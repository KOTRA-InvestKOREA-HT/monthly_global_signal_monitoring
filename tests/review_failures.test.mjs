import test from 'node:test';
import assert from 'node:assert/strict';
import { publishableReviewFailures } from '../scripts/review_report.mjs';
import { articleCoverageGap, companyCoverageGaps, reportBlockers } from '../scripts/local_report.mjs';

// 34939670823: 372건 중 6건이 두 번 모두 인용 검증에 실패했다(ABB 영상 자막 파일, 일본어 인용을 번역한 응답 등).
// 실패한 기사는 저장되지 않아 매 실행 다시 시도되므로, 막아 두면 보고서가 영영 나오지 않는다.
test('the report builds without articles that failed validation twice, never without untried ones', () => {
  const failed_articles = [{ article_id: 'a', reason: 'evidence_mismatch' }, { article_id: 'b', reason: 'evidence_mismatch' }];
  const state = { status: 'paused', reason: 'invalid_responses', completed: 8, total: 10, failed_articles };
  assert.deepEqual(publishableReviewFailures(state), ['a', 'b']);
  // 요청 한도로 멈췄으면 아직 시도하지 못한 기사가 있다. 다음 실행이 이어간다.
  assert.deepEqual(publishableReviewFailures({ ...state, reason: 'request_budget' }), []);
  assert.deepEqual(publishableReviewFailures({ ...state, completed: 7 }), []);
  assert.deepEqual(publishableReviewFailures({ status: 'completed', completed: 10, total: 10, failed_articles: [] }), []);
});

test('only articles that failed review may be missing when the report is built', () => {
  const pending = [{ article_id: 'a' }, { article_id: 'b' }];
  assert.equal(reportBlockers({ pending, invalid: [] }, new Set(['a', 'b'])), null);
  assert.deepEqual(reportBlockers({ pending, invalid: [] }, new Set(['a'])), { pending: 1, invalid: 0 });
  assert.deepEqual(reportBlockers({ pending: [], invalid: [{ article_id: 'c' }] }, new Set(['c'])), { pending: 0, invalid: 1 });
  assert.equal(reportBlockers({ pending: [], invalid: [] }), null);
});

test('an article that reached the report without a review is a coverage gap, not a quiet no-signal', () => {
  const body = { content_text: 'Article body text. '.repeat(20) };
  const failed = { id: 'failed', candidates: [{ row: body }] };
  const reviewed = { id: 'reviewed', candidates: [{ row: body }] };
  const noSignal = { decisions: [{ quality: 'pass', entity_supported: true, indicator_supported: false }] };
  assert.equal(articleCoverageGap(failed, undefined), 'review_failed');
  assert.deepEqual(companyCoverageGaps([failed, reviewed], new Map([['reviewed', noSignal]])).map(article => article.id), ['failed']);
});
