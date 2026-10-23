// Google 확인 멈춤만 남은 기업을 이어 받기. 10월 1일 실행(9월 기간)에서 재시도 대상 28개 기업 가운데 26개가
// 이 까닭뿐이었는데, 다시 돌리면 공식 출처·상세 페이지·사업동향 검색을 처음부터 다시 받았다.
// 이제 받아 둔 단계는 다시 쓰고 멈춘 기사만 받는다. 결과는 같은 응답을 받은 전체 재수집과 같아야 한다.
// 상세 페이지 하나의 타임아웃처럼 상세 단계에만 남은 일시 오류도 같은 방법으로 이어 받는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectWithCheckpoint, createStepLog, onlyDetailStepsRetryable, retryableCollection } from '../scripts/collection_resilience.mjs';
import { collectCompany, createTally, mergeTally, parseArgs } from '../scripts/collect_company_signals.mjs';

const company = { target_no: 1, company: 'Acme Widgets', query_aliases: [] };
const sourceConfig = { official_feeds: { 'Acme Widgets': [{ url: 'https://acme.example/rss', source: 'Acme newsroom' }] } };
const trend = {
  technologyMap: { companies: [{ target_no: 1, company: 'Acme Widgets', technology_group: 'alloys',
    target_technology: '합금', target_technology_en: 'widget alloy' }] },
  keywordConfig: { groups: { alloys: { keywords: ['widget alloy', 'recycled widget'] } } },
  searchTerms: {},
};
const dateRange = { mode: 'explicit', fromDate: '2026-09-01', toDate: '2026-09-30', from_date: '2026-09-01',
  to_date: '2026-09-30', fromMs: Date.parse('2026-09-01T00:00:00Z'), toMs: Date.parse('2026-09-30T23:59:59Z'), lookbackDays: 45 };
const collectedAt = '2026-10-01T05:00:00Z';
// 상세 페이지 상한 3: 멈췄던 Google 기사를 이번에 받으면 그 뒤 기사가 상한에 걸리는 것까지 같아야 한다.
const args = { ...parseArgs([]), rateLimitSeconds: 0, timeoutSeconds: 5, maxPerSource: 6, maxPerCompany: 10,
  maxDetailPerCompany: 3, fallbackMode: 'always', maxTrendDiscovery: 2 };

const body = (title, day) => `<html><head><title>${title}</title></head><body><article><h1>${title}</h1>
  <p>September ${day}, 2026 - ${title}. ${'Acme Widgets reported progress on the project with customers and partners. '.repeat(12)}</p>
  </article></body></html>`;
const rss = items => `<rss><channel>${items.map(([title, url, day, publisher]) => `<item><title>${title}</title>
  <link>${url}</link><pubDate>${day} Sep 2026 09:00:00 GMT</pubDate>
  ${publisher ? `<source url="https://${publisher}">${publisher}</source>` : ''}<description>${title}</description></item>`).join('')}</channel></rss>`;
const official = [1, 2, 3].map(n => [`Acme Widgets opens production line number ${n} in Ohio`, `https://acme.example/news/a${n}`, 3 + n]);
const fallback = [1, 2, 3, 4].map(n => [`Acme Widgets wins supply contract number ${n} from carmaker`,
  `https://news.google.com/rss/articles/CBMiG${n}`, 10 + n, `outlet${n}.example`]);
const trendItems = [1, 2].map(n => [`Acme Widgets launches widget alloy grade ${n} for batteries`,
  `https://news.google.com/rss/articles/CBMiT${n}`, 20 + n, `trade${n}.example`]);
const publisher = id => `https://${id.startsWith('G') ? `outlet${id[1]}` : `trade${id[1]}`}.example/story-${id}`;
const titles = Object.fromEntries([...fallback, ...trendItems].map(([title, url, day]) => [url.split('CBMi')[1], [title, day]]));

function fakeNetwork() {
  const requested = [];
  const fetch = async (url, init = {}) => {
    url = String(url);
    requested.push(url);
    if (url === 'https://acme.example/rss') return new Response(rss(official));
    if (url === 'https://flaky.example/rss') return new Response('busy', { status: 503 });
    const own = official.find(([, link]) => link === url);
    if (own) return new Response(body(own[0], own[2]));
    if (url.startsWith('https://news.google.com/rss/search')) {
      // 대체 수집 질의는 신호 낱말("investor relations" 등)을 싣고, 사업동향 질의는 기술 키워드를 싣는다.
      return new Response(rss(decodeURIComponent(url).includes('investor') ? fallback : trendItems));
    }
    if (/\/articles\/CBMi\w+$/.test(url)) return new Response('<div data-n-a-sg="SIG" data-n-a-ts="1759000000"></div>');
    if (url.endsWith('/batchexecute')) {
      const id = decodeURIComponent(init.body).match(/CBMi(\w\d)/)[1];
      return new Response(")]}'\n\n" + JSON.stringify([['wrb.fr', 'Fbv4je', JSON.stringify(['garturlres', publisher(id), 1])]]));
    }
    const story = Object.keys(titles).find(id => url === publisher(id));
    if (story) return new Response(body(...titles[story]));
    return new Response('not found', { status: 404 });
  };
  return { fetch, requested };
}

const google = url => new URL(url).hostname.endsWith('google.com');
const always = (url, request) => request();
// 첫 Google 기사 뒤에 확인이 멈춘 실행. createPublisherProbe 가 세 번 쉬고도 막히면 이렇게 null 을 준다.
function pausingProbe() {
  let allowed = 1;
  return async (url, request) => !google(url) || allowed-- > 0 ? request() : null;
}

async function withNetwork(network, task) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = network.fetch;
  try { return await task(); } finally { globalThis.fetch = realFetch; }
}

const collect = (probe, log) => collectCompany(company, sourceConfig, ['official_feeds', 'google_news'], args, dateRange,
  collectedAt, { probe, log, trend });

test('a company left only with paused Google rows resumes them and matches a full recollection', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'company-resume-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const full = await withNetwork(fakeNetwork(), () => collect(always, createStepLog()));
  assert.equal(full.errors.length, 0);
  // 상한 3에 걸려 넷째 대체 기사는 본문 없이 남는다.
  assert.deepEqual(full.rows.filter(row => row.collector === 'google_news_rss').map(row => row.content_fetch_status),
    ['fetched', 'fetched', 'fetched', 'skipped_detail_limit']);
  assert.equal(full.rows.filter(row => row.trend_discovery && row.content_fetch_status === 'fetched').length, 2);

  let now = Date.parse('2026-10-01T05:10:00Z');
  const checkpoint = probe => collectWithCheckpoint({ directory, identity: { company: company.company }, toDate: '2026-09-30',
    now: () => now, collect: log => collect(probe, log) });
  const paused = await withNetwork(fakeNetwork(), () => checkpoint(pausingProbe()));
  assert.equal(paused.rows.filter(row => row.content_fetch_status === 'google_probe_paused').length, 5);
  assert.ok(retryableCollection(paused) && onlyDetailStepsRetryable(paused));

  now += 3600000;
  const network = fakeNetwork();
  const resumed = await withNetwork(network, () => checkpoint(always));
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.cached, false);
  // 행·오류·통계가 같은 응답을 받은 전체 재수집과 같다.
  assert.deepEqual(resumed.rows, full.rows);
  assert.deepEqual(resumed.errors, full.errors);
  assert.deepEqual(resumed.stats, full.stats);
  // 다시 보낸 요청은 멈췄던 기사뿐이다. 공식 피드·공식 기사·두 검색은 다시 받지 않는다. 멈췄던 대체 기사 셋 가운데
  // 셋째는 이제 상한에 걸려 요청하지 않는다(전체 재수집도 그렇다).
  assert.deepEqual(network.requested.filter(url => !url.endsWith('/batchexecute')).sort(), [
    'https://news.google.com/rss/articles/CBMiG2', 'https://news.google.com/rss/articles/CBMiG3',
    'https://news.google.com/rss/articles/CBMiT1', 'https://news.google.com/rss/articles/CBMiT2',
    publisher('G2'), publisher('G3'), publisher('T1'), publisher('T2')].sort());
  assert.equal(resumed.requestCount, 4);

  // 다 받은 기업은 다음 실행에서 그대로 재사용한다. 체크포인트 시각은 처음 받은 때다.
  const again = await withNetwork(fakeNetwork(), () => checkpoint(always));
  assert.equal(again.cached, true);
  const saved = JSON.parse(await fs.readFile(path.join(directory, (await fs.readdir(directory))[0]), 'utf8'));
  assert.equal(saved.saved_at, Date.parse('2026-10-01T05:10:00Z'));
});

test('a company with a real transient failure is still collected from scratch', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'company-resume-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  // 두 번째 공식 피드가 503 이고 Google 확인도 멈췄다. 멈춤만이 까닭이 아니므로 처음부터 다시 받는다.
  const flaky = { official_feeds: { 'Acme Widgets': [...sourceConfig.official_feeds['Acme Widgets'], { url: 'https://flaky.example/rss' }] } };
  const checkpoint = probe => collectWithCheckpoint({ directory, identity: { company: company.company },
    collect: log => collectCompany(company, flaky, ['official_feeds', 'google_news'], args, dateRange, collectedAt,
      { probe, log, trend }) });
  const failed = await withNetwork(fakeNetwork(), () => checkpoint(pausingProbe()));
  assert.ok(retryableCollection(failed) && !onlyDetailStepsRetryable(failed));
  const network = fakeNetwork();
  const retried = await withNetwork(network, () => checkpoint(always));
  assert.notEqual(retried.resumed, true);
  assert.ok(network.requested.includes('https://acme.example/rss'));
  assert.ok(network.requested.includes('https://acme.example/news/a1'));
  // 검색은 셋이다: 외부 기사, 사업동향 탐색, 한국 관련 검색.
  assert.equal(network.requested.filter(url => url.startsWith('https://news.google.com/rss/search')).length, 3);
});

// 상세 페이지 한 건이 일시 오류였던 기업은 그 기사만 다시 받는다. 예전에는 매번 처음부터 다시 받았다.
// 425 를 쓰는 까닭: 재시도 대상 일시 오류이면서 domainGuard 가 호스트 장애로 세지 않아, 테스트 사이에 이 호스트가
// 쉬는 상태로 남지 않는다(가드는 모듈 하나에 하나다).
test('a company whose only transient failure is one detail page resumes just that page', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'company-resume-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const full = await withNetwork(fakeNetwork(), () => collect(always, createStepLog()));
  const flakyPage = 'https://acme.example/news/a2';
  const failing = fakeNetwork();
  const down = { fetch: async (url, init) => (String(url) === flakyPage
    ? new Response('busy', { status: 425 }) : failing.fetch(url, init)) };
  const checkpoint = () => collectWithCheckpoint({ directory, identity: { company: company.company },
    toDate: '2026-09-30', collect: log => collect(always, log) });
  const failed = await withNetwork(down, () => checkpoint());
  assert.ok(retryableCollection(failed) && onlyDetailStepsRetryable(failed));
  const network = fakeNetwork();
  const resumed = await withNetwork(network, () => checkpoint());
  assert.equal(resumed.resumed, true);
  assert.deepEqual(network.requested, [flakyPage]);
  assert.deepEqual(resumed.rows, full.rows);
  assert.deepEqual(resumed.errors, []);
});

// 링크 판정·제외 집계는 기업 결과에 실려 체크포인트에 남는다. 예전에는 모듈 전역 카운터라 다시 쓴 기업이 빠졌다.
test('link verdict and exclusion counts travel with the company result through the checkpoint', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'company-tally-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const pageConfig = { official_pages: { 'Acme Widgets': [{ url: 'https://acme.example/newsroom', source: 'Acme newsroom' }] } };
  const page = `<ul><li>September 4, 2026 <a href="https://acme.example/news/a1">Acme Widgets opens production line number 1 in Ohio</a></li>
    <li><a href="https://acme.example/news/">News</a></li><li><a href="https://acme.example/news/page/2">Older news</a></li></ul>`;
  const network = fakeNetwork();
  const fetch = async (url, init) => (String(url) === 'https://acme.example/newsroom' ? new Response(page) : network.fetch(url, init));
  const run = () => collectWithCheckpoint({ directory, identity: { company: company.company }, toDate: '2026-09-30',
    collect: log => collectCompany(company, pageConfig, ['official_pages'], args, dateRange, collectedAt, { probe: always, log, trend }) });
  const first = await withNetwork({ fetch }, run);
  assert.ok(first.stats.link_verdict_counts.accept >= 1);
  assert.ok(first.stats.excluded_non_article_count >= 1);
  assert.equal(first.stats.excluded_non_article_count,
    Object.values(first.stats.excluded_non_article_reasons).reduce((sum, count) => sum + count, 0));
  const cached = await withNetwork({ fetch }, run);
  assert.equal(cached.cached, true);
  assert.deepEqual(cached.stats, first.stats);
  // 실행 요약은 기업 결과의 집계를 합친다.
  const total = [first, cached].reduce((sum, result) => mergeTally(sum, result.stats), createTally());
  assert.equal(total.excluded_non_article_count, first.stats.excluded_non_article_count * 2);
});

// 본문 단계에서 뺀 대체 기사는 결과에 다시 들어오지 않는다. 예전에는 rows.map 이 빠진 행 자리에 원래 행을 넣었다.
test('a fallback article excluded at the detail stage stays excluded', async () => {
  const network = fakeNetwork();
  // 검색 결과의 짧은 제목은 받아 본 페이지 제목으로 바뀌고, 그 제목이 목록 페이지라 기사에서 빠진다.
  const shortTitled = fallback.map((item, index) => (index === 0 ? ['Acme update', ...item.slice(1)] : item));
  const fetch = async (url, init) => {
    url = String(url);
    if (url === publisher('G1')) return new Response(body('News archive', 11));
    if (url.startsWith('https://news.google.com/rss/search') && decodeURIComponent(url).includes('investor')) {
      return new Response(rss(shortTitled));
    }
    return network.fetch(url, init);
  };
  const result = await withNetwork({ fetch }, () => collect(always, createStepLog()));
  const fallbackUrls = result.rows.filter(row => row.collector === 'google_news_rss').map(row => row.url);
  assert.equal(fallbackUrls.includes('https://news.google.com/rss/articles/CBMiG1'), false);
  assert.equal(fallbackUrls.length, 3);
});

test('steps that failed transiently or were paused are never replayed', async () => {
  const log = createStepLog();
  await log.run('source:a', async () => ({ rows: [], errors: [{ error: 'HTTP 503 Service Unavailable' }] }));
  await log.run('source:b', async () => ({ failed: 'fetch failed' }));
  await log.run('detail:c', async () => ({ row: {}, errors: [{ error: 'google_probe_paused' }] }));
  await log.run('source:d', async () => ({ rows: [], errors: [{ error: 'HTTP 404 Not Found' }] }));
  assert.deepEqual(log.steps.map(([key]) => key), ['source:d']);
  // 기록은 그 순간의 사본이다. 뒤에서 결과를 고쳐도 기록은 그대로다.
  const value = (await log.run('source:e', async () => ({ rows: [{ title: 'kept' }], errors: [] }))).value;
  value.rows[0].title = 'changed';
  assert.equal(log.steps.at(-1)[1].rows[0].title, 'kept');
  const replay = createStepLog(JSON.parse(JSON.stringify(log.steps)));
  let ran = false;
  assert.deepEqual(await replay.run('source:e', async () => { ran = true; }), { value: { rows: [{ title: 'kept' }], errors: [] }, replayed: true });
  assert.equal(ran, false);
});
