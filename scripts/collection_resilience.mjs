import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// 사업동향 탐색의 질의어와 사전 필터는 기술 매핑·키워드 목록에서 나온다. 그 두 파일을 고쳐도
// 식별자가 그대로면 캐시된 수집이 재사용돼 바뀐 키워드가 다음 달까지 반영되지 않는다. 함께 해시한다.
export function collectionInputDigest(targets, sourceConfig, trendInputs = null) {
  return crypto.createHash('sha256').update(JSON.stringify({ targets, sourceConfig, trendInputs })).digest('hex');
}

export function collectionNeedsRefresh(summary, { version, inputDigest, now = Date.now() }) {
  const age = now - Date.parse(summary.run_finished_at || summary.run_started_at);
  return summary.content_collection_version !== version || summary.collection_resume_version !== 1 ||
    summary.collection_input_digest !== inputDigest || summary.retryable_company_count > 0 ||
    !Number.isFinite(age) || age < 0 || age >= 24 * 3600000;
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

export function retryableCollection(result) {
  return result.errors.some(e => /fetch failed|timeout|aborted|domain_cooldown|HTTP (408|425|429|5\d\d)/i.test(e.error || ''));
}

export async function collectWithCheckpoint({ directory, identity, collect, now = Date.now, refresh = false }) {
  const key = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const file = path.join(directory, `${key}.json`);
  if (!refresh) {
    try {
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      const age = now() - saved.saved_at;
      if (saved.version === 1 && Number.isFinite(age) && age >= 0 && age < 24 * 3600000 && !retryableCollection(saved.result)) {
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
