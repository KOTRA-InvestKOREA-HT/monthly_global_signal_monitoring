import test from 'node:test';
import assert from 'node:assert/strict';
import { extractArticleText, collectHtmlDateEvidence } from '../scripts/collect_company_signals.mjs';
import { chooseDateEvidence, reportEligible } from '../scripts/date_state.mjs';
const august = { from_date: '2026-08-01', to_date: '2026-08-31' };

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
