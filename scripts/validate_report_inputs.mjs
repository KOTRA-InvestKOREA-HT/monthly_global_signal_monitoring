#!/usr/bin/env node
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// 승인 규칙의 상수는 config/approval_policy.json 하나에서 온다. 같은 파일을
// scripts/build_pdf_report.py 도 읽는다. 두 곳이 각자 값을 들고 있던 동안, 지표 3·5 의
// 품목 연결 해제처럼 규칙이 바뀌면 양쪽을 함께 고쳐야 했고 한쪽을 놓치면 검증을 통과한
// 행이 발행 단계에서 조용히 사라졌다. 경로는 실행 위치가 아니라 이 파일 기준으로 찾는다.
export const APPROVAL_POLICY = JSON.parse(
  readFileSync(new URL("../config/approval_policy.json", import.meta.url), "utf8"),
);

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
const COMPANY_LEVEL_INDICATORS = new Set(APPROVAL_POLICY.company_level_indicators.map(String));

export function targetTechnologyRequired(indicatorNo, relevanceExempt = false) {
  if (relevanceExempt) return false;
  return !COMPANY_LEVEL_INDICATORS.has(String(indicatorNo ?? ""));
}

const DENIAL_PATTERNS = APPROVAL_POLICY.relevance_denial_patterns.map(
  (pattern) => new RegExp(pattern, "i"),
);

// 승인된 행의 사유가 스스로 품목 무관을 말하면 그 승인은 모순일 수 있다. 다만 사유 문자열이 일치했다는
// 것만으로 승인을 뒤집지는 않는다. 부정문의 대상이 무엇인지 정규식은 가리지 못한다. 실제로
// "한국 투자 자체는 언급되지 않음"이 품목 무관으로 읽혀, 막 소재 공동연구가 확인된 S4 가 탈락했다.
// 여기서는 충돌하는 구절만 돌려주고, 판단은 검토 단계가 그 후보의 근거와 함께 다시 묻는다
// (review_report.mjs 의 relevanceConflictSuspects). 발행 단계는 그 결과만 읽는다.
export function relevanceDenialPhrase(row) {
  if (!targetTechnologyRequired(row?.investment_signal_no, isRelevanceExempt(row))) return "";
  const reason = cleanText(row?.ai_summary_reason);
  for (const pattern of DENIAL_PATTERNS) {
    const match = pattern.exec(reason);
    if (match) return match[0];
  }
  return "";
}

// precursor = verified enabling activity, not a committed final investment project.
export function investmentStageSupported(stage, indicatorNo) {
  return APPROVAL_POLICY.leading_stages.includes(stage) ||
    (stage === "precursor" && APPROVAL_POLICY.precursor_indicators.includes(Number(indicatorNo)));
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
      // 사유 구절 하나로 승인을 뒤집던 검사는 여기에 없다. 모순이 의심되는 후보는 검토 단계가
      // 근거와 함께 다시 묻고(relevanceConflictSuspects), 풀리지 않으면 재검토 미완료로 남아
      // 발행되지 않는다. 발행 단계가 사유 문장을 다시 해석하지 않게 하려는 것이다.
      // 사업동향의 단계는 고정값이다. importReview 는 not_applicable 만 받아들이고 PDF 생성기도
      // 그것만 싣는데, 이 검증만 단계를 보지 않아 다른 단계가 적힌 사업동향 행이 통과했다.
      // 실제로 그런 행이 온 적은 없지만, 통과시키면 발행 단계가 말없이 떨어뜨리는 쪽이 된다.
      if (kind === "relevant" && row.ai_event_stage !== APPROVAL_POLICY.business_stage) {
        errors.push(`${id}: supported business row must use event stage ${APPROVAL_POLICY.business_stage}`);
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
