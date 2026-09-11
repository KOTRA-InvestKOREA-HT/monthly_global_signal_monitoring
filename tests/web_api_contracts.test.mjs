import test from 'node:test';
import assert from 'node:assert/strict';
import { dateParam, isCalendarDate, rangeProblem } from '../app/lib/date_range.mjs';

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
