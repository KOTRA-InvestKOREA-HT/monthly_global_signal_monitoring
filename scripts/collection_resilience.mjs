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
    if (state.failures >= threshold) state.probing = true;
    const start = now();
    stats.attempts++;
    try {
      const result = await request();
      state.failures = 0;
      return result;
    } catch (error) {
      // A reachable server rejecting one URL is different from an unavailable host.
      if (error.status === undefined || error.status === 408 || error.status === 429 || error.status >= 500) {
        state.failures++;
        if (state.failures >= threshold) state.until = now() + cooldownMs;
      } else state.failures = 0;
      throw error;
    } finally { state.probing = false; stats.elapsed_ms += now() - start; }
  } };
}

// google_probe_paused: Google 확인이 멈춰 요청조차 보내지 않은 기사. 다음 실행에서 다시 시도해야 한다.
export function retryableCollection(result) {
  return result.errors.some(e => /fetch failed|timeout|aborted|domain_cooldown|google_probe_paused|HTTP (408|425|429|5\d\d)/i.test(e.error || ''));
}

// toDate: 수집 기간의 끝날. 체크포인트를 얼마나 오래 쓸지 정한다(collectionMaxAgeMs).
export async function collectWithCheckpoint({ directory, identity, collect, now = Date.now, refresh = false, toDate = '' }) {
  const key = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const file = path.join(directory, `${key}.json`);
  if (!refresh) {
    try {
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      const age = now() - saved.saved_at;
      if (saved.version === 1 && Number.isFinite(age) && age >= 0 && age < collectionMaxAgeMs(toDate, saved.saved_at) && !retryableCollection(saved.result)) {
        return { ...saved.result, requestCount: 0, cached: true };
      }
    } catch { /* missing/corrupt progress is recollected */ }
  }
  const result = await collect();
  await fs.mkdir(directory, { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify({ version: 1, saved_at: now(), result }));
  await fs.rename(temp, file);
  return { ...result, cached: false };
}
