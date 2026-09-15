// 웹 다운로드용 보고서 PDF. Actions 와 같은 HTML(renderReport)과 같은 품목 카드 나눔(itemBreaks)을 쓰고
// 인쇄만 puppeteer 로 한다. build_html_report.mjs 는 Chrome 명령줄로 인쇄한다(Actions 는 npm 패키지를
// 설치하지 않는다). 서버리스 함수에는 명령줄로 띄울 Chrome 이 없어 @sparticuz/chromium 을 puppeteer 로 띄운다.
// 예전 웹 다운로드는 무시한 시그널이 있으면 reportlab 으로 모양이 다른 보고서를 만들었고, 없으면 정적 PDF 위에
// reportlab 좌표로 호수를 덧그려 HTML 표지의 보고월 줄을 가렸다.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { browserCandidates, itemBreaks } from '../../scripts/build_html_report.mjs';
import { renderReport } from '../../scripts/report_html.mjs';

// build_html_report.mjs 의 cardHeights 와 같은 측정이다. CSS px 를 pt 로 바꾼다.
const measureCards = () => [...document.querySelectorAll('.item-card')]
  .map(card => card.getBoundingClientRect().height / (96 / 72));

export async function browserLaunchOptions(puppeteer, env = process.env) {
  if (env.VERCEL === '1') {
    const { default: chromium } = await import('@sparticuz/chromium');
    return {
      args: await puppeteer.defaultArgs({ args: chromium.args, headless: 'shell' }),
      executablePath: await chromium.executablePath(),
      headless: 'shell',
    };
  }
  for (const candidate of browserCandidates()) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      await fs.access(candidate);
      return { executablePath: candidate, headless: true, args: ['--no-sandbox'] };
    } catch { /* 다음 후보 */ }
  }
  throw new Error('보고서를 인쇄할 Chrome 또는 Edge 를 찾지 못했습니다. CHROME_PATH 를 지정하세요.');
}

export async function printReportPdf(model, { puppeteer, launch, assetsDir }) {
  // 글꼴·이미지를 file:// 로 읽으므로 문서도 file:// 로 연다.
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'report-web-'));
  const htmlPath = path.join(work, 'report.html');
  const assets = pathToFileURL(assetsDir).href;
  const browser = await puppeteer.launch(launch);
  try {
    const page = await browser.newPage();
    const open = async html => {
      await fs.writeFile(htmlPath, html, 'utf8');
      await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
      await page.evaluate(async () => { await document.fonts.ready; });
    };
    await open(renderReport(model, { assets }));
    if (model.items?.cards?.length > 1) {
      const breaks = itemBreaks(await page.evaluate(measureCards));
      if (breaks.length) await open(renderReport(model, { assets, itemBreaks: breaks }));
    }
    return Buffer.from(await page.pdf({ printBackground: true, preferCSSPageSize: true }));
  } finally {
    await browser.close().catch(() => {});
    await fs.rm(work, { recursive: true, force: true });
  }
}
