import test from 'node:test';
import assert from 'node:assert/strict';
import {
  augustRule,
  classifyOfficialLink,
  currentRule,
  looksLikeTemplateUrl,
  verifyFetchedArticle,
} from '../scripts/link_policy.mjs';
import {
  createPublisherProbe,
  detailSourceUrl,
  judgeAnchor,
  parseAnchors,
} from '../scripts/collect_company_signals.mjs';
import { summarise } from '../scripts/audit_link_rules.mjs';

// 실제 수집 경로가 쓰는 조합. 판정을 링크 텍스트와 날짜 없이 시험하면 아무 의미가 없다.
const DEPS = {
  officialTitle: (anchor) => anchor.title,
  detectDate: (text) => (/\b20\d{2}[-.\/]\d{1,2}[-.\/]\d{1,2}\b/.test(text) ? '2026-08-01' : null),
};

const anchor = (url, title = '', context = '') => ({ url, title, context });
const verdict = (url, title = '', context = '', page = 'https://example.com/news/') =>
  classifyOfficialLink(anchor(url, title, context), page, DEPS).verdict;

test('짧은 기사 슬러그는 fetch 전에 버려지지 않는다', () => {
  // 두 낱말 슬러그는 카테고리 탭과 모양이 같다. URL만으로는 갈라지지 않으므로 받아보고 정한다.
  // 현재 규칙은 이 모양을 전부 목록으로 오판해 fetch 전에 버린다.
  for (const url of [
    'https://example.com/press/strategic-deal',
    'https://example.com/news/new-factory',
    'https://example.com/newsroom/korea-plant',
  ]) {
    assert.equal(currentRule(anchor(url, 'Read more'), 'https://example.com/news/', DEPS), false, url);
    assert.notEqual(verdict(url, 'Read more'), 'hard_reject', url);
  }
  // 뉴스 구역 밖의 짧은 슬러그는 기사라는 근거가 없으므로 받아보고 나서 정한다.
  assert.equal(verdict('https://example.com/investors/shareholder-services', 'Shareholder Services'), 'fetch_to_verify');
});

test('카테고리·태그·페이지네이션은 계속 hard reject 된다', () => {
  for (const url of [
    'https://example.com/news/category/corporate/',
    'https://example.com/blog/tag/batteries/',
    'https://example.com/newsroom/page/3/',
    'https://example.com/news/?label=Whitepaper',
    'https://example.com/en/media/newsroom/',
    'https://example.com/',
    'https://example.com/news/feed/',
  ]) {
    assert.equal(verdict(url, 'Corporate news 2026-08-01'), 'hard_reject', url);
  }
});

test('링크 텍스트가 라벨이어도 목적지가 기사면 살아남는다', () => {
  const article = 'https://example.com/newsroom/2026/08/korea-plant-opens';
  for (const label of ['Read more', 'More information', '']) {
    assert.notEqual(verdict(article, label), 'hard_reject', label || '(empty)');
  }
  // 반대로 라벨이 붙었어도 목적지가 제품 페이지면 확인할 값이 없다.
  assert.equal(verdict('https://example.com/products/vial-transfer-devices', 'Read more'), 'hard_reject');
});

test('stories·insights·blog 상세 페이지는 무조건 탈락하지 않는다', () => {
  for (const url of [
    'https://example.com/stories/building-our-korea-site',
    'https://example.com/insights/battery-supply-outlook',
    'https://example.com/blog/inside-the-new-line',
  ]) {
    assert.notEqual(verdict(url, 'Read the story'), 'hard_reject', url);
  }
  // 구역 자체를 가리키는 링크는 그대로 목록이다.
  assert.equal(verdict('https://example.com/stories', 'Stories'), 'hard_reject');
  assert.equal(verdict('https://example.com/en/insights/', 'Insights'), 'hard_reject');
});

test('발행일이 슬러그에 박힌 보도자료는 확인 없이 바로 통과한다', () => {
  // boeing.mediaroom.com 과 investors.danaher.com 의 실제 모양. 경로에 news 낱말이 없어
  // 현재 규칙이 통째로 놓치던 자리다.
  const boeing = 'https://boeing.mediaroom.com/2026-09-04-Boeing-Breaks-Ground-on-New-Site';
  assert.equal(verdict(boeing, 'Boeing Breaks Ground on New Site', '', 'https://boeing.mediaroom.com/'), 'accept');
  assert.equal(currentRule(anchor(boeing, 'Boeing Breaks Ground on New Site'), 'https://boeing.mediaroom.com/', DEPS), false);
});

test('대문자 문서번호 슬러그를 깨진 URL로 보지 않는다', () => {
  // nxp.com 은 자리표시자를 콜론으로 붙이고, 보도자료 슬러그는 슬래시 뒤 대문자 번호다.
  assert.equal(looksLikeTemplateUrl('https://www.nxp.com/company/about-nxp/accessibility:ACCESSIBILITY'), true);
  assert.equal(looksLikeTemplateUrl('https://www.nxp.com/company/about-nxp/newsroom/NW-NXP-BREAKS-GROUND-SITE-MAL'), false);
  assert.notEqual(
    verdict('https://www.nxp.com/company/about-nxp/newsroom/NW-NXP-BREAKS-GROUND-SITE-MAL',
      'NXP Breaks Ground on Assembly Site', '', 'https://www.nxp.com/company/about-nxp/newsroom'),
    'hard_reject',
  );
});

test('PDF 링크는 에셋으로 버려지지 않고, 본문이 있으면 목록으로 오판되지 않는다', () => {
  const pdf = 'https://example.com/newsroom/2026/q2-results-release.pdf';
  assert.notEqual(verdict(pdf, 'Second quarter results'), 'hard_reject');
  // PDF는 html 이 비어 있어 링크 밀도가 0이다. 본문만으로 판정돼야 한다.
  assert.deepEqual(
    verifyFetchedArticle({ title: 'Second quarter results', content: 'short', html: '', usableTitle: true }),
    { ok: true, reason: 'verified_article' },
  );
  // 이미지·압축 파일은 그대로 버린다.
  assert.equal(verdict('https://example.com/newsroom/photo-2026.jpg', 'Plant photo'), 'hard_reject');
  assert.equal(verdict('https://example.com/newsroom/press-kit-2026.zip', 'Press kit'), 'hard_reject');
});

test('받아본 문서가 목록이면 확인 대상은 통과하지 못한다', () => {
  const listing = { title: 'Press releases from 2020', content: '', html: '<a href="/a">a</a>', usableTitle: true };
  assert.equal(verifyFetchedArticle(listing).reason, 'verified_index_page');
  const navPage = {
    title: 'Shareholder Information',
    content: 'Contact us.',
    html: Array.from({ length: 40 }, (_, i) => `<a href="/p${i}">link</a>`).join(''),
    usableTitle: true,
  };
  assert.equal(verifyFetchedArticle(navPage).reason, 'verified_index_page');
  const article = { title: 'Korea plant opens', content: 'x'.repeat(900), html: '<a href="/a">a</a>', usableTitle: true };
  assert.equal(verifyFetchedArticle(article).ok, true);
  assert.equal(verifyFetchedArticle({ ...article, usableTitle: false }).reason, 'no_article_title');
});

test('Google publisher 추적은 그대로다', () => {
  assert.equal(
    detailSourceUrl({ url: 'https://news.google.com/rss/articles/abc', source_direct_url: 'https://publisher.example/news/story' }),
    'https://publisher.example/news/story',
  );
  // 발행사 URL을 모르면 구글 링크를 그대로 두고 리디렉션을 따라간다.
  assert.equal(detailSourceUrl({ url: 'https://news.google.com/rss/articles/abc' }), 'https://news.google.com/rss/articles/abc');
  assert.equal(detailSourceUrl({ url: 'https://publisher.example/news/story' }), 'https://publisher.example/news/story');
  assert.equal(typeof createPublisherProbe(3), 'function');
});

test('제안 규칙은 현재 규칙이 받던 링크를 하나도 잃지 않는다', () => {
  const page = 'https://example.com/en/news/';
  const html = `
    <a href="/news/2026-08-01-korea-plant-expansion">Korea plant expansion 2026-08-01</a>
    <a href="/press-releases/quarterly-earnings-2026">Quarterly earnings</a>
    <a href="/newsroom/partnership-announcement-2026">Partnership announcement</a>
    <a href="/investors/annual-report-2026.pdf">2026 Annual Report</a>
    <a href="/news/category/corporate/">Corporate</a>
    <a href="/privacy">Privacy</a>
    <a href="/products/widget">Widget</a>`;
  for (const item of parseAnchors(html, page)) {
    if (!currentRule(item, page, DEPS)) continue;
    assert.equal(classifyOfficialLink(item, page, DEPS).verdict, 'accept', item.url);
  }
});

test('proposed 정책은 현재 걷던 링크를 하나도 떨어뜨리지 않는다', () => {
  // 이번 작업의 약속. 규칙을 바꿔서 새 후보가 늘어나더라도, 지금 수집되던 링크가
  // 하나라도 hard_reject 되면 그것은 회수가 아니라 교체다.
  const page = 'https://www.borgwarner.com/investors';
  const html = `
    <a href="https://borgwarner.canto.global/direct/document/nr0vvrvrqp4rb72qj1plv8">2023 Annual Report (PDF)</a>
    <a href="/newsroom/2026-08-11-borgwarner-opens-korea-line">BorgWarner opens Korea line</a>
    <a href="/investors/sec-filings">SEC Filings</a>
    <a href="/newsroom/press-releases/">Press releases</a>`;
  for (const item of parseAnchors(html, page)) {
    const effective = judgeAnchor(item, page, 'proposed');
    if (judgeAnchor(item, page, 'current').verdict === 'accept') {
      assert.equal(effective.verdict, 'accept', item.url);
      assert.equal(effective.rank, 0, item.url);
    }
    // 새 후보는 언제나 기존 기사 뒤에 선다.
    if (effective.verdict !== 'hard_reject' && judgeAnchor(item, page, 'current').verdict !== 'accept') {
      assert.ok(effective.rank > 0, item.url);
    }
  }
});

test('감사 도구는 프로덕션 판정을 읽기만 하고 바꾸지 않는다', () => {
  const page = 'https://example.com/en/news/';
  const html = `
    <a href="/news/2026-08-01-korea-plant-expansion">Korea plant expansion 2026-08-01</a>
    <a href="/press/strategic-deal">Read more</a>
    <a href="/news/category/corporate/">Corporate</a>
    <a href="/stories/building-our-korea-site">Read the story</a>`;
  const anchors = parseAnchors(html, page);

  // 기본 정책에서 수집 경로의 처분은 얼려둔 currentRule 과 정확히 같다.
  // 제안 규칙과 감사 도구를 붙였다고 해서 지금 돌고 있는 결과가 달라지지 않는다는 뜻이다.
  for (const item of anchors) {
    const production = judgeAnchor(item, page, 'current');
    assert.equal(production.verdict === 'accept', currentRule(item, page, DEPS), item.url);
  }

  // 감사 집계는 세 규칙을 읽어 세기만 한다. 같은 입력에 두 번 돌려도 결과가 같다.
  const records = anchors.map((item) => ({
    judgement: {
      august: augustRule(item, page, DEPS),
      current: currentRule(item, page, DEPS),
      proposed: classifyOfficialLink(item, page, DEPS),
    },
  }));
  const first = summarise(records);
  assert.deepEqual(summarise(records), first);
  assert.equal(first.counts.anchors, anchors.length);
  assert.equal(
    first.counts.current_pass,
    anchors.filter((item) => currentRule(item, page, DEPS)).length,
  );
});
