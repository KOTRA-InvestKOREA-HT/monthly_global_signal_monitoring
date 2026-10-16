import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// 사업동향 탐색의 질의어와 사전 필터는 기술 매핑·키워드 목록에서 나온다. 그 두 파일을 고쳐도
// 식별자가 그대로면 캐시된 수집이 재사용돼 바뀐 키워드가 다음 달까지 반영되지 않는다. 함께 해시한다.
export function collectionInputDigest(targets, sourceConfig, trendInputs = null) {
  return crypto.createHash('sha256').update(JSON.stringify({ targets, sourceConfig, trendInputs })).digest('hex');
}

const DAY_MS = 24 * 3600000;

// 수집본을 다시 쓸 수 있는 시간. 기본은 24시간이고, 기간이 닫힌 지(to_date 다음 날 0시, UTC) 3일이 지난 뒤에
// 받은 수집본만 72시간까지 쓴다. 무료 한도로 판정이 멈추면 다음 날 이어 돌리는데, 24시간이 지났다고 전부
// 다시 받으면 기사 본문·날짜가 바뀌어 이미 끝난 판정까지 다시 해야 한다.
// 대가는 늦게 올라온 기사다. 기간 안에 나왔지만 뉴스룸·검색 색인에 늦게 잡힌 기사는 재사용하는 동안 들어오지
// 않는다. 그래서 실행 시점이 아니라 수집 시점이 마감 뒤 3일 이상일 때만 늘린다(실행도 당연히 그 뒤다).
// 마감 뒤 사흘이 지나도록 안 잡힌 기사는 이틀 더 기다려도 잡힐 가능성이 낮다고 보고 그만큼은 감수한다.
// 마감 직후 받은 수집본은 마지막 며칠 기사가 아직 덜 잡혔을 수 있어 지금처럼 하루만 쓴다.
// 기간 없이 돌린 조회(--days)는 날짜 창이 실행 시점을 따라 움직이므로 늘 24시간이다.
export function collectionMaxAgeMs(toDate, collectedAt) {
  const closed = /^\d{4}-\d{2}-\d{2}$/.test(String(toDate || '')) ? Date.parse(`${toDate}T00:00:00Z`) + DAY_MS : NaN;
  return Number.isFinite(closed) && Number.isFinite(collectedAt) && collectedAt >= closed + 3 * DAY_MS ? 3 * DAY_MS : DAY_MS;
}

export function collectionNeedsRefresh(summary, { version, inputDigest, now = Date.now() }) {
  const age = now - Date.parse(summary.run_finished_at || summary.run_started_at);
  const maxAge = collectionMaxAgeMs(summary.to_date, Date.parse(summary.run_started_at));
  return summary.content_collection_version !== version || summary.collection_resume_version !== 1 ||
    summary.collection_input_digest !== inputDigest || summary.retryable_company_count > 0 ||
    !Number.isFinite(age) || age < 0 || age >= maxAge;
}

export function createDomainGuard({ now = Date.now, threshold = 3, cooldownMs = 30000 } = {}) {
  const domains = new Map();
  const stats = { attempts: 0, skipped: 0, elapsed_ms: 0 };
  return { stats, async run(url, request) {
    const host = new URL(url).hostname;
    const state = domains.get(host) || { failures: 0, until: 0, probing: false };
    domains.set(host, state);
    if (state.failures >= threshold && (now() < state.until || state.probing)) {
      stats.skipped++;
      throw Object.assign(new Error(`domain_cooldown: ${host}`), { noRetry: true });
    }
    // 쉬는 시간이 지난 뒤 첫 요청 하나만 탐침으로 보낸다. 탐침이 끝날 때만 표시를 푼다. 예전에는 탐침이 아닌
    // 요청이 끝날 때도 풀어서, 탐침이 진행 중인데 다른 요청이 그 호스트로 함께 나갔다.
    const probe = state.failures >= threshold;
    if (probe) state.probing = true;
    const start = now();
    stats.attempts++;
    try {
      const result = await request();
      state.failures = 0;
      return result;
    } catch (error) {
      // A reachable server rejecting one URL is different from an unavailable host.
      // noRetry 오류(크기 초과, Google 중계 주소 등)는 응답을 받은 뒤의 판단이라 호스트 장애가 아니다.
      if (!error.noRetry && (error.status === undefined || error.status === 408 || error.status === 429 || error.status >= 500)) {
        state.failures++;
        if (state.failures >= threshold) state.until = now() + cooldownMs;
      } else state.failures = 0;
      throw error;
    } finally {
      if (probe) state.probing = false;
      stats.elapsed_ms += now() - start;
    }
  } };
}

const TRANSIENT_ERROR = /fetch failed|timeout|aborted|domain_cooldown|HTTP (408|425|429|5\d\d)/i;
// google_probe_paused: Google 확인이 멈춰 요청조차 보내지 않은 기사. 다음 실행에서 다시 시도해야 한다.
const PROBE_PAUSED = /google_probe_paused/i;

export function retryableError(error) {
  const message = error?.error || '';
  return TRANSIENT_ERROR.test(message) || PROBE_PAUSED.test(message);
}

export function retryableCollection(result) {
  return result.errors.some(retryableError);
}

// 재시도할 까닭이 Google 확인 멈춤뿐인 기업. 9월 실행(10월 1일)에서 재시도 대상 28개 기업 가운데 26개가 그랬다.
// 공식 출처·검색·상세 페이지는 이미 다 받았으므로 멈춘 기사만 다시 받으면 된다.
export function onlyProbePaused(result) {
  const retryable = result.errors.filter(retryableError);
  return retryable.length > 0 && !retryable.some(error => TRANSIENT_ERROR.test(error.error || ''));
}

// 다시 써도 되는 단계 결과. 일시 오류나 Google 확인 멈춤이 든 결과는 다음에 다시 시도해야 하므로 남기지 않는다.
// failed: 출처 수집기가 던진 오류의 메시지.
export function reusableStep(value) {
  return !retryableError({ error: value?.failed }) && !(value?.errors || []).some(retryableError);
}

export function stepKey(kind, input) {
  return `${kind}:${crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex')}`;
}

// 기업 수집의 단계별 결과 기록. 출처 하나, 검색 하나, 상세 페이지 한 건이 각각 한 단계다.
// previous 가 있으면 같은 단계는 요청하지 않고 그 결과를 쓴다. 단계 사이의 판단(대체 수집 여부, 기업 상한,
// 상세 페이지 상한, 사업동향 후보 선택)은 지금처럼 다시 계산하므로, 결과는 같은 응답을 받은 전체 재수집과 같다.
// 멈춘 기사를 이번에 받으면 그 뒤 기사가 상세 페이지 상한에 걸리는 것까지 그대로 따라간다.
// replayed 단계는 이번 실행의 작업이 아니므로 요청 수에 더하지 않고 요청 간격도 두지 않는다.
// 기록은 그 순간의 사본이다. 뒤 단계가 받은 객체를 고쳐도 기록은 단계가 돌려준 그대로 남는다.
export function createStepLog(previous = null) {
  const copy = value => JSON.parse(JSON.stringify(value));
  const saved = new Map(previous || []);
  const steps = [], recorded = new Set();
  const record = (key, value) => {
    if (recorded.has(key)) return;
    recorded.add(key);
    steps.push([key, copy(value)]);
  };
  return {
    steps,
    async run(key, task, reusable = reusableStep) {
      if (saved.has(key)) {
        const value = copy(saved.get(key));
        record(key, value);
        return { value, replayed: true };
      }
      const value = await task();
      if (reusable(value)) record(key, value);
      return { value, replayed: false };
    },
  };
}

// toDate: 수집 기간의 끝날. 체크포인트를 얼마나 오래 쓸지 정한다(collectionMaxAgeMs).
// collect 는 단계 기록(createStepLog)을 받는다. 체크포인트에 결과와 함께 단계 결과를 남겨, 재시도할 까닭이
// Google 확인 멈춤뿐인 기업은 다음 실행에서 멈춘 기사만 다시 받는다. 다른 일시 오류가 있으면 처음부터 받는다.
// 이어 받은 체크포인트는 처음 받은 시각을 그대로 지닌다. 재사용한 단계가 그때 받은 것이기 때문이다.
export async function collectWithCheckpoint({ directory, identity, collect, now = Date.now, refresh = false, toDate = '' }) {
  const key = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const file = path.join(directory, `${key}.json`);
  let replay = null, savedAt = null;
  if (!refresh) {
    try {
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      const age = now() - saved.saved_at;
      if (saved.version === 1 && Number.isFinite(age) && age >= 0 && age < collectionMaxAgeMs(toDate, saved.saved_at)) {
        if (!retryableCollection(saved.result)) return { ...saved.result, requestCount: 0, cached: true };
        if (onlyProbePaused(saved.result) && Array.isArray(saved.steps)) {
          replay = createStepLog(saved.steps);
          savedAt = saved.saved_at;
        }
      }
    } catch { /* missing/corrupt progress is recollected */ }
  }
  const log = replay || createStepLog();
  const result = await collect(log);
  await fs.mkdir(directory, { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify({ version: 1, saved_at: savedAt ?? now(), result, steps: log.steps }));
  await fs.rename(temp, file);
  return { ...result, cached: false, resumed: replay !== null };
}
