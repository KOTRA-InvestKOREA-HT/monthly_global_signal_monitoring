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
  muted: '#8591A3',
  onNavy: '#C8D2DF',
  legend: '#596579',
  bodyGrey: '#555F6E',
  footerBg: '#EFF4F8',
  divider: '#D6DEE9',
  rowNo: '#737C86',
};

// Rows per matrix column, from the page geometry: the table starts 145pt down,
// each row is 12.8pt, and the legend needs the last 92pt. The reportlab page
// hard-codes profiles[:39]/[39:] instead and silently overruns the legend once
// the target list passes about 81 companies.
export const MATRIX_ROWS_PER_COLUMN = 39;
const MATRIX_COLUMNS_PER_PAGE = 2;

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

const header = (kicker, title) => `
      <header class="header">
        <p class="kicker">${escapeHtml(kicker)}</p>
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
              ${row.signals.map(on => `<td class="cell"><i class="${on ? 'on' : 'off'}"></i></td>`).join('')}
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
        </div>
        <p class="matrix-indicators">${escapeHtml(matrix.indicators)}</p>
        <p class="matrix-footnote">${escapeHtml(matrix.footnote)}</p>
      </div>` : ''}`)).join('');
}

// `assets` is a URL prefix for fonts and images: a file:// directory when
// printing, a served path when the same markup is a web page.
export function renderReport(model, { assets = '' } = {}) {
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
</body>
</html>
`;
}

function styles(assets) {
  return `
@font-face {
  font-family: 'Noto Sans KR VF';
  src: url('${assets}/fonts/NOTOSANSKR-VF.TTF') format('truetype-variations');
  font-weight: 100 900;
  font-display: block;
}
@page { size: ${PAGE_WIDTH_PT}pt ${PAGE_HEIGHT_PT}pt; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: 'Noto Sans KR VF', 'Noto Sans KR', sans-serif;
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
i.on, i.off { display: inline-block; width: 8.2pt; height: 8.2pt; border-radius: 2pt; }
i.on { background: ${COLORS.gold}; }
i.off { background: ${COLORS.light}; }
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
