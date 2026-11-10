import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectHtmlDateEvidence } from '../scripts/collect_company_signals.mjs';
import { chooseDateEvidence, periodPlacement } from '../scripts/date_state.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'article_dates');
const october = { from_date: '2026-10-01', to_date: '2026-10-31' };
const timeTags = evidence => evidence.filter(item => item.source === 'time_tag').map(item => item.date.slice(0, 10));
const toppan = fs.readFileSync(path.join(FIXTURES, 'toppan_related_news.html'), 'utf8');
const TOPPAN_URL = 'https://www.holdings.toppan.com/en/news/2026/10/newsrelease261028_1.html';

// 2026-10 보고서(2026-11-02 수집): 본문 <article> 안 "Related News" 카드의 2026/08/03·2026/04/09 <time> 때문에
// 승인된 Toppan 시그널(10/28 공동 R&D)이 근거 충돌 → date_pending 으로 보고서에서 빠졌다.
test('time tags on related-news cards inside the article are not its publication date', () => {
  const evidence = collectHtmlDateEvidence(toppan, TOPPAN_URL);
  assert.deepEqual(timeTags(evidence), ['2026-10-28']);
  const row = chooseDateEvidence(evidence);
  assert.equal(row.published_at_status, 'confirmed');
  assert.equal(row.date_conflict, false);
  assert.equal(periodPlacement(row, october).placement, 'in_period');
});

// 기사 머리에 날짜가 없어도 관련 기사 덩어리의 날짜는 근거가 아니다. 이때 남의 날짜가 게시일로 "확정"되면 안 된다.
test('a related-news block is left out even when the article prints no date of its own', () => {
  const noOwnDate = toppan.replace(/<time class="page__date"[\s\S]*?<\/time>/, '');
  assert.deepEqual(timeTags(collectHtmlDateEvidence(noOwnDate, TOPPAN_URL)), []);
  const withMeta = noOwnDate.replace('<meta property="og:type" content="article">',
    '<meta property="article:published_time" content="2026-10-28T09:00:00+09:00">');
  const row = chooseDateEvidence(collectHtmlDateEvidence(withMeta, TOPPAN_URL));
  assert.equal(row.published_at_status, 'confirmed');
  assert.equal(row.published_at.slice(0, 10), '2026-10-28');
});

test('a header date that disagrees with the structured data is still a conflict', () => {
  const html = toppan.replace('<meta property="og:type" content="article">',
    '<meta property="article:published_time" content="2026-09-30">');
  const row = chooseDateEvidence(collectHtmlDateEvidence(html, TOPPAN_URL));
  assert.equal(row.published_at_status, 'conflicting');
  assert.equal(periodPlacement(row, october).placement, 'date_pending');
  // 기사 머리의 두 날짜가 서로 어긋나도 그대로 충돌이다.
  const twoHeaderDates = toppan.replace('<h1 class="page__title"',
    '<time class="page__date">2026/09/30</time><h1 class="page__title"');
  assert.equal(chooseDateEvidence(collectHtmlDateEvidence(twoHeaderDates, TOPPAN_URL)).published_at_status, 'conflicting');
});

const page = ({ title = 'Company opens a new cathode materials plant in Ontario', head = '', body }) =>
  `<html><head><meta property="og:title" content="${title}">${head}</head><body>${body}</body></html>`;
const filler = '<p>' + 'The plant will supply cathode materials to battery makers in North America. '.repeat(12) + '</p>';

test('sidebar, recent-post widgets, comments and the site header clock are outside the article', () => {
  const html = page({
    head: '<meta property="article:published_time" content="2026-10-13T08:00:00Z">',
    body: '<header class="tp-header site-header"><time datetime="2026-11-10">Tuesday, November 10, 2026</time></header>'
      + '<main><article class="post"><h1>Company opens a new cathode materials plant in Ontario</h1>'
      + '<time class="entry-date published" datetime="2026-10-13T08:00:00Z">October 13, 2026</time>' + filler
      + '<aside class="widget rpwe_widget recent-posts-extended"><ul><li><time class="rpwe-time published" datetime="2026-11-09T07:01:15+01:00">Nov 9</time></li></ul></aside>'
      + '<ol class="comment-list"><li class="comment"><time datetime="2026-11-01T09:41:54-05:00">Nov 1</time>Nice.</li></ol>'
      + '</article><div class="widget-area sidebar"><time class="entry-date published" datetime="2026-11-05T10:23:28+01:00">Nov 5</time></div></main>',
  });
  const evidence = collectHtmlDateEvidence(html);
  assert.deepEqual(timeTags(evidence), ['2026-10-13']);
  assert.equal(chooseDateEvidence(evidence).published_at_status, 'confirmed');
});

// Umicore 보도자료: 제목 바로 뒤에 자기 날짜, 본문 아래 아무 표시 없는 <div> 에 최신 뉴스 세 건의 <time>.
test('the date printed right under the headline outranks undated-looking lists further down the page', () => {
  const html = page({
    title: 'Half Year Results 2026',
    body: '<h1>Half Year Results 2026</h1><div class="flex"><div>Press release</div>'
      + '<time datetime="2026-07-31T07:30:00+02:00">July 31, 2026</time></div><main>' + filler + filler
      + '<div class="grid"><div><a href="/a">Other story</a><time datetime="2026-10-28T11:00:00+01:00">October 28, 2026</time></div>'
      + '<div><a href="/b">Another story</a><time datetime="2026-10-27T13:30:00+01:00">October 27, 2026</time></div></div></main>',
  });
  const row = chooseDateEvidence(collectHtmlDateEvidence(html));
  assert.equal(row.published_at_status, 'confirmed');
  assert.equal(row.published_at.slice(0, 10), '2026-07-31');
  assert.equal(periodPlacement(row, october).placement, 'out_of_period');
});

// 3M 투자자 보도자료는 제목 바로 뒤 "related-documents-line" 에 게시일을 둔다. 다른 근거가 없는 페이지라
// 이 날짜를 버리면 확정이던 기사가 게시일 미상이 된다.
test('the article\'s own date survives inside a block whose name only looks foreign', () => {
  const html = page({
    title: '3M and AWS collaborate to advance optical connectivity innovation',
    body: '<main><article class="full-news-article"><h1>3M and AWS collaborate to advance optical connectivity innovation</h1>'
      + '<div class="related-documents-line"><time class="date" datetime="2026-10-21T10:28:00">Oct 21, 2026</time>'
      + '<a href="/doc.pdf">PDF</a></div>' + filler + '</article></main>',
  });
  assert.deepEqual(timeTags(collectHtmlDateEvidence(html)), ['2026-10-21']);
  // 같은 이름의 덩어리라도 제목이 든 <article> 밖이면 되살리지 않는다.
  const outside = page({
    title: '3M and AWS collaborate to advance optical connectivity innovation',
    body: '<main><article><h1>3M and AWS collaborate to advance optical connectivity innovation</h1></article>'
      + '<aside class="page-rail"><time datetime="2026-08-17">Aug 17</time></aside>' + filler + '</main>',
  });
  assert.deepEqual(timeTags(collectHtmlDateEvidence(outside)), []);
});

test('a layout wrapper that holds the headline is never treated as a sidebar', () => {
  const html = page({
    body: '<div class="content-sidebar-wrap"><main><article><h1>Company opens a new cathode materials plant in Ontario</h1>'
      + '<p>By staff</p>' + filler + '<footer class="entry-footer"><time class="entry-date published" datetime="2026-10-13">Oct 13</time></footer>'
      + '</article></main><aside class="sidebar"><time datetime="2026-11-02">Nov 2</time></aside></div>',
  });
  assert.deepEqual(timeTags(collectHtmlDateEvidence(html)), ['2026-10-13']);
});

// Digital Today: 기사 제목 앞 사이트 <header> 의 2025-11-20 <time>. RegMedNet: 기사 밖 header#post-header 가
// 제목과 게시일을 함께 담고, 그 앞 웨비나 카운트다운이 <time class="timer"> 다.
test('a site header outside the article is left out, a post header holding the headline is kept', () => {
  const siteHeader = page({
    title: 'Onsemi in talks to buy AI chip power startup Ferric for $1 billion',
    head: '<meta property="article:published_time" content="2026-10-28T09:00:00Z">',
    body: '<header class="dt-header--en"><time datetime="2025-11-20T15:00:00-05:00">Nov 20</time><h1><img alt=""></h1></header>'
      + '<main><article><header><h1>Onsemi in talks to buy AI chip power startup Ferric for $1 billion</h1></header>' + filler + '</article></main>',
  });
  assert.deepEqual(timeTags(collectHtmlDateEvidence(siteHeader)), []);
  assert.equal(chooseDateEvidence(collectHtmlDateEvidence(siteHeader)).published_at_status, 'confirmed');
  const postHeader = page({
    title: 'Cell therapy weekly: stem cell therapy for osteoarthritis',
    body: '<div id="content"><div id="banner-countdown"><div class="inner"><span>WEBINAR</span>'
      + '<time class="timer" datetime="2026-11-10 15:00:00"><span>0 days</span></time></div></div>'
      + '<div id="single-post"><div class="inner"><header id="post-header"><h1>Cell therapy weekly: stem cell therapy for osteoarthritis</h1>'
      + '<div class="meta"><div class="box"><time class="ui-small-meta-date">15 Oct 2026</time></div></div></header>' + filler + '</div></div></div>',
  });
  assert.deepEqual(timeTags(collectHtmlDateEvidence(postHeader)), ['2026-10-15']);
});

// 제목을 찾지 못한 페이지는 표시된 덩어리만 거르고 나머지 <time> 은 예전처럼 모두 읽는다.
test('without a recognizable headline only marked blocks are filtered', () => {
  const html = '<main><time datetime="2026-10-05">Oct 5</time><p>Notice.</p><time datetime="2026-09-20">Sep 20</time>'
    + '<aside><time datetime="2026-11-01">Nov 1</time></aside></main>';
  const evidence = collectHtmlDateEvidence(html);
  assert.deepEqual(timeTags(evidence), ['2026-10-05', '2026-09-20']);
  assert.equal(chooseDateEvidence(evidence).published_at_status, 'conflicting');
});
