import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reviewArticles, MODEL } from '../scripts/review_report.mjs';
import { groupArticles } from '../scripts/local_report.mjs';

// 수집한 본문이 기사인지 목록·오류 페이지인지는 길이로도 갈린다. 고정값도 실제 기사 길이를 쓴다.
const TAIL = "The company said the site would support qualification volumes first, "
  + "that a final location has not been chosen, and that no construction contract has been signed. "
  + "It declined to give a timeline, and said the plan stays under review until the board meets.";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const article = company => groupArticles([{ company, target_no: 1, title: company, published_at: '2026-08-01', investment_signal_no: 2 }], [],
  { from_date: '2026-08-01', to_date: '2026-08-31' })[0];
const ok = () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ decisions: [{
  candidate_id: 'investment:2', entity_supported: true, target_technology_supported: false,
  indicator_supported: false, leading_indicator_supported: false, event_stage: 'not_applicable',
  quality: 'pass', reason_ko: '투자 해당 없음', evidence_quotes: [], summary_ko: '', summary_en: '',
}] }) } }] }));
async function setup(t, count = 5) {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'parallel-review-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  return { articles: Array.from({ length: count }, (_, i) => article(`Company${i}`)), reviewDir, policy: '',
    config: { apiKey: 'test', maxRequests: 40, delayMs: 10, concurrency: 3 } };
}

test('overlaps responses while spacing every request start and reuses all caches', async t => {
  const args = await setup(t);
  const starts = [];
  let active = 0, peak = 0;
  const state = await reviewArticles({ ...args, fetchImpl: async () => {
    starts.push(performance.now()); peak = Math.max(peak, ++active);
    await sleep(55); active--; return ok();
  } });
  assert.equal(state.status, 'completed');
  assert.equal(state.completed, 5);
  assert.equal(state.requests, 5);
  assert.ok(peak > 1 && peak <= 3);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i-1] >= 9);
  const cached = await reviewArticles({ ...args, fetchImpl: async () => { throw new Error('unexpected API request'); } });
  assert.equal(cached.cached, 5); assert.equal(cached.requests, 0);
});

test('global budget counts retries and preserves other completed articles', async t => {
  const args = await setup(t);
  let calls = 0;
  const state = await reviewArticles({ ...args, config: { ...args.config, maxRequests: 3 }, fetchImpl: async () => {
    calls++; return calls === 1 ? new Response('{}') : ok();
  } });
  assert.equal(calls, 3);
  assert.equal(state.requests, 3);
  assert.equal(state.reason, 'request_budget');
  assert.equal(state.completed, 2);
  const resumed = await reviewArticles({ ...args, fetchImpl: async () => ok() });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.cached, 2);
});

test('quota stops queued calls but drains successful in-flight results', async t => {
  const args = await setup(t);
  let calls = 0;
  const state = await reviewArticles({ ...args, fetchImpl: async () => {
    if (++calls === 1) { await sleep(60); return ok(); }
    return new Response('', { status: 429 });
  } });
  assert.equal(calls, 2);
  assert.equal(state.reason, 'quota');
  assert.equal(state.completed, 1);
  await fs.access(path.join(args.reviewDir, `${args.articles[0].id}.json`));
});

test('authentication failure waits for in-flight cache writes before rejecting', async t => {
  const args = await setup(t);
  let calls = 0;
  await assert.rejects(reviewArticles({ ...args, fetchImpl: async () => {
    if (++calls === 1) { await sleep(60); return ok(); }
    return new Response('', { status: 403 });
  } }), /HTTP 403/);
  assert.equal(calls, 2);
  await fs.access(path.join(args.reviewDir, `${args.articles[0].id}.json`));
});

// 게시일 미상 기사. 본문은 있으나 날짜 근거가 없어 date_pending 으로 들어온다.
const rejection = { candidate_id: 'investment:2', entity_supported: true, target_technology_supported: false,
  indicator_supported: false, leading_indicator_supported: false, event_stage: 'not_applicable',
  quality: 'pass', reason_ko: '투자 해당 없음', evidence_quotes: [], summary_ko: '', summary_en: '' };
const pendingArticle = company => groupArticles([{ company, target_no: 1, title: company, published_at: null,
  published_at_source: '', investment_signal_no: 2, content_text: `Body without a date. ${TAIL}` }], [],
  { from_date: '2026-08-01', to_date: '2026-08-31' })[0];

test('a failed date-hint supplement never stops the other workers reviewing uncached articles', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'parallel-supplement-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const pending = pendingArticle('Undated');
  const articles = [pending, ...Array.from({ length: 4 }, (_, i) => article(`Company${i}`))];
  await fs.writeFile(path.join(reviewDir, `${pending.id}.json`), JSON.stringify({ article_id: pending.id,
    reviewer: `${MODEL}/article-review-v1`, provider: 'nvidia', decisions: [rejection] }));
  let supplements = 0;
  const state = await reviewArticles({ articles, reviewDir, policy: '',
    config: { apiKey: 'test', maxRequests: 40, delayMs: 30, concurrency: 3 },
    fetchImpl: async (url, init) => {
      // 보강 요청은 캐시된 미상 기사에만 나간다. 그것만 429 로 떨어뜨린다.
      if (JSON.parse(init.body).messages[1].content.includes('Undated')) { supplements++; return new Response('', { status: 429 }); }
      return ok();
    } });
  assert.equal(supplements, 1);
  // 보강 실패가 공유 스케줄러를 멈추면 뒤에 남은 기사들이 판정 없이 끝난다.
  assert.equal(state.status, 'completed');
  assert.equal(state.completed, 5);
  assert.equal(state.cached, 1);
  assert.equal(state.date_hints, 0);
  assert.equal(state.requests, 5);
  for (const a of articles.slice(1)) await fs.access(path.join(reviewDir, `${a.id}.json`));
});

test('one failed supplement stops the whole run supplementing, not just its own article', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'parallel-supplement-stop-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  // 캐시된 미상 기사 셋, 판정이 필요한 기사 둘.
  const pending = ['A', 'B', 'C'].map(pendingArticle);
  const fresh = ['D', 'E'].map(article);
  await Promise.all(pending.map(a => fs.writeFile(path.join(reviewDir, `${a.id}.json`),
    JSON.stringify({ article_id: a.id, reviewer: `${MODEL}/article-review-v1`, provider: 'nvidia', decisions: [rejection] }))));
  let supplements = 0, contentCalls = 0;
  const state = await reviewArticles({ articles: [...pending, ...fresh], reviewDir, policy: '',
    config: { apiKey: 'test', maxRequests: 40, delayMs: 30, concurrency: 3 },
    fetchImpl: async (url, init) => {
      const company = JSON.parse(JSON.parse(init.body).messages[1].content).company;
      if (['A', 'B', 'C'].includes(company)) { supplements++; return new Response('', { status: 429 }); }
      contentCalls++; return ok();
    } });
  // 보강 중단은 실행 전체가 공유해야 한다. 기사마다 다시 시도하면 할당량이 끝난 뒤에도 계속 두드린다.
  assert.equal(supplements, 1);
  // 그러면서도 판정 요청은 그대로 나간다.
  assert.equal(contentCalls, 2);
  assert.equal(state.status, 'completed');
  assert.equal(state.completed, 5);
  assert.equal(state.cached, 3);
  assert.equal(state.date_hints, 0);
  assert.equal(state.requests, 3);
  for (const a of fresh) await fs.access(path.join(reviewDir, `${a.id}.json`));
});
