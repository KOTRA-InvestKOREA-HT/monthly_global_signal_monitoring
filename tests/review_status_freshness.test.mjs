import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startingStatus } from '../scripts/review_report.mjs';

const ROOT = path.resolve('.');

test('a starting status names this run before any work begins', () => {
  const period = { from_date: '2026-08-01', to_date: '2026-08-31' };
  const status = startingStatus(period);
  assert.equal(status.status, 'running');
  assert.deepEqual(status.period, period);
  assert.equal(typeof status.started_at, 'string');
  // 실행 결과 필드는 아직 없다. 지난 실행의 completed·requests 가 남아 있으면 안 된다.
  assert.equal(status.completed, undefined);
  assert.equal(status.requests, undefined);
});

test("a restored status.json from an earlier run never survives into this run's artifact", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'status-freshness-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const workDir = path.join(temp, 'outputs', 'review_work');
  await fs.mkdir(path.join(workDir, '2026-08-01_2026-08-31'), { recursive: true });
  for (const file of ['docs/local_report_review.md', 'data/target_companies.json',
    'data/company_technology_map.json', 'config/investment_signal_indicators.json']) {
    await fs.mkdir(path.join(temp, path.dirname(file)), { recursive: true });
    await fs.copyFile(path.join(ROOT, file), path.join(temp, file));
  }
  // 캐시에서 복원된 지난 실행의 결과. 이것이 이번 실행의 것으로 읽히면 진단이 통째로 어긋난다.
  const ghost = { requests: 1, completed: 0, status: 'paused', reason: 'quota', http_status: 429 };
  await fs.writeFile(path.join(workDir, 'status.json'), JSON.stringify(ghost));
  // 수집분은 있으나 기간이 어긋나 판정 전에 멈춘다. 네트워크는 쓰지 않는다.
  await fs.writeFile(path.join(workDir, '2026-08-01_2026-08-31', 'latest_company_signals.json'), '[]');
  await fs.writeFile(path.join(workDir, '2026-08-01_2026-08-31', 'latest_collection_summary.json'),
    JSON.stringify({ from_date: '2026-07-01', to_date: '2026-07-31' }));
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/review_report.mjs')], {
    cwd: temp, encoding: 'utf8',
    env: { ...process.env, OPENAI_API_KEY: 'nvapi-test', REPORT_FROM_DATE: '2026-08-01', REPORT_TO_DATE: '2026-08-31',
      GITHUB_RUN_ID: '34180547079', GITHUB_SHA: 'deadbeef', GITHUB_REF_NAME: 'feat/local-monthly-report' },
  });
  assert.notEqual(result.status, 0);
  const written = JSON.parse(await fs.readFile(path.join(workDir, 'status.json'), 'utf8'));
  assert.notDeepEqual(written, ghost);
  assert.equal(written.http_status, null);
  // 아티팩트만 보고 어느 실행이었는지 알 수 있어야 한다.
  assert.equal(written.run.id, '34180547079');
  assert.equal(written.run.sha, 'deadbeef');
});
