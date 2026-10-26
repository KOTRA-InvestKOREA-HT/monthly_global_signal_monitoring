import test from 'node:test';
import assert from 'node:assert/strict';
import { articleContentFromHtml, enrichOfficialRowsWithContent, extractArticleBody, extractArticleText, fetchedContentStatus,
  parseArgs } from '../scripts/collect_company_signals.mjs';
import { extractEmbeddedArticle, sharedWordRatio } from '../scripts/embedded_article.mjs';
import { configuredOfficialHosts, extractQualcommAemArticle, isOfficialHostUrl } from '../scripts/publisher_recovery.mjs';

// 2026-09 수집(10월 25일 실행)에서 Google 주소는 발행사로 잘 풀렸지만 본문이 관련 기사 카드이거나 빈 껍데기였다.
// 실제 페이지를 줄여 구조만 흉내 낸 고정 자료다. 원문을 옮긴 것이 아니다.

const filler = (text, times = 6) => `<p>${`${text} `.repeat(times).trim()}</p>`;
const htmlToText = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// ITS International·Global Highways·Best Magazine·KED Global 구조: og:title 끝에 " - 사이트 이름"이 붙어 본문 어디에도
// 그 글자가 없고, 기사보다 긴 관련 기사 카드가 <article> 로 들어 있다. 예전에는 가장 긴 카드가 본문이 됐다.
function suffixedPage() {
  const title = 'Jenoptik intersection cameras set for British Columbia';
  return { title, html: `<head><meta property="og:title" content="${title} - ITS International">
    <title>${title} - ITS International</title></head><body>
    <article><h2>Inaugural regional conference set for 2027</h2>${filler('Related conference story about another event in Africa.', 20)}</article>
    <article><h1>${title}</h1><p>by Staff writer September 25, 2026</p>
    ${filler('Jenoptik will supply more than 140 intersection safety camera systems to the province.')}</article>
    <article><h2>Crash cushion saves a life</h2>${filler('Related roadside safety story from another supplier.', 12)}</article></body>` };
}

test('a site-name suffix on og:title no longer sends the body to a related-article card', () => {
  const { title, html } = suffixedPage();
  const result = extractArticleBody(html);
  assert.equal(result.matchedHeadline, true);
  assert.ok(result.text.startsWith(title));
  assert.match(result.text, /140 intersection safety camera systems/);
  assert.doesNotMatch(result.text, /Related conference story|Related roadside safety story/);
  assert.equal(extractArticleText(html), result.text);
});

// Light Reading 구조: og:title 과 h1 의 문구가 다르다. 행 제목(Google 제목, " - 발행사"로 끝난다)이 h1 과 같다.
function rewordedPage(ogTitle) {
  const h1 = "Verizon loads up on Corning's fiber for network expansion and AI infrastructure";
  return { h1, html: `<head><meta property="og:title" content="${ogTitle}"></head><body>
    <article><h2>Operator makes first AI-RAN call</h2>${filler('Featured story about a different operator and its vendors.', 20)}</article>
    <article><h1>${h1}</h1>${filler('Verizon struck a multi-year supply deal with Corning for optical fiber and cable.')}</article></body>` };
}

test('the row title finds the article when og:title is worded differently from the h1', () => {
  const { h1, html } = rewordedPage('Verizon signs multibillion supply pact');
  const withoutRowTitle = extractArticleBody(html);
  assert.equal(withoutRowTitle.matchedHeadline, false);
  assert.match(withoutRowTitle.text, /Featured story about a different operator/);
  const result = extractArticleBody(html, { title: `${h1} - Light Reading` });
  assert.equal(result.matchedHeadline, true);
  assert.ok(result.text.startsWith(h1));
  assert.doesNotMatch(result.text, /Featured story/);
});

test('an h1 that shares most of its distinctive words with og:title is used without a row title', () => {
  const { h1, html } = rewordedPage('Verizon strikes Corning fiber supply deal for AI network');
  const result = extractArticleBody(html);
  assert.equal(result.matchedHeadline, true);
  assert.ok(result.text.startsWith(h1));
});

// news.3m.com 구조: 모든 기사의 h1 이 사이트 공통 제목("3M News Center - 3M Stories")이다. 이 h1 을 제목으로
// 받으면 본문이 그 자리에서 잘려 기사 글이 빠진다. og:title 과 겹치는 낱말이 없으므로 받지 않는다.
test('a site-wide h1 that does not resemble og:title is never used as the headline', () => {
  const html = `<head><meta property="og:title" content="From electronics to agriculture: how film helps growers"></head><body>
    <main><h2>How film technology is helping growers</h2>
    ${filler('Multilayer optical film keeps greenhouse crops cooler during summer heat waves.')}
    <h1>3M News Center - 3M Stories</h1><p>More stories from the newsroom.</p></main></body>`;
  assert.ok(sharedWordRatio('3M News Center - 3M Stories', 'From electronics to agriculture: how film helps growers') < 0.5);
  const result = extractArticleBody(html, { title: 'From electronics to agriculture: how film helps growers - 3M News' });
  assert.equal(result.matchedHeadline, false);
  assert.match(result.text, /Multilayer optical film keeps greenhouse crops cooler/);
});

// 처음 시도에서 제목을 찾은 페이지는 행 제목이 무엇이든 본문이 글자 하나 바뀌지 않는다. 바뀌면 기사 ID 가 바뀐다.
test('a page whose headline the original extractor found is unchanged by any row title', () => {
  const title = 'Infineon acquires power management startup';
  const html = `<head><meta property="og:title" content="${title} | Infineon Technologies"></head><body><main>
    <article><h1>${title}</h1>${filler('Infineon agreed to acquire the startup to expand data center power management.')}</article>
    <article><h2>Related: Infineon opens new fab in Dresden</h2>${filler('Related story about a fab opening.', 20)}</article>
    </main></body>`;
  const original = extractArticleBody(html);
  assert.equal(original.matchedHeadline, true);
  for (const rowTitle of ['Related: Infineon opens new fab in Dresden - Trade Weekly', `${title} - Infineon`, ''])
    assert.equal(extractArticleText(html, { title: rowTitle }), original.text);
});

// The Northern Miner 유료 안내 페이지 구조: og:title 과 같은 <h1> 이 인쇄용 스크립트 문자열 안에만 있다.
// 다시 대 보기가 그 자리에서 자르면 스크립트 코드가 본문이 된다. 스크립트 안의 제목은 대지 않는다.
test('a retry never trims the body at a heading inside a script string', () => {
  const html = `<head><meta property="og:title" content="Free Article Limit Reached - The Northern Miner"></head><body>
    <article><h1>New US lithium mines are coming</h1>${filler('Nine new lithium mines could start producing in the next decade.')}</article>
    <article>${filler('Related mining card text.', 30)}</article>
    <script>sessionStorage.setItem('print', '<h1>Free Article Limit Reached</h1>' + "<div>print copy</div>");</script></body>`;
  const result = extractArticleBody(html, { title: 'New US lithium mines are coming - The Northern Miner' });
  assert.equal(result.matchedHeadline, true);
  assert.ok(result.text.startsWith('New US lithium mines are coming'));
  assert.doesNotMatch(result.text, /sessionStorage|print copy/);
});

test('candidates with fewer than three words are not tried', () => {
  const html = `<head><meta property="og:title" content="Quarterly update - Example Corp"></head><body>
    <article>${filler('Unrelated card text.', 30)}</article><article><h1>Quarterly update</h1><p>Body.</p></article></body>`;
  assert.equal(extractArticleBody(html).matchedHeadline, false);
});

// Chosun English 는 Arc XP 다. 본문은 HTML 이 아니라 Fusion.globalContent 에 실린다.
function arcPage(restrictions) {
  const content = {
    headlines: { basic: 'Party leader demands ouster of ministers over budget' },
    ...(restrictions ? { content_restrictions: restrictions } : {}),
    content_elements: [
      { type: 'text', content: 'The party leader said on the 22nd that the ministers &ldquo;must step down&rdquo;.' },
      { type: 'image', url: 'https://example.com/photo.jpg', caption: 'Photo caption is not body text' },
      { type: 'header', content: 'Budget dispute' },
      { type: 'text', content: `<b>Lawmakers</b> ${'debated the budget late into the night. '.repeat(8)}` },
    ],
  };
  return `<head><meta property="og:title" content="${content.headlines.basic}"></head><body><div id="fusion-app"></div>
    <script>window.Fusion=window.Fusion||{};Fusion.globalContent=${JSON.stringify(content)};Fusion.globalContentConfig={"source":"x"};</script>
    <script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', headline: content.headlines.basic,
      articleBody: 'Teaser shown to everyone. '.repeat(12) })}</script></body>`;
}

test('Arc XP globalContent text and header elements become the body when the headline matches', () => {
  const titles = ['Party leader demands ouster of ministers over budget - The Chosun Daily'];
  const article = extractEmbeddedArticle(arcPage(), { titles, htmlToText });
  assert.equal(article.kind, 'arc');
  assert.equal(article.title, 'Party leader demands ouster of ministers over budget');
  assert.match(article.content, /^The party leader said on the 22nd/);
  assert.match(article.content, /\nBudget dispute\nLawmakers debated/);
  assert.doesNotMatch(article.content, /Photo caption/);
  assert.equal(extractEmbeddedArticle(arcPage(), { titles: ['Completely different story about weather'], htmlToText }), null);
});

// GenomeWeb(digital)·Pensions&Investments(registration-required): 유료·가입 기사는 어떤 형식으로도 꺼내지 않는다.
test('a restricted Arc article yields nothing, not even its JSON-LD copy', () => {
  for (const restrictions of [{ content_code: 'digital' }, { content_code: 'registration-required' }])
    assert.equal(extractEmbeddedArticle(arcPage(restrictions),
      { titles: ['Party leader demands ouster of ministers over budget'], htmlToText }), null);
});

// 제목을 찾았고 기준을 넘은 HTML 본문은 스크립트에 다른 글이 있어도 그대로다. 짧은 본문(LPGA 179자)만 바뀐다.
test('embedded text replaces only a short or headline-less HTML body', () => {
  const headline = 'Party leader demands ouster of ministers over budget';
  const withHtmlBody = arcPage().replace('<div id="fusion-app"></div>',
    `<article><h1>${headline}</h1>${filler('The printed article body says the ministers must resign.', 8)}</article>`);
  const kept = articleContentFromHtml(withHtmlBody, { title: headline });
  assert.equal(kept.status, '');
  assert.equal(kept.text, extractArticleText(withHtmlBody));
  const short = articleContentFromHtml(arcPage().replace('<div id="fusion-app"></div>', `<article><h1>${headline}</h1></article>`),
    { title: headline });
  assert.equal(short.matchedHeadline, true);
  assert.equal(short.status, 'fetched_embedded_arc');
  assert.ok(short.text.startsWith(`${headline}\nThe party leader said`));
});

function jsonLdPage(node) {
  return `<head><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org',
    '@graph': [{ '@type': 'WebPage', name: 'Site home' }, { '@type': 'Organization', name: 'Global Highways' }, node] })}</script></head>
    <body><div>Menu</div></body>`;
}

test('JSON-LD articleBody is used only with a matching headline, enough text, and free access', () => {
  const headline = "Ouster's digital lidar installed at Stamford intersections";
  const articleBody = `Ouster has reported that Stamford is the first city to install its lidar system.\r\n\r\n${'The deployment covers busy intersections downtown. '.repeat(6)}`;
  const titles = [`${headline} - Global Highways`];
  const found = extractEmbeddedArticle(jsonLdPage({ '@type': 'NewsArticle', headline, articleBody }), { titles, htmlToText });
  assert.equal(found.kind, 'jsonld');
  assert.equal(found.title, headline);
  assert.match(found.content, /^Ouster has reported/);
  assert.equal(extractEmbeddedArticle(jsonLdPage({ '@type': 'NewsArticle', headline: 'Valtir crash cushion saves a life', articleBody }),
    { titles, htmlToText }), null);
  assert.equal(extractEmbeddedArticle(jsonLdPage({ '@type': 'NewsArticle', headline, articleBody: 'Too short.' }),
    { titles, htmlToText }), null);
  assert.equal(extractEmbeddedArticle(jsonLdPage({ '@type': 'NewsArticle', headline, articleBody, isAccessibleForFree: false }),
    { titles, htmlToText }), null);
});

function rscPage(chunks) {
  return `<head><title>x</title></head><body><div id="__next"></div>${chunks.map(chunk =>
    `<script>self.__next_f.push([1,${JSON.stringify(chunk)}])</script>`).join('')}</body>`;
}

// Motley Fool·LPGA 는 Next.js 다. 본문이 self.__next_f 조각에 HTML 로 실린다. 같은 페이지의 사이드바 조각이 더 길 수 있다.
test('a Next.js RSC chunk is accepted only when the title words appear near its start', () => {
  const title = 'Brooke Henderson Named Impact Award Recipient - LPGA';
  const body = `<p>Brooke Henderson was named the recipient of the Impact Award after fan voting.</p><p>${'The award recognizes community work. '.repeat(8)}</p>`;
  const sidebar = `<div><p>${'Alicia discusses probiotic ingredients and emotional wellbeing benefits. '.repeat(12)}</p></div>`;
  const found = extractEmbeddedArticle(rscPage(['1:HL["/_next/static/css/app.css"]', body]), { titles: [title], htmlToText });
  assert.equal(found.kind, 'rsc');
  assert.equal(found.title, 'Brooke Henderson Named Impact Award Recipient');
  assert.match(found.content, /^Brooke Henderson was named/);
  // 가장 긴 HTML 조각이 다른 글이면 받지 않는다(Nutrition Insight 의 사이드바).
  assert.equal(extractEmbeddedArticle(rscPage([body, sidebar]), { titles: [title], htmlToText }), null);
});

// Qualcomm Apple 특허 재계약 보도자료: 이미지 컴포넌트가 먼저 오고 본문은 mediarte_1 에 있다.
const qualcommRow = { company: 'Qualcomm', publisher: 'Qualcomm',
  title: 'Qualcomm Announces Renewal of Patent License Agreement - Qualcomm' };
const MEDIA = 'qcomm-martech/components/content/mediaComponents';
function qualcommModel(items, order) {
  return { title: 'Qualcomm Announces Renewal of Patent License Agreement',
    ':items': { root: { ':items': { responsivegrid: { ...(order ? { ':itemsOrder': order } : {}), ':items': items } } } } };
}

test('the first media-RTE component in item order is the Qualcomm article body', () => {
  const image = { ':type': `${MEDIA}/mediaimage/v1/mediaimage` };
  const rte = text => ({ ':type': `${MEDIA}/mediarte/v1/mediarte`, qcommRTE: { text: `<p>${text}</p>` } });
  const appleOnly = qualcommModel({ mediaimage: image, mediarte_1: rte('Qualcomm renewed its license.') }, ['mediaimage', 'mediarte_1']);
  assert.equal(extractQualcommAemArticle(qualcommRow, appleOnly, htmlToText).content, 'Qualcomm renewed its license.');
  // PickNik 인수 보도자료: mediarte 가 본문, 뒤의 mediarte_1 은 회사 소개다. 둘을 합치지 않는다.
  const both = qualcommModel({ mediaimage: image, mediarte: rte('Qualcomm will acquire the company.'), mediarte_1: rte('About Qualcomm boilerplate.') },
    ['mediaimage', 'mediarte', 'mediarte_1']);
  assert.equal(extractQualcommAemArticle(qualcommRow, both, htmlToText).content, 'Qualcomm will acquire the company.');
  // :itemsOrder 가 없으면 키 순서다. 이름이 맞아도 종류가 다르면 건너뛴다.
  const unordered = qualcommModel({ mediarte: { ':type': `${MEDIA}/text/v1/text`, qcommRTE: { text: '<p>Decoy</p>' } },
    mediarte_2: rte('Body from key order.') });
  assert.equal(extractQualcommAemArticle(qualcommRow, unordered, htmlToText).content, 'Body from key order.');
  assert.equal(extractQualcommAemArticle(qualcommRow, qualcommModel({ footer: rte('Footer') }), htmlToText), null);
});

test('official hosts come from the configured official pages, ignoring www', () => {
  const hosts = configuredOfficialHosts('Qualcomm', { official_pages: { Qualcomm: [{ url: 'https://www.qualcomm.com/news', domain: 'www.qualcomm.com' }] } });
  assert.equal(isOfficialHostUrl('https://qualcomm.com/news/releases/2026/09/a', hosts), true);
  assert.equal(isOfficialHostUrl('https://www.qualcomm.com.evil.example/a', hosts), false);
  assert.equal(isOfficialHostUrl('', hosts), false);
});

test('every body-bearing fetch status counts as fetched', () => {
  for (const status of ['fetched', 'fetched_aem_model', 'fetched_embedded_arc', 'fetched_embedded_jsonld', 'fetched_embedded_rsc'])
    assert.equal(fetchedContentStatus(status), true, status);
  for (const status of ['error', 'empty', 'google_probe_paused', 'unextractable_binary_document', 'fetched_other'])
    assert.equal(fetchedContentStatus(status), false, status);
});

// 수집 경로 전체: Google 주소를 풀어 qualcomm.com 에 닿은 행도 공식 호스트이면 AEM 모델을 본다. 예전에는 제목 대조로
// 찾은 행(official_exact_title)만 봐서 Apple 재계약 보도자료 본문이 83자 껍데기로 남았다.
const ARTICLE_URL = 'https://www.qualcomm.com/news/releases/2026/09/qualcomm-announces-renewal-of-patent-license';
const SHELL = '<html><head><meta property="og:title" content="Qualcomm Announces Renewal of Patent License Agreement"></head>'
  + '<body><main><h1>Qualcomm Announces Renewal of Patent License Agreement</h1></main></body></html>';

async function collectWith(responses, row, officialHosts) {
  const realFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (target) => {
    requested.push(String(target));
    const respond = responses[String(target)];
    if (!respond) return new Response('missing', { status: 404, statusText: 'Not Found' });
    const response = respond();
    Object.defineProperty(response, 'url', { value: String(target) });
    return response;
  };
  try {
    const args = { ...parseArgs([]), rateLimitSeconds: 0, timeoutSeconds: 5, fetchRetries: 0 };
    const company = { target_no: 1, company: row.company, query_aliases: [] };
    const result = await enrichOfficialRowsWithContent([row], args, '2026-10-25T00:00:00Z', company,
      { probe: async () => ({ target: ARTICLE_URL }), officialHosts });
    return { ...result, requested };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('a Google-decoded official-host shell page reads the AEM model', async () => {
  const body = `<p>${'Qualcomm renewed its global patent license agreement for several more years. '.repeat(5)}</p>`;
  const model = qualcommModel({ mediaimage: { ':type': `${MEDIA}/mediaimage/v1/mediaimage` },
    mediarte_1: { ':type': `${MEDIA}/mediarte/v1/mediarte`, qcommRTE: { text: body } } }, ['mediaimage', 'mediarte_1']);
  const responses = {
    [ARTICLE_URL]: () => new Response(SHELL, { headers: { 'content-type': 'text/html' } }),
    [`${ARTICLE_URL}.model.json`]: () => new Response(JSON.stringify(model), { headers: { 'content-type': 'application/json' } }),
  };
  const row = { target_no: 1, company: 'Qualcomm', ...qualcommRow, url: 'https://news.google.com/rss/articles/CBMiQUALCOMM?oc=5',
    source: 'Google News: Qualcomm', source_type: 'fallback', collector: 'google_news_rss', link_verdict: 'accept', link_rank: 0 };
  const hosts = new Set(['qualcomm.com']);
  const { rows } = await collectWith(responses, row, hosts);
  assert.equal(rows[0].content_fetch_status, 'fetched_aem_model');
  assert.match(rows[0].content_text, /^Qualcomm Announces Renewal of Patent License Agreement\nQualcomm renewed/);
  // 공식 호스트가 아니면 예전처럼 모델을 보지 않는다.
  const outside = await collectWith(responses, row, new Set(['example.com']));
  assert.equal(outside.rows[0].content_fetch_status, 'fetched');
  assert.deepEqual(outside.requested, [ARTICLE_URL]);
});

test('a Google-decoded Arc page with a title-only HTML body keeps the embedded article', async () => {
  const headline = 'Party leader demands ouster of ministers over budget';
  const responses = { [ARTICLE_URL]: () => new Response(arcPage(), { headers: { 'content-type': 'text/html' } }) };
  const row = { target_no: 1, company: 'Qualcomm', title: `${headline} - The Chosun Daily`, publisher: 'The Chosun Daily',
    url: 'https://news.google.com/rss/articles/CBMiCHOSUN?oc=5', source: 'Google News: The Chosun Daily',
    source_type: 'fallback', collector: 'google_news_rss', link_verdict: 'accept', link_rank: 0 };
  const { rows } = await collectWith(responses, row, new Set());
  assert.equal(rows[0].content_fetch_status, 'fetched_embedded_arc');
  assert.ok(rows[0].content_text.startsWith(`${headline}\nThe party leader said on the 22nd that the ministers “must step down”.`));
});
