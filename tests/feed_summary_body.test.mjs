import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichOfficialRowsWithContent, feedSummaryText, parseArgs, parseRssOrAtom } from '../scripts/collect_company_signals.mjs';
import { ARTICLE_BODY_MIN_CHARS, hasArticleBody } from '../scripts/date_state.mjs';
import { decisionOutcome, groupArticles, importReview, monthPeriod } from '../scripts/local_report.mjs';

// 2026-09 수집에서 Syensqo 5건·DNP 10건은 공식 RSS 로 목록은 받았지만 원문 페이지가 403/500 이라 본문 없이
// 규칙으로 버려졌다. 피드에 요약이 있으면 그것을 본문 대신 쓴다. 네트워크 없이 가짜 피드와 가짜 fetch 로 확인한다.

const company = { target_no: 46, company: 'Syensqo', query_aliases: [] };
const FEED_URL = 'https://www.syensqo.com/rss.xml';
const ARTICLE_URL = 'https://www.syensqo.com/en/press-release/syensqo-brings-aromatic-compounding-capability-to-india';
const TITLE = 'Syensqo brings aromatic compounding capability to India';
const COLLECTED_AT = '2026-10-01T00:00:00Z';
const period = monthPeriod('2026-09');

// 실제 피드처럼 HTML 을 이스케이프해 싣고 이름 있는 엔티티를 섞는다.
const LONG_SUMMARY_HTML = '&lt;p&gt;Syensqo will add a compounding line for aromatic polymers at its Panoli site in Gujarat, India.&lt;/p&gt;'
  + '&lt;p&gt;The new line starts operating in the second half of 2027 and serves automotive and electronics customers'
  + ' in the region&amp;nbsp;&amp;mdash; the company&amp;rsquo;s first such capability in South Asia.&lt;/p&gt;';
const LONG_SUMMARY_TEXT = 'Syensqo will add a compounding line for aromatic polymers at its Panoli site in Gujarat, India.';
const SHORT_SUMMARY = 'Syensqo expands in India.';

function feed(description) {
  return `<?xml version="1.0" encoding="utf-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
    <title>Syensqo</title><description>Channel description is not an item summary</description>
    <item><title>${TITLE}</title><link>${ARTICLE_URL}</link>
      ${description === undefined ? '' : `<description>${description}</description>`}
      <pubDate>Thu, 03 Sep 2026 07:00:00 +0000</pubDate></item>
  </channel></rss>`;
}

const PAGE_BODY = 'Syensqo today announced a compounding investment at Panoli. '.repeat(8);
const PAGE_HTML = `<html><head><title>${TITLE}</title></head><body><main><article><h1>${TITLE}</h1>`
  + `<p>${PAGE_BODY}</p></article></main></body></html>`;

// 상세 페이지 요청만 가짜로 답한다. 다른 주소를 요청하면 실패시킨다.
async function enrichWith(xml, respond) {
  const realFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (target) => {
    requested.push(String(target));
    if (String(target) !== ARTICLE_URL) throw new Error(`unexpected request ${target}`);
    const response = respond();
    Object.defineProperty(response, 'url', { value: ARTICLE_URL });
    return response;
  };
  try {
    const rows = parseRssOrAtom(xml, company, COLLECTED_AT, 'official_feed', FEED_URL, 'Syensqo - Official RSS', 'press_release');
    const args = { ...parseArgs([]), rateLimitSeconds: 0, timeoutSeconds: 5, fetchRetries: 0 };
    const result = await enrichOfficialRowsWithContent(rows, args, COLLECTED_AT, company, { probe: (url, request) => request() });
    assert.deepEqual(requested, [ARTICLE_URL]);
    return result;
  } finally {
    globalThis.fetch = realFetch;
  }
}

const blocked = () => new Response('Access denied', { status: 403, statusText: 'Forbidden' });
const page = (html) => () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });

// 판정 후보로 만든다. 수집 이후 단계(sourceCandidates)가 붙이는 기술·지표 필드만 더한다.
const candidateRow = (row) => ({ ...row, target_technology: 'aromatic polymers', target_technology_en: 'aromatic polymers',
  investment_signal_no: 2 });

test('feed summaries lose markup and entities, and WordPress footers', () => {
  assert.equal(feedSummaryText('<![CDATA[<p>Line&nbsp;one &amp; <b>two</b></p><p>It&rsquo;s here</p>]]>'),
    'Line one & two\nIt’s here');
  assert.equal(feedSummaryText('&lt;p&gt;AT&amp;amp;T &lt;a href="x"&gt;link&lt;/a&gt;&lt;/p&gt;'), 'AT&T link');
  assert.equal(feedSummaryText('<p>Body text.</p><p>The post <a href="https://a">Title</a> appeared first on <a href="https://b">Site</a>.</p>'),
    'Body text.');
});

test('official feed items carry their longest summary; Google News items and empty tags do not', () => {
  const xml = `<rss><channel>
    <item><title>Long encoded</title><link>https://example.com/a</link><description>Short teaser</description>
      <content:encoded><![CDATA[<p>Full text of the release.</p>]]></content:encoded></item>
    <item><title>Empty description</title><link>https://example.com/b</link><description/></item>
  </channel></rss>`;
  const rows = parseRssOrAtom(xml, company, COLLECTED_AT, 'official_feed', FEED_URL, 'Feed', 'press_release');
  assert.equal(rows[0].feed_summary, 'Full text of the release.');
  assert.equal(Object.hasOwn(rows[1], 'feed_summary'), false);
  const atom = `<feed><entry><title>Atom item</title><link href="https://example.com/c"/>
    <summary type="html">&lt;p&gt;Atom summary&lt;/p&gt;</summary><content type="html">&lt;p&gt;Atom content body&lt;/p&gt;</content></entry></feed>`;
  assert.equal(parseRssOrAtom(atom, company, COLLECTED_AT, 'official_feed', FEED_URL, 'Feed')[0].feed_summary, 'Atom content body');
  const google = parseRssOrAtom(xml, company, COLLECTED_AT, 'google_news_rss', 'query', 'Google News');
  assert.equal(google.some(row => Object.hasOwn(row, 'feed_summary')), false);
});

test('a blocked detail page with a long feed summary uses the summary as the article body', async () => {
  const { rows, errors } = await enrichWith(feed(LONG_SUMMARY_HTML), blocked);
  assert.equal(errors.length, 1);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row.content_text.length >= ARTICLE_BODY_MIN_CHARS);
  assert.match(row.content_text, /Panoli site in Gujarat/);
  assert.match(row.content_text, /region — the company’s first/);
  assert.doesNotMatch(row.content_text, /<|&[a-z]+;/);
  assert.equal(row.content_source, 'feed_summary');
  // 상세 페이지 요청의 결과는 그대로 남는다. 원문은 여전히 수집 보완 대상이다.
  assert.equal(row.content_fetch_status, 'error');
  // 받은 원문 주소가 없다. 보고서 출처 링크가 피드 XML 을 가리키지 않게 비워 둔다.
  assert.equal(Object.hasOwn(row, 'content_source_url'), false);
  assert.equal(Object.hasOwn(row, 'feed_summary'), false);
  assert.equal(hasArticleBody(row), true);

  // 판정 근거에 요약이 들어가고, 인용 확인은 그 글에 대해 그대로 한다.
  const article = groupArticles([candidateRow(row)], [], period)[0];
  assert.ok(article.evidence.some(text => text.includes(LONG_SUMMARY_TEXT)));
  const decision = (quotes) => ({ candidate_id: 'investment:2', entity_supported: true, target_technology_supported: true,
    indicator_supported: true, leading_indicator_supported: true, event_stage: 'planned', quality: 'pass',
    reason: 'The feed summary states a new compounding line.', evidence_quotes: quotes });
  const accepted = decision([LONG_SUMMARY_TEXT]);
  assert.equal(importReview(article, { article_id: article.id, reviewer: 'test', decisions: [accepted] },
    { summaries: false }).length, 1);
  assert.equal(decisionOutcome(article, [accepted], accepted).supported, true);
  assert.throws(() => importReview(article, { article_id: article.id, reviewer: 'test',
    decisions: [decision(['Syensqo will build a new plant in Korea.'])] }, { summaries: false }), /exact passages/);
});

test('a blocked detail page with a short feed summary stays without a body', async () => {
  const { rows } = await enrichWith(feed(SHORT_SUMMARY), blocked);
  const row = rows[0];
  assert.equal(row.content_fetch_status, 'error');
  assert.equal(Object.hasOwn(row, 'content_text'), false);
  assert.equal(Object.hasOwn(row, 'content_source'), false);
  assert.equal(Object.hasOwn(row, 'feed_summary'), false);
  assert.equal(hasArticleBody(row), false);
  // 본문 없는 기사는 승인되지 않는다(decisionForApproval).
  const article = groupArticles([candidateRow(row)], [], period)[0];
  const decision = { candidate_id: 'investment:2', entity_supported: true, target_technology_supported: true,
    indicator_supported: true, leading_indicator_supported: true, event_stage: 'planned', quality: 'pass',
    reason: 'Title only.', evidence_quotes: [TITLE] };
  assert.equal(decisionOutcome(article, [decision], decision).supported, false);
});

test('a readable detail page keeps its own body, and the article id does not depend on the feed summary', async () => {
  const withSummary = await enrichWith(feed(LONG_SUMMARY_HTML), page(PAGE_HTML));
  const withoutSummary = await enrichWith(feed(undefined), page(PAGE_HTML));
  const row = withSummary.rows[0];
  assert.equal(row.content_fetch_status, 'fetched');
  assert.match(row.content_text, /announced a compounding investment at Panoli/);
  assert.doesNotMatch(row.content_text, /Gujarat/);
  assert.equal(Object.hasOwn(row, 'content_source'), false);
  // 이미 본문이 있던 기사는 요약이 있든 없든 같은 행·같은 기사 ID 다. 저장된 판정을 다시 쓴다.
  assert.deepEqual(withSummary.rows, withoutSummary.rows);
  assert.equal(groupArticles([candidateRow(row)], [], period)[0].id,
    groupArticles([candidateRow(withoutSummary.rows[0])], [], period)[0].id);
});

test('a page that loads but yields no usable body falls back to a long feed summary', async () => {
  const shell = `<html><head><title>${TITLE}</title></head><body><main><h1>${TITLE}</h1></main></body></html>`;
  const { rows } = await enrichWith(feed(LONG_SUMMARY_HTML), page(shell));
  assert.equal(rows[0].content_source, 'feed_summary');
  assert.match(rows[0].content_text, /Panoli site in Gujarat/);
  assert.equal(hasArticleBody(rows[0]), true);
});
