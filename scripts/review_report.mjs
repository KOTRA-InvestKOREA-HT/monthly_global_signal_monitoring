#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sourceCandidates, groupArticles, importReview, normalizeQuote, build } from './local_report.mjs';
import { resolveProvider, describeKeyShape, DATE_HINT_VERSION } from './review_providers.mjs';
import { CONTENT_COLLECTION_VERSION } from './collect_company_signals.mjs';
import { collectionInputDigest, collectionNeedsRefresh } from './collection_resilience.mjs';
import { reportEligible, periodPlacement } from './date_state.mjs';
import { investmentStageSupported } from './validate_report_inputs.mjs';

// 판정은 NVIDIA build 의 OpenAI 호환 엔드포인트로 보낸다. 모델은 NVIDIA_MODEL 로 바꾼다.
// 모델 이름은 정책 다이제스트에 들어가므로, 바꾸면 앞선 판정은 재사용되지 않는다.
export const PROVIDER = resolveProvider();
export const MODEL = PROVIDER.model;
const VERSION = 'article-review-v1';
export function publishedSignalCounts(rows, period) {
  const published = rows.filter(row => reportEligible(row, period));
  return { approved_count: rows.length, report_signal_count: published.length,
    date_pending_count: rows.filter(row => periodPlacement(row, period).placement === 'date_pending').length,
    out_of_period_count: rows.filter(row => periodPlacement(row, period).placement === 'out_of_period').length,
    companies_in_report: new Set(published.map(row => row.company)).size };
}
const STAGE_REVIEW_VERSION = 'candidate-event-v3';
// 전조(precursor)를 쓸 수 있는 지표는 1·3·4·5인데, 이 재검토는 오랫동안 4번만 훑었다.
// 그래서 Nexeon 의 1억 파운드 조달(investment:3)처럼 나머지 조건이 모두 true 인데
// 단계 판정 하나로 탈락한 건이 재검토 대상에 아예 오르지 못했다. 범위를 정책과 맞춘다.
// 판정을 자동으로 precursor 로 바꾸지는 않는다. 다시 물어볼 뿐이다.
export function needsStageReview(article, review) {
  return review.stage_review_version !== STAGE_REVIEW_VERSION && review.decisions.some(d =>
    investmentStageSupported('precursor', String(d.candidate_id || '').split(':')[1]) &&
    ['committed', 'completed'].includes(d.event_stage) &&
    d.entity_supported && d.indicator_supported && (d.target_technology_supported ||
      article.candidates.find(c => c.id === d.candidate_id)?.relevance_exempt));
}
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const write = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n');
  await fs.rename(`${file}.tmp`, file);
};

export function configuration(env = process.env, provider = resolveProvider(env)) {
  const prefix = provider.id.toUpperCase();
  // Gemini 는 API 가 무료 티어를 강제하지 못하므로 사람이 확인했다는 표시를 요구한다.
  // NVIDIA 무료 키는 선불 크레딧이라 같은 위험이 없다.
  if (provider.requiresFreeTierConfirmation && env[`${prefix}_FREE_TIER_CONFIRMED`] !== 'true') {
    throw new Error(`Set ${prefix}_FREE_TIER_CONFIRMED=true only after confirming this key belongs to a project with no paid billing. The API cannot enforce free-tier billing.`);
  }
  const keyEnv = provider.keyEnv.find(name => env[name]);
  if (!keyEnv) throw new Error(`${provider.keyEnv.join(' or ')} is required`);
  const maxRequests = Number(env[`${prefix}_MAX_REQUESTS`] || env.REPORT_MAX_REQUESTS || 400);
  const delayMs = Number(env[`${prefix}_DELAY_MS`] || env.REPORT_DELAY_MS || provider.defaultDelayMs);
  const concurrency = Number(env.REPORT_CONCURRENCY || 8);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 12) throw new Error('REPORT_CONCURRENCY must be 1..12');
  // 대기 하한은 프로바이더의 관측 RPM 에서 온다(60000 / RPM). 429 가 나도 저장 후 멈추고
  // 다음 실행이 이어간다. 400 상한은 한 회차 전체를 한 번에 덮는다.
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 400) throw new Error(`${prefix}_MAX_REQUESTS must be 1..400`);
  if (!Number.isFinite(delayMs) || delayMs < provider.minDelayMs || delayMs > 60000) {
    throw new Error(`${prefix}_DELAY_MS must be ${provider.minDelayMs}..60000`);
  }
  return { apiKey: String(env[keyEnv]).trim(), maxRequests, delayMs, concurrency };
}

// 아티팩트만 보고 어느 실행·어느 커밋의 결과인지 알 수 있어야 한다. 로컬 실행에서는 비어 있다.
export function runIdentity(env = process.env) {
  const run = { id: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, sha: env.GITHUB_SHA, ref: env.GITHUB_REF_NAME };
  const named = Object.entries(run).filter(([, value]) => value);
  return named.length ? { run: Object.fromEntries(named) } : {};
}

// status.json 은 캐시(outputs/review_work) 안에 있어 지난 실행의 것이 복원된다. 이번 실행이
// 중단되면 아티팩트에는 남의 실행 결과만 남고, 그것이 이번 실행의 결과로 읽힌다.
// 그래서 긴 작업을 시작하기 전에 이번 실행의 표시로 먼저 덮어쓴다.
export function startingStatus(period) {
  return { status: 'running', started_at: new Date().toISOString(), period,
    provider: PROVIDER.id, model: MODEL, ...runIdentity() };
}

// 429 가 왜 났는지는 본문보다 헤더에 있을 때가 많다. 한도·잔량·리셋 시각을 보내주는
// 게이트웨이라면 여기 있고, 아무것도 안 보낸다면 빈 객체가 그 사실 자체를 기록한다.
// 본문이 아니라 이 메타데이터만 남긴다. date 는 리셋 시각을 서버 시간 기준으로 읽으려고 함께 받는다.
const RATE_LIMIT_HEADER = /^(retry-after|date|x-request-id|x-requestid|(x-)?rate-?limit-)/i;
export function rateLimitHeaders(headers, apiKey) {
  const found = {};
  for (const [name, value] of headers) if (RATE_LIMIT_HEADER.test(name)) found[name] = providerMessage(value, apiKey);
  return found;
}

// 모델에 보내는 판정 계약 구간. 로컬 CLI 작업 지침은 제외한다.
export function policySection(doc) {
  return doc.split('## 판정 기준')[1].split('## 기사별 응답 형식')[0];
}

// 판정 캐시 식별자. 여기 들어가는 값이 하나라도 바뀌면 기사 id 가 바뀌고 앞선 판정은 재사용되지
// 않는다. 판정 기준을 고치면 옛 판정이 새 기준의 결과로 읽히지 않는다는 뜻이고, 그것이 의도다.
// golden 평가도 같은 식을 써야 운영과 같은 기사 id 를 얻는다.
export function reviewPolicy({ policyText, technology, indicators, provider = PROVIDER }) {
  // 줄바꿈은 정규화하고 해시한다. Windows 작업트리는 CRLF, 리눅스 러너는 LF 로 같은 문서를 받으므로,
  // 정규화하지 않으면 같은 커밋이 플랫폼마다 다른 기사 id 를 만든다. 그러면 로컬에서 돌린 golden
  // 평가가 운영과 다른 정책을 재고, 체크아웃 설정이 다른 사람이 캐시를 통째로 무효화한다.
  const normalized = String(policyText).split('\r\n').join('\n');
  return `${VERSION}:${digest([provider.id, provider.model, normalized, technology, indicators])}`;
}

function invalidResponse(code, label = PROVIDER.label) {
  return Object.assign(new Error(`${label} invalid response: ${code}`), { response_code: code });
}

// 실패 응답에서 프로바이더가 한 말만 남긴다. 키는 지우고 길이는 자른다.
// 성공 응답 본문은 기사 본문이 섞여 있으므로 여기서도 다루지 않는다.
const PROVIDER_MESSAGE_LIMIT = 300;
export function providerMessage(text, apiKey) {
  const collapsed = String(text || '').replace(/\s+/g, ' ').trim();
  const safe = apiKey ? collapsed.split(apiKey).join('[REDACTED]') : collapsed;
  return safe.length > PROVIDER_MESSAGE_LIMIT ? `${safe.slice(0, PROVIDER_MESSAGE_LIMIT)}…` : safe;
}

// A quote array can contain separate passages. Split joined sentences only
// when EVERY sentence independently matches the SAME source block in order.
// Never fill omitted text, remove ellipses, or use fuzzy/semantic matching.
export function separateVerifiedQuotes(article, decisions) {
  const evidence = article.evidence.map(normalizeQuote);
  const repairs = [];
  return {
    decisions: decisions.map(decision => {
      if (!Array.isArray(decision.evidence_quotes)) return decision;
      const quotes = decision.evidence_quotes.flatMap((quote, quote_index) => {
        if (typeof quote !== 'string' || evidence.some(block => block.includes(normalizeQuote(quote)))) return [quote];
        if (/\.{3}|…/.test(quote)) return [quote];
        const sentences = quote.trim().split(/(?<=[.!?])\s+/);
        if (sentences.length < 2 || sentences.some(s => s.length < 30 || !/[.!?]$/.test(s))) return [quote];
        const normalized = sentences.map(normalizeQuote);
        const blockIndex = evidence.findIndex(block => {
          let offset = 0;
          for (const sentence of normalized) {
            const index = block.indexOf(sentence, offset);
            if (index < 0) return false;
            offset = index + sentence.length;
          }
          return true;
        });
        if (blockIndex < 0) return [quote];
        repairs.push({ candidate_id: decision.candidate_id, quote_index, original_quote: quote,
          separated_quotes: sentences, evidence_block_index: blockIndex });
        return sentences;
      });
      return { ...decision, evidence_quotes: quotes };
    }),
    repairs,
  };
}

// Diagnostic data is never imported as a review. Keep only evidence-related
// fields, not provider bodies, thoughts, summaries, headers or error messages.
const textLength = value => (typeof value === 'string' ? value.trim().length : null);

function quoteDiagnostics(article, decisions, apiKey, validationMessage = null) {
  const evidence = article.evidence.map((text, index) => ({ index, text, normalized: normalizeQuote(text) }));
  const detail = {
    company: article.company, url: article.url, title: article.title,
    ...(validationMessage ? { validation_message: validationMessage } : {}),
    expected_candidate_ids: article.candidates.map(c => c.id),
    expected_kinds: Object.fromEntries(article.candidates.map(c => [c.id, c.kind])),
    evidence_blocks: evidence,
    decisions: decisions.map((d, decision_index) => ({
      decision_index,
      candidate_id: typeof d.candidate_id === 'string' ? d.candidate_id : null,
      // enum·불리언은 그대로, 자유 텍스트는 길이만. 어느 검증이 깨졌는지 이걸로 좁힌다.
      event_stage: typeof d.event_stage === 'string' ? d.event_stage : null,
      quality: typeof d.quality === 'string' ? d.quality : null,
      booleans: Object.fromEntries(['entity_supported', 'target_technology_supported', 'indicator_supported', 'leading_indicator_supported']
        .map(k => [k, typeof d[k] === 'boolean' ? d[k] : `(${typeof d[k]})`])),
      reason_ko_length: textLength(d.reason_ko),
      summary_ko_length: textLength(d.summary_ko),
      summary_en_length: textLength(d.summary_en),
      quotes_is_array: Array.isArray(d.evidence_quotes),
      quotes: Array.isArray(d.evidence_quotes) ? d.evidence_quotes.map((quote, quote_index) => {
        if (typeof quote !== 'string') return { quote_index, invalid_type: quote === null ? 'null' : typeof quote };
        const normalized = normalizeQuote(quote);
        return { quote_index, quote, normalized,
          matching_block_indices: normalized ? evidence.filter(block => block.normalized.includes(normalized)).map(block => block.index) : [] };
      }) : [],
    })),
  };
  // Redact the configured key even if it unexpectedly appears in supplied text.
  return JSON.parse(JSON.stringify(detail, (_, value) => typeof value === 'string' && apiKey
    ? value.split(apiKey).join('[REDACTED]') : value));
}

export async function requestReview(article, policy, apiKey, fetchImpl = fetch, retry = false, provider = PROVIDER) {
  const invalid = code => invalidResponse(code, provider.label);
  let response;
  try {
    response = await fetchImpl(provider.url(provider.model), {
      method: 'POST', headers: provider.headers(apiKey),
      signal: AbortSignal.timeout(120000),
      body: JSON.stringify(provider.body({ article, policy, retry, model: provider.model })),
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError' || error instanceof TypeError) {
      // 이름과 사유를 함께 남긴다. TimeoutError(프로바이더가 120초 안에 답하지 않음)와
      // TypeError(DNS·TLS·연결 실패, 또는 fetch 호출 안에서 난 우리 코드의 결함)는 서로 다른
      // 문제인데 예전에는 둘 다 이름 없는 "transport error" 하나로 뭉뚱그려졌다.
      throw Object.assign(new Error(`${provider.label} transport error`), { transport_error: true,
        transport_reason: error.name || 'Error',
        transport_message: providerMessage(error.cause?.message || error.message, apiKey) });
    }
    throw error;
  }
  // Do not log provider response bodies: they may contain supplied text or credentials.
  if (!response.ok) {
    const error = new Error(`${provider.label} HTTP ${response.status}`);
    error.status = response.status;
    // 본문은 한 번만 읽을 수 있다. 텍스트로 받아 두고 JSON 이면 거기서 메시지를 꺼낸다.
    // 게이트웨이가 JSON 이 아닌 본문이나 다른 필드명을 쓰면 예전 코드는 빈 문자열만 봤고,
    // 그래서 모든 분류가 unspecified 로 떨어졌다.
    const body = await response.text().catch(() => '');
    let detail = null;
    try { detail = JSON.parse(body); } catch { /* JSON 이 아니면 본문 그대로 본다 */ }
    const stated = String(detail?.error?.message || detail?.detail || detail?.message || body || '');
    const message = stated.toLowerCase();
    error.provider_reason = /overload|high demand|capacity/.test(message) ? 'capacity'
      : /model.*not found|model.*not supported/.test(message) ? 'model_unavailable'
      : /api key/.test(message) ? 'api_key'
      // A 429 is either a burst this run can wait out or an exhausted account.
      // One costs a minute and the other costs a day, so name which it was.
      : /credit|quota|balance|exceeded your current/.test(message) ? 'credits_exhausted'
      : /per (minute|second)|rate limit|too many requests/.test(message) ? 'rate_limit'
      : 'unspecified';
    // 분류에 성공하면 프로바이더 본문은 남기지 않는다. 분류가 실패했을 때만, 무엇을 받았길래
    // 알아보지 못했는지 남긴다. 그게 없으면 1분 기다릴 일인지 계정이 빈 것인지 알아낼 방법이 없다.
    if (error.provider_reason === 'unspecified') error.provider_message = providerMessage(stated, apiKey) || '(빈 응답 본문)';
    error.rate_limit = rateLimitHeaders(response.headers, apiKey);
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) error.retry_after = retryAfter;
    throw error;
  }
  const payload = await response.json().catch(() => { throw invalid('invalid_json'); });
  const { text, usage } = provider.parse(payload, invalid);
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw invalid('invalid_json'); }
  if (!parsed || !Array.isArray(parsed.decisions) || parsed.decisions.some(d => !d || typeof d !== 'object')) throw invalid('invalid_decisions');
  // Business activity has no investment-stage test. These are contract constants,
  // not model judgements; entity, technology, concrete activity and quotes still gate approval.
  if (Array.isArray(parsed.decisions)) parsed.decisions = parsed.decisions.map(decision =>
    article.candidates.some(c => c.id === decision.candidate_id && c.kind === 'relevant')
      ? { ...decision, leading_indicator_supported: true, event_stage: 'not_applicable' } : decision);
  const separated = separateVerifiedQuotes(article, parsed.decisions);
  // 게시일 제안은 기사 단위 필드다. 여기서 review 로 옮기지 않으면 스키마를 고쳐도 dateHints 는
  // 계속 비어 있다. 스키마상 항상 문자열이지만, 빠졌거나 문자열이 아니면 제안 없음으로 읽는다.
  const suggested = value => (typeof value === 'string' ? value : '');
  const review = { article_id: article.id, reviewer: `${provider.model}/${VERSION}`, provider: provider.id, decisions: separated.decisions,
    date_hint_version: DATE_HINT_VERSION, stage_review_version: STAGE_REVIEW_VERSION,
    published_date: suggested(parsed.published_date), published_date_quote: suggested(parsed.published_date_quote),
    ...(separated.repairs.length ? { quote_repairs: separated.repairs } : {}), usage };
  let problem = null;
  try { importReview(article, review); } catch (error) { problem = error; }
  // 날짜 힌트는 보조 정보이고 언제나 추정으로만 쓰인다. 첫 실패는 기존 재시도에 맡기되, 재시도에서도
  // 인용이 그 날짜를 말하지 못하면 힌트만 버리고 판정은 살린다. 근거 있는 판정 전체를 근거 없는
  // 날짜 하나 때문에 잃으면 그 기사는 보고서에서 조용히 사라지고 build 까지 막힌다.
  // 힌트를 지운 뒤 판정을 다시 검증하므로, 판정 자체의 결함은 여기서 가려지지 않는다.
  if (problem && retry && /published_date/.test(problem.message)) {
    const withoutHint = { ...review, published_date: '', published_date_quote: '' };
    try {
      importReview(article, withoutHint);
      console.log(`Article ${article.id}: unusable publication date discarded, content review kept`);
      return withoutHint;
    } catch (error) { problem = error; }
  }
  if (problem) {
    const failure = invalid(/published_date/.test(problem.message) ? 'date_evidence_mismatch'
      : /evidence_quotes/.test(problem.message) ? 'evidence_mismatch'
      : /summary names/.test(problem.message) ? 'summary_ungrounded'
      : /needs an evidence quote/.test(problem.message) ? 'missing_evidence' : 'review_validation');
    // importReview 의 메시지는 우리가 만든 문구다. 회사명과 후보 id 만 담고 모델 출력은 담지 않는다.
    failure.diagnostic = quoteDiagnostics(article, parsed.decisions, apiKey, problem.message);
    throw failure;
  }
  return review;
}

export async function reviewArticles(options) {
  const { articles, config, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)) } = options;
  const concurrency = config.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 12) throw new Error('REPORT_CONCURRENCY must be 1..12');
  if (concurrency === 1) return reviewArticlesSerial(options);
  // One start-time gate for all workers AND retries. Waiting for a response
  // does not hold this gate. The existing per-article validator/cache is reused.
  let queue = Promise.resolve(), nextStart = 0, requests = 0, index = 0;
  let stopped = null, fatal = null, progressCompleted = 0;
  // 보강 중단은 실행 전체가 공유한다. 기사마다 따로 판단하면 할당량이 끝난 뒤에도 남은 미상 기사
  // 수만큼 계속 두드린다. 판정 중단(stopped)과는 별개다: 보강이 멈춰도 판정은 계속 나간다.
  const supplementStop = { stopped: false };
  const results = [];
  // 보조 요청인지는 어느 게이트를 통해 왔는지로 정한다. 이 구분은 게이트 안에만 있고
  // RequestInit 으로 새어나가지 않는다.
  const gate = supplement => async (url, init) => {
    const slot = queue.then(async () => {
      if (stopped || fatal || (supplement && supplementStop.stopped)) return false;
      if (requests >= config.maxRequests) {
        // 날짜 보강은 보조 작업이다. 예산이 바닥나면 실행을 멈추지 않고 스스로 물러난다.
        if (!supplement) stopped = { status: 'paused', reason: 'request_budget' };
        return false;
      }
      while (nextStart > performance.now()) await sleep(nextStart - performance.now());
      if (stopped || fatal || (supplement && supplementStop.stopped)) return false;
      requests++;
      nextStart = performance.now() + config.delayMs;
      return true;
    });
    queue = slot.then(() => {}, () => {});
    if (!await slot) throw Object.assign(new Error('Request scheduling stopped'), { scheduling_stopped: true });
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(120000) });
    // Stop queued requests promptly on quota/auth errors, but let in-flight
    // successful responses finish validation and durable cache writes.
    // 보강의 실패로는 판정 요청을 멈추지 않는다. 할당량이 정말 끝났다면 다음 판정 요청이 같은 응답으로 알아낸다.
    if (!supplement) {
      if (response.status === 429) stopped = { status: 'paused', reason: 'quota', http_status: 429 };
      else if (!response.ok && response.status < 500) stopped = { status: 'paused', reason: 'provider_error', http_status: response.status };
    }
    return response;
  };
  const gatedFetch = gate(false), supplementFetch = gate(true);
  await Promise.all(Array.from({ length: Math.min(concurrency, articles.length) }, async () => {
    while (index < articles.length && !fatal) {
      const article = articles[index++];
      try {
        const result = await reviewArticlesSerial({ ...options, articles: [article], fetchImpl: gatedFetch,
          supplementFetchImpl: supplementFetch, supplementStop, logReviewed: false });
        results.push(result);
        progressCompleted += result.completed;
        if (result.completed > result.cached) console.log(`Reviewed ${progressCompleted}/${articles.length}: ${article.company}`);
        if (result.status === 'paused' && !['invalid_responses', 'scheduling_stopped'].includes(result.reason)) {
          // The gate stops queued work knowing only the status code; the worker
          // also read the provider's own explanation. Preferring the gate's
          // report discarded provider_reason on every 429, which is exactly
          // what separates "retry in a minute" from "the account is out".
          const lessInformative = !stopped || stopped.reason === 'request_budget' ||
            (stopped.http_status === result.http_status && !stopped.provider_reason && result.provider_reason);
          if (lessInformative) stopped = result;
        }
      } catch (error) { fatal ??= error; }
    }
  }));
  if (fatal) throw fatal;
  const failed_articles = results.flatMap(r => r.failed_articles);
  const completed = results.reduce((n, r) => n + r.completed, 0);
  return {
    ...(completed === articles.length ? { status: 'completed' } : stopped || { status: 'paused', reason: 'invalid_responses' }),
    requests, cached: results.reduce((n, r) => n + r.cached, 0), completed, total: articles.length,
    date_hints: results.reduce((n, r) => n + (r.date_hints || 0), 0),
    failed_articles, diagnostics: results.flatMap(r => r.diagnostics), concurrency,
  };
}

// 같은 날짜 규칙으로 이미 물어본 판정은 다시 묻지 않는다. 빈 문자열도 물어본 것이다.
// 날짜 프롬프트나 인용문 날짜 파서를 고쳐 DATE_HINT_VERSION 을 올리면, 내용 판정은 그대로 둔 채
// 이 기사들의 날짜만 다시 묻는다. 그것이 힌트 버전을 판정 캐시 식별자와 분리해 둔 이유다.
function needsDateHint(article, review) {
  return article.date_placement === 'date_pending' && review.date_hint_version !== DATE_HINT_VERSION;
}

async function reviewArticlesSerial({ articles, reviewDir, policy, config, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), random = Math.random, logReviewed = true,
  supplementFetchImpl = fetchImpl, supplementStop = { stopped: false } }) {
  let requests = 0, cached = 0, completed = 0, dateHints = 0;
  const failed = [];
  const diagnostics = [];
  const state = extra => ({ requests, cached, completed, date_hints: dateHints, total: articles.length, failed_articles: failed, diagnostics, ...extra });
  for (const article of articles) {
    const file = path.join(reviewDir, `${article.id}.json`);
    try {
      const review = await read(file);
      if (review.reviewer !== `${PROVIDER.model}/${VERSION}` || review.provider !== PROVIDER.id) throw new Error('cache provider mismatch');
      importReview(article, review);
      if (needsStageReview(article, review)) throw new Error('candidate event stage needs recheck');
      cached++; completed++;
      // 끝난 내용 판정은 그대로 두고 날짜만 보강한다. 스키마가 바뀌었다고 캐시 식별자를 올리면
      // 날짜와 무관한 기사까지 전부 다시 판정되고, 같은 기사에서 다른 승인이 나올 수 있다.
      // 날짜 상태와 내용 평가는 독립이므로 그 대가를 치를 이유가 없다.
      if (needsDateHint(article, review) && !supplementStop.stopped && requests < config.maxRequests) {
        if (requests) await sleep(config.delayMs);
        requests++;
        try {
          // 보강 전용 게이트로 보낸다. 이 실패가 공유 스케줄러를 멈추면 아직 판정받지 못한
          // 기사들이 날짜와 무관한 이유로 판정 없이 끝난다.
          const fresh = await requestReview(article, policy, config.apiKey, supplementFetchImpl);
          // 새 응답의 판정은 버리고 날짜만 옮긴다. 이미 검증된 판정을 재현성 없는 재판정으로 덮지 않는다.
          await write(file, { ...review, date_hint_version: DATE_HINT_VERSION,
            published_date: fresh.published_date, published_date_quote: fresh.published_date_quote });
          if (fresh.published_date) dateHints++;
        } catch (error) {
          // 힌트는 보조 정보다. 실패해도 캐시된 판정과 실행 상태는 건드리지 않는다. 다만 할당량·
          // 전송 오류라면 남은 기사에서 반복해도 결과가 같으므로 이번 실행에서는 보강을 멈춘다.
          if (error.status || error.transport_error || error.scheduling_stopped) supplementStop.stopped = true;
          console.log(`Article ${article.id}: date hint unavailable (${error.response_code || error.status || 'error'})`);
        }
      }
      continue;
    } catch (error) {
      if (error.code !== 'ENOENT') console.log(`Rechecking invalid cache: ${article.id}`);
    }
    let providerRetries = 0, waitMs = config.delayMs;
    let maxAttempts = 2, retryFeedback = false;
    for (let attempt = 0; attempt < maxAttempts;) {
      if (requests >= config.maxRequests) return state({ status: 'paused', reason: 'request_budget' });
      if (requests) await sleep(waitMs);
      waitMs = config.delayMs;
      requests++;
      let review;
      try {
        review = await requestReview(article, policy, config.apiKey, fetchImpl, retryFeedback);
      } catch (error) {
        // Outage retries and invalid-output retries share the run request budget.
        if (error.scheduling_stopped) return state({ status: 'paused', reason: 'scheduling_stopped' });
        if ((error.status >= 500 || error.transport_error) && providerRetries < 2) {
          waitMs = Math.max(config.delayMs, 15000 * 2 ** providerRetries + Math.floor(random() * 1000));
          providerRetries++;
          console.log(`Article ${article.id}: transient provider error (${error.transport_reason || `HTTP ${error.status}`}${error.transport_message ? `: ${error.transport_message}` : ''}); retry ${providerRetries}/2 after ${waitMs}ms`);
          continue;
        }
        if (error.status === 429 || error.status >= 500) return state({ status: 'paused', reason: error.status === 429 ? 'quota' : 'provider_unavailable', http_status: error.status, provider_reason: error.provider_reason, ...(error.provider_message ? { provider_message: error.provider_message } : {}), ...(error.rate_limit ? { rate_limit: error.rate_limit } : {}), ...(error.retry_after ? { retry_after: error.retry_after } : {}) });
        if (error.transport_error) return state({ status: 'paused', reason: 'transport_error',
          ...(error.transport_reason ? { transport_reason: error.transport_reason } : {}),
          ...(error.transport_message ? { transport_message: error.transport_message } : {}) });
        if (!error.response_code) throw error;
        retryFeedback = { reason: error.response_code,
          ...(error.diagnostic?.validation_message ? { validation_message: error.diagnostic.validation_message } : {}) };
        // A quote repair can expose a separate missing-summary error. Allow one
        // targeted repair, still subject to the shared request budget and all
        // validation checks. Never manufacture text or downgrade the decision.
        if (attempt === 1 && /missing ai_summary_(ko|en)/.test(error.diagnostic?.validation_message || '')) maxAttempts = 3;
        const diagnosticPath = `${path.basename(reviewDir)}/diagnostics/${article.id}/${crypto.randomUUID()}-attempt-${attempt + 1}.json`;
        await write(path.join(path.dirname(reviewDir), diagnosticPath), {
          schema_version: 1, article_id: article.id, model: MODEL,
          created_at: new Date().toISOString(), attempt: attempt + 1,
          reason: error.response_code, ...(error.diagnostic || {}),
        });
        diagnostics.push({ article_id: article.id, attempt: attempt + 1, reason: error.response_code, file: diagnosticPath });
        const failure = { article_id: article.id, reason: error.response_code };
        console.log(`Article ${article.id}: ${error.response_code} (attempt ${attempt + 1}/${maxAttempts})`);
        if (attempt === maxAttempts - 1) failed.push(failure);
        attempt++;
        continue;
      }
      await write(file, review);
      completed++;
      if (logReviewed) console.log(`Reviewed ${completed}/${articles.length}: ${article.company}`);
      break;
    }
  }
  return state(failed.length ? { status: 'paused', reason: 'invalid_responses' } : { status: 'completed' });
}

async function main() {
  const config = configuration(); // fail before crawling or calling any model
  const from = process.env.REPORT_FROM_DATE, to = process.env.REPORT_TO_DATE;
  for (const date of [from, to]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('Valid REPORT_FROM_DATE and REPORT_TO_DATE are required');
  }
  if (from > to) throw new Error('Invalid reporting period');
  const period = { from_date: from, to_date: to };
  const root = path.resolve('outputs/review_work');
  // 수집·판정보다 먼저 쓴다. 여기서부터 죽더라도 아티팩트는 이번 실행을 말한다.
  await write(path.join(root, 'status.json'), startingStatus(period));
  const policyDoc = await fs.readFile('docs/local_report_review.md', 'utf8');
  // Share the reviewed judgement contract, excluding instructions for the local CLI workflow.
  const policyText = policySection(policyDoc);
  const [targets, technology, indicators] = await Promise.all([
    read('data/target_companies.json'), read('data/company_technology_map.json'), read('config/investment_signal_indicators.json'),
  ]);
  const policy = reviewPolicy({ policyText, technology, indicators });
  const inputDir = path.join(root, `${from}_${to}`);
  const sourceFile = path.join(inputDir, 'latest_company_signals.json');
  if (process.env.REPORT_REFRESH === 'true') await fs.rm(inputDir, { recursive: true, force: true });
  try {
    await fs.access(sourceFile);
    const previous = await read(path.join(inputDir, 'latest_collection_summary.json'));
    const sourceConfig = await read('config/company_sources.json');
    if (collectionNeedsRefresh(previous, { version: CONTENT_COLLECTION_VERSION,
      inputDigest: collectionInputDigest(targets, sourceConfig) })) throw new Error('Refresh stale or incomplete collection');
  }
  catch {
    const result = spawnSync(process.execPath, ['scripts/collect_company_signals.mjs', '--companies', 'data/target_companies.json', '--source-config', 'config/company_sources.json', '--out-dir', inputDir,
      '--sources', 'official_feeds,official_pages,google_news', '--from-date', from, '--to-date', to,
      '--max-per-source', '6', '--max-per-company', '10', '--max-detail-per-company', '10', '--fallback-mode', 'missing', '--fallback-min-results', '1', '--rate-limit-seconds', '0.5', '--company-concurrency', '4'], { stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error('Collection failed');
  }
  const [signals, summary] = await Promise.all([read(sourceFile), read(path.join(inputDir, 'latest_collection_summary.json'))]);
  if (summary.from_date !== from || summary.to_date !== to) throw new Error('Cached collection period mismatch');
  const candidates = sourceCandidates(signals, technology, indicators, period);
  const articles = groupArticles(candidates.investment, candidates.relevant, period, policy);
  const snapshot = { policy, period, summary, signals, articles, targets, technology, indicators, date_deferred: candidates.deferred };
  const runDir = path.join(root, `${from.slice(0, 7)}-${digest(snapshot)}`);
  await write(path.join(runDir, 'snapshot.json'), snapshot);
  const state = await reviewArticles({ articles, reviewDir: path.join(root, 'reviews'), policy: policyText, config });
  await write(path.join(root, 'status.json'), { ...state, period, provider: PROVIDER.id, model: MODEL, ...runIdentity() });
  console.log(JSON.stringify(state));
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,
    `### ${PROVIDER.label} report\n${state.status}: ${state.completed}/${state.total} articles; ${state.requests} API requests; ${state.cached} cached` +
    `${state.date_hints ? `; ${state.date_hints} date hints` : ''}.\n` +
    (state.status === 'paused' ? `Reason: ${state.reason}${state.provider_reason ? ` (${state.provider_reason})` : ''}${state.retry_after ? `, retry-after ${state.retry_after}s` : ''}. ` +
      (state.provider_message ? `${PROVIDER.label} said: ${state.provider_message}
` : '') +
      (state.transport_reason ? `Transport: ${state.transport_reason}${state.transport_message ? ` - ${state.transport_message}` : ''}
` : '') +
      (state.rate_limit ? (Object.keys(state.rate_limit).length
        ? `Rate-limit headers: ${Object.entries(state.rate_limit).map(([k, v]) => `${k}=${v}`).join(', ')}
`
        : `${PROVIDER.label} sent no rate-limit headers with this ${state.http_status}.
`) : '') +
      'Saved progress; rerun the same dates with refresh=false. ' +
      // A burst limit clears in a minute; an exhausted account does not.
      (state.provider_reason === 'credits_exhausted' ? 'The account is out of credits, so an immediate rerun will only 429 again. ' : '') +
      (state.provider_reason === 'rate_limit' ? 'This was a burst limit, so a rerun shortly should continue. ' : '') +
      'Existing published PDFs are unchanged.\n' : '') +
    state.failed_articles.map(item => `- Article ${item.article_id}: ${item.reason}\n`).join('') +
    state.diagnostics.map(item => `- Diagnostic in progress artifact: ${item.file} (${item.reason})\n`).join(''));
  if (state.status !== 'completed') { process.exitCode = 75; return; }
  const reportDir = await build({ runDir, issueNumber: process.env.REPORT_ISSUE_NUMBER || '2' });
  const investment = await read(path.join(reportDir, 'investment.json'));
  const relevant = await read(path.join(reportDir, 'relevant.json'));
  // The workflow commits these files together only after both PDFs have succeeded.
  for (const [source, target] of [['signals.json', 'latest_company_signals.json'], ['summary.json', 'latest_collection_summary.json'], ['investment.json', 'latest_investment_signals.json'], ['relevant.json', 'latest_relevant_signals.json']]) {
    await fs.copyFile(path.join(reportDir, source), path.join('outputs', target));
  }
  await write('outputs/latest_investment_signal_summary.json', { investment_signal_count: investment.length, companies_with_investment_signals: new Set(investment.map(r => r.company)).size, ...publishedSignalCounts(investment, period), provider: PROVIDER.id });
  await write('outputs/latest_relevance_summary.json', { relevant_signal_count: relevant.length, companies_with_relevant_signals: new Set(relevant.map(r => r.company)).size, ...publishedSignalCounts(relevant, period), provider: PROVIDER.id });
  await write('outputs/latest_ai_summary_summary.json', { ...state, period, provider: PROVIDER.id, model: MODEL });
  await fs.mkdir('public/reports', { recursive: true });
  await fs.copyFile(path.join(reportDir, 'report_ko.pdf'), 'public/reports/latest_report.pdf');
  await fs.copyFile(path.join(reportDir, 'report_en.pdf'), 'public/reports/latest_report_en.pdf');
  await fs.rm(reportDir, { recursive: true, force: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(async error => {
  console.error(error.message);
  await write(path.resolve('outputs/review_work/status.json'), {
    status: 'failed', reason: error.status ? 'provider_error' : 'validation_or_execution',
    http_status: error.status || null, provider: PROVIDER.id, model: MODEL, ...runIdentity(),
    ...(error.provider_message ? { provider_message: error.provider_message } : {}),
    ...(error.rate_limit ? { rate_limit: error.rate_limit } : {}),
    ...(error.transport_reason ? { transport_reason: error.transport_reason, transport_message: error.transport_message } : {}),
    period: { from_date: process.env.REPORT_FROM_DATE || null, to_date: process.env.REPORT_TO_DATE || null },
  }).catch(() => {});
  if (error.provider_message) console.error(`${PROVIDER.label} 응답: ${error.provider_message}`);
  if (error.status === 401 || error.status === 403) {
    const apiKey = PROVIDER.keyEnv.map(name => process.env[name]).find(Boolean);
    const shape = describeKeyShape(apiKey);
    console.error(`${PROVIDER.keyEnv[0]} 이 ${PROVIDER.label} 에서 거절됐다. 키는 찍지 않고 모양만 보고한다:`);
    console.error(`  길이 ${shape.length}, 접두사 ${shape.prefix} (${shape.issuer}), 앞뒤 공백 ${shape.had_surrounding_whitespace ? '있음' : '없음'}`);
    if (PROVIDER.expectedKeyPrefix && !String(apiKey).trim().startsWith(PROVIDER.expectedKeyPrefix)) {
      console.error(`  ${PROVIDER.label} 키는 보통 ${PROVIDER.expectedKeyPrefix} 로 시작한다. 이 시크릿에 다른 서비스 키가 들어 있는지 확인할 것.`);
    }
  }
  if (error.status === 404) {
    // Metadata-only request: report available model IDs, never select a paid fallback.
    try {
      const apiKey = PROVIDER.keyEnv.map(name => process.env[name]).find(Boolean);
      const models = await PROVIDER.listModels(apiKey);
      console.error(models.length ? `Available models: ${models.join(', ')}` : 'Model metadata unavailable');
    } catch { console.error('Model metadata unavailable'); }
  }
  process.exitCode = 1;
});
