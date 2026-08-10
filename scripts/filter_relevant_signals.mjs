import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_ARGS = {
  signals: "outputs/latest_company_signals.json",
  technologyMap: "data/company_technology_map.json",
  keywordConfig: "config/technology_keywords.json",
  outDir: "outputs",
  threshold: 1,
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

function buildSearchText(signal, includeUrl = true) {
  return [
    signal.company,
    signal.title,
    signal.source,
    signal.query,
    includeUrl ? signal.url : "",
    includeUrl ? signal.official_source_url : "",
  ].join(" ");
}

function matchKeywords(signal, keywords) {
  const visibleHaystack = normalizeText(buildSearchText(signal, false));
  const haystack = normalizeText(buildSearchText(signal, true));
  const compactHaystack = compactText(haystack);
  const matched = [];

  for (const keyword of keywords) {
    const normalizedKeyword = normalizeText(keyword);
    const compactKeyword = compactText(keyword);
    if (!normalizedKeyword || normalizedKeyword.length < 2) continue;

    const isShortLatinAcronym = /^[a-z0-9]{2,3}$/i.test(compactKeyword);
    if (isShortLatinAcronym) {
      const escaped = normalizedKeyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const acronymPattern = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
      if (acronymPattern.test(visibleHaystack)) {
        matched.push(keyword);
      }
      continue;
    }

    if (haystack.includes(normalizedKeyword) || (compactKeyword.length >= 4 && compactHaystack.includes(compactKeyword))) {
      matched.push(keyword);
    }
  }

  return unique(matched);
}

function scoreMatch(signal, matchedTerms) {
  const sourceBoost = signal.source_type === "official" ? 2 : 0;
  const specificBoost = matchedTerms.some((term) => compactText(term).length >= 8) ? 1 : 0;
  return matchedTerms.length + sourceBoost + specificBoost;
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
    "target_technology_en",
    "title",
    "url",
    "source",
    "source_type",
    "published_at",
    "collected_at",
    "matched_terms",
    "relevance_score",
    "relevance_decision",
    "relevance_reason",
  ];
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => toCsvValue(row[header])).join(","));
  }
  await fs.writeFile(filePath, `\uFEFF${lines.join("\n")}\n`, "utf8");
}

function classifySignal(signal, companyMap, keywordGroups, threshold) {
  const company = companyMap.get(signal.company);
  if (!company) {
    return {
      ...signal,
      relevance_decision: "unmapped_company",
      relevance_score: 0,
      matched_terms: [],
      relevance_reason: "기술 매핑 파일에서 회사를 찾지 못했습니다.",
    };
  }

  const base = {
    ...signal,
    target_no: company.target_no,
    industry: company.industry,
    target_technology: company.target_technology,
    target_technology_en: company.target_technology_en,
    technology_group: company.technology_group,
    excluded_from_relevance: company.excluded_from_relevance,
  };

  if (company.excluded_from_relevance) {
    return {
      ...base,
      relevance_decision: "excluded",
      relevance_score: 0,
      matched_terms: [],
      relevance_reason: "사용자 요청에 따라 연관성 분석 제외 기업입니다.",
    };
  }

  const group = keywordGroups[company.technology_group];
  if (!group) {
    return {
      ...base,
      relevance_decision: "missing_keyword_group",
      relevance_score: 0,
      matched_terms: [],
      relevance_reason: "기술 키워드 그룹을 찾지 못했습니다.",
    };
  }

  const matchedTerms = matchKeywords(signal, group.keywords || []);
  const score = matchedTerms.length ? scoreMatch(signal, matchedTerms) : 0;
  const decision = score >= threshold ? "relevant" : "not_relevant";

  return {
    ...base,
    matched_terms: matchedTerms,
    relevance_score: score,
    relevance_decision: decision,
    relevance_reason:
      decision === "relevant"
        ? `${company.target_technology} 관련 키워드가 발견되었습니다: ${matchedTerms.slice(0, 8).join(", ")}`
        : `${company.target_technology} 관련 키워드가 제목/URL/출처 메타데이터에서 발견되지 않았습니다.`,
  };
}

function sortRelevantRows(a, b) {
  const sourceA = a.source_type === "official" ? 0 : 1;
  const sourceB = b.source_type === "official" ? 0 : 1;
  if (sourceA !== sourceB) return sourceA - sourceB;
  if (b.relevance_score !== a.relevance_score) return b.relevance_score - a.relevance_score;
  return String(b.published_at || "").localeCompare(String(a.published_at || ""));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [signals, technologyMap, keywordConfig] = await Promise.all([
    readJson(args.signals),
    readJson(args.technologyMap),
    readJson(args.keywordConfig),
  ]);

  const companyMap = new Map(technologyMap.companies.map((company) => [company.company, company]));
  const keywordGroups = keywordConfig.groups || {};
  const threshold = Number.isFinite(args.threshold) && args.threshold > 0 ? args.threshold : keywordConfig.default_threshold || 1;

  const classified = signals.map((signal) => classifySignal(signal, companyMap, keywordGroups, threshold));
  const relevant = classified
    .filter((row) => row.relevance_decision === "relevant")
    .sort(sortRelevantRows);

  const analyzedCompanies = technologyMap.companies.filter((company) => !company.excluded_from_relevance);
  const relevantCompanies = new Set(relevant.map((row) => row.company));
  const companiesWithSignals = new Set(signals.map((row) => row.company));
  const excludedCompanies = technologyMap.companies.filter((company) => company.excluded_from_relevance).map((company) => company.company);

  const summary = {
    run_started_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    input_signal_count: signals.length,
    technology_company_count: technologyMap.company_count,
    analyzed_company_count: analyzedCompanies.length,
    excluded_company_count: excludedCompanies.length,
    excluded_companies: excludedCompanies,
    threshold,
    relevant_signal_count: relevant.length,
    companies_with_relevant_signals: relevantCompanies.size,
    companies_without_relevant_signals: analyzedCompanies
      .map((company) => company.company)
      .filter((company) => !relevantCompanies.has(company)),
    companies_without_any_collected_signal: analyzedCompanies
      .map((company) => company.company)
      .filter((company) => !companiesWithSignals.has(company)),
    counts_by_company: Object.fromEntries(
      analyzedCompanies.map((company) => [
        company.company,
        relevant.filter((row) => row.company === company.company).length,
      ]),
    ),
    counts_by_technology_group: Object.fromEntries(
      Object.keys(keywordGroups).map((groupId) => [
        groupId,
        relevant.filter((row) => row.technology_group === groupId).length,
      ]),
    ),
    method: "broad_keyword_synonym_filter",
    matched_fields: ["company", "title", "url", "source", "query", "official_source_url"],
    note: "This first pass does not call an AI API and does not fetch full article bodies. It filters collected signal metadata using broad Korean/English synonym keywords.",
  };

  await fs.mkdir(args.outDir, { recursive: true });
  const timestamp = summary.run_started_at.replace(/[-:]/g, "").replace("T", "T").replace("Z", "Z");
  const relevantJson = path.join(args.outDir, `relevant_company_signals_${timestamp}.json`);
  const relevantCsv = path.join(args.outDir, `relevant_company_signals_${timestamp}.csv`);
  const classifiedJson = path.join(args.outDir, `signal_relevance_classification_${timestamp}.json`);
  const summaryJson = path.join(args.outDir, `relevance_summary_${timestamp}.json`);

  await fs.writeFile(relevantJson, `${JSON.stringify(relevant, null, 2)}\n`, "utf8");
  await writeCsv(relevantCsv, relevant);
  await fs.writeFile(classifiedJson, `${JSON.stringify(classified, null, 2)}\n`, "utf8");
  await fs.writeFile(summaryJson, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  await fs.writeFile(path.join(args.outDir, "latest_relevant_signals.json"), `${JSON.stringify(relevant, null, 2)}\n`, "utf8");
  await writeCsv(path.join(args.outDir, "latest_relevant_signals.csv"), relevant);
  await fs.writeFile(path.join(args.outDir, "latest_signal_relevance_classification.json"), `${JSON.stringify(classified, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(args.outDir, "latest_relevance_summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        relevant_signal_count: summary.relevant_signal_count,
        companies_with_relevant_signals: summary.companies_with_relevant_signals,
        analyzed_company_count: summary.analyzed_company_count,
        excluded_company_count: summary.excluded_company_count,
        latest_relevant_json: path.join(args.outDir, "latest_relevant_signals.json"),
        latest_relevant_csv: path.join(args.outDir, "latest_relevant_signals.csv"),
        latest_summary: path.join(args.outDir, "latest_relevance_summary.json"),
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
