// Report pages as HTML. Pure: a view model in, a document out, no file or
// browser access, so the same renderer can serve a page and print a PDF.
//
// The reportlab path places every run of text at an absolute coordinate and
// hand-fits it with wrap/clip/max-lines helpers. Here the layout engine does
// that work, which is the point of the exercise: the matrix below paginates on
// its own instead of being sliced at a hard-coded 39 rows.

export const PAGE_WIDTH_PT = 540;
export const PAGE_HEIGHT_PT = 780;

// Kept in the same order and spelling as build_pdf_report.py so a change on one
// side is easy to see on the other.
export const COLORS = {
  navy: '#122844',
  gold: '#DCA72F',
  light: '#EEF3F7',
  tableLine: '#D8DDE4',
  text: '#10243E',
  // 출처 줄과 각주가 쓰는 색. 흰 배경에서 #8591A3 은 대비 3.19:1 로 WCAG AA(4.5:1)
  // 미달이었고, 7.1pt 로 찍히는 출처가 실제로 읽히지 않았다. 4.59:1 로 올린다.
  muted: '#6B7688',
  onNavy: '#C8D2DF',
  legend: '#596579',
  bodyGrey: '#555F6E',
  footerBg: '#EFF4F8',
  divider: '#D6DEE9',
  rowNo: '#737C86',
  boxLine: '#E4EAF0',
  tealBg: '#EAF7F4',
  tealLine: '#9EDCD3',
  teal: '#087A70',
  pill: '#56687B',
  // 국가명 같은 보조 라벨. 2.04:1 은 너무 흐려서 옛 muted 값까지만 올린다.
  grey: '#8591A3',
  faint: '#B5B9BF',
};

// Rows per matrix column, from the page geometry: the table starts 145pt down,
// each row is 12.8pt, and the legend needs the last 92pt. The reportlab page
// hard-codes profiles[:39]/[39:] instead and silently overruns the legend once
// the target list passes about 81 companies.
export const MATRIX_ROWS_PER_COLUMN = 39;
const MATRIX_COLUMNS_PER_PAGE = 2;

// Where trend cards may sit: lower on the first sheet, which carries the note,
// and never past the band the footer keeps.
export const ITEM_BAND = { firstTop: 158, top: 114, bottom: 724, gap: 14 };

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g,
  ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const chunk = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

// Pages are numbered across the whole document, and the matrix may now claim
// more than one, so the caller cannot know a page's number in advance.
function page(state, content, { cover = false } = {}) {
  state.number += 1;
  return `<section class="page${cover ? ' cover' : ''}">${content}${cover ? '' : footer(state)}</section>`;
}

const footer = state => `
      <footer class="footer">
        <span>${escapeHtml(state.footer)}</span>
        <span class="folio">${String(state.number).padStart(2, '0')}</span>
      </footer>`;

const header = (kicker, title, fraction = '') => `
      <header class="header">
        <p class="kicker">${escapeHtml(kicker)}${fraction ? ` · ${escapeHtml(fraction)}` : ''}</p>
        <h2>${escapeHtml(title)}</h2>
      </header>`;

function coverPage(state, model, assets) {
  const { cover, issue } = model;
  const logo = (file, alt, className) => assets
    ? `<img class="${className}" src="${assets}/images/${file}" alt="${alt}">`
    : `<span class="${className}">${alt}</span>`;
  return page(state, `
      <div class="issue">
        <p class="issue-label">${escapeHtml(issue.label)}</p>
        <p class="issue-month">${escapeHtml(issue.month)}</p>
      </div>
      <div class="cover-body">
        <p class="cover-kicker">${escapeHtml(cover.kicker)}</p>
        <h1 style="font-size:${cover.title_size ?? 36}pt">${cover.titles.map((title, index) =>
          `<span class="${index === 1 ? 'accent' : ''}">${escapeHtml(title)}</span>`).join('')}</h1>
        <div class="cover-lines">${cover.lines.map(line => `<p>${escapeHtml(line)}</p>`).join('')}</div>
        <p class="cover-indicator-heading">${escapeHtml(cover.indicator_heading)}</p>
        <ul class="cover-indicators">${cover.indicators.map(item => `
          <li>
            <span class="badge">${escapeHtml(item.no)}</span>
            <span class="label">${escapeHtml(item.label)}</span>
            <span class="desc">${escapeHtml(item.description)}</span>
          </li>`).join('')}</ul>
      </div>
      <div class="cover-foot">
        ${logo('kotra_logo_white.png', 'kotra', 'logo-kotra')}
        ${logo('invest_korea_logo_white.png', 'Invest KOREA', 'logo-ik')}
      </div>`, { cover: true });
}

// 꺼진 칸이 두 가지 뜻을 갖는다. 검토를 끝내고 신호가 없었던 것과, 검토를 못 해서
// 모르는 것이다. 지금까지 같은 색이라 읽는 사람이 어느 기업을 다시 뒤져야 하는지 알 수
// 없었다. 34546694524 에서 77개사 중 59개사가 뒤쪽이다. 속을 채운 점은 "보고 없었다",
// 테두리만 있는 점은 "못 봤다"로 읽힌다.
const offMark = row => (row.status === 'insufficient' ? 'unknown' : 'off');

const matrixTable = (heading, rows) => `
        <table class="matrix">
          <thead>
            <tr>
              <th class="col-company" colspan="2">${escapeHtml(heading)}</th>
              ${['①', '②', '③', '④', '⑤'].map(mark => `<th class="col-signal">${mark}</th>`).join('')}
            </tr>
          </thead>
          <tbody>${rows.map(row => `
            <tr>
              <td class="no">${escapeHtml(row.target_no)}</td>
              <td class="company">${escapeHtml(row.company)}</td>
              ${row.signals.map(on => `<td class="cell"><i class="${on ? 'on' : offMark(row)}"></i></td>`).join('')}
            </tr>`).join('')}
          </tbody>
        </table>`;

function matrixPages(state, model) {
  const { matrix } = model;
  const columns = chunk(matrix.rows, MATRIX_ROWS_PER_COLUMN);
  const sheets = chunk(columns, MATRIX_COLUMNS_PER_PAGE);
  return sheets.map((sheet, index) => page(state, `
      ${header(matrix.kicker, matrix.title)}
      <div class="body">
        ${index === 0 ? `<p class="matrix-desc">${escapeHtml(matrix.description)}</p>` : ''}
        <div class="matrix-columns">
          ${sheet.map(rows => matrixTable(matrix.company_heading, rows)).join('')}
        </div>
      </div>
      ${index === sheets.length - 1 ? `
      <div class="matrix-tail">
        <div class="matrix-legend">
          <span><i class="on"></i>${escapeHtml(matrix.legend_on)}</span>
          <span><i class="off"></i>${escapeHtml(matrix.legend_off)}</span>
          <span><i class="unknown"></i>${escapeHtml(matrix.legend_unknown)}</span>
        </div>
        <p class="matrix-indicators">${escapeHtml(matrix.indicators)}</p>
        <p class="matrix-footnote">${escapeHtml(matrix.footnote)}</p>
      </div>` : ''}`)).join('');
}

// A signal's summary is one paragraph: the headline in semibold, then the rest
// after an em dash. Whether the two share a line is settled upstream, because
// only the side holding the font metrics can measure it.
const summary = signal => {
  if (signal.plain) return `<p class="summary">${escapeHtml(signal.plain)}</p>`;
  const headline = `<strong>${escapeHtml(signal.headline)}</strong>`;
  if (!signal.detail) return `<p class="summary">${headline}</p>`;
  return signal.inline
    ? `<p class="summary">${headline} — ${escapeHtml(signal.detail)}</p>`
    : `<p class="summary">${headline}</p><p class="summary continued">— ${escapeHtml(signal.detail)}</p>`;
};

const signalRow = signal => `
          <li class="signal ${signal.active ? 'on' : 'off'}">
            <span class="badge">${escapeHtml(signal.no)}</span>
            <div class="signal-body">
              <p class="signal-head">
                <span class="pill">${escapeHtml(signal.label)}</span>
                ${signal.active ? '' : `<span class="empty">${escapeHtml(signal.empty)}</span><span class="dash">—</span>`}
              </p>
              ${signal.active ? `${summary(signal)}<p class="source">${escapeHtml(signal.source)}</p>` : ''}
            </div>
          </li>`;

function detailPages(state, model, assets) {
  const { details } = model;
  const marker = assets
    ? `<img class="marker" src="${assets}/images/emoji_target_1f3af.png" alt="">`
    : '<span class="marker"></span>';
  return details.pages.map((entry, index) => page(state, `
      ${header(details.kicker, details.title, `${index + 1}/${details.pages.length}`)}
      <div class="detail">
        <section class="signal-box">
          <div class="detail-head">
            <h3>${escapeHtml(entry.company)}</h3>
            ${entry.industry ? `<span class="pill industry">${escapeHtml(entry.industry)}</span>` : ''}
            <span class="country">${escapeHtml(entry.country)}</span>
          </div>
          <ol class="signals">${entry.signals.map(signalRow).join('')}</ol>
        </section>
        <section class="business-box">
          <p class="business-head">
            <span class="business-heading">${escapeHtml(entry.business.heading)}</span>
            ${entry.business.target_text ? `
            <span class="pill target">${marker}${escapeHtml(entry.business.target_label)}</span>
            <span class="target-text">${escapeHtml(entry.business.target_text)}</span>` : ''}
          </p>
          <p class="business-body">${escapeHtml(entry.business.body)}</p>
          <p class="source">${escapeHtml(entry.business.source)}</p>
        </section>
      </div>`)).join('');
}

const itemCard = (items, card) => `
        <article class="item-card">
          <div class="detail-head">
            <h3>${escapeHtml(card.company)}</h3>
            ${card.industry ? `<span class="pill industry">${escapeHtml(card.industry)}</span>` : ''}
            <span class="country">${escapeHtml(card.country)}</span>
          </div>
          <p class="item-target">
            <span class="pill">${escapeHtml(items.target_label)}</span>
            <span class="target-text">${escapeHtml(card.target_text)}</span>
          </p>
          <p class="item-trend-label"><span class="pill">${escapeHtml(items.trend_label)}</span></p>
          <p class="item-body">${escapeHtml(card.body)}</p>
          <p class="source">${escapeHtml(card.source)}</p>
        </article>`;

// `breaks` holds the card indices that start a new sheet. The builder works
// them out from the heights Chrome reports, because a card is as tall as its
// own text and only the engine that laid it out knows how tall that is. With
// no breaks every card goes on one sheet, which is what the current data needs.
function itemPages(state, model, breaks = []) {
  const { items } = model;
  if (!items || !items.cards.length) return '';
  const sheets = [];
  items.cards.forEach((card, index) => {
    if (!sheets.length || breaks.includes(index)) sheets.push([]);
    sheets[sheets.length - 1].push(card);
  });
  return sheets.map((cards, index) => page(state, `
      ${header(items.kicker, items.title, `${index + 1}/${sheets.length}`)}
      <div class="items${index === 0 ? ' first' : ''}">
        ${index === 0 ? `<p class="matrix-desc">${escapeHtml(items.note)}</p>` : ''}
        ${cards.map(card => itemCard(items, card)).join('')}
      </div>`)).join('');
}

// `assets` is a URL prefix for fonts and images: a file:// directory when
// printing, a served path when the same markup is a web page.
export function renderReport(model, { assets = '', itemBreaks = [] } = {}) {
  const state = { number: 0, footer: model.footer };
  return `<!doctype html>
<html lang="${escapeHtml(model.lang)}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(model.footer)}</title>
<style>${styles(assets)}</style>
</head>
<body>
${coverPage(state, model, assets)}
${matrixPages(state, model)}
${model.details ? detailPages(state, model, assets) : ''}
${itemPages(state, model, itemBreaks)}
</body>
</html>
`;
}

function styles(assets) {
  return `
/* The static cuts, not the 10MB variable file: Chrome embeds what it is given
   and a variable face lands in the PDF an order of magnitude heavier. These are
   the same four weights build_pdf_report.py instantiates. */
@font-face { font-family: 'Noto Sans KR'; src: url('${assets}/fonts/NotoSansKR-DemiLight.ttf') format('truetype'); font-weight: 350; font-display: block; }
@font-face { font-family: 'Noto Sans KR'; src: url('${assets}/fonts/NotoSansKR-Medium.ttf') format('truetype'); font-weight: 500; font-display: block; }
@font-face { font-family: 'Noto Sans KR'; src: url('${assets}/fonts/NotoSansKR-SemiBold.ttf') format('truetype'); font-weight: 600; font-display: block; }
@font-face { font-family: 'Noto Sans KR'; src: url('${assets}/fonts/NotoSansKR-ExtraBold.ttf') format('truetype'); font-weight: 800; font-display: block; }
@page { size: ${PAGE_WIDTH_PT}pt ${PAGE_HEIGHT_PT}pt; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: 'Noto Sans KR', sans-serif;
  font-weight: 350;
  color: ${COLORS.text};
  -webkit-font-smoothing: antialiased;
}
.page {
  position: relative;
  width: ${PAGE_WIDTH_PT}pt;
  height: ${PAGE_HEIGHT_PT}pt;
  overflow: hidden;
  background: #fff;
  break-after: page;
}
.page:last-of-type { break-after: auto; }

/* ---- shared chrome ---- */
.header {
  height: 100pt;
  padding: 27pt 43pt 0;
  background: ${COLORS.navy};
  border-bottom: 8pt solid ${COLORS.gold};
}
.header .kicker { margin: 0; font-size: 9pt; font-weight: 500; color: ${COLORS.gold}; white-space: pre-wrap; }
.header h2 { margin: -2pt 0 0; font-size: 22pt; font-weight: 600; color: #fff; }
.footer {
  position: absolute;
  inset: auto 0 0 0;
  height: 38pt;
  padding: 0 42pt;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: ${COLORS.footerBg};
  border-top: 0.7pt solid ${COLORS.tableLine};
  font-size: 8pt;
  color: ${COLORS.muted};
}
.footer .folio { font-weight: 600; color: ${COLORS.text}; }
.body { padding: 16pt 17pt 0 25pt; }

/* ---- cover ---- */
/* The cover's anchor points are design constants, so they are placed rather
   than flowed. What HTML is here for is inside each block: the title shrinks
   to fit, and a long indicator label pushes its description instead of being
   overprinted by it. */
.cover {
  background: ${COLORS.navy};
  border-top: 8pt solid ${COLORS.gold};
  color: #fff;
}
.cover > * { position: absolute; left: 43pt; right: 43pt; }
.cover .issue { top: 30pt; text-align: right; }
.issue-label { margin: 0; font-size: 18pt; font-weight: 600; }
.issue-month { margin: 3pt 0 0; font-size: 10pt; font-weight: 500; color: ${COLORS.onNavy}; }
.cover-body { top: 185pt; bottom: 76pt; }
.cover-kicker {
  margin: 0;
  font-size: 12pt;
  font-weight: 500;
  color: ${COLORS.gold};
  /* The kicker spaces its letters with real spaces; collapsing them runs the
     words together. */
  white-space: pre-wrap;
}
.cover h1 {
  margin: 11pt 0 0;
  /* Overridden per language: the size that fits comes with the view model. */
  font-size: 36pt;
  font-weight: 600;
  line-height: 45pt;
  /* Korean breaks between any two syllables unless told otherwise. */
  word-break: keep-all;
}
.cover h1 span { display: block; }
.cover h1 .accent { color: ${COLORS.gold}; }
.cover-lines { margin: 22pt 0 0; font-size: 12pt; line-height: 20pt; }
.cover-lines p { margin: 0; word-break: keep-all; }
.cover-indicator-heading { margin: 33pt 0 0; font-size: 9pt; color: ${COLORS.onNavy}; }
.cover-indicators { margin: 13pt 0 0; padding: 0; list-style: none; }
.cover-indicators li {
  display: flex;
  align-items: baseline;
  gap: 11pt;
  height: 32pt;
}
.cover-indicators .badge {
  flex: none;
  /* The ring hangs 7pt outside the text margin, as it does on the drawn cover,
     which is also what leaves the description its full measure. */
  margin-left: -7pt;
  width: 20pt;
  height: 20pt;
  border: 1.2pt solid ${COLORS.gold};
  border-radius: 50%;
  color: ${COLORS.gold};
  font-size: 9pt;
  font-weight: 600;
  line-height: 18pt;
  text-align: center;
  /* Centred on the label's own optical middle, not on the row box. */
  align-self: flex-start;
  margin-top: 0.8pt;
}
/* The label keeps its line and the description gives up room first, which is
   the priority the hand-fitted version had to compute. Here the two just
   negotiate: nothing overprints and nothing pushes a row out of its rhythm. */
.cover-indicators .label {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 12pt;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* The description takes the room the label leaves and shrinks rather than
   overprinting it, which is what the hand-fitted version had to guard against. */
.cover-indicators .desc {
  /* Grow into the slack, but give room up far faster than the label does, so a
     long label shortens the description rather than itself. */
  flex: 1 999 auto;
  min-width: 0;
  padding-left: 16pt;
  font-size: 8pt;
  color: ${COLORS.onNavy};
  text-align: right;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cover-foot {
  bottom: 0;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  padding: 8pt 0 20pt;
  border-top: 0.7pt solid ${COLORS.divider};
}
.logo-kotra { height: 34pt; }
.logo-ik { height: 32pt; }

/* ---- matrix ---- */
/* ---- item-linked business trends ---- */
/* Cards are as tall as their own text; which sheet each lands on is settled by
   the builder from measured heights, not by a running total of constants. */
.items { position: absolute; top: 114pt; left: 30pt; right: 30pt; }
.items.first { top: 116pt; }
.items .matrix-desc { margin: 0 0 18pt; }
.item-card {
  margin-bottom: 14pt;
  padding: 0 0 15.2pt;
  background: #fff;
  border: 0.9pt solid ${COLORS.boxLine};
  border-radius: 10pt;
  break-inside: avoid;
}
.item-card .detail-head { padding: 11pt 0 16pt; }
.item-card .detail-head h3 { font-size: 13pt; }
.item-card .detail-head .country { margin-left: auto; }
.item-target, .item-trend-label { display: flex; align-items: baseline; gap: 10pt; margin: 10.7pt 16.1pt 0; }
.item-target .pill, .item-trend-label .pill { padding: 1.2pt 7pt 2.6pt; font-size: 7.6pt; }
.item-target .target-text {
  flex: 0 1 auto;
  min-width: 0;
  /* Tighten the leading so the row's baseline is set close to the pill's own,
     which is what puts the pill 10pt above the line it shares. */
  line-height: 1;
  font-size: 9.5pt;
  font-weight: 600;
  color: ${COLORS.text};
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.item-trend-label { margin-top: 10.4pt; }
.item-body {
  margin: 4.7pt 16.1pt 0;
  font-size: 8.8pt;
  line-height: 10.8pt;
  color: #000;
  word-break: keep-all;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
  overflow: hidden;
}
.item-card .source { margin: 2pt 16.1pt 0; font-size: 7.1pt; color: ${COLORS.muted}; }

/* ---- company detail ---- */
/* The drawn page decides how many lines of each summary to show by trying a
   ladder of line counts until one fits. Here each row is as tall as its own
   text and the boxes follow, so there is nothing to search for; the clamps
   below are the same ceilings that ladder topped out at. */
.detail { position: absolute; top: 114pt; left: 30pt; right: 30pt; }
.signal-box, .business-box {
  border: 0.9pt solid ${COLORS.boxLine};
  border-radius: 10pt;
}
.signal-box { background: #fff; padding: 0 0 24pt; }
.detail-head {
  display: flex;
  align-items: baseline;
  gap: 14pt;
  margin: 0 16.3pt;
  padding: 9.5pt 0 17.2pt;
  border-bottom: 1pt solid #000;
}
.detail-head h3 { margin: 0; font-size: 14pt; font-weight: 600; white-space: nowrap; }
.detail-head .country { font-size: 9pt; font-weight: 600; color: ${COLORS.grey}; white-space: nowrap; }
.pill {
  display: inline-block;
  padding: 2pt 9pt;
  border-radius: 3pt;
  background: ${COLORS.light};
  font-size: 9pt;
  font-weight: 600;
  color: ${COLORS.pill};
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.detail-head .industry { flex: 0 1 auto; min-width: 0; max-width: 190pt; }
/* The box border sits inside its 480pt, so the padding is short by it and
   the row separators still span 49pt to 491pt. */
.signals { margin: 0; padding: 9.6pt 18.1pt 0; list-style: none; }
.signal { position: relative; display: flex; gap: 15pt; padding-bottom: 10pt; }
.signal + .signal { padding-top: 6pt; }
/* Drawn rather than a border: a border would add its own width to the row and
   walk every row below it down the page. */
.signal:not(:last-child)::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  border-top: 0.9pt solid ${COLORS.boxLine};
}
.signal .badge {
  flex: none;
  width: 16pt;
  height: 16pt;
  border-radius: 3pt;
  background: ${COLORS.navy};
  color: #fff;
  font-size: 9pt;
  font-weight: 600;
  line-height: 16pt;
  text-align: center;
}
.signal.off .badge { background: #D8DADF; }
.signal-body { flex: 1; min-width: 0; }
/* A silent row still occupies the 21pt the drawn page gives it. */
.signal.off .signal-body { padding-bottom: 5pt; }
/* The gap under the last row belongs to the box, not to the row. */
.signal:last-child { padding-bottom: 0; }
.signal-head { display: flex; align-items: baseline; gap: 18pt; height: 16pt; margin: 0; }
.signal-head .pill { flex: 0 1 auto; min-width: 0; padding: 2pt 8pt; font-size: 7.6pt; }
.signal-head .empty { flex: 0 1 auto; min-width: 0; font-size: 10pt; color: ${COLORS.faint}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.signal-head .dash { margin-left: auto; margin-right: 12pt; font-size: 10pt; color: ${COLORS.faint}; }
.summary {
  margin: 3.6pt 0 0;
  /* The summary column is narrower than the row: the drawn page reserves the
     right end of the row for nothing, and the wrapping must match. */
  max-width: 378pt;
  font-size: 8.8pt;
  line-height: 10.4pt;
  word-break: keep-all;
  /* The ladder stopped at six lines; past that a summary is cut, not carried. */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 6;
  overflow: hidden;
}
.summary strong { font-weight: 600; }
.summary.continued { margin-top: 0; }
.signal .source, .business-box .source { margin: 2.4pt 0 0; font-size: 7.1pt; color: ${COLORS.muted}; }
/* The drawn row keeps 2.5pt under the source line before its separator. */
.signal .source { max-width: 378pt; padding-bottom: 2.6pt; }
.business-box {
  margin-top: 15.2pt;
  min-height: 88pt;
  padding: 11.2pt 15.3pt 22.2pt;
  background: ${COLORS.tealBg};
  border-color: ${COLORS.tealLine};
}
/* A target name too long to sit beside its label drops to a line of its own
   and gets the whole box width, which is what the drawn page arranges by
   measuring first and growing the box by a fixed 15pt. */
.business-head { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 9pt; row-gap: 4.6pt; margin: 0; }
.business-heading {
  font-size: 8.5pt;
  font-weight: 600;
  color: ${COLORS.teal};
  letter-spacing: 0.85pt;
  margin-right: 9pt;
  white-space: nowrap;
}
.business-head .target {
  display: inline-flex;
  align-items: center;
  gap: 5pt;
  background: #DDF0EE;
  color: ${COLORS.teal};
  font-size: 8.5pt;
}
.business-head .marker { width: 11pt; height: 11pt; }
.target-text {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 9.5pt;
  font-weight: 600;
  color: ${COLORS.teal};
  word-break: keep-all;
}
.business-body {
  margin: 6.4pt 0 0;
  font-size: 9pt;
  line-height: 10.35pt;
  word-break: keep-all;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 9;
  overflow: hidden;
}
.business-box .source { margin-top: 7.1pt; font-size: 8pt; }

.matrix-desc {
  margin: 0 0 5pt;
  font-size: 8pt;
  line-height: 1.5;
  color: ${COLORS.bodyGrey};
  text-align: justify;
  word-break: keep-all;
}
.matrix-columns { display: flex; align-items: flex-start; gap: 14pt; }
table.matrix { flex: 1; border-collapse: collapse; table-layout: fixed; }
table.matrix th {
  height: 16pt;
  padding: 0 7pt;
  background: ${COLORS.navy};
  color: #fff;
  font-size: 8pt;
  font-weight: 600;
  text-align: left;
}
table.matrix th.col-signal { width: 18pt; padding: 0; font-size: 7pt; text-align: center; }
table.matrix td {
  height: 12.8pt;
  padding: 0;
  border-bottom: 0.45pt solid ${COLORS.tableLine};
  font-size: 6pt;
  color: ${COLORS.text};
}
table.matrix td.no { width: 22pt; color: ${COLORS.rowNo}; text-align: center; }
table.matrix td.cell { text-align: center; }
table.matrix td.company { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
i.on, i.off, i.unknown { display: inline-block; width: 8.2pt; height: 8.2pt; border-radius: 2pt; }
i.on { background: ${COLORS.gold}; }
/* 채운 점: 검토했고 신호가 없었다. 테두리만: 검토를 못 해 모른다. */
i.off { background: ${COLORS.light}; }
i.unknown { background: transparent; box-shadow: inset 0 0 0 0.6pt ${COLORS.tableLine}; }
.matrix-tail { position: absolute; top: 671pt; left: 25pt; right: 17pt; }
.matrix-legend {
  display: flex;
  gap: 18pt;
  font-size: 8pt;
  color: ${COLORS.legend};
}
.matrix-legend span { display: flex; align-items: center; gap: 5pt; }
.matrix-indicators { margin: 6pt 0 0; font-size: 7pt; color: ${COLORS.muted}; }
.matrix-footnote { margin: 7pt 0 0; font-size: 8pt; font-weight: 800; color: ${COLORS.text}; }
`;
}
