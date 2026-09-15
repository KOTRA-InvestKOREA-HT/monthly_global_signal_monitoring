import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { browserLaunchOptions, printReportPdf } from '../app/lib/report_pdf.mjs';

const model = {
  lang: 'ko',
  issue: { label: 'Issue 3', month: '2026.09' },
  footer: 'Invest KOREA · Issue 3',
  cover: { kicker: 'G L O B A L', titles: ['타겟기업', '글로벌 투자시그널', '모니터링'], lines: ['첫 줄', '둘째 줄'],
    indicator_heading: '5대 투자동향 지표', indicators: [{ no: 1, label: '공급망', description: '설명' }] },
  matrix: { kicker: 'S I G N A L   M A T R I X', title: '매트릭스', description: '설명', company_heading: '기업',
    legend_on: '포착', legend_off: '미포착', indicators: '① 공급망', footnote: '각주',
    counts: { detected: 0, reviewed_off: 1, insufficient: 0, total: 1 },
    rows: [{ target_no: 1, company: 'Company 1', signals: [false, false, false, false, false] }] },
  items: { kicker: 'T A R G E T - I T E M   S I G N A L S', title: '품목별 글로벌 사업동향', note: '안내',
    target_label: '투자유치 필요 품목·기술', trend_label: '8월 글로벌 사업동향',
    cards: ['A', 'B', 'C'].map(company => ({ company, industry: '소재', country: '미국', target_text: '양극재',
      body: '본문', source: '출처 Newsroom 2026.08.05' })) },
};

// 웹 다운로드는 Actions 와 같은 HTML 을 그리고, 브라우저가 잰 카드 높이로 품목 장을 다시 나눈 뒤 인쇄한다.
test('the web download prints the report HTML, re-cut at the item-card breaks the browser measured', async () => {
  const opened = [];
  const printed = [];
  let launchedWith = null;
  let closed = false;
  const page = {
    goto: async url => { opened.push(await fs.readFile(new URL(url), 'utf8')); },
    // 카드 셋이 한 장에 들어가지 않는 높이를 돌려준다. 글꼴 대기는 값이 없다.
    evaluate: async fn => (String(fn).includes('item-card') ? [300, 300, 300] : undefined),
    pdf: async options => { printed.push(options); return new Uint8Array([37, 80, 68, 70]); },
  };
  const puppeteer = { launch: async options => {
    launchedWith = options;
    return { newPage: async () => page, close: async () => { closed = true; } };
  } };
  const output = await printReportPdf(model, { puppeteer, launch: { headless: true }, assetsDir: 'assets' });
  assert.deepEqual(launchedWith, { headless: true });
  assert.equal(opened.length, 2);
  assert.equal(opened[0].split('<section class="page').length - 1, 3);
  assert.ok(opened[1].split('<section class="page').length - 1 > 3);
  // 표지의 호수와 보고월은 HTML 에 그대로 있다. 예전처럼 PDF 위에 덧그리지 않는다.
  assert.match(opened[1], /Issue 3[\s\S]*2026\.09/);
  assert.deepEqual(printed, [{ printBackground: true, preferCSSPageSize: true }]);
  assert.equal(output.toString(), '%PDF');
  assert.equal(closed, true);
});

test('outside Vercel the download prints with the browser CHROME_PATH names', async () => {
  const saved = process.env.CHROME_PATH;
  // 존재하는 실행 파일이면 된다. 브라우저를 띄우지 않고 고르는 것만 본다.
  process.env.CHROME_PATH = process.execPath;
  try {
    const options = await browserLaunchOptions({}, { VERCEL: '' });
    assert.equal(options.executablePath, process.execPath);
    assert.equal(options.headless, true);
  } finally {
    if (saved === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = saved;
  }
});
