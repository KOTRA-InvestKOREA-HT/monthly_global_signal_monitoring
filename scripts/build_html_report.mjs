// Build the report by rendering HTML and printing it with headless Chrome.
//
// Chrome is driven through its own command line rather than a driver library.
// Nothing else in scripts/ needs node_modules, the workflow installs no npm
// packages, and the GitHub runner and this machine both already have a browser;
// a driver would buy control this page does not need, since the markup is static
// and its fonts are local files.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ITEM_BAND, renderReport } from './report_html.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEW_MODEL = path.join(ROOT, 'scripts', 'report_view_model.py');

export function browserCandidates() {
  const programFiles = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA];
  const windows = programFiles.filter(Boolean).flatMap(base => [
    path.join(base, 'Google/Chrome/Application/chrome.exe'),
    path.join(base, 'Microsoft/Edge/Application/msedge.exe'),
  ]);
  return [
    process.env.CHROME_PATH,
    // The GitHub-hosted Ubuntu runner ships these on PATH.
    'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
    ...windows,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean).filter((value, index, all) => all.indexOf(value) === index);
}

export function run(command, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    if (capture) child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => (code === 0
      ? resolve(stdout)
      : reject(new Error(`${command} exited ${code}: ${stderr.trim().slice(0, 300)}`))));
  });
}

async function printPdf(htmlPath, pdfPath) {
  // A throwaway profile: without one Chrome may attach to the signed-in
  // browser already running on a desktop and never print.
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'report-chrome-'));
  const args = [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--user-data-dir=${profile}`,
    '--no-pdf-header-footer',
    // Let webfonts and layout settle before the snapshot.
    '--virtual-time-budget=10000',
    '--run-all-compositor-stages-before-draw',
    `--print-to-pdf=${pdfPath}`,
    pathToFileURL(htmlPath).href,
  ];
  const failures = [];
  try {
    for (const command of browserCandidates()) {
      try {
        await run(command, args);
        return command;
      } catch (error) {
        failures.push(`${command}: ${error.message}`);
      }
    }
  } finally {
    await fs.rm(profile, { recursive: true, force: true });
  }
  throw new Error(`No usable Chrome or Edge found. Set CHROME_PATH.\n${failures.join('\n')}`);
}

// Ask the browser how tall each trend card came out. The drawn report adds up
// line counts and padding constants to predict this; the engine that laid the
// cards out already knows, so the sheets are cut from measurement instead.
const CARD_HEIGHTS = `<script>
document.title = 'CARDS' + JSON.stringify([...document.querySelectorAll('.item-card')]
  .map(card => card.getBoundingClientRect().height / (96 / 72))) + 'END';
</script>`;

async function cardHeights(html, near) {
  const probePath = path.join(path.dirname(near), '.card-probe.html');
  await fs.writeFile(probePath, html.replace('</body>', `${CARD_HEIGHTS}</body>`), 'utf8');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'report-cards-'));
  const args = ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--user-data-dir=${work}`, '--virtual-time-budget=10000', '--dump-dom', pathToFileURL(probePath).href];
  try {
    for (const command of browserCandidates()) {
      const dom = await run(command, args, { capture: true }).catch(() => null);
      const found = dom && /CARDS(\[.*?\])END/s.exec(dom);
      if (found) return JSON.parse(found[1]);
    }
  } finally {
    await fs.rm(work, { recursive: true, force: true });
    await fs.rm(probePath, { force: true });
  }
  throw new Error('Could not measure the trend cards.');
}

// A card that would cross the band's bottom starts the next sheet instead.
function greedyBreaks(heights) {
  const breaks = [];
  let cursor = ITEM_BAND.firstTop;
  let onSheet = 0;
  heights.forEach((height, index) => {
    if (onSheet && cursor + height > ITEM_BAND.bottom) {
      breaks.push(index);
      cursor = ITEM_BAND.top;
      onSheet = 0;
    }
    cursor += height + ITEM_BAND.gap;
    onSheet += 1;
  });
  return breaks;
}

// 한 장에 들어갈 카드들이 실제로 띠 안에 들어가는지. 띠보다 큰 카드 하나는 greedy 와
// 같이 그대로 둔다. 저 혼자서는 어느 장에도 들어가지 않기 때문이다.
function sheetFits(heights, from, to, first) {
  let cursor = first ? ITEM_BAND.firstTop : ITEM_BAND.top;
  for (let index = from; index < to; index += 1) {
    if (index > from && cursor + heights[index] > ITEM_BAND.bottom) return false;
    cursor += heights[index] + ITEM_BAND.gap;
  }
  return true;
}

const planFits = (heights, breaks) => [0, ...breaks, heights.length]
  .slice(0, -1).every((from, i) => sheetFits(heights, from, [...breaks, heights.length][i], i === 0));

// 장수를 고정한 채 카드 수를 고르게 나눈 지점. 첫 장은 안내문 때문에 띠가 좁으므로
// 남는 카드는 뒤쪽 장에 준다.
function evenBreaks(count, sheets) {
  const base = Math.floor(count / sheets);
  const extra = count % sheets;
  const breaks = [];
  let cursor = 0;
  for (let sheet = 0; sheet < sheets - 1; sheet += 1) {
    cursor += base + (sheet >= sheets - extra ? 1 : 0);
    breaks.push(cursor);
  }
  return breaks;
}

// greedy 는 앞 장을 가득 채우므로 마지막 장에 카드가 하나만 남을 수 있다. 그 장은 거의
// 백지가 된다. 34564332764 영문판이 품목 카드 4장을 3+1 로 갈라 마지막 쪽의 70%가 비었다.
// greedy 가 정한 장수는 그대로 두고(쪽수는 늘리지 않는다) 그 안에서 고르게 나눈다.
// 고른 분할이 띠에 안 들어가면 greedy 를 쓴다. 카드 높이는 제각각이라 늘 되지는 않는다.
const sheetSpread = (count, breaks) => {
  const edges = [...breaks, count];
  const sizes = edges.map((edge, i) => edge - (i ? edges[i - 1] : 0));
  return Math.max(...sizes) - Math.min(...sizes);
};

export function itemBreaks(heights) {
  const greedy = greedyBreaks(heights);
  if (!greedy.length) return greedy;
  const even = evenBreaks(heights.length, greedy.length + 1);
  // greedy 가 이미 고르게 갈렸으면 그대로 둔다. 앞 장을 채우는 편이 낫고, 같은 고르기를
  // 위해 카드를 뒤로 미룰 이유가 없다. 더 고를 때만, 그리고 들어갈 때만 바꾼다.
  if (sheetSpread(heights.length, even) >= sheetSpread(heights.length, greedy)) return greedy;
  return planFits(heights, even) ? even : greedy;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) throw new Error(`Unexpected argument: ${argv[i]}`);
    args[argv[i].slice(2)] = argv[i + 1] ?? '';
  }
  return args;
}

async function viewModel(args) {
  if (args['view-model']) return JSON.parse(await fs.readFile(args['view-model'], 'utf8'));
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'report-vm-'));
  const out = path.join(work, 'view-model.json');
  // report_view_model.py 가 받는 것은 전부 넘긴다. 빠뜨리면 호출부가 명시한 경로가
  // 조용히 무시되고 기본값이 쓰인다. --relevant 가 그렇게 빠져 있었다.
  const pass = ['signals', 'summary', 'relevant', 'investment-signals', 'indicator-config', 'targets',
    'technology-map', 'font', 'issue-number', 'lang', 'ignored-signals', 'from-date', 'to-date'];
  try {
    await run(process.env.PYTHON || 'python', ['-X', 'utf8', VIEW_MODEL,
      ...pass.flatMap(name => (args[name] ? [`--${name}`, args[name]] : [])), '--out', out]);
    return JSON.parse(await fs.readFile(out, 'utf8'));
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out) throw new Error('--out is required');
  const model = await viewModel(args);
  // Chrome resolves relative URLs against the document, so the HTML has to sit
  // where it can still see assets/. A sibling of the output keeps both true.
  const outPath = path.resolve(args.out);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const htmlPath = args.html ? path.resolve(args.html) : `${outPath.replace(/\.pdf$/i, '')}.html`;
  const assets = pathToFileURL(path.join(ROOT, 'assets')).href;
  let html = renderReport(model, { assets });
  let breaks = [];
  if (model.items?.cards?.length > 1) {
    breaks = itemBreaks(await cardHeights(html, htmlPath));
    if (breaks.length) html = renderReport(model, { assets, itemBreaks: breaks });
  }
  await fs.writeFile(htmlPath, html, 'utf8');
  const browser = await printPdf(htmlPath, outPath);
  console.log(JSON.stringify({
    output: outPath, html: htmlPath, browser, lang: model.lang,
    company_count: model.matrix.rows.length,
    matrix_counts: model.matrix.counts,
    item_cards: model.items?.cards?.length ?? 0,
    item_pages: model.items?.cards?.length ? breaks.length + 1 : 0,
  }, null, 2));
}

// Importable for the layout verifier, which needs the same browser lookup.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
