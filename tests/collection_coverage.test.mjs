import assert from 'node:assert/strict';
import test from 'node:test';
import { mergePublisherDuplicateDates, usableMonthlySource } from '../scripts/collect_company_signals.mjs';

test('fallback requires dated monthly evidence after official detail enrichment', () => {
  const range = {fromMs: Date.parse('2026-08-01'), toMs: Date.parse('2026-09-01') - 1};
  const row = {published_at:'2026-08-20',source_type:'official',content_fetch_status:'fetched',content_text:'Actual article body'};
  assert.equal(usableMonthlySource(row, range), true);
  for (const changed of [{published_at:null},{published_at:'2026-07-31'},{published_at:'2026-09-01'}])
    assert.equal(usableMonthlySource({...row,...changed}, range), false);
  // An unreadable body does not make a dated monthly press release disappear.
  for (const changed of [{content_fetch_status:'error'},{content_fetch_status:'skipped_non_html'},{content_text:''}])
    assert.equal(usableMonthlySource({...row,...changed}, range), true);
});

test('an exact official/relay duplicate merges date evidence into one official row', () => {
  const official = { company: 'Example', source_type: 'official', url: 'https://example.com/article',
    source_direct_url: 'https://example.com/article', published_at: null, published_at_source: '', date_candidates: [] };
  const relay = { company: 'Example', source_type: 'fallback', url: 'https://news.google.com/rss/articles/opaque',
    source_direct_url: official.url, publisher_resolution: 'official_exact_title',
    publisher_resolution_source_url: 'https://example.com/news', published_at: '2026-08-20T00:00:00Z',
    published_at_source: 'feed', date_candidates: [{ date: '2026-08-20T00:00:00Z', month: '2026-08',
      source: 'feed', kind: 'published', precision: 'day' }] };
  const merged = mergePublisherDuplicateDates([official], [relay]);
  assert.equal(merged.officialRows.length, 1);
  assert.equal(merged.fallbackRows.length, 0);
  assert.equal(merged.officialRows[0].published_at.slice(0, 10), '2026-08-20');
  assert.equal(merged.officialRows[0].publisher_discovery_url, relay.url);
});

test('conflicting official and relay dates remain held after duplicate merge', () => {
  const evidence = (date, source) => ({ date: `${date}T00:00:00Z`, month: date.slice(0, 7),
    source, kind: 'published', precision: 'day' });
  const official = { source_type: 'official', url: 'https://example.com/article',
    date_candidates: [evidence('2026-07-31', 'listing')] };
  const relay = { source_direct_url: official.url, url: 'https://news.google.com/rss/articles/x',
    date_candidates: [evidence('2026-08-01', 'feed')] };
  const { officialRows } = mergePublisherDuplicateDates([official], [relay]);
  assert.equal(officialRows[0].date_conflict, true);
  assert.equal(usableMonthlySource(officialRows[0],
    { fromMs: Date.parse('2026-08-01'), toMs: Date.parse('2026-09-01') - 1 }), false);
});
