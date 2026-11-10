// 2026-11-10: 재시도 대상 기업이 남으면 발행을 멈추게 했다가 같은 날 되돌렸다. 남은 5개 기업이 다시 받을 때마다 같은 주소에서
// 같은 오류를 내 몇 번을 다시 돌려도 발행이 막혔다(실행 42773340938). 이제 발행은 하고 경고와 기록만 남긴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { collectionRetryable, retryableWarning } from '../scripts/publish_report.mjs';

const summary = { retryable_company_count: 5, collection_coverage: [
  { company: 'Amkor Technology', retryable: true }, { company: 'Magnix', retryable: true }, { company: 'BASF', retryable: false },
  { company: 'Schmalz', retryable: true }, { company: 'HyproMag', retryable: true }, { company: 'Veolia', retryable: true }] };

test('retryable companies left in the judged collection are listed, not held', () => {
  const retryable = collectionRetryable(summary);
  assert.deepEqual(retryable, { companies: ['Amkor Technology', 'Magnix', 'Schmalz', 'HyproMag', 'Veolia'], count: 5 });
  assert.equal(retryableWarning(retryable), 'Published although 5 companies still have temporary collection errors: '
    + 'Amkor Technology, Magnix, Schmalz, HyproMag, Veolia. Their articles may be missing from the report.');
  assert.deepEqual(collectionRetryable({ collection_coverage: [] }), { companies: [], count: 0 });
});

test('the publish workflow and dashboard no longer carry the hold', async () => {
  const workflow = await fs.readFile('.github/workflows/publish-report.yml', 'utf8');
  assert.doesNotMatch(workflow, /Held - retryable companies remain|allow_retryable_companies|held=true/);
  const pipeline = await fs.readFile('app/lib/report_pipeline.mjs', 'utf8');
  assert.doesNotMatch(pipeline, /HELD_STEP|발행 보류/);
  const publish = await fs.readFile('scripts/publish_report.mjs', 'utf8');
  assert.doesNotMatch(publish, /HELD_EXIT_CODE|exitCode = 65/);
});
