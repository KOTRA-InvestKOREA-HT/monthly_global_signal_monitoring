import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { removeBuildDirs } from '../scripts/publish_report.mjs';

// 발행은 실행 폴더 안의 report-* 빌드 폴더를 남기지 않는다. 예전에는 성공할 때만 지워, 실패한 발행의
// 폴더가 캐시된 outputs/review_work 에 쌓였다. 판정 파일과 진단은 그대로 둔다.
test('publishing clears stale build folders and keeps everything else in the run folder', async t => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-run-'));
  t.after(() => fs.rm(runDir, { recursive: true, force: true }));
  for (const name of ['report-a1', 'report-b2']) {
    await fs.mkdir(path.join(runDir, name));
    await fs.writeFile(path.join(runDir, name, 'report_ko.pdf'), 'x');
  }
  await fs.writeFile(path.join(runDir, 'snapshot.json'), '{}');
  await fs.writeFile(path.join(runDir, 'date_pending.json'), '{}');
  await removeBuildDirs(runDir);
  assert.deepEqual((await fs.readdir(runDir)).sort(), ['date_pending.json', 'snapshot.json']);
  await removeBuildDirs(path.join(runDir, 'missing'));
});
