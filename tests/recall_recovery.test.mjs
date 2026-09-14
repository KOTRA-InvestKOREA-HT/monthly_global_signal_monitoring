import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchArticleDocument } from '../scripts/collect_company_signals.mjs';
import { mergeReviewSummaries, needsForm3Review, needsReviewSummary, needsStageReview } from '../scripts/review_report.mjs';
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

test('an old approved Form 3 S5 decision gets one fresh semantic review', () => {
  const article = { candidates: [{ id: 'investment:5', kind: 'investment', relevance_exempt: true,
    row: { source_kind: 'filing', investment_signal_no: 5,
      title: '3 - Initial statement of beneficial ownership of securities' } }] };
  const decision = { candidate_id: 'investment:5', entity_supported: true, target_technology_supported: false,
    indicator_supported: true, leading_indicator_supported: true, quality: 'pass', event_stage: 'precursor' };
  assert.equal(needsForm3Review(article, { decisions: [decision] }), true);
  // A fresh review is trusted under the ordinary semantic contract whether it
  // finds an explicit appointment or rejects a status-only filing.
  assert.equal(needsForm3Review(article, { decisions: [decision], form3_review_version: 'form3-personnel-event-v1' }), false);
  assert.equal(needsForm3Review(article, { decisions: [{ ...decision, indicator_supported: false }] }), false);
  assert.equal(needsForm3Review({ candidates: [{ ...article.candidates[0],
    row: { ...article.candidates[0].row, source_kind: 'press_release' } }] }, { decisions: [decision] }), false);
});

test('a saved review whose human-review candidate lacks prose is asked once for summaries', () => {
  const article = { candidates: [{ id: 'investment:2', kind: 'investment', row: { investment_signal_no: 2 } }] };
  const decision = { candidate_id: 'investment:2', entity_supported: true, indicator_supported: true,
    target_technology_supported: false, leading_indicator_supported: true, event_stage: 'planned', quality: 'pass',
    summary_ko: '', summary_en: '' };
  assert.equal(needsReviewSummary(article, { decisions: [decision] }), true);
  assert.equal(needsReviewSummary(article, { decisions: [decision], summary_review_version: 'human-review-summary-v1' }), false);
  assert.equal(needsReviewSummary(article, { decisions: [{ ...decision, summary_ko: '요약 - 상세', summary_en: 'Summary - detail' }] }), false);
  // Neither an approved decision nor one without an indicator event is a review candidate.
  assert.equal(needsReviewSummary(article, { decisions: [{ ...decision, target_technology_supported: true }] }), false);
  assert.equal(needsReviewSummary(article, { decisions: [{ ...decision, indicator_supported: false }] }), false);
});

test('summary backfill copies prose only into empty human-review decisions and keeps every judgement', () => {
  const article = { candidates: [
    { id: 'investment:2', kind: 'investment', row: { investment_signal_no: 2 } },
    { id: 'investment:3', kind: 'investment', row: { investment_signal_no: 3 } },
  ] };
  const review = { article_id: 'x', decisions: [
    { candidate_id: 'investment:2', entity_supported: true, indicator_supported: true, target_technology_supported: false,
      leading_indicator_supported: true, event_stage: 'planned', quality: 'pass', summary_ko: '', summary_en: '' },
    { candidate_id: 'investment:3', entity_supported: false, indicator_supported: false, target_technology_supported: false,
      leading_indicator_supported: false, event_stage: 'not_applicable', quality: 'pass', summary_ko: '', summary_en: '' },
  ] };
  // The fresh answer flips judgements; only prose for the review candidate may cross over.
  const fresh = { decisions: [
    { ...review.decisions[0], target_technology_supported: true, summary_ko: '표제 - 상세', summary_en: 'Headline - detail' },
    { ...review.decisions[1], entity_supported: true, summary_ko: '다른 문안', summary_en: 'Other prose' },
  ] };
  const merged = mergeReviewSummaries(article, review, fresh);
  assert.equal(merged.summary_review_version, 'human-review-summary-v1');
  assert.equal(merged.decisions[0].target_technology_supported, false);
  assert.equal(merged.decisions[0].summary_ko, '표제 - 상세');
  assert.equal(merged.decisions[0].summary_en, 'Headline - detail');
  assert.deepEqual(merged.decisions[1], review.decisions[1]);
  assert.equal(needsReviewSummary(article, merged), false);
  // A fresh answer without prose is still stamped, so the article is not asked again.
  assert.equal(needsReviewSummary(article, mergeReviewSummaries(article, review, { decisions: [] })), false);
});
