#!/usr/bin/env node
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULTS = {
  investmentSignals: "outputs/latest_investment_signals.json",
  relevantSignals: "outputs/latest_relevant_signals.json",
};

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    args[name] = argv[index + 1];
    index += 1;
  }
  return args;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function rowId(row, kind, index) {
  return `${kind}[${index}] ${row.company || "?"} S${row.investment_signal_no || "-"} ${row.url || row.title || "?"}`;
}

const REQUIRED_DECISIONS = [
  "ai_signal_supported",
  "ai_entity_supported",
  "ai_target_technology_supported",
  "ai_indicator_supported",
  "ai_leading_indicator_supported",
];

// 분류 단계에서 유치필요 품목(기술) 관련성 검사를 생략한 행.
// 승인 조건으로 타겟 기술 근거를 요구하면 그 면제가 무효가 되므로 여기서도 동일하게 제외한다.
function isRelevanceExempt(row) {
  return row?.excluded_from_relevance === true || row?.technology_gate_decision === "relevance_exempt";
}

// 지표 3(투자 재원 확보)과 5(핵심 전략 인력의 이동)는 회사채 발행·C-Level 이동처럼 기업 단위로
// 일어나는 사건이다. 발표문이 그 돈을 어느 품목에 쓰는지, 그 임원이 어느 품목을 맡는지 적는 일은
// 드물어서, 이 둘에 품목 연결을 요구하면 근거가 충분한 사건도 구조적으로 거의 통과하지 못한다.
// 2026-09 실행 35478668517 의 근접 후보 22건 가운데 21건이 품목 미연결로 떨어졌고, 그중 3·5번
// 8건은 Veolia 11.5억 유로 회사채, Jenoptik CEO 취임처럼 기업 귀속과 지표 사건이 모두 확인된
// 것이었다. 승인은 5개사에서 11개사가 된다(그중 1개사는 날짜 보류라 PDF 에는 10개사).
//
// 1·2·4 는 그대로 요구한다. 공급망 조치·증설·공동연구는 어느 품목의 활동인지 발표문이 밝히는
// 것이 보통이라, 거기서 연결을 놓으면 이 보고서가 지금까지 잡아온 타겟 기술 오인이 되돌아온다.
// 사업동향(investment_signal_no 없음)도 정의 자체가 품목 연계이므로 계속 요구한다.
const COMPANY_LEVEL_INDICATORS = new Set(["3", "5"]);

export function targetTechnologyRequired(indicatorNo, relevanceExempt = false) {
  if (relevanceExempt) return false;
  return !COMPANY_LEVEL_INDICATORS.has(String(indicatorNo ?? ""));
}

const DENIAL_PATTERNS = [
  /직접적? (?:연관성|연계).*(?:확인되지|없음)/i,
  /직접 관련.*(?:근거.*제시되지|확인되지)/i,
  /자체는 언급되지/i,
  /not directly (?:related|linked)/i,
  /no direct (?:evidence|link|connection|relevance)/i,
];

// precursor = verified enabling activity, not a committed final investment project.
export function investmentStageSupported(stage, indicatorNo) {
  return ["exploratory", "planned"].includes(stage) ||
    (stage === "precursor" && [1, 3, 4, 5].includes(Number(indicatorNo)));
}

export function validateRows(rows, kind) {
  const errors = [];
  rows.forEach((row, index) => {
    const id = rowId(row, kind, index);
    for (const field of REQUIRED_DECISIONS) {
      if (typeof row[field] !== "boolean") errors.push(`${id}: missing boolean ${field}`);
    }
    // 승인되지 않은 행은 보고서에 실리지 않고 대시보드에만 남으므로 문안이 없어도 된다. 어떤 행을
    // 그렇게 남길지는 local_report.mjs 의 nearMissCandidate 가 정한다(기업 귀속·지표 사건 확인 필수).
    // 여기서 지키는 것은 발행되는 행의 기준이다.
    if (row.ai_signal_supported !== false) {
      if (!cleanText(row.ai_summary_ko)) errors.push(`${id}: missing ai_summary_ko`);
      if (!cleanText(row.ai_summary_en)) errors.push(`${id}: missing ai_summary_en`);
    }
    if (!cleanText(row.ai_summary_reason)) errors.push(`${id}: missing ai_summary_reason`);
    if (!cleanText(row.ai_event_stage)) errors.push(`${id}: missing ai_event_stage`);

    // 후보에 걸린 승인 조건은 하나도 양보하지 않는다. 전조 아닌 사건·근거 부족은 이 보고서가
    // 지금까지 잡아온 오류이고, 그 방어벽을 여기서 낮추면 같은 오류가 다시 발행된다.
    // 품목 연결을 어느 후보에 요구하는지만 targetTechnologyRequired 가 따로 정한다.
    if (row.ai_signal_supported === true) {
      const techRequired = targetTechnologyRequired(row.investment_signal_no, isRelevanceExempt(row));
      if (row.ai_summary_quality !== "pass") errors.push(`${id}: supported row is not quality=pass`);
      if (row.ai_entity_supported !== true) errors.push(`${id}: supported row lacks entity evidence`);
      if (techRequired && row.ai_target_technology_supported !== true) {
        errors.push(`${id}: supported row lacks target-technology evidence`);
      }
      if (row.ai_indicator_supported !== true) errors.push(`${id}: supported row lacks indicator evidence`);
      if (row.ai_leading_indicator_supported !== true) errors.push(`${id}: supported row is not a leading indicator`);
      if (techRequired && DENIAL_PATTERNS.some((pattern) => pattern.test(cleanText(row.ai_summary_reason)))) {
        errors.push(`${id}: supported row reason denies direct relevance`);
      }
      if (kind === "investment" && !investmentStageSupported(row.ai_event_stage, row.investment_signal_no)) {
        errors.push(`${id}: supported investment row has non-leading event stage ${row.ai_event_stage}`);
      }
    }
  });
  return errors;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [investmentRows, relevantRows] = await Promise.all([
    readJson(args.investmentSignals),
    readJson(args.relevantSignals),
  ]);
  const errors = [
    ...validateRows(investmentRows, "investment"),
    ...validateRows(relevantRows, "relevant"),
  ];
  const result = {
    status: errors.length ? "failed" : "passed",
    investment_signal_count: investmentRows.length,
    relevant_signal_count: relevantRows.length,
    error_count: errors.length,
    errors: errors.slice(0, 100),
  };
  console.log(JSON.stringify(result, null, 2));
  if (errors.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
