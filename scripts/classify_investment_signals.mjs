import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ARGS = {
  signals: "outputs/latest_company_signals.json",
  technologyClassification: "outputs/latest_signal_relevance_classification.json",
  indicatorConfig: "config/investment_signal_indicators.json",
  outDir: "outputs",
  threshold: 0,
  requireTechnologyRelevance: true,
  // shadow가 기본값이다. 한 회차만 보고 거르기 시작하면, 걸러진 것이 정말 버려도 되는 것이었는지
  // 확인할 방법이 사라진다. shadow는 판정만 기록하고 행은 그대로 둔다.
  indicatorProximity: "shadow",
};

function parseArgs(argv) {
  const args = { ...DEFAULT_ARGS };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key.startsWith("--")) continue;
    index += 1;
    const normalized = key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (normalized === "threshold") {
      args[normalized] = Number(value);
    } else if (normalized === "requireTechnologyRelevance") {
      args[normalized] = !["0", "false", "no"].includes(String(value).toLowerCase());
    } else if (normalized === "indicatorProximity") {
      const mode = String(value).toLowerCase();
      if (!PROXIMITY_MODES.has(mode)) {
        throw new Error(`--indicator-proximity는 ${[...PROXIMITY_MODES].join(", ")} 중 하나여야 합니다 (받은 값: ${value})`);
      }
      args[normalized] = mode;
    } else {
      args[normalized] = value;
    }
  }
  return args;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"');
}

function compactText(value) {
  return normalizeText(value).replace(/[\s\-_/.,:;()[\]{}"'|+&]+/g, "");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function CounterLike(values) {
  const counts = {};
  for (const value of values) {
    const key = value || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function normalizeUrlKey(url = "") {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_)/i.test(key)) parsed.searchParams.delete(key);
    }
    return parsed.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return String(url || "").replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
  }
}

function signalKey(signal) {
  return `${String(signal.company || "").toLowerCase()}|${normalizeUrlKey(signal.url)}`;
}

function buildTechnologyGateMap(rows) {
  return new Map(rows.map((row) => [signalKey(row), row]));
}

function technologyGate(signal, gateMap, required) {
  if (!required) {
    return {
      passed: true,
      technology_gate_decision: "not_required",
      technology_gate_reason: "기술/품목 관련성 게이트를 사용하지 않았습니다.",
    };
  }

  const row = gateMap.get(signalKey(signal));
  if (!row) {
    return {
      passed: false,
      technology_gate_decision: "missing_technology_classification",
      technology_gate_reason: "기술/품목 관련성 분류 결과에서 해당 수집 건을 찾지 못했습니다.",
    };
  }

  const excludedFromRelevance = row.excluded_from_relevance || row.relevance_decision === "excluded";
  if (excludedFromRelevance) {
    return {
      passed: true,
      technology_gate_decision: "relevance_exempt",
      technology_gate_reason: "사용자 요청에 따라 유치필요 품목(기술) 관련성 검사는 생략하고 5대 투자동향 시그널만 판단합니다.",
      industry: row.industry,
      target_technology: row.target_technology,
      target_technology_en: row.target_technology_en,
      technology_group: row.technology_group,
      technology_relevance_decision: row.relevance_decision,
      technology_relevance_score: row.relevance_score || 0,
      technology_matched_terms: row.matched_terms || [],
      technology_matched_fields: row.matched_fields || [],
      technology_evidence_snippets: row.evidence_snippets || [],
      technology_relevance_reason: row.relevance_reason || "",
      excluded_from_relevance: true,
    };
  }

  const passed = row.relevance_decision === "relevant";
  return {
    passed,
    technology_gate_decision: passed ? "passed" : row.relevance_decision || "not_relevant",
    technology_gate_reason: passed
      ? "유치필요 품목(기술)과 관련된 수집 건이므로 투자동향 시그널 판단 대상입니다."
      : "유치필요 품목(기술)과 관련된 수집 건이 아니므로 투자동향 시그널 판단에서 제외했습니다.",
    industry: row.industry,
    target_technology: row.target_technology,
    target_technology_en: row.target_technology_en,
    technology_group: row.technology_group,
    technology_relevance_decision: row.relevance_decision,
    technology_relevance_score: row.relevance_score || 0,
    technology_matched_terms: row.matched_terms || [],
    technology_matched_fields: row.matched_fields || [],
    technology_evidence_snippets: row.evidence_snippets || [],
    technology_relevance_reason: row.relevance_reason || "",
    excluded_from_relevance: row.excluded_from_relevance || false,
  };
}

function signalText(signal) {
  return [
    signal.company,
    signal.title,
    signal.content_excerpt,
    signal.content_text,
    signal.query,
    signal.url,
    signal.source_direct_url,
  ].join(" ");
}

function includesKeyword(text, keyword) {
  const haystack = normalizeText(text);
  const compactHaystack = compactText(text);
  const normalizedKeyword = normalizeText(keyword);
  const compactKeyword = compactText(keyword);
  if (!normalizedKeyword || normalizedKeyword.length < 2) return false;

  const isShortLatinAcronym = /^[a-z0-9]{2,3}$/i.test(compactKeyword);
  if (isShortLatinAcronym) {
    const escaped = normalizedKeyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
  }

  return haystack.includes(normalizedKeyword) || (compactKeyword.length >= 4 && compactHaystack.includes(compactKeyword));
}

function matchKeywords(text, keywords) {
  return unique((keywords || []).filter((keyword) => includesKeyword(text, keyword)));
}

function matchedFields(signal, terms) {
  const fields = [
    ["title", signal.title],
    ["content", `${signal.content_excerpt || ""} ${signal.content_text || ""}`],
    ["url", `${signal.url || ""} ${signal.source_direct_url || ""}`],
    ["query", signal.query],
  ];
  return fields
    .filter(([, value]) => terms.some((term) => includesKeyword(value, term)))
    .map(([name]) => name);
}

function extractEvidence(signal, terms) {
  const text = String(signal.content_text || signal.content_excerpt || signal.title || "").replace(/\s+/g, " ").trim();
  if (!text) return [];
  const normalizedText = normalizeText(text);
  const snippets = [];

  for (const term of terms) {
    const normalizedTerm = normalizeText(term);
    const index = normalizedText.indexOf(normalizedTerm);
    if (index < 0) continue;
    const start = Math.max(0, index - 150);
    const end = Math.min(text.length, index + normalizedTerm.length + 220);
    snippets.push(text.slice(start, end).trim());
    if (snippets.length >= 3) break;
  }
  return unique(snippets);
}

function isPressRelease(signal) {
  return signal.source_type === "official" && Boolean(signal.is_press_release);
}

// 지표 용어가 기사 어딘가에 있기만 하면 점수가 붙는다. 그래서 네비게이션이나 상용문구에 섞인
// "expansion" 하나로도 시그널이 만들어지고, 그걸 요약 단계의 AI가 다시 버린다. 2026-09 회차에서
// 투자 시그널 109건 중 107건이 거절됐고 그중 81건의 사유가 "지표 근거 없음"이었다.
//
// 그 판정의 상당 부분은 AI 없이도 확인된다. 지표 용어가 회사를 가리키는 문장 안에 있는지 보면
// 된다. 같은 회차 데이터에 걸어보니 109건이 42건으로 줄고 승인된 2건은 모두 남았다.
//
// 다만 투자 시그널 전용이다. 사업동향에 걸면 승인 35건 중 17건을 잘못 버린다. 사업동향은
// 지표 동시출현을 요구하지 않기 때문이다.
const PROXIMITY_MODES = new Set(["shadow", "enforce", "off"]);

function sentencesOf(text) {
  return String(text || "")
    .split(/(?<=[.!?。])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

// 회사를 가리키는 표현은 넓게 잡는다. 좁게 잡아 놓치면 진짜 시그널이 사라지지만, 넓게 잡아
// 남는 것은 어차피 뒤에서 판정을 받는다. 틀릴 때 남는 쪽으로 틀려야 한다.
function companyMentions(company) {
  const full = normalizeText(company);
  if (!full) return [];
  const tokens = full.split(/[^a-z0-9가-힣]+/i).filter((token) => token.length >= 3);
  return unique([full, ...tokens]);
}

export function indicatorProximity(signal, terms) {
  const mentions = companyMentions(signal.company);
  if (!mentions.length || !terms?.length) return { near: false, sentence: "" };

  const text = `${signal.title || ""}\n${signal.content_text || signal.content_excerpt || ""}`;
  for (const sentence of sentencesOf(text)) {
    const normalized = normalizeText(sentence);
    if (!mentions.some((mention) => normalized.includes(mention))) continue;
    if (!terms.some((term) => includesKeyword(sentence, term))) continue;
    return { near: true, sentence: sentence.slice(0, 300) };
  }
  return { near: false, sentence: "" };
}

function scoreMatch(signal, terms, fields) {
  const officialBoost = signal.source_type === "official" ? 1 : 0;
  const pressBoost = isPressRelease(signal) ? 1 : 0;
  const contentBoost = fields.includes("content") ? 1 : 0;
  const specificBoost = terms.some((term) => compactText(term).length >= 10) ? 1 : 0;
  return terms.length + officialBoost + pressBoost + contentBoost + specificBoost;
}

// 한 기사가 다섯 지표에 모두 걸리는 병리적 경우만 막는 방어선이다.
// 중복을 실제로 정리하는 것은 요약 단계의 ai_signal_supported 판정이고(측정: 중복 33건 -> 24건,
// 4중복은 전부 소멸), 여기서 점수순으로 미리 잘라내면 그 판정을 받아보기도 전에 진짜 시그널을
// 지울 수 있다. 실제로 한 기사가 공급망·증설·R&D를 함께 알리는 경우가 있어 3중복은 정상이다.
const MAX_SIGNALS_PER_ARTICLE = 4;

function classifySignal(signal, indicators, threshold) {
  const text = signalText(signal);
  const matches = [];

  for (const indicator of indicators) {
    const terms = matchKeywords(text, indicator.keywords || []);
    if (!terms.length) continue;
    const fields = matchedFields(signal, terms);
    const score = scoreMatch(signal, terms, fields);
    if (score < threshold) continue;

    matches.push({
      ...signal,
      investment_signal_id: indicator.id,
      investment_signal_no: indicator.no,
      investment_signal_label: indicator.label_ko,
      investment_signal_label_en: indicator.label_en,
      investment_signal_description: indicator.description_ko,
      investment_signal_score: score,
      investment_signal_decision: "signal",
      matched_terms: terms,
      matched_fields: fields,
      evidence_snippets: extractEvidence(signal, terms),
      investment_signal_reason: `${indicator.label_ko} 관련 표현이 ${fields.join(", ") || "수집 텍스트"}에서 발견되었습니다: ${terms.slice(0, 8).join(", ")}`,
      ...(() => {
        const { near, sentence } = indicatorProximity(signal, terms);
        return { indicator_near_company: near, indicator_near_company_sentence: sentence };
      })(),
    });
  }

  if (matches.length > MAX_SIGNALS_PER_ARTICLE) {
    matches.sort(
      (a, b) =>
        b.investment_signal_score - a.investment_signal_score ||
        b.matched_terms.length - a.matched_terms.length ||
        a.investment_signal_no - b.investment_signal_no,
    );
    return matches.slice(0, MAX_SIGNALS_PER_ARTICLE);
  }
  return matches;
}

function toCsvValue(value) {
  if (Array.isArray(value)) return toCsvValue(value.join("; "));
  if (value === null || value === undefined) return "";
  const stringValue = String(value);
  if (/[",\n\r]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

async function writeCsv(filePath, rows) {
  const headers = [
    "target_no",
    "company",
    "industry",
    "target_technology",
    "technology_relevance_score",
    "technology_matched_terms",
    "investment_signal_no",
    "investment_signal_label",
    "investment_signal_description",
    "title",
    "url",
    "source",
    "source_type",
    "source_kind",
    "source_label_ko",
    "published_at",
    "collected_at",
    "matched_terms",
    "matched_fields",
    "evidence_snippets",
    "investment_signal_score",
    "indicator_near_company",
    "investment_signal_reason",
  ];
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => toCsvValue(row[header])).join(","));
  }
  await fs.writeFile(filePath, `\uFEFF${lines.join("\n")}\n`, "utf8");
}

function sortRows(a, b) {
  if (a.investment_signal_no !== b.investment_signal_no) {
    return a.investment_signal_no - b.investment_signal_no;
  }
  if (b.investment_signal_score !== a.investment_signal_score) {
    return b.investment_signal_score - a.investment_signal_score;
  }
  const pressA = isPressRelease(a) ? 0 : 1;
  const pressB = isPressRelease(b) ? 0 : 1;
  if (pressA !== pressB) return pressA - pressB;
  const officialA = a.source_type === "official" ? 0 : 1;
  const officialB = b.source_type === "official" ? 0 : 1;
  if (officialA !== officialB) return officialA - officialB;
  return String(b.published_at || "").localeCompare(String(a.published_at || ""));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [signals, config, technologyClassification] = await Promise.all([
    readJson(args.signals),
    readJson(args.indicatorConfig),
    args.requireTechnologyRelevance ? readJson(args.technologyClassification) : Promise.resolve([]),
  ]);
  const threshold = Number.isFinite(args.threshold) && args.threshold > 0 ? args.threshold : config.default_threshold || 1;
  const indicators = config.indicators || [];
  const technologyGateMap = buildTechnologyGateMap(technologyClassification);
  const gatedSignals = signals.map((signal) => ({
    ...signal,
    ...technologyGate(signal, technologyGateMap, args.requireTechnologyRelevance),
  }));

  const classified = gatedSignals.map((signal) => ({
    ...signal,
    investment_signal_matches: signal.passed
      ? classifySignal(signal, indicators, threshold).map((match) => ({
      investment_signal_id: match.investment_signal_id,
      investment_signal_no: match.investment_signal_no,
      investment_signal_label: match.investment_signal_label,
      investment_signal_score: match.investment_signal_score,
      matched_terms: match.matched_terms,
      matched_fields: match.matched_fields,
      evidence_snippets: match.evidence_snippets,
    }))
      : [],
  }));

  const eligibleSignals = gatedSignals.filter((signal) => signal.passed);
  const scored = eligibleSignals.flatMap((signal) => classifySignal(signal, indicators, threshold)).sort(sortRows);
  const farFromCompany = scored.filter((row) => row.indicator_near_company !== true);
  const investmentSignals = args.indicatorProximity === "enforce" ? scored.filter((row) => row.indicator_near_company === true) : scored;
  const proximity = {
    mode: args.indicatorProximity,
    evaluated: scored.length,
    near_company: scored.length - farFromCompany.length,
    far_from_company: farFromCompany.length,
    // shadow에서는 무엇이 걸러졌을지 회사별로 남긴다. 한 회차만으로 규칙을 확정할 수 없으므로
    // 몇 회차를 모아 실제 AI 판정과 대조할 수 있어야 한다.
    would_drop:
      args.indicatorProximity === "shadow"
        ? farFromCompany.map((row) => ({
            company: row.company,
            indicator: row.investment_signal_label,
            score: row.investment_signal_score,
            title: row.title,
            url: row.url,
          }))
        : [],
  };
  const companiesWithInvestmentSignals = new Set(investmentSignals.map((row) => row.company));
  const gateCounts = CounterLike(gatedSignals.map((signal) => signal.technology_gate_decision));
  const countsByIndicator = Object.fromEntries(
    indicators.map((indicator) => [
      indicator.id,
      {
        no: indicator.no,
        label_ko: indicator.label_ko,
        count: investmentSignals.filter((row) => row.investment_signal_id === indicator.id).length,
        companies: unique(
          investmentSignals
            .filter((row) => row.investment_signal_id === indicator.id)
            .map((row) => row.company),
        ),
      },
    ]),
  );

  const summary = {
    run_started_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    input_signal_count: signals.length,
    technology_gate_required: args.requireTechnologyRelevance,
    technology_classification_file: args.requireTechnologyRelevance ? args.technologyClassification : "",
    technology_gate_pass_count: eligibleSignals.length,
    technology_gate_counts: gateCounts,
    threshold,
    indicator_count: indicators.length,
    investment_signal_count: investmentSignals.length,
    indicator_proximity: proximity,
    companies_with_investment_signals: companiesWithInvestmentSignals.size,
    counts_by_indicator: countsByIndicator,
    method: args.requireTechnologyRelevance
      ? "technology_gated_with_relevance_exempt_five_indicator_body_keyword_filter"
      : "five_indicator_body_keyword_filter",
    matched_fields: ["company", "title", "url", "query", "source_direct_url", "content_excerpt", "content_text"],
    note: args.requireTechnologyRelevance
      ? "This pass does not call an AI API. It first requires collected signals to be relevant to the company's target technology/item, except for the user-defined relevance-exempt companies, then classifies the eligible signal text against the five investment trend indicators."
      : "This pass does not call an AI API. It classifies collected official/fallback signal text against the five investment trend indicators from the reference PDF.",
  };

  await fs.mkdir(args.outDir, { recursive: true });
  const timestamp = summary.run_started_at.replace(/[-:]/g, "");
  const signalJson = path.join(args.outDir, `investment_signals_${timestamp}.json`);
  const signalCsv = path.join(args.outDir, `investment_signals_${timestamp}.csv`);
  const classifiedJson = path.join(args.outDir, `investment_signal_classification_${timestamp}.json`);
  const summaryJson = path.join(args.outDir, `investment_signal_summary_${timestamp}.json`);

  await fs.writeFile(signalJson, `${JSON.stringify(investmentSignals, null, 2)}\n`, "utf8");
  await writeCsv(signalCsv, investmentSignals);
  await fs.writeFile(classifiedJson, `${JSON.stringify(classified, null, 2)}\n`, "utf8");
  await fs.writeFile(summaryJson, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  await fs.writeFile(path.join(args.outDir, "latest_investment_signals.json"), `${JSON.stringify(investmentSignals, null, 2)}\n`, "utf8");
  await writeCsv(path.join(args.outDir, "latest_investment_signals.csv"), investmentSignals);
  await fs.writeFile(path.join(args.outDir, "latest_investment_signal_classification.json"), `${JSON.stringify(classified, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(args.outDir, "latest_investment_signal_summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        investment_signal_count: summary.investment_signal_count,
        companies_with_investment_signals: summary.companies_with_investment_signals,
        latest_investment_signals: path.join(args.outDir, "latest_investment_signals.json"),
        latest_summary: path.join(args.outDir, "latest_investment_signal_summary.json"),
      },
      null,
      2,
    ),
  );
}

// 직접 실행할 때만 분류를 돌린다. 이 가드가 없으면 규칙 하나를 import하는 것만으로 전체 분류가
// 실행되어 outputs가 덮어써진다.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
