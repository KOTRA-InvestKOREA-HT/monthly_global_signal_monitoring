import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { groupArticles, importReview } from '../scripts/local_report.mjs';
import {
  acceptedIssues, resolveReviewer, reviewAndRewrite, reviewerBody, reviewerRequest, reviewSummaries, DEFAULT_REVIEWER_MODEL,
  REVIEWER_INSTRUCTION,
} from '../scripts/summary_reviewer.mjs';
import { resolveWriter, writeSummaries, writerPolicySection } from '../scripts/summary_writer.mjs';

// Issue 3 Applied Materials: 원문은 "will join"(합류 예정)인데 문안은 "영입했음"(완료)이었다.
const quote = 'Broadcom Inc. will join EPIC as an innovation partner to accelerate development of advanced chip packaging technologies.';
const row = { company: 'Applied Materials', target_no: 1, title: 'Applied Materials reports results', url: 'https://example.com/amat',
  published_at: '2026-08-14', content_text: `Announced three additional EPIC Center partnerships. ${quote} ` +
    'The EPIC Center is designed to reduce the time it takes to commercialize new technologies from early research to full-scale manufacturing.',
  target_technology: 'packaging', target_technology_en: 'packaging', investment_signal_no: 4,
  investment_signal_label_en: 'Technology & R&D Partnerships' };
const article = groupArticles([row], [], { from_date: '2026-08-01', to_date: '2026-08-31' })[0];
const decision = {
  candidate_id: 'investment:4', entity_supported: true, target_technology_supported: true, indicator_supported: true,
  leading_indicator_supported: true, event_stage: 'planned', quality: 'pass', reason: 'New EPIC partner.',
  evidence_quotes: [quote],
  summary_en: 'Broadcom Inc. joined EPIC as an innovation partner to develop advanced chip packaging technologies.',
  summary_ko: 'EPIC Center 파트너 영입 - Applied Materials는 첨단 칩 패키징 기술 개발을 위해 Broadcom Inc.를 EPIC Center 혁신 파트너로 영입했음.',
  summary_quotes: [],
};
const review = { article_id: article.id, reviewer: 'gemini/test', provider: 'gemini', decisions: [decision] };
const reviewer = { ...resolveReviewer({}), delayMs: 0 };
const gemini = reviews => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP',
  content: { parts: [{ text: JSON.stringify({ reviews }) }] } }] }));
const flag = { check: 'certainty', copy_phrase: 'Broadcom Inc.를 EPIC Center 혁신 파트너로 영입했음', source_phrase: 'Broadcom Inc. will join EPIC',
  note: 'The source says Broadcom will join; the copy says it has joined.' };

async function workspace() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'reviewer-'));
  const reviewDir = path.join(root, 'reviews');
  await fsp.mkdir(reviewDir);
  const file = path.join(reviewDir, `${article.id}.json`);
  await fsp.writeFile(file, JSON.stringify(review));
  return { reviewDir, read: async () => JSON.parse(await fsp.readFile(file, 'utf8')) };
}
const run = (ws, fetchImpl) => reviewSummaries({ articles: [article], reviewDir: ws.reviewDir, reviewer, apiKey: 'AIza-test',
  fetchImpl, sleep: async () => {}, log: () => {} });

test('the reviewer runs on flash-lite with high thinking, and can be switched off', () => {
  assert.equal(DEFAULT_REVIEWER_MODEL, 'gemini-3.5-flash-lite');
  assert.equal(resolveReviewer({}).thinkingLevel, 'high');
  assert.equal(resolveReviewer({ GEMINI_REVIEWER_MODEL: 'off' }), null);
});

test('the reviewer sees the copy and its sources only, and asks the four questions', () => {
  const request = reviewerRequest(article, [decision]);
  assert.deepEqual(request.items[0].sources, [quote]);
  assert.equal(JSON.stringify(request).includes(decision.reason), false);
  assert.equal('article_evidence' in request, false);
  for (const check of ['certainty:', 'unsupported:', 'term:', 'mismatch:']) assert.match(REVIEWER_INSTRUCTION, new RegExp(check));
  assert.match(REVIEWER_INSTRUCTION, /Do not rewrite the copy/);
  assert.equal(reviewerBody(reviewer, request).generationConfig.thinkingConfig.thinkingLevel, 'high');
});

test('a flag must quote the copy and the sources exactly, otherwise it is discarded', () => {
  const { accepted, discarded } = acceptedIssues(decision, [
    flag,
    { ...flag, copy_phrase: 'Broadcom Inc.를 파트너로 인수했음' },
    { ...flag, source_phrase: 'Broadcom Inc. joined EPIC' },
    { ...flag, check: 'style' },
  ]);
  assert.equal(accepted.length, 1);
  assert.equal(discarded.length, 3);
});

test('a review is saved with the copy, and the same copy is not reviewed twice', async () => {
  const ws = await workspace();
  let calls = 0;
  const stats = await run(ws, async () => { calls += 1; return gemini([{ candidate_id: 'investment:4', issues: [flag] }]); });
  assert.equal(calls, 1);
  assert.equal(stats.flagged.length, 1);
  assert.equal(stats.flagged[0].check, 'certainty');
  // 투자 시그널의 시제 지적은 다시 쓰게 할 목록에 오른다.
  assert.equal(stats.enforce.length, 1);
  assert.match(stats.enforce[0].problems[0], /^review_certainty: "Broadcom Inc.를 EPIC Center 혁신 파트너로 영입했음" vs source/);
  const saved = await ws.read();
  assert.equal(saved.decisions[0].summary_ko, decision.summary_ko);
  assert.equal(saved.decisions[0].copy_review.issues.length, 1);
  // 검토 자체는 문안을 바꾸거나 보고서 가져오기를 막지 않는다. 다시 쓰기와 내리기는 reviewAndRewrite 가 한다.
  assert.equal(importReview(article, saved)[0].supported, true);
  const again = await run(ws, async () => { calls += 1; return gemini([]); });
  assert.equal(calls, 1);
  assert.equal(again.cached, 1);
  assert.equal(again.flagged.length, 1);
});

test('a quota error stops the review without failing', async () => {
  const ws = await workspace();
  const stats = await run(ws, async () => new Response('', { status: 429 }));
  assert.equal(stats.stopped.reason, 'quota');
  assert.equal(stats.reviewed, 0);
});

test('a term flag on a signal card is recorded but not sent back for rewriting', async () => {
  const ws = await workspace();
  const term = { check: 'term', copy_phrase: 'EPIC Center 파트너 영입', source_phrase: '', note: 'Illustrative term flag.' };
  const stats = await run(ws, async () => gemini([{ candidate_id: 'investment:4', issues: [term] }]));
  assert.equal(stats.flagged.length, 1);
  assert.equal(stats.enforce.length, 0);
});

// 사업동향 문안은 기사 전체를 풀어 쓴다. 검토 모델에게도 본문을 주고, 본문 구절을 댄 지적을 받는다.
test('business copy is reviewed against the article body, signal cards against their sources only', () => {
  const business = groupArticles([], [{ ...row, investment_signal_no: undefined }], { from_date: '2026-08-01', to_date: '2026-08-31' })[0];
  const businessDecision = { ...decision, candidate_id: 'relevant' };
  assert.match(reviewerRequest(business, [businessDecision]).article_evidence, /reduce the time it takes/);
  assert.equal('article_evidence' in reviewerRequest(article, [decision]), false);
  const bodyFlag = { check: 'unsupported', copy_phrase: 'Broadcom Inc.', source_phrase: 'reduce the time it takes', note: 'x' };
  assert.equal(acceptedIssues(businessDecision, [bodyFlag], business.evidence).accepted.length, 1);
  assert.equal(acceptedIssues(decision, [bodyFlag]).accepted.length, 0);
});

const writerAnswer = summaries => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP',
  content: { parts: [{ text: JSON.stringify({ summaries }) }] } }] }));
const fixed = { candidate_id: 'investment:4', source_quotes: [],
  summary_en: 'Broadcom Inc. will join EPIC as an innovation partner to develop advanced chip packaging technologies.',
  summary_ko: 'EPIC 혁신 파트너 합류 예정 - Broadcom Inc.는 첨단 칩 패키징 기술 개발을 위해 Applied Materials의 EPIC Center에 혁신 파트너로 합류할 예정임.' };
const loop = (ws, reviews, onWrite = () => {}) => {
  const writer = { ...resolveWriter({}), delayMs: 0, fallback: null };
  const wording = writerPolicySection(fs.readFileSync(new URL('../docs/local_report_review.md', import.meta.url), 'utf8'));
  return reviewAndRewrite({ articles: [article], reviewDir: ws.reviewDir, reviewer, apiKey: 'AIza-test',
    fetchImpl: async () => gemini(reviews()), sleep: async () => {}, log: () => {},
    rewrite: feedback => writeSummaries({ articles: [article], reviewDir: ws.reviewDir, writer, apiKey: 'AIza-test', policyWording: wording,
      feedback, fetchImpl: async (url, init) => { onWrite(JSON.parse(init.body).contents[0].parts[0].text); return writerAnswer([fixed]); },
      sleep: async () => {}, log: () => {} }) });
};

test('a flagged signal card is rewritten with the flag as feedback, and kept once the review is clean', async () => {
  const ws = await workspace();
  const sent = [];
  let reviews = 0;
  const stats = await loop(ws, () => (reviews++ === 0 ? [{ candidate_id: 'investment:4', issues: [flag] }] : [{ candidate_id: 'investment:4', issues: [] }]),
    body => sent.push(body));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /rejected_because/);
  assert.match(sent[0], /review_certainty/);
  assert.equal(stats.rounds.length, 1);
  assert.deepEqual(stats.withdrawn, []);
  const saved = await ws.read();
  assert.equal(saved.decisions[0].summary_ko, fixed.summary_ko);
  assert.equal(importReview(article, saved)[0].supported, true);
});

test('a signal card still flagged after two rewrites is withdrawn from the report and kept for the dashboard', async () => {
  const ws = await workspace();
  let writes = 0;
  const stats = await loop(ws, () => [{ candidate_id: 'investment:4',
    issues: [{ check: 'unsupported', copy_phrase: 'Broadcom Inc.', source_phrase: '', note: 'Illustrative persistent flag.' }] }], () => writes++);
  assert.equal(writes, 2);
  assert.equal(stats.rounds.length, 2);
  assert.equal(stats.withdrawn.length, 1);
  const saved = await ws.read();
  assert.equal(saved.decisions[0].summary_ko, '');
  assert.deepEqual(saved.summary_failed.candidate_ids, ['investment:4']);
  const [result] = importReview(article, saved);
  assert.equal(result.supported, false);
  assert.equal(result.near_miss, true);
});

// 시제는 날짜로 판단한다. 게시일을 모르는 검토 모델은 제 날짜의 일을 현재형으로 쓴 발표를 미래로 읽었다.
test('the reviewer is told the published date and reporting period, and judges tense by date', () => {
  const request = reviewerRequest(article, [decision]);
  assert.equal(request.published_date, '2026-08-14');
  assert.deepEqual(request.reporting_period, { from_date: '2026-08-01', to_date: '2026-08-31' });
  assert.match(REVIEWER_INSTRUCTION, /Decide what is future by date, not by grammatical tense/);
});

test('a certainty flag on business copy is sent back for rewriting; other business flags are only recorded', async () => {
  const business = groupArticles([], [{ ...row, investment_signal_no: undefined }], { from_date: '2026-08-01', to_date: '2026-08-31' })[0];
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'reviewer-business-'));
  const reviewDir = path.join(root, 'reviews');
  await fsp.mkdir(reviewDir);
  const businessDecision = { ...decision, candidate_id: 'relevant', leading_indicator_supported: true, event_stage: 'not_applicable',
    summary_ko: 'Applied Materials는 첨단 칩 패키징 기술 개발을 위해 Broadcom Inc.를 EPIC Center 혁신 파트너로 영입했음.' };
  await fsp.writeFile(path.join(reviewDir, `${business.id}.json`),
    JSON.stringify({ article_id: business.id, reviewer: 'gemini/test', provider: 'gemini', decisions: [businessDecision] }));
  const issues = [{ ...flag, copy_phrase: 'Broadcom Inc.를 EPIC Center 혁신 파트너로 영입했음' },
    { check: 'term', copy_phrase: '혁신 파트너', source_phrase: '', note: 'Illustrative term flag.' }];
  const stats = await reviewSummaries({ articles: [business], reviewDir, reviewer, apiKey: 'AIza-test',
    fetchImpl: async () => gemini([{ candidate_id: 'relevant', issues }]), sleep: async () => {}, log: () => {} });
  assert.equal(stats.flagged.length, 2);
  assert.equal(stats.enforce.length, 1);
  assert.equal(stats.enforce[0].problems.length, 1);
  assert.match(stats.enforce[0].problems[0], /^review_certainty/);
});

// 근접 사업동향 행은 보고서 본문에 실리지 않는다. 지적은 기록하되 다시 쓰게 하거나 내리지 않는다.
test('a near-miss business row is flagged but never sent back or withdrawn', async () => {
  const business = groupArticles([], [{ ...row, investment_signal_no: undefined }], { from_date: '2026-08-01', to_date: '2026-08-31' })[0];
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'reviewer-nearmiss-'));
  const reviewDir = path.join(root, 'reviews');
  await fsp.mkdir(reviewDir);
  const nearMiss = { ...decision, candidate_id: 'relevant', target_technology_supported: false, event_stage: 'not_applicable',
    summary_ko: 'Applied Materials는 첨단 칩 패키징 기술 개발을 위해 Broadcom Inc.를 EPIC Center 혁신 파트너로 영입했음.' };
  await fsp.writeFile(path.join(reviewDir, `${business.id}.json`),
    JSON.stringify({ article_id: business.id, reviewer: 'gemini/test', provider: 'gemini', decisions: [nearMiss] }));
  const stats = await reviewSummaries({ articles: [business], reviewDir, reviewer, apiKey: 'AIza-test',
    fetchImpl: async () => gemini([{ candidate_id: 'relevant', issues: [{ ...flag, copy_phrase: 'Broadcom Inc.를 EPIC Center 혁신 파트너로 영입했음' }] }]),
    sleep: async () => {}, log: () => {} });
  assert.equal(stats.flagged.length, 1);
  assert.equal(stats.enforce.length, 0);
});
