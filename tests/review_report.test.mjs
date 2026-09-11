import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configuration, requestReview, reviewArticles, separateVerifiedQuotes, providerMessage, rateLimitHeaders, runIdentity, MODEL } from '../scripts/review_report.mjs';
import { groupArticles } from '../scripts/local_report.mjs';
import { DATE_HINT_VERSION } from '../scripts/review_providers.mjs';

// 수집한 본문이 기사인지 목록·오류 페이지인지는 길이로도 갈린다. 고정값도 실제 기사 길이를 쓴다.
const TAIL = "The company said the site would support qualification volumes first, "
  + "that a final location has not been chosen, and that no construction contract has been signed. "
  + "It declined to give a timeline, and said the plan stays under review until the board meets.";

const article = company => groupArticles([{ company, target_no: 1, url: `https://example.com/${company}`, title: 'Pilot plant', published_at: '2026-08-02', investment_signal_no: 2, target_technology: 'material', content_text: `The company plans a pilot plant. ${TAIL}` }], [], { from_date: '2026-08-01', to_date: '2026-08-31' })[0];
const decisions = [{ candidate_id: 'investment:2', entity_supported: true, target_technology_supported: true, indicator_supported: true, leading_indicator_supported: true, event_stage: 'planned', quality: 'pass', reason_ko: '파일럿 생산시설 계획을 확인함', evidence_quotes: ['The company plans a pilot plant.'], summary_ko: '파일럿 생산시설 계획', summary_en: 'Pilot production plant planned' }];
const response = (ds = decisions, finish_reason = 'stop') => new Response(JSON.stringify({ choices: [{ finish_reason, message: { content: JSON.stringify({ decisions: ds }) } }], usage: {} }));
const config = { apiKey: 'test-key', maxRequests: 40, delayMs: 15000 };

// Run 34204971030: an invalid quote was repaired, but the S4 precursor
// then had no bilingual summaries. A third, targeted repair must be possible.
test('quote then missing S4 summaries gets one bounded repair and reuses completed cache', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-summary-repair-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const a = article('HyproMag');
  a.candidates[0].id = 'investment:4';
  a.candidates[0].row.investment_signal_no = 4;
  const good = [{ ...decisions[0], candidate_id: 'investment:4', event_stage: 'precursor' }];
  const missing = good.map(d => ({ ...d, summary_ko: '', summary_en: '' }));
  let calls = 0;
  const args = { articles: [a], reviewDir, policy: '', config, sleep: async () => {} };
  const state = await reviewArticles({ ...args, fetchImpl: async (_, init) => {
    calls++;
    const body = JSON.parse(init.body);
    if (calls === 1) return response(good.map(d => ({ ...d, evidence_quotes: ['Invented quote'] })));
    if (calls === 2) {
      assert.match(body.messages[2].content, /evidence_quotes must be exact passages/);
      return response(missing);
    }
    assert.match(body.messages[2].content, /missing ai_summary_ko/);
    assert.match(body.messages[2].content, /missing ai_summary_en/);
    return response(good);
  } });
  assert.equal(state.status, 'completed');
  assert.equal(state.requests, 3);
  assert.equal(state.diagnostics.length, 2);
  const resumed = await reviewArticles({ ...args, fetchImpl: async () => assert.fail('valid cache must be reused') });
  assert.equal(resumed.cached, 1);
  assert.equal(resumed.requests, 0);

  const b = article('StillMissing');
  const bounded = await reviewArticles({ ...args, articles: [b], fetchImpl: async () => response(decisions.map(d => ({ ...d, summary_ko: '', summary_en: '' }))) });
  assert.equal(bounded.status, 'paused');
  assert.equal(bounded.requests, 3);
  assert.equal(bounded.failed_articles.length, 1);
  const budget = await reviewArticles({ ...args, articles: [b], config: { ...config, maxRequests: 2 },
    fetchImpl: async () => response(decisions.map(d => ({ ...d, summary_ko: '', summary_en: '' }))) });
  assert.equal(budget.reason, 'request_budget');
  assert.equal(budget.requests, 2);
});

// 게시일 미상 기사. 본문 안에 게시일이 문장으로 적혀 있다.
const datedQuote = 'Published on August 14, 2026.';
const pendingBody = `The company plans a pilot plant. ${TAIL} ${datedQuote}`;
const pendingArticle = company => groupArticles([{ company, target_no: 1, url: `https://example.com/${company}`, title: 'Pilot plant', published_at: null, published_at_source: '', investment_signal_no: 2, target_technology: 'material', content_text: pendingBody }], [], { from_date: '2026-08-01', to_date: '2026-08-31' })[0];
const pendingDecisions = [{ ...decisions[0], evidence_quotes: [pendingBody] }];
const dated = (published_date, published_date_quote, ds = pendingDecisions) =>
  new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ decisions: ds, published_date, published_date_quote }) } }], usage: {} }));

test('the article-level date reaches the review object, and a date it cannot quote is rejected', async () => {
  const a = pendingArticle('Undated');
  assert.equal(a.date_placement, 'date_pending');
  const review = await requestReview(a, '', 'key', async () => dated('2026-08-14', datedQuote));
  assert.equal(review.published_date, '2026-08-14');
  assert.equal(review.published_date_quote, datedQuote);
  // 스키마에 없던 옛 응답은 제안 없음으로 읽는다. 날짜가 확정된 기사도 빈 값으로 지나간다.
  const empty = await requestReview(article('Dated'), '', 'key', async () => response());
  assert.equal(empty.published_date, '');
  assert.equal(empty.published_date_quote, '');
  const emptyPair = await requestReview(a, '', 'key', async () => dated('', ''));
  assert.equal(emptyPair.published_date, '');
  // 인용문이 그 날짜를 말하지 않으면 거부한다. 인용이 기사에 있다는 것만으로는 부족하다.
  for (const [date, quote] of [['2026-08-15', datedQuote], ['2026-08-14', 'The company plans a pilot plant.'],
    ['2026-08-14', 'Published on August 14, 2026 by staff.'], ['August 14, 2026', datedQuote]]) {
    await assert.rejects(requestReview(a, '', 'key', async () => dated(date, quote)), /date_evidence_mismatch/);
  }
});

test('a cached review gains a date hint once without re-deciding the article', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'date-hint-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const a = pendingArticle('Undated');
  const file = path.join(reviewDir, `${a.id}.json`);
  // 날짜 스키마 이전에 저장된 판정: 두 필드가 아예 없다.
  const before = { article_id: a.id, reviewer: `${MODEL}/article-review-v1`, provider: 'nvidia', decisions: pendingDecisions };
  await fs.writeFile(file, JSON.stringify(before));
  const args = { articles: [a], reviewDir, policy: '', config, sleep: async () => {} };
  const topped = await reviewArticles({ ...args, fetchImpl: async () => dated('2026-08-14', datedQuote, [{ ...pendingDecisions[0], summary_ko: '재판정된 다른 요약' }]) });
  assert.equal(topped.status, 'completed');
  assert.equal(topped.cached, 1);
  assert.equal(topped.requests, 1);
  assert.equal(topped.date_hints, 1);
  const stored = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(stored.published_date, '2026-08-14');
  // 보강 호출의 판정은 버린다. 캐시된 내용 판정이 날짜 때문에 흔들리면 안 된다.
  assert.deepEqual(stored.decisions, before.decisions);
  // 한 번 물어본 기사는 다시 묻지 않는다. 빈 답도 물어본 것이다.
  const again = await reviewArticles({ ...args, fetchImpl: async () => { throw new Error('must not ask twice'); } });
  assert.equal(again.requests, 0);
  assert.equal(again.cached, 1);
});

test('a failed or unavailable date hint never costs the cached decision or the run', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'date-hint-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const a = pendingArticle('Undated'), b = article('Dated');
  const cache = article => fs.writeFile(path.join(reviewDir, `${article.id}.json`),
    JSON.stringify({ article_id: article.id, reviewer: `${MODEL}/article-review-v1`, provider: 'nvidia',
      decisions: article === a ? pendingDecisions : decisions }));
  await Promise.all([cache(a), cache(b)]);
  const args = { articles: [a, b], reviewDir, policy: '', config, sleep: async () => {}, random: () => 0 };
  // 날짜가 확정된 기사는 보강 대상이 아니므로 호출은 미상 기사 하나에만 쓰인다.
  let calls = 0;
  const state = await reviewArticles({ ...args, fetchImpl: async () => { calls++; return new Response('', { status: 429 }); } });
  assert.equal(calls, 1);
  assert.equal(state.status, 'completed');
  assert.equal(state.cached, 2);
  assert.equal(state.date_hints, 0);
  // 실패한 보강은 캐시를 건드리지 않는다. 다음 실행이 다시 시도한다.
  const stored = JSON.parse(await fs.readFile(path.join(reviewDir, `${a.id}.json`), 'utf8'));
  assert.equal('published_date' in stored, false);
  assert.deepEqual(stored.decisions, pendingDecisions);
  const rejected = await reviewArticles({ ...args, fetchImpl: async () => dated('2026-08-15', datedQuote) });
  assert.equal(rejected.status, 'completed');
  assert.equal(rejected.date_hints, 0);
  assert.equal('published_date' in JSON.parse(await fs.readFile(path.join(reviewDir, `${a.id}.json`), 'utf8')), false);
});

test('a date hint that is still unusable on retry is discarded so the content review survives', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'date-hint-discard-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const a = pendingArticle('Undated');
  let calls = 0;
  // 인용문은 8월 14일을 말하는데 제안은 8월 15일이다. 판정 자체는 두 번 다 정상이다.
  const state = await reviewArticles({ articles: [a], reviewDir, policy: '', config, sleep: async () => {},
    fetchImpl: async () => { calls++; return dated('2026-08-15', datedQuote); } });
  // 첫 실패는 기존 재시도를 쓴다. 두 번째에도 날짜만 어긋나면 힌트를 버린다.
  assert.equal(calls, 2);
  assert.equal(state.status, 'completed');
  assert.equal(state.completed, 1);
  assert.deepEqual(state.failed_articles, []);
  const stored = JSON.parse(await fs.readFile(path.join(reviewDir, `${a.id}.json`), 'utf8'));
  // 날짜는 보조 정보다. 근거 없는 날짜는 버리되 판정은 남는다.
  assert.equal(stored.published_date, '');
  assert.equal(stored.published_date_quote, '');
  assert.deepEqual(stored.decisions, pendingDecisions);
  // 버린 것도 물어본 것이다. 규칙이 바뀌기 전까지 다시 묻지 않는다.
  assert.equal(stored.date_hint_version, DATE_HINT_VERSION);
});

test('discarding the date hint never hides a decision that failed its own validation', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'date-hint-discard-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const a = pendingArticle('Undated');
  // 날짜도 인용도 어긋난 응답. 날짜를 버린 뒤 판정을 다시 검증하면 인용 위조가 그대로 드러난다.
  const state = await reviewArticles({ articles: [a], reviewDir, policy: '', config, sleep: async () => {},
    fetchImpl: async () => dated('2026-08-15', datedQuote, [{ ...pendingDecisions[0], evidence_quotes: ['Invented quote'] }]) });
  assert.equal(state.status, 'paused');
  assert.equal(state.reason, 'invalid_responses');
  assert.deepEqual(state.failed_articles, [{ article_id: a.id, reason: 'evidence_mismatch' }]);
  await assert.rejects(fs.access(path.join(reviewDir, `${a.id}.json`)));
});

test('bumping only the date hint version re-asks the date and keeps every content decision cached', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'date-hint-version-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const a = pendingArticle('Undated'), b = article('Dated');
  const cache = (article, ds, date_hint_version) => fs.writeFile(path.join(reviewDir, `${article.id}.json`),
    JSON.stringify({ article_id: article.id, reviewer: `${MODEL}/article-review-v1`, provider: 'nvidia',
      decisions: ds, date_hint_version, published_date: '', published_date_quote: '' }));
  // 이전 규칙으로 물어봐 빈 답을 받은 기사. 프롬프트·파서가 바뀌었으므로 날짜만 다시 묻는다.
  await cache(a, pendingDecisions, 'date-hint-v0');
  await cache(b, decisions, 'date-hint-v0');
  let calls = 0;
  const state = await reviewArticles({ articles: [a, b], reviewDir, policy: '', config, sleep: async () => {},
    fetchImpl: async () => { calls++; return dated('2026-08-14', datedQuote); } });
  // 날짜가 이미 확정된 기사는 버전을 올려도 다시 묻지 않는다. 미상 기사 하나만 호출한다.
  assert.equal(calls, 1);
  assert.equal(state.cached, 2);
  assert.equal(state.completed, 2);
  assert.equal(state.date_hints, 1);
  const stored = JSON.parse(await fs.readFile(path.join(reviewDir, `${a.id}.json`), 'utf8'));
  assert.equal(stored.date_hint_version, DATE_HINT_VERSION);
  assert.equal(stored.published_date, '2026-08-14');
  // 힌트 버전을 올려도 내용 판정은 캐시된 그대로다. 이것이 VERSION 과 분리한 목적이다.
  assert.deepEqual(stored.decisions, pendingDecisions);
});

test('DeepSeek no-investment responses validate on first request and are reused from cache', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-rejected-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const row = article('Infineon').candidates[0].row;
  const a = groupArticles([1, 2, 3, 4, 5].map(investment_signal_no => ({ ...row, investment_signal_no })), [row],
    { from_date: '2026-08-01', to_date: '2026-08-31' })[0];
  const ds = a.candidates.map(c => ({ ...decisions[0], candidate_id: c.id, event_stage: 'not_applicable',
    target_technology_supported: false, indicator_supported: false, leading_indicator_supported: false,
    evidence_quotes: [], summary_ko: '', summary_en: '', reason_ko: '기사에 해당 투자 활동이 없음' }));
  const args = { articles: [a], reviewDir, policy: '', config };
  const first = await reviewArticles({ ...args, fetchImpl: async () => response(ds) });
  assert.equal(first.status, 'completed');
  assert.equal(first.requests, 1);
  assert.deepEqual(first.diagnostics, []);
  const stored = JSON.parse(await fs.readFile(path.join(reviewDir, `${a.id}.json`), 'utf8'));
  assert.equal(stored.decisions[0].event_stage, 'not_applicable');
  assert.equal(stored.decisions[0].indicator_supported, false);
  const resumed = await reviewArticles({ ...args, fetchImpl: async () => { throw new Error('must use cached review'); } });
  assert.equal(resumed.cached, 1);
  assert.equal(resumed.requests, 0);
});

// Actual failed HyproMag investment:2 quote: the model omitted the middle sentence.
const remloyPlant = 'Remloy has developed a plant in Bitterfeld, Germany, which recycles end-of-life rare earth magnets via a melting process (medium loop recycling) to produce neodymium-iron-boron (“NdFeB”) alloy powders for the bonded and hot deformed magnet markets.';
const remloyMiddle = 'The Remloy process is complementary to HyProMag’s short loop recycling process to produce sintered magnets, and to Mkango Rare Earths UK’s long loop recycling process, to produce mixed rare earth carbonates and oxides.';
const remloyCapacity = 'Target capacity is at least 500 tonnes per year of NdFeB alloy powder.';

test('real HyproMag joined quote becomes two independently verified passages', async () => {
  const a = article('HyproMag');
  a.evidence = [[remloyPlant, remloyMiddle, remloyCapacity].join(' ')];
  const joined = `${remloyPlant} ${remloyCapacity}`;
  const review = await requestReview(a, '', 'key', async () => response([{ ...decisions[0], evidence_quotes: [joined] }]));
  assert.deepEqual(review.decisions[0].evidence_quotes, [remloyPlant, remloyCapacity]);
  assert.equal(review.quote_repairs[0].original_quote, joined);
  assert.equal(review.quote_repairs[0].evidence_block_index, 0);
  for (const field of ['entity_supported', 'indicator_supported', 'event_stage', 'quality', 'summary_ko', 'summary_en']) {
    assert.equal(review.decisions[0][field], decisions[0][field]);
  }
});

test('quote separation rejects altered numbers, ellipses, reversed passages and cross-block joins', async () => {
  const a = article('HyproMag');
  a.evidence = [[remloyPlant, remloyMiddle, remloyCapacity].join(' ')];
  for (const quote of [`${remloyPlant} ${remloyCapacity.replace('500', '900')}`,
    `${remloyPlant} ... ${remloyCapacity}`, `${remloyCapacity} ${remloyPlant}`]) {
    await assert.rejects(requestReview(a, '', 'key', async () => response([{ ...decisions[0], evidence_quotes: [quote] }])), /evidence_mismatch/);
  }
  a.evidence = [remloyPlant, remloyCapacity];
  const ds = [{ ...decisions[0], evidence_quotes: [`${remloyPlant} ${remloyCapacity}`] }];
  const separated = separateVerifiedQuotes(a, ds);
  assert.deepEqual(separated.decisions, ds);
  assert.deepEqual(separated.repairs, []);
});

test('requires explicit free-tier confirmation and bounds API requests', () => {
  assert.throws(() => configuration({}), /OPENAI_API_KEY is required/);
  assert.deepEqual(configuration({ OPENAI_API_KEY: 'key' }), { apiKey: 'key', maxRequests: 400, delayMs: 1600, concurrency: 4 });
  assert.throws(() => configuration({ OPENAI_API_KEY: 'key', REPORT_CONCURRENCY: '13' }), /CONCURRENCY/);
  assert.throws(() => configuration({ OPENAI_API_KEY: 'key', NVIDIA_MAX_REQUESTS: '0' }), /1..400/);
  assert.throws(() => configuration({ OPENAI_API_KEY: 'key', NVIDIA_DELAY_MS: '1499' }), /1500..60000/);
  assert.deepEqual(configuration({ OPENAI_API_KEY: 'key', NVIDIA_MAX_REQUESTS: '400', NVIDIA_DELAY_MS: '1600' }), { apiKey: 'key', maxRequests: 400, delayMs: 1600, concurrency: 4 });
});

test('uses one fixed endpoint, structured output and all article candidates', async () => {
  const a = article('Example');
  const review = await requestReview(a, 'policy', 'test-key', async (url, init) => {
    assert.equal(url, 'https://integrate.api.nvidia.com/v1/chat/completions');
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(init.body);
    assert.equal(body.model, MODEL);
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.tools, undefined);
    assert.equal(JSON.parse(body.messages[1].content).candidates.length, a.candidates.length);
    return response();
  });
  assert.equal(review.provider, 'nvidia');
});

test('quota interruption preserves completed reviews and the next run resumes only pending articles', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'article-review-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const articles = [article('A'), article('B')];
  let calls = 0;
  const first = await reviewArticles({ articles, reviewDir, policy: '', config, sleep: async () => {}, fetchImpl: async () => ++calls === 1 ? response() : new Response('', { status: 429 }) });
  assert.equal(first.status, 'paused');
  assert.equal(first.completed, 1);
  assert.equal(first.reason, 'quota');
  assert.equal(calls, 2);
  let resumedCalls = 0;
  const next = await reviewArticles({ articles, reviewDir, policy: '', config, sleep: async () => {}, fetchImpl: async () => { resumedCalls++; return response(); } });
  assert.equal(next.status, 'completed');
  assert.equal(next.cached, 1);
  assert.equal(resumedCalls, 1);
});

test('request budget pauses without fallback and corrupt evidence is never cached', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'article-review-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const articles = [article('A'), article('B')];
  const state = await reviewArticles({ articles, reviewDir, policy: '', config: { ...config, maxRequests: 1 }, fetchImpl: async () => response() });
  assert.equal(state.reason, 'request_budget');
  assert.equal(state.requests, 1);
  const invalid = await reviewArticles({ articles: [articles[1]], reviewDir, policy: '', config, sleep: async () => {}, fetchImpl: async () => response([{ ...decisions[0], evidence_quotes: ['Invented quote'] }]) });
  assert.equal(invalid.reason, 'invalid_responses');
  assert.equal(invalid.requests, 2);
  assert.deepEqual(invalid.failed_articles, [{ article_id: articles[1].id, reason: 'evidence_mismatch' }]);
  await assert.rejects(fs.access(path.join(reviewDir, `${articles[1].id}.json`)));
});

test('authentication failures and truncated responses fail closed', async () => {
  await assert.rejects(requestReview(article('A'), '', 'key', async () => new Response('secret detail', { status: 403 })), /^Error: NVIDIA HTTP 403$/);
  await assert.rejects(requestReview(article('A'), '', 'key', async () => response(decisions, 'length')), /incomplete_response/);
});

test('invalid article retries once, later articles are saved, and resume repairs only the failed article', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'article-review-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const articles = [article('Bad'), article('Good')];
  let calls = 0;
  const delays = [];
  const first = await reviewArticles({ articles, reviewDir, policy: '', config,
    sleep: async ms => delays.push(ms), fetchImpl: async (_, init) => {
      const body = JSON.parse(init.body);
      calls++;
      if (calls === 2) assert.match(body.messages[2].content, /Copy evidence_quotes verbatim/);
      return calls <= 2 ? response([]) : response();
    } });
  assert.equal(first.status, 'paused');
  assert.equal(first.completed, 1);
  assert.equal(first.requests, 3);
  assert.deepEqual(delays, [15000, 15000]);
  await assert.rejects(fs.access(path.join(reviewDir, `${articles[0].id}.json`)));
  const resumed = await reviewArticles({ articles, reviewDir, policy: '', config, fetchImpl: async () => response() });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.cached, 1);
  assert.equal(resumed.requests, 1);
});

test('retry respects request budget and quota; authentication still fails immediately', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'article-review-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const args = { articles: [article('A')], reviewDir, policy: '', config, sleep: async () => {} };
  let calls = 0;
  const limited = await reviewArticles({ ...args, config: { ...config, maxRequests: 1 }, fetchImpl: async () => { calls++; return response([]); } });
  assert.equal(limited.reason, 'request_budget');
  assert.equal(calls, 1);
  calls = 0;
  const quota = await reviewArticles({ ...args, fetchImpl: async () => ++calls === 1 ? response([]) : new Response('', { status: 429 }) });
  assert.equal(quota.reason, 'quota');
  assert.equal(quota.requests, 2);
  calls = 0;
  await assert.rejects(reviewArticles({ ...args, fetchImpl: async () => { calls++; return new Response('', { status: 403 }); } }), /HTTP 403/);
  assert.equal(calls, 1);
});

test('malformed or truncated output recovers on retry without caching the bad response', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'article-review-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  for (const [index, bad] of [() => response(decisions, 'length'), () => new Response('null'),
    () => new Response('{'), () => response([null]), () => response([{ ...decisions[0], evidence_quotes: [] }])].entries()) {
    let calls = 0;
    const result = await reviewArticles({ articles: [article(`A${index}`)], reviewDir, policy: '', config,
      sleep: async () => {}, fetchImpl: async () => ++calls === 1 ? bad() : response() });
    assert.equal(result.status, 'completed');
    assert.equal(result.requests, 2);
  }
});

test('persistent provider outages use bounded backoff and expose only safe diagnostics', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'article-review-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  let calls = 0;
  const delays = [];
  const state = await reviewArticles({ articles: [article('A')], reviewDir, policy: '', config, random: () => 0, sleep: async ms => delays.push(ms), fetchImpl: async () => {
    calls++;
    return new Response(JSON.stringify({ error: { message: 'High demand; private provider detail' } }), { status: 503 });
  } });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [15000, 30000]);
  assert.equal(state.http_status, 503);
  assert.equal(state.provider_reason, 'capacity');
  assert.equal(JSON.stringify(state).includes('private provider detail'), false);
});

test('503 recovers automatically with cached progress and retries obey budget', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'article-review-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const a = article('Cached'), b = article('Pending');
  const args = { reviewDir, policy: '', config, sleep: async () => {}, random: () => 0 };
  await reviewArticles({ ...args, articles: [a], fetchImpl: async () => response() });
  let calls = 0;
  const recovered = await reviewArticles({ ...args, articles: [a, b], fetchImpl: async () => ++calls === 1 ? new Response('', { status: 503 }) : response() });
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.cached, 1);
  assert.equal(recovered.requests, 2);
  const limited = await reviewArticles({ ...args, articles: [article('Budget')], config: { ...config, maxRequests: 1 }, fetchImpl: async () => new Response('', { status: 503 }) });
  assert.equal(limited.reason, 'request_budget');
  assert.equal(limited.requests, 1);
});

test('quote failure artifacts retain both attempts, original evidence and normalized comparisons without secrets', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'article-diagnostics-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const a = article('Diagnostic');
  a.evidence.push('Company’s capacity is 10 tonnes.');
  const args = { articles: [a], reviewDir, policy: '', config, sleep: async () => {} };
  const invalid = [{ ...decisions[0], summary_en: 'DO NOT SAVE SUMMARY', evidence_quotes: [
    "Company's capacity is 10 tonnes.", 'Capacity is 100 tonnes. test-key',
  ] }];
  const state = await reviewArticles({ ...args, fetchImpl: async () => response(invalid) });
  assert.equal(state.diagnostics.length, 2);
  assert.notEqual(state.diagnostics[0].file, state.diagnostics[1].file);
  const readDiagnostic = async item => JSON.parse(await fs.readFile(path.join(path.dirname(reviewDir), item.file), 'utf8'));
  const detail = await readDiagnostic(state.diagnostics[0]);
  assert.equal(detail.reason, 'evidence_mismatch');
  assert.equal(detail.decisions[0].candidate_id, 'investment:2');
  assert.equal(detail.decisions[0].quotes[0].quote, "Company's capacity is 10 tonnes.");
  assert.deepEqual(detail.decisions[0].quotes[0].matching_block_indices, [2]);
  assert.deepEqual(detail.decisions[0].quotes[1].matching_block_indices, []);
  assert.equal(detail.evidence_blocks[2].text, 'Company’s capacity is 10 tonnes.');
  assert.equal(JSON.stringify(detail).includes('test-key'), false);
  assert.equal(JSON.stringify(detail).includes('DO NOT SAVE SUMMARY'), false);
  assert.equal(JSON.stringify(state).includes('Capacity is'), false);
  await assert.rejects(fs.access(path.join(reviewDir, `${a.id}.json`)));
  const again = await reviewArticles({ ...args, fetchImpl: async () => response(invalid) });
  assert.notEqual(again.diagnostics[0].file, state.diagnostics[0].file);
  assert.deepEqual(await readDiagnostic(state.diagnostics[0]), detail);
  const recovered = await reviewArticles({ ...args, fetchImpl: async () => response() });
  assert.equal(recovered.status, 'completed');
  assert.deepEqual(recovered.diagnostics, []);
  const cached = await reviewArticles({ ...args, fetchImpl: async () => { throw new Error('must use cache'); } });
  assert.equal(cached.cached, 1);
});

test('missing and malformed quotes produce readable diagnostics without saving arbitrary objects', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'article-diagnostics-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  for (const quotes of [[], null, [{ secret: 'private object' }]]) {
    const state = await reviewArticles({ articles: [article('Missing')], reviewDir, policy: '', config: { ...config, maxRequests: 1 },
      fetchImpl: async () => response([{ ...decisions[0], evidence_quotes: quotes }]) });
    assert.equal(state.diagnostics.length, 1);
    const content = await fs.readFile(path.join(path.dirname(reviewDir), state.diagnostics[0].file), 'utf8');
    assert.equal(content.includes('private object'), false);
    const detail = JSON.parse(content);
    assert.equal(detail.decisions[0].quotes_is_array, Array.isArray(quotes));
  }
});

test('business non-applicable fields are constants without bypassing the activity gate', async () => {
  const original = article('A').candidates[0].row;
  const a = groupArticles([], [original], { from_date: '2026-08-01', to_date: '2026-08-31' })[0];
  const review = await requestReview(a, '', 'key', async () => response([{ ...decisions[0], candidate_id: 'relevant', indicator_supported: false, leading_indicator_supported: false, event_stage: 'unclear', summary_ko: '', summary_en: '' }]));
  assert.equal(review.decisions[0].event_stage, 'not_applicable');
  assert.equal(review.decisions[0].leading_indicator_supported, true);
  assert.equal(review.decisions[0].indicator_supported, false);
});

test('an unclassifiable 429 reports what the provider actually said, redacted and bounded', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-message-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const args = { articles: [article('A')], reviewDir, policy: '', config, sleep: async () => {} };
  // 관측된 형태: 429 인데 우리 패턴 어디에도 걸리지 않는 문구. 이때만 본문을 남긴다.
  const state = await reviewArticles({ ...args, fetchImpl: async () =>
    new Response(JSON.stringify({ error: { message: 'Daily allowance for this deployment is used up' } }), { status: 429 }) });
  assert.equal(state.reason, 'quota');
  assert.equal(state.provider_reason, 'unspecified');
  assert.match(state.provider_message, /Daily allowance for this deployment is used up/);
  // JSON 이 아니거나 error.message 가 아닌 본문도 읽는다. 예전에는 빈 문자열만 봤다.
  const plain = await reviewArticles({ ...args, fetchImpl: async () => new Response('Deployment allowance used up', { status: 429 }) });
  assert.equal(plain.provider_message, 'Deployment allowance used up');
  const nested = await reviewArticles({ ...args, fetchImpl: async () =>
    new Response(JSON.stringify({ detail: 'Account has no remaining allowance' }), { status: 429 }) });
  assert.equal(nested.provider_message, 'Account has no remaining allowance');
  // 알아본 실패는 예전대로 분류만 남기고 본문은 남기지 않는다.
  const classified = await reviewArticles({ ...args, fetchImpl: async () =>
    new Response(JSON.stringify({ error: { message: 'Rate limit reached; private provider detail' } }), { status: 429 }) });
  assert.equal(classified.provider_reason, 'rate_limit');
  assert.equal(classified.provider_message, undefined);
  assert.equal(JSON.stringify(classified).includes('private provider detail'), false);
});

test('a provider message never carries the key and never runs unbounded', () => {
  assert.equal(providerMessage('key test-key was rejected', 'test-key'), 'key [REDACTED] was rejected');
  assert.equal(providerMessage(`  spread   over
  lines  `, ''), 'spread over lines');
  const long = providerMessage('x'.repeat(500), '');
  assert.equal(long.length, 301);
  assert.equal(long.endsWith('…'), true);
  assert.equal(providerMessage(undefined, 'k'), '');
});

test('a transport failure names itself instead of pausing anonymously', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'transport-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const args = { articles: [article('A')], reviewDir, policy: '', config, sleep: async () => {}, random: () => 0 };
  // 프로바이더가 120초 안에 답하지 않는 경우.
  const timeout = await reviewArticles({ ...args, fetchImpl: async () => {
    throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); } });
  assert.equal(timeout.reason, 'transport_error');
  assert.equal(timeout.transport_reason, 'TimeoutError');
  assert.match(timeout.transport_message, /timeout/);
  // 연결 자체가 안 되는 경우. fetch 는 원인을 cause 에 담는다.
  const refused = await reviewArticles({ ...args, fetchImpl: async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND integrate.api.nvidia.com') }); } });
  assert.equal(refused.transport_reason, 'TypeError');
  assert.match(refused.transport_message, /ENOTFOUND/);
  // fetch 호출 안에서 난 우리 코드의 결함은 전송 오류로 위장돼 왔다. 이제 문구가 남는다.
  const ourBug = await reviewArticles({ ...args, fetchImpl: async () => { null.missing(); } });
  assert.equal(ourBug.transport_reason, 'TypeError');
  assert.match(ourBug.transport_message, /null/);
  // 키는 어느 경로로도 새지 않는다.
  const leak = await reviewArticles({ ...args, fetchImpl: async () => {
    throw new TypeError(`connect failed for key ${config.apiKey}`); } });
  assert.equal(leak.transport_message.includes(config.apiKey), false);
  assert.match(leak.transport_message, /\[REDACTED\]/);
});

test('an empty error body is reported as empty rather than vanishing', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'empty-body-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const state = await reviewArticles({ articles: [article('A')], reviewDir, policy: '', config, sleep: async () => {},
    fetchImpl: async () => new Response('', { status: 429 }) });
  assert.equal(state.provider_reason, 'unspecified');
  // 예전에는 빈 문자열이라 필드가 통째로 사라졌고, 본문이 없었다는 사실조차 남지 않았다.
  assert.equal(state.provider_message, '(빈 응답 본문)');
});

test('a run stamps which workflow run and commit produced it', () => {
  assert.deepEqual(runIdentity({}), {});
  assert.deepEqual(runIdentity({ GITHUB_RUN_ID: '34179775899', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'abc123', GITHUB_REF_NAME: 'feat/local-monthly-report' }),
    { run: { id: '34179775899', attempt: '1', sha: 'abc123', ref: 'feat/local-monthly-report' } });
  // 로컬 실행은 아무것도 붙이지 않는다.
  assert.deepEqual(runIdentity({ GITHUB_RUN_ID: '', GITHUB_SHA: undefined }), {});
});

test('a 429 keeps whatever the provider said about the limit, and records saying nothing', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rate-limit-headers-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const args = { articles: [article('A')], reviewDir, policy: '', config, sleep: async () => {} };
  const limited = await reviewArticles({ ...args, fetchImpl: async () => new Response('', { status: 429, headers: {
    'x-ratelimit-limit-requests': '40', 'x-ratelimit-remaining-requests': '0',
    'x-ratelimit-reset-requests': '58s', 'retry-after': '58', 'x-request-id': 'req_abc',
    // 한도와 무관한 헤더는 가져오지 않는다.
    'content-type': 'application/json', 'set-cookie': 'session=secret',
  } }) });
  assert.equal(limited.rate_limit['x-ratelimit-limit-requests'], '40');
  assert.equal(limited.rate_limit['x-ratelimit-remaining-requests'], '0');
  assert.equal(limited.rate_limit['x-ratelimit-reset-requests'], '58s');
  assert.equal(limited.rate_limit['x-request-id'], 'req_abc');
  assert.equal(limited.retry_after, '58');
  assert.equal(limited.rate_limit['set-cookie'], undefined);
  assert.equal(limited.rate_limit['content-type'], undefined);
  assert.equal(JSON.stringify(limited).includes('session=secret'), false);
  // 아무 헤더도 안 보내면 빈 객체가 남는다. "확인했고 아무것도 없었다"와 "확인 안 했다"는 다르다.
  const silent = await reviewArticles({ ...args, fetchImpl: async () => new Response('', { status: 429 }) });
  assert.deepEqual(silent.rate_limit, {});
});

test('rate-limit header capture is name-based and redacts the key', () => {
  const headers = new Headers({ 'RateLimit-Reset': '30', 'x-rate-limit-limit': '40',
    'authorization': 'Bearer test-key', 'x-detail': `used by test-key` });
  const found = rateLimitHeaders(headers, 'test-key');
  assert.deepEqual(Object.keys(found).sort(), ['ratelimit-reset', 'x-rate-limit-limit']);
  assert.equal(found['x-detail'], undefined);
  assert.equal(found.authorization, undefined);
  assert.equal(rateLimitHeaders(new Headers({ 'x-ratelimit-key': 'test-key' }), 'test-key')['x-ratelimit-key'], '[REDACTED]');
});
