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
import { renderReport } from './report_html.mjs';

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
  const out = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'report-vm-')), 'view-model.json');
  const pass = ['signals', 'summary', 'investment-signals', 'indicator-config', 'targets',
    'technology-map', 'font', 'issue-number', 'lang', 'ignored-signals', 'from-date', 'to-date'];
  await run(process.env.PYTHON || 'python', ['-X', 'utf8', VIEW_MODEL,
    ...pass.flatMap(name => (args[name] ? [`--${name}`, args[name]] : [])), '--out', out]);
  return JSON.parse(await fs.readFile(out, 'utf8'));
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
  await fs.writeFile(htmlPath, renderReport(model, { assets }), 'utf8');
  const browser = await printPdf(htmlPath, outPath);
  console.log(JSON.stringify({
    output: outPath, html: htmlPath, browser, lang: model.lang,
    company_count: model.matrix.rows.length,
    matrix_counts: model.matrix.counts,
  }, null, 2));
}

// Importable for the layout verifier, which needs the same browser lookup.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
