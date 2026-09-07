import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { groupArticles, importReview, inPeriod, monthPeriod, sourceCandidates } from "../scripts/local_report.mjs";
import { periodPlacement, reviewCandidate } from "../scripts/date_state.mjs";

const period = monthPeriod("2026-08");
const source = {
  target_no: 1, company: "Example", title: "Example plans a pilot",
  url: "https://example.com/pilot", published_at: "2026-08-10T00:00:00Z",
  target_technology: "target material", investment_signal_no: 2,
  content_text: "Example is considering a new pilot plant for its target material.",
};
const article = () => groupArticles([source], [], period)[0];
const decision = (overrides = {}) => ({
  candidate_id: "investment:2", entity_supported: true, target_technology_supported: true,
  indicator_supported: true, leading_indicator_supported: true, event_stage: "planned", quality: "pass",
  reason_ko: "타겟 소재의 생산시설 검토가 본문에 명시됨", evidence_quotes: [source.content_text],
  summary_ko: "타겟 소재 파일럿 시설 검토", summary_en: "Target-material pilot plant under consideration", ...overrides,
});
const review = (a, decisions = [decision()]) => ({ article_id: a.id, reviewer: "test", decisions });

test("month filtering matches UTC boundaries, leap years, and unknown dates", () => {
  assert.equal(monthPeriod("2024-02").to_date, "2024-02-29");
  assert.throws(() => monthPeriod("2026-13"));
  assert.equal(inPeriod({ published_at: "2026-09-01T08:59:59+09:00" }, period), true);
  assert.equal(inPeriod({ published_at: "2026-09-01T09:00:00+09:00" }, period), false);
  assert.equal(inPeriod({ published_at: "2026-08-01T00:00:00" }, period), true);
  assert.equal(inPeriod({ published_at: null }, period), false);
  assert.equal(inPeriod({ published_at: "invalid" }, period), false);
});

test("groups indicators for one company/article, preserves distinct companies and filters before review", () => {
  const groups = groupArticles([source, { ...source, investment_signal_no: 4 },
    { ...source, company: "Subsidiary", target_no: 2 }], [source], period);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].candidates.length, 3);
  assert.equal(groups[0].evidence.filter((text) => text === source.content_text).length, 1);
  assert.throws(() => groupArticles([source, source], [], period), /Duplicate candidate/);
});

test("review identity ignores old AI prose and crawl timestamps but changes with evidence and policy", () => {
  const original = article().id;
  assert.equal(groupArticles([{ ...source, ai_signal_supported: false, collected_at: "later" }], [], period)[0].id, original);
  assert.notEqual(groupArticles([{ ...source, content_text: "Different evidence" }], [], period)[0].id, original);
  assert.notEqual(groupArticles([source], [], period, "changed-policy")[0].id, original);
  assert.notEqual(groupArticles([{ ...source, target_technology: "different" }], [], period)[0].id, original);
});

test("rejects missing, duplicated, stale and ungrounded reviews", () => {
  const a = article();
  assert.throws(() => importReview(a, review(a, [])), /every candidate/);
  assert.throws(() => importReview(a, { ...review(a), article_id: "old" }), /stale/);
  assert.throws(() => importReview(a, review(a, [decision({ candidate_id: "unknown" })])), /unknown/);
  assert.throws(() => importReview(a, review(a, [decision({ evidence_quotes: ["Invented investment"] })])), /exact passages/);
  assert.throws(() => importReview(a, review(a, [decision({ evidence_quotes: [] })])), /needs an evidence quote/);
  assert.throws(() => importReview(a, review(a, [decision({ entity_supported: "true" })])), /missing boolean/);
  assert.throws(() => importReview(a, review(a, [decision({ event_stage: "not_applicable" })])), /invalid event_stage/);
  const multi = groupArticles([source, { ...source, investment_signal_no: 4 }], [], period)[0];
  assert.throws(() => importReview(multi, review(multi, [decision(), decision()])), /duplicate/);
});

test('not_applicable investment stages record a rejection and still validate evidence and fields', () => {
  const a = article();
  const rejected = decision({ event_stage: 'not_applicable', indicator_supported: false,
    leading_indicator_supported: false, evidence_quotes: [], summary_ko: '', summary_en: '' });
  for (const quality of ['pass', 'needs_review']) {
    const result = importReview(a, review(a, [{ ...rejected, quality }]));
    assert.equal(result[0].supported, false);
    assert.equal(result[0].row, null);
  }
  // A decision that falls short on any approval field has nothing to stage, so
  // not_applicable is an honest answer rather than a contradiction. Observed
  // shape: the model matched the indicator but found no leading-indicator
  // evidence. Rejecting these discarded the whole article, other candidates
  // included, over a field that cannot approve anything.
  for (const flags of [{ indicator_supported: true }, { leading_indicator_supported: true },
    { indicator_supported: true, quality: 'needs_review' }, { target_technology_supported: false }]) {
    const result = importReview(a, review(a, [{ ...rejected, ...flags }]));
    assert.equal(result[0].supported, false);
    assert.equal(result[0].row, null);
  }
  // The stage is the only thing blocking approval here: that contradiction is
  // what the retry exists to resolve, so it must stay loud.
  assert.throws(() => importReview(a, review(a, [decision({ event_stage: 'not_applicable' })])), /invalid event_stage/);
  assert.throws(() => importReview(a, review(a, [{ ...rejected, indicator_supported: 'false' }])), /missing boolean/);
  assert.throws(() => importReview(a, review(a, [{ ...rejected, evidence_quotes: ['Fabricated quote'] }])), /exact passages/);
  assert.throws(() => importReview(a, review(a, [{ ...rejected, reason_ko: '' }])), /reason_ko/);
});

test('Albemarle table quotes accept currency and percent padding without changing numbers', () => {
  const a = article();
  a.evidence = ['Sales Volume (kT LCE) (a) 65 59 6 11.0&nbsp;% Avg. Realized Price ($/kg LCE) (a) $&nbsp;&nbsp;19.53 $&nbsp;&nbsp;12.17 $&nbsp;7.36 60.5&nbsp;%'];
  const quotes = ['Sales Volume (kT LCE) (a) 65 59 6 11.0%', 'Avg. Realized Price ($/kg LCE) (a) $19.53 $12.17 $7.36 60.5%'];
  assert.equal(importReview(a, review(a, [decision({ evidence_quotes: quotes })]))[0].supported, true);
  for (const quote of [quotes[0].replace('65 59', '6559'), quotes[0].replace('11.0', '110'),
    quotes[1].replace('$19.53', '$19.35'), quotes[1].replace('$19.53', '€19.53'), quotes[1].replace('$7.36', '$-7.36')]) {
    assert.throws(() => importReview(a, review(a, [decision({ evidence_quotes: [quote] })])), /exact passages/);
  }
});

test("only supported decisions need bilingual prose; rejection does not become a report row", () => {
  const a = article();
  assert.throws(() => importReview(a, review(a, [decision({ summary_en: "" })])), /missing ai_summary_en/);
  assert.throws(() => importReview(a, review(a, [decision({ reason_ko: "no direct evidence" })])), /denies direct relevance/);
  for (const overrides of [{ quality: "needs_review" }, { event_stage: "completed" }, { entity_supported: false }]) {
    const result = importReview(a, review(a, [decision({ ...overrides, summary_ko: "", summary_en: "" })]))[0];
    assert.equal(result.supported, false);
    assert.equal(result.row, null);
  }
  assert.equal(importReview(a, review(a))[0].row.ai_summary_source, "local_agent_review");
});

test('quote matching accepts typography and entities but rejects paraphrases, changed numbers and cross-block joins', () => {
  const a = article();
  a.evidence = ['Japan’s CCS hub uses Mizushima&rsquo;s strengths &amp; CO₂&#160;capture—planned.', 'Capacity is 10 tonnes.', 'Separate block.'];
  const original = JSON.stringify(a);
  const check = quote => importReview(a, review(a, [decision({ evidence_quotes: [quote] })]));
  assert.equal(check("Japan's CCS hub uses Mizushima's strengths & CO2 capture-planned.")[0].supported, true);
  for (const quote of ['Capacity is 100 tonnes.', 'Japan has a CCS hub', '10 tonnes. Separate block.', '&nbsp;', 10]) {
    assert.throws(() => check(quote), /exact passages/);
  }
  assert.equal(JSON.stringify(a), original);
});

test("relevance exemption never bypasses entity or leading-event requirements", () => {
  const a = groupArticles([{ ...source, excluded_from_relevance: true }], [], period)[0];
  assert.equal(importReview(a, review(a, [decision({ target_technology_supported: false })]))[0].supported, true);
  assert.equal(importReview(a, review(a, [decision({ target_technology_supported: false, entity_supported: false })]))[0].supported, false);
  assert.equal(importReview(a, review(a, [decision({ event_stage: "committed" })]))[0].supported, false);
});

test("CLI prepares isolated files and refuses incomplete builds without changing source data", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "local-report-"));
  const dataDir = path.join(temp, "data"), outDir = path.join(temp, "runs");
  const cli = (args) => spawnSync(process.execPath, ["scripts/local_report.mjs", ...args], { encoding: "utf8" });
  try {
    await fs.mkdir(dataDir);
    const inputs = {
      "latest_collection_summary.json": period,
      "latest_company_signals.json": [{ ...source, company: "Australian Strategic Metals" }],
    };
    for (const [name, value] of Object.entries(inputs)) await fs.writeFile(path.join(dataDir, name), JSON.stringify(value));
    const args = ["prepare", "--data-dir", dataDir, "--out-dir", outDir, "--month", "2026-08"];
    const prepared = cli(args);
    assert.equal(prepared.status, 0, prepared.stderr);
    const runName = (await fs.readdir(outDir)).find((name) => name.startsWith("2026-08-"));
    const runDir = path.join(outDir, runName);
    const blocked = cli(["build", "--run-dir", runDir]);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /1 pending articles/);
    assert.equal((await fs.readdir(runDir)).some((name) => name.startsWith("report-")), false);
    assert.equal(cli([...args.slice(0, -1), "2026-09"]).status, 1);
    assert.equal(cli(args).status, 0);
    const snapshot = JSON.parse(await fs.readFile(path.join(runDir, "snapshot.json"), "utf8"));
    const preparedArticle = snapshot.articles[0];
    const reviewFile = path.join(outDir, "reviews", `${preparedArticle.id}.json`);
    const reviewed = JSON.stringify(review(preparedArticle, preparedArticle.candidates.map((candidate) => decision({
      candidate_id: candidate.id, indicator_supported: candidate.kind === "relevant",
      leading_indicator_supported: candidate.kind === "relevant", event_stage: candidate.kind === "relevant" ? "not_applicable" : "unclear",
      entity_supported: false,
    }))));
    await fs.writeFile(reviewFile, reviewed);
    assert.equal(cli(["status", "--run-dir", runDir]).status, 0);
    assert.equal(cli(args).status, 0);
    assert.equal(await fs.readFile(reviewFile, "utf8"), reviewed, "prepare must preserve completed reviews");
    const previous = path.join(runDir, "report-previous");
    await fs.mkdir(previous);
    await fs.writeFile(path.join(previous, "report_ko.pdf"), "previous report bytes");
    const failed = cli(["build", "--run-dir", runDir, "--python", path.join(temp, "missing-python")]);
    assert.equal(failed.status, 1);
    assert.equal(await fs.readFile(path.join(previous, "report_ko.pdf"), "utf8"), "previous report bytes");
    assert.deepEqual((await fs.readdir(runDir)).filter((name) => name.startsWith("report-")), ["report-previous"]);
    snapshot.signals = [];
    await fs.writeFile(path.join(runDir, "snapshot.json"), JSON.stringify(snapshot));
    const modified = cli(["build", "--run-dir", runDir]);
    assert.equal(modified.status, 1);
    assert.match(modified.stderr, /snapshot was modified/);
    for (const [name, value] of Object.entries(inputs)) assert.equal(await fs.readFile(path.join(dataDir, name), "utf8"), JSON.stringify(value));
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});


test("raw source review includes keyword misses and technology rejects for all five indicators", () => {
  const technology = { companies: [{ company: source.company, target_no: 1, target_technology: "target", excluded_from_relevance: false }] };
  const indicators = { indicators: [1,2,3,4,5].map((no) => ({no, label_ko: `S${no}`})) };
  const candidates = sourceCandidates([{ ...source, passed: false }], technology, indicators, period);
  assert.equal(candidates.investment.length, 5);
  assert.equal(candidates.relevant.length, 1);
  assert.equal(candidates.investment[4].investment_signal_no, 5);
  assert.equal(candidates.investment[0].technology_gate_decision, "agent_review");
  assert.throws(() => sourceCandidates([source], { companies: [] }, indicators, period), /Missing target/);
});

test("confirmed research precursor is accepted but cannot turn completed factories into signals", () => {
  const a = groupArticles([{ ...source, investment_signal_no: 4 }], [], period)[0];
  assert.equal(importReview(a, review(a, [decision({candidate_id: "investment:4", event_stage: "precursor"})]))[0].supported, true);
  assert.equal(importReview(article(), review(article(), [decision({event_stage: "precursor"})]))[0].supported, false);
});


test("technology-exempt business rows still require concrete activity", () => {
  const a = groupArticles([], [{...source, excluded_from_relevance:true}], period)[0];
  const result = importReview(a, review(a, [decision({candidate_id:"relevant", event_stage:"not_applicable", target_technology_supported:false, indicator_supported:false, evidence_quotes:[]})]));
  assert.equal(result[0].supported, false);
});


test("date state separates report eligibility from review eligibility", () => {
  const undated = { ...source, published_at: null, published_at_source: "" };
  // 게시일이 없어도 본문이 있으면 검토는 한다. 다만 보고서 본문에는 들어가지 않는다.
  assert.equal(reviewCandidate(undated, period).included, true);
  assert.equal(inPeriod(undated, period), false);
  assert.equal(periodPlacement(undated, period).placement, "date_pending");
  // 근거도 본문도 없는 링크는 수집 보완 대상이지 검토 대상이 아니다.
  assert.equal(reviewCandidate({ ...undated, content_text: "" }, period).included, false);
  // 공식 자료로 게시월까지 확인되면 일자가 없어도 그 달 보고서 후보다.
  const monthOnly = { ...source, published_at: null, published_month: "2026-08", published_at_source: "listing" };
  assert.equal(inPeriod(monthOnly, period), true);
  // 같은 게시월이라도 선택 기간이 월 전체가 아니면 포함 여부를 확인해야 한다.
  assert.equal(inPeriod(monthOnly, { from_date: "2026-08-10", to_date: "2026-08-20" }), false);
  // 본문에서 처음 찾은 날짜는 사건 발생일일 수 있으므로 게시일로 확정하지 않는다.
  assert.equal(inPeriod({ ...source, published_at_source: "body_text" }, period), false);
  assert.equal(reviewCandidate({ ...source, published_at_source: "body_text" }, period).included, true);
  // 수정일만 있는 7월 기사를 8월 신규 기사로 잡지 않는다.
  const modifiedOnly = { ...source, published_at: "2026-08-20T00:00:00Z", published_at_source: "modified_meta" };
  assert.equal(inPeriod(modifiedOnly, period), false);
  // 확정 근거끼리 어긋나면 날짜를 확인하기 전까지 본문에 넣지 않는다.
  assert.equal(inPeriod({ ...source, published_at_source: "listing", date_conflict: true }, period), false);
  // 확인된 근거가 기간 밖이면 검토 대상도 아니다.
  assert.equal(reviewCandidate({ ...source, published_at: "2026-07-10T00:00:00Z" }, period).included, false);
});

test("review identity survives a recovered date so a corrected article is not reviewed twice", () => {
  const undated = { ...source, published_at: null, published_at_source: "" };
  const before = groupArticles([undated], [], period)[0];
  const after = groupArticles([{ ...undated, published_at: source.published_at, published_at_source: "meta" }], [], period)[0];
  assert.equal(before.id, after.id);
  assert.equal(before.date_status, "unknown");
  assert.equal(after.date_placement, "in_period");
});
