import test from 'node:test';
import assert from 'node:assert/strict';
import { extractArticleText, collectHtmlDateEvidence, parseRssOrAtom } from '../scripts/collect_company_signals.mjs';
import { chooseDateEvidence, reportEligible } from '../scripts/date_state.mjs';
const august = { from_date: '2026-08-01', to_date: '2026-08-31' };

// Reduced structural fixtures from the 2026-09-10 investigation, not copies
// of the live releases. Assert financial content, not just output length.
test('Air Products structure: sidebar articles cannot hide the main earnings release', () => {
  const title = 'Air Products Reports Fiscal 2026 Third Quarter Results';
  const html = `<head><meta property="og:title" content="${title}"></head><body>
    <nav>Semiconductor product navigation</nav><main>
    <header><h1>${title}</h1></header><p>07/30/2026 | Lehigh Valley, PA</p>
    <p>Revenue increased and GAAP earnings per share improved. Management updated guidance and outlook.</p>
    <p>The earnings release includes financial tables, segment performance and an explanation of quarterly operating results.</p>
    <article>View entire earnings release with all financial tables</article>
    <article>Access all earnings materials</article>
    <article>${'About Air Products: a world-leading industrial gases company. '.repeat(100)}</article>
    </main><aside>Unrelated investment news</aside><footer>Privacy Policy</footer></body>`;
  const body = extractArticleText(html);
  for (const text of [title, '07/30/2026', 'Revenue', 'GAAP', 'per share', 'guidance', 'outlook'])
    assert.ok(body.includes(text), `Missing ${text}`);
  assert.doesNotMatch(body, /Semiconductor product navigation|Unrelated investment news|Privacy Policy/);
});

test('Charles River structure: a headline-bearing print card cannot replace the release', () => {
  const title = 'Charles River Laboratories Announces Second-Quarter 2026 Results';
  const html = `<head><meta property="og:title" content="${title}"></head><body>
    <div>Skip to main navigation ${'Services product menu '.repeat(100)}</div>
    <h1>${title}</h1><article>View printer-friendly version ${title} Download PDF 477.6 KB</article>
    <div><p>Revenue and GAAP earnings per share are detailed in the financial tables.</p>
    <p>The company updated full-year guidance and outlook alongside its operating results.</p>
    <p>Management discussed quarterly performance, ongoing operations and expectations for the coming year.</p></div>
    <aside>Other companies announced investments</aside><footer>Privacy Policy</footer></body>`;
  const body = extractArticleText(html);
  for (const text of [title, 'Revenue', 'GAAP', 'per share', 'guidance', 'outlook'])
    assert.ok(body.includes(text), `Missing ${text}`);
  assert.doesNotMatch(body, /Skip to main navigation|Services product menu|Other companies|Privacy Policy/);
});

test('a substantive article stays scoped even when main contains longer unrelated content', () => {
  const title = 'New recycling collaboration';
  const article = `<article><header><h1>${title}</h1></header><p>${'Acme will jointly develop recycling methods. '.repeat(10)}</p></article>`;
  const body = extractArticleText(`<body><main>${article}<div>${'Unrelated semiconductor investment. '.repeat(100)}</div></main></body>`);
  assert.match(body, /New recycling collaboration/);
  assert.match(body, /Acme will jointly develop/);
  assert.doesNotMatch(body, /Unrelated semiconductor/);
});

test('short notices survive and title matching tolerates punctuation differences', () => {
  assert.equal(extractArticleText('<body><article><h1>Brief notice</h1><p>Meeting postponed.</p></article></body>'),
    'Brief notice\nMeeting postponed.');
  const html = `<head><meta property="og:title" content="ACME – quarterly results"></head><body><main>
    <article><h1>ACME: Quarterly Results</h1><p>${'Revenue and earnings per share increased. '.repeat(10)}</p></article>
    <div>${'Unrelated product list. '.repeat(100)}</div></main></body>`;
  assert.doesNotMatch(extractArticleText(html), /Unrelated product/);
});

test('article evidence excludes larger site-wide product navigation and footer text', () => {
  const html = `<body><nav>${'Battery semiconductor product menu '.repeat(100)}</nav>
    <main><article><header><h1>New recycling collaboration</h1></header><p>Acme will jointly develop recycling methods.</p></article>
    <aside>Other company plans a new plant</aside></main><footer>Privacy Policy</footer></body>`;
  const body = extractArticleText(html);
  assert.match(body, /New recycling collaboration/);
  assert.match(body, /Acme will jointly develop/);
  assert.doesNotMatch(body, /Battery|Other company|Privacy Policy/);
});

test('unmarked body remains complete and empty article tags do not hide the body', () => {
  const body = extractArticleText('<body><article></article><div class="content"><div>First paragraph</div><div>Second paragraph</div></div></body>');
  assert.match(body, /First paragraph/);
  assert.match(body, /Second paragraph/);
  assert.equal(extractArticleText('<main><p>Standalone main content</p></main>'), 'Standalone main content');
});

test('time-tag modification date cannot promote an older article into the current month', () => {
  const html = '<time itemprop="dateModified" datetime="2026-08-20"></time><time itemprop="datePublished" datetime="2026-07-10"></time>';
  const chosen = chooseDateEvidence(collectHtmlDateEvidence(html));
  assert.equal(chosen.published_at.slice(0, 10), '2026-07-10');
  assert.equal(chosen.modified_at.slice(0, 10), '2026-08-20');
  assert.equal(reportEligible(chosen, august), false);
  const modifiedOnly = chooseDateEvidence(collectHtmlDateEvidence('<time itemprop="dateModified" datetime="2026-08-20"/>'));
  assert.equal(modifiedOnly.published_at_status, 'estimated');
  assert.equal(reportEligible(modifiedOnly, august), false);
});

test('event dates are not publication dates, and conflicting time tags are held', () => {
  const dates = collectHtmlDateEvidence('<time itemprop="startDate" datetime="2026-08-10"></time>');
  assert.equal(dates.some(d => d.source === 'time_tag'), false);
  const chosen = chooseDateEvidence(collectHtmlDateEvidence('<time datetime="2026-08-05"></time><time datetime="2026-07-20"></time>'));
  assert.equal(chosen.date_conflict, true);
  assert.equal(reportEligible(chosen, august), false);
});

// 34546694524: Infineon 기사 6건의 본문이 24,000자로 완전히 동일했다. 페이지 전체가 하나의
// <article> 인데 제목 바로 뒤에서 이미지용 <article> 이 열렸다 닫히고, 기사 본문은 그 뒤에
// 있다. 첫 닫는 태그까지만 읽으면 앞의 제품 메뉴만 남고, 글자 수 제한이 그 메뉴를 자른다.
test('a nested article tag cannot end the scope before the release it wraps', () => {
  // og:title 은 낱말 경계에서 잘려 온다: "... support successful | Infineon Technologies".
  const cut = title => title.slice(0, title.lastIndexOf(' ', 52));
  const page = (title, body) => `<head><meta property="og:title" content="${cut(title)} | Infineon Technologies"></head>
    <body><article><div class="megamenu"><ul>${'<li>Battery management ICs</li><li>Automotive Ethernet</li>'.repeat(200)}</ul></div>
    <h1>${title}</h1><article><figure>Press photo JPEG 2126x1196 px Download</figure></article>
    <p>${body}</p></article></body>`;
  const first = extractArticleText(page('Infineon HiRel power semiconductors support successful launch of NASA Roman Space Telescope',
    'Radiation-hardened HiRel power devices are aboard the observatory launched from Kennedy Space Center.'));
  const second = extractArticleText(page('Infineon acquires C2i Semiconductors to expand AI data center power management',
    'The acquisition adds multiphase controllers and smart power stages for AI server power delivery.'));
  for (const body of [first, second]) assert.doesNotMatch(body, /Battery management ICs|Automotive Ethernet/);
  assert.match(first, /Radiation-hardened HiRel power devices are aboard/);
  assert.match(second, /multiphase controllers and smart power stages/);
  // 같은 레이아웃의 서로 다른 기사가 같은 본문을 갖지 않는다. 그것이 원래의 증상이었다.
  assert.notEqual(first, second);
});

test('a commented-out tag leaves neither its markup nor a stray comment close behind', () => {
  const body = extractArticleText(`<head><meta property="og:title" content="Spokesperson contact"></head>
    <body><main><h1>Spokesperson contact</h1><p>Call the press office.</p>
    <!-- <img class="globe" src="/globe.svg" alt="Globe"> --><p>+49 89 234 39300</p></main></body>`);
  assert.match(body, /Call the press office\./);
  assert.match(body, /\+49 89 234 39300/);
  assert.doesNotMatch(body, /-->|globe|Globe/);
});

// 34546694524: Google 보조 뉴스 117행의 본문 확보는 0건이었다. 기사 링크가 본문을
// 자바스크립트로 받아오는 news.google.com 중계 페이지라 수집기가 원문에 닿지 못한다.
// 중계 페이지를 원문으로 인정할 수는 없으므로, 최소한 어디로 가야 하는지는 남겨야 한다.
// 피드의 <source url> 이 발행사 홈페이지를 그대로 주는데 지금까지 버리고 있었다.
test('an unreachable news relay still records which publisher to go to', () => {
  const relay = 'https://news.google.com/rss/articles/CBMiwwFBVV95cUxPbWViRDNJdWE3?oc=5';
  const xml = `<rss><channel><item>
    <title>Mkango Acquires Remloy For EUR 8 Million - Pulse 2.0</title>
    <link>${relay}</link><pubDate>Mon, 31 Aug 2026 20:28:52 GMT</pubDate>
    <source url="https://pulse2.com">Pulse 2.0</source></item></channel></rss>`;
  const [row] = parseRssOrAtom(xml, { target_no: 41, company: 'Heraeus' }, '2026-09-11T00:29:37Z',
    'google_news_rss', 'query', 'Google News');
  assert.equal(row.publisher, 'Pulse 2.0');
  // stripTracking 이 URL 을 정규화하므로 끝 슬래시가 붙는다.
  assert.equal(row.publisher_home_url, 'https://pulse2.com/');
  // 표시 이름은 그대로 두고, 원문 주소를 중계 링크로 지어내지 않는다.
  assert.equal(row.source, 'Google News: Pulse 2.0');
  assert.equal(row.url, relay);
});

test('a feed without a publisher attribute leaves the field empty rather than guessing', () => {
  const xml = `<rss><channel><item><title>Pilot plant</title>
    <link>https://example.com/pilot</link><source>Example Wire</source></item></channel></rss>`;
  const [row] = parseRssOrAtom(xml, { target_no: 1, company: 'Example' }, '2026-09-11T00:00:00Z',
    'google_news_rss', 'query', 'Google News');
  assert.equal(row.publisher, 'Example Wire');
  assert.equal(row.publisher_home_url, '');
});
