import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { dashboardSignals, DASHBOARD_SIGNAL_FIELDS } from '../app/lib/dashboard_signals.mjs';

test('dashboard retains dates, decisions, ignore identifiers and links without full review evidence', () => {
  const row = { target_no: 1, company: 'A', investment_signal_no: 3,
    url: 'https://example.com/a', direct_source_url: 'https://example.com/original',
    published_at: '2026-08-10', date_conflict: false, ai_signal_supported: false,
    ai_summary_ko: '요약', content_excerpt: '발췌', content_text: 'Long original text',
    date_candidates: [{ date: '2026-08-10' }], ai_evidence_quotes: ['evidence'] };
  const [result] = dashboardSignals([row]);
  assert.equal(result.ai_signal_supported, false);
  assert.equal(result.date_conflict, false);
  assert.equal(Object.hasOwn(result, 'published_at_source'), false);
  assert.equal(dashboardSignals([{ ...row, published_at_source: '' }])[0].published_at_source, '');
  for (const field of ['target_no', 'company', 'investment_signal_no', 'url', 'direct_source_url', 'content_excerpt', 'ai_summary_ko']) {
    assert.equal(result[field], row[field]);
  }
  for (const field of ['content_text', 'date_candidates', 'ai_evidence_quotes']) assert.equal(Object.hasOwn(result, field), false);
  assert.equal(row.content_text, 'Long original text');
});

test('the response contract covers every row field the dashboard reads', async () => {
  const page = await fs.readFile(new URL('../app/page.jsx', import.meta.url), 'utf8');
  const fields = [...page.matchAll(/\bitem(?:\?\.|\.)([A-Za-z_][A-Za-z_0-9]*)/g)].map(match => match[1]);
  // Direct item.foo and item?.foo accesses include source selection and ignore keys.
  for (const field of fields) {
    assert.ok(DASHBOARD_SIGNAL_FIELDS.includes(field), `Missing dashboard field: ${field}`);
  }
  assert.ok(fields.length > 20);
});
