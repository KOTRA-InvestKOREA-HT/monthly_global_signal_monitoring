import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { githubConfig } from '../app/lib/github_env.mjs';
import { suggestedIssue } from '../app/lib/issue_number.mjs';
import { PAUSED_STEP, dispatchFor, pipelineStatus } from '../app/lib/report_pipeline.mjs';

// 대시보드 버튼 한 번이 판정(collect-company-signals)과 발행(publish-report)을 차례로 돌린다.
// 상태 표시는 두 워크플로의 최근 실행을 합쳐 지금 단계를 보여 준다.

const run = (created_at, status, conclusion = null, extra = {}) =>
  ({ id: Date.parse(created_at), created_at, status, conclusion, html_url: 'https://example/run', ...extra });

test('the newer run is the current stage, and a pause is not a failure', () => {
  assert.equal(pipelineStatus({}).label, '대기');

  const judging = pipelineStatus({ collect: run('2026-10-01T00:00:00Z', 'in_progress') });
  assert.deepEqual([judging.stage, judging.label, judging.active, judging.can_publish], ['collect', '판정 중', true, false]);

  const paused = pipelineStatus({ collect: run('2026-10-01T00:00:00Z', 'completed', 'failure'), collectPaused: true });
  assert.deepEqual([paused.label, paused.paused, paused.can_publish], ['판정 일시정지', true, false]);
  assert.match(paused.hint, /다시 누르면 이어서/);

  const broken = pipelineStatus({ collect: run('2026-10-01T00:00:00Z', 'completed', 'failure') });
  assert.deepEqual([broken.label, broken.paused], ['판정 실패', false]);

  // 수동 실행(auto_publish 끔)으로 판정만 끝난 경우. 발행만 실행을 연다.
  const judged = pipelineStatus({ collect: run('2026-10-01T00:00:00Z', 'completed', 'success') });
  assert.deepEqual([judged.label, judged.can_publish], ['판정 완료', true]);

  // 버튼이 이어서 시작한 발행은 판정 실행보다 늦게 만들어진다.
  const collect = run('2026-10-01T00:00:00Z', 'completed', 'success');
  const publishing = pipelineStatus({ collect, publish: run('2026-10-01T03:00:00Z', 'queued') });
  assert.deepEqual([publishing.stage, publishing.label, publishing.active, publishing.can_publish], ['publish', '발행 중', true, false]);

  const done = pipelineStatus({ collect, publish: run('2026-10-01T03:00:00Z', 'completed', 'success') });
  assert.deepEqual([done.label, done.can_publish], ['완료', true], '같은 판정으로 다시 발행할 수 있다');

  const publishPaused = pipelineStatus({ collect, publish: run('2026-10-01T03:00:00Z', 'completed', 'failure'), publishPaused: true });
  assert.deepEqual([publishPaused.label, publishPaused.can_publish], ['발행 일시정지', true]);
  assert.match(publishPaused.hint, /발행만 실행/);

  // 발행 뒤에 판정을 다시 돌리면 판정이 지금 단계다.
  const rejudging = pipelineStatus({
    collect: run('2026-10-05T00:00:00Z', 'in_progress'),
    publish: run('2026-10-01T03:00:00Z', 'completed', 'success'),
  });
  assert.deepEqual([rejudging.stage, rejudging.label, rejudging.can_publish], ['collect', '판정 중', false]);
});

test('the issue number follows the last published issue for that month and the next', () => {
  const published = { issue_number: '4', period: { from_date: '2026-09-01', to_date: '2026-09-30' } };
  assert.equal(suggestedIssue(published, '2026-09-01'), '4');
  assert.equal(suggestedIssue(published, '2026-10-01'), '5');
  assert.equal(suggestedIssue({ issue_number: '7', period: { from_date: '2026-12-01' } }, '2027-01-01'), '8');
  // 건너뛴 달이나 지난 달은 짐작하지 않는다. 호수가 달마다 하나씩만 늘지 않았다.
  assert.equal(suggestedIssue(published, '2026-11-01'), '');
  assert.equal(suggestedIssue(published, '2026-08-01'), '');
  assert.equal(suggestedIssue(null, '2026-10-01'), '');
});

test('each button sends only the inputs its workflow defines', async () => {
  const config = { ...githubConfig(), workflowFile: 'collect-company-signals.yml', publishWorkflowFile: 'publish-report.yml' };
  const values = { days: '45', fromDate: '2026-09-01', toDate: '2026-09-30', issueNumber: '4' };
  const inputsOf = async file => {
    const text = (await fs.readFile(`.github/workflows/${file}`, 'utf8')).replace(/\r\n/g, '\n');
    const block = text.split('\n    inputs:\n')[1].split(/\n\S/)[0];
    return [...block.matchAll(/^ {6}(\w+):$/gm)].map(match => match[1]);
  };
  for (const stage of ['collect', 'publish']) {
    const { workflowFile, inputs } = dispatchFor(stage, config, values);
    const defined = await inputsOf(workflowFile);
    for (const name of Object.keys(inputs)) assert.ok(defined.includes(name), `${workflowFile} does not define ${name}; GitHub answers 422`);
  }
  assert.equal(dispatchFor('collect', config, values).inputs.auto_publish, 'true');
  assert.equal('auto_publish' in dispatchFor('publish', config, values).inputs, false);
  assert.equal(dispatchFor('publish', config, values).workflowFile, 'publish-report.yml');
});

test('manual collection judges only; the publish hand-off waits for a finished judgement', async () => {
  const collect = (await fs.readFile('.github/workflows/collect-company-signals.yml', 'utf8')).replace(/\r\n/g, '\n');
  const publish = (await fs.readFile('.github/workflows/publish-report.yml', 'utf8')).replace(/\r\n/g, '\n');
  // 수동 실행 폼의 기본값은 꺼짐이다. 버튼만 켜서 보낸다.
  assert.match(collect, /auto_publish:\n\s+description: [^\n]+\n\s+type: boolean\n\s+default: false/);
  assert.match(collect, /permissions:\n\s+contents: read\n(?:\s+#[^\n]*\n)?\s+actions: write/);

  // 두 워크플로 모두 종료 코드 75 만 이름 붙은 단계로 실패시킨다. 대시보드가 그 이름으로 일시정지를 알아본다.
  for (const [name, text, step] of [['collect', collect, 'review'], ['publish', publish, 'publish']]) {
    assert.ok(text.includes(`- name: ${PAUSED_STEP}\n`), `${name} lacks the paused step`);
    assert.ok(text.includes(`if: \${{ steps.${step}.outputs.paused == 'true' }}`), `${name} paused step is not tied to exit 75`);
    assert.match(text, /if \[ "\$code" -eq 75 \]; then echo "paused=true" >> "\$GITHUB_OUTPUT"; exit 0; fi\n\s+exit "\$code"/);
  }

  // 발행 실행 단계는 일시정지 단계 뒤에 있고, 상태 함수 없이 inputs.auto_publish 만 본다.
  // 그래야 기본 success() 가 붙어 앞 단계가 실패(일시정지 포함)하면 건너뛴다.
  const paused = collect.indexOf(`- name: ${PAUSED_STEP}`);
  const handOff = collect.indexOf('- name: Start publish-report for the finished judgement');
  assert.ok(paused > 0 && handOff > paused);
  const handOffStep = collect.slice(handOff);
  assert.match(handOffStep, /if: \$\{\{ inputs\.auto_publish \}\}/);
  assert.doesNotMatch(handOffStep, /always\(\)|failure\(\)/);
  assert.match(handOffStep, /gh workflow run publish-report\.yml/);
  assert.match(handOffStep, /FROM_DATE: \$\{\{ steps\.report_period\.outputs\.from_date \}\}/);

  // 발행이 멈추면 커밋까지 가지 않는다.
  assert.ok(publish.indexOf(`- name: ${PAUSED_STEP}`) < publish.indexOf('git-auto-commit-action'));
});

// 라우트는 호출 시점에 globalThis.fetch 를 쓴다.
const withGitHub = async (answer, body) => {
  const saved = { fetch: globalThis.fetch, env: { ...process.env } };
  Object.assign(process.env, { GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_TOKEN: 't' });
  delete process.env.GITHUB_WORKFLOW_FILE;
  delete process.env.GITHUB_PUBLISH_WORKFLOW_FILE;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    return answer(String(url), init);
  };
  try {
    const route = await import(`../app/api/trigger-crawl/route.js?case=${Math.random()}`);
    const response = await route.POST(new Request('http://local/api/trigger-crawl', { method: 'POST', body: JSON.stringify(body) }));
    return { response, payload: await response.json(), calls };
  } finally {
    globalThis.fetch = saved.fetch;
    process.env = saved.env;
  }
};

const reply = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });
const runs = list => reply(200, { workflow_runs: list });

test('the crawl button dispatches the judgement with auto_publish on', async () => {
  const { response, calls } = await withGitHub(() => reply(204),
    { fromDate: '2026-09-01', toDate: '2026-09-30', issueNumber: '4' });
  assert.equal(response.status, 202);
  const dispatch = calls.find(call => call.method === 'POST');
  assert.match(dispatch.url, /workflows\/collect-company-signals\.yml\/dispatches$/);
  assert.deepEqual(dispatch.body.inputs,
    { days: '45', from_date: '2026-09-01', to_date: '2026-09-30', issue_number: '4', auto_publish: 'true' });
});

test('an empty issue number is refused instead of printing issue 2', async () => {
  const { response, payload, calls } = await withGitHub(() => reply(204), { fromDate: '2026-09-01', toDate: '2026-09-30' });
  assert.equal(response.status, 400);
  assert.match(payload.error, /호수/);
  assert.equal(calls.length, 0);
});

test('publish-only is refused while there is no finished judgement', async () => {
  const answer = url => (url.includes('collect-company-signals.yml/runs')
    ? runs([run('2026-10-01T00:00:00Z', 'in_progress')])
    : url.includes('publish-report.yml/runs') ? runs([]) : reply(204));
  const { response, payload, calls } = await withGitHub(answer,
    { stage: 'publish', fromDate: '2026-09-01', toDate: '2026-09-30', issueNumber: '4' });
  assert.equal(response.status, 409);
  assert.match(payload.error, /판정 중/);
  assert.equal(calls.some(call => call.method === 'POST'), false);
});

test('publish-only dispatches publish-report without the judgement inputs', async () => {
  const answer = url => (url.includes('collect-company-signals.yml/runs')
    ? runs([run('2026-10-01T00:00:00Z', 'completed', 'success')])
    : url.includes('publish-report.yml/runs') ? runs([run('2026-10-01T03:00:00Z', 'completed', 'failure')])
      : url.includes('/jobs') ? reply(200, { jobs: [{ steps: [{ name: PAUSED_STEP, conclusion: 'failure' }] }] })
        : reply(204));
  const { response, calls } = await withGitHub(answer,
    { stage: 'publish', fromDate: '2026-09-01', toDate: '2026-09-30', issueNumber: '4' });
  assert.equal(response.status, 202);
  const dispatch = calls.find(call => call.method === 'POST');
  assert.match(dispatch.url, /workflows\/publish-report\.yml\/dispatches$/);
  assert.deepEqual(dispatch.body.inputs, { from_date: '2026-09-01', to_date: '2026-09-30', issue_number: '4' });
});
