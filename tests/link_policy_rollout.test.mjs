import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, selectDetailRows, trimByRank, enrichOfficialRowsWithContent } from '../scripts/collect_company_signals.mjs';

const company = { company: 'Acme', target_no: 1 };
const row = { ...company, title: 'Acme announces new production facility', url: 'https://example.com/news/facility', source_type: 'official' };
const options = { ...parseArgs([]), rateLimitSeconds: 0, maxDetailPerCompany: 1, maxVerifyPerCompany: 2 };

test('production defaults recover accepted links and disable uncertain probes', () => {
  assert.equal(parseArgs([]).linkPolicy, 'proposed');
  assert.equal(parseArgs([]).maxVerifyPerCompany, 0);
  assert.equal(parseArgs(['--max-verify-per-company', '2']).maxVerifyPerCompany, 2);
  assert.throws(() => parseArgs(['--max-verify-per-company', '-1']));
  assert.throws(() => parseArgs(['--link-policy', 'typo']));
});

test('accepted links keep fetching priority even if uncertain links have newer dates', () => {
  const old = { ...row, link_verdict: 'accept', link_rank: 0 };
  const recovered = { ...row, url: row.url + '-new', link_verdict: 'accept', link_rank: 1 };
  const uncertain = { ...row, url: row.url + '-uncertain', link_verdict: 'fetch_to_verify', link_rank: 2, published_at: '2027-01-01' };
  assert.deepEqual(trimByRank(selectDetailRows([uncertain, recovered, old], 2), 2), [old, recovered]);
  assert.deepEqual(selectDetailRows([uncertain, recovered, old], 0), [old, recovered]);
});

test('disabled verification and no-body mode cannot leak unverified rows', async () => {
  const uncertain = { ...row, link_verdict: 'fetch_to_verify', content_text: 'An old cached body' };
  for (const args of [{ ...options, maxVerifyPerCompany: 0 }, { ...options, fetchOfficialContent: false }]) {
    const result = await enrichOfficialRowsWithContent([uncertain], args, '2026-09-10', company);
    assert.deepEqual(result.rows, []);
    assert.equal(result.requestCount, 0);
  }
});

test('failed verification is excluded while accepted inaccessible articles retain their evidence', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 403, statusText: 'Forbidden' }));
  for (const verdict of ['accept', 'fetch_to_verify']) {
    const result = await enrichOfficialRowsWithContent([{ ...row, link_verdict: verdict }], options, '2026-09-10', company);
    assert.equal(result.requestCount, 1);
    assert.equal(result.errors.length, 1);
    assert.equal(result.rows.length, verdict === 'accept' ? 1 : 0);
  }
});
