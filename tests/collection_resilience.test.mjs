import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDomainGuard, collectWithCheckpoint, collectionMaxAgeMs, retryableCollection } from '../scripts/collection_resilience.mjs';
import { collectionBlockingErrors, companyCollectionIdentity, companyTrendInputs, parseArgs } from '../scripts/collect_company_signals.mjs';
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

// 9월 28일 실행: Google 확인이 멈춘 뒤의 78건은 요청 없이 남았고 오류도 없어, 체크포인트가 완료로 저장됐다.
test('Google rows skipped by a paused probe make the company retryable, detail failures alone do not', () => {
  const result = errors => ({ rows: [], requestCount: 1, errors });
  assert.equal(retryableCollection(result([{ source: 'official_detail', error: 'google_probe_paused' }])), true);
  assert.equal(retryableCollection(result([{ source: 'official_detail', error: 'HTTP 403 Forbidden' }])), false);
  assert.equal(collectionBlockingErrors([{ source: 'official_detail', error: 'google_probe_paused' }]).length, 0);
});

// 한 기업의 출처를 고쳤다고 77개 기업을 모두 다시 받지 않는다. 그 기업 결과를 바꿀 수 있는 것은 모두 식별자에 남는다.
test('a company checkpoint depends on its own sources and every setting that shapes its rows', () => {
  const hydro = { target_no: 31, company: 'Norsk Hydro', query_aliases: ['Hydro'] };
  const sources = { description: ['note'],
    official_feeds: { 'Norsk Hydro': [{ url: 'https://hydro.example/rss' }], Cognex: [{ url: 'https://cognex.example/rss' }] },
    official_pages: { 'Norsk Hydro': [{ url: 'https://hydro.example/news' }], Cognex: [{ url: 'https://cognex.example/news' }] },
    official_sitemaps: { Cognex: [{ url: 'https://cognex.example/sitemap.xml' }] },
    sec_filers: { Cognex: { cik: '1' } } };
  const technology = { companies: [
    { target_no: 31, company: 'Norsk Hydro', technology_group: 'scrap', target_technology_en: 'scrap use' },
    { target_no: 5, company: 'Cognex', technology_group: 'vision', target_technology_en: 'machine vision' }] };
  const keywords = { default_threshold: 1, groups: { scrap: { keywords: ['recycled aluminium'] }, vision: { keywords: ['camera'] } } };
  const terms = { companies: { 'Norsk Hydro': ['CIRCAL'], Cognex: ['In-Sight'] } };
  const args = parseArgs(['--from-date', '2026-09-01', '--to-date', '2026-09-30', '--max-trend-discovery', '2']);
  const dateRange = { fromDate: '2026-09-01', toDate: '2026-09-30' };
  const key = ({ company = hydro, sourceConfig = sources, settings = args, selectedSources = ['official_pages', 'google_news'],
    period = dateRange, tech = technology, kw = keywords, st = terms } = {}) => JSON.stringify(companyCollectionIdentity({
    company, sourceConfig, args: settings, selectedSources, dateRange: period,
    trendInputs: companyTrendInputs(settings, company, tech, kw, st) }));
  const base = key();
  const edit = (object, change) => ({ ...structuredClone(object), ...change });
  // 다른 기업의 출처·기술 항목·키워드 그룹·검색어를 고쳐도 그대로다. 실행 위치(outDir)·refresh 도 그렇다.
  for (const same of [
    key({ sourceConfig: edit(sources, { official_pages: { ...sources.official_pages, Cognex: [{ url: 'https://cognex.example/press' }] } }) }),
    key({ sourceConfig: edit(sources, { sec_filers: {}, official_sitemaps: {} }) }),
    key({ tech: { companies: [technology.companies[0], { ...technology.companies[1], technology_group: 'scrap' }] } }),
    key({ kw: edit(keywords, { groups: { ...keywords.groups, vision: { keywords: ['lens'] } } }) }),
    key({ st: { companies: { 'Norsk Hydro': ['CIRCAL'] } } }),
    key({ settings: { ...args, outDir: 'elsewhere', refresh: true } }),
  ]) assert.equal(same, base);
  // 자기 몫의 출처·기술 항목·키워드 그룹·검색어, 회사 항목, 기간, 출처 목록, 상한·정책은 모두 식별자를 바꾼다.
  for (const changed of [
    key({ sourceConfig: edit(sources, { official_feeds: { ...sources.official_feeds, 'Norsk Hydro': [] } }) }),
    key({ sourceConfig: edit(sources, { official_pages: { ...sources.official_pages, 'Norsk Hydro': [{ url: 'https://hydro.example/press' }] } }) }),
    key({ sourceConfig: edit(sources, { official_sitemaps: { ...sources.official_sitemaps, 'Norsk Hydro': [{ url: 'https://hydro.example/s.xml' }] } }) }),
    key({ sourceConfig: edit(sources, { sec_filers: { ...sources.sec_filers, 'Norsk Hydro': { cik: '2' } } }) }),
    key({ sourceConfig: edit(sources, { defaults: { timeout: 5 } }) }),
    key({ tech: { companies: [{ ...technology.companies[0], target_technology_en: 'scrap utilisation' }, technology.companies[1]] } }),
    key({ kw: edit(keywords, { groups: { ...keywords.groups, scrap: { keywords: ['remelting'] } } }) }),
    key({ kw: edit(keywords, { default_threshold: 2 }) }),
    key({ st: { companies: { 'Norsk Hydro': ['CIRCAL', 'recycled alu'], Cognex: ['In-Sight'] } } }),
    key({ company: { ...hydro, search_names: ['Norsk Hydro ASA'] } }),
    key({ period: { fromDate: '2026-08-01', toDate: '2026-08-31' } }),
    key({ selectedSources: ['official_pages'] }),
    key({ settings: { ...args, maxPerCompany: 12 } }),
    key({ settings: { ...args, maxDetailPerCompany: 3 } }),
    key({ settings: { ...args, linkPolicy: args.linkPolicy === 'current' ? 'proposed' : 'current' } }),
    key({ settings: { ...args, maxTrendDiscovery: 1 } }),
    key({ settings: { ...args, contentCharLimit: 1000 } }),
  ]) assert.notEqual(changed, base);
  // 탐색을 끄면 탐색 입력은 식별자에서 빠진다.
  assert.equal(companyTrendInputs({ maxTrendDiscovery: 0 }, hydro, technology, keywords, terms), null);
});

// 무료 한도로 판정이 멈추면 다음 날 이어 돌린다. 마감 뒤 사흘이 지나 받은 수집본만 72시간까지 쓴다.
test('collection lasts 72 hours only when it was taken three days after the period closed', async t => {
  const at = value => Date.parse(value);
  // 9월 기간은 10월 1일 0시에 닫힌다. 10월 4일 0시부터 받은 수집본이 72시간 대상이다.
  assert.equal(collectionMaxAgeMs('2026-09-30', at('2026-10-04T00:00:00Z')), 72 * 3600000);
  assert.equal(collectionMaxAgeMs('2026-09-30', at('2026-10-03T23:59:59Z')), 24 * 3600000);
  assert.equal(collectionMaxAgeMs('2026-09-30', at('2026-10-01T04:49:52Z')), 24 * 3600000);
  // 기간이 없는 조회와 잘못된 시각은 기본값이다.
  assert.equal(collectionMaxAgeMs('', at('2026-12-01T00:00:00Z')), 24 * 3600000);
  assert.equal(collectionMaxAgeMs('2026-09-30', NaN), 24 * 3600000);

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'company-progress-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let calls = 0, now = at('2026-10-05T09:00:00Z');
  const args = { directory, identity: { company: 'A', period: '2026-09' }, toDate: '2026-09-30', now: () => now,
    collect: async () => { calls++; return { rows: [{ title: 'article' }], requestCount: 3, errors: [] }; } };
  await collectWithCheckpoint(args);
  now += 48 * 3600000;
  assert.equal((await collectWithCheckpoint(args)).cached, true);
  now += 24 * 3600000;
  assert.equal((await collectWithCheckpoint(args)).cached, false);
  assert.equal(calls, 2);
  // 마감 다음 날 받은 수집본은 실행이 마감 사흘 뒤여도 24시간만 쓴다.
  const early = { ...args, identity: { company: 'B', period: '2026-09' } };
  now = at('2026-10-02T09:00:00Z');
  await collectWithCheckpoint(early);
  now = at('2026-10-04T08:00:00Z');
  assert.equal((await collectWithCheckpoint(early)).cached, false);
});
