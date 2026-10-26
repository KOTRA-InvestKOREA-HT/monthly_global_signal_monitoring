// 실제 브라우저로 보고서 HTML 을 그려, 화면에서 가려지는 글자를 빌드가 찾는지 본다.
//
// .page 는 overflow:hidden 이라 상세 페이지 내용이 푸터 선(742pt) 아래로 내려가도, 한 줄 칸이 말줄임돼도
// PDF 는 오류 없이 나온다. 예전 측정은 줄 수 제한 잘림만 봐서, 약 400자 영문 시그널 셋과 약 420자 사업현황이면
// 내용이 752pt 까지 내려가 푸터를 덮고(시그널 넷이면 837pt, 쪽 밖) 그래도 빌드가 통과했다(2026-10-15 감사 §3-1).
// 지금 데이터는 기업당 지표가 최대 둘이라 아직 터지지 않았을 뿐이다.
//
// Chrome·Edge 가 없는 환경에서만 건너뛴다(build_html_report.mjs 와 같은 후보, CHROME_PATH 포함).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { browserCandidates, cutTexts, measureLayout } from '../scripts/build_html_report.mjs';
import { CONTENT_BOTTOM_PT, renderReport } from '../scripts/report_html.mjs';

const ROOT = path.resolve('.');
const ASSETS = pathToFileURL(path.join(ROOT, 'assets')).href;

function installedBrowser() {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['', '.exe'] : [''];
  return browserCandidates().find(candidate => (path.isAbsolute(candidate)
    ? fs.existsSync(candidate)
    : dirs.some(dir => exts.some(ext => fs.existsSync(path.join(dir, candidate + ext))))));
}

const browser = installedBrowser();
const skip = browser ? false : 'no Chrome or Edge installed (set CHROME_PATH)';

const fixture = lang => JSON.parse(fs.readFileSync(
  path.join(ROOT, 'tests/fixtures/report_snapshot', `expected_view_model_${lang}.json`), 'utf8'));

async function measure(model) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'report-layout-'));
  try {
    return await measureLayout(renderReport(model, { assets: ASSETS }), path.join(dir, `report_${model.lang}.html`));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

// 약 400자 영문 시그널 문안. 표제 한 줄과 상세 문단으로, 실제 카드처럼 따로 줄을 잡는다.
const sentence = 'The company agreed to expand its advanced materials production with a new regional partner. ';
const longSignal = (signal, filler) => ({
  ...signal, active: true, inline: false, cut: false, plain: '',
  headline: 'Applied Materials expands advanced packaging capacity in Singapore',
  detail: filler.repeat(4).trim().slice(0, 330),
  source: 'Source:  Press release · Applied Materials - Newsroom Aug 20, 2026',
  source_url: 'https://www.example.com/news/a',
});

function crowdedDetail(signalCount) {
  const model = fixture('en');
  const page = model.details.pages[0];
  page.signals = page.signals.map((signal, index) => (index < signalCount ? longSignal(signal, sentence) : signal));
  // 첫 카드는 별도 기사가 없어 상자가 빠져 있다. 가장 붐비는 경우를 재려고 다른 카드의 상자를 빌려 온다.
  page.business = { ...(page.business || model.details.pages.find(entry => entry.business).business) };
  page.business.items = [{ ...page.business.items[0], body: (sentence.repeat(5)).trim().slice(0, 420) }];
  return { model, company: page.company };
}

// 사업현황 상자에 기사 세 건(2026-10-26). 항목마다 번호·문안·출처 줄이 있고, 뷰 모델이 쪽에 들어간다고 본 만큼이면
// 줄 수 제한에도, 푸터 선에도 걸리지 않아야 한다.
const numberedBox = business => ({
  ...business,
  numbered: true,
  items: [1, 2, 3].map(no => ({
    no: `${no}.`, body: sentence.repeat(3).trim(), cut: false,
    source: `Source:  Media ${no} Sep ${10 - no}, 2026`, source_url: `https://www.example.com/news/${no}`,
  })),
});

test('the current report fits every page and shows every text whole', { skip }, async () => {
  for (const lang of ['ko', 'en']) {
    const layout = await measure(fixture(lang));
    assert.deepEqual(layout.problems, [], lang);
    assert.equal(layout.cards.length, fixture(lang).items.cards.length);
  }
});

test('a detail page whose content runs below the footer rule fails the build', { skip }, async () => {
  const { model, company } = crowdedDetail(3);
  const layout = await measure(model);
  const overflow = layout.problems.filter(problem => problem.part === 'page overflow');
  assert.equal(overflow.length, 1, JSON.stringify(layout.problems));
  assert.equal(overflow[0].company, company);
  assert.equal(overflow[0].page, 3);
  assert.ok(overflow[0].bottom > CONTENT_BOTTOM_PT, String(overflow[0].bottom));
  // 빌드는 이 목록이 비어 있지 않으면 PDF 를 만들지 않는다(REPORT_ALLOW_CUT_TEXT 가 아니면).
  assert.ok(cutTexts(model, layout.problems).some(item => item.part === 'page overflow' && item.rendered));

  // 시그널이 넷이면 쪽 밖까지 내려간다. 그것도 같은 검사로 잡힌다.
  const worse = await measure(crowdedDetail(4).model);
  const past = worse.problems.find(problem => problem.part === 'page overflow');
  assert.ok(past && past.bottom > overflow[0].bottom, JSON.stringify(worse.problems));
});

test('a business box with three numbered articles fits a one-signal card whole', { skip }, async () => {
  const model = fixture('en');
  const index = model.details.pages.findIndex(entry => entry.business
    && entry.signals.filter(signal => signal.active).length === 1);
  model.details.pages[index].business = numberedBox(model.details.pages[index].business);
  const layout = await measure(model);
  assert.deepEqual(layout.problems, []);
});

test('a one-line box that ellipsizes its text is reported', { skip }, async () => {
  const model = fixture('en');
  model.details.pages[0].industry = 'Semiconductor Packaging, Test, Advanced Substrates and Heterogeneous Integration Services';
  model.matrix.rows[0].company = 'Australian Strategic Materials Rare Earth Metals and Alloys Holdings Limited';
  model.items.cards[0].target_text = 'Silicon-carbon composite anode material technology for next-generation high-energy lithium-ion cells';
  const layout = await measure(model);
  const parts = layout.problems.map(problem => problem.part);
  assert.ok(parts.includes('ellipsis pill industry'), JSON.stringify(layout.problems));
  assert.ok(parts.includes('ellipsis company'), JSON.stringify(layout.problems));
  assert.ok(parts.includes('ellipsis target-text'), JSON.stringify(layout.problems));
  const pill = layout.problems.find(problem => problem.part === 'ellipsis pill industry');
  assert.equal(pill.company, model.details.pages[0].company);
  assert.match(pill.text, /Heterogeneous Integration/);
});
