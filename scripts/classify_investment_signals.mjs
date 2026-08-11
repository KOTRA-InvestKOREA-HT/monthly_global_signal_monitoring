import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_ARGS = {
  signals: "outputs/latest_company_signals.json",
  indicatorConfig: "config/investment_signal_indicators.json",
  outDir: "outputs",
  threshold: 0,
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

function signalText(signal) {
  return [
    signal.company,
    signal.title,
    signal.content_excerpt,
    signal.content_text,
    signal.query,
    signal.url,
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
    ["url", signal.url],
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

function scoreMatch(signal, terms, fields) {
  const officialBoost = signal.source_type === "official" ? 1 : 0;
  const contentBoost = fields.includes("content") ? 1 : 0;
  const specificBoost = terms.some((term) => compactText(term).length >= 10) ? 1 : 0;
  return terms.length + officialBoost + contentBoost + specificBoost;
}

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
    });
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
    "investment_signal_no",
    "investment_signal_label",
    "investment_signal_description",
    "title",
    "url",
    "source",
    "source_type",
    "published_at",
    "collected_at",
    "matched_terms",
    "matched_fields",
    "evidence_snippets",
    "investment_signal_score",
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
  const officialA = a.source_type === "official" ? 0 : 1;
  const officialB = b.source_type === "official" ? 0 : 1;
  if (officialA !== officialB) return officialA - officialB;
  return String(b.published_at || "").localeCompare(String(a.published_at || ""));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [signals, config] = await Promise.all([readJson(args.signals), readJson(args.indicatorConfig)]);
  const threshold = Number.isFinite(args.threshold) && args.threshold > 0 ? args.threshold : config.default_threshold || 1;
  const indicators = config.indicators || [];

  const classified = signals.map((signal) => ({
    ...signal,
    investment_signal_matches: classifySignal(signal, indicators, threshold).map((match) => ({
      investment_signal_id: match.investment_signal_id,
      investment_signal_no: match.investment_signal_no,
      investment_signal_label: match.investment_signal_label,
      investment_signal_score: match.investment_signal_score,
      matched_terms: match.matched_terms,
      matched_fields: match.matched_fields,
      evidence_snippets: match.evidence_snippets,
    })),
  }));

  const investmentSignals = signals.flatMap((signal) => classifySignal(signal, indicators, threshold)).sort(sortRows);
  const companiesWithInvestmentSignals = new Set(investmentSignals.map((row) => row.company));
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
    threshold,
    indicator_count: indicators.length,
    investment_signal_count: investmentSignals.length,
    companies_with_investment_signals: companiesWithInvestmentSignals.size,
    counts_by_indicator: countsByIndicator,
    method: "five_indicator_body_keyword_filter",
    matched_fields: ["company", "title", "url", "query", "content_excerpt", "content_text"],
    note: "This pass does not call an AI API. It classifies collected official/fallback signal text against the five investment trend indicators from the reference PDF.",
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
