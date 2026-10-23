import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { COLLECTION_ARGS, COLLECTOR_NODE_FLAGS, collectorCommand } from '../scripts/collection_args.mjs';
import { parseArgs } from '../scripts/collect_company_signals.mjs';

// 운영 판정(review_report.mjs)이 2026-10 까지 손으로 넘기던 인자. 공용 인자는 이것과 같아야 한다.
// 사업동향 탐색 상한만 2026-10 에 2건에서 4건으로 올렸다(collection_args.mjs 의 근거).
// 2026-10-23 에 외부 기사를 늘 보도록 바꿨다: fallback-mode always, 외부 기사 3건, 한국 관련 검색 2건.
const PRODUCTION = ['--companies', 'data/target_companies.json', '--source-config', 'config/company_sources.json',
  '--sources', 'official_feeds,official_pages,official_sitemaps,sec_filings,google_news',
  '--max-per-source', '6', '--max-per-company', '10', '--max-detail-per-company', '10', '--fallback-mode', 'always',
  '--fallback-min-results', '1', '--rate-limit-seconds', '0.5', '--company-concurrency', '4',
  '--technology-map', 'data/company_technology_map.json', '--keyword-config', 'config/technology_keywords.json',
  '--search-terms', 'config/trend_search_terms.json', '--max-trend-discovery', '4',
  '--max-external-news', '3', '--max-korea-news', '2'];
const pairs = args => Object.fromEntries(args.reduce((list, value, index) => (index % 2 ? list : [...list, [value, args[index + 1]]]), []));

test('the shared collection arguments are the production arguments', () => {
  assert.deepEqual(pairs([...COLLECTION_ARGS]), pairs(PRODUCTION));
  assert.deepEqual(COLLECTOR_NODE_FLAGS, ['--max-http-header-size=131072']);
  const command = collectorCommand(['--out-dir', 'x', '--from-date', '2026-09-01', '--to-date', '2026-09-30']);
  assert.equal(command[0], '--max-http-header-size=131072');
  assert.equal(command[1], 'scripts/collect_company_signals.mjs');
  // 운영 인자로 읽은 값과 기본값이 같다. 인자 없이 돌려도 운영과 같은 설정이다.
  const parsed = parseArgs(command.slice(2));
  const { outDir, fromDate, toDate, ...settings } = parsed;
  const { outDir: defaultOut, fromDate: f, toDate: t, ...defaults } = parseArgs([]);
  assert.deepEqual(settings, defaults);
  assert.deepEqual([outDir, fromDate, toDate], ['x', '2026-09-01', '2026-09-30']);
  // 기업 체크포인트 식별자는 args 의 키 순서까지 해시한다. 순서가 바뀌면 받아 둔 수집을 모두 다시 받는다.
  assert.deepEqual(Object.keys(parsed), ['companies', 'sourceConfig', 'outDir', 'refresh', 'sources', 'days', 'fromDate',
    'toDate', 'maxPerSource', 'maxPerCompany', 'fallbackMinResults', 'fallbackMode', 'rateLimitSeconds', 'timeoutSeconds',
    'companyLimit', 'companyConcurrency', 'fetchOfficialContent', 'contentCharLimit', 'contentExcerptLimit',
    'maxDetailPerCompany', 'fetchRetries', 'linkPolicy', 'maxVerifyPerCompany', 'technologyMap', 'keywordConfig',
    'searchTerms', 'maxTrendDiscovery', 'maxExternalNews', 'maxKoreaNews']);
});

test('every collection entry point goes through the shared arguments', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.match(pkg.scripts.collect, /scripts\/collection_args\.mjs/);
  for (const file of ['scripts/review_report.mjs', 'scripts/local_report.mjs']) {
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /collectorCommand\(/, file);
    assert.doesNotMatch(source, /'--max-per-source'|"--max-per-source"/, file);
  }
  assert.match(fs.readFileSync('.github/workflows/link-policy-trial.yml', 'utf8'), /scripts\/collection_args\.mjs/);
});

// 워크플로에서 company_limit 을 비우면 "--company-limit --link-policy current" 가 되어 current 가 버려졌다.
test('the argument parser rejects missing values, unknown flags and non-numbers', () => {
  assert.throws(() => parseArgs(['--company-limit', '--link-policy', 'current']), /Missing value for --company-limit/);
  assert.throws(() => parseArgs(['--link-policy']), /Missing value/);
  assert.throws(() => parseArgs(['--max-per-sorce', '6']), /Unknown argument: --max-per-sorce/);
  assert.throws(() => parseArgs(['--company-limit', 'ten']), /Invalid --company-limit/);
  assert.throws(() => parseArgs(['--company-limit', '-1']), /Invalid --company-limit/);
  assert.throws(() => parseArgs(['--rate-limit-seconds', 'fast']), /Invalid --rate-limit-seconds/);
  assert.throws(() => parseArgs(['--company-concurrency', '0']), /Invalid --company-concurrency/);
  assert.throws(() => parseArgs(['--refresh', 'maybe']), /Invalid --refresh/);
  assert.throws(() => parseArgs(['--fallback-mode', 'sometimes']), /Invalid --fallback-mode/);
  const args = parseArgs(['--company-limit', '0', '--link-policy', 'current', '--refresh', 'false', '--rate-limit-seconds', '1.5',
    '--max-verify-per-company', '2']);
  assert.equal(args.companyLimit, 0);
  assert.equal(args.linkPolicy, 'current');
  assert.equal(args.refresh, false);
  assert.equal(args.rateLimitSeconds, 1.5);
  assert.equal(args.maxVerifyPerCompany, 2);
  // 뒤에 온 같은 플래그가 이긴다. 공용 인자 뒤에 시험용 값을 붙이는 방식이 여기에 기댄다.
  assert.equal(parseArgs(['--max-per-source', '6', '--max-per-source', '3']).maxPerSource, 3);
});
