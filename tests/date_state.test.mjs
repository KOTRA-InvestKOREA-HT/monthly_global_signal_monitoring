import assert from "node:assert/strict";
import test from "node:test";
import { chooseDateEvidence, periodPlacement, reportEligible, resolveDateState, reviewCandidate } from "../scripts/date_state.mjs";
import { collectHtmlDateEvidence, dateEvidence, usableMonthlySource } from "../scripts/collect_company_signals.mjs";

const period = { from_date: "2026-08-01", to_date: "2026-08-31" };
const chooseFrom = (html, url = "") => chooseDateEvidence(collectHtmlDateEvidence(html, url));

test("publication and modification dates are collected as separate evidence", () => {
  const chosen = chooseFrom(`<head><meta property="article:published_time" content="2026-07-12T09:00:00Z">
    <meta property="article:modified_time" content="2026-08-20T10:00:00Z"></head>`);
  assert.equal(chosen.published_at, "2026-07-12T09:00:00Z");
  assert.equal(chosen.modified_at, "2026-08-20T10:00:00Z");
  assert.equal(reportEligible(chosen, period), false, "a July article must not become an August one");
  // 수정일만 있는 기사는 게시일을 추정한 것으로 남는다.
  const modifiedOnly = chooseFrom(`<head><meta property="article:modified_time" content="2026-08-20T10:00:00Z"></head>`);
  assert.equal(modifiedOnly.published_at_source, "modified_meta");
  assert.equal(modifiedOnly.published_at_status, "estimated");
  assert.equal(reportEligible(modifiedOnly, period), false);
});

test("month-only dates stay month-precision instead of becoming the first of the month", () => {
  const chosen = chooseFrom(`<head><meta name="datePublished" content="2026-08"></head>`);
  assert.equal(chosen.published_at, null);
  assert.equal(chosen.published_month, "2026-08");
  assert.equal(chosen.published_at_precision, "month");
  assert.equal(reportEligible(chosen, period), true, "a confirmed publication month is enough for that month's report");
  assert.equal(reportEligible(chosen, { from_date: "2026-08-10", to_date: "2026-08-20" }), false);
  // 연도만 적힌 값은 1월 1일이 아니라 근거 없음이다.
  assert.equal(dateEvidence("2026", "meta"), null);
});

test("conflicting confirmed evidence is held instead of silently picking one date", () => {
  const chosen = chooseDateEvidence([dateEvidence("2026-08-05", "listing"), dateEvidence("2026-07-30", "meta")]);
  assert.equal(chosen.published_at_status, "conflicting");
  assert.equal(chosen.date_conflict, true);
  assert.equal(reportEligible(chosen, period), false);
  // 8월을 가리키는 근거가 하나라도 있으면 내용 검토 대상으로는 남는다.
  assert.equal(reviewCandidate({ ...chosen, content_text: "body" }, period).included, true);
  // 월 단위 근거와 그 달의 일자 근거는 어긋난 것이 아니다.
  const agreeing = chooseDateEvidence([dateEvidence("2026-08", "meta"), dateEvidence("2026-08-14", "listing")]);
  assert.equal(agreeing.published_at_status, "confirmed");
});

test("English month names are read as UTC so the first of a month keeps its month", () => {
  const chosen = chooseFrom("<body>Published August 1, 2026 in Seoul</body>");
  assert.equal(resolveDateState(chosen).day, "2026-08-01");
  assert.equal(chosen.published_at_source, "text");
  assert.equal(chosen.published_at_status, "estimated", "a date found in page text is not a publication date");
});

test("fallback collection is not suppressed by an article whose date is only estimated", () => {
  const range = { fromMs: Date.parse("2026-08-01"), toMs: Date.parse("2026-09-01") - 1 };
  const row = { published_at: "2026-08-20", source_type: "official", content_fetch_status: "fetched", content_text: "body" };
  assert.equal(usableMonthlySource({ ...row, published_at_source: "feed" }, range), true);
  assert.equal(usableMonthlySource({ ...row, published_at_source: "body_text" }, range), false);
});

test("period placement keeps date work separate from content review", () => {
  const pending = periodPlacement({ published_at: null, published_at_source: "" }, period);
  assert.equal(pending.placement, "date_pending");
  assert.match(pending.reason, /근거/);
  assert.equal(periodPlacement({ published_at: "2026-07-01T00:00:00Z", published_at_source: "feed" }, period).placement, "out_of_period");
});
