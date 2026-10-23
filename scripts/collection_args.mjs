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
// 상한을 올리면 기업당 LLM 판정 요청, 본문 받기, Google 링크 풀기 요청이 그만큼 늘어난다.
// 2026-08 보고서에서 탐색 기사 27건 중 5건이 승인됐다(본문 있는 13건 기준 38%, 소스 중 가장 높다). 그래서 1건에서 2건으로 올렸다.
// 2026-09 수집(4호)은 탐색으로 441건을 찾고 51건만 남겼다. 17개사가 2건 상한을 채웠고, 그중 15개사는 찾은 기사가
// 5건 이상이었다(ASML 99, Vestas 34, Applied Materials 32 등). 본문 있는 9월 탐색 기사도 17건 중 6건이 승인됐다.
// 4건이면 상한을 채운 기업마다 두 자리가 더 생겨 후보가 많아야 32건 는다. 판정 요청 약 32회, 4.5초 간격으로
// 2분 반 남짓이고 실행당 판정 상한(review_report.mjs MAX_JUDGE_REQUESTS) 안에 든다. 5건 이상은 키워드가 덜 구체적으로 맞은 기사
// (selectTrendRows 의 뒷순위)에 자리를 주면서 Google 링크 풀기 요청을 더 늘린다. 9월에는 탐색 기사 51건 중
// 21건이 Google 429 일시정지로 본문을 받지 못했다. 그래서 4건에서 멈춘다.
export const TREND_DISCOVERY_PER_COMPANY = 4;

// 외부 기사. 예전에는 이번 달 공식 기사가 있으면 일반 뉴스 검색을 아예 돌리지 않았다(fallbackMode missing).
// 9월 수집에서 77개사 중 46개사가 그렇게 건너뛰었고, Amkor 의 광주 증설 검토 같은 외부 보도가 빠졌다.
// 2026-10-23 사용자 결정으로 늘 돌린다(always). 공식 기사가 기업 자리를 채워도 외부 기사 3건까지는 상한 밖에
// 덧붙인다. 기업마다 한국 관련 검색(buildKoreaQuery)도 한 번 돌려 2건까지 덧붙인다.
// 많아야 기업당 5건, 77개사 385건이 는다. 기간 밖·중복·주가 해설(stockCommentary)을 빼면 실제로는 그보다 적다.
// 판정 상한은 같은 날 600건에서 800건으로 올렸다(review_report.mjs).
export const EXTERNAL_NEWS_PER_COMPANY = 3;
export const KOREA_NEWS_PER_COMPANY = 2;

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
  fallbackMode: 'always',
  fallbackMinResults: 1,
  rateLimitSeconds: 0.5,
  companyConcurrency: 4,
  technologyMap: 'data/company_technology_map.json',
  keywordConfig: 'config/technology_keywords.json',
  searchTerms: 'config/trend_search_terms.json',
  maxTrendDiscovery: TREND_DISCOVERY_PER_COMPANY,
  maxExternalNews: EXTERNAL_NEWS_PER_COMPANY,
  maxKoreaNews: KOREA_NEWS_PER_COMPANY,
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
  maxExternalNews: '--max-external-news',
  maxKoreaNews: '--max-korea-news',
};

// 수집본을 다시 쓸지 정하는 입력 요약(collection_input_digest)에 넣는 외부 기사 설정. 수집기와 운영 판정이 같은
// 값을 넣어야 한다. 이 값이 없으면 설정을 바꿔도 하루 안에 받은 수집본을 그대로 다시 쓴다.
export function newsDigestInputs(settings = COLLECTION_SETTINGS) {
  return { fallbackMode: settings.fallbackMode, maxExternalNews: settings.maxExternalNews, maxKoreaNews: settings.maxKoreaNews };
}

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
