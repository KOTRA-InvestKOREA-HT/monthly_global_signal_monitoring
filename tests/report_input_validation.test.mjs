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

// 승인 조건은 하나도 양보하지 않는다. 타겟 기술 오인·전조 아닌 사건·근거 부족이 지금까지 잡아온
// 오류라, 조건이 하나만 비어도 승인에서 떨어진다.
test("any single unmet condition rejects a supported row", () => {
  const cases = [
    [{ ai_summary_quality: "needs_review" }, "not quality=pass"],
    [{ ai_target_technology_supported: false }, "lacks target-technology evidence"],
    [{ ai_leading_indicator_supported: false }, "not a leading indicator"],
    [{ ai_entity_supported: false }, "lacks entity evidence"],
    [{ ai_indicator_supported: false }, "lacks indicator evidence"],
  ];
  for (const [overrides, message] of cases) {
    const errors = validateRows([validRow(overrides)], "investment");
    assert.ok(errors.some((error) => error.includes(message)), `${JSON.stringify(overrides)} → ${message}`);
  }
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
  assert.ok(errors.some((error) => error.includes("non-leading event stage completed")));
});

test("precursor stages are restricted to enabling activities and unknown stages fail closed", () => {
  for (const no of [1, 3, 4, 5]) {
    assert.deepEqual(validateRows([validRow({ investment_signal_no: no, ai_event_stage: "precursor" })], "investment"), []);
  }
  for (const stage of ["precursor", "not_applicable", "unknown", "committed"]) {
    assert.ok(validateRows([validRow({ ai_event_stage: stage })], "investment").length > 0, stage);
  }
});

// 승인되지 않은 행은 보고서에 실리지 않고 대시보드에만 남으므로 문안이 없어도 된다.
// 어떤 후보를 그렇게 남길지는 nearMissCandidate 가 정한다(local_report.test.mjs 가 검사).
test("an unapproved row stays for the dashboard without prose", () => {
  const nearMiss = validRow({ ai_signal_supported: false, ai_target_technology_supported: false,
    ai_summary_ko: "", ai_summary_en: "" });
  assert.deepEqual(validateRows([nearMiss], "investment"), []);
  // 근거 부족으로 내려간 사업동향 행도 같은 방식으로 남는다.
  assert.deepEqual(validateRows([{ ...nearMiss, investment_signal_no: undefined,
    ai_event_stage: "not_applicable" }], "relevant"), []);
});

// 보고서에 실리는 승인 행은 예외 없이 한·영 문안을 갖춰야 한다.
test("an approved row needs both summaries", () => {
  const errors = validateRows([validRow({ ai_summary_ko: "", ai_summary_en: "" })], "investment");
  assert.ok(errors.some((error) => error.includes("ai_summary_ko")));
  assert.ok(errors.some((error) => error.includes("ai_summary_en")));
});
