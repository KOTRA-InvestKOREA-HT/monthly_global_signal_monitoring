import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { dateParam, isCalendarDate, rangeProblem } from '../app/lib/date_range.mjs';
import { githubConfig, githubHeaders, missingGithubEnv } from '../app/lib/github_env.mjs';

// trigger-crawl 과 report 가 같은 정규식을 각자 들고 있었고, 둘 다 모양만 봤다.
test('a date that looks right but does not exist is refused, not rolled over', () => {
  // 2026-02-31 은 Date 에 넣으면 조용히 3월 3일이 된다. 요청한 날이 아닌 날로 도는 것이다.
  assert.equal(new Date('2026-02-31T00:00:00Z').toISOString().slice(0, 10), '2026-03-03');
  assert.equal(isCalendarDate('2026-02-31'), false);
  assert.equal(dateParam('2026-02-31'), '');
  for (const bad of ['2026-13-01', '2026-08-00', '0000-00-00', '2026-8-5', '', null, undefined])
    assert.equal(isCalendarDate(bad), false, String(bad));
  for (const good of ['2026-08-05', '2024-02-29', '2026-12-31'])
    assert.equal(isCalendarDate(good), true, good);
});

test('a range must have both ends and run forwards', () => {
  assert.equal(rangeProblem('', ''), null, '아무것도 없으면 기본 기간을 쓴다');
  assert.equal(rangeProblem('2026-08-01', '2026-08-31'), null);
  assert.match(rangeProblem('2026-08-01', ''), /함께/);
  assert.match(rangeProblem('2026-08-31', '2026-08-01'), /늦습니다/);
  assert.match(rangeProblem('2026-02-31', '2026-08-01'), /시작일이 올바른/);
  assert.match(rangeProblem('2026-08-01', '2026-02-31'), /종료일이 올바른/);
  // 같은 날 하루짜리 기간은 기간이다.
  assert.equal(rangeProblem('2026-08-05', '2026-08-05'), null);
});

// 투자 시그널 조회가 깨졌는데 화면에 "시그널 없음"이 뜨면, 실제로 없는 달과 구분할 수 없다.
// 없는 파일(404)은 빈 결과가 맞고, 읽기 실패는 드러나야 한다.
const withEnv = async (env, run) => {
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try { return await run(); } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
};

// 라우트는 호출 시점에 globalThis.fetch 를 쓰므로, 불러온 뒤에 갈아끼우면 된다.
const loadRoute = async (fetchImpl) => {
  globalThis.fetch = fetchImpl;
  return import(`../app/api/signals/route.js?case=${Math.random()}`);
};

const reply = (status, body) => new Response(JSON.stringify(body), { status });

test('a broken investment-signal read is reported, not shown as an empty month', async () => {
  await withEnv({ GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_TOKEN: 't' }, async () => {
    const contents = (name, payload) => ({ content: Buffer.from(JSON.stringify(payload)).toString('base64'), name });
    const answer = url => {
      if (url.includes('latest_investment_signals.json')) return reply(401, { message: 'Bad credentials' });
      if (url.includes('latest_company_signals.json')) return reply(200, contents('signals', []));
      if (url.includes('latest_collection_summary.json')) return reply(200, contents('summary', {}));
      return reply(200, contents('other', []));
    };
    const route = await loadRoute(async url => answer(String(url)));
    const response = await route.GET();
    assert.equal(response.status, 500, '토큰이 죽었는데 200 으로 빈 목록을 주면 안 된다');
    assert.match((await response.json()).error, /401/);
  });
});

test('a file that does not exist yet still yields an empty list', async () => {
  await withEnv({ GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_TOKEN: 't' }, async () => {
    const contents = payload => ({ content: Buffer.from(JSON.stringify(payload)).toString('base64') });
    const answer = url => {
      if (String(url).includes('latest_investment_signals.json')) return reply(404, { message: 'Not Found' });
      if (String(url).includes('latest_company_signals.json')) return reply(200, contents([]));
      if (String(url).includes('latest_collection_summary.json')) return reply(200, contents({}));
      return reply(200, contents([]));
    };
    const route = await loadRoute(async url => answer(String(url)));
    const response = await route.GET();
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).investmentSignals, []);
  });
});

// 세 라우트가 환경변수를 각자 읽었다. 실행 버튼만 공백·따옴표를 다듬었고 상태 조회와 신호
// 조회는 원값을 썼다. Vercel 변수에 따옴표가 섞이면 버튼은 돌아가는데 상태는 "확인 실패"가
// 되고 신호 조회는 말없이 로컬 파일로 떨어져, 화면에는 크롤링이 돈 흔적이 없어 보인다.
test('every GitHub-backed route reads the same cleaned environment', async t => {
  const saved = { ...process.env };
  t.after(() => { process.env = saved; });
  process.env.GITHUB_OWNER = ' "kotra" ';
  process.env.GITHUB_REPO = "'signal-monitor'\n";
  process.env.GITHUB_TOKEN = ' ghp_example ';
  delete process.env.GITHUB_REF;
  delete process.env.GITHUB_WORKFLOW_FILE;

  const config = githubConfig();
  assert.deepEqual(config, { token: 'ghp_example', owner: 'kotra', repo: 'signal-monitor',
    workflowFile: 'collect-company-signals.yml', ref: 'main' });
  assert.deepEqual(missingGithubEnv(config), []);

  // 공백만 든 값은 없는 값이다. 예전에는 소유자가 " " 여도 설정된 것으로 세어 GitHub 를 불렀다.
  process.env.GITHUB_OWNER = '   ';
  assert.equal(githubConfig().owner, '');
  assert.deepEqual(missingGithubEnv(), ['GITHUB_OWNER']);

  // 토큰이 없으면 Authorization 을 붙이지 않는다(비공개 저장소가 아니면 공개 읽기가 된다).
  assert.equal('Authorization' in githubHeaders(''), false);
  assert.equal(githubHeaders('abc').Authorization, 'Bearer abc');
});

test('no route builds its own GitHub headers or reads process.env directly', async () => {
  for (const file of ['app/api/crawl-status/route.js', 'app/api/signals/route.js', 'app/api/trigger-crawl/route.js']) {
    const source = await fs.readFile(file, 'utf8');
    assert.match(source, /github_env\.mjs/, `${file} must use the shared GitHub config`);
    assert.doesNotMatch(source, /process\.env\.GITHUB_|X-GitHub-Api-Version/, `${file} still reads GitHub settings on its own`);
  }
});
