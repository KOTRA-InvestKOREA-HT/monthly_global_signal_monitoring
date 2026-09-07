import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reviewArticles } from '../scripts/review_report.mjs';
import { groupArticles } from '../scripts/local_report.mjs';

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
