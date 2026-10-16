import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { dataRangeProblem } from '../app/lib/date_range.mjs';
import { viewModelOrigin } from '../app/lib/internal_request.mjs';
import { pythonCandidates, viewModelFromPython } from '../app/lib/python_view_model.mjs';
import { MAX_IGNORED_KEYS, reportOptions } from '../app/lib/report_request.mjs';

// 웹 보고서 다운로드(/api/report)의 요청 검사. api/report-view-model.py 가 같은 규칙을 Python 으로 들고 있다
// (tests/test_report_view_model_api.py).
const query = values => new URLSearchParams(values);

test('a report request without an issue number is refused instead of printing issue 2', () => {
  for (const issue of [undefined, '', ' ', 'abc', '0', '12345', '4a'])
    assert.match(reportOptions(query(issue === undefined ? {} : { issue })).error, /호수/, String(issue));
  assert.deepEqual(reportOptions(query({ issue: '04', lang: 'EN' })).options,
    { issue: '4', ignored: [], fromDate: '', toDate: '', lang: 'en' });
});

test('a report request needs a whole forward range of real dates', () => {
  assert.match(reportOptions(query({ issue: '4', from: '2026-09-01' })).error, /함께/);
  assert.match(reportOptions(query({ issue: '4', from: '2026-09-30', to: '2026-09-01' })).error, /늦습니다/);
  assert.match(reportOptions(query({ issue: '4', from: '2026-02-31', to: '2026-03-31' })).error, /올바른 날짜/);
  assert.deepEqual(reportOptions(query({ issue: '4', from: '2026-09-01', to: '2026-09-30' })).options,
    { issue: '4', ignored: [], fromDate: '2026-09-01', toDate: '2026-09-30', lang: 'ko' });
});

test('the ignore list is bounded and holds only dashboard signal keys', () => {
  assert.deepEqual(reportOptions(query({ issue: '4', ignored: '0a1b2c3d, ffffffff,' })).options.ignored, ['0a1b2c3d', 'ffffffff']);
  assert.match(reportOptions(query({ issue: '4', ignored: 'x'.repeat(5000) })).error, /무시 목록/);
  assert.match(reportOptions(query({ issue: '4', ignored: Array(MAX_IGNORED_KEYS + 1).fill('0a1b2c3d').join(',') })).error, /500건/);
});

// 배포에는 마지막 한 달 치만 실린다. 다른 달을 고르면 오류 없이 "0개사" 보고서가 나왔다.
test('a month outside the shipped data is refused with the month that is available', () => {
  assert.equal(dataRangeProblem('2026-09-01', '2026-09-30', '2026-09-01', '2026-09-30'), null);
  assert.equal(dataRangeProblem('2026-09-10', '2026-09-20', '2026-09-01', '2026-09-30'), null);
  assert.match(dataRangeProblem('2026-10-01', '2026-10-31', '2026-09-01', '2026-09-30'), /2026-09-01 ~ 2026-09-30/);
  assert.match(dataRangeProblem('2026-08-25', '2026-09-30', '2026-09-01', '2026-09-30'), /수집 데이터가 없습니다/);
  // 기간을 주지 않았거나 데이터 기간을 모르면 막지 않는다.
  assert.equal(dataRangeProblem('', '', '2026-09-01', '2026-09-30'), null);
  assert.equal(dataRangeProblem('2026-10-01', '2026-10-31', undefined, undefined), null);
});

const withEnv = async (env, run) => {
  const saved = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try { return await run(); } finally { process.env = saved; }
};

test('the report route answers 400 before computing anything when the request is wrong', async () => {
  await withEnv({ VERCEL: '1' }, async () => {
    const saved = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => { called = true; return new Response('{}'); };
    try {
      const route = await import(`../app/api/report/route.js?case=${Math.random()}`);
      for (const search of ['', '?issue=4&from=2026-09-01', '?issue=4&ignored=bad']) {
        const response = await route.GET(new Request(`https://deploy.example/api/report${search}`));
        assert.equal(response.status, 400, search);
      }
      assert.equal(called, false);
    } finally {
      globalThis.fetch = saved;
    }
  });
});

test('a 400 from the Python function reaches the viewer, other failures do not leak details', async () => {
  await withEnv({ VERCEL: '1' }, async () => {
    const saved = globalThis.fetch;
    const answers = [
      new Response(JSON.stringify({ error: '2026-10-01 ~ 2026-10-31 기간의 수집 데이터가 없습니다.' }), { status: 400 }),
      new Response('Traceback (most recent call last):\n  File "/var/task/scripts/report_content.py"', { status: 500 }),
    ];
    globalThis.fetch = async () => answers.shift();
    try {
      const route = await import(`../app/api/report/route.js?case=${Math.random()}`);
      const request = () => new Request('https://deploy.example/api/report?issue=5&from=2026-10-01&to=2026-10-31');
      const outside = await route.GET(request());
      assert.equal(outside.status, 400);
      assert.match((await outside.json()).error, /수집 데이터가 없습니다/);
      const broken = await route.GET(request());
      assert.equal(broken.status, 500);
      assert.doesNotMatch((await broken.json()).error, /Traceback|\/var\/task/);
    } finally {
      globalThis.fetch = saved;
    }
  });
});

// 자체 호스팅에서 요청 주소(Host 헤더)로 내부 호출을 보내면 쿠키가 아무 호스트로나 간다.
test('the internal view-model call goes to this deployment, not to whatever Host was sent', () => {
  assert.equal(viewModelOrigin('https://deploy.example/api/report', { VERCEL: '1' }), 'https://deploy.example');
  assert.equal(viewModelOrigin('https://attacker.example/api/report', {}), 'http://localhost:3000');
  assert.equal(viewModelOrigin('https://attacker.example/api/report', { PORT: '4000' }), 'http://localhost:4000');
  assert.equal(viewModelOrigin('https://attacker.example/api/report', { REPORT_VIEW_MODEL_ORIGIN: 'https://reports.example/x' }),
    'https://reports.example');
});

test('a real Python failure is not retried on every other interpreter', async () => {
  const options = { issue: '4', ignored: [], fromDate: '', toDate: '', lang: 'ko' };
  const tried = [];
  const failing = async command => {
    tried.push(command);
    if (command === 'missing') throw Object.assign(new Error('missing: spawn ENOENT'), { missing: true });
    if (command === 'bare') throw Object.assign(new Error("bare: No module named 'reportlab'"), { wrongInterpreter: true });
    throw new Error(`${command}: KeyError: 'company'`);
  };
  await assert.rejects(viewModelFromPython(options, { candidates: ['missing', 'bare', 'good', 'other'], run: failing }), /KeyError/);
  assert.deepEqual(tried, ['missing', 'bare', 'good']);

  // 모든 후보가 없는 해석기일 때만 Python 함수로 넘어갈 수 있다.
  const absent = await viewModelFromPython(options, { candidates: ['missing'], run: failing }).catch(error => error);
  assert.equal(absent.noInterpreter, true);
  const unusable = await viewModelFromPython(options, { candidates: ['missing', 'bare'], run: failing }).catch(error => error);
  assert.equal(unusable.noInterpreter, false);
});

test('no personal interpreter path is built into the report route', async () => {
  assert.deepEqual(pythonCandidates({ PYTHON_PATH: '/opt/py/bin/python' }).slice(0, 1), ['/opt/py/bin/python']);
  for (const file of ['app/api/report/route.js', 'app/lib/python_view_model.mjs']) {
    assert.doesNotMatch(await fs.readFile(file, 'utf8'), /codex-runtimes|USERPROFILE/, file);
  }
});
