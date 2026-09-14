import test from 'node:test';
import assert from 'node:assert/strict';
import { collectionInputDigest, collectionNeedsRefresh } from '../scripts/collection_resilience.mjs';
import { coverageStatus, sourceCandidates } from '../scripts/local_report.mjs';
import { publishedSignalCounts } from '../scripts/review_report.mjs';

test('top-level collection cache respects expiry, inputs, failures and version', () => {
  const now = Date.parse('2026-09-10T12:00:00Z');
  const digest = collectionInputDigest([{ company: 'A' }], { feeds: ['https://example.com/feed'] });
  const expected = { version: 'v5', inputDigest: digest, now };
  const summary = { content_collection_version: 'v5', collection_resume_version: 1,
    collection_input_digest: digest, run_finished_at: '2026-09-10T11:00:00Z', retryable_company_count: 0 };
  assert.equal(collectionNeedsRefresh(summary, expected), false);
  for (const change of [{ run_finished_at: '2026-09-09T12:00:00Z' },
    { run_finished_at: 'not a timestamp' }, { run_finished_at: '2026-09-11T12:00:00Z' },
    { retryable_company_count: 1 }, { collection_input_digest: 'changed' }, { content_collection_version: 'v4' }])
    assert.equal(collectionNeedsRefresh({ ...summary, ...change }, expected), true);
  assert.notEqual(digest, collectionInputDigest([{ company: 'B' }], { feeds: ['https://example.com/feed'] }));
  assert.notEqual(digest, collectionInputDigest([{ company: 'A' }], { feeds: ['https://example.com/new-feed'] }));
});

test('unreviewable collected rows remain follow-up candidates and prevent completed coverage', () => {
  const period = { from_date: '2026-08-01', to_date: '2026-08-31' };
  const rows = [{ company: 'A', target_no: 1, title: 'No body or date', url: 'https://example.com/a', published_at_source: '' }];
  const candidates = sourceCandidates(rows, { companies: [] }, { indicators: [] }, period);
  assert.equal(candidates.deferred.length, 1);
  assert.equal(candidates.relevant.length, 0);
  assert.equal(coverageStatus([], new Map(), 'completed', candidates.deferred.length), 'incomplete_evidence');
});

test('approved totals distinguish report rows, pending dates and outside-period rows', () => {
  const period = { from_date: '2026-08-01', to_date: '2026-08-31' };
  const rows = [
    { company: 'A', published_at: '2026-08-10', published_at_source: 'feed' },
    { company: 'A', published_at: '2026-08-11', published_at_source: 'feed' },
    { company: 'B', published_at: '2026-08-12', published_at_source: 'url' },
    { company: 'C', published_at: '2026-07-01', published_at_source: 'feed' },
  ];
  assert.deepEqual(publishedSignalCounts(rows, period), { approved_count: 4, human_review_count: 0, report_signal_count: 2, approved_companies_in_report: 1,
    date_pending_count: 1, out_of_period_count: 1, companies_in_report: 1 });
});

test('human-review rows count toward the report only when both summaries exist, as in the PDF', () => {
  const period = { from_date: '2026-08-01', to_date: '2026-08-31' };
  const review = { company: 'R', published_at: '2026-08-10', published_at_source: 'feed',
    ai_signal_supported: false, ai_review_tier: 'human_review' };
  const counts = publishedSignalCounts([
    { company: 'A', published_at: '2026-08-10', published_at_source: 'feed' },
    { ...review, ai_summary_ko: '표제 - 상세', ai_summary_en: 'Headline - detail' },
    { ...review, company: 'S', ai_summary_ko: '', ai_summary_en: '' },
  ], period);
  assert.equal(counts.approved_count, 1);
  assert.equal(counts.human_review_count, 2);
  assert.equal(counts.report_signal_count, 2);
  assert.equal(counts.companies_in_report, 2);
  assert.equal(counts.approved_companies_in_report, 1);
});
