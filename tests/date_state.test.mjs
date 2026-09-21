import assert from "node:assert/strict";
import test from "node:test";
import { chooseDateEvidence, hasArticleBody, periodPlacement, reportEligible, resolveDateState, reviewCandidate, unextractableBody } from "../scripts/date_state.mjs";
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

test('periodic documents dated by their title year cannot be this month without a confirmed date', async () => {
  const { periodicDocumentPublicationYear, periodPlacement: place } = await import('../scripts/date_state.mjs');
  const august = { from_date: '2026-08-01', to_date: '2026-08-31' };
  const undated = (title, url = '') => ({ title, url, published_at: null, published_at_source: '', date_candidates: [] });
  assert.equal(periodicDocumentPublicationYear(undated('annual report 2023 lres', 'https://www.umicore.com/storage/demo_2024/annual-report-2023-lres.pdf')), 2024);
  assert.equal(periodicDocumentPublicationYear(undated('2025 Proxy Statement of 2024, PDF file')), 2025);
  assert.equal(place(undated('annual report 2023 lres'), august).placement, 'out_of_period');
  assert.equal(place(undated('umicore integrated annual report 2022'), august).placement, 'out_of_period');
  assert.equal(place(undated('2025 Proxy Statement of 2024, PDF file, (opens in new window)'), august).placement, 'out_of_period');
  assert.equal(place(undated('Sustainability Report 2023', 'https://assets.example.com/dam/x/Siemens-Energy_Sustainability-Report-2023.pdf'), august).placement, 'out_of_period');
  // This year's publication of last year's report may be this month; keep it for review.
  assert.equal(place(undated('2025 Annual Report of 2025, PDF file'), august).placement, 'date_pending');
  // A confirmed August press release about a report is judged by its date, not its title.
  const confirmed = { title: 'Chemours Publishes 2023 Sustainability Report', published_at: '2026-08-25T00:00:00Z',
    published_month: '2026-08', published_at_source: 'jsonld', date_candidates: [] };
  assert.equal(place(confirmed, august).placement, 'in_period');
  // Ordinary headlines with a year are not periodic documents.
  assert.equal(periodicDocumentPublicationYear(undated('Energy Fuels completes acquisition of ASM in 2024 deal')), null);
});

// 2026-09 수집본 607행 중 8행의 본문이 PDF·XLSX 를 글자로 읽은 바이트였다(Merck 재무제표 XLS,
// Nabtesco 결산 PDF 5건, Renishaw 중간실적 PDF 2건). 2만 자가 넘어 길이 검사를 통과하고 그대로
// 근거가 되어, 모델이 "PK..[Content_Types].xml" 을 읽고 판단하게 된다. 프롬프트로는 풀 수 없다.
test("a body that is really a binary document is not evidence", () => {
  const pdf = "%PDF-1.6\r%��\r\n6587 0 obj\r >\rendobj\r ".padEnd(900, "x");
  const xlsx = "PK\u0003\u0004\u0014\u0000\u0006\u0000[Content_Types].xml ".padEnd(900, "y");
  assert.equal(unextractableBody(pdf), "binary_document");
  assert.equal(unextractableBody(xlsx), "binary_document");
  for (const text of [pdf, xlsx]) assert.equal(hasArticleBody({ content_text: text }), false);

  // 매직 바이트가 없어도 제어문자가 섞인 본문은 추출 실패로 본다. 실제 8건은 9.9% 이상이었다.
  const scrambled = "Nabtesco reported results. ".repeat(20).split("")
    .map((character, index) => (index % 20 === 0 ? "\u0001" : character)).join("");
  assert.equal(unextractableBody(scrambled), "undecoded_bytes");
  assert.equal(hasArticleBody({ content_text: scrambled }), false);
});

test("ordinary article bodies keep counting as evidence", () => {
  const body = "Nabtesco reported that orders for precision reduction gears rose 11% in the second quarter. ".repeat(4);
  assert.equal(unextractableBody(body), "");
  assert.equal(hasArticleBody({ content_text: body }), true);
  // 줄바꿈과 탭은 제어문자로 세지 않는다. 정상 본문 457건의 제어문자 비율은 모두 0이었다.
  assert.equal(unextractableBody(body.replace(/\. /g, ".\n\t")), "");
  // 빈 본문은 추출 실패가 아니라 그냥 본문 없음이다. 그 판정은 길이 검사가 맡는다.
  assert.equal(unextractableBody(""), "");
  assert.equal(hasArticleBody({ content_text: "   " }), false);
});
