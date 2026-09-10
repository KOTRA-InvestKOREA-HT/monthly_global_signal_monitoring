import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

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
      if (saved.version === 1 && now() - saved.saved_at < 24 * 3600000 && !retryableCollection(saved.result)) {
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
