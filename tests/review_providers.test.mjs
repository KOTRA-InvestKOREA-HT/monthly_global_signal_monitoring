import test from 'node:test';
import assert from 'node:assert/strict';
import * as provider_module from '../scripts/review_providers.mjs';
const { GEMINI, NVIDIA, PROVIDERS, resolveProvider, toJsonSchema, toGeminiSchema, decisionProperties } = provider_module;
import { configuration, requestReview } from '../scripts/review_report.mjs';
import { groupArticles } from '../scripts/local_report.mjs';

// 수집한 본문이 기사인지 목록·오류 페이지인지는 길이로도 갈린다. 고정값도 실제 기사 길이를 쓴다.
const TAIL = "The company said the site would support qualification volumes first, "
  + "that a final location has not been chosen, and that no construction contract has been signed. "
  + "It declined to give a timeline, and said the plan stays under review until the board meets.";

const article = company => groupArticles([{ company, target_no: 1, url: `https://example.com/${company}`, title: 'Pilot plant', published_at: '2026-08-02', investment_signal_no: 2, target_technology: 'material', content_text: `The company plans a pilot plant. ${TAIL}` }], [], { from_date: '2026-08-01', to_date: '2026-08-31' })[0];
const decisions = [{ candidate_id: 'investment:2', entity_supported: true, target_technology_supported: true, indicator_supported: true, leading_indicator_supported: true, event_stage: 'planned', quality: 'pass', reason_ko: '파일럿 생산시설 계획을 확인함', evidence_quotes: ['The company plans a pilot plant.'], summary_ko: '파일럿 생산시설 계획', summary_en: 'Pilot production plant planned' }];
const chat = (ds = decisions, finish_reason = 'stop') =>
  new Response(JSON.stringify({ choices: [{ finish_reason, message: { content: JSON.stringify({ decisions: ds }) } }], usage: { total_tokens: 12 } }));

test('the decision schema converts to a strict JSON Schema without losing enums', () => {
  const schema = toJsonSchema({ type: 'OBJECT', properties: { decisions: { type: 'ARRAY', items: { type: 'OBJECT', properties: decisionProperties } } } });
  const item = schema.properties.decisions.items;
  assert.equal(schema.type, 'object');
  assert.equal(item.properties.entity_supported.type, 'boolean');
  assert.equal(item.properties.evidence_quotes.items.type, 'string');
  assert.deepEqual(item.properties.quality.enum, ['pass', 'needs_review']);
  // strict 모드는 모든 필드가 required 이고 추가 필드가 금지돼야 한다.
  assert.deepEqual(item.required, Object.keys(decisionProperties));
  assert.equal(item.additionalProperties, false);
});

test('the publication date is one article-level pair of required strings, not a per-candidate field', () => {
  const { articleDateProperties, DATE_INSTRUCTION, SYSTEM_INSTRUCTION, RETRY_INSTRUCTION } = provider_module;
  const schema = toJsonSchema({ type: 'OBJECT', properties: { decisions: { type: 'ARRAY', items: { type: 'OBJECT', properties: decisionProperties } }, ...articleDateProperties } });
  assert.equal(schema.properties.published_date.type, 'string');
  assert.equal(schema.properties.published_date_quote.type, 'string');
  // strict 모드라 optional 이 없다. 제안이 없으면 빈 문자열이어야 하고, 그 규칙은 프롬프트에 있다.
  assert.deepEqual(schema.required, ['decisions', 'published_date', 'published_date_quote']);
  assert.equal(schema.properties.decisions.items.properties.published_date, undefined);
  assert.match(DATE_INSTRUCTION, /only when this article has date_placement "date_pending"/);
  assert.match(DATE_INSTRUCTION, /return "" for both/);
  assert.equal(SYSTEM_INSTRUCTION.includes(DATE_INSTRUCTION), true);
  // 거부된 날짜는 재시도에서 고칠 수 있어야 한다. 재시도 지시가 날짜를 언급하지 않으면 같은 값이 다시 온다.
  assert.match(RETRY_INSTRUCTION, /published_date/);
});

test('the request carries the article date placement the date rule refers to', () => {
  const pending = groupArticles([{ company: 'Undated', target_no: 1, url: 'https://example.com/u', title: 'Pilot plant',
    published_at: null, published_at_source: '', investment_signal_no: 2, target_technology: 'material',
    content_text: `The company plans a pilot plant. ${TAIL}` }], [], { from_date: '2026-08-01', to_date: '2026-08-31' })[0];
  const body = NVIDIA.body({ article: pending, policy: '', retry: false, model: NVIDIA.model });
  assert.equal(JSON.parse(body.messages[1].content).date_placement, 'date_pending');
  assert.equal(JSON.parse(NVIDIA.body({ article: article('Acme'), policy: '', retry: false, model: NVIDIA.model }).messages[1].content).date_placement, 'in_period');
});

test('the NVIDIA request disables reasoning and pins deterministic structured output', () => {
  const body = NVIDIA.body({ article: article('Acme'), policy: 'POLICY', retry: false, model: NVIDIA.model });
  // 추론 토큰이 출력 예산을 먹으면 JSON 이 잘려 응답 전체가 폐기된다.
  assert.deepEqual(body.chat_template_kwargs, { thinking: false });
  assert.equal(body.temperature, 0);
  assert.equal(body.stream, false);
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.messages.map(m => m.role), ['system', 'user']);
  assert.match(body.messages[0].content, /POLICY$/);
  // 원본 수집 행은 모델에 보내지 않는다.
  assert.equal(JSON.parse(body.messages[1].content).candidates.every(c => c.row === undefined), true);
});

test('a retry adds the verbatim-quote instruction as another user turn', () => {
  const body = NVIDIA.body({ article: article('Acme'), policy: '', retry: true, model: NVIDIA.model });
  assert.deepEqual(body.messages.map(m => m.role), ['system', 'user', 'user']);
  assert.match(body.messages[2].content, /Copy evidence_quotes verbatim/);
});

test('a truncated NVIDIA response is rejected instead of parsed', () => {
  const invalid = code => Object.assign(new Error(code), { response_code: code });
  assert.throws(() => NVIDIA.parse({ choices: [{ finish_reason: 'length', message: { content: '{"decisions":[' } }] }, invalid), /incomplete_response/);
  assert.throws(() => NVIDIA.parse({ choices: [{ finish_reason: 'stop', message: {} }] }, invalid), /invalid_parts/);
  const ok = NVIDIA.parse({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }], usage: { total_tokens: 3 } }, invalid);
  assert.equal(ok.text, '{}');
  assert.deepEqual(ok.usage, { total_tokens: 3 });
});

test('requestReview sends the NVIDIA article to the OpenAI-compatible endpoint', async () => {
  const a = article('Acme');
  const review = await requestReview(a, 'policy', 'test-key', async (url, init) => {
    assert.equal(url, 'https://integrate.api.nvidia.com/v1/chat/completions');
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    assert.equal(JSON.parse(init.body).model, NVIDIA.model);
    return chat();
  }, false, NVIDIA);
  assert.equal(review.provider, 'nvidia');
  assert.equal(review.reviewer, `${NVIDIA.model}/article-review-v1`);
  assert.deepEqual(review.usage, { total_tokens: 12 });
});

test('an NVIDIA HTTP failure is labelled without leaking the response body', async () => {
  await assert.rejects(
    requestReview(article('Acme'), '', 'key', async () => new Response('secret detail', { status: 403 }), false, NVIDIA),
    /^Error: NVIDIA HTTP 403$/,
  );
});

test('NVIDIA needs no free-tier confirmation and reads the single shared key secret', () => {
  assert.deepEqual(
    configuration({ REPORT_PROVIDER: 'nvidia', OPENAI_API_KEY: 'k' }, NVIDIA),
    { apiKey: 'k', maxRequests: 400, delayMs: 1600, concurrency: 8 },
  );
  // 40 RPM 이면 1500ms 가 한도다.
  assert.throws(() => configuration({ REPORT_PROVIDER: 'nvidia', OPENAI_API_KEY: 'k', NVIDIA_DELAY_MS: '1499' }, NVIDIA), /1500\.\.60000/);
  assert.throws(() => configuration({ REPORT_PROVIDER: 'nvidia' }, NVIDIA), /OPENAI_API_KEY is required/);
});

test('the model stays overridable and reaches the cache identity', () => {
  assert.equal(resolveProvider({}).model, NVIDIA.model);
  assert.equal(resolveProvider({ NVIDIA_MODEL: ' deepseek-ai/other ' }).model, 'deepseek-ai/other');
});

test('an auth failure can be diagnosed without printing the key', () => {
  const { describeKeyShape } = provider_module;
  // 다른 서비스 키가 들어 있는 경우와 붙여넣기 공백을 구분할 수 있어야 한다.
  assert.deepEqual(describeKeyShape('nvapi-0123456789'), { length: 16, prefix: 'nvapi-', issuer: 'NVIDIA build', had_surrounding_whitespace: false });
  assert.equal(describeKeyShape('sk-legacygatewaykey').prefix, 'sk-');
  assert.equal(describeKeyShape(' nvapi-0123456789\n').had_surrounding_whitespace, true);
  assert.equal(describeKeyShape(undefined).prefix, '(알 수 없는 형식)');
  // 어떤 경우에도 키 본문은 결과에 담기지 않는다.
  assert.equal(JSON.stringify(describeKeyShape('nvapi-supersecret')).includes('supersecret'), false);
});

test('a pasted key with surrounding whitespace still authenticates', () => {
  assert.equal(configuration({ REPORT_PROVIDER: 'nvidia', OPENAI_API_KEY: '  nvapi-abc\n' }, NVIDIA).apiKey, 'nvapi-abc');
});

test('a non-quote validation failure records what actually broke', async t => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { reviewArticles } = await import('../scripts/review_report.mjs');
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validation-diagnostics-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  // 투자 후보에 not_applicable 은 스키마상 허용되지만 판정 계약에서는 거부된다.
  const broken = [{ ...decisions[0], event_stage: 'not_applicable', reason_ko: '사유', summary_ko: '요약문', summary_en: 'summary' }];
  const state = await reviewArticles({
    articles: [article('Broken')], reviewDir, policy: '', config: { apiKey: 'k', maxRequests: 1, delayMs: 0 },
    sleep: async () => {}, fetchImpl: async () => chat(broken),
  });
  assert.equal(state.diagnostics.length, 1);
  const detail = JSON.parse(await fs.readFile(path.join(path.dirname(reviewDir), state.diagnostics[0].file), 'utf8'));
  assert.match(detail.validation_message, /invalid event_stage/);
  assert.equal(detail.decisions[0].event_stage, 'not_applicable');
  assert.equal(detail.expected_kinds['investment:2'], 'investment');
  assert.equal(detail.decisions[0].reason_ko_length, 2);
  // 자유 텍스트 본문은 길이만 남고 내용은 남지 않는다.
  assert.equal(JSON.stringify(detail).includes('요약문'), false);
});

test('the Gemini request uses its own dialect and carries the same one schema', () => {
  const body = GEMINI.body({ article: article('Acme'), policy: 'POLICY', retry: false, model: GEMINI.model });
  assert.equal(GEMINI.url(GEMINI.model), 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
  assert.equal(GEMINI.headers('AIzaTest')['x-goog-api-key'], 'AIzaTest');
  assert.match(body.systemInstruction.parts[0].text, /POLICY$/);
  assert.equal(body.generationConfig.temperature, 0);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  const schema = body.generationConfig.responseSchema;
  // 날짜 힌트 두 필드는 여기에도 루트로 실린다. 스키마 정의가 한 곳이므로 자동으로 따라온다.
  assert.deepEqual(schema.required, ['decisions', 'published_date', 'published_date_quote']);
  assert.equal(schema.properties.published_date.type, 'STRING');
  // Gemini 방언은 대문자 타입을 쓰고 additionalProperties 를 받지 않는다.
  assert.equal(schema.properties.decisions.items.type, 'OBJECT');
  assert.equal(schema.properties.decisions.items.additionalProperties, undefined);
  assert.deepEqual(schema.properties.decisions.items.required, Object.keys(decisionProperties));
  assert.deepEqual(schema.properties.decisions.items.properties.quality.enum, ['pass', 'needs_review']);
  // 원본 수집 행은 모델에 보내지 않는다.
  assert.equal(JSON.parse(body.contents[0].parts[0].text).candidates.every(c => c.row === undefined), true);
  assert.equal(GEMINI.body({ article: article('Acme'), policy: '', retry: true, model: GEMINI.model }).contents[0].parts.length, 2);
});

test('Gemini responses drop reasoning parts and reject truncation', () => {
  const invalid = code => Object.assign(new Error(code), { response_code: code });
  const ok = GEMINI.parse({ candidates: [{ finishReason: 'STOP', content: { parts: [
    { thought: true, text: 'internal reasoning' }, { text: '{"decisions"' }, { text: ':[]}' }] } }],
    usageMetadata: { totalTokenCount: 9 } }, invalid);
  assert.equal(ok.text, '{"decisions":[]}');
  assert.deepEqual(ok.usage, { totalTokenCount: 9 });
  assert.throws(() => GEMINI.parse({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] }, invalid), /incomplete_response/);
  assert.throws(() => GEMINI.parse({ candidates: [{ finishReason: 'STOP', content: {} }] }, invalid), /invalid_parts/);
});

test('the provider is selected by name and each keeps its own key, model and pacing', () => {
  assert.deepEqual(Object.keys(PROVIDERS), ['gemini', 'nvidia']);
  // 코드 기본값은 nvidia 다. 워크플로가 디스패치 입력이나 저장소 변수로 덮는다.
  assert.equal(resolveProvider({}).id, 'nvidia');
  assert.equal(resolveProvider({ REPORT_PROVIDER: ' Gemini ' }).id, 'gemini');
  assert.equal(resolveProvider({ REPORT_PROVIDER: 'gemini' }).model, 'gemini-3.5-flash-lite');
  assert.equal(resolveProvider({ REPORT_PROVIDER: 'gemini', GEMINI_MODEL: 'gemini-3.5-flash' }).model, 'gemini-3.5-flash');
  // 다른 프로바이더의 모델 변수는 서로 넘보지 않는다.
  assert.equal(resolveProvider({ REPORT_PROVIDER: 'gemini', NVIDIA_MODEL: 'x' }).model, 'gemini-3.5-flash-lite');
  assert.throws(() => resolveProvider({ REPORT_PROVIDER: 'openai' }), /Unknown REPORT_PROVIDER: openai. Use one of gemini, nvidia/);
  assert.deepEqual(GEMINI.keyEnv, ['GEMINI_API_KEY']);
  assert.equal(GEMINI.minDelayMs, 4000);
});

test('Gemini needs a human free-tier confirmation that NVIDIA does not', () => {
  const env = { REPORT_PROVIDER: 'gemini', GEMINI_API_KEY: 'AIzaKey' };
  // API 가 무료 티어를 강제하지 못하므로, 확인 표시 없이는 한 번도 호출하지 않는다.
  assert.throws(() => configuration(env, GEMINI), /GEMINI_FREE_TIER_CONFIRMED=true/);
  assert.deepEqual(configuration({ ...env, GEMINI_FREE_TIER_CONFIRMED: 'true' }, GEMINI),
    { apiKey: 'AIzaKey', maxRequests: 400, delayMs: 4500, concurrency: 8 });
  assert.throws(() => configuration({ ...env, GEMINI_FREE_TIER_CONFIRMED: 'true', GEMINI_DELAY_MS: '3999' }, GEMINI), /4000\.\.60000/);
  assert.throws(() => configuration({ REPORT_PROVIDER: 'gemini', GEMINI_FREE_TIER_CONFIRMED: 'true' }, GEMINI), /GEMINI_API_KEY is required/);
  // 선불 크레딧인 NVIDIA 는 같은 위험이 없어 확인을 요구하지 않는다.
  assert.equal(configuration({ OPENAI_API_KEY: 'k' }, NVIDIA).delayMs, 1600);
});
