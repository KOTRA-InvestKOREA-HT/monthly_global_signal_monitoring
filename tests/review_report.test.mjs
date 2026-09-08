import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configuration, requestReview, reviewArticles, separateVerifiedQuotes, MODEL } from '../scripts/review_report.mjs';
import { groupArticles } from '../scripts/local_report.mjs';
import { DATE_HINT_VERSION } from '../scripts/review_providers.mjs';

const article = company => groupArticles([{ company, target_no: 1, url: `https://example.com/${company}`, title: 'Pilot plant', published_at: '2026-08-02', investment_signal_no: 2, target_technology: 'material', content_text: 'The company plans a pilot plant.' }], [], { from_date: '2026-08-01', to_date: '2026-08-31' })[0];
const decisions = [{ candidate_id: 'investment:2', entity_supported: true, target_technology_supported: true, indicator_supported: true, leading_indicator_supported: true, event_stage: 'planned', quality: 'pass', reason_ko: '파일럿 생산시설 계획을 확인함', evidence_quotes: ['The company plans a pilot plant.'], summary_ko: '파일럿 생산시설 계획', summary_en: 'Pilot production plant planned' }];
const response = (ds = decisions, finish_reason = 'stop') => new Response(JSON.stringify({ choices: [{ finish_reason, message: { content: JSON.stringify({ decisions: ds }) } }], usage: {} }));
const config = { apiKey: 'test-key', maxRequests: 40, delayMs: 15000 };

// 게시일 미상 기사. 본문 안에 게시일이 문장으로 적혀 있다.
const datedQuote = 'Published on August 14, 2026.';
const pendingBody = `The company plans a pilot plant. ${datedQuote}`;
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
  assert.deepEqual(configuration({ OPENAI_API_KEY: 'key' }), { apiKey: 'key', maxRequests: 400, delayMs: 1600, concurrency: 8 });
  assert.throws(() => configuration({ OPENAI_API_KEY: 'key', REPORT_CONCURRENCY: '13' }), /CONCURRENCY/);
  assert.throws(() => configuration({ OPENAI_API_KEY: 'key', NVIDIA_MAX_REQUESTS: '0' }), /1..400/);
  assert.throws(() => configuration({ OPENAI_API_KEY: 'key', NVIDIA_DELAY_MS: '1499' }), /1500..60000/);
  assert.deepEqual(configuration({ OPENAI_API_KEY: 'key', NVIDIA_MAX_REQUESTS: '400', NVIDIA_DELAY_MS: '1600' }), { apiKey: 'key', maxRequests: 400, delayMs: 1600, concurrency: 8 });
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
