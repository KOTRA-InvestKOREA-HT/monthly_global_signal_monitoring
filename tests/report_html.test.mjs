import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReport, COLORS, MATRIX_ROWS_PER_COLUMN, PAGE_WIDTH_PT, PAGE_HEIGHT_PT, ITEM_BAND } from '../scripts/report_html.mjs';
import { itemBreaks } from '../scripts/build_html_report.mjs';

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

const silent = no => ({ no, label: `지표 ${no}`, active: false, empty: '이번 달 해당 신호 없음' });
const firing = (no, extra = {}) => ({
  no, label: `지표 ${no}`, active: true, headline: '투자 유치 완료',
  detail: '', plain: '', inline: true, source: '출처 Media 2026.08.31', ...extra,
});

function withDetails(companies, signalsFor = () => [firing(4)]) {
  const base = model(77);
  base.details = {
    kicker: 'C O M P A N Y   S I G N A L S',
    title: '기업별 시그널 상세',
    pages: companies.map(company => ({
      company,
      country: '미국',
      industry: '반도체',
      signals: [1, 2, 3, 4, 5].map(no => signalsFor(company).find(s => s.no === no) || silent(no)),
      business: {
        heading: '글로벌 사업현황', target_label: '타겟품목', target_text: '라이다',
        body: '본문', source: '출처 Media',
      },
    })),
  };
  return base;
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


test('every company with a signal gets its own detail page, numbered i/n', () => {
  const html = renderReport(withDetails(['Ouster', 'Nexeon', 'Applied Materials']));
  // Cover, one matrix page, three detail pages.
  assert.equal(pages(html), 5);
  assert.equal(occurrences(html, 'class="signal-box"'), 3);
  for (const [index, company] of ['Ouster', 'Nexeon', 'Applied Materials'].entries()) {
    assert.equal(occurrences(html, `<h3>${company}</h3>`), 1);
    assert.match(html, new RegExp(`C O M P A N Y[^<]*\u00b7 ${index + 1}/3`));
  }
});

test('a month with no signal for a company is stated, not left blank', () => {
  const html = renderReport(withDetails(['Ouster']));
  assert.equal(occurrences(html, 'class="signal off"'), 4);
  assert.equal(occurrences(html, 'class="signal on"'), 1);
  assert.equal(occurrences(html, '이번 달 해당 신호 없음'), 4);
  // A silent row carries no summary and no source line of its own.
  assert.equal(occurrences(html, 'class="summary"'), 1);
  assert.equal(occurrences(html, 'class="source"'), 2); // one signal, one business
});

test('a headline and its detail share a paragraph only when they fit on a line', () => {
  const short = renderReport(withDetails(['A'], () => [firing(4, { detail: '짧은 설명', inline: true })]));
  assert.match(short, /<p class="summary"><strong>투자 유치 완료<\/strong> — 짧은 설명<\/p>/);
  assert.equal(occurrences(short, 'class="summary continued"'), 0);

  const long = renderReport(withDetails(['A'], () => [firing(4, { detail: '아주 긴 설명', inline: false })]));
  assert.match(long, /<p class="summary"><strong>투자 유치 완료<\/strong><\/p><p class="summary continued">— 아주 긴 설명<\/p>/);
});

test('a summary with no headline falls back to the plain text', () => {
  const html = renderReport(withDetails(['A'], () => [firing(4, { headline: '', detail: '', plain: '평문 요약' })]));
  assert.match(html, /<p class="summary">평문 요약<\/p>/);
});

test('detail text is escaped like everything else', () => {
  const html = renderReport(withDetails(['A'], () => [firing(4, { headline: '<b>x</b>', detail: 'a & b', inline: true })]));
  assert.equal(html.includes('<strong><b>x</b></strong>'), false);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;.*a &amp; b/);
});

test('a model without detail pages still renders the cover and matrix', () => {
  const html = renderReport(model(77));
  assert.equal(pages(html), 2);
  assert.equal(occurrences(html, 'class="signal-box"'), 0);
});


const itemCard = company => ({
  company, industry: '이차전지 핵심소재', country: '미국',
  target_text: '양극재 소재', body: '본문', source: '출처 Newsroom 2026.08.05',
});

function withItems(companies) {
  const base = model(77);
  base.items = {
    kicker: 'T A R G E T - I T E M   S I G N A L S',
    title: '품목별 글로벌 사업동향',
    note: '5대 시그널에는 미포착되었으나...',
    target_label: '투자유치 필요 품목·기술',
    trend_label: '8월 글로벌 사업동향',
    cards: companies.map(itemCard),
  };
  return base;
}

test('trend cards share one sheet until the builder says otherwise', () => {
  const html = renderReport(withItems(['Albemarle', 'HyproMag']));
  assert.equal(pages(html), 3);
  assert.equal(occurrences(html, 'class="item-card"'), 2);
  // The note introduces the section once.
  assert.equal(occurrences(html, '5대 시그널에는 미포착되었으나...'), 1);
});

test('a break moves the cards after it onto the next sheet', () => {
  const html = renderReport(withItems(['A', 'B', 'C']), { itemBreaks: [2] });
  assert.equal(pages(html), 4);
  assert.match(html, /T A R G E T[^<]*· 1\/2/);
  assert.match(html, /T A R G E T[^<]*· 2\/2/);
  // Only the first sheet carries the note and its lower start.
  assert.equal(occurrences(html, 'class="items first"'), 1);
});

test('a report with no item trends ends after the detail pages', () => {
  const html = renderReport(withDetails(['Ouster']));
  assert.equal(occurrences(html, 'class="item-card"'), 0);
  assert.equal(pages(html), 3);
});

test('a card that would cross the band starts the next sheet', () => {
  const room = ITEM_BAND.bottom - ITEM_BAND.firstTop;
  // Two cards that just fit the first sheet, then one that cannot.
  const half = (room - ITEM_BAND.gap) / 2;
  assert.deepEqual(itemBreaks([half, half, half]), [2]);
  // A single card taller than the band is not pushed off a sheet of its own.
  assert.deepEqual(itemBreaks([room + 200]), []);
  assert.deepEqual(itemBreaks([10, 10, 10]), []);
});

test('later sheets start higher, because only the first carries the note', () => {
  assert.equal(ITEM_BAND.top < ITEM_BAND.firstTop, true);
  const tall = ITEM_BAND.bottom - ITEM_BAND.firstTop - ITEM_BAND.gap + 1;
  // The same card fits on a later sheet even though it ended the first one.
  assert.deepEqual(itemBreaks([tall, tall]), [1]);
});

// 34564332764 영문판: 품목 카드 4장이 3+1 로 갈려 마지막 쪽의 70%가 비었다.
test('a spilled last sheet is evened out instead of carrying a single card', () => {
  const room = ITEM_BAND.bottom - ITEM_BAND.firstTop;
  // 4장이 한 장에는 안 들어가고 3장까지는 들어가는 높이. greedy 면 3+1 이다.
  const height = (room - ITEM_BAND.gap * 2) / 3;
  assert.deepEqual(itemBreaks([height, height, height, height]), [2]);
  // 요구사항은 특정 인덱스가 아니라 "한 장만 덜렁 남지 않는 것"이다. 장별 장수 차이를 본다.
  const counts = (n) => {
    const edges = [0, ...itemBreaks(Array(n).fill(height)), n];
    return edges.slice(1).map((edge, i) => edge - edges[i]);
  };
  for (const n of [4, 5, 6]) {
    const sheets = counts(n);
    assert.ok(Math.max(...sheets) - Math.min(...sheets) <= 1, `${n} cards split ${sheets}`);
  }
});

test('evening out never overflows a sheet or adds a page', () => {
  const room = ITEM_BAND.bottom - ITEM_BAND.firstTop;
  // 큰 카드 하나와 작은 카드 셋. 큰 것을 뒤로 넘기면 첫 장이 비므로 옮기지 않는다.
  const big = room - ITEM_BAND.gap;
  const small = 40;
  const breaks = itemBreaks([big, small, small, small]);
  assert.equal(breaks.length, 1, 'still two sheets');
  assert.equal(breaks[0], 1, 'the oversized card keeps the first sheet to itself');
  // 띠보다 큰 카드 하나는 여전히 자기 장을 그대로 쓴다.
  assert.deepEqual(itemBreaks([room + 200]), []);
});

// 출처 줄은 7.1pt 로 찍힌다. 흰 배경에서 대비가 모자라면 인쇄물에서 사라진다.
// 34564332764 영문판의 출처와 발행일이 그래서 읽히지 않았다.
test('body text colours clear the WCAG AA contrast floor on white', () => {
  const luminance = (hex) => {
    const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const onWhite = (hex) => 1.05 / (luminance(hex) + 0.05);
  assert.ok(onWhite(COLORS.muted) >= 4.5, `muted ${COLORS.muted} is ${onWhite(COLORS.muted).toFixed(2)}:1`);
  assert.ok(onWhite(COLORS.text) >= 4.5, `text ${COLORS.text}`);
  // 보조 라벨은 AA 까지는 못 가도 이전(2.04:1)보다는 읽혀야 한다.
  assert.ok(onWhite(COLORS.grey) >= 3, `grey ${COLORS.grey} is ${onWhite(COLORS.grey).toFixed(2)}:1`);
});
