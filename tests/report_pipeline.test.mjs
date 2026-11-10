import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { githubConfig } from '../app/lib/github_env.mjs';
import { suggestedIssue } from '../app/lib/issue_number.mjs';
import { HELD_STEP, PAUSED_STEP, dispatchFor, pipelineStatus, stopKind } from '../app/lib/report_pipeline.mjs';
import { HELD_EXIT_CODE, collectionRetryable, heldMessage } from '../scripts/publish_report.mjs';
import { HANDOFF_WAIT_MS, NOT_STARTED_LABEL, START_WAIT_MS, followRequest, requestedStatus, runRequest } from '../app/lib/run_request.mjs';

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

// 버튼을 누른 직후 GitHub 목록에는 아직 지난 실행(끝남)만 있다. 그것을 믿으면 폴링이 멈추고 진행이 보이지 않았다.
test('the dashboard keeps polling until the run it dispatched appears and finishes', () => {
  const pressed = Date.parse('2026-10-13T00:00:00Z');
  const at = seconds => pressed + seconds * 1000;
  const iso = seconds => new Date(at(seconds)).toISOString();
  const lastCollect = run('2026-10-01T00:00:00Z', 'completed', 'success');
  const lastPublish = run('2026-10-01T03:00:00Z', 'completed', 'success');
  const before = pipelineStatus({ collect: lastCollect, publish: lastPublish });
  assert.equal(before.active, false);

  const crawl = runRequest('collect', iso(0), at(1));
  assert.deepEqual([requestedStatus(crawl).label, requestedStatus(crawl).active], ['판정 대기', true]);

  // 3초 뒤 첫 확인: 새 판정이 아직 목록에 없다. 지난 발행 완료를 보이지 않고 계속 확인한다.
  let step = followRequest(before, crawl, at(4));
  assert.deepEqual([step.status.label, step.status.active, step.status.can_publish, step.status.html_url], ['판정 대기', true, false, undefined]);
  assert.equal(step.request, crawl);

  // 시계 차이(초 단위로 잘린 created_at)로 몇 초 이르게 찍힌 새 실행도 이번 실행이다.
  const judging = pipelineStatus({ collect: run(iso(-2), 'in_progress'), publish: lastPublish });
  step = followRequest(judging, step.request, at(14));
  assert.deepEqual([step.status.label, step.status.active], ['판정 중', true]);
  assert.ok(step.request);

  // 판정이 끝나면 발행이 이어진다. 발행 실행이 목록에 오를 때까지 판정 완료에서 멈추지 않는다.
  const judged = pipelineStatus({ collect: run(iso(-2), 'completed', 'success'), publish: lastPublish });
  step = followRequest(judged, step.request, at(3600));
  assert.deepEqual([step.status.label, step.status.active, step.status.can_publish], ['발행 대기', true, false]);
  assert.equal(step.request.handoff_deadline, at(3600) + HANDOFF_WAIT_MS);
  const publishing = pipelineStatus({ collect: run(iso(-2), 'completed', 'success'), publish: run(iso(3590), 'queued') });
  step = followRequest(publishing, step.request, at(3610));
  assert.deepEqual([step.status.label, step.status.active], ['발행 중', true]);
  const published = pipelineStatus({ collect: run(iso(-2), 'completed', 'success'), publish: run(iso(3590), 'completed', 'success') });
  step = followRequest(published, step.request, at(4700));
  assert.deepEqual([step.status.label, step.status.active, step.request], ['완료', false, null]);

  // 수동으로 끈 발행 등으로 발행이 끝내 나타나지 않으면 판정 완료와 '발행만 실행' 안내를 보인다.
  const waited = followRequest(judged, { ...crawl, handoff_deadline: at(3600) + HANDOFF_WAIT_MS }, at(3601) + HANDOFF_WAIT_MS);
  assert.deepEqual([waited.status.label, waited.status.active, waited.request], ['판정 완료', false, null]);

  // 판정이 멈추면 따라가기를 끝낸다.
  const paused = pipelineStatus({ collect: run(iso(5), 'completed', 'failure'), publish: lastPublish, collectPaused: true });
  assert.deepEqual([followRequest(paused, crawl, at(600)).status.label, followRequest(paused, crawl, at(600)).request], ['판정 일시정지', null]);
});

test('a dispatch that never shows up stops polling with a clear message', () => {
  const pressed = Date.parse('2026-10-13T00:00:00Z');
  const before = pipelineStatus({ collect: run('2026-10-01T00:00:00Z', 'completed', 'success'),
    publish: run('2026-10-01T03:00:00Z', 'completed', 'failure'), publishPaused: true });
  const publishOnly = runRequest('publish', new Date(pressed).toISOString(), pressed);
  assert.equal(followRequest(before, publishOnly, pressed + START_WAIT_MS).status.label, '발행 대기');
  const gaveUp = followRequest(before, publishOnly, pressed + START_WAIT_MS + 1);
  assert.deepEqual([gaveUp.status.label, gaveUp.status.active, gaveUp.request], [NOT_STARTED_LABEL, false, null]);
  assert.match(gaveUp.status.hint, /새 실행이 보이지 않습니다/);
  assert.equal(gaveUp.status.html_url, null, '지난 실행 링크를 이번 실행처럼 걸지 않는다');
  assert.equal(gaveUp.status.can_publish, true, '다시 누를 수 있다');

  // 상태 확인이 실패해도 곧바로 그만두지 않는다. 연달아 실패하면 그만둔다.
  let request = publishOnly;
  let step;
  for (let i = 0; i < 30; i += 1) {
    step = followRequest({ label: '확인 실패', status: 'error', error: 'HTTP 502' }, request, pressed + i * 10000);
    assert.deepEqual([step.status.label, step.status.active], ['확인 실패', true]);
    request = step.request;
  }
  step = followRequest({ label: '확인 실패', status: 'error' }, request, pressed + 300000);
  assert.equal(step.request, null);
  assert.equal(step.status.active, undefined);

  // 요청이 없으면 상태를 그대로 보인다.
  assert.deepEqual(followRequest(before, null), { status: before, request: null });
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
  const values = { fromDate: '2026-09-01', toDate: '2026-09-30', issueNumber: '4' };
  const inputsOf = async file => {
    const text = (await fs.readFile(`.github/workflows/${file}`, 'utf8')).replace(/\r\n/g, '\n');
    const block = text.split('\n    inputs:\n')[1].split(/\n\S/)[0];
    return [...block.matchAll(/^ {6}(\w+):$/gm)].map(match => match[1]);
  };
  for (const stage of ['collect', 'publish']) {
    for (const allowRetryable of [false, true]) {
      const { workflowFile, inputs } = dispatchFor(stage, config, { ...values, allowRetryable });
      const defined = await inputsOf(workflowFile);
      for (const name of Object.keys(inputs)) assert.ok(defined.includes(name), `${workflowFile} does not define ${name}; GitHub answers 422`);
    }
  }
  assert.equal(dispatchFor('collect', config, values).inputs.auto_publish, 'true');
  assert.equal('auto_publish' in dispatchFor('publish', config, values).inputs, false);
  assert.equal(dispatchFor('publish', config, values).workflowFile, 'publish-report.yml');
  // 재시도 대상 기업을 넘기는 입력은 '발행만 실행'에서 체크했을 때만 간다. 판정 버튼은 보내지 않는다.
  assert.equal(dispatchFor('publish', config, { ...values, allowRetryable: true }).inputs.allow_retryable_companies, 'true');
  assert.equal('allow_retryable_companies' in dispatchFor('publish', config, values).inputs, false);
  assert.equal('allow_retryable_companies' in dispatchFor('publish', config, { ...values, allowRetryable: 'true' }).inputs, false);
  assert.equal('allow_retryable_companies' in dispatchFor('collect', config, { ...values, allowRetryable: true }).inputs, false);
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

// Issue 5(2026-10)는 수집 요약에 재시도 대상 8개 기업이 남은 채 발행됐다. 발행 단계는 판정이 끝났는지만 봤고,
// 대시보드에도 그 목록이 보이지 않았다. 이제 발행은 문안을 쓰기 전에 멈추고, 대시보드는 "발행 보류"로 보인다.
const ISSUE5_RETRYABLE = ['Dupont', 'Chemours', '3M', 'Ouster', 'HyproMag', 'Texcell', 'DNP', 'Shanghai Electric Wind Power'];
const issue5Summary = { retryable_company_count: 8, collection_coverage: [
  { company: 'Australian Strategic Metals', status: 'completed', retryable: false, cached: false },
  ...ISSUE5_RETRYABLE.map(company => ({ company, status: 'incomplete', retryable: true, cached: false }))] };

test('publish holds a judgement whose collection still has retryable companies, unless a person allows it', () => {
  const period = { from_date: '2026-10-01', to_date: '2026-10-31' };
  const held = collectionRetryable(issue5Summary);
  assert.deepEqual([held.held, held.allowed, held.count, held.companies], [true, false, 8, ISSUE5_RETRYABLE]);
  const message = heldMessage(held, period);
  assert.match(message, /^8 companies still have temporary collection errors in the judged collection: Dupont, Chemours, 3M, Ouster, HyproMag, Texcell, DNP, Shanghai Electric Wind Power\./);
  assert.match(message, /collect-company-signals again for 2026-10-01\.\.2026-10-31/);
  assert.match(message, /allow_retryable_companies/);
  assert.doesNotMatch(message, /\n/, 'one line, so it fits an annotation');

  assert.deepEqual(collectionRetryable(issue5Summary, true), { companies: ISSUE5_RETRYABLE, count: 8, held: false, allowed: true });
  // 재시도 대상이 없으면 멈추지 않는다. 접근 거부(403)처럼 다시 받아도 같은 오류는 재시도 대상이 아니다.
  const clean = { retryable_company_count: 0, collection_coverage: [{ company: 'DNP', status: 'incomplete', retryable: false }] };
  assert.deepEqual(collectionRetryable(clean), { companies: [], count: 0, held: false, allowed: false });
  // 기업 목록이 없는 옛 요약도 수만 있으면 멈춘다.
  assert.equal(collectionRetryable({ retryable_company_count: 3 }).held, true);
  assert.equal(collectionRetryable(null).held, false);
});

test('a held publish exits before choosing a model or key and leaves a held status', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-held-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const period = { from_date: '2026-10-01', to_date: '2026-10-31' };
  const work = path.join(dir, 'outputs', 'review_work');
  await fs.mkdir(path.join(work, '2026-10-issue5'), { recursive: true });
  await fs.writeFile(path.join(work, 'status.json'), JSON.stringify({ stage: 'judgement', judged: true, status: 'completed',
    completed: 800, total: 800, period, run_dir: '2026-10-issue5', issue_number: '5' }));
  await fs.writeFile(path.join(work, '2026-10-issue5', 'snapshot.json'), JSON.stringify({ summary: issue5Summary, articles: [] }));
  // 키를 하나도 주지 않는다. 멈춤이 키 검사보다 먼저이므로 모델을 부를 수 없다.
  const env = { ...process.env, REPORT_FROM_DATE: period.from_date, REPORT_TO_DATE: period.to_date,
    GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: path.join(dir, 'step_summary.md') };
  for (const name of ['GEMINI_API_KEY', 'GEMINI_FOR_SUMMARY', 'GEMINI_FREE_TIER_CONFIRMED', 'REPORT_ISSUE_NUMBER',
    'REPORT_ALLOW_RETRYABLE_COMPANIES', 'GITHUB_RUN_ID']) delete env[name];
  const script = path.resolve('scripts/publish_report.mjs');

  const held = spawnSync(process.execPath, [script], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(held.status, HELD_EXIT_CODE, held.stderr);
  assert.notEqual(HELD_EXIT_CODE, 75, 'a hold is not a quota pause');
  assert.match(held.stdout, /::error title=Collection incomplete::8 companies .*Shanghai Electric Wind Power\./);
  const status = JSON.parse(await fs.readFile(path.join(work, 'publish_status.json'), 'utf8'));
  assert.deepEqual([status.status, status.reason, status.retryable_companies, status.retryable_company_count],
    ['held', 'collection_retryable', ISSUE5_RETRYABLE, 8]);
  assert.match(await fs.readFile(env.GITHUB_STEP_SUMMARY, 'utf8'), /^### Collection incomplete\n8 companies/);
  await assert.rejects(fs.access(path.join(dir, 'outputs', 'latest_collection_summary.json')), 'nothing is published');

  // 넘기면 멈춤을 지나 키 검사에서 멈춘다(키가 없다). 모델 호출 없이 넘김이 통하는 것만 본다.
  // 넘김이 막다른 길을 없앤다: DNP 의 설정 주소는 2026-11 확인으로 늘 500 이라 설정을 고칠 때까지 매 실행 남는다.
  const allowed = spawnSync(process.execPath, [script], { cwd: dir, env: { ...env, REPORT_ALLOW_RETRYABLE_COMPANIES: 'true' },
    encoding: 'utf8' });
  assert.equal(allowed.status, 1);
  assert.match(allowed.stdout, /Publishing with 8 retryable companies \(allow_retryable_companies\)/);
  assert.match(allowed.stderr, /GEMINI_FOR_SUMMARY \(or GEMINI_API_KEY\)/);
});

test('a held publish fails through its own named step, before validation and the commit', async () => {
  const collect = (await fs.readFile('.github/workflows/collect-company-signals.yml', 'utf8')).replace(/\r\n/g, '\n');
  const publish = (await fs.readFile('.github/workflows/publish-report.yml', 'utf8')).replace(/\r\n/g, '\n');
  assert.ok(publish.includes(`- name: ${HELD_STEP}\n`), 'publish lacks the held step');
  assert.ok(publish.includes(`if: \${{ steps.publish.outputs.held == 'true' }}`));
  assert.ok(publish.includes(`if [ "$code" -eq ${HELD_EXIT_CODE} ]; then echo "held=true" >> "$GITHUB_OUTPUT"; exit 0; fi\n`),
    'exit code of publish_report.mjs is tied to the held step');
  const held = publish.indexOf(`- name: ${HELD_STEP}`);
  assert.ok(held < publish.indexOf('- name: Validate report inputs') && held < publish.indexOf('git-auto-commit-action'));
  // 넘기는 입력은 기본이 꺼짐이고, 스크립트가 읽는 변수로 간다.
  assert.match(publish, /\n {6}allow_retryable_companies:\n {8}description: [^\n]+\n {8}type: boolean\n {8}default: false\n/);
  assert.match(publish, /\n {10}REPORT_ALLOW_RETRYABLE_COMPANIES: \$\{\{ inputs\.allow_retryable_companies \|\| 'false' \}\}\n/);
  assert.match(await fs.readFile('scripts/publish_report.mjs', 'utf8'), /process\.env\.REPORT_ALLOW_RETRYABLE_COMPANIES === 'true'/);
  // 판정이 이어서 시작하는 발행은 넘기지 않는다. 사람이 고르지 않은 발행은 늘 멈춘다.
  const handOff = collect.slice(collect.indexOf('- name: Start publish-report for the finished judgement'));
  assert.doesNotMatch(handOff, /allow_retryable_companies/);
});

test('the dashboard reads a held publish as 발행 보류 and keeps publish-only open to allow it', async () => {
  const collect = run('2026-11-02T07:02:00Z', 'completed', 'success');
  const publish = run('2026-11-02T08:40:00Z', 'completed', 'failure');
  const held = pipelineStatus({ collect, publish, publishHeld: true });
  // can_publish 가 true 라야 늘 남는 기업(DNP 의 영구 500 주소)이 매달 발행을 막지 않는다. 사람이 넘길 길이 열려 있다.
  assert.deepEqual([held.stage, held.label, held.held, held.paused, held.can_publish], ['publish', '발행 보류', true, false, true]);
  assert.match(held.hint, /'크롤링 수행'을 다시 누르면 그 기업만 다시 받아/);
  assert.match(held.hint, /'재시도 대상 기업이 남아도 발행'/);
  assert.equal(pipelineStatus({ collect, publish }).held, false);
  assert.equal(pipelineStatus({ collect, publish }).label, '발행 실패');

  // 실패한 단계 이름으로 가른다. 건너뛴 단계는 세지 않는다.
  assert.deepEqual(stopKind([{ steps: [{ name: HELD_STEP, conclusion: 'failure' }] }]), { paused: false, held: true });
  assert.deepEqual(stopKind([{ steps: [{ name: PAUSED_STEP, conclusion: 'failure' }, { name: HELD_STEP, conclusion: 'skipped' }] }]),
    { paused: true, held: false });
  assert.deepEqual(stopKind([{ steps: [{ name: 'Validate report inputs', conclusion: 'failure' }] }]), { paused: false, held: false });

  // 화면: 안내 문구를 보이고, 체크 상자는 발행 보류 뒤 '발행만 실행' 창에만 있다.
  const page = await fs.readFile('app/page.jsx', 'utf8');
  assert.match(page, /\["판정 완료", "판정 일시정지", "발행 일시정지", "발행 보류",/);
  assert.match(page, /runDialog === "publish" && crawlStatus\?\.held \? \(/);
  assert.match(page, /재시도 대상 기업이 남아도 발행/);
  assert.match(page, /allowRetryable: stage === "publish" && Boolean\(crawlStatus\?\.held\) && allowRetryable/);
});

// 수동 실행 폼의 호수 기본값이 "2"였다. 그대로 돌리면 status.json 에 2호가 기록되고 발행이 Issue 2 PDF 를 커밋했다.
test('no workflow fills in an issue number, and the hand-off stops early without one', async () => {
  const collect = (await fs.readFile('.github/workflows/collect-company-signals.yml', 'utf8')).replace(/\r\n/g, '\n');
  const publish = (await fs.readFile('.github/workflows/publish-report.yml', 'utf8')).replace(/\r\n/g, '\n');
  for (const text of [collect, publish]) {
    assert.match(text, /\n {6}issue_number:\n(?: {8}[^\n]*\n)*? {8}default: ""\n/);
  }
  // 판정 전에 검사한다. 한 시간 판정한 뒤 발행에서 실패하지 않게 한다.
  const check = collect.indexOf('- name: Check the issue number for the publish hand-off');
  assert.ok(check > 0 && check < collect.indexOf('- name: Collect and judge articles'));
  assert.match(collect.slice(check), /^- name: [^\n]+\n\s+if: \$\{\{ inputs\.auto_publish \}\}\n/);
});

// README 가 GEMINI_REVIEWER_MODEL=off 로 검토를 끈다고 안내했지만 워크플로가 그 변수를 넘기지 않았다.
// 스크립트가 읽는 모델 설정은 저장소 변수로 바꿀 수 있어야 한다.
test('each workflow passes the model settings its scripts read', async () => {
  const settings = {
    'collect-company-signals.yml': ['GEMINI_MODEL', 'NVIDIA_MODEL', 'GEMINI_THINKING_LEVEL', 'GEMINI_VERIFIER_MODEL',
      'GEMINI_VERIFIER_THINKING_LEVEL', 'REVIEW_VERIFIER'],
    'publish-report.yml': ['GEMINI_WRITER_MODEL', 'GEMINI_WRITER_THINKING_LEVEL', 'GEMINI_WRITER_TIMEOUT_MS',
      'GEMINI_REVIEWER_MODEL', 'GEMINI_REVIEWER_THINKING_LEVEL'],
  };
  for (const [file, names] of Object.entries(settings)) {
    const text = await fs.readFile(`.github/workflows/${file}`, 'utf8');
    for (const name of names) assert.match(text, new RegExp(`\\n {10}${name}: \\$\\{\\{ vars\\.${name} \\}\\}\\r?\\n`), `${file} ${name}`);
  }
});

// 제한 시간이 없으면 멈춘 실행이 두 워크플로가 같이 쓰는 동시 실행 그룹을 6시간 막는다.
// 긴 단계가 작업보다 먼저 끊겨야 진행 저장이 작업 제한 시간 안에서 돈다. 저장은 실패·취소에도 돈다.
test('both stages stop well before six hours and still save progress', async () => {
  for (const [file, step] of [['collect-company-signals.yml', 'review'], ['publish-report.yml', 'publish']]) {
    const text = (await fs.readFile(`.github/workflows/${file}`, 'utf8')).replace(/\r\n/g, '\n');
    const job = Number(text.match(/\n {4}timeout-minutes: (\d+)\n/)?.[1]);
    const long = Number(text.match(new RegExp(`\\n {8}id: ${step}\\n(?: {8}#[^\\n]*\\n)* {8}timeout-minutes: (\\d+)\\n`))?.[1]);
    assert.ok(job > 0 && job <= 180, `${file} job timeout ${job}`);
    assert.ok(long > 0 && job - long >= 15, `${file} leaves ${job - long} minutes after the ${step} step`);
    // 진행 상황(outputs/review_work)을 캐시에 저장하고 아티팩트로 올리는 두 단계.
    const saves = text.split('\n      - ').filter(block => /uses: actions\/(?:cache\/save|upload-artifact)@/.test(block)
      && /path: outputs\/review_work\n/.test(block));
    assert.equal(saves.length, 2, `${file} progress save and upload`);
    for (const block of saves) assert.match(block, new RegExp(`\\n {8}if: \\$\\{\\{ always\\(\\) && steps\\.${step}\\.outcome != 'skipped' \\}\\}\\n`));
  }
});

// 한 시간 남짓 도는 사이 main 에 커밋이 올라오면 push 가 fast-forward 가 아니라 거절됐다.
// 얕은 체크아웃에서는 rebase 가 공통 조상을 못 찾을 수 있어, 커밋 전에 새 main 으로 옮기고 결과 파일만 얹는다.
test('the publish commit lands on the latest main from a shallow checkout', async () => {
  const collect = (await fs.readFile('.github/workflows/collect-company-signals.yml', 'utf8')).replace(/\r\n/g, '\n');
  const publish = (await fs.readFile('.github/workflows/publish-report.yml', 'utf8')).replace(/\r\n/g, '\n');
  for (const text of [collect, publish]) assert.doesNotMatch(text, /fetch-depth/);

  const sync = publish.indexOf('- name: Move onto the latest main before committing');
  const commit = publish.indexOf('git-auto-commit-action');
  assert.ok(publish.indexOf('- name: Downloadable bilingual PDFs') < sync && sync < commit, 'PDFs are kept before the sync can fail');
  const step = publish.slice(sync, commit);
  assert.match(step, /git fetch --no-tags --depth=1 origin "refs\/heads\/\$GITHUB_REF_NAME"/);
  // 조상이 필요한 명령은 쓰지 않는다.
  assert.doesNotMatch(step, /git (?:rebase|merge|pull)\b/);
  // 결과 파일이 main 에서도 바뀌었으면 덮어쓰지 않고 실패한다. 패턴은 셸이 아니라 git 이 펼친다.
  assert.match(step, /set -f\n\s+changed=\$\(git diff --name-only "\$base" "\$latest" -- \$REPORT_COMMIT_FILES\)/);
  assert.match(step, /if \[ -n "\$changed" \]; then\n\s+echo "::error::[^\n]+\n\s+exit 1/);
  assert.match(step, /git reset --hard "\$latest"/);
  // 비교하는 파일과 커밋하는 파일이 같은 목록이다.
  assert.match(publish, /\n {6}REPORT_COMMIT_FILES: outputs\/latest_\*\.json public\/reports\/latest_report\.pdf public\/reports\/latest_report_en\.pdf\n/);
  assert.match(publish.slice(commit), /file_pattern: \$\{\{ env\.REPORT_COMMIT_FILES \}\}/);
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
  let dispatchedAt = null;
  const answer = (url, init) => {
    if (init.method !== 'POST') return runs([run('2026-10-01T00:00:00Z', 'completed', 'success')]);
    dispatchedAt ??= Date.now();
    return reply(204);
  };
  const { response, payload, calls } = await withGitHub(answer, { fromDate: '2026-09-01', toDate: '2026-09-30', issueNumber: '4' });
  assert.equal(response.status, 202);
  // 화면은 이 시각보다 먼저 만들어진 실행을 지난 실행으로 본다. 실행은 응답 전에 만들어질 수 있어 보내기 전에 잰다.
  assert.ok(Date.parse(payload.requested_at) <= dispatchedAt);
  const dispatch = calls.find(call => call.method === 'POST');
  assert.match(dispatch.url, /workflows\/collect-company-signals\.yml\/dispatches$/);
  assert.deepEqual(dispatch.body.inputs,
    { from_date: '2026-09-01', to_date: '2026-09-30', issue_number: '4', auto_publish: 'true' });
});

// 두 워크플로는 같은 동시 실행 그룹이고 GitHub 는 그룹마다 대기 실행을 하나만 둔다. 발행이 기다리는 중에
// 판정을 보내면 기다리던 발행이 말없이 취소됐다.
test('the crawl button is refused while a run is queued or running', async () => {
  const answer = url => (url.includes('collect-company-signals.yml/runs')
    ? runs([run('2026-10-01T00:00:00Z', 'completed', 'success')])
    : url.includes('publish-report.yml/runs') ? runs([run('2026-10-01T03:00:00Z', 'queued')]) : reply(204));
  const { response, payload, calls } = await withGitHub(answer, { fromDate: '2026-09-01', toDate: '2026-09-30', issueNumber: '4' });
  assert.equal(response.status, 409);
  assert.match(payload.error, /발행 중/);
  assert.equal(calls.some(call => call.method === 'POST'), false);
});

// 인증 없이 열리는 진단 주소다. 토큰 길이·앞 글자, 토큰 주인의 로그인, 저장소 이름을 내보내지 않는다.
test('the open diagnostic shows only whether settings exist and the GitHub status codes', async () => {
  const saved = { fetch: globalThis.fetch, env: { ...process.env } };
  Object.assign(process.env, { GITHUB_OWNER: 'secret-owner', GITHUB_REPO: 'secret-repo', GITHUB_TOKEN: 'ghp_abcdefghijklmnop' });
  globalThis.fetch = async url => (String(url).endsWith('/user')
    ? reply(200, { login: 'token-owner-login' }) : reply(200, { state: 'active' }));
  try {
    const route = await import(`../app/api/trigger-crawl/route.js?case=${Math.random()}`);
    const text = JSON.stringify(await (await route.GET()).json());
    for (const secret of ['ghp_', 'token-owner-login', 'secret-owner', 'secret-repo', '20자'])
      assert.ok(!text.includes(secret), `diagnostic leaks ${secret}`);
    assert.match(text, /"GITHUB_TOKEN":"설정됨"/);
    assert.match(text, /"token":\{"status":200,"ok":true\}/);
  } finally {
    globalThis.fetch = saved.fetch;
    process.env = saved.env;
  }
});

// 토큰 없이 부르면 비공개 저장소는 404 이고, 404 는 "실행 없음"이라 상태가 "대기"로 잘못 보였다.
test('the status route does not call GitHub without a token', async () => {
  const saved = { fetch: globalThis.fetch, env: { ...process.env } };
  Object.assign(process.env, { GITHUB_OWNER: 'o', GITHUB_REPO: 'r' });
  delete process.env.GITHUB_TOKEN;
  let called = false;
  globalThis.fetch = async () => { called = true; return reply(404, {}); };
  try {
    const route = await import(`../app/api/crawl-status/route.js?case=${Math.random()}`);
    const payload = await (await route.GET()).json();
    assert.equal(called, false);
    assert.equal(payload.label, '설정 필요');
    assert.match(payload.message, /GITHUB_TOKEN/);
  } finally {
    globalThis.fetch = saved.fetch;
    process.env = saved.env;
  }
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

// 발행 보류 뒤 사람이 체크하면 '발행만 실행'이 재시도 대상 기업을 넘기는 입력을 보낸다. 정확히 true 일 때만이고,
// 판정 버튼으로는 보내지 않는다.
test('publish-only after a hold sends allow_retryable_companies only when it was ticked', async () => {
  const answer = url => (url.includes('collect-company-signals.yml/runs')
    ? runs([run('2026-11-02T07:02:00Z', 'completed', 'success')])
    : url.includes('publish-report.yml/runs') ? runs([run('2026-11-02T08:40:00Z', 'completed', 'failure')])
      : url.includes('/jobs') ? reply(200, { jobs: [{ steps: [{ name: HELD_STEP, conclusion: 'failure' }] }] })
        : reply(204));
  const period = { fromDate: '2026-10-01', toDate: '2026-10-31', issueNumber: '5' };
  const dispatched = async body => {
    const { response, calls } = await withGitHub(answer, { ...period, ...body });
    assert.equal(response.status, 202);
    return calls.find(call => call.method === 'POST');
  };
  const allowed = await dispatched({ stage: 'publish', allowRetryable: true });
  assert.deepEqual(allowed.body.inputs,
    { from_date: '2026-10-01', to_date: '2026-10-31', issue_number: '5', allow_retryable_companies: 'true' });
  assert.equal('allow_retryable_companies' in (await dispatched({ stage: 'publish', allowRetryable: 'true' })).body.inputs, false);
  assert.equal('allow_retryable_companies' in (await dispatched({ stage: 'publish' })).body.inputs, false);
  const crawl = await dispatched({ allowRetryable: true });
  assert.match(crawl.url, /collect-company-signals\.yml\/dispatches$/);
  assert.equal('allow_retryable_companies' in crawl.body.inputs, false);
});
