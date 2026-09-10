import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDomainGuard, collectWithCheckpoint } from '../scripts/collection_resilience.mjs';
import { coverageStatus } from '../scripts/local_report.mjs';

test('unavailable host pauses, another host proceeds, and cooldown allows one probe', async () => {
  let now = 0;
  const guard = createDomainGuard({ now: () => now, cooldownMs: 100 });
  const fail = () => guard.run('https://down.example/news', async () => { throw new Error('fetch failed'); });
  for (let i = 0; i < 3; i++) await assert.rejects(fail(), /fetch failed/);
  await assert.rejects(fail(), /domain_cooldown/);
  assert.equal(await guard.run('https://other.example/', async () => 'ok'), 'ok');
  now = 100;
  let finish;
  const probe = guard.run('https://down.example/', () => new Promise(resolve => { finish = resolve; }));
  await assert.rejects(fail(), /domain_cooldown/);
  finish('recovered');
  await probe;
  assert.equal(await guard.run('https://down.example/', async () => 'ok'), 'ok');
  assert.equal(guard.stats.skipped, 2);
});

test('access-denied URLs never trigger transport cooldown for unrelated pages', async () => {
  const guard = createDomainGuard();
  for (let i = 0; i < 4; i++) await assert.rejects(guard.run('https://site.example/private', async () => {
    throw Object.assign(new Error('HTTP 403 Forbidden'), { status: 403 });
  }), /403/);
  assert.equal(await guard.run('https://site.example/public', async () => 'public'), 'public');
  assert.equal(guard.stats.skipped, 0);
});

test('checkpoint resumes completed companies, retries transient failures, expires and respects refresh', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'company-progress-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let calls = 0, now = 100;
  const args = { directory, identity: { company: 'A', period: '2026-08' }, now: () => now,
    collect: async () => { calls++; return { rows: [{ title: 'article' }], requestCount: 3, errors: [] }; } };
  assert.equal((await collectWithCheckpoint(args)).cached, false);
  const cached = await collectWithCheckpoint(args);
  assert.equal(cached.cached, true);
  assert.equal(cached.requestCount, 0);
  assert.equal(calls, 1);
  await collectWithCheckpoint({ ...args, refresh: true });
  assert.equal(calls, 2);
  now += 24 * 3600000;
  await collectWithCheckpoint(args);
  assert.equal(calls, 3);
  const bad = { ...args, identity: { company: 'B' }, collect: async () => ({ rows: [], requestCount: 1, errors: [{ error: 'fetch failed' }] }) };
  await collectWithCheckpoint(bad);
  assert.equal((await collectWithCheckpoint(bad)).cached, false);
  assert.equal(coverageStatus([], new Map(), 'incomplete'), 'incomplete_evidence');
});
