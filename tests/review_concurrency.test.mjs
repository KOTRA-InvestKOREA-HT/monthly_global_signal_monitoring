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
  quality: 'pass', reason: '투자 해당 없음', evidence_quotes: [], summary_ko: '', summary_en: '',
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

// 어느 기사의 요청인지는 본문에서 읽는다. 호출 순서로 추측하면 안 된다: 워커는 게이트에 닿기 전에
// 캐시 파일을 먼저 읽고, 그 읽기가 끝나는 순서는 부하에 따라 달라진다. CPU 부하를 준 probe 40회에서
// 첫 요청이 Company0 33회, Company1 6회, Company2 1회로 갈렸다.
const companyOf = init => {
  const body = JSON.parse(init.body);
  const texts = body.messages ? body.messages.map(message => message.content)
    : body.contents.flatMap(content => content.parts.map(part => part.text));
  for (const text of texts) {
    try { const parsed = JSON.parse(text); if (parsed?.company) return parsed.company; } catch { /* 기사 본문이 아닌 부분 */ }
  }
  throw new Error('request body carries no article');
};

test('quota stops queued calls but drains successful in-flight results', async t => {
  const args = await setup(t);
  // Company1 의 429 는 Company0 의 요청이 시작된 뒤에만 나간다. 성공한 요청이 할당량 중단보다
  // 먼저 떠 있어야 "이미 떠 있던 성공 응답을 끝까지 저장하는가"를 검사할 수 있다.
  // 워커 둘만 둔다. 워커가 셋이면 Company2 도 429 가 나오기 전에 정당하게 출발할 수 있어
  // (게이트가 Company1 → Company2 → Company0 순으로 열리는 경우) 할당량 이후 차단을 검사할 수 없다.
  let company0Started;
  const company0Start = new Promise(resolve => { company0Started = resolve; });
  const requested = [], afterQuota = [];
  const state = await reviewArticles({ ...args, config: { ...args.config, delayMs: 60, concurrency: 2 },
    fetchImpl: async (url, init) => {
      const company = companyOf(init);
      requested.push(company);
      if (company === 'Company0') { company0Started(); await sleep(120); return ok(); }
      if (company === 'Company1') { await company0Start; return new Response('', { status: 429 }); }
      afterQuota.push(company);
      return new Response('', { status: 429 });
    } });
  // 할당량 뒤에는 대기 중이던 어떤 기사도 새 요청을 시작하지 않는다.
  assert.deepEqual(afterQuota, []);
  assert.deepEqual([...requested].sort(), ['Company0', 'Company1']);
  assert.equal(state.reason, 'quota');
  assert.equal(state.completed, 1);
  // 이미 비용을 쓴 성공 응답은 검증과 캐시 기록까지 끝난다. 429 로 끝난 기사는 남기지 않는다.
  await fs.access(path.join(args.reviewDir, `${args.articles[0].id}.json`));
  await assert.rejects(fs.access(path.join(args.reviewDir, `${args.articles[1].id}.json`)));
  // 그리고 다음 실행이 그 판정을 다시 사지 않는다.
  const resumedRequests = [];
  const resumed = await reviewArticles({ ...args,
    fetchImpl: async (url, init) => { resumedRequests.push(companyOf(init)); return ok(); } });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.cached, 1);
  assert.equal(resumedRequests.includes('Company0'), false);
  assert.equal(resumedRequests.length, 4);
});

// 위와 같은 이유로 호출 순서를 가정하지 않는다. 인증 실패는 실행을 즉시 거부하므로, 떠 있던
// 성공 응답의 캐시 기록을 기다리는지가 여기서 확인할 점이다.
test('authentication failure waits for in-flight cache writes before rejecting', async t => {
  const args = await setup(t);
  let company0Started;
  const company0Start = new Promise(resolve => { company0Started = resolve; });
  const requested = [];
  await assert.rejects(reviewArticles({ ...args, config: { ...args.config, delayMs: 60, concurrency: 2 },
    fetchImpl: async (url, init) => {
      const company = companyOf(init);
      requested.push(company);
      if (company === 'Company0') { company0Started(); await sleep(120); return ok(); }
      await company0Start;
      return new Response('', { status: 403 });
    } }), /HTTP 403/);
  assert.deepEqual([...requested].sort(), ['Company0', 'Company1']);
  await fs.access(path.join(args.reviewDir, `${args.articles[0].id}.json`));
});

// 게시일 미상 기사. 본문은 있으나 날짜 근거가 없어 date_pending 으로 들어온다.
const rejection = { candidate_id: 'investment:2', entity_supported: true, target_technology_supported: false,
  indicator_supported: false, leading_indicator_supported: false, event_stage: 'not_applicable',
  quality: 'pass', reason: '투자 해당 없음', evidence_quotes: [], summary_ko: '', summary_en: '' };
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
