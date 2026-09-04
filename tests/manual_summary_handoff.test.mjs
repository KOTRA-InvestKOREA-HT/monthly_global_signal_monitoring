import assert from "node:assert/strict";
import test from "node:test";

import { groupByArticle, trimToBudget, usefulSentences } from "../scripts/build_report_brief.mjs";
import { buildSummaryFields, expandEntry, parseResponseArray, validateEntry } from "../scripts/merge_summary_batches.mjs";

function entry(overrides = {}) {
  return {
    ref: "INV-001",
    summary_ko: "군산 실리콘 음극재 생산기지 확장 기반 확보",
    summary_headline_ko: "군산 실리콘 음극재 생산기지 확장 기반 확보",
    summary_detail_ko: "수요 증가 시 반응기 증설로 생산능력 확대 가능한 설비 구축",
    summary_en: "Gunsan silicon anode site built for staged expansion",
    summary_headline_en: "Gunsan silicon anode site built for staged expansion",
    summary_detail_en: "Reactors can be added as demand grows",
    signal_supported: true,
    entity_supported: true,
    target_technology_supported: true,
    indicator_supported: true,
    leading_indicator_supported: true,
    event_stage: "exploratory",
    quality: "pass",
    confidence: 0.83,
    reason: "생산능력 확대 설계가 본문에서 직접 확인됨",
    ...overrides,
  };
}

test("a chat reply wrapped in prose and a code fence still parses", () => {
  const text = '판정 결과입니다.\n\n```json\n[{"ref":"INV-001"}]\n```\n검토 바랍니다.';
  assert.deepEqual(parseResponseArray(text), [{ ref: "INV-001" }]);
});

test("a bare array parses, and unparseable text is rejected", () => {
  assert.deepEqual(parseResponseArray('[{"ref":"REL-002"}]'), [{ ref: "REL-002" }]);
  assert.throws(() => parseResponseArray("판정을 완료했습니다"), /JSON 배열/);
  assert.throws(() => parseResponseArray(""), /빈 응답/);
});

test("a complete entry passes validation", () => {
  assert.deepEqual(validateEntry(entry(), "INV-001"), []);
});

test("a verdict written as a string is refused rather than coerced", () => {
  const errors = validateEntry(entry({ entity_supported: "true" }), "INV-001");
  assert.ok(errors.some((error) => error.includes("boolean이어야 함")));
});

test("values outside the defined vocabularies are refused", () => {
  assert.ok(validateEntry(entry({ event_stage: "maybe" }), "INV-001").some((e) => e.includes("event_stage")));
  assert.ok(validateEntry(entry({ quality: "good" }), "INV-001").some((e) => e.includes("quality")));
});

test("a missing summary or reason is refused", () => {
  assert.ok(validateEntry(entry({ summary_ko: "" }), "INV-001").some((e) => e.includes("summary_ko")));
  assert.ok(validateEntry(entry({ summary_en: "  " }), "INV-001").some((e) => e.includes("summary_en")));
  assert.ok(validateEntry(entry({ reason: "" }), "INV-001").some((e) => e.includes("reason")));
});

test("approval is recomputed here, not taken from the reply", () => {
  // 답변은 승인이라고 말하지만 선행 단계가 아니므로 승인되지 않아야 한다.
  const fields = buildSummaryFields(entry({ event_stage: "completed" }), {
    kind: "investment",
    relevanceExempt: false,
    model: "manual-chat",
  });
  assert.equal(fields.ai_signal_supported, false);
  assert.equal(fields.ai_event_stage, "completed");
});

test("an exempt row is approved without target-technology evidence", () => {
  const overrides = { target_technology_supported: false, reason: "타겟 기술과의 직접적 연관성은 확인되지 않으나 생산 확대 계획이 구체적" };
  const exempt = buildSummaryFields(entry(overrides), { kind: "investment", relevanceExempt: true, model: "m" });
  const gated = buildSummaryFields(entry(overrides), { kind: "investment", relevanceExempt: false, model: "m" });
  assert.equal(exempt.ai_signal_supported, true);
  assert.equal(gated.ai_signal_supported, false);
});

test("merged rows are marked as coming from the manual path", () => {
  const fields = buildSummaryFields(entry(), { kind: "investment", relevanceExempt: false, model: "manual-chat" });
  assert.equal(fields.ai_summary_source, "manual_chat_handoff");
  assert.equal(fields.ai_summary_tier, "manual");
  assert.equal(fields.ai_summary_model, "manual-chat");
});

test("business rows keep a single paragraph and drop headline fields", () => {
  const fields = buildSummaryFields(entry({ event_stage: "not_applicable" }), {
    kind: "relevant",
    relevanceExempt: false,
    model: "m",
  });
  assert.equal(fields.ai_summary_headline_ko, "");
  assert.equal(fields.ai_summary_detail_ko, "");
  assert.ok(fields.ai_summary_ko.length > 0);
});

test("boilerplate and repeated paragraphs are dropped from the brief", () => {
  const text = [
    "Applied plans a new bonding line in Korea next year.",
    "This press release contains forward-looking statements within the meaning of the Act.",
    "Skip to main navigation Investor Relations Financials Stock Info",
    "Applied plans a new bonding line in Korea next year.",
    "short",
  ].join(" ");
  const kept = usefulSentences(text);
  assert.equal(kept.length, 1);
  assert.match(kept[0], /bonding line/);
});

test("the article budget trims whole sentences rather than mid-word", () => {
  const sentences = ["a".repeat(50), "b".repeat(50), "c".repeat(50)];
  const body = trimToBudget(sentences, 110);
  assert.equal(body, `${"a".repeat(50)} ${"b".repeat(50)}`);
});

test("one article carries every target that cites it, but its body once", () => {
  const entries = [
    { ref: "INV-001", url: "https://example.com/a", title: "A", sentences: ["one two three"] },
    { ref: "INV-007", url: "https://example.com/a", title: "A", sentences: ["one two three"] },
    { ref: "REL-002", url: "https://example.com/b", title: "B", sentences: ["four five six"] },
  ];
  const articles = groupByArticle(entries);
  assert.equal(articles.length, 2);
  assert.deepEqual(articles[0].targets.map((t) => t.ref), ["INV-001", "INV-007"]);
  assert.equal(articles[0].sentences.length, 1);
});

test("the brief's short field names expand to the pipeline's field names", () => {
  const entry = expandEntry({ ref: "INV-001", e: 1, t: 0, i: 1, l: 1, stage: "planned", q: "pass", c: 0.8, why: "근거", ko: "요약", en: "summary" });
  assert.equal(entry.entity_supported, true);
  assert.equal(entry.target_technology_supported, false);
  assert.equal(entry.event_stage, "planned");
  assert.equal(entry.quality, "pass");
  assert.equal(entry.reason, "근거");
  assert.deepEqual(validateEntry(entry, "INV-001"), []);
});

test("an approved investment reply gives headline and detail, and the combined form is built", () => {
  const entry = expandEntry({
    ref: "INV-014", ok: 1, e: 1, t: 1, i: 1, l: 1, stage: "planned", q: "pass", c: 0.9,
    why: "확장 계획이 구체적", hko: "군산 생산기지 확장 기반", dko: "반응기 증설로 생산능력 확대",
    hen: "Gunsan site built for expansion", den: "Reactors can be added as demand grows",
  });
  assert.equal(entry.summary_ko, "군산 생산기지 확장 기반 - 반응기 증설로 생산능력 확대");
  assert.equal(entry.summary_en, "Gunsan site built for expansion - Reactors can be added as demand grows");
  assert.deepEqual(validateEntry(entry, "INV-014"), []);
});

test("verdicts written as 0 and 1 are read as booleans, not left as numbers", () => {
  const entry = expandEntry({ ref: "REL-001", e: 1, t: 1, i: 1, l: 1, stage: "not_applicable", q: "pass", c: 0.8, why: "근거", ko: "요약", en: "s" });
  const fields = buildSummaryFields(entry, { kind: "relevant", relevanceExempt: false, model: "m" });
  assert.equal(fields.ai_entity_supported, true);
  assert.equal(fields.ai_signal_supported, true);
});
