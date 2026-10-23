// 외부 기사를 늘 본다(2026-10-23 사용자 결정). 공식 기사가 기업 자리를 다 채워도 외부 기사 몇 건은 상한 밖에
// 덧붙고, 한국 관련 검색 결과도 덧붙는다. 주가 해설은 자리를 받기 전에 빠진다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKoreaQuery, collectCompany, parseArgs, stockCommentary, titleNamesCompany } from '../scripts/collect_company_signals.mjs';
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
const stories = Object.fromEntries([...external, ...korea].map(([title, url, day, publisher]) =>
  [url.split('CBMi')[1], { title, day, home: `https://${publisher.toLowerCase()}/story-${url.split('CBMi')[1]}` }]));

async function withNetwork(task) {
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
      if (query.includes('investor')) return new Response(rss(external));
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
