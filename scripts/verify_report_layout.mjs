// Check the HTML report against the coordinates the reportlab report draws at.
//
// Porting a page is only finished when it lands where the old one did, and
// comparing rendered pictures by eye does not say by how much. This asks Chrome
// where each run of text actually sits and prints the difference in points, so
// the next page to be ported has an acceptance test rather than an opinion.
//
//   node scripts/verify_report_layout.mjs --html outputs/html_report/report_ko.html

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { browserCandidates, run } from './build_html_report.mjs';

// [selector, expected distance from the top of its own page, what to measure]
// Baselines come from build_pdf_report.py, converted from its bottom-left
// origin: a run drawn at y is PAGE_H - y from the top.
export const EXPECTED = [
  ['.cover-kicker', 208, 'baseline'],
  ['.cover h1 span:nth-child(1)', 264, 'baseline'],
  ['.cover h1 span:nth-child(2)', 309, 'baseline'],
  ['.cover h1 span:nth-child(3)', 354, 'baseline'],
  ['.cover-lines p:nth-child(1)', 396, 'baseline'],
  ['.cover-lines p:nth-child(2)', 416, 'baseline'],
  ['.cover-indicator-heading', 461, 'baseline'],
  ['.cover-indicators li:nth-child(1) .badge', 475, 'top'],
  ['.cover-indicators li:nth-child(1) .label', 490, 'baseline'],
  ['.cover-indicators li:nth-child(5) .label', 618, 'baseline'],
  ['.page:nth-of-type(2) .header .kicker', 39, 'baseline'],
  ['.page:nth-of-type(2) .header h2', 66, 'baseline'],
  ['.page:nth-of-type(2) .matrix-desc', 128, 'baseline'],
  ['.page:nth-of-type(2) table.matrix', 145, 'top'],
  ['.page:nth-of-type(2) table.matrix tbody tr:nth-child(1) .company', 170.1, 'baseline'],
  ['.page:nth-of-type(2) table.matrix tbody tr:nth-child(39) .company', 656.8, 'baseline'],
  ['.page:nth-of-type(2) .matrix-legend', 683, 'baseline'],
  ['.page:nth-of-type(2) .matrix-indicators', 698, 'baseline'],
  ['.page:nth-of-type(2) .matrix-footnote', 716, 'baseline'],
  ['.page:nth-of-type(2) table.matrix', 25, 'left'],
  ['.page:nth-of-type(2) table.matrix', 242, 'width'],
];

const TOLERANCE_PT = 1;

const measureScript = `<script>
const PT = 96 / 72;
function measure(sel, mode) {
  const el = document.querySelector(sel);
  if (!el) return null;
  const box = el.getBoundingClientRect();
  if (mode === 'width') return +(box.width / PT).toFixed(1);
  if (mode === 'left') return +(box.left / PT).toFixed(1);
  const origin = el.closest('.page').getBoundingClientRect().top;
  if (mode === 'top') return +((box.top - origin) / PT).toFixed(1);
  // A zero-width inline box shares the line's baseline, and its bottom is that
  // baseline; there is no direct way to read one.
  const probe = document.createElement('span');
  probe.textContent = 'X';
  probe.style.cssText = 'display:inline-block;width:0;overflow:hidden';
  el.insertBefore(probe, el.firstChild);
  const baseline = probe.getBoundingClientRect().bottom;
  probe.remove();
  return +((baseline - origin) / PT).toFixed(1);
}
const measured = EXPECTED_JSON.map(([sel, , mode]) => measure(sel, mode));
document.title = 'LAYOUT' + JSON.stringify(measured) + 'END';
</script>`;

async function measure(htmlPath) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'report-verify-'));
  const source = await fs.readFile(htmlPath, 'utf8');
  const probePath = path.join(path.dirname(htmlPath), '.layout-probe.html');
  const script = measureScript.replace('EXPECTED_JSON', JSON.stringify(EXPECTED));
  await fs.writeFile(probePath, source.replace('</body>', `${script}</body>`), 'utf8');
  const args = ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--user-data-dir=${work}`, '--virtual-time-budget=10000',
    '--dump-dom', pathToFileURL(probePath).href];
  try {
    for (const command of browserCandidates()) {
      const dom = await run(command, args, { capture: true }).catch(() => null);
      if (dom === null) continue;
      const found = /LAYOUT(\[.*?\])END/s.exec(dom);
      if (found) return JSON.parse(found[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    }
  } finally {
    await fs.rm(work, { recursive: true, force: true });
    await fs.rm(probePath, { force: true });
  }
  throw new Error('Could not measure the page: no browser produced a result.');
}

async function main() {
  const index = process.argv.indexOf('--html');
  if (index < 0) throw new Error('--html <file> is required');
  const measured = await measure(path.resolve(process.argv[index + 1]));
  let worst = 0;
  let missing = 0;
  for (const [i, [selector, expected, mode]] of EXPECTED.entries()) {
    const value = measured[i];
    if (value === null) {
      missing += 1;
      console.log(`MISSING  ${selector}`);
      continue;
    }
    const delta = +(value - expected).toFixed(1);
    worst = Math.max(worst, Math.abs(delta));
    const mark = Math.abs(delta) > TOLERANCE_PT ? 'OFF ' : '    ';
    console.log(`${mark} ${selector} [${mode}]  expected ${expected}  got ${value}  ${delta > 0 ? '+' : ''}${delta}pt`);
  }
  console.log(`\nworst deviation ${worst.toFixed(1)}pt (tolerance ${TOLERANCE_PT}pt), ${missing} selector(s) missing`);
  if (worst > TOLERANCE_PT || missing) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
