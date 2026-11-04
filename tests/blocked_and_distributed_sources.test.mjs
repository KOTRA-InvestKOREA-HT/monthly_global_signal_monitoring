// 2026-10 수집(5호)의 출처 문제 네 가지를 네트워크 없이 다시 만든다.
// 1. airbus.com(Imperva)이 200 으로 차단 페이지를 돌려줘, 기사 5건이 그 한 줄을 본문으로 저장했고 사이트맵은 0건으로 끝났다.
// 2. 짧은 공식 페이지마다 .model.json 을 붙여, AEM 이 아닌 14개 기업에서 쓸모없는 요청 23건이 오류로 남았다.
// 3. syensqo.com 은 수집기에 403 이라, 같은 보도자료가 실리는 Press Release Finder 의 Syensqo 페이지를 읽는다.
// 4. sewpg.com 은 매달 헤더를 읽을 수 없어 실패해 설정에서 뺐다.
// 고정 자료는 실제 페이지의 구조만 흉내 낸 것이다. 원문을 옮긴 것이 아니다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { botChallengeError, createDomainGuard, detectBotChallenge, retryableCollection } from '../scripts/collection_resilience.mjs';
import { collectCompany, collectionBlockingErrors, companySourceConfig, enrichOfficialRowsWithContent, extractDateFromText,
  fetchPage, parseArgs, sitemapEntryCount } from '../scripts/collect_company_signals.mjs';
import { AEM_MODEL_HOSTS, configuredOfficialHosts, hasAemModel } from '../scripts/publisher_recovery.mjs';

const realSources = JSON.parse(fs.readFileSync(new URL('../config/company_sources.json', import.meta.url), 'utf8'));

// --- 차단 페이지 판별 ---------------------------------------------------------------------------------------

// airbus.com 이 2026-10 에 돌려준 응답의 모양(사건 번호·주소는 바꿨다).
const INCAPSULA_PAGE = '<html style="height:100%"><head><META NAME="ROBOTS" CONTENT="NOINDEX, NOFOLLOW">'
  + '<script type="text/javascript" src="/_Incapsula_Resource?SWJIYLWA=0000"></script></head><body style="margin:0px;height:100%">'
  + '<iframe id="main-iframe" src="/_Incapsula_Resource?SWUDNSAI=31&incident_id=1000-2000" frameborder=0 width="100%" height="100%">'
  + 'Request unsuccessful. Incapsula incident ID: 1000-2000</iframe></body></html>';
const AKAMAI_PAGE = '<HTML><HEAD>\n<TITLE>Access Denied</TITLE>\n</HEAD><BODY>\n<H1>Access Denied</H1>\n \n'
  + 'You don\'t have permission to access "http&#58;&#47;&#47;www&#46;example&#46;com&#47;news" on this server.<P>\n'
  + 'Reference&#32;&#35;18&#46;5e3c1302&#46;1700000000&#46;1a2b3c\n<P>https&#58;&#47;&#47;errors&#46;edgesuite&#46;net&#47;18</P>\n</BODY>\n</HTML>';
const CLOUDFLARE_PAGE = '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body>'
  + '<div class="main-wrapper"><noscript>Enable JavaScript and cookies to continue</noscript></div>'
  + '<script>(function(){window._cf_chl_opt={cvId:"3"};var a=document.createElement("script");'
  + 'a.src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1";document.head.appendChild(a);})();</script></body></html>';
const CLOUDFLARE_BLOCK = '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head>'
  + '<body><h1>Sorry, you have been blocked</h1><div id="cf-error-details">Cloudflare Ray ID: 8a1b</div></body></html>';

test('Incapsula, Akamai and Cloudflare block pages are recognised', () => {
  assert.equal(detectBotChallenge(INCAPSULA_PAGE), 'incapsula');
  // 본문 추출기를 거친 글(2026-10 Airbus 행의 content_text)도 차단 문구로 알아본다.
  assert.equal(detectBotChallenge('Request unsuccessful. Incapsula incident ID: 420000840022305398-68953642675475730'), 'incapsula');
  assert.equal(detectBotChallenge(AKAMAI_PAGE), 'akamai');
  assert.equal(detectBotChallenge(AKAMAI_PAGE.replace(/&#32;&#35;/, ' #').replace(/&#46;/g, '.')), 'akamai');
  assert.equal(detectBotChallenge(CLOUDFLARE_PAGE), 'cloudflare');
  assert.equal(detectBotChallenge(CLOUDFLARE_BLOCK), 'cloudflare');
});

test('ordinary articles that talk about blocking, access denied or Cloudflare are not block pages', () => {
  const article = (title, body) => `<html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${body}</p></article></body></html>`;
  const prose = [
    article('Court rules on access denied to plant records', 'The regulator said access denied to inspectors was unlawful. Reference # 12 of the ruling lists the plants.'),
    article('Imperva report: bot attacks rise', 'Imperva, which runs the Incapsula network, said request unsuccessful rates rose. The incident ID system was upgraded.'),
    article('Cloudflare expands in Korea', 'Cloudflare said "Just a moment..." challenge pages now load faster; Attention Required pages are rarer.'),
    // 제목이 "Access Denied" 인 실제 기사도 참조 번호가 없으면 차단 페이지가 아니다.
    article('Access Denied', 'A film review. The director said the reference was to the 1999 novel.'),
    // 제목이 "Just a moment..." 이어도 Cloudflare 확인 스크립트가 없으면 아니다.
    article('Just a moment...', 'A column about patience in supply-chain planning.'),
  ];
  for (const html of prose) assert.equal(detectBotChallenge(html), '', html.slice(0, 80));
  // Imperva 가 보호하는 사이트는 정상 페이지에도 자원 스크립트를 심는다. 짧은 정상 기사가 차단 페이지로 걸리면 안 된다.
  assert.equal(detectBotChallenge(article('Plant expansion', 'The company opened a new plant.')
    .replace('</body>', '<script type="text/javascript" src="/_Incapsula_Resource?SWJIYLWA=719d34d31c8e3a6e6fffd425f7e032f3&ns=1&cb=1"></script></body>')), '');
  assert.equal(detectBotChallenge(''), '');
  assert.equal(detectBotChallenge(undefined), '');
  // 긴 페이지는 차단 페이지가 아니다. 기사 안에 차단 페이지 예시가 인용돼도 걸리지 않는다.
  assert.equal(detectBotChallenge(`${'<p>Long article text about a plant expansion.</p>'.repeat(2000)}${INCAPSULA_PAGE}`), '');
});

test('a block page is a non-retryable error that never starts a transport cooldown, and stops further requests to that host', async () => {
  const guard = createDomainGuard({ challengeThreshold: 2 });
  let sent = 0;
  const blocked = () => guard.run('https://www.blocked.example/news', async () => { sent++; throw botChallengeError('incapsula'); });
  await assert.rejects(blocked(), /^Error: bot_challenge: incapsula$/);
  await assert.rejects(blocked(), /bot_challenge: incapsula/);
  // 두 번 연달아 막히면 이번 실행 동안 그 호스트에는 보내지 않는다. 오류는 domain_cooldown 이 아니라 bot_challenge 다.
  const skipped = await guard.run('https://www.blocked.example/other', async () => { sent++; return 'unexpected'; }).catch(error => error);
  assert.match(skipped.message, /^bot_challenge: incapsula \(skipped: www\.blocked\.example challenged earlier in this run\)$/);
  assert.equal(skipped.noRetry, true);
  assert.equal(sent, 2);
  assert.equal(guard.stats.bot_challenges, 2);
  assert.equal(guard.stats.challenge_skipped, 1);
  assert.equal(guard.stats.skipped, 0);
  // 다른 호스트는 그대로 받는다.
  assert.equal(await guard.run('https://www.open.example/news', async () => 'ok'), 'ok');
  // 차단 한 번 뒤 정상 응답이 오면 연속 횟수는 처음부터 센다.
  const flaky = createDomainGuard({ challengeThreshold: 2 });
  await assert.rejects(flaky.run('https://flaky.example/a', async () => { throw botChallengeError('cloudflare'); }));
  assert.equal(await flaky.run('https://flaky.example/b', async () => 'ok'), 'ok');
  await assert.rejects(flaky.run('https://flaky.example/c', async () => { throw botChallengeError('cloudflare'); }));
  assert.equal(await flaky.run('https://flaky.example/d', async () => 'still sent'), 'still sent');
});

test('a blocked official listing leaves the company incomplete but not retryable; a blocked detail page does neither', () => {
  const listing = { source: 'official_sitemaps', kind: 'sitemap', error: 'bot_challenge: incapsula' };
  const skipped = { source: 'official_pages', kind: 'newsroom', error: 'bot_challenge: incapsula (skipped: www.airbus.com challenged earlier in this run)' };
  const detail = { source: 'official_detail', error: 'bot_challenge: incapsula' };
  assert.equal(collectionBlockingErrors([listing]).length, 1);
  assert.equal(collectionBlockingErrors([skipped]).length, 1);
  assert.equal(collectionBlockingErrors([detail]).length, 0);
  // 같은 차단은 다음 실행에도 되풀이된다. 기업을 매번 처음부터 다시 받게 하지 않는다.
  assert.equal(retryableCollection({ errors: [listing, skipped, detail] }), false);
  assert.equal(retryableCollection({ errors: [{ source: 'official_sitemaps', error: 'sitemap_empty: no <url> or <sitemap> entries' }] }), false);
});

// --- 수집 경로 전체 ---------------------------------------------------------------------------------------

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

const html = body => new Response(body, { headers: { 'content-type': 'text/html' } });
const october = { mode: 'explicit', fromDate: '2026-10-01', toDate: '2026-10-31', from_date: '2026-10-01', to_date: '2026-10-31',
  fromMs: Date.parse('2026-10-01T00:00:00Z'), toMs: Date.parse('2026-10-31T23:59:59Z'), lookbackDays: 45 };
const args = { ...parseArgs([]), rateLimitSeconds: 0, timeoutSeconds: 5, fetchRetries: 0, maxPerSource: 6, maxPerCompany: 10,
  maxDetailPerCompany: 6 };
const trend = { technologyMap: { companies: [] }, keywordConfig: { groups: {} }, searchTerms: {} };
const always = (url, request) => request();

test('a block page served with HTTP 200 is an error for listings and sitemaps, not an empty page', async () => {
  // 호스트마다 수집기 전체가 domainGuard 를 함께 쓰므로 이 시험만의 호스트를 쓴다.
  const { result: page } = await withFetch(() => html(INCAPSULA_PAGE),
    () => fetchPage('https://listing-block.example/en/newsroom', 5).catch(error => error));
  assert.match(page.message, /^bot_challenge: incapsula$/);
  const company = { target_no: 9, company: 'Blocked Aero', query_aliases: [] };
  const sourceConfig = { official_sitemaps: { 'Blocked Aero': [
    { source: 'Blocked Aero - sitemap', kind: 'press_release', url: 'https://sitemap-block.example/sitemap.xml?page=1' },
    { source: 'Blocked Aero - sitemap', kind: 'press_release', url: 'https://sitemap-empty.example/sitemap.xml' },
  ] } };
  const { result } = await withFetch(url => url.startsWith('https://sitemap-block.example/') ? html(INCAPSULA_PAGE)
    : html('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>'),
  () => collectCompany(company, sourceConfig, ['official_sitemaps'], args, october,
    '2026-11-04T00:00:00Z', { probe: always, trend }));
  const errors = result.errors.filter(error => error.source === 'official_sitemaps').map(error => error.error);
  assert.deepEqual(errors, ['bot_challenge: incapsula', 'sitemap_empty: no <url> or <sitemap> entries']);
});

test('sitemap entries are counted before any include or date filter', () => {
  assert.equal(sitemapEntryCount('<urlset><url><loc>https://a.example/1</loc></url><url><loc>https://a.example/2</loc></url></urlset>'), 2);
  assert.equal(sitemapEntryCount('<sitemapindex><sitemap><loc>https://a.example/s1.xml</loc></sitemap></sitemapindex>'), 1);
  assert.equal(sitemapEntryCount('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>'), 0);
  assert.equal(sitemapEntryCount(INCAPSULA_PAGE), 0);
  assert.equal(sitemapEntryCount(''), 0);
});

const AIRBUS_URL = 'https://detail-block.example/en/newsroom/press-releases/2026-10-airbus-reports-nine-month-9m-2026-results';

test('a blocked detail page leaves the row without a body and asks for no AEM model', async () => {
  const row = { target_no: 9, company: 'Airbus', title: 'Airbus reports Nine-Month (9M) 2026 results', url: AIRBUS_URL,
    source: 'Airbus - Press release sitemap', source_type: 'official', collector: 'official_sitemap', link_verdict: 'accept', link_rank: 0 };
  const company = { target_no: 9, company: 'Airbus', query_aliases: [] };
  const { result, requested } = await withFetch(() => html(INCAPSULA_PAGE), () => enrichOfficialRowsWithContent([row],
    { ...args, fetchOfficialContent: true }, '2026-11-04T00:00:00Z', company, { officialHosts: new Set(['detail-block.example']) }));
  const [kept] = result.rows;
  assert.equal(kept.content_fetch_status, 'error');
  assert.equal(kept.content_text, undefined);
  assert.deepEqual(result.errors.map(error => [error.source, error.error]), [['official_detail', 'bot_challenge: incapsula']]);
  // 예전에는 차단 페이지 본문이 짧다고 .model.json 까지 받았다.
  assert.deepEqual(requested, [AIRBUS_URL]);
});

// --- AEM 모델은 AEM 호스트에서만 ---------------------------------------------------------------------------

test('only Qualcomm\'s AEM site is asked for a .model.json', () => {
  assert.deepEqual([...AEM_MODEL_HOSTS], ['qualcomm.com']);
  assert.equal(hasAemModel('https://www.qualcomm.com/news/releases/2026/09/qualcomm-announces-renewal'), true);
  assert.equal(hasAemModel('https://qualcomm.com/news/releases/2026/09/a'), true);
  // Q4 IR 플랫폼은 AEM 이 아니다.
  assert.equal(hasAemModel('https://investor.qualcomm.com/news-events/press-releases/news-details/2026/x/default.aspx'), false);
  // 2026-10 에 .model.json 을 받아 404·403·차단 페이지로 끝난 공식 호스트들.
  for (const url of ['https://www.albemarle.com/us/en/newsroom/latest-stories', 'https://www.veolia.com/en/veolia-group/finance/press-releases/x',
    'https://investors.airproducts.com/news-releases/news-release-details/x', 'https://www.airbus.com/en/newsroom/press-releases/2026-10-x',
    'https://www.jsr.co.jp/jsr_e/news', 'https://www.qualcomm.com.evil.example/news'])
    assert.equal(hasAemModel(url), false, url);
});

test('a short page on a non-AEM official host is kept as it is, without a model request', async () => {
  const url = 'https://www.hydro-like.example/en/global/media/news/2026/norsk-plant-update';
  const title = 'Hydro announces update on its Norwegian plant';
  const shell = `<html><head><meta property="og:title" content="${title}"></head><body><main><h1>${title}</h1></main></body></html>`;
  const row = { target_no: 3, company: 'Norsk Hydro', title, url, source: 'Hydro newsroom', source_type: 'official',
    collector: 'official_page', link_verdict: 'accept', link_rank: 0 };
  const company = { target_no: 3, company: 'Norsk Hydro', query_aliases: [] };
  const { result, requested } = await withFetch(target => target === url ? html(shell) : null, () => enrichOfficialRowsWithContent([row],
    { ...args, fetchOfficialContent: true }, '2026-11-04T00:00:00Z', company, { officialHosts: new Set(['hydro-like.example']) }));
  assert.deepEqual(requested, [url]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].content_fetch_status, 'fetched');
});

// --- Syensqo: Press Release Finder ---------------------------------------------------------------------------

const PRF = 'https://www.pressreleasefinder.com';
// Press Release Finder 회사 페이지의 구조: 항목마다 <p class=dateline> 날짜, <h3 class='headline'> 제목 링크, 요약,
// 언어 단추. 옆 칸에는 다른 회사 페이지 링크가, 아래에는 다음 쪽 링크가 있다. 날짜는 "24 Sept 2026" 처럼도 쓴다.
const prfItem = (date, id, title, langs = ['de']) => `<div class='col-xs-12 col-md-6'>
<p class=dateline>${date}</p>
<h3 class='headline'><a href='/Syensqo/${id}/en/'>${title}</a></h3>
<p><img class='thumbnail img-responsive' src='${PRF}/primages/2026/med/${id}a.jpg' alt='${title}. (Photo: Syensqo, ${id})'>
${'Syensqo, a global leader in high-performance materials, said the new product line will be produced in Europe. '.repeat(3)}</p>
<div class='langbtn'>
<a href='/Syensqo/${id}/en/' class='btn btn-xs btn-orange'>English</a> ${langs.map(lang => `<a href='/Syensqo/${id}/${lang}/' class='btn btn-xs btn-orange'>Deutsch</a>`).join(' ')}</div></div>`;
const PRF_LISTING = `<html><head><title>Syensqo - Press Release Finder</title></head><body>
<nav><a href='/'>Home</a> <a href='/about.asp'>About</a> <a href='/login.asp'>Login</a></nav>
<div class='well'><h1 class='boxed'>Syensqo</h1><address><a href='https://www.syensqo.com/en/'>www.syensqo.com/en/</a>
<a href='https://www.linkedin.com/company/syensqo/'>syensqo/</a></address></div>
${prfItem('29 Oct 2026', 'SQOPR140', 'Syensqo materials help advance medical technologies from heart surgery to implants')}
${prfItem('8 Oct 2026', 'SQOPR135', 'Syensqo expands its portfolio of certified circular specialty materials')}
${prfItem('24 Sept 2026', 'SQOPR133', 'Syensqo showcases advanced materials for every processing route at Fakuma 2026')}
<div class='col-md-3'><h4>Other companies</h4><ul>
<li><a href='/TotalEnergies/'>TotalEnergies</a></li><li><a href='/Clariant/'>Clariant</a></li>
<li><a href='/Clariant/CLAPR301/en/'>Clariant opens a new catalyst plant in China in 2026</a> 27 Oct 2026</li></ul></div>
<a href='/Syensqo/?pg=2&fdate=1784207400&fid=13847'>2</a>
</body></html>`;
const prfDetail = (title, dateText, isoDate) => `<html><head><title>${title}</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"${title}","datePublished":"${isoDate}"}</script>
</head><body><div class='container'><h1>${title}</h1>
<p>Brussels, ${dateText} - ${'Syensqo, a leading global provider of high-performance materials and chemical solutions, announced the expansion. '.repeat(8)}</p>
<p>Media contacts: press@example.org</p></div></body></html>`;

test('the Syensqo page on Press Release Finder yields its own October releases as official, dated, bodied rows', async () => {
  const company = { target_no: 47, company: 'Syensqo', query_aliases: [] };
  const sourceConfig = { official_pages: { Syensqo: [realSources.official_pages.Syensqo[0]] } };
  const details = {
    [`${PRF}/Syensqo/SQOPR140/en/`]: prfDetail('Syensqo materials help advance medical technologies from heart surgery to implants', 'October 29, 2026', '2026-10-29'),
    [`${PRF}/Syensqo/SQOPR135/en/`]: prfDetail('Syensqo expands its portfolio of certified circular specialty materials', 'October 8, 2026', '2026-10-08'),
  };
  const { result, requested } = await withFetch(url => url === `${PRF}/Syensqo/` ? html(PRF_LISTING)
    : details[url] ? html(details[url]) : null,
  () => collectCompany(company, sourceConfig, ['official_pages'], args, october,
    '2026-11-04T00:00:00Z', { probe: always, trend }));
  const rows = result.rows.filter(row => row.collector === 'official_page');
  assert.deepEqual(rows.map(row => row.url).sort(), Object.keys(details).sort());
  for (const row of rows) {
    assert.equal(row.source_type, 'official');
    assert.equal(row.source_kind, 'press_release');
    assert.equal(row.link_verdict, 'accept');
    assert.equal(row.content_fetch_status, 'fetched');
    assert.ok(row.content_text.length > 500);
    assert.match(row.published_at, /^2026-10-(29|08)/);
  }
  // 9월 항목("24 Sept 2026")은 기간 밖으로 빠지고, 다른 회사·언어 단추·다음 쪽 링크는 받지 않는다.
  assert.equal(requested.some(url => /SQOPR133|Clariant|TotalEnergies|\/de\/|pg=2/.test(url)), false, requested.join('\n'));
  assert.deepEqual(result.errors, []);
});

test('"Sept" is read as September, as Press Release Finder writes it', () => {
  assert.equal(String(extractDateFromText('24 Sept 2026')).slice(0, 10), '2026-09-24');
  assert.equal(String(extractDateFromText('Sept. 24, 2026')).slice(0, 10), '2026-09-24');
  assert.equal(String(extractDateFromText('29 Oct 2026')).slice(0, 10), '2026-10-29');
});

// --- 설정과 수집 식별자 -------------------------------------------------------------------------------------

test('Press Release Finder is official for Syensqo only, and only under /Syensqo/', () => {
  const [entry] = realSources.official_pages.Syensqo;
  assert.equal(entry.url, `${PRF}/Syensqo/`);
  const include = new RegExp(entry.include, 'i');
  assert.equal(include.test(`${PRF}/Syensqo/SQOPR140/en/`), true);
  for (const url of [`${PRF}/Syensqo/SQOPR140/de/`, `${PRF}/Clariant/CLAPR301/en/`, `${PRF}/Syensqo/`, `${PRF}/Syensqo/?pg=2`,
    'https://evil.example/Syensqo/SQOPR140/en/'])
    assert.equal(include.test(url), false, url);
  // syensqo.com 항목은 남긴다(막힘이 풀리면 다시 읽는다).
  assert.ok(realSources.official_pages.Syensqo.some(page => page.domain === 'www.syensqo.com'));
  assert.ok(realSources.official_feeds.Syensqo.some(feed => /syensqo\.com\/rss\.xml$/.test(feed.url)));
  assert.equal(configuredOfficialHosts('Syensqo', realSources).has('pressreleasefinder.com'), true);
  for (const [name, pages] of Object.entries(realSources.official_pages)) {
    if (name !== 'Syensqo') assert.equal(configuredOfficialHosts(name, realSources).has('pressreleasefinder.com'), false, name);
    for (const page of pages) if (page.include) assert.doesNotThrow(() => new RegExp(page.include, 'i'), name);
  }
});

test('sewpg.com is no longer read; the AEM host list adds no source-config key', () => {
  const sewpg = realSources.official_pages['Shanghai Electric Wind Power'];
  assert.ok(sewpg.length > 0);
  assert.equal(sewpg.some(page => /sewpg\.com/.test(`${page.url} ${page.domain}`)), false);
  // AEM 호스트 목록은 코드에 둔다. 출처 설정 최상위 키가 늘면 77개 기업의 수집 식별자가 모두 바뀐다.
  assert.deepEqual(Object.keys(realSources), ['description', 'official_feeds', 'official_pages', 'sec_filers', 'official_sitemaps',
    'external_news_title_names', 'external_news_same_name_exclusions', 'external_news_unreadable_outlets']);
  // Press Release Finder 설정은 Syensqo 몫에만 실린다. 다른 기업의 식별자에는 들어가지 않는다.
  const slice = name => JSON.stringify(companySourceConfig(realSources, { company: name }).official_pages);
  assert.match(slice('Syensqo'), /pressreleasefinder/);
  assert.doesNotMatch(slice('Airbus'), /pressreleasefinder/);
  assert.doesNotMatch(slice('Qualcomm'), /pressreleasefinder/);
});
