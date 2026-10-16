// 감사(2026-10-15) 2-5: 수집 범위 점검이 근접 후보까지 승인으로 세었다(35건 대 실제 18건).
import test from 'node:test';
import assert from 'node:assert/strict';
import { investmentCoverage } from '../scripts/audit_signal_coverage.mjs';

const period = { from_date: '2026-09-01', to_date: '2026-09-30' };
const dated = { published_at: '2026-09-10T00:00:00Z', published_at_source: 'meta', published_at_status: 'confirmed' };

test('the coverage audit counts only approved rows, as the report does', () => {
  const rows = [
    { company: 'A', ai_signal_supported: true, ...dated },
    { company: 'A', ai_signal_supported: false, ...dated },
    { company: 'B', ai_signal_supported: false, ...dated },
  ];
  const coverage = investmentCoverage(rows, period);
  assert.equal(coverage.approved_rows, 1);
  assert.equal(coverage.near_miss_rows, 2);
  assert.equal(coverage.approved_companies, 1);
  assert.deepEqual(coverage.report_companies.filter(company => company === 'B'), []);
});
