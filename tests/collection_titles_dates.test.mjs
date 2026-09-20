import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseBetterTitle, collectHtmlDateEvidence, dateEvidence, extractDateFromText, extractMonthFromText,
  isUsableTitle, parseAnchors } from '../scripts/collect_company_signals.mjs';
import { chooseDateEvidence, periodPlacement } from '../scripts/date_state.mjs';

const company = { company: 'Umicore', query_aliases: [] };

test('link labels and site greetings are not article titles', () => {
  for (const title of ['English version', 'Download the document', 'Download the video transcript',
    '11 MB (PDF)', 'PDF&nbsp;3.29 MB', 'PDF 3.29 MB', 'Welcome to Mkango Resources Ltd.']) {
    assert.equal(isUsableTitle(title, company), false, title);
  }
  assert.equal(isUsableTitle('Umicore breaks ground on cathode plant in Ontario', company), true);
});

test('a label title on a document without a page title takes the file name', () => {
  assert.equal(chooseBetterTitle('English version', '',
    'https://www.umicore.com/storage/umicore/umicore-integrated-annual-report-2022.pdf', company),
  'umicore integrated annual report 2022');
  // A site-wide og:title never replaces a usable link title.
  assert.equal(chooseBetterTitle('Mkango completes acquisition of Remloy', 'Welcome to Mkango Resources Ltd.',
    'https://mkango.ca/news/mkango-completes-acquisition-of-remloy/', { company: 'HyproMag', query_aliases: [] }),
  'Mkango completes acquisition of Remloy');
  // A usable link title is kept when the document has no title.
  assert.equal(chooseBetterTitle('H1 2026 activity report', '', 'https://example.com/files/x.pdf', company),
    'H1 2026 activity report');
});

test('European hyphenated dates are read day first, ISO dates are unchanged', () => {
  assert.equal(extractDateFromText('1-04-2026 | Press release Prodrive Technologies announces 2025 results').slice(0, 10), '2026-04-01');
  assert.equal(extractDateFromText('23-09-2025 | Press release Change in executive management').slice(0, 10), '2025-09-23');
  assert.equal(extractDateFromText('Published 2026-08-14 in Tokyo').slice(0, 10), '2026-08-14');
  assert.equal(extractDateFromText('SEC filing 0001627223-26-000027'), null);
});

test('zone-less dates are read as written in UTC, whatever the machine time zone', () => {
  // Albemarle JSON-LD datePublished; a KST machine used to read it as 2026-08-04T15:00:00Z.
  assert.equal(dateEvidence('08/05/26', 'jsonld').date, '2026-08-05T00:00:00Z');
  assert.equal(dateEvidence('2026-08-05T12:15:00', 'meta').date, '2026-08-05T12:15:00Z');
  assert.equal(dateEvidence('2026-08-05', 'meta').date, '2026-08-05T00:00:00Z');
  assert.equal(dateEvidence('2026-08-05T12:15:00-04:00', 'meta').date, '2026-08-05T16:15:00Z');
  assert.equal(dateEvidence('Wed, 05 Aug 2026 16:00:00 GMT', 'feed').date, '2026-08-05T16:00:00Z');
});

test('US zone abbreviations in feed dates keep their zone', () => {
  assert.equal(dateEvidence('Wed, 05 Aug 2026 16:00:00 EST', 'feed').date, '2026-08-05T21:00:00Z');
  assert.equal(dateEvidence('Wed, 05 Aug 2026 22:30:00 PDT', 'feed').date, '2026-08-06T05:30:00Z');
});

// 목록 항목 하나를 Boeing 보도자료 목록과 같은 모양으로 재현한다: 날짜 칸과 제목 링크 사이에
// 툴팁 속성이 300자 넘게 들어 있어 고정폭 창으로는 날짜가 밀려난다.
const listingItem = (date, title, href) => `<li class="wd_item">
  <div class="wd_item_wrapper">
  <div class="wd_date">${date}</div>
  <div class="wd_title"><div class="wd_tooltip-trigger" data-trigger="hover" data-parent=".wd_item"
   data-content=".wd_summary" data-classes="qtip-shadow qtip-rounded wd_tooltip"
   data-position='{"my":"top left","at":"bottom right","target":"mouse"}' data-filler="${'x'.repeat(200)}">
   <a href="${href}">${title}</a></div></div>
  </div></li>`;

const listingDate = anchor => extractDateFromText(`${anchor.title} ${anchor.context}`)
  || extractMonthFromText(`${anchor.title} ${anchor.context}`);

test('a listing date separated from its link by markup is still that item\'s date', () => {
  const html = `<ul>${listingItem('Aug 11, 2026', 'WZL-1 and Boeing sign offset agreements', 'https://boeing.mediaroom.com/2026-08-11-offset')}`
    + `${listingItem('Aug 10, 2026', 'Archer to acquire Wisk Aero from Boeing', 'https://boeing.mediaroom.com/2026-08-10-archer')}</ul>`;
  const anchors = parseAnchors(html, 'https://boeing.mediaroom.com/news-releases-statements');
  assert.equal(listingDate(anchors[0]).slice(0, 10), '2026-08-11');
  // 창을 넓혀도 항목 경계는 넘지 않는다. 넘으면 앞 기사 날짜인 8월 11일을 이 기사 것으로 읽는다.
  assert.equal(listingDate(anchors[1]).slice(0, 10), '2026-08-10');
});

test('a listing date makes the article confirmed, where the URL alone only estimates it', () => {
  const html = listingItem('Aug 10, 2026', 'Archer to acquire Wisk Aero from Boeing', 'https://boeing.mediaroom.com/2026-08-10-archer');
  const [anchor] = parseAnchors(html, 'https://boeing.mediaroom.com/news-releases-statements');
  const row = chooseDateEvidence([
    dateEvidence(listingDate(anchor), 'listing', 'published'),
    dateEvidence('2026-08-10', 'url', 'context'),
  ]);
  assert.equal(row.published_at_status, 'confirmed');
  assert.equal(periodPlacement(row, { from_date: '2026-08-01', to_date: '2026-08-31' }).placement, 'in_period');
});

test('a newsroom that prints no date at all is placed by the CMS modification time', () => {
  // maxon 뉴스룸은 목록에도 기사에도 날짜가 없다. 2025-07 기사 여덟 건이 게시일 미상으로 들어와
  // 2026-08 보고서 후보까지 올라왔다. 수정 시각은 게시일 이후이므로 기간 밖 판정에 쓸 수 있다.
  const html = '<html><body><h1>maxon acquires strategic minority stake in Synapticon</h1>'
    + '<script>window.__DATA__={"extDisplayedDate":null,"modificationDate":"2025-07-15T08:13:26Z[GMT]"}</script></body></html>';
  const evidence = collectHtmlDateEvidence(html, 'https://www.maxongroup.com/en/news-and-events/news/synapticon-285238');
  assert.deepEqual(evidence.map(item => [item.source, item.kind, item.date]),
    [['modified_cms', 'modified', '2025-07-15T08:13:26Z']]);
  const row = chooseDateEvidence(evidence);
  // 수정 근거만으로는 게시일을 확정하지 않는다. 기간 밖이라는 판정에만 쓴다.
  assert.equal(row.published_at_status, 'estimated');
  assert.equal(periodPlacement(row, { from_date: '2026-08-01', to_date: '2026-08-31' }).placement, 'out_of_period');
  // 같은 근거가 기간 안을 가리키면 내용 검토는 하되 본문에는 넣지 않는다.
  const recent = chooseDateEvidence(collectHtmlDateEvidence(html.replace('2025-07-15', '2026-08-15'), ''));
  assert.equal(periodPlacement(recent, { from_date: '2026-08-01', to_date: '2026-08-31' }).placement, 'date_pending');
});
