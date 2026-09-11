import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchArticleDocument } from '../scripts/collect_company_signals.mjs';
import { needsStageReview } from '../scripts/review_report.mjs';
import { coverageStatus } from '../scripts/local_report.mjs';

test('publisher redirects supply HTML, Google wrappers never become evidence', async () => {
  const response = (url, html) => {
    const r = new Response(html);
    Object.defineProperty(r, 'url', { value: url });
    return r;
  };
  await assert.rejects(fetchArticleDocument('https://news.google.com/rss/articles/abc', 1,
    async () => response('https://consent.google.com/', 'Consent page')), /publisher_url_unresolved/);
  const doc = await fetchArticleDocument('https://news.google.com/rss/articles/abc', 1,
    async () => response('https://publisher.example/news/story', '<article>Real story</article>'));
  assert.equal(doc.html, '<article>Real story</article>');
  assert.equal(doc.resolvedUrl, 'https://publisher.example/news/story');
});

test('only plausible old S4 stage rejections need a new review', () => {
  const a = { candidates: [{ id: 'investment:4', relevance_exempt: false }] };
  const d = { candidate_id: 'investment:4', event_stage: 'completed', entity_supported: true,
    indicator_supported: true, target_technology_supported: true };
  assert.equal(needsStageReview(a, { decisions: [d] }), true);
  assert.equal(needsStageReview(a, { decisions: [d], stage_review_version: 'candidate-event-v3' }), false);
  for (const change of [{ event_stage: 'precursor' }, { indicator_supported: false }])
    assert.equal(needsStageReview(a, { decisions: [{ ...d, ...change }] }), false);
});

// 34546694524: Nexeon 의 1억 파운드 조달은 investment:3 이고 네 조건이 모두 true 인데
// event_stage=completed 하나로 탈락했다. 재검토가 4번만 보던 동안 이 건은 대상이 아니었다.
test('stage review covers every indicator that precursor is available to', () => {
  const decision = no => ({ candidate_id: `investment:${no}`, event_stage: 'completed',
    entity_supported: true, indicator_supported: true, target_technology_supported: true });
  const article = no => ({ candidates: [{ id: `investment:${no}`, relevance_exempt: false }] });
  for (const no of [1, 3, 4, 5]) {
    assert.equal(needsStageReview(article(no), { decisions: [decision(no)] }), true, `indicator ${no}`);
  }
  // 생산확대(2)는 정책상 precursor 를 쓸 수 없으므로 다시 물어볼 것이 없다.
  assert.equal(needsStageReview(article(2), { decisions: [decision(2)] }), false);
  // 사업동향 행에는 투자 단계 판정 자체가 없다.
  assert.equal(needsStageReview({ candidates: [{ id: 'relevant' }] },
    { decisions: [{ ...decision(3), candidate_id: 'relevant' }] }), false);
});

test('passing AI decisions cannot hide absent bodies or unresolved dates in coverage', () => {
  const a = { id: 'a', date_placement: 'in_period', candidates: [{ row: { content_text: 'Evidence '.repeat(80) } }] };
  const reviews = new Map([['a', { decisions: [{ quality: 'pass' }] }]]);
  assert.equal(coverageStatus([], reviews), 'no_monthly_sources');
  assert.equal(coverageStatus([a], reviews), 'reviewed');
  assert.equal(coverageStatus([{ ...a, candidates: [{ row: {} }] }], reviews), 'incomplete_evidence');
  assert.equal(coverageStatus([{ ...a, date_placement: 'date_pending' }], reviews), 'incomplete_evidence');
});
