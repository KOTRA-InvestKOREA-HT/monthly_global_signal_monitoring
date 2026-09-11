import test from 'node:test';
import assert from 'node:assert/strict';
import { extractArticleText, collectHtmlDateEvidence } from '../scripts/collect_company_signals.mjs';
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
