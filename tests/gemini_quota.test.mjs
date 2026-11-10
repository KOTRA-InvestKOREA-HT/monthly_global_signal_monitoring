// 2026-11-10 실행 42765829296: 판정을 10여 분 돌고 두 키 모두 "할당량"으로 멈췄다. 하루 한도에 닿을 요청 수가 아니었다.
// Gemini 는 분당 한도(요청 수·입력 토큰)에 걸려도 message 가 "You exceeded your current quota" 로 시작하고, 어느 한도인지는
// details 의 quotaId 와 retryDelay 에만 있다. 예전 분류는 message 만 보고 모든 429 를 하루 한도 소진으로 봤다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { providerFailure, rateLimitWaitMs, reviewArticles, RATE_LIMIT_RETRIES } from '../scripts/review_report.mjs';
import { groupArticles } from '../scripts/local_report.mjs';

const period = { from_date: '2026-10-01', to_date: '2026-10-31' };
const BODY = 'AGC announced that it will expand production of fluoropolymer films at its Chiba plant to meet rising demand '
  + 'from semiconductor customers, with the new line scheduled to start operating in 2028 after an investment of 10 billion yen. '
  + 'The company said the expansion strengthens its supply capacity in Asia.';
const article = (name, no = 67) => {
  const row = { company: name, target_no: no, url: `https://example.com/${name}`, title: `${name} expands film production`,
    published_at: '2026-10-15T00:00:00Z', target_technology: 'fluoropolymer', target_technology_en: 'fluoropolymer', content_text: BODY };
  return groupArticles([{ ...row, investment_signal_no: 2 }], [row], period)[0];
};
const decisions = [
  { candidate_id: 'investment:2', entity_supported: true, target_technology_supported: true, indicator_supported: true,
    leading_indicator_supported: true, event_stage: 'planned', quality: 'pass', reason: '증설 계획 확인', evidence_quotes: [BODY.split(', with')[0]],
    summary_ko: '불소수지 필름 증설 - 지바 공장 증설 계획을 밝혔음.', summary_en: 'Film expansion - AGC plans to expand its Chiba plant.' },
  { candidate_id: 'relevant', entity_supported: true, target_technology_supported: true, indicator_supported: true,
    leading_indicator_supported: true, event_stage: 'not_applicable', quality: 'pass', reason: '사업동향', evidence_quotes: [BODY.split(', with')[0]],
    summary_ko: 'AGC는 지바 공장의 불소수지 필름 생산을 늘린다고 밝혔음.', summary_en: 'AGC said it will expand fluoropolymer film production in Chiba.' },
];
const reply = () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop',
  message: { content: JSON.stringify({ decisions }) } }], usage: {} }));

// 실제 Gemini 429 본문의 모양(ai.google.dev/gemini-api/docs/rate-limits). 키나 기사 본문은 들어 있지 않다.
const geminiQuota = (quotaId, retryDelay) => ({ error: { code: 429, status: 'RESOURCE_EXHAUSTED',
  message: 'You exceeded your current quota, please check your plan and billing details. For more information on this error, '
    + `head to: https://ai.google.dev/gemini-api/docs/rate-limits.${retryDelay ? ` Please retry in ${retryDelay}.` : ''}`,
  details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/x', quotaId }] },
    ...(retryDelay ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }] : []),
  ] } });
const PER_MINUTE = geminiQuota('GenerateContentInputTokensPerModelPerMinute-FreeTier', '34s');
const PER_DAY = geminiQuota('GenerateRequestsPerDayPerProjectPerModel-FreeTier', null);
const tooMany = body => new Response(JSON.stringify(body), { status: 429, headers: { 'content-type': 'application/json' } });
const tempDir = async (t, name) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), name));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};

test('a Gemini 429 is named by its quota: per-minute limits wait, per-day limits stop', () => {
  const minute = providerFailure(PER_MINUTE.error.message, PER_MINUTE);
  assert.equal(minute.reason, 'rate_limit');
  assert.equal(minute.retry_seconds, 34);
  assert.deepEqual(minute.quota_ids, ['GenerateContentInputTokensPerModelPerMinute-FreeTier']);
  const day = providerFailure(PER_DAY.error.message, PER_DAY);
  assert.equal(day.reason, 'credits_exhausted');
  assert.deepEqual(day.quota_ids, ['GenerateRequestsPerDayPerProjectPerModel-FreeTier']);
  // 하루 한도와 분당 한도가 함께 오면 하루 한도다. 기다려도 풀리지 않는다.
  const both = geminiQuota('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '20s');
  both.error.details[0].violations.push({ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' });
  assert.equal(providerFailure(both.error.message, both).reason, 'credits_exhausted');
  // details 없이 message 의 "Please retry in" 만 있어도 기다릴 수 있는 한도다.
  assert.deepEqual(providerFailure('You exceeded your current quota. Please retry in 12.5s.'),
    { reason: 'rate_limit', quota_ids: [], retry_seconds: 12.5 });
  // 아무 표시 없는 예전 모양은 예전처럼 소진으로 본다.
  assert.equal(providerFailure('You exceeded your current quota').reason, 'credits_exhausted');
});

test('the wait before a per-minute retry follows the stated delay, within two minutes', () => {
  assert.equal(rateLimitWaitMs(34, 4500, () => 0), 35000);
  assert.equal(rateLimitWaitMs(null, 4500, () => 0), 61000);
  assert.equal(rateLimitWaitMs(600, 4500, () => 0), 120000);
  assert.equal(rateLimitWaitMs(0.1, 4500, () => 0), 4500);
});

test('a per-minute 429 is waited out and the same article is asked again instead of pausing the run', async t => {
  const reviewDir = await tempDir(t, 'quota-minute-');
  const waits = [];
  let calls = 0;
  const state = await reviewArticles({ articles: [article('AGC')], reviewDir, policy: '',
    config: { apiKey: 'key', maxRequests: 10, delayMs: 4500 }, sleep: async ms => { waits.push(ms); },
    fetchImpl: async () => (++calls === 1 ? tooMany(PER_MINUTE) : reply()) });
  assert.equal(calls, 2);
  assert.equal(state.status, 'completed');
  assert.equal(state.requests, 2);
  assert.ok(waits.some(ms => ms >= 35000 && ms <= 120000), `waits ${waits}`);
});

test('a per-day 429 stops the run at once and names the quota', async t => {
  const reviewDir = await tempDir(t, 'quota-day-');
  let calls = 0;
  const state = await reviewArticles({ articles: [article('AGC')], reviewDir, policy: '',
    config: { apiKey: 'key', maxRequests: 10, delayMs: 0 }, sleep: async () => {},
    fetchImpl: async () => { calls++; return tooMany(PER_DAY); } });
  assert.equal(calls, 1);
  assert.equal(state.status, 'paused');
  assert.equal(state.reason, 'quota');
  assert.equal(state.provider_reason, 'credits_exhausted');
  assert.deepEqual(state.quota_ids, ['GenerateRequestsPerDayPerProjectPerModel-FreeTier']);
});

test('a per-minute limit that does not clear stops after the bounded retries', async t => {
  const reviewDir = await tempDir(t, 'quota-stuck-');
  let calls = 0;
  const state = await reviewArticles({ articles: [article('AGC')], reviewDir, policy: '',
    config: { apiKey: 'key', maxRequests: 10, delayMs: 0 }, sleep: async () => {},
    fetchImpl: async () => { calls++; return tooMany(PER_MINUTE); } });
  assert.equal(calls, 1 + RATE_LIMIT_RETRIES);
  assert.equal(state.status, 'paused');
  assert.equal(state.reason, 'quota');
  assert.equal(state.provider_reason, 'rate_limit');
  assert.equal(state.retry_after, '34');
});

test('with parallel workers a per-minute 429 holds the other requests instead of stopping them', async t => {
  const reviewDir = await tempDir(t, 'quota-parallel-');
  const starts = [];
  let calls = 0;
  // 대기시간은 실제 시간으로 흐른다(게이트가 performance.now 로 다음 시작을 정한다). 0.01초 안내 + 1~2초 여유.
  const brief = geminiQuota('GenerateContentInputTokensPerModelPerMinute-FreeTier', '0.01s');
  const state = await reviewArticles({ articles: [article('AGC'), article('JSR', 68), article('Toray', 75)], reviewDir, policy: '',
    // 간격 0.3초: 첫 요청이 429 를 받을 때 나머지는 아직 차례를 기다리는 중이다.
    config: { apiKey: 'key', maxRequests: 10, delayMs: 300, concurrency: 3 },
    sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 20))),
    fetchImpl: async () => { starts.push(performance.now()); return ++calls === 1 ? tooMany(brief) : reply(); } });
  assert.equal(state.status, 'completed');
  assert.equal(state.completed, 3);
  assert.equal(calls, 4);
  // 첫 요청이 429 를 받은 뒤 나간 요청은 모두 안내된 대기(최소 1초) 뒤에 나갔다.
  assert.ok(starts.slice(1).every(start => start - starts[0] >= 900), `starts ${starts.map(s => Math.round(s - starts[0]))}`);
});
