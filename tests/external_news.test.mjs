// 외부 기사를 늘 본다(2026-10-23 사용자 결정). 공식 기사가 기업 자리를 다 채워도 외부 기사 몇 건은 상한 밖에
// 덧붙고, 한국 관련 검색 결과도 덧붙는다. 주가 해설은 자리를 받기 전에 빠진다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKoreaQuery, collectCompany, companySourceConfig, copiesOfficialRow, exportExternalFilter, externalNoiseReason,
  marketResearchPromo, orderExternalRows, parseArgs, routineNotice, screenExternalRows, stockCommentary, titleNamesCompany,
  titleNamesCompanyExpanded, titleWordOverlap, unreadableOutlet } from '../scripts/collect_company_signals.mjs';
import fs from 'node:fs';
import { collectionInputDigest, createStepLog } from '../scripts/collection_resilience.mjs';
import { newsDigestInputs } from '../scripts/collection_args.mjs';

test('stock commentary is dropped, business news from the same outlets is kept', () => {
  const dropped = [
    { title: 'Bank of America Makes New $10.93 Million Investment in Acme Inc. $ACME', publisher: 'MarketBeat' },
    { title: 'West Pharmaceutical stock gains as Morgan Stanley turns bullish', publisher: 'ad-hoc-news.de' },
    { title: 'BE Semiconductor Industries (ENXTAM:BESI) Stock Looks Pricey Even With Strong Cash Flow Hopes', publisher: 'Yahoo Finance' },
    { title: 'Is Umicore (ENXTBR:UMI) Still Undervalued After A 61% Gain?', publisher: 'Yahoo Finance' },
    { title: 'Why Is Merck (MRK) Up 18.2% Since Last Earnings Report?', publisher: 'Yahoo Finance' },
    // 9월 수집(실행 147)에서 승인까지 갔던 두 건
    { title: 'Infineon Trims Memory Unit and Adds Radar, Server Power in Twin Bet on Growth', publisher: 'AD HOC NEWS' },
    { title: 'Albemarle vs. Rio Tinto: Which Lithium Stock Holds More Promise? - The Globe and Mail', publisher: 'The Globe and Mail' },
  ];
  const kept = [
    { title: 'Valens Semiconductor and onsemi Partner to Develop Integrated 3MP Automotive Camera Sensor', publisher: 'Yahoo Finance' },
    { title: 'Aeluma Shares Rise 7% After Sumitomo Chemical Photonics Manufacturing Agreement', publisher: 'Yahoo Finance' },
    { title: 'ABL Texcell Diagnostics Announces Proposed Acquisition Of Vela Diagnostics', publisher: 'TradingView' },
    { title: 'Amkor considers expanding Gwangju plant in Korea', publisher: 'The Korea Herald' },
    { title: 'Moderna opens mRNA plant (EUV-free) in Australia', publisher: 'BioSpace' },
  ];
  for (const row of dropped) assert.equal(stockCommentary(row), true, row.title);
  for (const row of kept) assert.equal(stockCommentary(row), false, row.title);
});

test('the Korea query searches the company name with Korea over the report period', () => {
  // 이름이 본문에만 있는 기사는 받지 않는다. 9월에 Dupont 으로 부고가, Maxon 으로 정치 기사가 들어왔다.
  assert.equal(titleNamesCompany('onsemi Charts Path to Power the Next Decade', ['Onsemi']), true);
  assert.equal(titleNamesCompany('Merck Korea Launches Campaign', ['Merck']), true);
  assert.equal(titleNamesCompany('Gerald Wibbels Obituary - Broken Bow, NE', ['Dupont']), false);
  assert.equal(titleNamesCompany('Toppan opens new BOPP film line', ['Toppan Holdings']), false);
  const dateRange = { mode: 'explicit', fromDate: '2026-09-01', toDate: '2026-09-30' };
  assert.equal(buildKoreaQuery({ company: 'Amkor Technology', query_aliases: [] }, dateRange),
    '"Amkor Technology" (Korea OR Korean) after:2026-09-01 before:2026-10-01');
});

const company = { target_no: 1, company: 'Acme Widgets', query_aliases: [] };
const sourceConfig = { official_feeds: { 'Acme Widgets': [{ url: 'https://acme.example/rss', source: 'Acme newsroom' }] } };
const trend = { technologyMap: null, keywordConfig: null, searchTerms: {} };
const dateRange = { mode: 'explicit', fromDate: '2026-09-01', toDate: '2026-09-30', from_date: '2026-09-01',
  to_date: '2026-09-30', fromMs: Date.parse('2026-09-01T00:00:00Z'), toMs: Date.parse('2026-09-30T23:59:59Z'), lookbackDays: 45 };
const collectedAt = '2026-10-01T05:00:00Z';
const body = (title, day) => `<html><head><title>${title}</title></head><body><article><h1>${title}</h1>
  <p>September ${day}, 2026 - ${title}. ${'Acme Widgets reported progress on the project with customers and partners. '.repeat(12)}</p>
  </article></body></html>`;
const rss = items => `<rss><channel>${items.map(([title, url, day, publisher]) => `<item><title>${title}</title>
  <link>${url}</link><pubDate>${day} Sep 2026 09:00:00 GMT</pubDate>
  ${publisher ? `<source url="https://${publisher}">${publisher}</source>` : ''}</item>`).join('')}</channel></rss>`;
// 공식 기사가 기업 자리를 다 채운다(피드 상한 6건, 아래 시험의 maxPerCompany 6).
const official = Array.from({ length: 6 }, (_, i) => [`Acme Widgets opens production line number ${i + 1} in Ohio`,
  `https://acme.example/news/a${i + 1}`, 2 + i]);
const external = [
  ['Bank of America Makes New Investment in Acme Widgets Inc. $ACME', 'https://news.google.com/rss/articles/CBMiM1', 12, 'MarketBeat'],
  ...[1, 2, 3, 4].map(n => [`Acme Widgets wins supply contract number ${n} from carmaker`,
    `https://news.google.com/rss/articles/CBMiG${n}`, 12 + n, `outlet${n}.example`]),
];
const korea = [1, 2, 3].map(n => [`Acme Widgets plans Korean plant expansion phase ${n}`,
  `https://news.google.com/rss/articles/CBMiK${n}`, 20 + n, `korea${n}.example`]);
// 잡음 규칙 시험용 외부 기사. 정례 공지, 공식 보도자료 사본, 이름 없는 제목, 본문을 주지 않는 매체가 섞여 있다.
const noisy = [
  ['Acme Widgets to Report Third Quarter 2026 Results on October 30', 'https://news.google.com/rss/articles/CBMiN1', 10, 'wire1.example'],
  ['Carmaker picks a new widget supplier for its Ohio plant', 'https://news.google.com/rss/articles/CBMiN2', 11, 'autos.example'],
  ['Acme Widgets opens production line number 1 in Ohio - Wire Service', 'https://news.google.com/rss/articles/CBMiN3', 12, 'wire2.example'],
  ['Acme Widgets wins defence contract - Reuters', 'https://news.google.com/rss/articles/CBMiN4', 13, 'Reuters'],
  ['Acme Widgets signs battery supply deal with carmaker', 'https://news.google.com/rss/articles/CBMiN5', 14, 'outlet5.example'],
  ['Acme Widgets adds second shift at Texas plant', 'https://news.google.com/rss/articles/CBMiN6', 15, 'outlet6.example'],
];
const stories = Object.fromEntries([...external, ...korea, ...noisy].map(([title, url, day, publisher]) =>
  [url.split('CBMi')[1], { title, day, home: `https://${publisher.toLowerCase()}/story-${url.split('CBMi')[1]}` }]));

async function withNetwork(task, externalItems = external) {
  const realFetch = globalThis.fetch;
  const searches = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url === 'https://acme.example/rss') return new Response(rss(official));
    const own = official.find(([, link]) => link === url);
    if (own) return new Response(body(own[0], own[2]));
    if (url.startsWith('https://news.google.com/rss/search')) {
      const query = new URL(url).searchParams.get('q');
      searches.push(query);
      if (query.includes('investor')) return new Response(rss(externalItems));
      if (query.includes('Korea')) return new Response(rss(korea));
      return new Response(rss([]));
    }
    if (/\/articles\/CBMi\w+$/.test(url)) return new Response('<div data-n-a-sg="SIG" data-n-a-ts="1759000000"></div>');
    if (url.endsWith('/batchexecute')) {
      const id = decodeURIComponent(init.body).match(/CBMi(\w\d)/)[1];
      return new Response(")]}'\n\n" + JSON.stringify([['wrb.fr', 'Fbv4je', JSON.stringify(['garturlres', stories[id].home, 1])]]));
    }
    const story = Object.values(stories).find(item => item.home === url);
    if (story) return new Response(body(story.title, story.day));
    return new Response('not found', { status: 404 });
  };
  try { return { result: await task(), searches }; } finally { globalThis.fetch = realFetch; }
}

const run = overrides => withNetwork(() => collectCompany(company, sourceConfig, ['official_feeds', 'google_news'],
  { ...parseArgs([]), rateLimitSeconds: 0, timeoutSeconds: 5, ...overrides }, dateRange, collectedAt,
  { probe: (url, request) => request(), log: createStepLog(), trend }));

test('with a full company quota, external and Korea news are still added after the cap', async () => {
  const { result, searches } = await run({ maxPerCompany: 6 });
  const titles = collector => result.rows.filter(row => row.collector === collector).map(row => row.title);
  assert.equal(result.rows.filter(row => row.source_type === 'official').length, 6);
  // MarketBeat 은 자리를 받기 전에 빠지고, 다음 세 건이 상한 밖에 붙는다.
  assert.deepEqual(titles('google_news_rss'), [1, 2, 3].map(n => `Acme Widgets wins supply contract number ${n} from carmaker`));
  assert.deepEqual(titles('google_news_korea'), [1, 2].map(n => `Acme Widgets plans Korean plant expansion phase ${n}`));
  assert.ok(result.rows.filter(row => row.collector === 'google_news_korea').every(row => row.korea_discovery));
  assert.equal(result.stats.fallback_reserved, 3);
  assert.equal(result.stats.korea_news_kept, 2);
  assert.equal(searches.length, 2);
});

test('the old missing mode skips the general search when the company has its own monthly news', async () => {
  const { result, searches } = await run({ fallbackMode: 'missing', maxKoreaNews: 0 });
  assert.equal(result.rows.filter(row => row.source_type !== 'official').length, 0);
  assert.equal(result.stats.fallback, 'skipped_has_monthly_source');
  assert.deepEqual(searches, []);
});

// 외부 기사 설정은 수집본 재사용 판단(collection_input_digest)에 들어간다. 빠지면 설정을 바꿔도 하루 안에 받은
// 수집본을 운영 판정이 그대로 다시 써서 바뀐 설정이 돌지 않는다.
test('the external news settings are part of the collection input digest', () => {
  const news = newsDigestInputs();
  assert.deepEqual(news, { fallbackMode: 'always', maxExternalNews: 3, maxKoreaNews: 2 });
  assert.deepEqual(newsDigestInputs(parseArgs([])), news);
  const digest = collectionInputDigest([{ company: 'A' }], {}, null, news);
  assert.notEqual(digest, collectionInputDigest([{ company: 'A' }], {}, null));
  assert.notEqual(digest, collectionInputDigest([{ company: 'A' }], {}, null, { ...news, maxKoreaNews: 0 }));
  assert.match(fs.readFileSync('scripts/review_report.mjs', 'utf8'), /newsDigestInputs\(\)\)/);
});

// ---- 외부 기사 잡음 줄이기(2026-11). 8~10월 수집을 되짚어 정한 규칙이다. 실제 설정 파일로 시험한다.
const realSources = JSON.parse(fs.readFileSync('config/company_sources.json', 'utf8'));
const targets = JSON.parse(fs.readFileSync('data/target_companies.json', 'utf8'));
const target = name => targets.find(item => item.company === name);
const ext = (title, extra = {}) => ({ title, source_type: 'fallback', ...extra });
const reason = (name, title, extra) => externalNoiseReason(ext(title, extra), target(name), realSources);

test('routine notices are dropped from external news, business and results news is kept', () => {
  const dropped = [
    'Dow Inc. (DOW) Earnings Preview: What to Expect - Nasdaq',
    'Dow to report third-quarter 2026 results on October 23 - Yahoo Finance',
    'Amkor Technology Sets Date for Third Quarter 2026 Earnings Release and Conference Call - Business Wire',
    'Ouster to Host Third Quarter 2026 Earnings Conference Call - GlobeNewswire',
    'Applied Materials Q3 2026 Earnings Call Transcript - Seeking Alpha',
    'Corning to Present at the Citi Global Technology Conference - Business Wire',
    '3M Declares Fourth-Quarter Dividend - 3M News Center',
    'Besi: Transparency notification by BlackRock - GlobeNewswire',
    'Umicore: Disclosure of transactions in own shares - GlobeNewswire',
    'Week Ahead: Earnings from ASML, Nokia and Volvo - Reuters',
  ];
  for (const title of dropped) assert.equal(routineNotice(ext(title)), true, title);
  const kept = [
    '3M Q3 Earnings Call Highlights - Yahoo Finance',
    '[FY2026 Q2 Earnings Call] Shin-Etsu Chemical Posts Record Q2 Operating Profit - Investing.com',
    'Aeluma Shares Rise 7% After Sumitomo Chemical Photonics Manufacturing Agreement - Yahoo Finance',
    'Dow reports third quarter 2026 results - Business Wire',
  ];
  for (const title of kept) assert.equal(routineNotice(ext(title)), false, title);
});

test('market research releases are dropped, IndexBox news and market-share stories are kept', () => {
  assert.equal(marketResearchPromo(ext('Semiconductor Thermal Management Materials Market to Reach USD 9 Bn - openPR.com')), true);
  assert.equal(marketResearchPromo(ext('Lidar Market Size, Share & Growth Report 2034 - Fortune Business Insights')), true);
  assert.equal(marketResearchPromo(ext('Polyurethane market expands at 6.1% CAGR through 2033 - EIN Presswire')), true);
  assert.equal(marketResearchPromo(ext('Rare Earth Magnet Market Outlook', { publisher: 'SNS Insider' })), true);
  assert.equal(marketResearchPromo(ext('Rio Tinto to Expand Aluminium Smelter in Canada - IndexBox')), false);
  assert.equal(marketResearchPromo(ext('HyProMag USA Plans Magnet Recycling Plant in Texas - IndexBox')), false);
  assert.equal(marketResearchPromo(ext("Samsung's HBM Market Share Jumps on Nvidia Orders - BusinessKorea")), false);
  // 사업동향 탐색 행에도 같은 규칙이 닿는다.
  assert.equal(reason('DOW', 'Semiconductor Thermal Management Materials Market to Reach - openPR.com',
    { collector: 'google_news_trend', trend_discovery: true }), 'market_research');
});

test('same-name collisions are dropped per company, the company news is kept', () => {
  const dropped = [
    ['Safran', 'Peter Safran says DC Studios slate is on track - Variety'],
    ['EVG', 'Evion Group (ASX:EVG) completes Maniry graphite study - Proactive'],
    ['DNP', 'DNP Select Income Fund declares monthly distribution - Business Wire'],
    ['Albemarle', 'Albemarle County Supervisors approve housing plan - Daily Progress'],
    ['Dupont', 'Pierre Dupont named head of French rail - Le Monde'],
    ['Dupont', 'Dupont Circle cafe reopens - Washingtonian'],
    ['Dupont', 'duPont REGISTRY lists rare car - Robb Report'],
    ['JSR', 'JSR registry adds Deno packages - InfoWorld'],
    ['Ouster', "Board weighs CEO's ouster after vote - CNBC"],
    ['Maxon', 'Maxon One adds ZBrush features - CG Channel'],
    ['DOW', 'Dow Jones futures rise as earnings roll in - IBD'],
    ['DOW', 'The Dow closes higher on Fed hopes - CNN'],
    ['Bayer', 'Bayer Leverkusen beat Bayern in Bundesliga - ESPN'],
    ['Toray', 'Toray Pan Pacific Open: top seed advances - WTA'],
    ['Merck', 'Merck & Co. wins Keytruda approval - Fierce Pharma'],
    ['Corning', 'Jane Doe Obituary - Corning, NY - Legacy'],
    ['Hexagon AB', 'Hexagon Purus wins hydrogen tank order - Electrive'],
  ];
  for (const [name, title] of dropped) assert.equal(reason(name, title), 'same_name', `${name}: ${title}`);
  const kept = [
    ['EVG', 'EVG Supports CPO Production with New Bonding Platform - Semiconductor Digest'],
    ['JSR', "JSR Opens EUV MOR Plant in South Korea's Ochang - BusinessKorea"],
    ['Dupont', 'DuPont completes Qnity electronics spin-off - Reuters'],
    ['DOW', 'Dow to build new silicone plant in Germany - Chemical Week'],
    ['Ouster', 'Ouster acquires StereoLabs to expand into vision - Business Wire'],
    ['Merck', 'Merck KGaA opens semiconductor materials site in Korea - Korea Herald'],
  ];
  for (const [name, title] of kept) assert.equal(reason(name, title), '', `${name}: ${title}`);
});

test('official rows are never dropped by the external title rules', () => {
  const official = (title) => ({ title, source_type: 'official' });
  for (const [name, title] of [['DOW', 'dow reports third quarter 2026 results'], ['DOW', 'dow to report third quarter 2026 results'],
    ['Ouster', 'ouster acquires stereolabs to expand into vision'], ['Dupont', 'dupont completes qnity spin off'],
    ['DOW', 'global polyurethane market size to reach usd 120 bn by 2034']]) {
    assert.equal(externalNoiseReason(official(title), target(name), realSources), '', title);
  }
});

test('the expanded name list finds short and parent names, short capitals only in capitals', () => {
  assert.equal(titleNamesCompany('Amkor considers expanding Gwangju plant', ['Amkor Technology']), false);
  assert.equal(titleNamesCompanyExpanded('Amkor considers expanding Gwangju plant', target('Amkor Technology'), realSources), true);
  assert.equal(titleNamesCompanyExpanded('Prodrive opens Eindhoven factory', target('Prodrive'), realSources), true);
  assert.equal(titleNamesCompanyExpanded('Siemens Energy wins Korean grid order', target('Siemens-Gamesa'), realSources), true);
  assert.equal(titleNamesCompanyExpanded('TEL expands Korea service centre', target('Tokyo Electron'), realSources), true);
  assert.equal(titleNamesCompanyExpanded('Tel Aviv startup raises chip funds', target('Tokyo Electron'), realSources), false);
  // 예전 검색 이름으로 통과하던 제목은 그대로 통과한다.
  assert.equal(titleNamesCompanyExpanded('Tokyo Electron Korea opens office', target('Tokyo Electron'), realSources), true);
});

test('external rows are ordered named and readable first before the cap', () => {
  const amkor = target('Amkor Technology');
  const rows = [
    ext('Chipmakers race to add packaging capacity - Nikkei'),
    ext('Amkor wins Apple packaging order - Reuters'),
    ext('Amkor expands Arizona campus - Construction Review'),
  ];
  assert.equal(unreadableOutlet(rows[1], realSources), true);
  assert.deepEqual(orderExternalRows(rows, amkor, realSources).map(row => row.title),
    [rows[2].title, rows[1].title, rows[0].title]);
});

test('an external copy of an official release with a body is dropped, other news is kept', () => {
  const official = { source_type: 'official', title: 'Amkor Technology Announces Phase 2 of Arizona Advanced Packaging and Test Campus',
    content_text: 'Amkor Technology announced phase 2 of its Arizona campus. '.repeat(20) };
  const copy = ext('Amkor Technology Announces Phase 2 of Arizona Advanced Packaging and Test Campus; Expands Investment - Yahoo Finance');
  const other = ext('Amkor considers expanding Gwangju plant in Korea - Korea Herald');
  assert.ok(titleWordOverlap(copy.title, official.title) >= 0.5);
  assert.equal(copiesOfficialRow(copy, [official]), true);
  assert.equal(copiesOfficialRow(other, [official]), false);
  // 본문이 없는 공식 행이면 외부 사본이 유일한 본문이라 남긴다.
  assert.equal(copiesOfficialRow(copy, [{ ...official, content_text: '' }]), false);
  const screened = screenExternalRows([copy, other], target('Amkor Technology'), realSources, [official]);
  assert.deepEqual(screened.rows, [other]);
  assert.deepEqual(screened.dropped, { official_copy: 1 });
});

test('the export re-filter applies the noise rules to rows from old checkpoints', () => {
  const official = { company: 'DOW', source_type: 'official', title: 'dow to report third quarter 2026 results', url: 'https://dow.example/1' };
  const rows = [official,
    { company: 'DOW', source_type: 'fallback', title: 'Dow Jones futures fall - IBD', url: 'u1' },
    { company: 'DOW', source_type: 'fallback', title: 'Dow to build silicone plant - Chemical Week', url: 'u2' },
    { company: 'DOW', source_type: 'fallback', title: 'Dow Inc. Earnings Preview: What to Expect - Nasdaq', url: 'u3' }];
  const result = exportExternalFilter(rows, [target('DOW')], realSources);
  assert.deepEqual(result.rows.map(row => row.url), ['https://dow.example/1', 'u2']);
  assert.deepEqual(result.noiseDropped, { same_name: 1, routine_notice: 1 });
});

test('the noise lists enter the collection identity, each company carries only its own entries', () => {
  const dow = companySourceConfig(realSources, target('DOW'));
  assert.equal(dow.external_news_same_name_exclusions.case_sensitive, true);
  assert.equal(dow.external_news_title_names, null);
  assert.deepEqual(dow.external_news_unreadable_outlets, realSources.external_news_unreadable_outlets);
  for (const key of ['external_news_title_names', 'external_news_same_name_exclusions']) {
    for (const name of Object.keys(realSources[key])) assert.ok(target(name), `${key}: ${name} is not a listed company`);
  }
});

const runNoisy = (sources, overrides) => withNetwork(() => collectCompany(company, sources, ['official_feeds', 'google_news'],
  { ...parseArgs([]), rateLimitSeconds: 0, timeoutSeconds: 5, maxPerCompany: 6, maxKoreaNews: 0, ...overrides },
  dateRange, collectedAt, { probe: (url, request) => request(), log: createStepLog(), trend }), noisy);

test('the fallback search drops noise before the per-source cap so the freed slots are reused', async () => {
  const { result } = await runNoisy(sourceConfig, { maxPerSource: 3 });
  const titles = result.rows.filter(row => row.collector === 'google_news_rss').map(row => row.title);
  // 정례 공지와 공식 사본이 빠지고, 이름이 있는 기사 세 건이 상한(3) 안에 든다. 이름 없는 제목은 밀려난다.
  assert.deepEqual(titles, ['Acme Widgets wins defence contract - Reuters',
    'Acme Widgets signs battery supply deal with carmaker', 'Acme Widgets adds second shift at Texas plant']);
  assert.deepEqual(result.stats.fallback_noise_dropped, { routine_notice: 1, official_copy: 1 });
});

test('unreadable outlets go behind readable ones within the fallback cap', async () => {
  const { result } = await runNoisy({ ...sourceConfig, external_news_unreadable_outlets: ['Reuters'] }, { maxPerSource: 2 });
  assert.deepEqual(result.rows.filter(row => row.collector === 'google_news_rss').map(row => row.title),
    ['Acme Widgets signs battery supply deal with carmaker', 'Acme Widgets adds second shift at Texas plant']);
});
