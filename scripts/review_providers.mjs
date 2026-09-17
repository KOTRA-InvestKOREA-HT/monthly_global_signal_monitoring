// API adapters only: prompt composition lives in review_prompts.mjs.
// Keep existing exports for callers that import the shared contract here.
import { buildSystemInstruction, retryInstruction } from './review_prompts.mjs';
export {
  DATE_HINT_VERSION, DATE_INSTRUCTION, SUMMARY_INSTRUCTION,
  SYSTEM_INSTRUCTION, RETRY_INSTRUCTION, VERIFY_INSTRUCTION,
} from './review_prompts.mjs';

const EVENT_STAGES = ['exploratory', 'planned', 'precursor', 'committed', 'completed', 'unclear', 'not_applicable'];

// 스키마는 여기 한 곳에만 정의하고, 아래에서 표준 JSON Schema 로 변환해 보낸다.
// 키 순서가 곧 모델이 답을 쓰는 순서다(Gemini 3.x 구조화 출력은 스키마 키 순서를 따른다). 인용과 사유를
// 판정 필드보다 앞에 둔다. 앞선 342건은 모두 판정을 먼저 쓰고 사유를 뒤에 붙였다.
export const decisionProperties = {
  candidate_id: { type: 'STRING' },
  evidence_quotes: { type: 'ARRAY', items: { type: 'STRING' } },
  reason_ko: { type: 'STRING' },
  ...Object.fromEntries(
    ['entity_supported', 'target_technology_supported', 'indicator_supported', 'leading_indicator_supported']
      .map(k => [k, { type: 'BOOLEAN' }]),
  ),
  event_stage: { type: 'STRING', enum: EVENT_STAGES },
  quality: { type: 'STRING', enum: ['pass', 'needs_review'] },
  summary_ko: { type: 'STRING' }, summary_en: { type: 'STRING' },
};

const JSON_TYPES = { STRING: 'string', BOOLEAN: 'boolean', ARRAY: 'array', OBJECT: 'object', NUMBER: 'number', INTEGER: 'integer' };

// strict 구조화 출력에 맞춰 표준 JSON Schema 로 옮긴다.
// strict 모드는 모든 필드가 required 이고 additionalProperties 가 false 여야 한다.
export function toJsonSchema(node) {
  const type = JSON_TYPES[node.type];
  if (!type) throw new Error(`Unsupported schema type: ${node.type}`);
  const out = { type };
  if (node.enum) out.enum = node.enum;
  if (node.items) out.items = toJsonSchema(node.items);
  if (node.properties) {
    out.properties = Object.fromEntries(Object.entries(node.properties).map(([k, v]) => [k, toJsonSchema(v)]));
    out.required = Object.keys(node.properties);
    out.additionalProperties = false;
  }
  return out;
}

// 기사 단위 필드. 후보별 판정과 나란히 두면 같은 기사의 후보 다섯 개가 서로 다른 게시일을 말할 수 있다.
// strict 모드는 모든 필드를 required 로 만들므로 제안이 없으면 빈 문자열로 돌아온다.
export const articleDateProperties = {
  published_date: { type: 'STRING' },
  published_date_quote: { type: 'STRING' },
};

// Gemini 는 자체 스키마 방언을 쓴다. 대문자 타입은 그대로 두고 required 만 채운다.
// additionalProperties 는 받지 않으므로 넣지 않는다.
export function toGeminiSchema(node) {
  const out = { type: node.type };
  if (node.enum) out.enum = node.enum;
  if (node.items) out.items = toGeminiSchema(node.items);
  if (node.properties) {
    out.properties = Object.fromEntries(Object.entries(node.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
    out.required = Object.keys(node.properties);
  }
  return out;
}

const decisionsEnvelope = {
  type: 'OBJECT',
  properties: {
    decisions: { type: 'ARRAY', items: { type: 'OBJECT', properties: decisionProperties } },
    ...articleDateProperties,
  },
};

const articleText = article => JSON.stringify({ ...article, candidates: article.candidates.map(({ row, ...c }) => c) });

export const GEMINI = {
  id: 'gemini',
  label: 'Gemini',
  model: 'gemini-3.5-flash-lite',
  // Flash-Lite 의 기본 추론 단계는 minimal 이라, 설정하지 않으면 거의 추론 없이 답한다. 앞선 342건 모두
  // 추론 토큰이 없었다. low 로 올린 2026-08 판정(34939670823) 358건에도 thoughtsTokenCount 가 한 번도
  // 없었고, 공급계약을 R&D 로, 주가 해설 속 지난 사건을 이번 달 시그널로 승인했다. 그래서 최대인 high 로 둔다.
  // 무료 등급의 토큰 한도(GenerateContentInputTokensPerModelPerMinute-FreeTier)는 입력 토큰만 세고
  // RPM·RPD 는 요청 수라, 추론 단계는 무료 한도를 더 쓰지 않는다. 늘어나는 것은 응답 시간과 출력 토큰이다.
  // 기본값은 버전마다 바뀌어 왔으므로 기대지 않고 명시한다. GEMINI_THINKING_LEVEL 로 바꿀 수 있다.
  thinkingLevel: 'high',
  keyEnv: ['GEMINI_API_KEY'],
  // 관측된 무료 티어 15 RPM. 4500ms가 안전값, 4000이 한도다.
  minDelayMs: 4000,
  defaultDelayMs: 4500,
  // API 가 무료 티어를 강제하지 못한다. 결제 계정이 붙은 키면 조용히 과금되므로 사람의 확인을 받는다.
  requiresFreeTierConfirmation: true,
  expectedKeyPrefix: 'AIza',
  url(model) {
    return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  },
  headers(apiKey) {
    return { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey };
  },
  body({ article, policy, retry }) {
    return {
      systemInstruction: { parts: [{ text: buildSystemInstruction(policy) }] },
      contents: [{ role: 'user', parts: [
        { text: articleText(article) },
        ...(retry ? [{ text: retryInstruction(retry) }] : []),
      ] }],
      generationConfig: {
        // Gemini 3.x 문서는 temperature·top_p·top_k 를 요청에서 빼라고 한다. 그래서 보내지 않는다.
        // 예전에 보내던 temperature 0 이 판정 재현을 보장한다고 볼 근거는 없다.
        // maxOutputTokens 에는 추론 토큰도 들어간다.
        thinkingConfig: { thinkingLevel: this.thinkingLevel || 'high' },
        // high 추론의 추론 토큰이 잘리지 않도록 gemini-3.5-flash-lite 출력 한도(65,536)까지 연다.
        maxOutputTokens: 65536, responseMimeType: 'application/json',
        responseSchema: toGeminiSchema(decisionsEnvelope),
      },
    };
  },
  // 판정 본문만 돌려준다. thought 파트는 추론 흔적이라 버린다.
  parse(payload, invalid) {
    const candidate = payload?.candidates?.[0];
    if (candidate?.finishReason !== 'STOP') throw invalid('incomplete_response');
    if (!Array.isArray(candidate.content?.parts)) throw invalid('invalid_parts');
    return {
      text: candidate.content.parts.filter(p => p && !p.thought).map(p => p.text || '').join(''),
      usage: payload.usageMetadata || {},
    };
  },
  async listModels(apiKey) {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { 'x-goog-api-key': apiKey }, signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return [];
    const payload = await response.json();
    return (payload.models || [])
      .filter(m => m.name?.includes('flash') && m.supportedGenerationMethods?.includes('generateContent'))
      .map(m => m.name);
  },
};

export const NVIDIA = {
  id: 'nvidia',
  label: 'NVIDIA',
  model: 'deepseek-ai/deepseek-v4-flash-0731',
  // 이 저장소는 서드파티 키 시크릿을 하나만 쓴다. 이름은 OPENAI_API_KEY 지만
  // 내용은 NVIDIA build 키다. 그래서 같은 시크릿을 읽는 옛 OpenAI 경로
  // (summarize_signal_evidence.mjs, check_openai_access.mjs)는 더 이상 동작하지 않는다.
  keyEnv: ['OPENAI_API_KEY'],
  // 40 RPM 관측치. 무료 티어 확인 플래그는 필요 없다. 선불 크레딧이라 조용히 과금되지 않는다.
  requiresFreeTierConfirmation: false,
  // 40 RPM 이면 1500ms 다. 1600ms 를 기본값으로 두어 여유를 둔다.
  minDelayMs: 1500,
  defaultDelayMs: 1600,
  expectedKeyPrefix: 'nvapi-',
  url() {
    return 'https://integrate.api.nvidia.com/v1/chat/completions';
  },
  headers(apiKey) {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  },
  body({ article, policy, retry, model }) {
    return {
      model,
      messages: [
        { role: 'system', content: buildSystemInstruction(policy) },
        { role: 'user', content: articleText(article) },
        ...(retry ? [{ role: 'user', content: retryInstruction(retry) }] : []),
      ],
      // 판정은 재현 가능해야 하므로 표집을 끈다.
      temperature: 0,
      max_tokens: 16384,
      stream: false,
      // 추론 토큰이 출력 예산을 먹으면 JSON 이 잘려 응답 전체가 폐기된다.
      chat_template_kwargs: { thinking: false },
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'review_decisions', strict: true, schema: toJsonSchema(decisionsEnvelope) },
      },
    };
  },
  parse(payload, invalid) {
    const choice = payload?.choices?.[0];
    if (!choice) throw invalid('invalid_parts');
    // length = 출력 상한에 걸려 잘린 응답. 파싱하면 깨진 JSON 이다.
    if (choice.finish_reason && choice.finish_reason !== 'stop') throw invalid('incomplete_response');
    const text = choice.message?.content;
    if (typeof text !== 'string') throw invalid('invalid_parts');
    return { text, usage: payload.usage || {} };
  },
  async listModels(apiKey) {
    const response = await fetch('https://integrate.api.nvidia.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return [];
    const payload = await response.json();
    return (payload.data || []).map(m => m.id);
  },
};

// 인증 실패를 진단할 때 키 자체는 절대 찍지 않는다. 길이·접두사·공백 여부면
// "다른 서비스 키가 들어 있다" 와 "붙여넣기에 개행이 섞였다" 를 구분할 수 있다.
const KEY_PREFIXES = [
  ['nvapi-', 'NVIDIA build'],
  ['sk-proj-', 'OpenAI project'],
  ['sk-or-', 'OpenRouter'],
  ['sk-', 'OpenAI 또는 호환 게이트웨이'],
  ['gsk_', 'Groq'],
  ['AIza', 'Google'],
];

export function describeKeyShape(rawKey) {
  const raw = String(rawKey ?? '');
  const key = raw.trim();
  const match = KEY_PREFIXES.find(([prefix]) => key.startsWith(prefix));
  return {
    length: key.length,
    prefix: match ? match[0] : '(알 수 없는 형식)',
    issuer: match ? match[1] : '(알 수 없음)',
    had_surrounding_whitespace: raw !== key,
  };
}

export const PROVIDERS = { gemini: GEMINI, nvidia: NVIDIA };

// 판정을 어디로 보낼지는 REPORT_PROVIDER 가 정한다. 코드 기본값은 nvidia 이고, 워크플로가
// 디스패치 입력이나 저장소 변수로 덮는다. 저장된 판정에는 provider 가 함께 적혀 있어,
// 프로바이더를 바꾸면 그 판정들은 캐시에서 거부되고 다시 판정된다.
// 2차 검증 모델. 1차 제공자와 무관하게 Gemini 를 쓴다. REVIEW_VERIFIER=off 로 끄고, GEMINI_VERIFIER_MODEL 로 모델을 바꾼다.
// 검증 모델은 판정 캐시 식별자에 넣지 않는다. 검증 결과에 모델 이름을 남긴다.
export const DEFAULT_VERIFIER_MODEL = 'gemini-3.8-flash';
export function resolveVerifier(env = process.env) {
  if (['off', 'false', '0', 'no'].includes(String(env.REVIEW_VERIFIER || '').trim().toLowerCase())) return null;
  const model = String(env.GEMINI_VERIFIER_MODEL || DEFAULT_VERIFIER_MODEL).trim();
  const thinking = String(env.GEMINI_VERIFIER_THINKING_LEVEL || 'high').trim().toLowerCase();
  if (!['minimal', 'low', 'medium', 'high'].includes(thinking)) {
    throw new Error(`GEMINI_VERIFIER_THINKING_LEVEL must be minimal, low, medium or high: ${thinking}`);
  }
  return { ...GEMINI, label: 'Gemini verifier', model, thinkingLevel: thinking };
}

export function resolveProvider(env = process.env) {
  const name = String(env.REPORT_PROVIDER || 'nvidia').trim().toLowerCase();
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown REPORT_PROVIDER: ${name}. Use one of ${Object.keys(PROVIDERS).join(', ')}`);
  // 모델은 프로바이더별 환경변수로만 바꾼다. 캐시 식별자에 들어가므로 바뀌면 재판정된다.
  const override = env[`${provider.id.toUpperCase()}_MODEL`];
  const resolved = override ? { ...provider, model: override.trim() } : provider;
  const thinking = provider.id === 'gemini' ? String(env.GEMINI_THINKING_LEVEL || '').trim().toLowerCase() : '';
  if (!thinking) return resolved;
  if (!['minimal', 'low', 'medium', 'high'].includes(thinking)) {
    throw new Error(`GEMINI_THINKING_LEVEL must be minimal, low, medium or high: ${thinking}`);
  }
  return { ...resolved, thinkingLevel: thinking };
}
