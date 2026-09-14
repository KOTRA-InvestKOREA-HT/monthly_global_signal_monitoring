import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeAnchor, orderPageRows, resolveSources, secFilingRows, sitemapRows, sitemapUrlDate } from '../scripts/collect_company_signals.mjs';
import { isBoilerplateLink, isPersonOrCoveragePage, looksLikeSourceIndexUrl } from '../scripts/link_policy.mjs';

const range = { fromDate: '2026-08-01', toDate: '2026-08-31', fromMs: Date.parse('2026-08-01T00:00:00Z'), toMs: Date.parse('2026-08-31T23:59:59Z') };
const company = { target_no: 22, company: 'Boeing' };

test('SEC collection needs a declared User-Agent and is otherwise skipped, not failed', () => {
  assert.deepEqual(resolveSources('official_feeds,sec_filings,google_news', {}),
    { sources: ['official_feeds', 'google_news'], skipped: ['sec_filings: SEC_USER_AGENT not set'] });
  assert.deepEqual(resolveSources('official_feeds,sec_filings', { SEC_USER_AGENT: 'Team monitor ops@example.org' }).sources,
    ['official_feeds', 'sec_filings']);
});

test('8-K filings in the period become dated official rows with readable item labels', () => {
  const submissions = { filings: { recent: {
    form: ['8-K', '4', '8-K', '10-Q'],
    accessionNumber: ['0001628280-26-059427', '0000012927-26-000100', '0001628280-26-050000', '0000012927-26-000099'],
    filingDate: ['2026-08-28', '2026-08-20', '2026-07-29', '2026-08-01'],
    acceptanceDateTime: ['2026-08-28T20:43:54.000Z', '', '2026-07-29T12:00:00.000Z', ''],
    primaryDocument: ['ba-20260824.htm', 'form4.xml', 'ba-20260728.htm', 'ba-10q.htm'],
    items: ['1.01,2.03,9.01', '', '2.02,9.01', ''],
  } } };
  const rows = secFilingRows(company, { cik: '0000012927', ticker: 'BA' }, submissions, range, '2026-09-14T00:00:00Z');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, 'https://www.sec.gov/Archives/edgar/data/12927/000162828026059427/ba-20260824.htm');
  assert.match(rows[0].title, /Item 1\.01 Entry into a Material Definitive Agreement; Item 2\.03/);
  assert.doesNotMatch(rows[0].title, /9\.01/);
  assert.equal(rows[0].source_type, 'official');
  assert.equal(rows[0].published_at.slice(0, 10), '2026-08-28');
});

test('sitemap URLs yield a date only when the path carries one', () => {
  assert.equal(sitemapUrlDate('https://www.evonik.com/en/news/press-releases/2026/08/q2-2026.html'), '2026-08');
  assert.equal(sitemapUrlDate('https://www.infineon.com/press-release/2026/infxx202607-113'), '2026-07');
  assert.equal(String(sitemapUrlDate('https://www.asahi-kasei.com/news/2026/e260803-pdf')).slice(0, 10), '2026-08-03');
  // A digit run that does not match its year folder is not a date.
  assert.equal(sitemapUrlDate('https://www.asahi-kasei.com/news/2026/e280826'), null);
  assert.equal(sitemapUrlDate('https://www.abb.com/global/en/areas/electrification/wire-terminals'), null);
});

test('sitemap rows keep only included, in-period URLs', () => {
  const xml = ['<urlset>',
    '<url><loc>https://www.evonik.com/en/news/press-releases/2026/08/claus-rettig-interim-ceo-evonik.html</loc><lastmod>2026-08-27</lastmod></url>',
    '<url><loc>https://www.evonik.com/en/news/press-releases/2026/07/older-release.html</loc></url>',
    '<url><loc>https://www.evonik.com/en/products/silica.html</loc><lastmod>2026-08-30</lastmod></url>',
    '</urlset>'].join('');
  const rows = sitemapRows(xml, { target_no: 40, company: 'Evonik Industries' },
    { url: 'https://www.evonik.com/en.sitemap.xml', include: '/en/news/press-releases/\\d{4}/\\d{2}/' }, range, '2026-09-14T00:00:00Z');
  assert.deepEqual(rows.map(row => row.url), ['https://www.evonik.com/en/news/press-releases/2026/08/claus-rettig-interim-ceo-evonik.html']);
  assert.equal(rows[0].collector, 'official_sitemap');
});

test('boilerplate is judged by whole path segments, so news under a career-and-company section survives', () => {
  assert.equal(isBoilerplateLink('Lifting Without Consequences 08/31/2026',
    'https://www.schmalz.com/en/career-company/latest/news/lifting-without-consequences'), false);
  assert.equal(isBoilerplateLink('A Career at Besi', 'https://www.besi.com/careers/a-career-at-besi/'), true);
  assert.equal(isBoilerplateLink('Find contact person', 'https://www.schmalz.com/en/contacts'), true);
  assert.equal(isBoilerplateLink('Share on LinkedIn', 'https://www.linkedin.com/shareArticle?url=x'), true);
});

test('year archives are index pages and IR person pages are not feed articles', () => {
  assert.equal(looksLikeSourceIndexUrl('https://www.besi.com/investor-relations/press-releases/2026/'), true);
  assert.equal(looksLikeSourceIndexUrl('https://www.besi.com/investor-relations/press-releases/details/be-semiconductor-industries-nv-announces-q2-26-and-h1-26-results/'), false);
  assert.equal(isPersonOrCoveragePage('https://investor.westpharma.com/board-member/michel-lagarde'), true);
  assert.equal(isPersonOrCoveragePage('https://ir.amkor.com/analyst/ruplu-bhattacharya'), true);
  assert.equal(isPersonOrCoveragePage('https://investor.lilly.com/news-releases/news-release-details/lilly-acquire-merida-biosciences'), false);
});

test("the link classifier rejects year archives before a year in the path can make them look like articles", () => {
  const page = "https://www.besi.com/investor-relations/press-releases/";
  assert.deepEqual(judgeAnchor({ url: "https://www.besi.com/investor-relations/press-releases/2026/", title: "2026", context: "" }, page, "proposed"),
    { verdict: "hard_reject", reason: "index_page" });
  assert.equal(judgeAnchor({ url: "https://www.besi.com/investor-relations/press-releases/details/be-semiconductor-industries-nv-announces-q2-26-and-h1-26-results/",
    title: "BE Semiconductor Industries N.V. Announces Q2-26 and H1-26 Results", context: "" }, page, "proposed").verdict, "accept");
});

test('dated links are kept ahead of undated ones of the same rank before the per-page cap', () => {
  const agm = year => ({ url: `https://www.besi.com/investor-relations/annual-general-meeting/agm-${year}/`, link_rank: 0 });
  const release = (slug, day) => ({ url: `https://www.besi.com/investor-relations/press-releases/details/${slug}/`,
    published_at: `2026-08-${day}T00:00:00Z`, link_rank: 0 });
  const verify = { url: 'https://www.besi.com/investor-relations/share-information/', link_rank: 2 };
  const rows = [agm(2026), agm(2025), agm(2024), verify, release('q2-26-results', '05'), release('early-redemption', '12')];
  assert.deepEqual(orderPageRows(rows).slice(0, 3).map(row => row.url), [rows[4].url, rows[5].url, rows[0].url]);
  // Rank still wins over dates: a fetch_to_verify link never jumps ahead of an accepted one.
  assert.equal(orderPageRows(rows).at(-1).url, verify.url);
});
