// 2026-10 수집(5호)에서 오류 없이 조용히 비거나 빠진 공식 출처 다섯 가지를 네트워크 없이 다시 만든다.
// 1. SCHOTT Pharma IR 페이지 세 곳은 SvelteKit 껍데기(링크 0개)라 매달 0건이었다. 사이트 검색 API(JSON)를 읽는다.
//    날짜(tagLine)가 "Thursday, October 1, 2026, mainz, germany" 라 JSON 피드 날짜를 글 속에서 찾는다.
// 2. Shanghai Electric Wind Power 의 shanghai-electric.com 페이지 네 곳은 메뉴뿐이었다(링크 299개 모두 거부).
//    상하이거래소 IR API(open.sseinfo.com)의 임시공고·정기보고를 읽고, 중국어 정례 공시는 같은 출처 안에서 뒤로 보낸다.
// 3. 200 으로 받았는데 링크가 0개인 공식 페이지는 page_empty 오류로 남긴다.
// 4. 목록 페이지가 광고한 피드(Texcell /actualites/feed/ 500)는 한 번만 받고, 그 실패로 호스트를 쉬게 하지 않는다.
// 5. Plansee 의 /en/articles/detail/ 기사는 설정의 article_path 로 기사로 받는다(확인 예산 0 에 빠지던 10/15 기사).
// 같은 수집에서 남은 세 곳(2026-11-10 점검):
// 6. AGC(Asahi Glass) /en/news/ 는 목록을 스크립트로 news_all.json 에서 그린다. 링크 133개가 모두 메뉴라 오류 없이 0건이었다.
//    그 JSON 을 읽는다. 날짜가 "20261028-100000" 이다.
// 7. Toray /news/ 는 목록도 기사(article.html?contentId=)도 키가 필요한 CMS API(microCMS)로 그린다. 받을 것이 없어 뺐다.
// 8. maxon 뉴스룸은 서버가 그린 목록이라 그대로 둔다(10월 전사 보도자료가 없었다). 날짜 없는 안내서 PDF 만 싣는
//    Media Center 는 뺐고, 동명 대상(Maxon 소프트웨어 등)을 가를 target_identity 를 넣었다.
// 고정 자료는 실제 응답의 구조만 흉내 낸 것이다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { collectionBlockingErrors, collectCompany, configuredArticleVerdict, CHINESE_ROUTINE_FILING_PATTERN,
  correctionsLast, extractDateFromText, fetchDiscoveredFeed, fetchText, jsonFeedDate, parseArgs, parseJsonFeed,
  routineNotice } from '../scripts/collect_company_signals.mjs';
import { createDomainGuard, retryableCollection } from '../scripts/collection_resilience.mjs';
import { decisionForApproval } from '../scripts/local_report.mjs';
import { configuredOfficialHosts } from '../scripts/publisher_recovery.mjs';

const realSources = JSON.parse(fs.readFileSync(new URL('../config/company_sources.json', import.meta.url), 'utf8'));
const realTechnology = JSON.parse(fs.readFileSync(new URL('../data/company_technology_map.json', import.meta.url), 'utf8'));

async function withFetch(handler, task) {
  const realFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (target) => {
    const url = String(target);
    requested.push(url);
    const response = handler(url, requested) || new Response('not found', { status: 404, statusText: 'Not Found' });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  };
  try { return { result: await task(), requested }; } finally { globalThis.fetch = realFetch; }
}

const html = body => new Response(body, { headers: { 'content-type': 'text/html' } });
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const october = { mode: 'explicit', fromDate: '2026-10-01', toDate: '2026-10-31', from_date: '2026-10-01', to_date: '2026-10-31',
  fromMs: Date.parse('2026-10-01T00:00:00Z'), toMs: Date.parse('2026-10-31T23:59:59Z'), lookbackDays: 45 };
const args = { ...parseArgs([]), rateLimitSeconds: 0, timeoutSeconds: 5, fetchRetries: 0, maxPerSource: 6, maxPerCompany: 10,
  maxDetailPerCompany: 6 };
const trend = { technologyMap: { companies: [] }, keywordConfig: { groups: {} }, searchTerms: {} };
const always = (url, request) => request();
const collect = (company, sourceConfig, sources, options = {}) => collectCompany(company, sourceConfig, sources,
  { ...args, ...options }, october, '2026-11-04T00:00:00Z', { probe: always, trend });
const articleHtml = (title, sentence, date = '') => `<html><head><title>${title}</title>
${date ? `<meta property="article:published_time" content="${date}">` : ''}</head>
<body><main><article><h1>${title}</h1><p>${sentence.repeat(10)}</p></article></main></body></html>`;

// --- 1. JSON 피드 날짜 ----------------------------------------------------------------------------------------

test('a JSON feed date that is not a date by itself is read from its text; dates that already parse are unchanged', () => {
  assert.equal(jsonFeedDate('Thursday, October 1, 2026, mainz, germany'), '2026-10-01T00:00:00Z');
  assert.equal(jsonFeedDate('Tuesday, September 22, 2026, mainz, germany'), '2026-09-22T00:00:00Z');
  // 지금 쓰는 피드의 모양: magniX YYYYMMDD, SSE ISO 날짜, Q4 "MM/DD/YYYY HH:MM:SS". 예전 값 그대로다.
  assert.equal(jsonFeedDate('20261015'), '2026-10-15');
  assert.equal(jsonFeedDate('2026-10-28'), '2026-10-28');
  assert.equal(jsonFeedDate('10/29/2026 00:00:00'), '10/29/2026 00:00:00');
  assert.equal(jsonFeedDate('2026-10-28T08:30:00Z'), '2026-10-28T08:30:00Z');
  assert.equal(jsonFeedDate('October 2026'), 'October 2026');
  // 날짜가 없는 글은 그대로 두어 날짜 미상이 된다.
  assert.equal(jsonFeedDate('mainz, germany'), 'mainz, germany');
  assert.equal(jsonFeedDate(''), '');
  assert.equal(jsonFeedDate(undefined), '');
});

test('ISO and Q4-dated JSON feeds produce the same rows as before', () => {
  const company = { target_no: 1, company: 'Cognex' };
  const q4 = JSON.stringify({ GetPressReleaseListResult: [
    { Headline: 'Cognex Reports Third Quarter 2026 Results', LinkToDetailPage: '/news/2026/q3', PressReleaseDate: '10/29/2026 00:00:00', Body: '' },
  ] });
  const [row] = parseJsonFeed(q4, company, '2026-11-04T00:00:00Z', 'https://investor.cognex.com/feed', 'Cognex feed', 'press_release',
    realSources.official_feeds.Cognex[0].json);
  assert.equal(row.published_at, '2026-10-29T00:00:00Z');
  assert.equal(row.published_at_source, 'feed');
  const sse = JSON.stringify({ pageContent: [{ ssedate: '2026-10-28', title: '2026年第三季度报告', url: 'https://static.sse.example/a.pdf' }] });
  const [iso] = parseJsonFeed(sse, company, '2026-11-04T00:00:00Z', 'https://open.sseinfo.example/ir2/notice', 'SSE', 'filing',
    { items: 'pageContent', title: 'title', url: 'url', date: 'ssedate' });
  assert.equal(iso.published_at, '2026-10-28T00:00:00Z');
  assert.equal(iso.title, '2026年第三季度报告');
});

// --- 1. SCHOTT Pharma -------------------------------------------------------------------------------------------

const SCHOTT = 'https://www.schott-pharma.com';
const schottItem = (name, title, tagLine) => ({ image: { src: 'https://media.schott.example/1', alt: '' }, name, tagLine, title,
  description: '<ul><li>SCHOTT Pharma said the tool was validated by an independent third party.</li></ul>',
  tags: ['2026', 'Corporate'], linkHref: `/en/news-and-media/media-releases/2026/${name}`, linkTarget: '_self', linkText: 'Read more' });
const SCHOTT_API = { numFound: 16, results: [
  schottItem('schott-pharma-makes-decarbonization-measurable', 'SCHOTT Pharma makes decarbonization measurable',
    'Thursday, October 1, 2026, mainz, germany'),
  schottItem('schott-pharma-and-nemera-launch', 'SCHOTT Pharma and Nemera launch first fully compatible platform',
    'Tuesday, September 22, 2026, mainz, germany'),
] };
const SCHOTT_ARTICLE = `${SCHOTT}/en/news-and-media/media-releases/2026/schott-pharma-makes-decarbonization-measurable`;

test('SCHOTT Pharma is read from its search API: the October release is dated, official and gets its detail body', async () => {
  const company = { target_no: 38, company: 'Schott Pharma', query_aliases: [] };
  const [feed] = realSources.official_feeds['Schott Pharma'];
  const { result, requested } = await withFetch(url => url === feed.url ? json(SCHOTT_API)
    : url === SCHOTT_ARTICLE ? html(articleHtml('SCHOTT Pharma makes decarbonization measurable',
      'SCHOTT Pharma said its product carbon footprint tool for primary packaging was validated by an independent party. '))
      : null,
  () => collect(company, realSources, ['official_feeds', 'official_pages']));
  assert.deepEqual(result.errors, []);
  const rows = result.rows.filter(row => row.source_type === 'official');
  assert.deepEqual(rows.map(row => row.url), [SCHOTT_ARTICLE]);
  const [row] = rows;
  assert.equal(row.published_at, '2026-10-01T00:00:00Z');
  assert.equal(row.published_month, '2026-10');
  assert.equal(row.published_at_source, 'feed');
  assert.equal(row.source_kind, 'press_release');
  // 피드의 description 은 요약 몇 줄이라 본문으로 싣지 않는다. 상세 페이지를 받아 본문을 얻는다.
  assert.equal(row.content_fetch_status, 'fetched');
  assert.ok(row.content_text.length > 500);
  // 9월 항목은 기간 밖이라 상세 페이지도 받지 않는다. 빈 껍데기 IR 페이지는 더 이상 요청하지 않는다.
  assert.deepEqual(requested, [feed.url, SCHOTT_ARTICLE]);
});

test('SCHOTT Pharma has no JavaScript-shell pages left, and its feed host still counts as official', () => {
  assert.equal(realSources.official_pages['Schott Pharma'], undefined);
  const [feed] = realSources.official_feeds['Schott Pharma'];
  assert.equal(feed.format, 'json');
  assert.equal(feed.json.body, undefined);
  assert.ok(configuredOfficialHosts('Schott Pharma', realSources).has('schott-pharma.com'));
  // 피드 호스트를 더해도 다른 기업의 공식 호스트는 그대로다(설정된 피드 호스트는 모두 목록 페이지 호스트이기도 하다).
  for (const [name, feeds] of Object.entries(realSources.official_feeds)) {
    if (!realSources.official_pages[name]) continue;
    const pagesOnly = configuredOfficialHosts(name, { official_pages: realSources.official_pages });
    for (const feed of feeds) {
      const host = new URL(typeof feed === 'string' ? feed : feed.url).hostname.replace(/^www\./, '');
      assert.ok(pagesOnly.has(host), `${name}: ${host}`);
    }
  }
});

// --- 2. Shanghai Electric Wind Power (SSE) -------------------------------------------------------------------

const SSE_PDF = 'https://static.sse.com.cn/disclosure/listedinfo/announcement/c/new';
const sseItem = (date, title, code) => ({ ssedate: date, title, url: `${SSE_PDF}/${date}/688660_${date.replace(/-/g, '')}_${code}.pdf` });
const SSE_NOTICES = { Page: 1, Pages: 24, pageContent: [
  sseItem('2026-10-28', '关于参加2026年上海辖区上市公司三季报集体业绩说明会的公告', '9D4O'),
  sseItem('2026-10-28', '计提资产减值准备及确认其他流动负债的公告', 'WPCT'),
  sseItem('2026-08-25', '关于参加科创板2026年半年度新能源行业集体业绩说明会的公告', 'GGR4'),
] };
const SSE_PERIODIC = { Page: 1, Pages: 11, pageContent: [
  sseItem('2026-10-28', '2026年第三季度报告', 'NJ2A'),
  sseItem('2026-08-18', '2026年半年度报告', '2YZ7'),
] };

test('Shanghai Electric Wind Power is read from the SSE IR API; October filings and the Q3 report appear as dated official rows', async () => {
  const company = { target_no: 77, company: 'Shanghai Electric Wind Power', query_aliases: [] };
  const [notices, periodic] = realSources.official_feeds['Shanghai Electric Wind Power'];
  // PDF 는 404 로 둔다(본문 없음). 행과 날짜·종류는 피드에서 나온다.
  const { result } = await withFetch(url => url === notices.url ? json(SSE_NOTICES) : url === periodic.url ? json(SSE_PERIODIC) : null,
    () => collect(company, realSources, ['official_feeds', 'official_pages']));
  const rows = result.rows.filter(row => row.collector === 'official_feed');
  assert.deepEqual(rows.map(row => [row.published_at.slice(0, 10), row.source_kind, row.title]).sort(), [
    ['2026-10-28', 'filing', '关于参加2026年上海辖区上市公司三季报集体业绩说明会的公告'],
    ['2026-10-28', 'filing', '计提资产减值准备及确认其他流动负债的公告'],
    ['2026-10-28', 'financial_report', '2026年第三季度报告'],
  ]);
  for (const row of rows) {
    assert.equal(row.source_type, 'official');
    assert.match(row.url, /^https:\/\/static\.sse\.com\.cn\/.+\.pdf$/);
  }
  // 상세 PDF 실패는 상세 단계 오류라 기업을 미완료로 만들지 않는다.
  assert.deepEqual(collectionBlockingErrors(result.errors), []);
});

test('with a per-source cap of one, the impairment notice keeps its place ahead of the earnings-call notice', async () => {
  const company = { target_no: 77, company: 'Shanghai Electric Wind Power', query_aliases: [] };
  const [notices] = realSources.official_feeds['Shanghai Electric Wind Power'];
  const { result } = await withFetch(url => url === notices.url ? json(SSE_NOTICES) : null,
    () => collect(company, { official_feeds: { [company.company]: [notices] } }, ['official_feeds'], { maxPerSource: 1 }));
  assert.deepEqual(result.rows.map(row => row.title), ['计提资产减值准备及确认其他流动负债的公告']);
});

test('Chinese routine filings are ordered after substantive ones; quarterly reports, contracts and impairments are not routine', () => {
  const routine = ['关于参加2026年上海辖区上市公司三季报集体业绩说明会的公告', '2025年年度股东会决议公告', '关于召开2025年年度股东会的通知',
    '2025年年度股东会会议资料', '股东大会2025年第二次临时会议决议公告',
    '国浩律师（上海）事务所关于上海电气风电集团股份有限公司2025年年度股东会的法律意见书',
    '2026年上半年度募集资金存放、管理与实际使用情况的专项报告', '关于使用部分闲置募集资金进行现金管理的公告',
    '中信证券关于电气风电2025年度募集资金存放与使用情况的专项核查意见', '独立董事（蔡旭）2025年度述职报告', '第三届监事会第十次会议决议公告'];
  const substantive = ['2026年第三季度报告', '2026年半年度报告', '上海电气风电集团股份有限公司2025年年度报告摘要', '关于签订重大合同的公告',
    '计提资产减值准备及确认其他流动负债的公告', '2025年度业绩快报公告', '2025年年度业绩预亏公告', '关于对外投资设立合资公司的公告',
    '2025年度可持续发展报告', '董事会决议公告'];
  for (const title of routine) assert.equal(CHINESE_ROUTINE_FILING_PATTERN.test(title), true, title);
  for (const title of substantive) assert.equal(CHINESE_ROUTINE_FILING_PATTERN.test(title), false, title);
  const ordered = correctionsLast([...routine, ...substantive].map(title => ({ title, source_type: 'official' })));
  assert.deepEqual(ordered.map(row => row.title), [...substantive, ...routine]);
  // 외부 기사 거르기(routineNotice 는 외부 행을 뺀다)에는 넣지 않았다. 중국어 기사 제목을 빼지 않는다.
  assert.equal(routineNotice({ title: '上海电气风电股东大会通过新的海上风电投资计划 - 新浪财经' }), false);
});

test('the shanghai-electric.com navigation pages are no longer read', () => {
  assert.equal(realSources.official_pages['Shanghai Electric Wind Power'], undefined);
  const feeds = realSources.official_feeds['Shanghai Electric Wind Power'];
  assert.deepEqual(feeds.map(feed => [feed.kind, new URL(feed.url).searchParams.get('bulletintype')]), [['filing', '2'], ['financial_report', '1']]);
  for (const feed of feeds) assert.equal(new URL(feed.url).searchParams.get('code'), '688660');
});

// --- 3. 링크가 0개인 공식 페이지 ----------------------------------------------------------------------------

const SHELL = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title></title>'
  + '<link rel="modulepreload" href="/_app/immutable/entry/start.js"></head><body data-sveltekit-preload-data="hover">'
  + '<div style="display: contents"><script>__sveltekit_x = { base: "" };</script></div></body></html>';

test('an official page with no links is a page_empty error; a page whose links are all rejected or filtered is not', async () => {
  const company = { target_no: 90, company: 'Shell Co', query_aliases: [] };
  const pages = [
    { source: 'Shell Co - IR', kind: 'press_release', url: 'https://shell-page.example/investor-relations/press-releases' },
    // 메뉴 링크만 있는 페이지: 링크가 모두 거부돼도 오류가 아니다.
    { source: 'Shell Co - profile', kind: 'official_page', url: 'https://menu-page.example/about' },
    // include 로 모두 걸러진 페이지도 링크는 있었다.
    { source: 'Shell Co - distribution', kind: 'press_release', url: 'https://filtered-page.example/list/', include: '/ShellCo/' },
    // 링크 없이 피드만 알리는 페이지는 그 피드가 목록이다.
    { source: 'Shell Co - feed only', kind: 'press_release', url: 'https://feed-only-page.example/news' },
  ];
  const menu = '<html><body><nav><a href="/">Home</a> <a href="/about/contact">Contact</a> <a href="/careers">Careers</a></nav></body></html>';
  const filtered = '<html><body><a href="/OtherCo/OPR1/en/">Other company opens a plant in 2026</a></body></html>';
  const feedOnly = '<html><head><link rel="alternate" type="application/rss+xml" href="https://feed-only-page.example/news/rss.xml"></head><body></body></html>';
  const rss = '<?xml version="1.0"?><rss><channel><title>News</title></channel></rss>';
  const { result } = await withFetch(url => url === pages[0].url ? html(SHELL) : url === pages[1].url ? html(menu)
    : url === pages[2].url ? html(filtered) : url === pages[3].url ? html(feedOnly)
      : url.endsWith('/rss.xml') ? new Response(rss, { headers: { 'content-type': 'application/rss+xml' } }) : null,
  () => collect(company, { official_pages: { [company.company]: pages } }, ['official_pages']));
  assert.deepEqual(result.errors.map(error => [error.source, error.source_url, error.kind, error.error]), [
    ['official_pages', pages[0].url, 'press_release', 'page_empty: 0 links'],
  ]);
  // sitemap_empty 처럼 기업을 미완료로 남기지만 재시도 대상은 아니다(다시 받아도 같다).
  assert.equal(collectionBlockingErrors(result.errors).length, 1);
  assert.equal(retryableCollection(result), false);
  // 공시·재무 문서 페이지의 오류는 지금처럼 기업을 미완료로 만들지 않는다.
  assert.deepEqual(collectionBlockingErrors([{ source: 'official_pages', kind: 'filing', error: 'page_empty: 0 links' }]), []);
});

// --- 4. 찾아낸 피드 ------------------------------------------------------------------------------------------

const WP_NO_FEEDS = '<!DOCTYPE html><html lang="fr-FR"><head><title>Texcell &rsaquo; Error</title></head>'
  + '<body id="error-page"><div class="wp-die-message"><h1>No feeds available!</h1></div></body></html>';

test('a discovered feed that answers 500 is asked once and does not put its host on cooldown', async () => {
  const company = { target_no: 57, company: 'Texcell', query_aliases: [] };
  const base = 'https://texcell-like.example';
  const pages = [
    { source: 'Texcell - News', kind: 'newsroom', url: `${base}/actualites/` },
    { source: 'Texcell - Website', kind: 'official_page', url: `${base}/` },
  ];
  const listing = `<html><head><link rel="alternate" type="application/rss+xml" href="${base}/actualites/feed/"></head><body>
<ul><li><a href="${base}/actualites/cphi-pmec-india-2026/">CPHI &amp; PMEC India 2026</a> <span>27/10/2026</span></li>
<li><a href="${base}/actualites/bio-europe-2026/">Join Texcell at BIO-Europe 2026</a> <span>14/10/2026</span></li></ul></body></html>`;
  const home = `<html><body><a href="${base}/actualites/">News</a> <a href="${base}/viral-clearance/">Viral clearance</a></body></html>`;
  const details = {
    [`${base}/actualites/cphi-pmec-india-2026/`]: articleHtml('CPHI & PMEC India 2026', 'Texcell will attend CPHI and PMEC India in New Delhi with its viral safety team. ', '2026-10-27'),
    [`${base}/actualites/bio-europe-2026/`]: articleHtml('Join Texcell at BIO-Europe 2026', 'Texcell will meet partners at BIO-Europe to discuss viral clearance studies. ', '2026-10-14'),
  };
  // 설정한 재시도 횟수와 상관없이 한 번만 보낸다.
  const { result, requested } = await withFetch(url => url === `${base}/actualites/feed/`
    ? new Response(WP_NO_FEEDS, { status: 500, statusText: 'Internal Server Error', headers: { 'content-type': 'text/html' } })
    : url === pages[0].url ? html(listing) : url === pages[1].url ? html(home) : details[url] ? html(details[url]) : null,
  () => collect(company, { official_pages: { [company.company]: pages } }, ['official_pages'], { fetchRetries: 2 }));
  assert.equal(requested.filter(url => url.endsWith('/feed/')).length, 1);
  assert.deepEqual(result.errors.map(error => [error.kind, error.error]),
    [['discovered_feed', 'feed_unavailable: no feeds available (status 500)']]);
  // 그 실패로 홈페이지·상세 기사가 domain_cooldown 으로 끝나지 않는다.
  assert.ok(requested.includes(pages[1].url));
  const rows = result.rows.filter(row => row.collector === 'official_page');
  assert.deepEqual(rows.map(row => [row.published_at.slice(0, 10), row.content_fetch_status]).sort(),
    [['2026-10-14', 'fetched'], ['2026-10-27', 'fetched']]);
  // WordPress 가 피드를 끈 것은 일시 오류가 아니다. 기업을 매번 다시 받게 하지 않는다. 찾아낸 피드 오류는 미완료도 아니다.
  assert.equal(retryableCollection(result), false);
  assert.deepEqual(collectionBlockingErrors(result.errors), []);
});

test('a discovered feed\'s other HTTP failures are kept as they are, without retries; configured feeds still retry', async () => {
  const { result: plain, requested } = await withFetch(() => new Response('oops', { status: 503, statusText: 'Service Unavailable' }),
    () => fetchDiscoveredFeed('https://discovered-503.example/feed/', 5).catch(error => error));
  assert.equal(plain.message, 'HTTP 503 Service Unavailable');
  assert.equal(plain.noRetry, true);
  assert.equal(requested.length, 1);
  // 설정한 피드(fetchText)는 지금처럼 일시 오류를 다시 보낸다.
  let calls = 0;
  const { result: text, requested: configured } = await withFetch(() => (++calls === 1
    ? new Response('busy', { status: 503, statusText: 'Service Unavailable' })
    : new Response('<rss><channel></channel></rss>', { headers: { 'content-type': 'application/rss+xml' } })),
  () => fetchText('https://configured-503.example/feed/', 5));
  assert.equal(configured.length, 2);
  assert.match(text, /<rss>/);
});

test('host-neutral failures neither start nor clear a host cooldown', async () => {
  const guard = createDomainGuard({ threshold: 2, cooldownMs: 30000 });
  const neutral = () => guard.run('https://neutral.example/feed/', async () => {
    throw Object.assign(new Error('HTTP 500'), { status: 500, noRetry: true, hostNeutral: true });
  });
  for (let i = 0; i < 3; i++) await assert.rejects(neutral());
  assert.equal(await guard.run('https://neutral.example/news', async () => 'ok'), 'ok');
  // 진짜 장애 한 번 뒤의 중립 실패는 연속 횟수를 지우지 않는다. 장애가 한 번 더 오면 쉰다.
  // 5xx 는 주소마다 한 번만 세므로(2026-10 DNP) 둘째 장애는 다른 주소다.
  const down = page => guard.run(`https://neutral.example/${page}`, async () => {
    throw Object.assign(new Error('HTTP 502'), { status: 502 });
  });
  await assert.rejects(down('x'));
  await assert.rejects(neutral());
  await assert.rejects(down('z'));
  await assert.rejects(guard.run('https://neutral.example/y', async () => 'never'), /domain_cooldown/);
});

// --- 5. Plansee: 설정의 기사 주소 모양 -----------------------------------------------------------------------

const PLANSEE = 'https://plansee-group.com';
const planseeCard = (slug, title, date) => `<li class="teaser"><a href="${PLANSEE}/en/articles/detail/${slug}"><img src="/x.jpg" alt=""></a>
<p class="date">${date}</p><h3><a href="${PLANSEE}/en/articles/detail/${slug}">${title}</a></h3>
<a href="${PLANSEE}/en/articles/detail/${slug}">read more</a></li>`;
const PLANSEE_LISTING = `<html><body><nav><a href="${PLANSEE}/en/company">Company</a> <a href="${PLANSEE}/en/careers">Careers</a>
<a href="${PLANSEE}/en/products/tungsten">Tungsten products</a></nav><ul>
${planseeCard('vdma-position-paper', 'Tungsten supply: Europe must act now', '15.10.2026')}
${planseeCard('plansee-shanghai-wins-deib-award-2026', 'Plansee Shanghai wins the DEIB Award', '17.09.2026')}
</ul></body></html>`;

test('Plansee article links are accepted through article_path, so the October story is collected with max_verify 0', async () => {
  const company = { target_no: 30, company: 'Plansee', query_aliases: [] };
  const [page] = realSources.official_pages.Plansee;
  const article = `${PLANSEE}/en/articles/detail/vdma-position-paper`;
  const handler = url => url === page.url ? html(PLANSEE_LISTING)
    : url === article ? html(articleHtml('Tungsten supply: Europe must act now',
      'Plansee Group joined the VDMA position paper calling for European tungsten supply security measures. ', '2026-10-15T13:08:02+02:00'))
      : null;
  const { result } = await withFetch(handler, () => collect(company, { official_pages: { Plansee: [page] } }, ['official_pages'],
    { maxVerifyPerCompany: 0 }));
  assert.deepEqual(result.errors, []);
  const rows = result.rows.filter(row => row.collector === 'official_page');
  assert.deepEqual(rows.map(row => [row.url, row.link_verdict, row.link_reason, row.title]),
    [[article, 'accept', 'configured_article_path', 'Tungsten supply: Europe must act now']]);
  assert.equal(rows[0].published_month, '2026-10');
  assert.equal(rows[0].content_fetch_status, 'fetched');
  // 설정이 없으면 지금처럼 확인 대상이라 확인 예산 0 에서 빠진다.
  const { article_path: _unused, ...plain } = page;
  const { result: before } = await withFetch(handler, () => collect(company, { official_pages: { Plansee: [plain] } }, ['official_pages'],
    { maxVerifyPerCompany: 0 }));
  assert.deepEqual(before.rows.filter(row => row.collector === 'official_page'), []);
});

test('article_path only promotes links the rules would verify; accepted and rejected links keep their verdict', () => {
  const page = { articlePath: new RegExp(realSources.official_pages.Plansee[0].article_path, 'i') };
  const anchor = url => ({ url, title: 'x', context: '' });
  const article = anchor(`${PLANSEE}/en/articles/detail/vdma-position-paper`);
  assert.deepEqual(configuredArticleVerdict({ verdict: 'fetch_to_verify', reason: 'unfamiliar_path', rank: 2 }, article, page),
    { verdict: 'accept', reason: 'configured_article_path', rank: 1 });
  const accepted = { verdict: 'accept', reason: 'article_link', rank: 0 };
  assert.equal(configuredArticleVerdict(accepted, article, page), accepted);
  const rejected = { verdict: 'hard_reject', reason: 'boilerplate_or_social' };
  assert.equal(configuredArticleVerdict(rejected, article, page), rejected);
  const elsewhere = { verdict: 'fetch_to_verify', reason: 'unfamiliar_path', rank: 2 };
  for (const url of [`${PLANSEE}/en/products/tungsten`, `${PLANSEE}/en/articles/detail/`, `${PLANSEE}/de/articles/detail/x`,
    `https://evil.example/en/articles/detail/x`])
    assert.equal(configuredArticleVerdict(elsewhere, anchor(url), page), elsewhere, url);
  assert.equal(configuredArticleVerdict(elsewhere, article, {}), elsewhere);
  for (const [name, pages] of Object.entries(realSources.official_pages))
    for (const entry of pages) if (entry.article_path) assert.doesNotThrow(() => new RegExp(entry.article_path, 'i'), name);
});

// --- 일-월 슬래시 날짜 ---------------------------------------------------------------------------------------

test('slash dates whose first number is above 12 are read day-first; others stay month-first', () => {
  assert.equal(extractDateFromText("CPHI & PMEC India 2025 Lire l'article 27/10/2025"), '2025-10-27T00:00:00Z');
  assert.equal(extractDateFromText('14/07/2025'), '2025-07-14T00:00:00Z');
  assert.equal(extractDateFromText('10/27/2025'), '2025-10-27T00:00:00Z');
  // 앞자리가 12 이하면 예전처럼 미국식이다(Texcell 의 "4/09/2025" 는 그래서 4월 9일로 읽힌다).
  assert.equal(extractDateFromText('05/10/2025'), '2025-05-10T00:00:00Z');
  assert.equal(extractDateFromText('31/02/2025'), null);
  assert.equal(extractDateFromText('32/10/2025'), null);
});

test('a day-first slash date never replaces a date the text already gave', () => {
  // 본문 머리에 월 이름 날짜(기사 날짜)와 표 안의 일-월 슬래시 날짜가 함께 있으면 예전처럼 월 이름 날짜다.
  assert.equal(extractDateFromText('Mainz, October 1, 2026. Dividend payable 15/11/2026.'), '2026-10-01T00:00:00Z');
  assert.equal(extractDateFromText('1 October 2026 - record date 15/11/2026'), '2026-10-01T00:00:00Z');
});

// --- 공식 호스트만 선언하는 항목(host_only) -------------------------------------------------------------------

test('a host_only page is never fetched but still declares the company\'s official host', async () => {
  const company = { target_no: 18, company: 'Qualcomm', query_aliases: [] };
  const pages = realSources.official_pages.Qualcomm;
  const declared = pages.filter(page => page.host_only);
  assert.deepEqual(declared.map(page => page.domain), ['www.qualcomm.com']);
  // AEM 껍데기(링크 0개)였던 www.qualcomm.com 목록은 더 받지 않는다. page_empty 로 기업이 매달 미완료가 되지 않는다.
  const { result, requested } = await withFetch(() => null,
    () => collect(company, { official_pages: { Qualcomm: declared } }, ['official_pages']));
  assert.deepEqual(requested, []);
  assert.deepEqual(result.errors, []);
  // qualcomm.com 은 그대로 공식 호스트다(AEM 모델과 Google 기사 제목 복구).
  const hosts = configuredOfficialHosts('Qualcomm', realSources);
  assert.ok(hosts.has('qualcomm.com'));
  assert.ok(hosts.has('investor.qualcomm.com'));
  assert.equal(pages.some(page => !page.host_only && /^https:\/\/www\.qualcomm\.com\//.test(page.url)), false);
  // Cytiva 뉴스 센터(자바스크립트 앱 껍데기, 링크 0개)는 뺐다. Danaher 목록과 피드로 읽는다.
  assert.equal(realSources.official_pages.Cytiva.some(page => /cytivalifesciences\.com/.test(page.url)), false);
});

// --- 6. AGC(Asahi Glass): 뉴스 목록 JSON ---------------------------------------------------------------------

test('a compact YYYYMMDD-HHMMSS JSON feed date is read as that day; other shapes keep the old handling', () => {
  // AGC news_all.json 의 date. 예전에는 날짜로도 글 속 날짜로도 읽히지 않아 그대로 남았다(날짜 미상).
  assert.equal(jsonFeedDate('20261028-100000'), '2026-10-28');
  assert.equal(jsonFeedDate('20261106-150000'), '2026-11-06');
  assert.equal(jsonFeedDate('20261015'), '2026-10-15');
  // 시각 자리가 여섯 자리가 아니거나 뒤에 글자가 붙으면 이 모양이 아니다.
  assert.equal(jsonFeedDate('20261028-1000'), '20261028-1000');
  assert.equal(jsonFeedDate('20261028-100000x'), '20261028-100000x');
});

const AGC = 'https://www.agc.com';
// news_all.json 은 최상위가 배열이다. type 이 inner 인 항목은 /en/news/detail/ 상세 페이지(서버가 그린 HTML)를 가리킨다.
const agcItem = (date, id, title, type = 'inner') => ({ date, path: type === 'pdf' ? `/en/news/pdf/${date.slice(0, 8)}e.pdf`
  : `/en/news/detail/${id}_2814.html`, type, pdf: `/en/news/pdf/${date.slice(0, 8)}e.pdf`, title, sort: '', flg_ir: 'T',
flg_csr: 'F', flg_show: 'F', tag: [{ tag01: '', tag02: '', tag03: '', tag04: '', tag05: '', tag06: 'R&D', tag07: '' }] });
const AGC_NEWS = [
  agcItem('20261106-150000', '1212604', 'AGC to Exhibit Materials Supporting a Hydrogen Society at the COP31 Japan Pavilion'),
  agcItem('20261028-100000', '1212518', 'Six Companies Launch Joint R&D to Build a Quantum-Computing-Based Materials Development Platform'),
  agcItem('20261006-100000', '1212354', 'AGC Biologics Awarded Multiple Cell Therapy Projects at Its Yokohama Site'),
  agcItem('20260918-150000', '1212254', 'SEMICON West 2026'),
];
const AGC_QUANTUM = `${AGC}/en/news/detail/1212518_2814.html`;
const AGC_BIOLOGICS = `${AGC}/en/news/detail/1212354_2814.html`;

test('AGC is read from its news JSON: October releases are dated official press releases with detail bodies', async () => {
  const company = { target_no: 67, company: 'Asahi Glass', query_aliases: ['AGC Inc', 'AGC'] };
  const feeds = realSources.official_feeds['Asahi Glass'];
  const [feed] = feeds;
  const details = {
    [AGC_QUANTUM]: articleHtml('Six Companies Launch Joint R&D to Build a Quantum-Computing-Based Materials Development Platform',
      'AGC and five companies began joint research on a quantum-computing-based materials development platform. '),
    [AGC_BIOLOGICS]: articleHtml('AGC Biologics Awarded Multiple Cell Therapy Projects at Its Yokohama Site',
      'AGC Biologics was awarded several cell therapy development projects at its Yokohama site. '),
  };
  const { result, requested } = await withFetch(url => url === feed.url ? json(AGC_NEWS) : details[url] ? html(details[url]) : null,
    () => collect(company, { official_feeds: { 'Asahi Glass': feeds } }, ['official_feeds']));
  assert.deepEqual(result.errors, []);
  const rows = result.rows.filter(row => row.source_type === 'official');
  assert.deepEqual(rows.map(row => [row.published_at, row.published_at_source, row.source_kind, row.url]).sort(), [
    ['2026-10-06T00:00:00Z', 'feed', 'press_release', AGC_BIOLOGICS],
    ['2026-10-28T00:00:00Z', 'feed', 'press_release', AGC_QUANTUM],
  ]);
  for (const row of rows) {
    assert.equal(row.content_fetch_status, 'fetched');
    assert.ok(row.content_text.length > 500);
  }
  // 11월·9월 항목은 기간 밖이라 상세 페이지를 받지 않는다. 메뉴뿐인 /en/news/ 목록도 더 받지 않는다.
  assert.deepEqual(requested.slice().sort(), [AGC_BIOLOGICS, AGC_QUANTUM, feed.url].sort());
});

test('AGC no longer reads the menu-only /en/news/ page, and agc.com stays its official host', () => {
  const [feed] = realSources.official_feeds['Asahi Glass'];
  assert.equal(feed.format, 'json');
  assert.equal(feed.json.items, undefined);
  assert.equal(new URL(feed.url).pathname, '/en/news/detail/news_all.json');
  assert.equal(realSources.official_pages['Asahi Glass'].some(page => /\/en\/news\/?$/.test(new URL(page.url).pathname)), false);
  assert.ok(configuredOfficialHosts('Asahi Glass', realSources).has('agc.com'));
});

// --- 7. Toray: 키가 필요한 CMS API 로만 그리는 뉴스룸 --------------------------------------------------------------

test('Toray no longer lists its script-drawn newsroom; its IR pages and official host remain', () => {
  // www.toray.com/news/ 와 기사 article.html?contentId= 는 HTML 에 기사가 없다(목록 링크 2개, 기사 본문 0자).
  // 둘 다 microCMS API(요청마다 API 키 머리글)에서 그린다. 수집기는 그 API 를 부르지 않는다.
  const pages = realSources.official_pages.Toray;
  assert.equal(pages.some(page => new URL(page.url).pathname.startsWith('/news')), false);
  assert.deepEqual(pages.map(page => new URL(page.url).pathname),
    ['/ir/', '/ir/annual_reports/', '/ir/library/', '/ir/library/lib_001.html']);
  assert.equal(realSources.official_feeds.Toray, undefined);
  assert.ok(configuredOfficialHosts('Toray', realSources).has('toray.com'));
});

// --- 8. maxon: 뉴스룸은 그대로, 안내서 PDF 목록은 빼고, 동명 대상을 가를 식별 정보 --------------------------------

test('maxon keeps its server-rendered newsroom and no longer reads the brochure-only Media Center', () => {
  // 2026-10 수집에서 maxon 의 공식 행 네 건은 모두 Media Center 의 날짜 없는 안내서 PDF 였다
  // ("company mediacenter business unit container ... download", 한 건은 document_too_large).
  const pages = realSources.official_pages.Maxon;
  assert.deepEqual(pages.map(page => [page.kind, page.url]),
    [['newsroom', 'https://www.maxongroup.com/en/news-and-events/news']]);
});

test('maxon has a target identity, so a maxon.net (Maxon software) article cannot approve the drive maker', () => {
  const maxon = realTechnology.companies.find(company => company.company === 'Maxon');
  const identity = maxon.target_identity;
  assert.equal(identity.legal_name, 'maxon international ag');
  assert.equal(identity.country, 'Switzerland');
  assert.deepEqual(identity.official_domains, ['maxongroup.com']);
  assert.deepEqual(identity.unrelated_domains, ['maxon.net']);
  // 검색어(query_aliases)는 그대로다. 식별 정보는 판정 모델과 승인 검사에만 간다.
  assert.deepEqual(maxon.query_aliases, ['maxon group']);
  const body = 'Maxon teased another AI tool for Cinema 4D artists, and the company said more details follow. '.repeat(5);
  const article = url => ({ target_identity: identity, url, content_source_url: url, evidence: [body],
    candidates: [{ id: 'relevant', kind: 'relevant', row: { content_text: body } }] });
  const decision = { candidate_id: 'relevant', entity_supported: true, target_technology_supported: false };
  // 동명 회사 자기 사이트의 기사에 정식명(maxon international ag)이 없으면 귀속을 인정하지 않는다.
  assert.equal(decisionForApproval(article('https://www.maxon.net/en/article/ai-tool'), [decision], decision).entity_supported, false);
  // maxon 자기 사이트와 제3자 매체의 기사는 모델 판단을 그대로 둔다.
  assert.equal(decisionForApproval(article('https://www.maxongroup.com/en/news-and-events/news/x-306082'), [decision], decision)
    .entity_supported, true);
  assert.equal(decisionForApproval(article('https://www.creativebloq.example/maxon-ai-tool'), [decision], decision)
    .entity_supported, true);
});
