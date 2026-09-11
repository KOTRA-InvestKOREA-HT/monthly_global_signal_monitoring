import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveReportPeriod } from '../scripts/report_period.mjs';

test('default report month follows Korea at UTC month boundaries and across years', () => {
  for (const [now, from_date, to_date] of [
    ['2026-08-31T14:59:59Z', '2026-07-01', '2026-07-31'],
    ['2026-08-31T15:00:00Z', '2026-08-01', '2026-08-31'],
    ['2026-01-15T00:00:00Z', '2025-12-01', '2025-12-31'],
    ['2024-03-01T00:00:00Z', '2024-02-01', '2024-02-29'],
  ]) assert.deepEqual(resolveReportPeriod({}, new Date(now)), { from_date, to_date });
});

test('explicit report dates accept real ranges and reject partial, impossible or reversed dates', () => {
  assert.deepEqual(resolveReportPeriod({ REPORT_FROM_DATE: ' 2024-02-29 ', REPORT_TO_DATE: '2024-02-29' }),
    { from_date: '2024-02-29', to_date: '2024-02-29' });
  for (const [from, to] of [
    ['2026-08-01', ''], ['', '2026-08-31'], ['2026-02-29', '2026-03-01'],
    ['2026-04-31', '2026-05-01'], ['2026-8-1', '2026-08-31'],
    ['2026-13-01', '2026-13-31'], ['bad', '2026-08-31'], ['2026-09-01', '2026-08-31'],
  ]) assert.throws(() => resolveReportPeriod({ REPORT_FROM_DATE: from, REPORT_TO_DATE: to }));
});

test('Actions output and CLI use the same validated period; invalid input writes no cache key', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'report-period-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const output = path.join(temp, 'github-output');
  const script = path.resolve('scripts/report_period.mjs');
  const env = { ...process.env, REPORT_FROM_DATE: '2026-08-01', REPORT_TO_DATE: '2026-08-31', GITHUB_OUTPUT: output };
  const result = spawnSync(process.execPath, [script, '--github-output'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), resolveReportPeriod(env));
  const saved = await fs.readFile(output, 'utf8');
  assert.equal(saved, 'from_date=2026-08-01\nto_date=2026-08-31\n');
  const invalid = spawnSync(process.execPath, [script, '--github-output'], {
    env: { ...env, REPORT_TO_DATE: '' }, encoding: 'utf8',
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /supplied together/);
  assert.equal(await fs.readFile(output, 'utf8'), saved);
});

test('monthly CLI aliases and Actions retain one article-review entrypoint', async () => {
  const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
  const workflow = await fs.readFile('.github/workflows/collect-company-signals.yml', 'utf8');
  assert.equal(pkg.scripts['collect:all'], pkg.scripts['report:review']);
  assert.ok(workflow.includes(`run: ${pkg.scripts['collect:all']}`));
  assert.match(workflow, /run: node scripts\/report_period\.mjs --github-output/);
  const entry = await fs.readFile(pkg.scripts['collect:all'].split(' ').at(-1), 'utf8');
  assert.match(entry, /sourceCandidates\(signals, technology, indicators, period\)/);
  assert.doesNotMatch(entry, /filter_relevant_signals|classify_investment_signals|summarize_signal_evidence/);
});

test('every directly invoked Node/Python script in active workflows exists', async () => {
  const directory = '.github/workflows';
  const names = await fs.readdir(directory);
  assert.ok(!names.includes('prepare-report-brief.yml'));
  assert.ok(!names.includes('build-report-from-brief.yml'));
  for (const name of names.filter(name => /\.ya?ml$/.test(name))) {
    const content = await fs.readFile(path.join(directory, name), 'utf8');
    for (const match of content.matchAll(/\b(?:node|python3?)\s+(?:--[\w-]+\s+)*(scripts\/[\w.-]+\.(?:mjs|py))/g)) {
      await assert.doesNotReject(fs.access(match[1]), `${name} references missing ${match[1]}`);
    }
  }
});
