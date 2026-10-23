// Google 링크 풀기가 429 를 받았을 때. 9월분(10월 13일 실행)에서 35건을 푼 뒤 기사 페이지가 429 를 내기 시작했고,
// 60초씩 세 번 쉬고도 풀리지 않아 남은 79건을 요청 없이 버렸다(google_probe_paused). 사업동향 탐색 51건 가운데 21건이
// 그렇게 본문 없이 남았다. 여기서는 실제 네트워크와 실제 대기 없이, 가짜 fetch 와 가짜 시계로 차례의 동작을 확인한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublisherProbe, decodeGoogleNewsLink, enrichOfficialRowsWithContent, parseArgs, parseRetryAfter,
  resolveArticleSource } from '../scripts/collect_company_signals.mjs';

const PAGE = '<c-wiz><div data-n-a-sg="SIG" data-n-a-ts="1759000000"></div></c-wiz>';
const google = id => `https://news.google.com/rss/articles/CBMi${id}?oc=5`;
const publisher = id => `https://publisher.example/story-${id}`;

// sleep 은 시각만 앞으로 옮긴다. 기다린 시간을 차례로 남긴다.
function fakeClock() {
  const clock = { t: 0, sleeps: [] };
  clock.now = () => clock.t;
  clock.sleepFn = async ms => { clock.sleeps.push(ms); clock.t += ms; };
  return clock;
}

// blocked() 가 참인 동안 Google 기사 페이지(RSS 쪽 중계 페이지)가 429 를 낸다. 요청마다 [시각, 주소]를 남긴다.
function fakeGoogle(clock, { blocked = () => false, retryAfter } = {}) {
  const requested = [];
  const fetchImpl = async (url, init = {}) => {
    url = String(url);
    requested.push([clock.t, url]);
    if (url.startsWith('https://news.google.com/rss/articles/')) {
      if (blocked()) return new Response('rate limited', { status: 429, headers: retryAfter ? { 'Retry-After': retryAfter } : {} });
      return new Response(PAGE);
    }
    if (url.endsWith('/batchexecute')) {
      const id = decodeURIComponent(init.body).match(/CBMi(\w+)/)[1];
      return new Response(")]}'\n\n" + JSON.stringify([['wrb.fr', 'Fbv4je', JSON.stringify(['garturlres', publisher(id), 1])]]));
    }
    if (url.startsWith('https://publisher.example/')) return new Response(articleHtml(url));
    throw new Error(`unexpected ${url}`);
  };
  return { requested, fetchImpl };
}

const articleHtml = url => `<html><head><title>Acme Widgets opens a widget alloy plant ${url.slice(-1)}</title></head><body><article>
  <p>September 12, 2026 - ${'Acme Widgets opened a new widget alloy plant with partners and customers. '.repeat(12)}</p></article></body></html>`;

const resolveWith = (probe, id) => probe(google(id), (googleFetch) => resolveArticleSource(google(id), 5, googleFetch));

test('Retry-After is read as seconds or as an HTTP date', () => {
  const nowMs = Date.parse('2026-10-13T07:00:00Z');
  assert.equal(parseRetryAfter('120', nowMs), 120);
  assert.equal(parseRetryAfter('Tue, 13 Oct 2026 07:01:30 GMT', nowMs), 90);
  assert.equal(parseRetryAfter('Tue, 13 Oct 2026 06:59:00 GMT', nowMs), 0);
  for (const value of [undefined, null, '', 'soon']) assert.equal(parseRetryAfter(value, nowMs), 0);
});

// 예전에는 해독 안에서 2초·4초 뒤 같은 429 요청을 다시 보내고, 그다음 중계 주소까지 따라갔다.
test('a 429 decode is returned at once with its Retry-After and never follows the relay', async () => {
  const clock = fakeClock();
  const network = fakeGoogle(clock, { blocked: () => true, retryAfter: '90' });
  assert.deepEqual(await decodeGoogleNewsLink(google('A'), 5, network.fetchImpl),
    { reason: 'article_page_http_429', rateLimited: true, retryAfterSeconds: 90 });
  assert.equal(network.requested.length, 1);
  const error = await resolveArticleSource(google('A'), 5, network.fetchImpl).catch(e => e);
  // 메시지와 해독 사유는 예전 이름 그대로다(google_news_unresolved_count, google_news_decode_failures).
  assert.equal(error.message, 'publisher_url_unresolved');
  assert.equal(error.decodeFailure, 'article_page_http_429');
  assert.equal(error.status, 429);
  assert.equal(error.retryAfterSeconds, 90);
  assert.equal(network.requested.length, 2);
  assert.ok(network.requested.every(([, url]) => url.startsWith('https://news.google.com/rss/articles/')));
});

test('429 then a cooldown that honours Retry-After then a retry that succeeds', async () => {
  const clock = fakeClock();
  let pageCalls = 0;
  const network = fakeGoogle(clock, { blocked: () => pageCalls++ === 0, retryAfter: '90' });
  const probe = createPublisherProbe(3, { fetchImpl: network.fetchImpl, sleepFn: clock.sleepFn, now: clock.now });
  assert.deepEqual(await resolveWith(probe, 'A'), { target: publisher('A') });
  // Retry-After(90초)가 기본 쉼(60초)보다 길어 그 값을 따른다. 다시 보낸 기사 페이지와 해독 요청 사이에는 1초 간격을 둔다.
  assert.deepEqual(clock.sleeps, [90000, 1000]);
  assert.deepEqual(network.requested.map(([t, url]) => [t, url.replace(/\?.*/, '')]), [
    [0, 'https://news.google.com/rss/articles/CBMiA'],
    [90000, 'https://news.google.com/rss/articles/CBMiA'],
    [91000, 'https://news.google.com/_/DotsSplashUi/data/batchexecute'],
  ]);
  assert.deepEqual(probe.stats, { requests: 3, rate_limited: 1, cooldowns: 1, cooldown_ms: 90000, retried: 1, paused: 0 });
  // 풀린 뒤에는 쉬지 않고 간격만 지킨다.
  assert.deepEqual(await resolveWith(probe, 'B'), { target: publisher('B') });
  assert.deepEqual(clock.sleeps, [90000, 1000, 1000, 1000]);
});

test('a lasting 429 is retried a limited number of times, then later rows are skipped without requests', async () => {
  const clock = fakeClock();
  const network = fakeGoogle(clock, { blocked: () => true });
  const probe = createPublisherProbe(3, { pauseMs: 60000, budgetMs: 180000, fetchImpl: network.fetchImpl,
    sleepFn: clock.sleepFn, now: clock.now });
  const results = await Promise.allSettled(['A', 'B', 'C', 'D'].map(id => resolveWith(probe, id)));
  // A: 429 → 60초 쉬고 한 번 더 → 429 → 포기. B: 남은 120초를 쉬고 시도 → 429. 다음 쉼(240초)은 예산을 넘어 다시 보내지 않는다.
  // C·D: Google 이 막혀 있고 기다릴 예산도 없어 요청 없이 null(google_probe_paused)이다.
  assert.equal(results[0].reason.decodeFailure, 'article_page_http_429');
  assert.equal(results[1].reason.decodeFailure, 'article_page_http_429');
  assert.deepEqual(results.slice(2).map(r => r.value), [null, null]);
  assert.deepEqual(clock.sleeps, [60000, 120000]);
  assert.deepEqual(network.requested.map(([t, url]) => [t, url.replace(/\?.*/, '')]), [
    [0, 'https://news.google.com/rss/articles/CBMiA'],
    [60000, 'https://news.google.com/rss/articles/CBMiA'],
    [180000, 'https://news.google.com/rss/articles/CBMiB'],
  ]);
  assert.deepEqual(probe.stats, { requests: 3, rate_limited: 3, cooldowns: 3, cooldown_ms: 180000, retried: 1, paused: 2 });
});

// 예전에는 쉼을 다 쓰면 그 실행의 Google 확인을 통째로 껐다. 이제는 막힘이 끝날 시각이 지나면 다음 기사로 다시 시험한다.
test('after the budget is spent, probing resumes once the block has had time to clear', async () => {
  const clock = fakeClock();
  let blocked = true;
  const network = fakeGoogle(clock, { blocked: () => blocked });
  const probe = createPublisherProbe(3, { pauseMs: 60000, budgetMs: 60000, fetchImpl: network.fetchImpl,
    sleepFn: clock.sleepFn, now: clock.now });
  // A: 429 → 60초 쉬고 다시 → 429. 다음 쉼 120초는 예산(60초)을 넘는다. 막힘은 t=180초까지다.
  await assert.rejects(resolveWith(probe, 'A'), /publisher_url_unresolved/);
  assert.equal(clock.t, 60000);
  assert.equal(await resolveWith(probe, 'B'), null);
  const before = network.requested.length;
  // 다른 기업 작업이 이어지는 동안 시간이 흐른다. 그사이 Google 이 풀렸다.
  clock.t = 170000;
  assert.equal(await resolveWith(probe, 'C'), null);
  assert.equal(network.requested.length, before);
  clock.t = 180000;
  blocked = false;
  assert.deepEqual(await resolveWith(probe, 'D'), { target: publisher('D') });
  // 풀린 뒤 다시 막히면 첫 쉼부터 다시 센다. 다만 예산은 실행 전체에서 하나라서 기다리지는 않는다.
  blocked = true;
  await assert.rejects(resolveWith(probe, 'E'), /publisher_url_unresolved/);
  assert.equal(await resolveWith(probe, 'F'), null);
  assert.deepEqual(clock.sleeps.filter(ms => ms > 1000), [60000]);
  assert.equal(probe.stats.paused, 3);
});

// 429 뒤 다시 보낸 기사는 상세 페이지 상한을 한 번만 쓴다. 두 번 세면 같은 기업의 다음 기사가 상한에 밀린다.
test('a Google row retried after a 429 keeps its body and uses the detail limit once', async () => {
  const clock = fakeClock();
  let pageCalls = 0;
  const network = fakeGoogle(clock, { blocked: () => pageCalls++ === 0 });
  const probe = createPublisherProbe(3, { fetchImpl: network.fetchImpl, sleepFn: clock.sleepFn, now: clock.now });
  const realFetch = globalThis.fetch;
  globalThis.fetch = network.fetchImpl;
  try {
    const company = { target_no: 1, company: 'Acme Widgets', query_aliases: [] };
    const rows = ['A', 'B'].map(id => ({ target_no: 1, company: 'Acme Widgets',
      title: `Acme Widgets opens a widget alloy plant ${id}`, url: google(id), source: 'Trade news', source_type: 'news',
      collector: 'google_news_trend', link_verdict: 'accept', link_rank: 0 }));
    const args = { ...parseArgs([]), rateLimitSeconds: 0, timeoutSeconds: 5, maxDetailPerCompany: 2 };
    const result = await enrichOfficialRowsWithContent(rows, args, '2026-10-13T07:00:00Z', company, { probe });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.rows.map(row => [row.content_fetch_status, row.content_source_url]),
      [['fetched', publisher('A')], ['fetched', publisher('B')]]);
    // 기사 두 건과 429 뒤 다시 보낸 한 번.
    assert.equal(result.requestCount, 3);
    assert.equal(probe.stats.retried, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
