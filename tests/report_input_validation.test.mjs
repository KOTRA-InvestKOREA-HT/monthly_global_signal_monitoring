import assert from "node:assert/strict";
import test from "node:test";

import { validateRows } from "../scripts/validate_report_inputs.mjs";

function validRow(overrides = {}) {
  return {
    company: "Example",
    investment_signal_no: 2,
    title: "Example plans a target-technology pilot facility",
    url: "https://example.com/news/pilot",
    ai_summary_ko: "타겟 기술 파일럿 시설 검토",
    ai_summary_en: "Target-technology pilot facility under consideration",
    ai_summary_reason: "기업과 타겟 기술 및 생산 확대 검토가 본문에서 직접 확인됨",
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

test("accepts a fully evidenced leading investment signal", () => {
  assert.deepEqual(validateRows([validRow()], "investment"), []);
});

// 근거 부족 하나만으로는 떨어지지 않는다. 투자 시그널은 네 조건 가운데 하나까지 비어도 싣는다.
test("one unmet condition still publishes; two do not", () => {
  assert.deepEqual(validateRows([validRow({ ai_summary_quality: "needs_review" })], "investment"), []);
  assert.deepEqual(validateRows([validRow({ ai_target_technology_supported: false })], "investment"), []);
  const two = validateRows([validRow({ ai_summary_quality: "needs_review", ai_leading_indicator_supported: false })], "investment");
  assert.ok(two.some((error) => error.includes("misses 2 approval conditions")));
});

// 기업 귀속과 지표 사건은 어떤 행에서도 양보하지 않는다.
test("entity and indicator evidence are never waived", () => {
  assert.ok(validateRows([validRow({ ai_entity_supported: false })], "investment").some((e) => e.includes("lacks entity evidence")));
  assert.ok(validateRows([validRow({ ai_indicator_supported: false })], "investment").some((e) => e.includes("lacks indicator evidence")));
});

test("rejects a supported row whose reason denies target relevance", () => {
  const errors = validateRows(
    [validRow({ ai_summary_reason: "타겟 기술과의 직접적 연관성은 확인되지 않음" })],
    "investment",
  );
  assert.ok(errors.some((error) => error.includes("reason denies direct relevance")));
});

test("rejects completed investments from the leading-signal report", () => {
  const errors = validateRows([validRow({ ai_event_stage: "completed" })], "investment");
  assert.ok(errors.some((error) => error.includes("reports a completed event")));
});

test("allows an unsupported row to remain for dashboard review", () => {
  const row = validRow({
    ai_signal_supported: false,
    ai_target_technology_supported: false,
    ai_summary_quality: "needs_review",
    ai_event_stage: "unclear",
  });
  assert.deepEqual(validateRows([row], "investment"), []);
});


// 단계만 어긋난 것은 하나 모자란 것이라 그대로 싣는다. 단계에 더해 다른 조건까지 비면 떨어진다.
test("an unapprovable stage alone still publishes, but not with a second gap", () => {
  for (const no of [1,3,4,5]) assert.deepEqual(validateRows([validRow({ investment_signal_no: no, ai_event_stage: "precursor" })], "investment"), []);
  for (const stage of ["precursor", "not_applicable", "unknown", "committed"]) {
    assert.deepEqual(validateRows([validRow({ ai_event_stage: stage })], "investment"), []);
    assert.ok(validateRows([validRow({ ai_event_stage: stage, ai_leading_indicator_supported: false })], "investment").length > 0);
  }
});

// 보고서에 실리는 행은 예외 없이 한·영 문안을 갖춰야 한다. 문안 없는 후보는 빌드에서 빠진다.
test("every published row needs both summaries", () => {
  const noProse = validRow({ ai_summary_ko: "", ai_summary_en: "" });
  const errors = validateRows([noProse], "investment");
  assert.ok(errors.some((error) => error.includes("ai_summary_ko")));
  assert.ok(errors.some((error) => error.includes("ai_summary_en")));
});

// 기술이 미확인인 채 실린 행에서 "직접 연관성 없음" 사유는 사실 그대로의 기록이다.
test("a denial reason is only a contradiction when the row claims the technology", () => {
  const denial = "타겟 기술과의 직접적 연관성은 확인되지 않음";
  assert.deepEqual(validateRows([validRow({ ai_target_technology_supported: false, ai_summary_reason: denial })], "investment"), []);
  assert.ok(validateRows([validRow({ ai_summary_reason: denial })], "investment")
    .some((error) => error.includes("reason denies direct relevance")));
});
