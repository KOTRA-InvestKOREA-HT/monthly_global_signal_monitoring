import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeGoogleNewsUrl, fetchArticleDocument } from '../scripts/collect_company_signals.mjs';
import { needsForm3Review, needsFundingReview, needsStageReview } from '../scripts/review_report.mjs';
import { coverageStatus } from '../scripts/local_report.mjs';
// 본문 없는 기사의 판정은 보고서에 실리지 않으므로 문안 보강·새로고침 대상도 아니다. 고정값에 본문을 둔다.
const BODY = 'Article body text that is long enough to count as a fetched article rather than a title. '.repeat(3);

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

test('Google News relay URLs are decoded to the publisher before fetching', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(url);
    if (url === 'https://news.google.com/articles/CBMiABC') {
      return new Response('<c-wiz><div data-n-a-sg="SIG" data-n-a-ts="1757000000"></div></c-wiz>');
    }
    if (url.includes('/batchexecute')) {
      assert.ok(decodeURIComponent(init.body).includes('SIG'));
      return new Response(")]}'\n\n" + JSON.stringify([['wrb.fr', 'Fbv4je',
        JSON.stringify(['garturlres', 'https://publisher.example/story', 1])]]));
    }
    if (url === 'https://publisher.example/story') return new Response('<article>Publisher story</article>');
    throw new Error(`unexpected ${url}`);
  };
  const doc = await fetchArticleDocument('https://news.google.com/rss/articles/CBMiABC?oc=5', 1, fetchImpl);
  assert.equal(doc.resolvedUrl, 'https://publisher.example/story');
  assert.equal(doc.html, '<article>Publisher story</article>');
  assert.equal(calls.at(-1), 'https://publisher.example/story');
  assert.equal(await decodeGoogleNewsUrl('https://publisher.example/story', 1, fetchImpl), null);
  assert.equal(await decodeGoogleNewsUrl('https://news.google.com/rss/articles/NOSIG', 1,
    async () => new Response('<html>no signature</html>')), null);
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

test('coverage is blocked only by articles that could still hide a signal', () => {
  const a = { id: 'a', date_placement: 'in_period', candidates: [{ row: { content_text: 'Evidence '.repeat(80) } }] };
  const noSignal = { quality: 'pass', entity_supported: true, indicator_supported: false };
  const reviews = new Map([['a', { decisions: [noSignal] }]]);
  assert.equal(coverageStatus([], reviews), 'no_monthly_sources');
  assert.equal(coverageStatus([a], reviews), 'reviewed');
  // A review that deferred judgement for lack of evidence blocks coverage.
  assert.equal(coverageStatus([a], new Map([['a', { decisions: [{ ...noSignal, quality: 'needs_review' }] }]])), 'incomplete_evidence');
  // Without a body, a title that matches both the company and an indicator event may hide a signal.
  const bodiless = { ...a, id: 'b', candidates: [{ row: {} }] };
  const both = (decision) => new Map([['a', { decisions: [noSignal] }], ['b', { decisions: [decision] }]]);
  assert.equal(coverageStatus([a, bodiless], both({ ...noSignal, indicator_supported: true })), 'incomplete_evidence');
  // A title that is clearly no signal does not, as long as the company has something that was read.
  assert.equal(coverageStatus([a, bodiless], both(noSignal)), 'reviewed');
  // A company whose every article is title-only was never read.
  assert.equal(coverageStatus([bodiless], both(noSignal)), 'incomplete_evidence');
  // A pending date blocks only when the article produced a report row.
  const pending = { ...a, date_placement: 'date_pending' };
  assert.equal(coverageStatus([pending], reviews), 'reviewed');
  assert.equal(coverageStatus([pending], reviews, 'completed', 0, new Set(['a'])), 'incomplete_evidence');
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

test('an S3 decision that could publish and mentions a debt buyback is asked again once', () => {
  const article = { candidates: [{ id: 'investment:3', kind: 'investment', row: { content_text: BODY, investment_signal_no: 3,
    title: 'BorgWarner Announces Pricing Terms of Cash Tender Offers for its Senior Notes' } }] };
  const decision = { candidate_id: 'investment:3', entity_supported: true, indicator_supported: true,
    target_technology_supported: false, leading_indicator_supported: true, event_stage: 'precursor', quality: 'pass',
    evidence_quotes: ['The Company made the Tender Offers as a balanced capital allocation strategy.'] };
  assert.equal(needsFundingReview(article, { decisions: [decision] }), true);
  assert.equal(needsFundingReview(article, { decisions: [decision], funding_review_version: 'funding-event-v2' }), false);
  assert.equal(needsFundingReview(article, { decisions: [{ ...decision, indicator_supported: false }] }), false);
  const round = { candidates: [{ ...article.candidates[0], row: { content_text: BODY, investment_signal_no: 3, title: 'Nexeon completes £100m investment round' } }] };
  assert.equal(needsFundingReview(round, { decisions: [{ ...decision, evidence_quotes: ['marks the completion of the investment round'] }] }), false);
});
