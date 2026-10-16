import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { dashboardSignals, DASHBOARD_SIGNAL_FIELDS, isWithinPeriod, signalKey } from '../app/lib/dashboard_signals.mjs';

test('dashboard retains dates, decisions, ignore identifiers and links without full review evidence', () => {
  const row = { target_no: 1, company: 'A', investment_signal_no: 3,
    url: 'https://example.com/a', source_direct_url: 'https://example.com/original',
    published_at: '2026-08-10', date_conflict: false, ai_signal_supported: false,
    ai_summary_ko: '요약', content_excerpt: '발췌', content_text: 'Long original text',
    date_candidates: [{ date: '2026-08-10' }], ai_evidence_quotes: ['evidence'],
    // 레거시 키워드 스크립트만 만들던 필드는 화면에 싣지 않는다.
    matched_terms: ['x'], direct_source_url: 'https://example.com/legacy' };
  const [result] = dashboardSignals([row]);
  assert.equal(result.ai_signal_supported, false);
  assert.equal(result.date_conflict, false);
  assert.equal(Object.hasOwn(result, 'published_at_source'), false);
  assert.equal(dashboardSignals([{ ...row, published_at_source: '' }])[0].published_at_source, '');
  for (const field of ['target_no', 'company', 'investment_signal_no', 'url', 'source_direct_url', 'content_excerpt', 'ai_summary_ko']) {
    assert.equal(result[field], row[field]);
  }
  for (const field of ['content_text', 'date_candidates', 'ai_evidence_quotes', 'matched_terms', 'direct_source_url'])
    assert.equal(Object.hasOwn(result, field), false, field);
  assert.equal(row.content_text, 'Long original text');
});

test('the response contract covers every row field the dashboard reads', async () => {
  const fields = [];
  for (const file of ['../app/page.jsx', '../app/lib/dashboard_signals.mjs']) {
    const source = await fs.readFile(new URL(file, import.meta.url), 'utf8');
    fields.push(...[...source.matchAll(/\bitem(?:\?\.|\.)([A-Za-z_][A-Za-z_0-9]*)/g)].map(match => match[1]));
  }
  // Direct item.foo and item?.foo accesses include source selection and ignore keys.
  for (const field of fields) {
    assert.ok(DASHBOARD_SIGNAL_FIELDS.includes(field), `Missing dashboard field: ${field}`);
  }
  assert.ok(fields.length > 20);
});

// 무시 목록은 화면이 만든 키로 보고서 생성기(report_content.py fnv1a_utf8)가 행을 찾는다.
// 두 해시가 어긋나면 화면에서 무시한 시그널이 보고서에 그대로 실린다. 기대값은 Python 이 계산한 값이다.
test('the ignore key matches the report generator hash, non-ASCII names included', () => {
  assert.equal(signalKey({ target_no: 12, company: '3M', investment_signal_no: 3 }), '50571163');
  assert.equal(signalKey({ target_no: 7, company: 'Société Générale', investment_signal_no: 1 }), '19657db8');
  assert.match(signalKey({ company: 'A' }), /^[0-9a-f]{8}$/);
});

test('the period filter keeps month-only and undated rows for review', () => {
  const september = { fromDate: '2026-09-01', toDate: '2026-09-30' };
  assert.equal(isWithinPeriod({ published_at: '2026-09-15T10:00:00Z' }, september), true);
  assert.equal(isWithinPeriod({ published_at: '2026-10-01T00:00:00Z' }, september), false);
  assert.equal(isWithinPeriod({ published_at: '2026-08-31' }, september), false);
  // 게시월만 확인된 항목은 그 달이 기간과 겹치면 남긴다.
  assert.equal(isWithinPeriod({ published_at: '2026-09' }, september), true);
  assert.equal(isWithinPeriod({ published_month: '2026-08' }, september), false);
  // 날짜를 모르면 검토 후보로 남긴다.
  assert.equal(isWithinPeriod({ published_at: '' }, september), true);
  assert.equal(isWithinPeriod({ published_at: 'not a date' }, september), true);
});
