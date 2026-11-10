import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDomainGuard, collectWithCheckpoint, collectionMaxAgeMs, retryableCollection } from '../scripts/collection_resilience.mjs';
import { collectCompany, collectionBlockingErrors, companyCollectionIdentity, companyTrendInputs, parseArgs } from '../scripts/collect_company_signals.mjs';
import { coverageStatus } from '../scripts/local_report.mjs';

test('unavailable host pauses, another host proceeds, and cooldown allows one probe', async () => {
  let now = 0;
  const guard = createDomainGuard({ now: () => now, cooldownMs: 100 });
  const fail = () => guard.run('https://down.example/news', async () => { throw new Error('fetch failed'); });
  for (let i = 0; i < 3; i++) await assert.rejects(fail(), /fetch failed/);
  await assert.rejects(fail(), /domain_cooldown/);
  assert.equal(await guard.run('https://other.example/', async () => 'ok'), 'ok');
  now = 100;
  let finish;
  const probe = guard.run('https://down.example/', () => new Promise(resolve => { finish = resolve; }));
  await assert.rejects(fail(), /domain_cooldown/);
  finish('recovered');
  await probe;
  assert.equal(await guard.run('https://down.example/', async () => 'ok'), 'ok');
  assert.equal(guard.stats.skipped, 2);
});

// 쉬기 전에 나간 느린 요청이 탐침 도중에 끝나도 탐침 표시는 그대로다. 예전에는 그 요청의 finally 가 표시를 풀어
// 탐침이 끝나기 전에 둘째 요청이 같은 호스트로 나갔다.
test('a slow request that started before the cooldown does not end the probe', async () => {
  let now = 0;
  const guard = createDomainGuard({ now: () => now, cooldownMs: 100 });
  let failSlow;
  const slow = guard.run('https://down.example/slow', () => new Promise((resolve, reject) => { failSlow = reject; }));
  for (let i = 0; i < 3; i++) {
    await assert.rejects(guard.run('https://down.example/news', async () => { throw new Error('fetch failed'); }));
  }
  now = 100;
  let finishProbe;
  const probe = guard.run('https://down.example/', () => new Promise(resolve => { finishProbe = resolve; }));
  failSlow(new Error('fetch failed'));
  await assert.rejects(slow, /fetch failed/);
  // 느린 요청의 실패로 쉬는 시간이 다시 잡혔다가 지나도, 첫 탐침이 끝나기 전에는 둘째 탐침을 보내지 않는다.
  now = 200;
  await assert.rejects(guard.run('https://down.example/other', async () => 'second probe'), /domain_cooldown/);
  finishProbe('recovered');
  await probe;
  assert.equal(await guard.run('https://down.example/other', async () => 'ok'), 'ok');
});

// 응답을 받은 뒤의 판단(크기 초과 등)은 호스트 장애가 아니다.
test('errors decided after a response never cool the host down', async () => {
  const guard = createDomainGuard();
  for (let i = 0; i < 4; i++) {
    await assert.rejects(guard.run('https://site.example/big.pdf', async () => {
      throw Object.assign(new Error('document_too_large'), { noRetry: true });
    }), /document_too_large/);
  }
  assert.equal(await guard.run('https://site.example/news', async () => 'ok'), 'ok');
});

test('access-denied URLs never trigger transport cooldown for unrelated pages', async () => {
  const guard = createDomainGuard();
  for (let i = 0; i < 4; i++) await assert.rejects(guard.run('https://site.example/private', async () => {
    throw Object.assign(new Error('HTTP 403 Forbidden'), { status: 403 });
  }), /403/);
  assert.equal(await guard.run('https://site.example/public', async () => 'public'), 'public');
  assert.equal(guard.stats.skipped, 0);
});

// --- 서버 오류 하나가 호스트를 쉬게 하던 일(2026-10 DNP) ------------------------------------------------------
// 2026-10 수집(11-02 실행)에서 DNP 의 www.dnp.co.jp/en/ir/ 가 500 을 냈다. 재시도 세 번이 각각 호스트 실패로 세어져
// 한도 3을 채웠고, 30초 쉼 동안 IR 목록 2곳과 기사 상세 10건이 모두 domain_cooldown 으로 끝났다.

const serverError = (status = 500) => async () => {
  throw Object.assign(new Error(`HTTP ${status}`), { status });
};

test('retries of one URL that answers 5xx count once, so its host keeps serving the other pages', async () => {
  let now = 0;
  const guard = createDomainGuard({ now: () => now });
  // fetchWithRetries 는 같은 주소를 세 번(재시도 2번) 보낸다.
  for (let i = 0; i < 3; i++) {
    await assert.rejects(guard.run('https://www.dnp-like.example/en/ir/', serverError(500)), /HTTP 500/);
    now += 1000;
  }
  assert.equal(await guard.run('https://www.dnp-like.example/ir/library/report/', async () => 'listing'), 'listing');
  assert.equal(await guard.run('https://www.dnp-like.example/news/detail/20178744_1587.html', async () => 'article'), 'article');
  assert.equal(guard.stats.skipped, 0);
  // 성공으로 연속이 끊기면 같은 주소의 5xx 는 다시 한 번 센다.
  const again = createDomainGuard({ now: () => now });
  await assert.rejects(again.run('https://again.example/en/ir/', serverError(500)));
  assert.equal(await again.run('https://again.example/news/', async () => 'ok'), 'ok');
  for (const page of ['en/ir/', 'a', 'b']) await assert.rejects(again.run(`https://again.example/${page}`, serverError(500)));
  await assert.rejects(again.run('https://again.example/news/detail/1.html', async () => 'never'), /domain_cooldown/);
});

test('three different URLs answering 5xx in a row still cool the host down, and 429 or silence still count every attempt', async () => {
  const guard = createDomainGuard();
  // 서버 전체 장애: 주소마다 재시도까지 5xx 다. 셋째 주소에서 쉰다.
  for (const page of ['news/', 'ir/']) {
    for (let i = 0; i < 3; i++) await assert.rejects(guard.run(`https://outage.example/${page}`, serverError(502)));
  }
  // 두 주소까지는 쉬지 않아 셋째 주소가 나간다. 그 5xx 에서 쉰다.
  await assert.rejects(guard.run('https://outage.example/library/', serverError(503)), /HTTP 503/);
  await assert.rejects(guard.run('https://outage.example/news/detail/1.html', async () => 'never'), /domain_cooldown/);
  // 429 는 호스트가 직접 늦추라고 한 것이다. 주소 하나라도 시도마다 센다.
  const limited = createDomainGuard();
  for (let i = 0; i < 3; i++) await assert.rejects(limited.run('https://busy.example/news/', serverError(429)), /HTTP 429/);
  await assert.rejects(limited.run('https://busy.example/news/detail/1.html', async () => 'never'), /domain_cooldown/);
  // 응답이 없는 실패(시간초과)도 지금처럼 시도마다 센다. 한 번에 20초씩 들기 때문이다.
  const silent = createDomainGuard();
  for (let i = 0; i < 3; i++) {
    await assert.rejects(silent.run('https://silent.example/news/', async () => { throw new Error('This operation was aborted'); }));
  }
  await assert.rejects(silent.run('https://silent.example/news/detail/1.html', async () => 'never'), /domain_cooldown/);
  // 같은 주소의 5xx 반복은 앞선 응답 없는 실패의 연속 횟수를 지우지 않는다.
  const mixed = createDomainGuard();
  await assert.rejects(mixed.run('https://mixed.example/a', serverError(500)));
  await assert.rejects(mixed.run('https://mixed.example/a', serverError(500)));
  await assert.rejects(mixed.run('https://mixed.example/b', async () => { throw new Error('fetch failed'); }));
  await assert.rejects(mixed.run('https://mixed.example/b', async () => { throw new Error('fetch failed'); }));
  await assert.rejects(mixed.run('https://mixed.example/c', async () => 'never'), /domain_cooldown/);
});

async function withFetch(handler, task) {
  const realFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (target) => {
    const url = String(target);
    requested.push(url);
    const response = handler(url) || new Response('not found', { status: 404, statusText: 'Not Found' });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  };
  try { return { result: await task(), requested }; } finally { globalThis.fetch = realFetch; }
}

// 수집기 전체가 쓰는 domainGuard 와 실제 재시도(fetchRetries 2, 사이에 0.7초·1.4초 대기)를 그대로 거친다.
// 출처 순서도 DNP 와 같다: 피드 → 뉴스 목록 → IR(500) → IR 목록 2곳 → 상세 기사.
test('DNP: an IR page that answers 500 on every retry no longer wipes out the article detail fetches', async () => {
  const company = { target_no: 63, company: 'DNP', query_aliases: ['Dai Nippon Printing'] };
  const base = 'https://www.dnp-replay.example';
  const articles = [
    ['20178744_1587', 'DNP introduced in Sankei Shimbun My Vision', '2026-10-27'],
    ['20178725_1587', 'DNP Group Sustainability Briefing 2026 video released', '2026-10-23'],
    ['20178718_1587', 'DNP joins the Tokyo Green Biz Lounge for employee well-being', '2026-10-19'],
    ['20178679_1587', 'DNP establishes the joint venture TriNebula Cell Tech', '2026-10-09'],
  ];
  const detailUrl = id => `${base}/news/detail/${id}.html`;
  const feed = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>DNP News</title>
<item><title>${articles[3][1]}</title><link>${detailUrl(articles[3][0])}?from=rss</link><pubDate>Fri, 09 Oct 2026 01:00:00 GMT</pubDate></item>
</channel></rss>`;
  const listing = `<html><body><ul>${articles.slice(0, 3).map(([id, title, date]) =>
    `<li><a href="${detailUrl(id)}">${title}</a> <span>${date}</span></li>`).join('')}</ul></body></html>`;
  const library = `<html><body><a href="${base}/ir/library/">IR Library</a> <a href="${base}/ir/faq/">FAQ</a></body></html>`;
  const articleHtml = (title, date) => `<html><head><title>${title}</title>
<meta property="article:published_time" content="${date}"></head>
<body><main><article><h1>${title}</h1><p>${'Dai Nippon Printing announced the initiative in Tokyo today. '.repeat(10)}</p></article></main></body></html>`;
  const pages = {
    [`${base}/news/rss_news_jp.xml`]: () => new Response(feed, { headers: { 'content-type': 'application/rss+xml' } }),
    [`${base}/news/`]: () => new Response(listing, { headers: { 'content-type': 'text/html' } }),
    // 번역 프록시가 없어진 경로. 몇 번을 보내도 같은 500 이다.
    [`${base}/en/ir/`]: () => new Response('<html><title>Fastly error: unknown domain</title></html>',
      { status: 500, statusText: 'Internal Server Error', headers: { 'content-type': 'text/html', 'retry-after': '0' } }),
    [`${base}/ir/library/report/`]: () => new Response(library, { headers: { 'content-type': 'text/html' } }),
    [`${base}/ir/library/?lang=en`]: () => new Response(library, { headers: { 'content-type': 'text/html' } }),
  };
  for (const [id, title, date] of articles) {
    for (const url of [detailUrl(id), `${detailUrl(id)}?from=rss`]) {
      pages[url] = () => new Response(articleHtml(title, date), { headers: { 'content-type': 'text/html' } });
    }
  }
  const sourceConfig = {
    official_feeds: { DNP: [{ source: 'DNP - Official RSS', kind: 'press_release', url: `${base}/news/rss_news_jp.xml` }] },
    official_pages: { DNP: [
      { source: 'DNP - Corporate News', kind: 'newsroom', url: `${base}/news/` },
      { source: 'DNP - Investor Relations', kind: 'ir', url: `${base}/en/ir/` },
      { source: 'DNP - Securities Reports', kind: 'filing', url: `${base}/ir/library/report/` },
      { source: 'DNP - IR Library', kind: 'financial_report', url: `${base}/ir/library/?lang=en` },
    ] },
  };
  const october = { mode: 'explicit', fromDate: '2026-10-01', toDate: '2026-10-31', from_date: '2026-10-01', to_date: '2026-10-31',
    fromMs: Date.parse('2026-10-01T00:00:00Z'), toMs: Date.parse('2026-10-31T23:59:59Z'), lookbackDays: 45 };
  const args = { ...parseArgs([]), rateLimitSeconds: 0, timeoutSeconds: 5, maxPerSource: 6, maxPerCompany: 10, maxDetailPerCompany: 10 };
  const trend = { technologyMap: { companies: [] }, keywordConfig: { groups: {} }, searchTerms: {} };
  const { result, requested } = await withFetch(url => pages[url]?.(),
    () => collectCompany(company, sourceConfig, ['official_feeds', 'official_pages'], args, october, '2026-11-02T07:02:42Z',
      { probe: (url, request) => request(), trend }));
  // IR 페이지는 재시도까지 세 번 보냈고, 그 오류 하나만 남는다.
  assert.equal(requested.filter(url => url === `${base}/en/ir/`).length, 3);
  assert.deepEqual(result.errors.map(error => [error.source, error.kind, error.error]),
    [['official_pages', 'ir', 'HTTP 500 Internal Server Error']]);
  // 뒤따른 IR 목록 2곳과 기사 상세는 쉼 없이 나갔고 본문을 받았다.
  assert.ok(requested.includes(`${base}/ir/library/report/`));
  assert.ok(requested.includes(`${base}/ir/library/?lang=en`));
  const fetched = result.rows.filter(row => row.content_fetch_status === 'fetched').map(row => row.url.replace(base, '')).sort();
  assert.deepEqual(fetched, [
    '/news/detail/20178679_1587.html?from=rss', '/news/detail/20178718_1587.html', '/news/detail/20178725_1587.html',
    '/news/detail/20178744_1587.html',
  ]);
  assert.ok(result.rows.every(row => row.content_fetch_status === 'fetched'));
});

test('checkpoint resumes completed companies, retries transient failures, expires and respects refresh', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'company-progress-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let calls = 0, now = 100;
  const args = { directory, identity: { company: 'A', period: '2026-08' }, now: () => now,
    collect: async () => { calls++; return { rows: [{ title: 'article' }], requestCount: 3, errors: [] }; } };
  assert.equal((await collectWithCheckpoint(args)).cached, false);
  const cached = await collectWithCheckpoint(args);
  assert.equal(cached.cached, true);
  assert.equal(cached.requestCount, 0);
  assert.equal(calls, 1);
  await collectWithCheckpoint({ ...args, refresh: true });
  assert.equal(calls, 2);
  now += 24 * 3600000;
  await collectWithCheckpoint(args);
  assert.equal(calls, 3);
  const bad = { ...args, identity: { company: 'B' }, collect: async () => ({ rows: [], requestCount: 1, errors: [{ error: 'fetch failed' }] }) };
  await collectWithCheckpoint(bad);
  assert.equal((await collectWithCheckpoint(bad)).cached, false);
  assert.equal(coverageStatus([], new Map(), 'incomplete'), 'incomplete_evidence');
});

// 9월 28일 실행: Google 확인이 멈춘 뒤의 78건은 요청 없이 남았고 오류도 없어, 체크포인트가 완료로 저장됐다.
test('Google rows skipped by a paused probe make the company retryable, detail failures alone do not', () => {
  const result = errors => ({ rows: [], requestCount: 1, errors });
  assert.equal(retryableCollection(result([{ source: 'official_detail', error: 'google_probe_paused' }])), true);
  assert.equal(retryableCollection(result([{ source: 'official_detail', error: 'HTTP 403 Forbidden' }])), false);
  assert.equal(collectionBlockingErrors([{ source: 'official_detail', error: 'google_probe_paused' }]).length, 0);
});

// 한 기업의 출처를 고쳤다고 77개 기업을 모두 다시 받지 않는다. 그 기업 결과를 바꿀 수 있는 것은 모두 식별자에 남는다.
test('a company checkpoint depends on its own sources and every setting that shapes its rows', () => {
  const hydro = { target_no: 31, company: 'Norsk Hydro', query_aliases: ['Hydro'] };
  const sources = { description: ['note'],
    official_feeds: { 'Norsk Hydro': [{ url: 'https://hydro.example/rss' }], Cognex: [{ url: 'https://cognex.example/rss' }] },
    official_pages: { 'Norsk Hydro': [{ url: 'https://hydro.example/news' }], Cognex: [{ url: 'https://cognex.example/news' }] },
    official_sitemaps: { Cognex: [{ url: 'https://cognex.example/sitemap.xml' }] },
    sec_filers: { Cognex: { cik: '1' } } };
  const technology = { companies: [
    { target_no: 31, company: 'Norsk Hydro', technology_group: 'scrap', target_technology_en: 'scrap use' },
    { target_no: 5, company: 'Cognex', technology_group: 'vision', target_technology_en: 'machine vision' }] };
  const keywords = { default_threshold: 1, groups: { scrap: { keywords: ['recycled aluminium'] }, vision: { keywords: ['camera'] } } };
  const terms = { companies: { 'Norsk Hydro': ['CIRCAL'], Cognex: ['In-Sight'] } };
  const args = parseArgs(['--from-date', '2026-09-01', '--to-date', '2026-09-30', '--max-trend-discovery', '2']);
  const dateRange = { fromDate: '2026-09-01', toDate: '2026-09-30' };
  const key = ({ company = hydro, sourceConfig = sources, settings = args, selectedSources = ['official_pages', 'google_news'],
    period = dateRange, tech = technology, kw = keywords, st = terms } = {}) => JSON.stringify(companyCollectionIdentity({
    company, sourceConfig, args: settings, selectedSources, dateRange: period,
    trendInputs: companyTrendInputs(settings, company, tech, kw, st) }));
  const base = key();
  const edit = (object, change) => ({ ...structuredClone(object), ...change });
  // 다른 기업의 출처·기술 항목·키워드 그룹·검색어를 고쳐도 그대로다. 실행 위치(outDir)·refresh 도 그렇다.
  for (const same of [
    key({ sourceConfig: edit(sources, { official_pages: { ...sources.official_pages, Cognex: [{ url: 'https://cognex.example/press' }] } }) }),
    key({ sourceConfig: edit(sources, { sec_filers: {}, official_sitemaps: {} }) }),
    key({ tech: { companies: [technology.companies[0], { ...technology.companies[1], technology_group: 'scrap' }] } }),
    key({ kw: edit(keywords, { groups: { ...keywords.groups, vision: { keywords: ['lens'] } } }) }),
    key({ st: { companies: { 'Norsk Hydro': ['CIRCAL'] } } }),
    key({ settings: { ...args, outDir: 'elsewhere', refresh: true } }),
  ]) assert.equal(same, base);
  // 자기 몫의 출처·기술 항목·키워드 그룹·검색어, 회사 항목, 기간, 출처 목록, 상한·정책은 모두 식별자를 바꾼다.
  for (const changed of [
    key({ sourceConfig: edit(sources, { official_feeds: { ...sources.official_feeds, 'Norsk Hydro': [] } }) }),
    key({ sourceConfig: edit(sources, { official_pages: { ...sources.official_pages, 'Norsk Hydro': [{ url: 'https://hydro.example/press' }] } }) }),
    key({ sourceConfig: edit(sources, { official_sitemaps: { ...sources.official_sitemaps, 'Norsk Hydro': [{ url: 'https://hydro.example/s.xml' }] } }) }),
    key({ sourceConfig: edit(sources, { sec_filers: { ...sources.sec_filers, 'Norsk Hydro': { cik: '2' } } }) }),
    key({ sourceConfig: edit(sources, { defaults: { timeout: 5 } }) }),
    key({ tech: { companies: [{ ...technology.companies[0], target_technology_en: 'scrap utilisation' }, technology.companies[1]] } }),
    key({ kw: edit(keywords, { groups: { ...keywords.groups, scrap: { keywords: ['remelting'] } } }) }),
    key({ kw: edit(keywords, { default_threshold: 2 }) }),
    key({ st: { companies: { 'Norsk Hydro': ['CIRCAL', 'recycled alu'], Cognex: ['In-Sight'] } } }),
    key({ company: { ...hydro, search_names: ['Norsk Hydro ASA'] } }),
    key({ period: { fromDate: '2026-08-01', toDate: '2026-08-31' } }),
    key({ selectedSources: ['official_pages'] }),
    key({ settings: { ...args, maxPerCompany: 12 } }),
    key({ settings: { ...args, maxDetailPerCompany: 3 } }),
    key({ settings: { ...args, linkPolicy: args.linkPolicy === 'current' ? 'proposed' : 'current' } }),
    key({ settings: { ...args, maxTrendDiscovery: 1 } }),
    key({ settings: { ...args, contentCharLimit: 1000 } }),
  ]) assert.notEqual(changed, base);
  // 탐색을 끄면 탐색 입력은 식별자에서 빠진다.
  assert.equal(companyTrendInputs({ maxTrendDiscovery: 0 }, hydro, technology, keywords, terms), null);
});

// 무료 한도로 판정이 멈추면 다음 날 이어 돌린다. 마감 뒤 사흘이 지나 받은 수집본만 72시간까지 쓴다.
test('collection lasts 72 hours only when it was taken three days after the period closed', async t => {
  const at = value => Date.parse(value);
  // 9월 기간은 10월 1일 0시에 닫힌다. 10월 4일 0시부터 받은 수집본이 72시간 대상이다.
  assert.equal(collectionMaxAgeMs('2026-09-30', at('2026-10-04T00:00:00Z')), 72 * 3600000);
  assert.equal(collectionMaxAgeMs('2026-09-30', at('2026-10-03T23:59:59Z')), 24 * 3600000);
  assert.equal(collectionMaxAgeMs('2026-09-30', at('2026-10-01T04:49:52Z')), 24 * 3600000);
  // 기간이 없는 조회와 잘못된 시각은 기본값이다.
  assert.equal(collectionMaxAgeMs('', at('2026-12-01T00:00:00Z')), 24 * 3600000);
  assert.equal(collectionMaxAgeMs('2026-09-30', NaN), 24 * 3600000);

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'company-progress-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let calls = 0, now = at('2026-10-05T09:00:00Z');
  const args = { directory, identity: { company: 'A', period: '2026-09' }, toDate: '2026-09-30', now: () => now,
    collect: async () => { calls++; return { rows: [{ title: 'article' }], requestCount: 3, errors: [] }; } };
  await collectWithCheckpoint(args);
  now += 48 * 3600000;
  assert.equal((await collectWithCheckpoint(args)).cached, true);
  now += 24 * 3600000;
  assert.equal((await collectWithCheckpoint(args)).cached, false);
  assert.equal(calls, 2);
  // 마감 다음 날 받은 수집본은 실행이 마감 사흘 뒤여도 24시간만 쓴다.
  const early = { ...args, identity: { company: 'B', period: '2026-09' } };
  now = at('2026-10-02T09:00:00Z');
  await collectWithCheckpoint(early);
  now = at('2026-10-04T08:00:00Z');
  assert.equal((await collectWithCheckpoint(early)).cached, false);
});
