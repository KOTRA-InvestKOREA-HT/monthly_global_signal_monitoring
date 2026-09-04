import assert from "node:assert/strict";
import test from "node:test";

import {
  downgradeSummaryQuality,
  flagSummaryFormat,
  isRelevanceExempt,
  terraReason,
} from "../scripts/summarize_signal_evidence.mjs";
import { validateRows } from "../scripts/validate_report_inputs.mjs";

function approvedSummary(overrides = {}) {
  return {
    ai_summary_ko: "타겟 기술 적용 확대가 확인된다.",
    ai_summary_en: "Adoption of the target technology is expanding.",
    ai_summary_reason: "기업과 타겟 기술의 직접 연계가 본문에서 확인됨",
    ai_summary_quality: "pass",
    ai_signal_supported: true,
    ai_entity_supported: true,
    ai_target_technology_supported: true,
    ai_indicator_supported: true,
    ai_leading_indicator_supported: true,
    ai_event_stage: "not_applicable",
    ...overrides,
  };
}

function businessRow(overrides = {}) {
  return {
    company: "Example",
    title: "Example reports steady demand for the target technology",
    url: "https://example.com/news/business",
    ...approvedSummary(overrides),
  };
}

test("downgrading quality also withdraws the report approval", () => {
  const downgraded = downgradeSummaryQuality(approvedSummary(), "모델 확신도 미달");
  assert.equal(downgraded.ai_summary_quality, "needs_review");
  assert.equal(downgraded.ai_signal_supported, false);
  assert.equal(downgraded.ai_summary_reason, "모델 확신도 미달");
});

test("a downgraded business row passes report input validation", () => {
  const row = { ...businessRow(), ...downgradeSummaryQuality(approvedSummary(), "요약문이 근거 부족을 명시") };
  assert.deepEqual(validateRows([row], "relevant"), []);
});

test("keeping quality=pass on an approved row still validates", () => {
  assert.deepEqual(validateRows([businessRow()], "relevant"), []);
});

test("a format shortfall leaves the evidence verdict and approval intact", () => {
  const flagged = flagSummaryFormat(approvedSummary(), "한국어 요약 목표 분량 미달(195자 < 220자)");
  assert.equal(flagged.ai_summary_quality, "pass");
  assert.equal(flagged.ai_signal_supported, true);
  assert.equal(flagged.ai_summary_format_status, "한국어 요약 목표 분량 미달(195자 < 220자)");
  assert.deepEqual(validateRows([{ ...businessRow(), ...flagged }], "relevant"), []);
});

test("terraReason separates presentation shortfalls from evidence shortfalls", () => {
  const short = terraReason({ ...approvedSummary(), ai_summary_ko: "짧은 요약", ai_summary_confidence: 0.9 }, "relevant");
  assert.equal(short.kind, "format");

  const unsure = terraReason(
    { ...approvedSummary(), ai_summary_ko: "가".repeat(260), ai_summary_confidence: 0.4 },
    "relevant",
  );
  assert.equal(unsure.kind, "evidence");

  const clean = terraReason(
    { ...approvedSummary(), ai_summary_ko: "가".repeat(260), ai_summary_confidence: 0.9 },
    "relevant",
  );
  assert.equal(clean, null);
});

test("relevance-exempt rows are recognised from either classifier field", () => {
  assert.equal(isRelevanceExempt({ excluded_from_relevance: true }), true);
  assert.equal(isRelevanceExempt({ technology_gate_decision: "relevance_exempt" }), true);
  assert.equal(isRelevanceExempt({ technology_gate_decision: "relevant" }), false);
  assert.equal(isRelevanceExempt({}), false);
});

function investmentRow(overrides = {}) {
  return {
    company: "Example",
    investment_signal_no: 2,
    title: "Example plans a pilot facility",
    url: "https://example.com/news/pilot",
    ai_summary_ko: "파일럿 시설 검토",
    ai_summary_en: "Pilot facility under consideration",
    ai_summary_reason: "생산 확대 검토가 본문에서 직접 확인됨",
    ai_summary_quality: "pass",
    ai_signal_supported: true,
    ai_entity_supported: true,
    ai_target_technology_supported: true,
    ai_indicator_supported: true,
    ai_leading_indicator_supported: true,
    ai_event_stage: "exploratory",
    ...overrides,
  };
}

test("an exempt company may be approved without target-technology evidence", () => {
  const row = investmentRow({
    technology_gate_decision: "relevance_exempt",
    excluded_from_relevance: true,
    ai_target_technology_supported: false,
    ai_summary_reason: "유치필요 기술과의 직접적 연관성은 확인되지 않으나 생산 확대 계획은 구체적으로 제시됨",
  });
  assert.deepEqual(validateRows([row], "investment"), []);
});

test("a company still under the technology gate is not given that latitude", () => {
  const row = investmentRow({
    ai_target_technology_supported: false,
    ai_summary_reason: "유치필요 기술과의 직접적 연관성은 확인되지 않음",
  });
  const errors = validateRows([row], "investment");
  assert.ok(errors.some((error) => error.includes("lacks target-technology evidence")));
  assert.ok(errors.some((error) => error.includes("reason denies direct relevance")));
});

test("an exempt row still needs entity, indicator and leading evidence", () => {
  const row = investmentRow({
    technology_gate_decision: "relevance_exempt",
    ai_target_technology_supported: false,
    ai_indicator_supported: false,
  });
  const errors = validateRows([row], "investment");
  assert.ok(errors.some((error) => error.includes("lacks indicator evidence")));
  assert.ok(!errors.some((error) => error.includes("target-technology")));
});
