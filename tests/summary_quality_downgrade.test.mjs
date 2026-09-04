import assert from "node:assert/strict";
import test from "node:test";

import { downgradeSummaryQuality } from "../scripts/summarize_signal_evidence.mjs";
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

test("downgrading quality also withdraws the report approval", () => {
  const downgraded = downgradeSummaryQuality(approvedSummary(), "Terra 결과도 목표 분량 미달");
  assert.equal(downgraded.ai_summary_quality, "needs_review");
  assert.equal(downgraded.ai_signal_supported, false);
  assert.equal(downgraded.ai_summary_reason, "Terra 결과도 목표 분량 미달");
});

test("a downgraded business row passes report input validation", () => {
  const row = {
    company: "Example",
    title: "Example reports steady demand for the target technology",
    url: "https://example.com/news/business",
    ...downgradeSummaryQuality(approvedSummary(), "Terra 재요약 실패: empty model output"),
  };
  assert.deepEqual(validateRows([row], "relevant"), []);
});

test("keeping quality=pass on an approved row still validates", () => {
  const row = {
    company: "Example",
    title: "Example reports steady demand for the target technology",
    url: "https://example.com/news/business",
    ...approvedSummary(),
  };
  assert.deepEqual(validateRows([row], "relevant"), []);
});
