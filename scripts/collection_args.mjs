// 수집기 인자를 한 곳에 둔다. 운영 판정(review_report.mjs), 로컬 보고서(local_report.mjs), npm run collect,
// link-policy-trial 워크플로가 모두 이 값으로 수집기를 돌린다. 예전에는 진입점마다 인자를 손으로 적어서, 운영만
// 사이트맵·SEC 출처와 응답 헤더 한도를 넘기고 나머지는 빠뜨렸다. 같은 기간을 돌려도 결과가 달랐다.
//
//   node scripts/collection_args.mjs --out-dir outputs --from-date 2026-09-01 --to-date 2026-09-30 [수집기 인자...]
//
// 뒤에 적은 인자는 운영 인자 뒤에 붙어 같은 이름의 운영 값을 덮는다(수집기는 같은 플래그가 두 번 오면 뒤의 값을 쓴다).
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// 기업당 사업동향 탐색 후보 상한. 판정 파이프라인(review_report.mjs)이 수집 식별자를 맞출 때 같은 값을 쓴다.
// 상한을 올리면 기업당 LLM 호출도 그만큼 늘어난다.
// 2026-08 보고서에서 탐색 기사 27건 중 5건이 승인됐다(본문 있는 13건 기준 38%, 소스 중 가장 높다).
// 9월 18일 probe 에서 2건 상한은 47건을 남겼다. 판정 호출 약 20회를 더 쓰고 2건으로 올린다.
export const TREND_DISCOVERY_PER_COMPANY = 2;

export const COLLECTOR_SCRIPT = 'scripts/collect_company_signals.mjs';

// 응답 헤더가 Node 기본 한도(16KB)를 넘는 사이트가 있다. Cytiva 뉴스룸과 Yahoo Finance 는 이 한도에서
// UND_ERR_HEADERS_OVERFLOW 로 실패한다.
export const COLLECTOR_NODE_FLAGS = ['--max-http-header-size=131072'];

// 운영 수집 설정. 수집기의 parseArgs 기본값도 이 값을 쓴다. 기간(--from-date/--to-date 또는 --days)과
// 출력 폴더(--out-dir)는 호출하는 쪽이 정한다.
export const COLLECTION_SETTINGS = Object.freeze({
  companies: 'data/target_companies.json',
  sourceConfig: 'config/company_sources.json',
  sources: 'official_feeds,official_pages,official_sitemaps,sec_filings,google_news',
  maxPerSource: 6,
  maxPerCompany: 10,
  maxDetailPerCompany: 10,
  fallbackMode: 'missing',
  fallbackMinResults: 1,
  rateLimitSeconds: 0.5,
  companyConcurrency: 4,
  technologyMap: 'data/company_technology_map.json',
  keywordConfig: 'config/technology_keywords.json',
  searchTerms: 'config/trend_search_terms.json',
  maxTrendDiscovery: TREND_DISCOVERY_PER_COMPANY,
});

const FLAGS = {
  companies: '--companies',
  sourceConfig: '--source-config',
  sources: '--sources',
  maxPerSource: '--max-per-source',
  maxPerCompany: '--max-per-company',
  maxDetailPerCompany: '--max-detail-per-company',
  fallbackMode: '--fallback-mode',
  fallbackMinResults: '--fallback-min-results',
  rateLimitSeconds: '--rate-limit-seconds',
  companyConcurrency: '--company-concurrency',
  technologyMap: '--technology-map',
  keywordConfig: '--keyword-config',
  searchTerms: '--search-terms',
  maxTrendDiscovery: '--max-trend-discovery',
};

export const COLLECTION_ARGS = Object.freeze(Object.entries(COLLECTION_SETTINGS).flatMap(([key, value]) => [FLAGS[key], String(value)]));

// node 에 넘길 인자 전체. extra 는 운영 인자 뒤에 붙는다(--out-dir, 기간, 시험용 덮어쓰기).
export function collectorCommand(extra = []) {
  return [...COLLECTOR_NODE_FLAGS, COLLECTOR_SCRIPT, ...COLLECTION_ARGS, ...extra];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // --use-system-ca 처럼 이 스크립트를 띄운 node 옵션은 수집기에도 그대로 넘긴다.
  const child = spawn(process.execPath, [...process.execArgv, ...collectorCommand(process.argv.slice(2))], { stdio: 'inherit' });
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.on('close', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}
