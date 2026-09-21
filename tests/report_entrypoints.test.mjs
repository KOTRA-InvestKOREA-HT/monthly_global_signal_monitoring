import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveReportPeriod } from '../scripts/report_period.mjs';
import { previousMonthRange } from '../scripts/report_month.mjs';

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

// 전월이 언제인지를 세 곳이 각자 계산했다. 자동 실행은 한국 시간, 실행 버튼(API)은 UTC,
// 화면은 브라우저 현지 시간이었다. 한국 시간 9월 1일 0시 30분(= UTC 8월 31일 15시 30분)에
// 자동 실행은 8월을 고르는데 버튼은 7월 수집을 보냈다.
test('the shared previous month follows Korea across UTC boundaries, years and leap days', () => {
  for (const [now, month_value, from_date, to_date] of [
    ['2026-08-31T14:59:59Z', '2026-07', '2026-07-01', '2026-07-31'],
    ['2026-08-31T15:00:00Z', '2026-08', '2026-08-01', '2026-08-31'],
    ['2026-01-15T00:00:00Z', '2025-12', '2025-12-01', '2025-12-31'],
    ['2026-03-15T00:00:00Z', '2026-02', '2026-02-01', '2026-02-28'],
    ['2024-03-01T00:00:00Z', '2024-02', '2024-02-01', '2024-02-29'],
  ]) {
    const range = previousMonthRange(new Date(now));
    assert.deepEqual({ month_value: range.month_value, from_date: range.from_date, to_date: range.to_date },
      { month_value, from_date, to_date }, now);
    // 보고 기간 결정도 같은 함수를 거친다.
    assert.deepEqual(resolveReportPeriod({}, new Date(now)), { from_date, to_date }, now);
  }
});

// 함수를 공유하는 것만으로는 다음 사람이 옆에 또 하나를 만드는 것을 막지 못한다.
// 전월을 고르는 자리에서 자기 달력 계산을 하는 파일이 없어야 한다.
test('no entry point computes the previous month on its own', async () => {
  const OWN_MONTH_MATH = /get(?:UTC)?Month\s*\(\)|new Date\([^)]*getMonth/;
  for (const file of ['app/api/trigger-crawl/route.js', 'app/page.jsx', 'scripts/report_period.mjs']) {
    const source = await fs.readFile(file, 'utf8');
    assert.match(source, /report_month\.mjs/, `${file} must take the month from the shared module`);
    assert.doesNotMatch(source, OWN_MONTH_MATH, `${file} still does its own month arithmetic`);
  }
});

// 파일 추적기는 JavaScript 의 import 만 따라간다. Python 쪽 의존은 next.config.mjs 가 손으로
// 적는 목록이 전부다. 빠뜨려도 빌드는 멀쩡히 끝나고 배포된 함수만 죽는다. 실제로 승인 상수를
// 공용 config 로 옮기고 내용 계층을 나눌 때 report_content.py 와 approval_policy.json 이
// 목록에 들어가지 않아, 추적된 파일만으로 실행하면 ModuleNotFoundError 가 났다.
test('the report route ships every file its Python entry point reaches', async () => {
  const saved = process.env.VERCEL;
  delete process.env.VERCEL;
  // 설정 모듈은 불러올 때 VERCEL 을 읽는다. 자체호스팅 분기(전체 목록)를 본다.
  const { default: config } = await import(`../next.config.mjs?packaging=${Date.now()}`);
  if (saved === undefined) delete process.env.VERCEL; else process.env.VERCEL = saved;

  const shipped = new Set((config.outputFileTracingIncludes['/api/report'] || [])
    .map(entry => entry.replace(/^\.\//, '')));

  // report_view_model.py 에서 시작해 scripts/ 안의 import 를 따라간다.
  const seen = new Set();
  const queue = ['scripts/report_view_model.py'];
  const dataFiles = new Set();
  // config/ 와 data/ 의 JSON 만 본다. 글꼴과 로고는 디렉터리 글로브로 실리고 있다.
  const PROJECT_FILE = /PROJECT_ROOT\s*\/\s*"(config|data)"\s*\/\s*"([\w.-]+\.json)"/g;
  const DEFAULT_PATH = /default="((?:data|config)\/[\w./-]+)"/g;
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = await fs.readFile(file, 'utf8');
    for (const match of source.matchAll(/^\s*(?:import|from)\s+([a-z_][\w]*)/gm)) {
      const candidate = `scripts/${match[1]}.py`;
      if (await fs.access(candidate).then(() => true, () => false)) queue.push(candidate);
    }
    for (const match of source.matchAll(PROJECT_FILE)) dataFiles.add(`${match[1]}/${match[2]}`);
    for (const match of source.matchAll(DEFAULT_PATH)) dataFiles.add(match[1]);
  }

  // 시작점만 훑고 끝나면 이 검사는 아무것도 지키지 못한다.
  assert.ok(seen.size >= 3, `expected the walk to follow imports, saw ${[...seen]}`);
  for (const file of [...seen, ...dataFiles]) {
    assert.ok(shipped.has(file), `next.config.mjs does not ship ${file} for /api/report`);
  }
});
