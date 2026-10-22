import test from 'node:test';
import assert from 'node:assert/strict';
import { configuration, judgementKeys, reviewWithKeyRotation, rotatesKey } from '../scripts/review_report.mjs';
import { GEMINI, NVIDIA } from '../scripts/review_providers.mjs';
import { summaryApiKeys, writeWithKeyRotation } from '../scripts/publish_report.mjs';

// 두 키 순환(2026-10-22 사용자 요청). 판정은 GEMINI_API_KEY → GEMINI_FOR_SUMMARY, 문안은 그 반대 순서다.
const env = { REPORT_PROVIDER: 'gemini', GEMINI_API_KEY: ' AIza-judge ', GEMINI_FOR_SUMMARY: 'AIza-copy', GEMINI_FREE_TIER_CONFIRMED: 'true' };

test('each stage lists both keys, its own first, without duplicates', () => {
  assert.deepEqual(judgementKeys(env, GEMINI), ['AIza-judge', 'AIza-copy']);
  assert.deepEqual(summaryApiKeys(env), ['AIza-copy', 'AIza-judge']);
  assert.deepEqual(judgementKeys({ ...env, GEMINI_FOR_SUMMARY: 'AIza-judge' }, GEMINI), ['AIza-judge']);
  assert.deepEqual(summaryApiKeys({ GEMINI_API_KEY: 'AIza-judge' }), ['AIza-judge']);
  // NVIDIA 판정은 Gemini 문안 키를 쓰지 않는다.
  assert.deepEqual(judgementKeys({ OPENAI_API_KEY: 'nvapi-1', GEMINI_FOR_SUMMARY: 'AIza-copy' }, NVIDIA), ['nvapi-1']);
  assert.deepEqual(configuration(env, GEMINI).apiKeys, ['AIza-judge', 'AIza-copy']);
});

test('only a quota or the run budget moves the judgement to the next key', () => {
  assert.equal(rotatesKey({ status: 'paused', reason: 'quota' }), true);
  assert.equal(rotatesKey({ status: 'paused', reason: 'request_budget' }), true);
  for (const reason of ['provider_error', 'provider_unavailable', 'invalid_responses', 'scheduling_stopped']) {
    assert.equal(rotatesKey({ status: 'paused', reason }), false, reason);
  }
  assert.equal(rotatesKey({ status: 'completed' }), false);
});

test('a judgement stopped by the quota continues with the second key in the same run', async () => {
  const config = configuration(env, GEMINI);
  const seen = [];
  const states = [{ status: 'paused', reason: 'quota', requests: 210, completed: 200 },
    { status: 'completed', requests: 190, completed: 386 }];
  const state = await reviewWithKeyRotation({ config, articles: [] }, async options => {
    seen.push([options.config.apiKey, options.config.verifierApiKey]);
    return states.shift();
  }, () => {});
  assert.deepEqual(seen, [['AIza-judge', 'AIza-judge'], ['AIza-copy', 'AIza-copy']]);
  assert.equal(state.status, 'completed');
  assert.equal(state.requests, 400);
  assert.deepEqual(state.key_runs.map(run => [run.key, run.status, run.reason]), [[1, 'paused', 'quota'], [2, 'completed', undefined]]);
});

test('other stops, and the last key, end the run as before', async () => {
  const config = configuration(env, GEMINI);
  let calls = 0;
  const auth = await reviewWithKeyRotation({ config }, async () => { calls += 1; return { status: 'paused', reason: 'provider_error', requests: 1 }; }, () => {});
  assert.equal(calls, 1);
  assert.equal(auth.reason, 'provider_error');
  calls = 0;
  const both = await reviewWithKeyRotation({ config }, async () => { calls += 1; return { status: 'paused', reason: 'quota', requests: 5 }; }, () => {});
  assert.equal(calls, 2);
  assert.equal(both.status, 'paused');
  assert.equal(both.requests, 10);
});

test('copy writing moves to the next key on a quota stop and hands that key to the later steps', async () => {
  const used = [];
  const results = [{ requests: 30, stopped: { reason: 'quota' } }, { requests: 12 }];
  const { stats, apiKey } = await writeWithKeyRotation(['AIza-copy', 'AIza-judge'], async key => { used.push(key); return results.shift(); }, () => {});
  assert.deepEqual(used, ['AIza-copy', 'AIza-judge']);
  assert.equal(apiKey, 'AIza-judge');
  assert.equal(stats.stopped, undefined);
  assert.equal(stats.requests, 42);
  // 할당량이 아닌 멈춤은 다음 키로 넘기지 않는다.
  const outage = await writeWithKeyRotation(['AIza-copy', 'AIza-judge'], async () => ({ requests: 3, stopped: { reason: 'provider_error' } }), () => {});
  assert.equal(outage.apiKey, 'AIza-copy');
  assert.equal(outage.stats.key_runs.length, 1);
});
