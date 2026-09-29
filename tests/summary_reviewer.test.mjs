import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { groupArticles, importReview } from '../scripts/local_report.mjs';
import {
  acceptedIssues, resolveReviewer, reviewerBody, reviewerRequest, reviewSummaries, DEFAULT_REVIEWER_MODEL, REVIEWER_INSTRUCTION,
} from '../scripts/summary_reviewer.mjs';

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

test('flags are recorded without changing the copy, and the same copy is not reviewed twice', async () => {
  const ws = await workspace();
  let calls = 0;
  const stats = await run(ws, async () => { calls += 1; return gemini([{ candidate_id: 'investment:4', issues: [flag] }]); });
  assert.equal(calls, 1);
  assert.equal(stats.mode, 'log_only');
  assert.equal(stats.flagged.length, 1);
  assert.equal(stats.flagged[0].check, 'certainty');
  const saved = await ws.read();
  assert.equal(saved.decisions[0].summary_ko, decision.summary_ko);
  assert.equal(saved.decisions[0].copy_review.issues.length, 1);
  // 기록은 보고서 가져오기를 막지 않는다.
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
