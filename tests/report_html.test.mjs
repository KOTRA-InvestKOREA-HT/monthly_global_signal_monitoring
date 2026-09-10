import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReport, MATRIX_ROWS_PER_COLUMN, PAGE_WIDTH_PT, PAGE_HEIGHT_PT } from '../scripts/report_html.mjs';

const row = (no, company, signals = [false, false, false, false, false]) => ({ target_no: no, company, signals });

function model(companyCount) {
  return {
    lang: 'ko',
    issue: { label: 'Issue 2', month: '2026.09' },
    footer: 'Invest KOREA · Issue 2',
    cover: {
      kicker: 'G L O B A L',
      titles: ['타겟기업', '글로벌 투자시그널', '모니터링'],
      lines: ['첫 줄', '둘째 줄'],
      indicator_heading: '5대 투자동향 지표',
      indicators: [{ no: 1, label: '공급망', description: '설명' }],
    },
    matrix: {
      kicker: 'S I G N A L   M A T R I X', title: '이번 달 시그널 매트릭스',
      description: '설명', company_heading: '기업',
      legend_on: '시그널 포착', legend_off: '미포착',
      indicators: '① 공급망', footnote: '시그널 포착 4개사',
      counts: { detected: 4, reviewed_off: 68, insufficient: 5, total: companyCount },
      rows: Array.from({ length: companyCount }, (_, i) => row(i + 1, `Company ${i + 1}`)),
    },
  };
}

const pages = html => html.match(/<section class="page/g)?.length ?? 0;
const occurrences = (html, needle) => html.split(needle).length - 1;

test('the current 77 companies still fit on one matrix page', () => {
  const html = renderReport(model(77));
  assert.equal(pages(html), 2);
  assert.equal(occurrences(html, 'class="matrix"'), 2);
});

test('a company list too long for one page is carried onto the next, not dropped', () => {
  // The reportlab page slices the list at profiles[:39]/[39:]; anything past the
  // second column is drawn over the legend or off the page, and the build still
  // reports success. Every company must appear exactly once, on some page.
  const companyCount = MATRIX_ROWS_PER_COLUMN * 2 + 3;
  const html = renderReport(model(companyCount));
  assert.equal(pages(html), 3);
  for (let i = 1; i <= companyCount; i += 1) {
    assert.equal(occurrences(html, `>Company ${i}<`), 1, `Company ${i} appears once`);
  }
});

test('the legend and footnote are printed once, on the last matrix page', () => {
  const html = renderReport(model(MATRIX_ROWS_PER_COLUMN * 4 + 1));
  assert.equal(pages(html), 4);
  // Match the attribute, not the bare name, which also appears in the stylesheet.
  assert.equal(occurrences(html, 'class="matrix-footnote"'), 1);
  assert.equal(occurrences(html, 'class="matrix-tail"'), 1);
  // The tail belongs to the final page, so nothing after it opens a new one.
  assert.equal(html.indexOf('class="matrix-tail"') > html.lastIndexOf('<section class="page'), true);
});

test('page numbers run on through however many matrix pages there are', () => {
  const folios = html => [...html.matchAll(/class="folio">(\d+)</g)].map(match => match[1]);
  // The cover carries no folio, so numbering starts at 02 on the first inside page.
  assert.deepEqual(folios(renderReport(model(77))), ['02']);
  assert.deepEqual(folios(renderReport(model(MATRIX_ROWS_PER_COLUMN * 4 + 1))), ['02', '03', '04']);
});

test('the page box is the size the reportlab report uses', () => {
  const html = renderReport(model(1));
  assert.match(html, new RegExp(`@page \\{ size: ${PAGE_WIDTH_PT}pt ${PAGE_HEIGHT_PT}pt; margin: 0; \\}`));
});

test('company names are escaped, not injected', () => {
  const injected = model(1);
  injected.matrix.rows = [row(1, 'Ampere & Co <script>alert(1)</script>')];
  const html = renderReport(injected);
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.match(html, /Ampere &amp; Co &lt;script&gt;/);
});

test('without an asset base the logos fall back to text instead of broken images', () => {
  assert.equal(renderReport(model(1)).includes('<img'), false);
  assert.match(renderReport(model(1), { assets: 'file:///x' }), /<img class="logo-kotra"/);
});
