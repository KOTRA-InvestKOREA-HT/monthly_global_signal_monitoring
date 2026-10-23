import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createDomainGuard, collectWithCheckpoint, createStepLog, retryableCollection, collectionInputDigest, stepKey } from './collection_resilience.mjs';
import { ARTICLE_BODY_MIN_CHARS, chooseDateEvidence, hasArticleBody, periodPlacement, reportEligible, resolveDateState, unextractableBody } from "./date_state.mjs";
import {
  augustRule,
  classifyOfficialLink,
  currentRule,
  isHttpUrl,
  looksLikeBrokenUrl,
  looksLikeSourceIndexUrl,
  isPersonOrCoveragePage,
  verifyFetchedArticle,
} from "./link_policy.mjs";
import { aemModelUrl, extractQualcommAemArticle, fetchedTitleMatchesPublisherArticle, recoverPublisherRow } from './publisher_recovery.mjs';
import { COLLECTION_SETTINGS, newsDigestInputs } from './collection_args.mjs';
// v17: 본문 상한을 24000자에서 36000자로 올렸다. 버전을 바꿔야 게시 단계가 24000자로 잘린 수집본을 다시 쓰지 않는다.
// v18: 상세 페이지를 못 읽은 공식 피드 기사에 피드 요약(200자 이상)을 본문으로 싣는다(content_source=feed_summary).
export const CONTENT_COLLECTION_VERSION = 'article-body-v18-feed-summary';
// 기업당 사업동향 탐색 후보 상한과 운영 수집 인자는 collection_args.mjs 에 있다. 판정 파이프라인이 이 파일에서
// 읽어 가므로 다시 내보낸다.
export { TREND_DISCOVERY_PER_COMPANY, collectorCommand, newsDigestInputs } from './collection_args.mjs';
export const DEFAULT_LINK_POLICY = 'proposed';
export const DEFAULT_MAX_VERIFY_PER_COMPANY = 0;

const FIELDNAMES = [
  "target_no",
  "company",
  "title",
  "url",
  "source",
  "published_at",
  "published_month",
  "published_at_precision",
  "published_at_status",
  "modified_at",
  "date_conflict",
  "collected_at",
  "collector",
  "query",
  "published_at_source",
  "source_type",
  "source_kind",
  "is_press_release",
  "source_label_ko",
  "source_priority",
  "official_source_url",
  "source_direct_url",
  "publisher_resolution",
  "publisher_resolution_source_url",
  "publisher_discovery_url",
  "content_excerpt",
  "content_word_count",
  "content_source",
  "content_fetch_status",
  "content_fetched_at",
];

const SIGNAL_TERMS = [
  "\"press release\"",
  "\"investor relations\"",
  "earnings",
  "announcement",
  "investment",
  "expansion",
  "acquisition",
  "partnership",
  "Korea",
];

// 스스로를 봇이라고 밝히는 UA는 기업 사이트의 WAF가 기본값으로 차단한다.
// 공개된 보도자료 페이지를 읽을 뿐 인증이나 유료 구간을 우회하지 않는다.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

// 일시적 실패만 재시도한다.
// 403(거부)과 404(없음)는 서버가 내린 결정이므로 헤더를 바꿔가며 다시 두드리지 않는다.
// 406도 같은 요청을 반복해봐야 결과가 달라지지 않는다.
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

let fetchRetries = 2;
let retryCount = 0;
const domainGuard = createDomainGuard();

// 링크 판정 규칙과 그 결과 집계. main 이 인자를 읽고 정한다.
let linkPolicy = DEFAULT_LINK_POLICY;
// 사업동향 탐색이 쓰는 기술 매핑과 키워드 목록. main() 이 채우고, 없으면 탐색을 건너뛴다.
let trendTechnology = null;
let trendKeywordConfig = null;
let trendSearchTerms = null;
// 링크 판정 집계와 제외 기록은 기업별로 센다(createTally). 기업 결과의 stats 에 실려 체크포인트에 함께 남고,
// main 이 합친다. 예전에는 모듈 전역 카운터라서 체크포인트를 다시 쓰거나 이어 받은 기업의 몫이 빠졌고,
// link-policy-trial 이 캐시를 복원한 뒤 이 숫자를 비교 지표로 쓰면 두 실행의 숫자가 서로 다른 기업 묶음을 셌다.
//
// 기사가 아니라고 판단해 제외한 링크. 필터가 과했는지 사후에 검증할 수 있어야 한다.
// 집계는 전량을 세고, 샘플만 상한을 둔다. 예전에는 둘 다 상한에 걸려 총 제외 건수를 알 수 없었다.
//
// 샘플은 사유별로 따로 담는다. 한 통에 담으면 압도적으로 많은 사유 하나가 표본을 다 먹는다.
// 실제로 9,998건 제외 중 9,782건이 index_or_category_page 라서, 120건 표본이 전부 그 사유로
// 채워지고 no_article_title 22건은 한 건도 눈에 띄지 않았다. 확인이 필요한 쪽은 늘 소수 사유다.
const EXCLUDED_SAMPLE_PER_REASON = 24;
const EXCLUDED_SAMPLE_PER_COMPANY_PER_REASON = 2;

export function createTally() {
  return { link_verdict_counts: {}, excluded_non_article_count: 0, excluded_non_article_reasons: {},
    excluded_non_article_samples: [] };
}

function countLinkVerdict(tally, verdict) {
  tally.link_verdict_counts[verdict] = (tally.link_verdict_counts[verdict] || 0) + 1;
}

// 한 회사가 사유별 표본을 다 차지하면 다른 회사의 오제외를 못 본다. 기업별 표본은 사유당 2건까지 둔다.
function addExclusionSample(samples, sample) {
  const same = samples.filter((row) => row.reason === sample.reason && row.company === sample.company).length;
  if (same < EXCLUDED_SAMPLE_PER_COMPANY_PER_REASON) samples.push(sample);
}

function recordExclusion(tally, company, title, url, reason) {
  tally.excluded_non_article_count += 1;
  tally.excluded_non_article_reasons[reason] = (tally.excluded_non_article_reasons[reason] || 0) + 1;
  addExclusionSample(tally.excluded_non_article_samples, { company, title: cleanText(title).slice(0, 120), url, reason });
}

// 단계별·기업별 집계를 합친다. 체크포인트에서 온 옛 결과처럼 집계가 없으면 그 몫은 0이다.
export function mergeTally(target, source) {
  if (!source) return target;
  for (const [verdict, count] of Object.entries(source.link_verdict_counts || {})) {
    target.link_verdict_counts[verdict] = (target.link_verdict_counts[verdict] || 0) + count;
  }
  target.excluded_non_article_count += source.excluded_non_article_count || 0;
  for (const [reason, count] of Object.entries(source.excluded_non_article_reasons || {})) {
    target.excluded_non_article_reasons[reason] = (target.excluded_non_article_reasons[reason] || 0) + count;
  }
  for (const sample of source.excluded_non_article_samples || []) addExclusionSample(target.excluded_non_article_samples, sample);
  return target;
}

// 실행 요약의 제외 표본. 기업 순서대로 사유마다 24건까지 담는다.
export function summarySamples(samples) {
  const byReason = new Map();
  for (const sample of samples) {
    if (!byReason.has(sample.reason)) byReason.set(sample.reason, []);
    const bucket = byReason.get(sample.reason);
    if (bucket.length < EXCLUDED_SAMPLE_PER_REASON) bucket.push(sample);
  }
  return byReason;
}

// 인자 이름과 args 필드. 모르는 플래그는 오류다. 예전에는 조용히 건너뛰어 철자가 틀린 인자가 기본값으로 돌았다.
const ARG_KEYS = {
  "--companies": "companies",
  "--source-config": "sourceConfig",
  "--out-dir": "outDir",
  "--refresh": "refresh",
  "--sources": "sources",
  "--days": "days",
  "--from-date": "fromDate",
  "--to-date": "toDate",
  "--max-per-source": "maxPerSource",
  "--max-per-company": "maxPerCompany",
  "--fallback-min-results": "fallbackMinResults",
  "--fallback-mode": "fallbackMode",
  "--rate-limit-seconds": "rateLimitSeconds",
  "--timeout-seconds": "timeoutSeconds",
  "--company-limit": "companyLimit",
  "--company-concurrency": "companyConcurrency",
  "--fetch-official-content": "fetchOfficialContent",
  "--content-char-limit": "contentCharLimit",
  "--content-excerpt-limit": "contentExcerptLimit",
  "--max-detail-per-company": "maxDetailPerCompany",
  "--fetch-retries": "fetchRetries",
  "--link-policy": "linkPolicy",
  "--max-verify-per-company": "maxVerifyPerCompany",
  "--technology-map": "technologyMap",
  "--keyword-config": "keywordConfig",
  "--search-terms": "searchTerms",
  "--max-trend-discovery": "maxTrendDiscovery",
  "--max-external-news": "maxExternalNews",
  "--max-korea-news": "maxKoreaNews",
};

const INTEGER_ARGS = new Set(["days", "maxPerSource", "maxPerCompany", "fallbackMinResults", "timeoutSeconds",
  "companyLimit", "companyConcurrency", "contentCharLimit", "contentExcerptLimit", "maxDetailPerCompany",
  "fetchRetries", "maxVerifyPerCompany", "maxTrendDiscovery", "maxExternalNews", "maxKoreaNews"]);
// 0 이면 아무 일도 하지 않는 값. 시간 제한과 동시 처리 수는 1 이상이어야 한다.
const POSITIVE_ARGS = new Set(["timeoutSeconds", "companyConcurrency", "contentCharLimit"]);

// 기본값은 운영 수집 설정(collection_args.mjs)이다. args 의 키 순서는 기업 체크포인트 식별자에 들어가므로 바꾸지 않는다.
//
// maxDetailPerCompany·maxVerifyPerCompany 는 이름과 달리 enrichOfficialRowsWithContent 한 번(호출 한 번)의
// 상한이다. 한 기업에서 공식 출처, 대체 수집, 사업동향 탐색이 각각 한 번씩 부르므로 기업당 최대 3배까지 받는다.
// 운영 결과가 이 동작에 맞춰져 있어 동작은 그대로 두고, 식별자에 들어가는 이름도 바꾸지 않는다.
export function parseArgs(argv) {
  const args = {
    companies: COLLECTION_SETTINGS.companies,
    sourceConfig: COLLECTION_SETTINGS.sourceConfig,
    outDir: "outputs",
    refresh: false,
    sources: COLLECTION_SETTINGS.sources,
    days: 45,
    fromDate: "",
    toDate: "",
    maxPerSource: COLLECTION_SETTINGS.maxPerSource,
    maxPerCompany: COLLECTION_SETTINGS.maxPerCompany,
    fallbackMinResults: COLLECTION_SETTINGS.fallbackMinResults,
    fallbackMode: COLLECTION_SETTINGS.fallbackMode,
    rateLimitSeconds: COLLECTION_SETTINGS.rateLimitSeconds,
    timeoutSeconds: 20,
    companyLimit: 0,
    companyConcurrency: COLLECTION_SETTINGS.companyConcurrency,
    fetchOfficialContent: true,
    // 2026-08 수집본에서 본문 415건 중 52건이 24000자에 걸렸고, 대부분 시그널이 많이 나오는 실적 발표·공시 PDF였다.
    // 문안 단계(summary_writer.mjs ARTICLE_EVIDENCE_CHARS)도 같은 36000자까지 받는다.
    contentCharLimit: 36000,
    contentExcerptLimit: 800,
    // 상세 페이지 상한(호출당). 위 주석 참고.
    maxDetailPerCompany: COLLECTION_SETTINGS.maxDetailPerCompany,
    fetchRetries: 2,
    // Keep recovered accept links; uncertain document verification is opt-in.
    linkPolicy: DEFAULT_LINK_POLICY,
    // 확인 대상(fetch_to_verify) 상한(호출당). 위 주석 참고.
    maxVerifyPerCompany: DEFAULT_MAX_VERIFY_PER_COMPANY,
    // 사업동향 탐색. 공식 자료가 있어도 돌린다(아래 collectTrendDiscovery 주석).
    technologyMap: COLLECTION_SETTINGS.technologyMap,
    keywordConfig: COLLECTION_SETTINGS.keywordConfig,
    searchTerms: COLLECTION_SETTINGS.searchTerms,
    maxTrendDiscovery: COLLECTION_SETTINGS.maxTrendDiscovery,
    // 외부 기사 자리와 한국 관련 검색(collection_args.mjs 의 근거). 키 순서 때문에 맨 뒤에 둔다.
    maxExternalNews: COLLECTION_SETTINGS.maxExternalNews,
    maxKoreaNews: COLLECTION_SETTINGS.maxKoreaNews,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const mapped = ARG_KEYS[key];
    if (!mapped) throw new Error(`Unknown argument: ${key}`);
    // 값 자리에 다음 플래그가 오면 값이 빠진 것이다. 워크플로에서 company_limit 을 비우면
    // "--company-limit --link-policy current" 가 되어 current 가 버려지고 기본 정책으로 돌았다.
    const value = argv[index + 1];
    if (value === undefined || String(value).startsWith("--")) throw new Error(`Missing value for ${key}`);
    index += 1;
    if (INTEGER_ARGS.has(mapped)) {
      const number = /^\d+$/.test(String(value).trim()) ? Number(value) : NaN;
      if (!Number.isSafeInteger(number) || (POSITIVE_ARGS.has(mapped) && number < 1)) {
        throw new Error(`Invalid ${key}: ${value}`);
      }
      args[mapped] = number;
    } else if (mapped === "rateLimitSeconds") {
      const number = /^\d+(?:\.\d+)?$/.test(String(value).trim()) ? Number(value) : NaN;
      if (!Number.isFinite(number)) throw new Error(`Invalid ${key}: ${value}`);
      args[mapped] = number;
    } else if (mapped === "fetchOfficialContent" || mapped === 'refresh') {
      const text = String(value).toLowerCase();
      if (!["0", "1", "false", "true", "no", "yes"].includes(text)) throw new Error(`Invalid ${key}: ${value}`);
      args[mapped] = !["0", "false", "no"].includes(text);
    } else {
      args[mapped] = value;
    }
  }
  if (!['current', 'proposed'].includes(args.linkPolicy)) throw new Error('Invalid --link-policy');
  if (!['missing', 'always'].includes(args.fallbackMode)) throw new Error('Invalid --fallback-mode');
  if (!Number.isInteger(args.maxVerifyPerCompany) || args.maxVerifyPerCompany < 0) throw new Error('Invalid --max-verify-per-company');
  return args;
}

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeXml(value = "") {
  return value
    .replace(/^<!\[CDATA\[/, "")
    .replace(/\]\]>$/, "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function cleanText(value = "") {
  return decodeXml(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// 주석은 태그를 지우는 정규식에 걸리지 않는다. `<!-- <img src=...> -->` 처럼 주석 안에
// 태그가 있으면 여는 쪽만 지워지고 닫는 `-->` 가 본문 글자로 남는다.
const stripComments = (value = "") => String(value).replace(/<!--[\s\S]*?-->/g, " ");

function cleanHtmlText(value = "") {
  return decodeXml(stripComments(value))
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<form\b[\s\S]*?<\/form>/gi, " ")
    .replace(/<(nav|footer|header|aside)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|main)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripTracking(url) {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_)/i.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function directUrlCandidate(value) {
  const text = stripTracking(String(value || "").trim());
  return isHttpUrl(text) && !looksLikeSourceIndexUrl(text) ? text : "";
}

function bestRssItemUrl(block, fallbackUrl = "") {
  const candidates = [tagText(block, "link"), tagText(block, "guid"), tagText(block, "id")].filter(Boolean);
  const direct = candidates.map(directUrlCandidate).find(Boolean);
  return direct || stripTracking(candidates.find(isHttpUrl) || fallbackUrl || "");
}

function atomEntryLinkUrls(entry) {
  const preferred = [];
  const fallback = [];
  const linkRegex = /<link\b([^>]*)>/gi;
  for (const match of entry.matchAll(linkRegex)) {
    const attrs = match[1] || "";
    const href = extractAttribute(attrs, "href");
    if (!href) continue;
    const rel = extractAttribute(attrs, "rel").toLowerCase();
    if (!rel || rel === "alternate") {
      preferred.push(href);
    } else {
      fallback.push(href);
    }
  }
  return [...preferred, ...fallback];
}

function bestAtomEntryUrl(entry, fallbackUrl = "") {
  const candidates = [...atomEntryLinkUrls(entry), tagText(entry, "link"), tagText(entry, "id"), fallbackUrl].filter(Boolean);
  const direct = candidates.map(directUrlCandidate).find(Boolean);
  return direct || stripTracking(candidates.find(isHttpUrl) || fallbackUrl || "");
}

function blocks(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"))].map(
    (match) => match[1],
  );
}

function tagText(block, tag) {
  const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? cleanText(match[1]) : "";
}

function tagAttribute(block, tag, name) {
  const match = block.match(new RegExp(`<${tag}\\b([^>]*)>`, "i"));
  return match ? extractAttribute(match[1], name) : "";
}

// 피드 요약이 담기는 자리. RSS 의 content:encoded·description, Atom 의 content·summary.
// tagText 의 `<tag\b` 는 "content" 로 "content:encoded" 까지 잡으므로 여기서는 태그 이름 뒤에 공백이나 > 만 허용한다.
// 비어 있는 <description/> 은 이 정규식에 걸리지 않는다(Veolia 피드의 최근 항목이 그렇다).
const FEED_SUMMARY_TAGS = ["content:encoded", "description", "content", "summary"];

// 요약 안의 HTML 엔티티. decodeXml 은 XML 다섯 개와 숫자 엔티티만 푼다. 피드 요약은 HTML 을 한 번 더 이스케이프해
// 싣는 일이 많아 &nbsp;·&rsquo; 같은 이름 있는 엔티티가 남는다. 모르는 이름은 그대로 둔다. 인용 대조는
// normalizeQuote(local_report.mjs)가 Latin-1 엔티티까지 풀어서 하므로, 남아도 근거 확인은 깨지지 않는다.
const FEED_HTML_ENTITIES = {
  nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", sbquo: "‚",
  bdquo: "„", laquo: "«", raquo: "»", ndash: "–", mdash: "—", hellip: "…", bull: "•", middot: "·", trade: "™",
  reg: "®", copy: "©", euro: "€", pound: "£", yen: "¥", deg: "°", times: "×", plusmn: "±", sect: "§",
  eacute: "é", egrave: "è", ecirc: "ê", aacute: "á", agrave: "à", acirc: "â", iacute: "í", oacute: "ó",
  uacute: "ú", auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß", ccedil: "ç",
  ntilde: "ñ", Eacute: "É",
};

// 피드 항목의 요약을 본문 후보 글로 바꾼다. CDATA 를 벗기고, XML 이스케이프를 한 번 풀어 HTML 로 만든 뒤
// cleanHtmlText 로 태그를 지운다(이때 이중 이스케이프가 한 번 더 풀린다). 상세 페이지 본문 추출(cleanHtmlText·
// extractArticleText)은 건드리지 않는다. 바꾸면 이미 본문이 있던 기사의 근거 글자가 달라져 기사 ID 가 바뀐다.
export function feedSummaryText(raw = "") {
  const unwrapped = String(raw || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  return cleanHtmlText(decodeXml(unwrapped))
    .replace(/&([a-z]+);/gi, (match, name) => FEED_HTML_ENTITIES[name] ?? match)
    // 워드프레스 피드가 덧붙이는 꼬리말이다. 기사 내용이 아니다.
    .replace(/\s*The post .{1,400}? appeared first on .{1,200}?\.?\s*$/s, "")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n\s*/g, "\n")
    .trim();
}

// 항목에 실린 요약 중 가장 긴 것. content:encoded 가 전문이고 description 이 앞부분 발췌인 피드가 많다.
function feedItemSummary(block) {
  let best = "";
  for (const tag of FEED_SUMMARY_TAGS) {
    const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
    const text = match ? feedSummaryText(match[1]) : "";
    if (text.length > best.length) best = text;
  }
  return best;
}

// 상세 페이지 대신 쓸 수 있는 피드 요약. 본문 기준(ARTICLE_BODY_MIN_CHARS)에 못 미치면 쓰지 않는다.
// 한두 문장짜리 요약은 제목을 다시 말할 뿐이라 판정 근거가 되지 못한다.
function feedSummaryBody(summary, contentCharLimit) {
  const text = String(summary || "").slice(0, contentCharLimit);
  return hasArticleBody({ content_text: text }) ? text : "";
}

function withoutFeedSummary(row) {
  const { feed_summary, ...rest } = row;
  return rest;
}

// CoreMedia 는 "2025-07-15T08:13:26Z[GMT]" 처럼 시간대 이름을 대괄호로 덧붙인다. Date 는 못 읽는다.
function stripTimeZoneName(value) {
  return value ? String(value).replace(/\[[^\]]+\]\s*$/, "") : value;
}

// 시간대 표기를 분 단위 오프셋으로 읽는다. 표기가 없으면 null 이다. 약어는 Date 가 읽는 미국 약어와 GMT·UTC 뿐이다.
const ZONE_ABBREVIATION_OFFSETS = { GMT: 0, UTC: 0, EST: -300, EDT: -240, CST: -360, CDT: -300,
  MST: -420, MDT: -360, PST: -480, PDT: -420 };

function zoneOffsetMinutes(text) {
  const numeric = text.match(/([+-])(\d{2}):?(\d{2})$/);
  if (numeric) return (numeric[1] === "-" ? -1 : 1) * (Number(numeric[2]) * 60 + Number(numeric[3]));
  const named = text.match(/\b(GMT|UTC|[ECMP][SD]T)$/i);
  if (named) return ZONE_ABBREVIATION_OFFSETS[named[1].toUpperCase()];
  return /\dZ$/i.test(text) ? 0 : null;
}

// 게시처 현지 시각과 그 오프셋. UTC 로 바꿔 적으면 9월 1일 오전 0시 30분(+09:00)에 낸 발표가 8월 31일이 되어
// 8월 보고서에 들어간다. 한국·일본 기업의 1일 오전 발표, 유럽의 자정 직후 발표가 그렇다. 오프셋을 남겨 두면
// 시각은 그대로 같은 순간이고, 날짜는 앞 열 글자(게시처 현지 날짜)로 읽는다(date_state.mjs dayOf).
function formatWithOffset(ms, offsetMinutes) {
  const local = new Date(ms + offsetMinutes * 60000).toISOString().slice(0, 19);
  if (!offsetMinutes) return `${local}Z`;
  const minutes = Math.abs(offsetMinutes);
  return `${local}${offsetMinutes < 0 ? "-" : "+"}${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

// 없는 날짜(2026-02-31)를 Date 는 다음 달로 넘겨 읽는다(3월 3일). 적힌 연·월·일이 실제로 있는 날인지 본다.
function isRealCalendarDay(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

function parseDate(value) {
  if (!value) return null;
  // Date parses a zone-less English calendar date at local midnight. In KST
  // that becomes the previous UTC day, so "October 20" was stored as the 19th.
  // Calendar-only values have no timezone; preserve the printed day as UTC.
  const named = String(value).match(new RegExp(
    `^\\s*(${MONTH_NAME_PATTERN})\\s+([0-3]?\\d),?\\s+((?:19|20)\\d{2})\\s*$`, 'i'));
  const dayNamed = String(value).match(new RegExp(
    `^\\s*([0-3]?\\d)\\s+(${MONTH_NAME_PATTERN})\\s+((?:19|20)\\d{2})\\s*$`, 'i'));
  const calendar = named
    ? [named[3], monthNumberFromName(named[1]), named[2]]
    : dayNamed ? [dayNamed[3], monthNumberFromName(dayNamed[2]), dayNamed[1]] : null;
  if (calendar) {
    const [year, month, day] = calendar.map(Number);
    if (!isRealCalendarDay(year, month, day)) return null;
    return new Date(Date.UTC(year, month - 1, day)).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  const text = String(value).trim();
  const isoDay = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/);
  if (isoDay && !isRealCalendarDay(Number(isoDay[1]), Number(isoDay[2]), Number(isoDay[3]))) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  // 시간대 표기가 없는 값(08/05/26, 2026-08-05T00:00:00)을 Date 는 실행 기기의 현지 시각으로 읽는다.
  // Actions(UTC)에서는 8월 5일이던 Albemarle JSON-LD "08/05/26" 가 한국 시간 PC에서는 8월 4일 15시가 되어
  // 메타 태그의 8월 5일과 충돌했다. 표기가 없으면 적힌 시각을 UTC 로 읽는다. 날짜만 있는 ISO 값은
  // Date 가 이미 UTC 로 읽으므로 그대로 둔다. RSS 의 "16:00:00 EST" 같은 미국 시간대 약어도 Date 가
  // 제대로 읽는 시간대 표기다. 표기가 있으면 게시처 현지 시각을 오프셋과 함께 남긴다(formatWithOffset).
  const offset = /^\d{4}-\d{2}-\d{2}$/.test(text) ? 0 : zoneOffsetMinutes(text);
  if (offset !== null) return formatWithOffset(parsed.getTime(), offset);
  const utc = new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(),
    parsed.getHours(), parsed.getMinutes(), parsed.getSeconds()));
  return utc.toISOString().replace(/\.\d{3}Z$/, "Z");
}

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function monthNumberFromName(name) {
  const key = String(name || "").toLowerCase().replace(/\.$/, "");
  const index = MONTH_NAMES.findIndex((month) => month === key || (key.length >= 3 && month.startsWith(key)));
  return index === -1 ? 0 : index + 1;
}

const MONTH_NAME_PATTERN = "January|February|March|April|May|June|July|August|September|October|November|December|Jan\\.?|Feb\\.?|Mar\\.?|Apr\\.?|Jun\\.?|Jul\\.?|Aug\\.?|Sept?\\.?|Oct\\.?|Nov\\.?|Dec\\.?";
const MONTH_DAY_YEAR = new RegExp(`\\b(${MONTH_NAME_PATTERN})\\s+([0-3]?\\d),?\\s+((?:19|20)\\d{2})\\b`, "i");
const DAY_MONTH_YEAR = new RegExp(`\\b([0-3]?\\d)\\s+(${MONTH_NAME_PATTERN})\\s+((?:19|20)\\d{2})\\b`, "i");

function isoMonth(year, month) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

// Archived corporate newsrooms can expose releases from the 1990s alongside
// current items. Treat those explicit dates as dates so period filtering can
// reject them; leaving them "unknown" sends clearly historical documents to
// the review queue and wastes scarce semantic review capacity.
const SUPPORTED_YEAR_PATTERN = "(?:19|20)\\d{2}";

// "2026-08"이나 "August 2026"처럼 일자가 없는 값. Date는 이런 값을 그 달 1일로 읽어버리므로
// 게시일로 쓰기 전에 걸러내고 월 단위 근거로만 남긴다.
function parseMonthOnly(value) {
  const text = cleanText(String(value ?? ""));
  if (!text) return "";
  const iso = text.match(/^((?:19|20)\d{2})[-/](0?[1-9]|1[0-2])$/);
  if (iso) return isoMonth(iso[1], iso[2]);
  const korean = text.match(/^((?:19|20)\d{2})\s*년\s*(0?[1-9]|1[0-2])\s*월$/);
  if (korean) return isoMonth(korean[1], korean[2]);
  const japanese = text.match(/^((?:19|20)\d{2})\s*年\s*(0?[1-9]|1[0-2])\s*月$/);
  if (japanese) return isoMonth(japanese[1], japanese[2]);
  const named = text.match(new RegExp(`^(${MONTH_NAME_PATTERN}),?\\s+(${SUPPORTED_YEAR_PATTERN})$`, "i"));
  const namedNumber = named ? monthNumberFromName(named[1]) : 0;
  return namedNumber ? isoMonth(named[2], namedNumber) : "";
}

// 일자까지 적히지 않은 본문 표기. 게시월 근거로만 쓰고 임의로 1일을 채우지 않는다.
// 판정 단계의 날짜 검증(local_report.mjs)도 이 파서를 그대로 쓴다. 단계마다 날짜 문법이
// 다르면 수집에서 못 읽은 날짜를 판정에서 받아들이는 일이 생긴다.
export function extractMonthFromText(value = "") {
  const text = cleanText(String(value ?? ""));
  const korean = text.match(/((?:19|20)\d{2})\s*년\s*(0?[1-9]|1[0-2])\s*월/);
  if (korean) return isoMonth(korean[1], korean[2]);
  const japanese = text.match(/((?:19|20)\d{2})\s*年\s*(0?[1-9]|1[0-2])\s*月/);
  if (japanese) return isoMonth(japanese[1], japanese[2]);
  const named = text.match(new RegExp(`\\b(${MONTH_NAME_PATTERN}),?\\s+(${SUPPORTED_YEAR_PATTERN})\\b`, "i"));
  const namedNumber = named ? monthNumberFromName(named[1]) : 0;
  return namedNumber ? isoMonth(named[2], namedNumber) : "";
}

// 날짜로 확신할 수 있을 때만 받는다. parseDate 는 해석에 실패하면 null 이다. 예전에는 입력 문자열을 그대로
// 돌려줘서, 없는 날짜 "2026-02-31T10:00:00Z" 가 ISO 모양이라는 이유로 날짜로 통과했다.
function parseStrictDate(value) {
  // Date는 "2026"을 1월 1일로 읽는다. 연도만 적힌 값은 게시일 근거가 아니다.
  if (/^\s*(?:19|20)\d{2}\s*$/.test(String(value || "")) || parseMonthOnly(value)) return null;
  const parsed = parseDate(value);
  return parsed && /^\d{4}-\d{2}-\d{2}T/.test(parsed) ? parsed : null;
}

// 근거 하나를 {날짜, 정밀도, 출처, 종류}로 만든다. 종류를 남겨야 게시일과 수정일·사건일이 섞이지 않는다.
export function dateEvidence(value, source, kind = "published") {
  const date = parseStrictDate(value);
  if (date) return { date, month: date.slice(0, 7), source, kind, precision: "day" };
  const month = parseMonthOnly(value);
  return month ? { date: null, month, source, kind, precision: "month" } : null;
}

function isoDate(year, month, day) {
  return parseStrictDate(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
}

export function extractDateFromText(value = "") {
  const text = cleanText(value);
  const korean = text.match(/((?:19|20)\d{2})\s*년\s*(0?[1-9]|1[0-2])\s*월\s*(0?[1-9]|[12]\d|3[01])\s*일/);
  if (korean) {
    return isoDate(korean[1], korean[2], korean[3]);
  }
  const japanese = text.match(/((?:19|20)\d{2})\s*年\s*(0?[1-9]|1[0-2])\s*月\s*(0?[1-9]|[12]\d|3[01])\s*日/);
  if (japanese) {
    return isoDate(japanese[1], japanese[2], japanese[3]);
  }
  const numeric = text.match(/\b((?:19|20)\d{2})[./-](0?[1-9]|1[0-2])[./-](0?[1-9]|[12]\d|3[01])\b/);
  if (numeric) {
    return isoDate(numeric[1], numeric[2], numeric[3]);
  }
  // 유럽식 점 표기(31.12.2026). 앞자리가 12를 넘으면 일-월 순서가 확정된다.
  const dayFirst = text.match(/\b(0?[1-9]|[12]\d|3[01])\.(0?[1-9]|1[0-2])\.((?:19|20)\d{2})\b/);
  if (dayFirst) {
    return isoDate(dayFirst[3], dayFirst[2], dayFirst[1]);
  }
  // 유럽식 하이픈 표기(1-04-2026, 23-09-2025). 연도가 앞인 ISO 표기는 위에서 이미 읽었고, 미국은
  // 월-일을 슬래시로 쓰므로 하이픈 일-월-연은 일이 앞이다. 2026-08 Prodrive 목록의 "1-04-2026 |
  // Press release"가 날짜 미상으로 남아 4월 기사가 8월 검토에 들어왔다.
  const dayFirstHyphen = text.match(/\b(0?[1-9]|[12]\d|3[01])-(0?[1-9]|1[0-2])-((?:19|20)\d{2})\b/);
  if (dayFirstHyphen) {
    return isoDate(dayFirstHyphen[3], dayFirstHyphen[2], dayFirstHyphen[1]);
  }
  // 미국식 슬래시 표기(12/31/2026).
  const monthFirst = text.match(/\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/((?:19|20)\d{2})\b/);
  if (monthFirst) {
    return isoDate(monthFirst[3], monthFirst[1], monthFirst[2]);
  }
  const monthName = text.match(MONTH_DAY_YEAR);
  if (monthName) {
    // 월 이름 표기를 Date에 그대로 넘기면 현지 시간대로 읽혀 하루가 밀린다.
    return isoDate(monthName[3], monthNumberFromName(monthName[1]), monthName[2]);
  }
  const dayMonth = text.match(DAY_MONTH_YEAR);
  if (dayMonth) {
    return isoDate(dayMonth[3], monthNumberFromName(dayMonth[2]), dayMonth[1]);
  }
  return null;
}

// 문서 파일(8-k-12-31-2017-....pdf)처럼 본문을 열 수 없는 링크는 URL이 유일한 날짜 단서다.
function extractDateFromUrl(url) {
  let text = String(url || "");
  try {
    text = decodeURIComponent(text);
  } catch {
    // 잘못 인코딩된 URL은 원문 그대로 본다.
  }
  const ymd = text.match(/(?:^|\D)((?:19|20)\d{2})[/_-](0?[1-9]|1[0-2])[/_-](0?[1-9]|[12]\d|3[01])(?:\D|$)/);
  if (ymd) return isoDate(ymd[1], ymd[2], ymd[3]);
  const mdy = text.match(/(?:^|\D)(0?[1-9]|1[0-2])[/_-](0?[1-9]|[12]\d|3[01])[/_-]((?:19|20)\d{2})(?:\D|$)/);
  if (mdy) return isoDate(mdy[3], mdy[1], mdy[2]);
  const compact = text.match(/(?:^|\D)((?:19|20)\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:\D|$)/);
  if (compact) return isoDate(compact[1], compact[2], compact[3]);
  return null;
}

function extractAttribute(attrs = "", name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = attrs.match(new RegExp(`\\b${escaped}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match ? decodeXml(match[1]).trim() : "";
}

function extractMetaContent(html, names) {
  const metaRegex = /<meta\b([^>]*)>/gi;
  for (const match of html.matchAll(metaRegex)) {
    const attrs = match[1] || "";
    const name = extractAttribute(attrs, "name") || extractAttribute(attrs, "property") || extractAttribute(attrs, "itemprop");
    if (!names.some((candidate) => candidate.toLowerCase() === name.toLowerCase())) continue;
    const content = extractAttribute(attrs, "content");
    if (content) return cleanText(content);
  }
  return "";
}

function extractTagText(html, tag) {
  const match = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? cleanHtmlText(match[1]) : "";
}

// 게시일과 수정일을 다른 목록으로 읽는다. 7월 기사에 붙은 8월 수정일을 8월 신규 기사로 잡지 않으려면
// 두 값이 같은 필드로 합쳐지기 전에 갈라놓아야 한다.
const PUBLISHED_META_NAMES = [
  "article:published_time",
  "og:published_time",
  "datePublished",
  "date",
  "dc.date",
  "dc.date.issued",
  "dcterms.date",
  "dcterms.created",
  "publishdate",
  "pubdate",
  "publish-date",
  "published-date",
  "release_date",
  "parsely-pub-date",
  "sailthru.date",
  "cXenseParse:recs:publishtime",
];

const MODIFIED_META_NAMES = [
  "article:modified_time",
  "og:updated_time",
  "dateModified",
  "dcterms.modified",
  "lastmod",
];

// <time datetime="2026-08-14">는 요즘 가장 흔한 게시일 마크업인데 메타 태그 스캔으로는 잡히지 않는다.
function extractDatesFromTimeTags(html) {
  const evidence = [];
  for (const match of html.matchAll(/<time\b([^>]*)>([\s\S]*?)<\/time>/gi)) {
    const attrs = match[1] || "";
    const property = extractAttribute(attrs, 'itemprop');
    if (/startDate|endDate/i.test(property)) continue;
    const modified = /dateModified/i.test(property) || /modified|updated/i.test(`${extractAttribute(attrs, 'class')} ${extractAttribute(attrs, 'id')}`);
    const parsed = extractAttribute(attrs, "datetime") || match[2];
    const source = modified ? 'modified_time_tag' : 'time_tag';
    const kind = modified ? 'modified' : 'published';
    const item = dateEvidence(parsed, source, kind) || dateEvidence(extractDateFromText(match[2]), source, kind);
    if (item) evidence.push(item);
  }
  for (const match of html.matchAll(/<time\b([^>]*)\/>/gi)) {
    evidence.push(...extractDatesFromTimeTags(`<time ${match[1]}></time>`));
  }
  return evidence;
}

// <span itemprop="datePublished" content="...">처럼 meta 태그가 아닌 곳에 실린 값.
function extractDateFromItemprop(html) {
  for (const match of html.matchAll(/<[^>]*\bitemprop\s*=\s*["'](?:datePublished|dateCreated)["']([^>]*)>/gi)) {
    const attrs = match[1] || "";
    for (const value of [extractAttribute(attrs, "content"), extractAttribute(attrs, "datetime")]) {
      if (dateEvidence(value, "itemprop")) return value;
    }
  }
  return null;
}

// 찾은 근거를 하나로 줄이지 않고 모두 돌려준다. 어느 하나를 고르는 판단과 근거끼리
// 어긋나는지 보는 판단이 chooseDateEvidence 한 곳에서 이뤄져야 하기 때문이다.
export function collectHtmlDateEvidence(html, url = "") {
  const jsonLdPublished = html.match(/"datePublished"\s*:\s*"([^"]+)"/i);
  const jsonLdModified = html.match(/"dateModified"\s*:\s*"([^"]+)"/i);
  // CMS가 페이지에 심어 둔 수정 시각. maxon 뉴스룸은 목록에도 기사에도 날짜를 한 줄도 보여 주지
  // 않아 게시일 근거가 전혀 없었고, 2025-07 기사 여덟 건이 미상으로 들어와 2026-08 보고서 후보까지
  // 올라왔다. 수정 시각은 게시일 이후이므로, 그것이 보고 기간보다 앞서면 게시일도 기간 밖이다.
  // 게시 근거가 아니라 수정 근거이므로 추정 등급이고, 이 값만으로 본문에 실리지는 않는다.
  const cmsModified = html.match(/"(?:modificationDate|lastModified)"\s*:\s*"([^"]+)"/i);
  const headText = cleanHtmlText(html.slice(0, 5000));
  return [
    dateEvidence(extractMetaContent(html, PUBLISHED_META_NAMES), "meta", "published"),
    dateEvidence(jsonLdPublished?.[1], "jsonld", "published"),
    ...extractDatesFromTimeTags(html),
    dateEvidence(extractDateFromItemprop(html), "itemprop", "published"),
    dateEvidence(extractMetaContent(html, MODIFIED_META_NAMES), "modified_meta", "modified"),
    dateEvidence(jsonLdModified?.[1], "modified_jsonld", "modified"),
    dateEvidence(stripTimeZoneName(cmsModified?.[1]), "modified_cms", "modified"),
    dateEvidence(extractDateFromText(headText) || extractMonthFromText(headText), "text", "context"),
    dateEvidence(extractDateFromUrl(url), "url", "context"),
  ].filter(Boolean);
}

// 목록 페이지의 앵커에서 날짜를 찾는다. 목록 날짜는 기사 항목에 붙은 게시일이고 URL 날짜는 정황이다.
function collectListingDateEvidence(anchor) {
  const text = `${anchor.title} ${anchor.context}`;
  return [
    dateEvidence(extractDateFromText(text) || extractMonthFromText(text), "listing", "published"),
    dateEvidence(extractDateFromUrl(anchor.url), "url", "context"),
  ].filter(Boolean);
}

function extractPageTitle(html) {
  return (
    extractMetaContent(html, ["og:title", "twitter:title"]) ||
    extractTagText(html, "h1") ||
    extractTagText(html, "title")
  ).replace(/\s+\|.*$/, "").trim();
}

// article/main 은 중첩된다. 여는 태그를 첫 닫는 태그까지만 읽으면 안쪽 조각이 바깥
// 범위를 끝내 버린다. Infineon 의 보도자료가 그렇다: 페이지 전체가 하나의 <article>
// 이고, 제목 바로 뒤에 이미지용 <article> 이 열렸다 닫히며, 기사 본문은 그 뒤에 있다.
// 그래서 첫 닫는 태그까지만 읽으면 앞의 제품 메뉴만 남는다. 깊이를 세어 바깥 조각을 읽는다.
function scopeFragments(html, tag) {
  const fragments = [];
  let depth = 0;
  let start = 0;
  for (const match of html.matchAll(new RegExp(`<${tag}\\b[^>]*>|</${tag}\\s*>`, 'gi'))) {
    if (match[0][1] !== '/') {
      if (depth === 0) start = match.index + match[0].length;
      depth += 1;
    } else if (depth > 0) {
      depth -= 1;
      if (depth === 0) fragments.push(html.slice(start, match.index));
    }
  }
  return fragments;
}

export function extractArticleText(html) {
  // An article tag can be a download card or company boilerplate. Advance to
  // main/body when it cannot supply both the headline and substantive text.
  // 주석은 먼저 지운다. 주석 처리된 <article> 이 남으면 깊이 계산이 어긋난다.
  const scoped = stripComments(html).replace(/<(nav|aside|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const normalize = text => cleanHtmlText(text).normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const headline = normalize(extractPageTitle(scoped));
  // og:title 은 잘려 오는 일이 잦아("... support successful | Infineon Technologies")
  // 실제 제목 heading 이 headline 보다 길 수 있다. 접두 일치까지 같은 제목으로 본다.
  const carriesHeadline = text => Boolean(headline) &&
    (text === headline || text.startsWith(`${headline} `));
  // 제품 메가메뉴는 <nav> 가 아니라 평범한 div/ul 로 되어 있어 위에서 걸러지지 않고,
  // 페이지 전체를 감싼 <article> 안에 기사보다 앞서 들어온다. 모든 범위에서 제목
  // heading 부터 자른다. 그래야 뒤에 붙는 글자 수 제한이 메뉴가 아니라 기사에 걸린다.
  // Only trim at a matching heading, never at a menu link or meta title.
  const fromHeadline = fragment => {
    const heading = [...fragment.matchAll(/<h[1-2]\b[^>]*>[\s\S]*?<\/h[1-2]>/gi)]
      .find(item => carriesHeadline(normalize(item[0])));
    return heading ? fragment.slice(heading.index) : fragment;
  };
  const levels = [];
  for (const [index, tag] of ['article', 'main', 'body'].entries()) {
    const candidates = scopeFragments(scoped, tag).map(fragment => {
      // Preserve headlines wrapped in an article/main header. At body scope,
      // retain the existing removal of site-wide headers.
      return cleanHtmlText(fromHeadline(
        index < 2 ? fragment.replace(/<\/?header\b[^>]*>/gi, '') : fragment));
    }).filter(Boolean).sort((a, b) => b.length - a.length);
    levels.push(candidates);
    const substantive = candidates.find(text => text.length >= 300 &&
      (!headline || normalize(text).includes(headline)));
    if (substantive) return substantive;
  }
  // A genuine short notice must survive when no larger usable scope exists.
  for (const candidates of levels) {
    const matching = candidates.find(text => headline && normalize(text).includes(headline));
    if (matching) return matching;
  }
  return levels.find(candidates => candidates.length)?.[0] || cleanHtmlText(scoped);
}

function contentExcerpt(text = "", limit = 800) {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit).trim()}...` : compact;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeDateInput(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error(`Invalid date input: ${text}. Expected YYYY-MM-DD.`);
  }
  return text;
}

function buildDateRange(args, collectedAt) {
  const fromDate = normalizeDateInput(args.fromDate);
  const toDate = normalizeDateInput(args.toDate);
  const collectedMs = Date.parse(collectedAt);

  if (fromDate || toDate) {
    if (!fromDate || !toDate) {
      throw new Error("Both --from-date and --to-date are required when using an explicit date range.");
    }
    const fromMs = Date.parse(`${fromDate}T00:00:00Z`);
    const toMs = Date.parse(`${toDate}T23:59:59Z`);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs > toMs) {
      throw new Error(`Invalid date range: ${fromDate} to ${toDate}`);
    }
    return {
      mode: "explicit",
      fromDate,
      toDate,
      from_date: fromDate,
      to_date: toDate,
      fromMs,
      toMs,
      lookbackDays: Math.max(1, Math.ceil(Math.max(0, collectedMs - fromMs) / DAY_MS) + 2),
    };
  }

  const days = Number.isFinite(args.days) && args.days > 0 ? args.days : 45;
  return {
    mode: "lookback",
    fromDate: "",
    toDate: "",
    from_date: new Date(collectedMs - days * DAY_MS).toISOString().slice(0, 10),
    to_date: new Date(collectedMs + DAY_MS).toISOString().slice(0, 10),
    fromMs: collectedMs - days * DAY_MS,
    toMs: collectedMs + DAY_MS,
    lookbackDays: days,
  };
}

// 수집 단계는 periodPlacement 가 out_of_period 로 본 기사만 버린다(filterByDateRange). 확인된 게시일이 기간 밖인
// 기사, 충돌한 근거가 모두 기간 밖인 기사, 그리고 확정 날짜가 없어도 제목·URL 의 발행 연도로 기간 밖이 분명한
// 정기 문서·옛 문서가 여기에 든다(date_state.mjs). 그 밖의 날짜 미상·추정·충돌 기사는 그대로 보관해
// 이후 단계에서 날짜를 보강하거나 검토 후보로 쓸 수 있게 한다.
function dateRangePeriod(dateRange) {
  return {
    from_date: dateRange.from_date || new Date(dateRange.fromMs).toISOString().slice(0, 10),
    to_date: dateRange.to_date || new Date(dateRange.toMs).toISOString().slice(0, 10),
  };
}

function filterByDateRange(rows, dateRange) {
  const period = dateRangePeriod(dateRange);
  return rows.filter((row) => periodPlacement(row, period).placement !== "out_of_period");
}

// 브라우저가 실제로 보내는 헤더 묶음. Referer가 없다는 이유만으로 403을 주는 사이트가 많다.
function requestHeaders(url) {
  const headers = {
    "User-Agent": USER_AGENT,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,application/rss+xml,application/atom+xml,application/json;q=0.8,*/*;q=0.7",
    "Accept-Language": "en-US,en;q=0.9,ko;q=0.7",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
  };
  try {
    // Referer를 보내면 Sec-Fetch-Site도 그에 맞춰야 한다. 둘이 어긋나면 오히려 봇으로 걸린다.
    headers.Referer = `${new URL(url).origin}/`;
    headers["Sec-Fetch-Site"] = "same-origin";
  } catch {
    // 상대 경로나 깨진 URL이면 Referer 없이 보낸다.
  }
  // SEC 는 연락처가 든 User-Agent 를 요구한다(공정 접근 정책). 설정했을 때만 sec.gov 요청에 쓴다.
  try {
    if (process.env.SEC_USER_AGENT && /(^|\.)sec\.gov$/i.test(new URL(url).hostname)) {
      headers["User-Agent"] = process.env.SEC_USER_AGENT.trim();
    }
  } catch {
    // URL 이 깨졌으면 기본 헤더를 쓴다.
  }
  return headers;
}

// 본문과 함께 리디렉트를 다 따라간 뒤의 최종 주소를 돌려준다. 목록 페이지의 상대 링크는 이 주소를 기준으로 풀어야 한다.
async function fetchPageOnce(url, timeoutSeconds) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: requestHeaders(url),
    });
    if (!response.ok) throw httpError(response);
    return { text: await response.text(), url: pageBaseUrl(url, response.url) };
  } finally {
    clearTimeout(timeout);
  }
}

// 페이지 안의 상대 링크를 풀 기준 주소. 브라우저처럼 리디렉트 뒤 실제로 받은 주소를 쓴다.
// 예전에는 설정에 적힌 주소를 기준으로 풀었다. 2026-09 수집에서 www.asml.com/en/news 가
// investor.asml.com/news(Q4 IR 플랫폼)로 넘어가자, 그 페이지의 "/news-releases/news-release-details/..."
// 링크가 www.asml.com 위로 붙어 ASML 공식 기사 10건이 모두 404 였다.
// 응답에 주소가 없으면(직접 만든 Response 등) 요청한 주소를 그대로 쓴다.
export function pageBaseUrl(requestedUrl, responseUrl) {
  return isHttpUrl(responseUrl) ? String(responseUrl) : requestedUrl;
}

function httpError(response) {
  const error = new Error(`HTTP ${response.status} ${response.statusText || ""}`.trim());
  error.status = response.status;
  error.retryAfterSeconds = Number.parseInt(response.headers.get("retry-after") || "", 10) || 0;
  return error;
}

// Retry-After 는 초 수이거나 HTTP 날짜다. 읽을 수 없으면 0(지정 없음)이다.
export function parseRetryAfter(value, nowMs = Date.now()) {
  const text = String(value ?? '').trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) return Number(text);
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - nowMs) / 1000)) : 0;
}

function isRetryableFetchError(error) {
  if (error.noRetry) return false;
  // 상태 코드가 없으면 네트워크 오류나 타임아웃이므로 재시도한다.
  return error.status === undefined ? true : RETRYABLE_STATUS.has(error.status);
}

// 요청 한 번(attempt)에 일시 오류 재시도와 domainGuard 를 씌운다. 목록·피드 요청(fetchText)과 상세 페이지·문서
// 받기(fetchPublisherDocument)가 같은 규칙을 쓴다. 예전에는 공식 .pdf 링크와 대체 출처 다운로드가 이 둘을 거치지 않았다.
async function fetchWithRetries(url, attempt) {
  let lastError;
  for (let tried = 0; tried <= fetchRetries; tried += 1) {
    if (tried > 0) {
      retryCount += 1;
      // 서버가 Retry-After로 대기 시간을 지정했으면 그 값을 따른다.
      const backoffMs = 700 * 2 ** (tried - 1) + Math.floor(Math.random() * 400);
      const retryAfterMs = (lastError?.retryAfterSeconds || 0) * 1000;
      await sleep(Math.min(Math.max(backoffMs, retryAfterMs), 30000));
    }
    try {
      return await domainGuard.run(url, attempt);
    } catch (error) {
      lastError = error;
      if (!isRetryableFetchError(error)) throw error;
    }
  }
  throw lastError;
}

export async function fetchPage(url, timeoutSeconds) {
  return fetchWithRetries(url, () => fetchPageOnce(url, timeoutSeconds));
}

export async function fetchText(url, timeoutSeconds) {
  return (await fetchPage(url, timeoutSeconds)).text;
}

async function fetchJson(url, timeoutSeconds) {
  return JSON.parse(await fetchText(url, timeoutSeconds));
}

function relevantAliases(company) {
  // 동명 기업이 있는 경우 검색에는 명시된 정식명만 쓴다. 표시명은 유지한다.
  if (company.search_names?.length) return [...new Set(company.search_names)];
  const names = [company.company];
  // 일반어와 겹치는 짧은 별칭은 검색어로 쓰지 않는다. Norsk Hydro 의 "Hydro", Evonik Industries 의 "Evonik" 이
  // 여기 걸린다(이 두 기업에는 search_names 가 없다). "maxon" 은 지금 별칭이 "maxon group" 이라 걸리지 않는다.
  for (const alias of company.query_aliases || []) {
    const key = alias.toLowerCase();
    if (alias.length >= 5 && !["hydro", "maxon", "evonik"].includes(key)) {
      names.push(alias);
    }
  }
  return [...new Map(names.map((name) => [name.toLowerCase(), name])).values()].slice(0, 3);
}

// 대체 수집 질의도 사업동향 질의처럼 기간으로 검색 창을 정한다(trendSearchWindow). when:Nd 는 요청 시점에서
// N일 전이라, 마감 한참 뒤에 돌리면 기간 밖 새 기사가 maxPerSource 자리를 채우고 그 달 기사가 밀려난다.
export function buildQuery(company, dateRange) {
  const names = relevantAliases(company);
  let nameClause = names.map((name) => `"${name}"`).join(" OR ");
  if (names.length > 1) nameClause = `(${nameClause})`;
  return `${nameClause} (${SIGNAL_TERMS.join(" OR ")}) ${trendSearchWindow(dateRange)}`;
}

// 한국 관련 검색. 대체 수집 질의는 "press release"·"earnings" 같은 신호 낱말로 찾아서, 한국 투자 기사가 검색 결과
// 뒷순위로 밀린다. 9월 Amkor 의 광주 공장 증설 검토(Herald 영문판 9/20)가 대체 질의로는 32건 중 22번째라
// 6건 상한에 잘렸고, 이 질의로는 2번째였다. 영문판 한국 매체도 같은 Google News(영어) 색인에 있다.
const KOREA_TERMS = ["Korea", "Korean"];

export function buildKoreaQuery(company, dateRange) {
  const names = relevantAliases(company);
  let nameClause = names.map((name) => `"${name}"`).join(" OR ");
  if (names.length > 1) nameClause = `(${nameClause})`;
  return `${nameClause} (${KOREA_TERMS.join(" OR ")}) ${trendSearchWindow(dateRange)}`;
}

// 주가 해설. 외부 기사를 늘리면 시세·목표주가·지분 변동 기사가 먼저 자리를 채운다. 9월 수집의 외부 기사에서
// 이런 기사는 한 건도 승인되지 않았다. 판정 전에 빼서 자리와 판정 요청을 아낀다.
// 매체는 주가 해설만 싣는 곳만 적는다. Yahoo Finance·TradingView·Investing.com 은 보도자료와 사업 기사도 실어
// (9월에 Yahoo Finance 2건 승인) 매체로 막지 않고 제목으로만 본다. 제목은 종목 기호와 주가 낱말이 함께 있을 때만
// 뺀다. "Aeluma Shares Rise 7% After Sumitomo ... Agreement" 처럼 종목 기호 없는 사업 기사는 남는다.
const STOCK_COMMENTARY_PUBLISHERS = /\b(?:marketbeat|simply wall st(?:reet)?|gurufocus|zacks|insider monkey|ad-hoc-news|defense world|etf daily news|stocktitan|kalkine)\b/i;
const TITLE_TICKER = /\((?:[A-Z]{2,8}:)?\$?[A-Z]{2,6}(?:\.[A-Z]{1,2})?\)|\$[A-Z]{2,5}\b|\b(?:NYSE|NASDAQ|Nasdaq)\s*:\s*[A-Z]{1,5}\b/;
const TITLE_STOCK_WORDS = /\b(?:stocks?|shares?|investors?|buy|sell|hold|price target|valuation|undervalued|overvalued|pricey|dividends?|outperform|underperform|analysts?|rating|rall(?:y|ies|ied)|bull(?:ish)?|bear(?:ish)?|momentum|roundup|plunges?|surges?|soars?|jumps?|tumbles?|gains?|up \d|down \d|since last earnings)\b/i;

export function stockCommentary(row) {
  if (STOCK_COMMENTARY_PUBLISHERS.test(`${row.publisher || ""} ${row.source || ""}`)) return true;
  // 매체 이름("- Yahoo Finance")은 떼고 본다.
  const title = String(row.title || "").replace(/\s+-\s+[^-]+$/, "");
  if (!TITLE_TICKER.test(title)) return false;
  // 종목 기호를 단 의문문 제목("Is Amkor Technology (AMKR) Arizona Expansion A Turning Point ...?")은 주가 해설 매체의
  // 서식이다. 같은 사건의 보도 기사는 따로 잡힌다.
  return TITLE_STOCK_WORDS.test(title) || /\?\s*$/.test(title);
}

// 제목에 기업 이름이 있는지. 한국 관련 검색은 이름이 본문에만 있는 기사까지 돌려준다. 이름이 흔한 낱말인 기업
// (Maxon·Dupont·DOW)은 9월에 부고·정치 기사가 들어왔다. 제목에 이름이 없으면 그 기업 기사로 보지 않는다.
export function titleNamesCompany(title, names) {
  const text = String(title || "");
  return names.some((name) => {
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(text);
  });
}

export function parseRssOrAtom(xml, company, collectedAt, collector, query, defaultSource, feedKind = "") {
  const rows = [];
  const isOfficialCollector = collector.startsWith("official_");
  const sourceFieldsFor = (itemUrl) =>
    isOfficialCollector
      ? officialSourceFields(feedKind, defaultSource, query, itemUrl)
      : fallbackSourceFields(90);
  // 공식 피드 항목의 요약. 상세 페이지를 못 받았을 때 본문 대신 쓴다(fetchDetailOutcome). 예전에는 읽지 않아서
  // 2026-09 수집의 Syensqo 5건처럼 피드는 받았는데 원문이 막힌 기사가 제목만 남아 규칙으로 버려졌다.
  // Google News 의 description 은 관련 기사 링크 목록이라 본문이 아니다. 공식 수집기에만 싣는다.
  // 결과 행에는 남지 않는다(enrichOfficialRowsWithContent 가 떼어 낸다).
  const summaryFieldsFor = (block) => {
    if (!isOfficialCollector) return {};
    const summary = feedItemSummary(block);
    return summary ? { feed_summary: summary } : {};
  };
  for (const item of blocks(xml, "item")) {
    const sourceText = tagText(item, "source");
    // 링크가 없는 항목은 기사 주소가 없는 것이다. 예전에는 질의(피드 주소나 검색어 문자열)를 주소로 채웠다.
    // 주소가 빈 행은 아래에서 걸러진다.
    const itemUrl = bestRssItemUrl(item);
    rows.push({
      target_no: company.target_no,
      company: company.company,
      title: tagText(item, "title"),
      url: itemUrl,
      source: sourceText ? `${defaultSource}: ${sourceText}` : defaultSource,
      // Google News 의 기사 링크는 본문을 자바스크립트로 받아오는 중계 페이지라 수집기가
      // 원문 주소를 얻지 못한다. 반면 <source url> 은 발행사 홈페이지를 그대로 준다.
      // 이 속성을 버리고 표시 이름만 남기던 탓에, 본문을 못 받은 기사의 후속 확인 목록에
      // "Dealroom" 같은 이름만 남고 어디로 가야 하는지는 남지 않았다.
      ...publisherFields(sourceText, tagAttribute(item, "source", "url")),
      ...chooseDateEvidence([
        dateEvidence(tagText(item, "pubDate"), "feed", "published"),
        dateEvidence(extractDateFromUrl(itemUrl), "url", "context"),
      ]),
      collected_at: collectedAt,
      collector,
      query,
      ...sourceFieldsFor(itemUrl),
      official_source_url: isOfficialCollector ? query : "",
      source_direct_url: directUrlCandidate(itemUrl),
      ...summaryFieldsFor(item),
    });
  }
  for (const entry of blocks(xml, "entry")) {
    const entryUrl = bestAtomEntryUrl(entry);
    rows.push({
      target_no: company.target_no,
      company: company.company,
      title: tagText(entry, "title"),
      url: entryUrl,
      source: defaultSource,
      ...chooseDateEvidence([
        dateEvidence(tagText(entry, "published"), "feed", "published"),
        dateEvidence(tagText(entry, "updated"), "modified_meta", "modified"),
        dateEvidence(extractDateFromUrl(entryUrl), "url", "context"),
      ]),
      collected_at: collectedAt,
      collector,
      query,
      ...sourceFieldsFor(entryUrl),
      official_source_url: isOfficialCollector ? query : "",
      source_direct_url: directUrlCandidate(entryUrl),
      ...summaryFieldsFor(entry),
    });
  }
  return rows.filter((row) => row.title && row.url);
}

// 목록 항목의 게시일은 제목 링크 바로 앞에 붙는데, 그 사이에 툴팁 속성이 잔뜩 든 마크업이
// 끼면 고정폭 창이 날짜를 밀어낸다. Boeing 보도자료 목록의 <div class="wd_date">Aug 10, 2026</div>
// 가 그래서 사라지고 URL 날짜만 남아 "게시일 추정"으로 보류됐다. 창을 항목 안에서만 넓힌다.
// 항목 경계를 넘지 않으므로 앞 기사의 날짜를 이 기사 것으로 읽을 일은 없다.
const ITEM_BOUNDARY = /<\/?(?:li|article|tr)\b[^>]*>/gi;
const ANCHOR_CONTEXT_CHARS = 260;
const ANCHOR_ITEM_CHARS = 2000;

function itemContextStart(html, index) {
  const from = Math.max(0, index - ANCHOR_ITEM_CHARS);
  const before = html.slice(from, index);
  let boundary = -1;
  for (const match of before.matchAll(ITEM_BOUNDARY)) boundary = match.index + match[0].length;
  return boundary === -1 ? Math.max(0, index - ANCHOR_CONTEXT_CHARS) : from + boundary;
}

export function parseAnchors(html, baseUrl) {
  const anchors = [];
  const anchorRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorRegex)) {
    const attrs = match[1] || "";
    const hrefMatch = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    const href = decodeXml(hrefMatch[1]).trim();
    if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) continue;
    if (/[{}]/.test(href) || /%7b|%7d/i.test(href)) continue;
    try {
      anchors.push({
        url: stripTracking(new URL(href, baseUrl).toString()),
        title: cleanText(match[2]),
        context: cleanText(
          html.slice(itemContextStart(html, match.index),
            Math.min(html.length, match.index + match[0].length + ANCHOR_CONTEXT_CHARS)),
        ),
      });
    } catch {
      continue;
    }
  }
  return anchors;
}

// 기사 제목이 아니라 링크 라벨이나 메뉴 이름인 문자열.
// 보고서 헤드라인으로 쓸 수 없으므로 제목 복구 대상으로 넘긴다.
const GENERIC_TITLE_PATTERN = new RegExp(
  `^(?:${[
    // 링크 문구·사이트 인사말. 문서 이름이 아니라 버튼이나 사이트 전체 제목이다(2026-08:
    // Umicore 연차보고서 PDF가 "English version", Air Liquide 보고서가 "PDF 3.29 MB",
    // Mkango 기사가 사이트 og:title "Welcome to Mkango Resources Ltd."로 수집됨).
    "welcome to\\b.*",
    "(?:english|german|french|japanese|chinese|korean) version",
    "download (?:the )?(?:document|file|pdf|report|presentation|video transcript)",
    "(?:pdf(?:&nbsp;|\\s)*)?[\\d.,]+\\s*[kmg]b(?:\\s*\\(pdf\\))?",
    "read more",
    "see more\\b.*",
    "learn more",
    "find out more",
    "more information",
    "more info",
    "more",
    "details?",
    "view details",
    "view all",
    "show all",
    "see all",
    "all news",
    "load more",
    "download(?:s)?",
    "share price info",
    "news",
    "news ?& ?insights",
    "news ?& ?events",
    "news release(?:s)?",
    "press release(?:s)?",
    "media release(?:s)?",
    "press kit(?:s)?",
    "corporate press kit",
    "press office",
    "press room|pressroom",
    "newsroom|news room",
    "media (?:center|centre|gallery|library|relations)",
    "video (?:center|centre)",
    "social media",
    "featured stories",
    "stories",
    "blog",
    "events",
    "presentation(?:s)?",
    "publication(?:s)?",
    "announcement(?:s)?",
    "sustainability",
    "business ?& ?products",
    "overview",
    "archive(?:s)?",
    "subscribe",
    "contact(?: us)?",
    "rules of disclosure",
    "wind turbine orders",
    "\\(opens in new tab\\)",
    "opens in new tab",
    "are you human",
    "&nbsp;",
  ].join("|")})$`,
  "i",
);

function isGenericOfficialTitle(title) {
  const text = cleanText(title).trim();
  if (!text) return true;
  return GENERIC_TITLE_PATTERN.test(text);
}

// 제목이 회사명 그 자체이면(사이트 <title>이 회사명뿐인 경우) 기사 제목으로 쓸 수 없다.
function isCompanyNameOnlyTitle(title, company) {
  const text = cleanText(title).toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").trim();
  if (!text) return true;
  const names = [company?.company, ...(company?.query_aliases || [])].filter(Boolean);
  return names.some((name) => {
    const normalized = String(name).toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").trim();
    return normalized && text === normalized;
  });
}

// 보고서 헤드라인으로 쓸 수 있는 제목인지. 여기서 걸러진 행은 기사로 인정하지 않는다.
export function isUsableTitle(title, company) {
  const text = cleanText(title).trim();
  if (text.length < 8) return false;
  if (isGenericOfficialTitle(text)) return false;
  if (isCompanyNameOnlyTitle(text, company)) return false;
  return true;
}

// 확장자 목록은 여기 한 곳에 둔다. 웹 문서(PDF 포함)는 받아 읽고, 오피스 문서와 미디어는 받지 않는다(canFetchDetailContent).
const WEB_DOCUMENT_EXTENSIONS = "pdf|html?|aspx|php";
const OFFICE_DOCUMENT_EXTENSIONS = "xlsx?|pptx?|docx?";
const UNREADABLE_FILE = new RegExp(`\\.(${OFFICE_DOCUMENT_EXTENSIONS}|zip|jpg|jpeg|png|gif|svg|webp|mp4|mov)(?:[?#]|$)`, "i");
const PARAM_FILE_EXTENSION = new RegExp(`\\.(${WEB_DOCUMENT_EXTENSIONS}|${OFFICE_DOCUMENT_EXTENSIONS})$`, "i");
// 경로의 파일 이름에서는 웹 문서 확장자만 뗀다. 오피스 확장자까지 떼면 이미 수집된 문서 행의 제목이 바뀐다.
const PATH_FILE_EXTENSION = new RegExp(`\\.(${WEB_DOCUMENT_EXTENSIONS})$`, "i");

function titleFromUrl(url) {
  try {
    const parsed = new URL(url);
    // 문서 링크는 경로가 난수 ID이고 실제 이름이 fileName 같은 쿼리에 담기는 경우가 많다.
    for (const key of ["fileName", "filename", "file", "name"]) {
      const value = parsed.searchParams.get(key);
      if (!value) continue;
      const fromParam = decodeURIComponent(value)
        .replace(PARAM_FILE_EXTENSION, "")
        .replace(/[-_]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (fromParam.length >= 16) return fromParam;
    }
    const segments = parsed.pathname.split("/").filter(Boolean);
    const last = segments.reverse().find((segment) => !/^(default|index|news|press|releases?|details?|en|global|ir)$/i.test(segment));
    if (!last) return "";
    const cleaned = decodeURIComponent(last)
      .replace(PATH_FILE_EXTENSION, "")
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return cleaned.length >= 16 ? cleaned : "";
  } catch {
    return "";
  }
}

function officialTitle(anchor) {
  if (!isGenericOfficialTitle(anchor.title)) return anchor.title;
  return titleFromUrl(anchor.url);
}

// 피드를 가리키는 낱말. 낱말 단위로만 본다. 예전에는 글자 일부로 맞아 "feedback" 링크나 feedback.css 도 피드로 받았다.
const FEED_WORD = /(?<![a-z])(?:rss|atom|feeds?)(?![a-z])/i;

export function discoverFeedLinks(html, baseUrl) {
  const urls = [];
  const linkRegex = /<link\b([^>]*)>/gi;
  for (const match of html.matchAll(linkRegex)) {
    const attrs = match[1] || "";
    const hrefMatch = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    const href = decodeXml(hrefMatch[1]);
    if (!/application\/(?:rss|atom)\+xml/i.test(attrs) && !FEED_WORD.test(href)) continue;
    if (/xmlrpc\.php|rsd/i.test(href)) continue;
    try {
      urls.push(stripTracking(new URL(href, baseUrl).toString()));
    } catch {
      continue;
    }
  }
  for (const anchor of parseAnchors(html, baseUrl)) {
    if (FEED_WORD.test(`${anchor.title} ${anchor.url}`)) {
      urls.push(anchor.url);
    }
  }
  return [...new Set(urls)].slice(0, 3);
}

// 규칙이 링크 텍스트와 날짜를 보려면 이 파일이 쥔 두 함수가 필요하다. 순환 import 대신
// 주입해서, link_policy.mjs 는 순수 함수로 남기고 감사 도구와 테스트가 같은 조합을 쓰게 한다.
const LINK_POLICY_DEPS = {
  officialTitle,
  detectDate: (text) => extractDateFromText(text),
};

// 앵커 하나에 세 규칙을 모두 걸어 결과를 돌려준다. 감사 도구가 쓰는 유일한 입구다.
// effective 는 --link-policy proposed 로 돌렸을 때 수집 경로가 실제로 내리는 처분이다.
// 제안 규칙 단독과 다른데, 프로덕션은 지금 걷던 링크를 절대 버리지 않기 때문이다.
export function judgeLink(anchor, pageUrl) {
  const proposed = classifyOfficialLink(anchor, pageUrl, LINK_POLICY_DEPS);
  return {
    august: augustRule(anchor, pageUrl, LINK_POLICY_DEPS),
    current: currentRule(anchor, pageUrl, LINK_POLICY_DEPS),
    proposed,
    effective: judgeAnchor(anchor, pageUrl, "proposed"),
  };
}

export function classifyLink(anchor, pageUrl) {
  return classifyOfficialLink(anchor, pageUrl, LINK_POLICY_DEPS);
}

function isRelevantOfficialLink(anchor, pageUrl) {
  return currentRule(anchor, pageUrl, LINK_POLICY_DEPS);
}

// 앵커 하나의 처분. current 는 지금 돌고 있는 참/거짓 판정을 세 갈래 모양으로 옮겨 담기만 한다.
// 사유는 현재 기록하는 두 가지 그대로라, 규칙을 바꾸지 않는 한 요약 수치도 그대로다.
export function judgeAnchor(anchor, pageUrl, policy = linkPolicy) {
  if (policy === "proposed") {
    const judged = classifyLink(anchor, pageUrl);
    // 지금 규칙이 받던 링크는 무슨 일이 있어도 계속 받고, 순위도 맨 앞을 준다.
    // 이번 작업은 fetch 전에 잘리는 기사를 되찾는 것이지 걷던 것을 정리하는 것이 아니다.
    // 제안 규칙의 accept 조건은 현재 규칙의 통과 조건을 그대로 담고 있어서 지금은 이 분기가
    // 판정을 뒤집을 일이 없지만, rank 0 을 다는 일은 trimByRank 가 쓰므로 실제로 필요하다.
    // 규칙을 더 손댈 때 이 줄이 회수 전용이라는 약속을 지킨다.
    const alreadyCollected = isRelevantOfficialLink(anchor, pageUrl);
    if (alreadyCollected) return { verdict: "accept", reason: "article_link", rank: 0 };
    if (judged.verdict === "hard_reject") return judged;
    // 새 후보는 기존 기사 뒤에 세운다. maxPerSource 로 잘릴 때 새 후보가 이미 걷던 기사를
    // 밀어내면 그건 회수가 아니라 교체다. 정렬 없이 돌렸을 때 DOW의 보도자료가 같은 페이지의
    // 블로그 링크에 밀려 사라졌다.
    return { ...judged, rank: judged.verdict === "accept" ? 1 : 2 };
  }
  if (isRelevantOfficialLink(anchor, pageUrl)) return { verdict: "accept", reason: "article_link" };
  if (looksLikeSourceIndexUrl(anchor.url)) return { verdict: "hard_reject", reason: "index_or_category_page" };
  if (looksLikeBrokenUrl(anchor.url)) return { verdict: "hard_reject", reason: "broken_url" };
  // 나머지 무관한 링크는 예전처럼 사유를 남기지 않는다.
  return { verdict: "hard_reject", reason: "" };
}

function acceptFirst(row) {
  return row.link_rank ?? 0;
}

// 페이지 링크를 잘라낼 순서. 같은 순위 안에서는 목록에 날짜가 붙은 링크를 앞에 세운다. 날짜 없는
// 링크는 상세 페이지를 열어봐야 쓸 수 있다. 2026-08 Besi 보도자료 페이지에서는 문서 앞쪽의
// 주주총회 보관 링크 6개가 페이지당 상한을 먼저 채워, 날짜 붙은 보도자료가 한 건도 남지 않았다.
// 기간 밖 날짜는 이 정렬 전에 이미 걸러져 있다.
export function orderPageRows(rows) {
  const undated = (row) => (row.published_at || row.published_month ? 0 : 1);
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => acceptFirst(a.row) - acceptFirst(b.row) || correctionLast(a.row) - correctionLast(b.row)
      || undated(a.row) - undated(b.row) || a.index - b.index)
    .map(({ row }) => row);
}

// 정정·수정 공시. 같은 날 여러 건이 한꺼번에 올라와 출처당 상한(maxPerSource)을 먼저 차지한다.
// 2026-09 Nabtesco 피드 맨 위를 9/30 정정·수정보고서 10여 건이 채워, 9/15 정밀 감속기 RV 보도자료가 자리를 받지 못했다.
// 버리지는 않고 같은 출처 안에서 뒤로만 보낸다. 내용은 대개 이미 낸 숫자를 고친 것이라 시그널 근거가 되는 일이 드물다.
const CORRECTION_NOTICE_PATTERN = new RegExp([
  String.raw`^\W*(?:correction|corrected|amendment|amended)\b`,
  String.raw`\bnotice\s+(?:regarding|of)\s+(?:the\s+)?(?:submission|filing)\s+(?:of\s+)?(?:the\s+)?(?:amend|correct)`,
  String.raw`\bpartial\s+(?:correction|amendment)\b`,
  "訂正", "一部変更のお知らせ", "정정",
].join("|"), "i");

function correctionLast(row) {
  return CORRECTION_NOTICE_PATTERN.test(String(row?.title || "")) ? 1 : 0;
}

// 출처 순서는 지키고 정정·수정 공시만 뒤로 보낸다(안정 정렬).
export function correctionsLast(rows) {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => correctionLast(a.row) - correctionLast(b.row) || a.index - b.index)
    .map(({ row }) => row);
}

const PRESS_RELEASE_PATTERN =
  /press[\s_-]*releases?|news[\s_-]*releases?|media[\s_-]*releases?|pressreleases?|newsreleases?|보도\s*자료|press[\s_-]*room|pressemitteilung|communiqu[eé]s?[\s_-]*de[\s_-]*presse|comunicad[oa]s?[\s_-]*de[\s_-]*prensa/i;

function looksLikePressRelease(...hints) {
  return PRESS_RELEASE_PATTERN.test(hints.filter(Boolean).join(" "));
}

// 설정 파일의 kind 값이 없거나 일반적인 경우에도 출처명/URL로 공식 보도자료를 식별한다.
function resolveOfficialKind(kind, ...hints) {
  if (kind === "press_release") return "press_release";
  if (looksLikePressRelease(...hints)) return "press_release";
  return kind || "official_page";
}

function sourceLabelKo(sourceType, sourceKind) {
  if (sourceType !== "official") return "대체출처";
  return sourceKind === "press_release" ? "공식보도자료" : "공식출처";
}

function officialSourcePriority(kind) {
  return {
    press_release: 5,
    newsroom: 12,
    ir: 15,
    filing: 17,
    presentation: 18,
    financial_report: 19,
  }[kind] || 20;
}

function officialSourceFields(kind, ...hints) {
  const sourceKind = resolveOfficialKind(kind, ...hints);
  return {
    source_type: "official",
    source_kind: sourceKind,
    is_press_release: sourceKind === "press_release",
    source_label_ko: sourceLabelKo("official", sourceKind),
    source_priority: officialSourcePriority(sourceKind),
  };
}

// 발행사 이름은 표시용이고 홈페이지 주소는 원문을 찾아갈 출발점이다. 둘을 따로 남긴다.
function publisherFields(name, homeUrl) {
  return { publisher: cleanText(name), publisher_home_url: isHttpUrl(homeUrl) ? stripTracking(homeUrl) : "" };
}

function fallbackSourceFields(priority) {
  return {
    source_type: "fallback",
    source_kind: "news",
    is_press_release: false,
    source_label_ko: sourceLabelKo("fallback", "news"),
    source_priority: priority,
  };
}

function normalizeOfficialPageEntries(entries) {
  return entries
    .map((entry) => {
      if (typeof entry === "string") {
        return { url: entry, source: "Official page", kind: "official_page" };
      }
      return {
        url: entry.url,
        source: entry.source || "Official page",
        kind: entry.kind || "official_page",
        crawlPriority: entry.crawl_priority || "",
        pageTitle: entry.page_title || "",
        sourceTypeLabel: entry.source_type_label || "",
      };
    })
    .filter((entry) => entry.url);
}

// 목록을 자바스크립트로 그리는 뉴스룸은 HTML 에 기사 링크가 없다. magniX 뉴스 페이지는 data/news.json 을
// 받아 그리고, 상세 페이지도 같은 JSON 의 news_description 을 그려서 HTML 로는 본문을 받을 수 없다.
// 그래서 2026-08 수집에서 magniX 는 결과가 0건이었다. 설정의 json 항목이 필드 이름을 정한다:
// items(배열 경로, 점으로 구분), title, url, date(YYYYMMDD 또는 ISO), body(HTML 본문), base(상대 주소의 기준), include.
// 본문이 있으면 여기서 싣는다. 본문이 실린 행은 상세 페이지를 다시 받지 않는다(enrichOfficialRowsWithContent).
export function parseJsonFeed(text, company, collectedAt, query, defaultSource, feedKind, spec = {}, contentCharLimit = 36000) {
  const payload = JSON.parse(text);
  const items = String(spec.items || "").split(".").filter(Boolean).reduce((value, key) => value?.[key], payload);
  const include = spec.include ? new RegExp(spec.include, "i") : null;
  const rows = [];
  for (const item of Array.isArray(items) ? items : []) {
    // 주소가 빈 항목은 건너뛴다. 빈 문자열을 기준 주소로 풀면 피드 주소가 그 기사의 주소가 됐다.
    const rawUrl = String(item?.[spec.url] ?? "").trim();
    if (!rawUrl) continue;
    let url;
    try {
      url = new URL(rawUrl, spec.base || query).href;
    } catch {
      continue;
    }
    if (include && !include.test(url)) continue;
    const rawDate = String(item?.[spec.date] || "").trim();
    const date = /^\d{8}$/.test(rawDate) ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6)}` : rawDate;
    const body = cleanHtmlText(String(item?.[spec.body] || "")).slice(0, contentCharLimit);
    rows.push({
      target_no: company.target_no,
      company: company.company,
      title: cleanText(item?.[spec.title]),
      url,
      source: defaultSource,
      ...chooseDateEvidence([
        dateEvidence(date, "feed", "published"),
        dateEvidence(extractDateFromUrl(url), "url", "context"),
      ]),
      collected_at: collectedAt,
      collector: "official_feed",
      query,
      ...officialSourceFields(feedKind, defaultSource, query, url),
      official_source_url: query,
      source_direct_url: directUrlCandidate(url),
      ...(hasArticleBody({ content_text: body }) ? {
        content_text: body,
        content_excerpt: contentExcerpt(body),
        content_fetch_status: "fetched",
        content_source_url: url,
        content_fetched_at: collectedAt,
      } : {}),
    });
  }
  return rows.filter((row) => row.title && row.url);
}

async function collectOfficialFeeds(company, sourceConfig, dateRange, maxPerSource, timeoutSeconds, collectedAt, contentCharLimit) {
  const feeds = sourceConfig.official_feeds?.[company.company] || [];
  const rows = [];
  let requestCount = 0;
  const errors = [];
  for (const feed of feeds) {
    const feedUrl = typeof feed === "string" ? feed : feed.url;
    const sourceName =
      typeof feed === "string" ? `Official feed: ${company.company}` : feed.source || `Official feed: ${company.company}`;
    const feedKind = typeof feed === "string" ? "" : feed.kind || "";
    if (!feedUrl) continue;
    // 피드 하나가 실패해도 같은 기업의 다른 피드는 계속 읽는다.
    try {
      // 실패한 요청도 요청이다. 받은 뒤에 세면 실패한 요청이 요청 수에서 빠진다. 재시도는 retry_count 가 센다.
      requestCount += 1;
      const xml = await fetchText(feedUrl, timeoutSeconds);
      const parsed = feed.format === "json"
        ? parseJsonFeed(xml, company, collectedAt, feedUrl, sourceName, feedKind, feed.json, contentCharLimit)
        : parseRssOrAtom(xml, company, collectedAt, "official_feed", feedUrl, sourceName, feedKind);
      rows.push(
        ...correctionsLast(filterByDateRange(
          parsed
            // IR 피드는 이사·애널리스트 소개 페이지도 새 항목으로 싣는다. 기사가 아니다.
            .filter((row) => !isPersonOrCoveragePage(row.url)),
          dateRange,
        )).slice(0, maxPerSource),
      );
    } catch (error) {
      errors.push({ source_url: feedUrl, source_name: sourceName, kind: "feed", error: error.message });
    }
  }
  return { rows, requestCount, errors, recoveryCandidates: rows };
}

async function collectOfficialPages(company, sourceConfig, dateRange, maxPerSource, timeoutSeconds, collectedAt) {
  const pages = normalizeOfficialPageEntries(sourceConfig.official_pages?.[company.company] || []);
  const rows = [];
  const recoveryCandidates = [];
  const errors = [];
  // 이 출처 단계의 링크 판정·제외 집계. 단계 결과에 실려 체크포인트에 남는다(collectCompany 가 합친다).
  const tally = createTally();
  let requestCount = 0;
  for (const page of pages) {
    try {
      requestCount += 1;
      // 링크는 리디렉트 뒤 실제로 받은 주소(baseUrl) 기준으로 풀고 판정한다. 같은 호스트 판정(sameHostNewsPath)도
      // 실제 페이지 호스트와 비교해야 맞다. 행의 query·official_source_url 은 설정 주소 그대로 둔다.
      const { text: html, url: baseUrl } = await fetchPage(page.url, timeoutSeconds);
      for (const feedUrl of discoverFeedLinks(html, baseUrl)) {
        try {
          requestCount += 1;
          const feedXml = await fetchText(feedUrl, timeoutSeconds);
          // 목록 페이지에서 찾은 피드의 항목도 링크 단계의 구조적 거부는 거친다. 설정한 피드처럼 인물·애널리스트
          // 소개 페이지를 빼고, 목록·깨진 주소도 뺀다. 예전에는 아무 판정 없이 들어왔다.
          const feedRows = filterByDateRange(
            parseRssOrAtom(feedXml, company, collectedAt, "official_feed_discovered", feedUrl, `${page.source} RSS`, page.kind)
              .filter((row) => {
                const reason = isPersonOrCoveragePage(row.url) ? "person_or_coverage_page"
                  : looksLikeSourceIndexUrl(row.url) ? "index_or_category_page"
                    : looksLikeBrokenUrl(row.url) ? "broken_url" : "";
                if (reason) recordExclusion(tally, company.company, row.title, row.url, reason);
                return !reason;
              }),
            dateRange,
          );
          rows.push(...correctionsLast(feedRows).slice(0, maxPerSource));
          recoveryCandidates.push(...feedRows.map(row => ({ ...row, source_page_url: feedUrl })));
        } catch (error) {
          errors.push({ source_url: feedUrl, source_name: `${page.source} RSS`, kind: "discovered_feed", error: error.message });
        }
      }
      const kept = [];
      for (const anchor of parseAnchors(html, baseUrl)) {
        // Keep raw configured-newsroom anchors only for exact-title recovery of
        // an opaque Google discovery URL. They do not enter collection unless
        // the ordinary link policy accepts them.
        if (!looksLikeSourceIndexUrl(anchor.url) && !looksLikeBrokenUrl(anchor.url)) {
          recoveryCandidates.push({ company: company.company, title: officialTitle(anchor),
            url: anchor.url, source_page_url: page.url });
        }
        const judged = judgeAnchor(anchor, baseUrl, linkPolicy);
        countLinkVerdict(tally, judged.verdict);
        if (judged.verdict === "hard_reject") {
          if (judged.reason) recordExclusion(tally, company.company, anchor.title, anchor.url, judged.reason);
          continue;
        }
        kept.push({ anchor, verdict: judged.verdict, reason: judged.reason, rank: judged.rank ?? 0 });
      }
      const sourceRows = dedupeRows(
        kept.map(({ anchor, verdict, reason, rank }) => ({
          target_no: company.target_no,
          company: company.company,
          title: officialTitle(anchor),
          url: anchor.url,
          source: page.source,
          ...chooseDateEvidence(collectListingDateEvidence(anchor)),
          collected_at: collectedAt,
          collector: "official_page",
          query: page.url,
          ...officialSourceFields(page.kind, page.source, page.sourceTypeLabel, page.pageTitle, page.url, anchor.url),
          official_source_url: page.url,
          source_direct_url: directUrlCandidate(anchor.url),
          link_verdict: verdict,
          link_reason: reason,
          link_rank: rank,
        })),
      );
      // 확인 대상은 확실한 기사 뒤에 세운다. maxPerSource 로 잘릴 때 밀려나야 할 쪽이 그쪽이다.
      rows.push(...orderPageRows(filterByDateRange(sourceRows, dateRange)).slice(0, maxPerSource));
    } catch (error) {
      errors.push({ source_url: page.url, source_name: page.source, kind: page.kind, error: error.message });
    }
  }
  return { rows, requestCount, errors, recoveryCandidates, tally };
}

function canFetchDetailContent(url) {
  return !UNREADABLE_FILE.test(url);
}

function isGoogle(value) {
  try { return /(^|\.)google\.com$/.test(new URL(value).hostname); } catch { return false; }
}

export function detailSourceUrl(row) {
  if (!isGoogle(row.url)) return row.url;
  // Prefer a known publisher URL; otherwise probe the actual redirect.
  if (row.source_direct_url && /^https?:\/\//i.test(row.source_direct_url) && !isGoogle(row.source_direct_url)) return row.source_direct_url;
  return row.url;
}

// Google 확인 차례. 기업이 달라도 Google 링크 풀기는 이 차례 하나를 지난다. Google 한도는 실행 전체가 함께 쓰기 때문이다.
// 2026-08 보고서(9월 14일 실행)에서는 Schott Pharma 에서 세 번 연속 실패한 뒤 Google 확인을 통째로 껐다.
// 그 뒤 순서의 기사 51건이 본문 없이 남았는데, 같은 링크를 로컬에서 다시 풀면 전부 1초 안에 풀렸다.
// 일시적인 차단이었다. 그래서 연속 실패가 limit 에 닿으면 쉬고 다시 시도하게 했는데, 9월분(10월 13일 실행)에서는
// 35건을 풀고 난 뒤 기사 페이지가 429 를 내기 시작해 60초씩 세 번 쉬고도 풀리지 않았고, 남은 79건을 요청 없이 버렸다.
// 그때 요청 사이에 간격이 없었다(4개 기업이 한 차례에 기사를 몰아넣는다). 429 를 받은 기사도 2초·4초 뒤 같은 요청을
// 되풀이하고 리다이렉트까지 따라가, 막힌 동안에도 기사 하나에 Google 요청이 네 번 갔다.
// 지금은 이렇게 한다.
// - Google 요청 사이에 intervalMs 를 둔다(앞 요청이 끝난 뒤부터 잰다). 몰아 보내지 않아 애초에 덜 막히게 한다.
// - 429 는 Google 이 직접 "잠시 멈추라"고 한 것이므로 한 번에 쉰다. 다른 막힘 신호(풀리지 않은 중계 주소·타임아웃·5xx)는
//   기사 탓일 수도 있어 limit 번 연속일 때만 쉰다. 쉬는 시간은 pauseMs 에서 시작해 쉴 때마다 두 배로 늘리고
//   (maxCooldownMs 까지), Retry-After 가 더 길면 그 값을 따른다. 쉬는 동안에는 아무 요청도 보내지 않는다.
// - 429 를 받은 기사는 쉬고 나서 retries 번까지 다시 보낸다. 그 기사 탓이 아니므로 그냥 버리면 손해다.
// - 한 실행에서 쉬는 데 쓰는 시간은 budgetMs 까지다. 다음 쉼이 예산을 넘으면 기다리지 않고, 막힌 동안 온 기사는
//   요청 없이 null(google_probe_paused)로 돌려준다. 막힘이 끝날 시각이 지나면 다음 기사로 한 번 시험해 보고, 풀렸으면
//   그대로 이어 간다. 예전처럼 이번 실행의 확인을 통째로 끄지 않는다. 그래도 남은 기사는 다음 실행이 이어 받는다.
// request 는 (fetchImpl, attempt) 를 받는다. fetchImpl 은 간격을 지키는 fetch 다. 쓰지 않으면 간격 없이 나간다.
// sleepFn·now·fetchImpl 은 시험에서 바꿔 넣는다. stats 는 이번 실행의 기록이다(수집 요약 google_probe_stats).
export function createPublisherProbe(limit = 3, { intervalMs = 1000, pauseMs = 60000, maxCooldownMs = 600000,
  budgetMs = 180000, retries = 1, sleepFn = sleep, now = Date.now,
  fetchImpl = (...request) => globalThis.fetch(...request) } = {}) {
  let failures = 0, cooldowns = 0, spentMs = 0, blockedUntil = 0, lastRequestAt = -Infinity, queue = Promise.resolve();
  const stats = { requests: 0, rate_limited: 0, cooldowns: 0, cooldown_ms: 0, retried: 0, paused: 0 };
  const pacedFetch = async (target, init) => {
    const waitMs = lastRequestAt + intervalMs - now();
    if (waitMs > 0) await sleepFn(waitMs);
    stats.requests += 1;
    try { return await fetchImpl(target, init); } finally { lastRequestAt = now(); }
  };
  const run = async (request) => {
    for (let attempt = 0; ; attempt += 1) {
      const waitMs = blockedUntil - now();
      if (waitMs > 0) {
        if (spentMs + waitMs > budgetMs) {
          stats.paused += 1;
          return null;
        }
        spentMs += waitMs;
        stats.cooldown_ms += waitMs;
        await sleepFn(waitMs);
      }
      try {
        const document = await request(pacedFetch, attempt);
        failures = 0;
        cooldowns = 0;
        return document;
      } catch (error) {
        if (!googleBlocked(error)) {
          failures = 0;
          throw error;
        }
        failures += 1;
        const rateLimited = error.status === 429;
        if (rateLimited) stats.rate_limited += 1;
        if (!rateLimited && failures < limit) throw error;
        const cooldown = Math.min(maxCooldownMs, Math.max((error.retryAfterSeconds || 0) * 1000, pauseMs * 2 ** cooldowns));
        cooldowns += 1;
        failures = 0;
        stats.cooldowns += 1;
        blockedUntil = now() + cooldown;
        // 예산 안에서 쉴 수 있을 때만 같은 기사를 다시 보낸다. 넘으면 이 기사는 오류로 남기고, 뒤 기사는 위에서 멈춘다.
        if (!rateLimited || attempt >= retries || spentMs + cooldown > budgetMs) throw error;
        stats.retried += 1;
      }
    }
  };
  const probe = async (url, request) => {
    if (!isGoogle(url)) return request();
    // 차례를 기업 사이에 하나로 묶어야 이미 줄 선 요청이 쉬는 판단을 건너뛰지 못한다. 다른 발행사는 차례 없이 받는다.
    const result = queue.then(() => run(request));
    queue = result.catch(() => {});
    return result;
  };
  probe.stats = stats;
  return probe;
}

// Google 이 막고 있다는 신호. 중계 주소가 발행사로 풀리지 않은 것만 세던 탓에, 429·5xx·타임아웃이 나면 오히려
// 연속 실패가 0으로 돌아가 쉬어 가는 장치가 걸리지 않았다. 404 처럼 서버가 내린 결정은 막힘이 아니다.
const GOOGLE_BLOCK_MESSAGE = /publisher_url_unresolved|timeout|aborted|fetch failed|^HTTP (?:429|5\d\d)\b/i;

export function googleBlocked(error) {
  if (error?.status === 429 || error?.status >= 500) return true;
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return true;
  return GOOGLE_BLOCK_MESSAGE.test(String(error?.message || ''));
}
// 기업 수집을 미완료로 만드는 오류. 목록·피드·사이트맵·검색 단계의 실패만 센다.
// 상세 페이지 실패는 그 기사가 본문 없는 기사로 남아 검토 커버리지에서 따로 드러난다. 여기서도 세면
// 실패 하나가 두 번 막는다. 공시·재무 보고서 목록은 월간 사건 기사가 올라오는 곳이 아니고(8-K 는
// sec_filings 가 따로 읽는다), 목록 페이지 안에서 찾은 피드는 그 페이지를 이미 읽었으므로 보조 경로다.
// 2026-08 실행에서는 오류가 하나라도 있으면 미완료로 봐서, 2023년 PDF 404나 SEC 공시 목록 403만으로
// 28개 기업이 근거 부족이 됐다.
const NON_BLOCKING_ERROR_SOURCES = new Set(["official_detail", "official_model"]);
const NON_BLOCKING_ERROR_KINDS = new Set(["filing", "financial_report", "discovered_feed"]);

export function collectionBlockingErrors(errors = []) {
  return errors.filter((error) => !NON_BLOCKING_ERROR_SOURCES.has(error.source) && !NON_BLOCKING_ERROR_KINDS.has(error.kind));
}

// In-memory only: each collector execution starts with fresh probes.
const probePublisher = createPublisherProbe();

// 응답 본문을 바이트로, 상한을 두고 읽는다. PDF 만 이렇게 읽다가 이제 모든 응답을 이렇게 받는다.
// 종류를 바이트로 판별해야 하고, 덤으로 HTML 응답에도 상한이 생긴다.
// 크기 초과는 서버의 일시 장애가 아니다. 다시 받아도 같고, domainGuard 가 호스트 실패로 세지도 않는다.
const tooLarge = () => Object.assign(new Error('document_too_large'), { noRetry: true });

export async function readLimitedResponse(response, limit = 20 * 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw tooLarge();
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

// 다단 PDF는 줄 단위로 읽으면 두 단이 한 줄씩 번갈아 섞인다. 한 문장이 옆 단 텍스트로
// 끊기므로, 모델이 제대로 읽고도 원문에 없는 인용을 내고 판정 전체가 검증에서 막힌다.
// extract_pdf_text.py 가 단을 먼저 나누고 읽는다.
const PDF_EXTRACTOR = fileURLToPath(new URL('extract_pdf_text.py', import.meta.url));

// 추출기를 돌릴 파이썬. pdfplumber 가 깔린 가상환경을 쓰려면 PDF_EXTRACTOR_PYTHON 에 그 실행 파일을 적는다.
// Actions 는 setup-python 이 PATH 에 둔 python 을 쓴다.
export function pdfExtractorPython(env = process.env) {
  return String(env.PDF_EXTRACTOR_PYTHON || '').trim() || 'python';
}

// 추출기를 돌릴 수 없는 환경. 파이썬이 없으면 ENOENT, pdfplumber 가 없으면 이 코드다. 문서 탓인 실패와 구분한다.
export function pdfExtractorUnavailable(error) {
  return error?.code === 'ENOENT' || error?.code === 'PDF_EXTRACTOR_UNAVAILABLE';
}

export function extractPdfText(bytes) {
  return new Promise((resolve, reject) => {
    const child = spawn(pdfExtractorPython(), ['-X', 'utf8', PDF_EXTRACTOR],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0, failure = null, stderr = '';
    const timer = setTimeout(() => { failure = new Error('pdf_extraction_timeout'); child.kill(); }, 30000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) { failure = new Error('pdf_text_too_large'); child.kill(); }
      else chunks.push(chunk);
    });
    // 오류 출력은 끝부분만 남긴다. 모듈이 없어서 실패했는지만 가리면 된다.
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
    child.stdin.on('error', () => {}); // close/error determines the extraction result
    child.on('close', code => {
      clearTimeout(timer);
      if (!failure && code !== 0 && /No module named ['"]?pdfplumber/.test(stderr)) {
        failure = Object.assign(new Error('pdf_extractor_unavailable'), { code: 'PDF_EXTRACTOR_UNAVAILABLE' });
      }
      if (failure || code !== 0) reject(failure || new Error('pdf_extraction_failed'));
      else resolve(Buffer.concat(chunks).toString('utf8').trim());
    });
    child.stdin.end(bytes);
  });
}

// Google News RSS 가 싣는 기사 주소는 발행사 주소를 감춘 중계 주소다. 따라가도 동의 페이지나 스크립트
// 이동에서 멈춘다. 2026-08 실행에서 이렇게 본문 없이 남은 기사가 98건이었다(Yahoo Finance, Reuters,
// Business Wire 등). 중계 페이지에 실린 서명으로 Google News 자체의 해독 요청을 보내 발행사 주소를 받는다.
// 어느 단계든 실패하면 null 이다. 호출하는 쪽은 예전처럼 리다이렉트를 따라가 본다.
export async function decodeGoogleNewsUrl(url, timeoutSeconds, fetchImpl = fetch) {
  return (await decodeGoogleNewsLink(url, timeoutSeconds, fetchImpl)).url || null;
}

// 해독 결과와, 실패했다면 어느 단계에서 왜 실패했는지. 9월 28일 실행은 Google 확인이 12번 실패한 뒤
// 멈춰 78건이 본문 없이 남았는데, 429 로 막힌 것인지 동의 페이지가 온 것인지 남지 않아 원인을 가릴 수 없었다.
export async function decodeGoogleNewsLink(url, timeoutSeconds, fetchImpl = fetch) {
  try {
    return await decodeGoogleNewsSteps(url, timeoutSeconds, fetchImpl);
  } catch (error) {
    return { reason: error?.name === 'TimeoutError' ? 'decode_timeout' : `decode_network: ${error?.cause?.code || error?.message || 'error'}` };
  }
}

async function decodeGoogleNewsSteps(url, timeoutSeconds, fetchImpl) {
  let id;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'news.google.com') return { reason: 'not_google_news' };
    id = parsed.pathname.match(/\/articles\/([^/?#]+)/)?.[1];
  } catch {
    return { reason: 'not_google_news' };
  }
  if (!id) return { reason: 'not_google_news' };
  // 5xx 는 잠깐 쉬고 두 번까지 다시 보낸다. 429 는 여기서 다시 보내지 않고 곧바로 돌려준다. 10월 13일 실행에서 2초·4초 뒤
  // 다시 보낸 429 가 36번 모두 또 429 였다. 막힌 동안 요청을 더 보내면 막힘만 길어진다. 쉬고 다시 보내는 일은
  // 모든 기업이 함께 쓰는 Google 차례(createPublisherProbe)가 맡는다.
  const send = async (target, init) => {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetchImpl(target, { ...init, signal: AbortSignal.timeout(timeoutSeconds * 1000) });
      if (response.status < 500 || attempt >= 2) return response;
      await response.body?.cancel();
      await sleep(2000 * 2 ** attempt);
    }
  };
  const failed = async (response, step) => {
    await response.body?.cancel();
    const reason = `${step}_http_${response.status}`;
    if (response.status !== 429) return { reason };
    return { reason, rateLimited: true, retryAfterSeconds: parseRetryAfter(response.headers?.get('retry-after')) };
  };
  // 서명은 RSS 쪽 중계 페이지(/rss/articles/)에서 받는다. 웹 쪽(/articles/)은 요청 제한이 따로 빡빡하다. 2026-09 수집
  // (10월 23일 실행 146)은 웹 쪽에서 약 48건을 푼 뒤 429 로 막혀 Google 기사 491건 중 440건을 본문 없이 넘겼다.
  // 같은 날 로컬에서 웹 쪽이 10분 넘게 429 인 동안에도 RSS 쪽은 200 에 서명이 그대로 있었고, 1초 간격으로 330건을
  // 연달아 풀었다(429 없음). 해독 요청(batchexecute)은 그대로다.
  const page = await send(`https://news.google.com/rss/articles/${id}`, { headers: { 'User-Agent': USER_AGENT } });
  if (!page.ok) return failed(page, 'article_page');
  const html = await page.text();
  const signature = html.match(/data-n-a-sg="([^"]+)"/)?.[1];
  const timestamp = html.match(/data-n-a-ts="([^"]+)"/)?.[1];
  if (!signature || !timestamp) {
    // 동의 페이지(consent.google.com)로 넘어가면 서명이 없다. 어디에 닿았는지 함께 남긴다.
    let landed = '';
    try { landed = page.url ? new URL(page.url).hostname : ''; } catch { /* 주소 없는 응답 */ }
    return { reason: landed && landed !== 'news.google.com' ? `article_page_no_signature: ${landed}` : 'article_page_no_signature' };
  }
  const request = ['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1],
    'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, Number(timestamp), signature];
  const response = await send('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': USER_AGENT },
    body: `f.req=${encodeURIComponent(JSON.stringify([[['Fbv4je', JSON.stringify(request), null, 'generic']]]))}`,
  });
  if (!response.ok) return failed(response, 'batchexecute');
  let decoded;
  try {
    const payload = (await response.text()).split('\n\n')[1];
    decoded = JSON.parse(JSON.parse(payload)[0][2])[1];
  } catch {
    return { reason: 'batchexecute_unparsed' };
  }
  return /^https?:\/\//i.test(decoded) && !isGoogle(decoded) ? { url: decoded } : { reason: 'decoded_not_publisher' };
}

// Google 차례에서 할 일만 한다. 발행사 본문 다운로드는 차례 밖 downloadArticleDocument 가 맡는다.
// 2026-09-15 실행에서는 해독 뒤의 본문·PDF 받기까지 차례 안에서 해서, 다른 기업의 Google 링크가 그걸 기다렸다.
// 해독이 안 되면 예전처럼 중계 주소를 따라가 보는데, 드물게 발행사에 닿으면 그 응답은 여기서 끝까지 읽는다.
// 본문을 차례 밖으로 넘기면 기업 자리를 기다리는 동안 요청 제한 시간이 지나 버린다.
export async function resolveArticleSource(url, timeoutSeconds, fetchImpl = fetch) {
  if (!isGoogle(url)) return { target: url };
  const decoded = await decodeGoogleNewsLink(url, timeoutSeconds, fetchImpl);
  if (decoded.url) return { target: decoded.url };
  // Google 이 429 로 막고 있으면 중계 주소를 따라가 보지 않는다. 같은 Google 에 또 요청하는 일이고, 10월 13일 실행의
  // 12건은 따라가도 모두 동의 페이지에서 멈췄다. 상태와 Retry-After 를 실어 Google 차례가 쉬고 다시 보내게 한다.
  // 메시지는 예전과 같다(google_news_unresolved_count 가 메시지로 센다).
  if (decoded.rateLimited) {
    throw Object.assign(new Error('publisher_url_unresolved'), { status: 429,
      retryAfterSeconds: decoded.retryAfterSeconds || 0, decodeFailure: decoded.reason, noRetry: true });
  }
  try {
    return { document: await downloadArticleDocument(url, timeoutSeconds, fetchImpl) };
  } catch (error) {
    // 오류 메시지는 그대로 둔다. createPublisherProbe 가 메시지로 연속 실패를 센다.
    error.decodeFailure = decoded.reason;
    throw error;
  }
}

export async function fetchArticleDocument(url, timeoutSeconds, fetchImpl = fetch) {
  const source = await resolveArticleSource(url, timeoutSeconds, fetchImpl);
  return source.document || downloadArticleDocument(source.target, timeoutSeconds, fetchImpl);
}

// 문서 종류는 바이트가 말한다. content-type 머리글과 주소 확장자만 보면 놓친다.
const DOCUMENT_MAGIC = [
  ['pdf', '255044462d'],        // %PDF-
  ['zip', '504b0304'],          // xlsx·docx·pptx 를 포함한 zip
  ['ole', 'd0cf11e0a1b11ae1'],  // 옛 xls·doc·ppt
  ['rtf', '7b5c727466'],        // {\rtf
  ['elf', '7f454c46'],
  ['png', '89504e470d0a1a0a'],
  ['jpeg', 'ffd8ff'],
  ['gzip', '1f8b'],
];

export function sniffDocumentType(bytes) {
  const head = Buffer.from(bytes).subarray(0, 8).toString('hex');
  return DOCUMENT_MAGIC.find(([, magic]) => head.startsWith(magic))?.[0] || 'text';
}

// 요청 한 번. 응답 바이트까지만 받는다. 재시도·domainGuard 는 이 단계만 감싼다. PDF 추출 실패는 서버 탓이
// 아니므로 다시 받지 않고 호스트 실패로도 세지 않는다.
async function requestDocument(target, timeoutSeconds, fetchImpl) {
  const response = await fetchImpl(target, { signal: AbortSignal.timeout(timeoutSeconds * 1000),
    redirect: 'follow', headers: requestHeaders(target) });
  if (!response.ok) {
    await response.body?.cancel();
    throw httpError(response);
  }
  const resolvedUrl = response.url || target;
  // Google consent/RSS wrapper text is not publisher evidence.
  // 메시지는 그대로 둔다. createPublisherProbe 가 메시지로 연속 실패를 센다.
  if (isGoogle(resolvedUrl)) {
    await response.body?.cancel();
    throw Object.assign(new Error('publisher_url_unresolved'), { noRetry: true });
  }
  const declaredPdf = /application\/pdf/i.test(response.headers.get('content-type') || '') || /\.pdf(?:[?#]|$)/i.test(resolvedUrl);
  return { bytes: await readLimitedResponse(response), resolvedUrl, declaredPdf };
}

export async function downloadArticleDocument(target, timeoutSeconds, fetchImpl = fetch) {
  return documentFromBytes(await requestDocument(target, timeoutSeconds, fetchImpl));
}

// 상세 페이지와 발행사 문서를 받는 수집 경로의 입구. 공식 상세 페이지도 이 길로 받는다. 예전에는 주소가 .pdf 로
// 끝나지 않는 공식 행이 fetchText → response.text() 로 내려가 바이트 판별을 타지 않았고, 10월 13일 실행에서도
// Nabtesco 5건, Renishaw 3건, Bayer·Merck 각 1건이 unextractable_binary_document 로 남았다.
// 반대로 공식 .pdf 링크와 대체 출처 다운로드는 재시도와 domainGuard 를 거치지 않았다. 이제 둘 다 거친다.
export async function fetchPublisherDocument(target, timeoutSeconds, fetchImpl = fetch) {
  return documentFromBytes(await fetchWithRetries(target, () => requestDocument(target, timeoutSeconds, fetchImpl)));
}

async function documentFromBytes({ bytes, resolvedUrl, declaredPdf }) {
  // 머리글도 주소도 PDF 라고 말하지 않는 PDF 가 있다. Nabtesco 보도자료 5건(주소가 .pdf 가 아니다)과
  // Renishaw 실적 자료 2건이 그래서 추출기를 타지 못하고 response.text() 로 내려가, 본문 자리에
  // "%PDF-1.6" 바이트가 그대로 실렸다. 바이트로 판별하면 그 7건이 제 추출기로 돌아온다.
  const kind = declaredPdf ? 'pdf' : sniffDocumentType(bytes);
  if (kind === 'pdf') return { html: '', content: await extractPdfText(bytes), resolvedUrl };
  // PDF 가 아닌 바이너리는 읽을 방법이 없다. Merck 재무제표는 XLSX 였다. 빈 본문과 까닭을 돌려주어
  // 행은 남기고 본문 추출 실패로 구분한다. 근거 없이 판정에 올리지 않고, 재수집 대상으로 남긴다.
  if (kind !== 'text') return { html: '', content: '', documentType: kind, resolvedUrl };
  // Response.text() 도 UTF-8 로 읽는다(Fetch 표준). 바이트를 먼저 받아도 해독 결과는 같다.
  return { html: new TextDecoder().decode(bytes), resolvedUrl };
}

export function chooseBetterTitle(currentTitle, pageTitle, url, company) {
  // 사이트 <title>이 회사명뿐이거나 메뉴 이름이면 링크 텍스트보다 나을 게 없다.
  // onsemi 뉴스룸의 <title>이 "onsemi"라서 제목이 회사명으로 덮이던 문제를 막는다.
  const usablePageTitle = pageTitle && isUsableTitle(pageTitle, company) ? pageTitle : "";
  if (!usablePageTitle) {
    // PDF처럼 문서에 제목이 없고 링크 문구가 라벨뿐이면("English version") 파일 이름이 더 낫다.
    const urlTitle = titleFromUrl(url);
    return !isUsableTitle(currentTitle, company) && urlTitle && isUsableTitle(urlTitle, company) ? urlTitle : currentTitle;
  }
  if (!currentTitle || currentTitle.length < 16 || isGenericOfficialTitle(currentTitle)) return usablePageTitle;
  const urlTitle = titleFromUrl(url);
  if (urlTitle && currentTitle.toLowerCase() === urlTitle.toLowerCase()) return usablePageTitle;
  return currentTitle;
}

// yieldSlot: Google 차례를 기다리는 동안 기업 작업 자리를 내놓는다(mapWithConcurrency 참고).
// probe: Google 확인 차례(createPublisherProbe). log: 기업 수집의 단계 기록(createStepLog).
// tally: 이 기업의 제외 집계(createTally). 다시 쓴 상세 단계의 제외도 센다. 이어 받은 기업의 집계가 전체 재수집과 같아야 한다.
export async function enrichOfficialRowsWithContent(rows, args, collectedAt, company,
  { yieldSlot = task => task(), probe = probePublisher, log = createStepLog(), tally = createTally() } = {}) {
  rows = selectDetailRows(rows, args.maxVerifyPerCompany);
  if (!args.fetchOfficialContent) {
    return { rows: rows.filter(row => row.link_verdict !== 'fetch_to_verify').map(withoutFeedSummary), requestCount: 0, errors: [] };
  }

  const enriched = [];
  const errors = [];
  let requestCount = 0;
  let detailCount = 0;
  let verifyCount = 0;

  for (const listed of rows) {
    // 피드 요약은 이 단계에서만 쓰고 결과 행에는 남기지 않는다. 본문 자리에 들어가면 그 사본이고, 안 쓰이면
    // 결과 파일만 키운다. 상세 단계 기록의 키(stepKey)는 요약까지 든 원래 행으로 만든다. 결과가 요약에 달려 있다.
    // 요약이 없는 행은 두 행이 같으므로 키도 예전과 같다.
    const feedSummary = listed.feed_summary || "";
    const row = withoutFeedSummary(listed);
    if (row.content_text && row.link_verdict !== 'fetch_to_verify') {
      enriched.push(row);
      continue;
    }
    // 확인 대상은 회사마다 몇 건까지만 받아본다. 확실한 기사가 먼저 줄을 서 있으므로,
    // 이 상한에 걸리는 것은 언제나 그다음으로 가능성이 낮은 링크다.
    if (row.link_verdict === "fetch_to_verify") {
      if (verifyCount >= args.maxVerifyPerCompany) {
        recordExclusion(tally, row.company, row.title, row.url, "verify_budget_exhausted");
        continue;
      }
      verifyCount += 1;
    }
    const detailUrl = detailSourceUrl(row);

    // 본문을 받아오지 않는 두 경로에서는 링크 텍스트와 URL만으로 제목을 확보해야 한다.
    if (detailCount >= args.maxDetailPerCompany || !canFetchDetailContent(row.url)) {
      const skipStatus = detailCount >= args.maxDetailPerCompany ? "skipped_detail_limit" : "skipped_non_html";
      const skipTitle = isUsableTitle(row.title, company) ? row.title : titleFromUrl(row.url);
      if (!isUsableTitle(skipTitle, company)) {
        recordExclusion(tally, row.company, row.title, row.url, "no_article_title");
        continue;
      }
      // 확인 대상은 문서를 봐야 판정이 끝난다. 못 받아봤으면 링크만 보고 들일 수 없다.
      if (row.link_verdict === "fetch_to_verify") {
        recordExclusion(tally, row.company, skipTitle, row.url, "unverified_no_fetch");
        continue;
      }
      // PDF·XLS 링크는 본문을 열 수 없으니 파일명에 남은 날짜라도 살린다. 다만 URL 날짜는 정황 근거다.
      const skipDates = chooseDateEvidence([
        ...(row.date_candidates || []),
        dateEvidence(extractDateFromText(skipTitle) || extractMonthFromText(skipTitle), "text", "context"),
        dateEvidence(extractDateFromUrl(row.url), "url", "context"),
      ]);
      // 열 수 없는 파일(XLS 등)에 날짜 근거도 없으면 검토도 날짜 확인도 영영 할 수 없다. 남겨 두면 매달
      // 수집 보완 대상으로만 쌓인다. 2026-08 실행의 Merck 지역 매출표, ABB 2021년 3분기 재무표가 그랬다.
      if (skipStatus === "skipped_non_html" && !skipDates.published_at && !skipDates.published_month) {
        recordExclusion(tally, row.company, skipTitle, row.url, "unreadable_undated_file");
        continue;
      }
      enriched.push({
        ...row,
        title: skipTitle,
        ...skipDates,
        content_fetch_status: skipStatus,
      });
      continue;
    }

    // 상세 페이지 한 건이 한 단계다. 재시도할 까닭이 상세 페이지 단계에만 남은 기업을 이어 받을 때는 앞선 실행이
    // 받아 둔 결과를 그대로 쓰고, 실패했거나 멈춰서 요청하지 못한 기사만 다시 받는다(createStepLog).
    const { value: outcome, replayed } = await log.run(stepKey("detail", listed),
      () => fetchDetailOutcome(row, detailUrl, args, collectedAt, company, { yieldSlot, probe, feedSummary }));
    if (!replayed) requestCount += outcome.requestCount;
    detailCount += outcome.detailCount;
    errors.push(...outcome.errors);
    if (outcome.exclusion) recordExclusion(tally, row.company, ...outcome.exclusion);
    if (outcome.row) enriched.push(outcome.row);
    if (outcome.paced && !replayed && args.rateLimitSeconds > 0) {
      await sleep(args.rateLimitSeconds * 1000);
    }
  }

  return { rows: enriched, requestCount, errors };
}

// 상세 페이지 한 건을 받아 판정한 결과. 체크포인트에 그대로 남으므로 데이터만 담는다.
// row: 남길 행, exclusion: 버린 까닭([제목, URL, 사유]), detailCount: 상세 페이지 상한에 세는 요청 수,
// paced: 요청 간격을 둘지. 본문을 받았거나 오류 행을 남긴 경우에만 둔다. 버리거나 멈춘 기사 뒤에는 두지 않는다.
async function fetchDetailOutcome(row, detailUrl, args, collectedAt, company, { yieldSlot, probe, feedSummary = "" }) {
  const outcome = { requestCount: 0, detailCount: 0, errors: [], row: null, exclusion: null, paced: false };
  const errors = outcome.errors;
  const exclude = (title, url, reason) => ({ ...outcome, exclusion: [title, url, reason] });
  // 상세 페이지 본문을 못 얻었을 때(요청 오류·차단, 추출 실패, 기준 미달) 본문 대신 쓸 피드 요약. 기준에 못 미치면 빈 값이다.
  // 상세 본문이 기준을 넘으면 요약은 쓰지 않는다. 그래야 이미 본문이 있던 기사의 근거와 기사 ID 가 그대로다.
  // 판정은 이 글을 본문과 똑같이 근거로 받고, 인용 확인(importReview)도 이 글에 대해 한다.
  const summaryBody = feedSummaryBody(feedSummary, args.contentCharLimit);
  const summaryFields = summaryBody ? {
    content_text: summaryBody,
    content_excerpt: contentExcerpt(summaryBody, args.contentExcerptLimit),
    content_word_count: summaryBody.split(/\s+/).filter(Boolean).length,
    // 본문 출처 표시. 상세 페이지 본문인 행에는 붙이지 않는다(없으면 상세 페이지·JSON 피드 본문이다).
    // content_fetch_status 는 상세 페이지 요청의 결과(error·empty·unextractable_* 등)를 그대로 둔다.
    // 근거가 원문 전체가 아니라 피드 요약이고 원문은 읽지 못했다는 사실을 지우지 않는다.
    content_source: "feed_summary",
  } : {};
  try {
    let document;
    // 공식 상세 페이지와 발행사 주소는 같은 길로 받는다: 바이트로 문서 종류를 판별하고, 재시도와 domainGuard 를 거친다.
    if (!isGoogle(detailUrl)) {
      outcome.requestCount += 1;
      outcome.detailCount += 1;
      document = await fetchPublisherDocument(detailUrl, args.timeoutSeconds);
    } else {
      // googleFetch 는 Google 요청 간격을 지키는 fetch 다. 429 뒤 다시 보낸 시도도 요청 수로 세지만, 상세 페이지 상한은
      // 기사 한 건으로 한 번만 센다. 다시 보냈다고 이 기업의 다른 기사가 상한에 밀려서는 안 된다.
      const source = await yieldSlot(() => probe(detailUrl, async (googleFetch, attempt = 0) => {
        outcome.requestCount += 1;
        if (attempt === 0) outcome.detailCount += 1;
        return resolveArticleSource(detailUrl, args.timeoutSeconds, googleFetch);
      }));
      document = source && (source.document || await fetchPublisherDocument(source.target, args.timeoutSeconds));
    }
    // 문서가 없는 경우는 하나다. createPublisherProbe 가 쉬는 시간 예산을 다 써서, Google 이 막고 있는 동안 요청을 보내지 않았다.
    // 오류로 남겨야 retryableCollection 이 이 기업을 재시도 대상으로 본다. 남기지 않으면 체크포인트가
    // 완료로 저장돼, 9월 28일 실행처럼 78건이 다시 돌려도 시도되지 않은 채 남는다.
    if (!document) {
      errors.push({ target_no: row.target_no, company: row.company, source: 'official_detail',
        source_url: row.url, source_name: row.source, error: 'google_probe_paused' });
      if (row.link_verdict === 'fetch_to_verify') return exclude(row.title, row.url, 'unverified_no_fetch');
      return { ...outcome, row: { ...row, content_fetch_status: 'google_probe_paused' } };
    }
    const html = document.html;
    let content = document.content ?? extractArticleText(html);
    const pageTitle = extractPageTitle(html);
    const resolvedTitle = chooseBetterTitle(row.title, pageTitle, row.url, company);
    if (row.publisher_resolution === 'official_exact_title' &&
        !fetchedTitleMatchesPublisherArticle(row, pageTitle || content.split(/\r?\n/, 1)[0])) {
      throw new Error('publisher_article_title_mismatch');
    }
    // 읽을 수 없는 문서였음을 "본문 없음"과 구분해 남긴다. 수집을 보완할 사람이 무엇을 고쳐야
    // 하는지 알 수 있어야 한다(PDF 추출 실패인지, 애초에 표 파일이었는지).
    let contentFetchStatus = content ? 'fetched' : document.documentType ? `unreadable_${document.documentType}` : 'empty';
    // Some official AEM pages return only a title shell in HTML. After an
    // independently discovered same-host exact-title URL, try that page's
    // same-path model once. The model helper accepts content only when its
    // own title identifies the same article.
    if (row.publisher_resolution === 'official_exact_title' && content.length < ARTICLE_BODY_MIN_CHARS) {
      const modelUrl = aemModelUrl(document.resolvedUrl);
      try {
        outcome.requestCount += 1;
        const modelArticle = extractQualcommAemArticle(row, await fetchJson(modelUrl, args.timeoutSeconds), cleanHtmlText);
        if (modelArticle?.content && modelArticle.content.length > content.length) {
          content = `${modelArticle.title}\n${modelArticle.content}`;
          contentFetchStatus = 'fetched_aem_model';
        }
      } catch (error) {
        errors.push({ target_no: row.target_no, company: row.company, source: 'official_model',
          source_url: modelUrl, source_name: row.source, error: error.message });
      }
    }
    let limitedContent = content.slice(0, args.contentCharLimit);
    // PDF·XLSX 를 글자로 읽어 저장하면 2만 자짜리 "본문"이 생기지만 내용은 없다. 근거로 넘기기
    // 전에 추출 실패로 구분한다. 행은 남겨 목록의 제목·날짜를 지키고, 본문만 비워 재수집 대상이 되게 한다.
    const unextractable = unextractableBody(limitedContent);
    if (unextractable) {
      contentFetchStatus = `unextractable_${unextractable}`;
      limitedContent = "";
    }
    // 페이지는 받았지만 본문이 기준에 못 미치면(빈 껍데기, 추출 실패) 피드 요약을 본문 자리에 쓴다.
    // 날짜 단서(bodyHead)도 실제로 근거가 되는 글에서 찾는다.
    const fromFeedSummary = Boolean(summaryBody) && !hasArticleBody({ content_text: limitedContent });
    if (fromFeedSummary) limitedContent = summaryBody;
    // 목록에 날짜가 있어도 기사 페이지를 다시 읽는다. 더 강한 근거가 있는지, 두 날짜가 어긋나는지는
    // 상세 페이지를 보고 나서야 알 수 있다.
    const bodyHead = limitedContent.slice(0, 4000);
    const dates = chooseDateEvidence([
      ...(row.date_candidates || []),
      ...collectHtmlDateEvidence(html, document.resolvedUrl),
      dateEvidence(extractDateFromText(`${resolvedTitle} ${bodyHead}`) ||
        extractMonthFromText(`${resolvedTitle} ${bodyHead}`), "body_text", "context"),
    ]);
    // 상세 페이지를 받아본 뒤에도 쓸 만한 제목이 없으면 기사로 인정하지 않는다.
    // 링크 텍스트로 추측하는 대신 실제 받아온 문서로 판정하는 지점이다.
    // 확인 대상으로 넘어온 링크는 제목에 더해 문서 자체가 목록이 아닌지도 여기서 본다.
    const usable = isUsableTitle(resolvedTitle, company);
    // 이미 기사 링크로 받아들인 행도 받아온 제목이 목록·문서번호 모양이면 기사가 아니다.
    // 2026-08에는 "Press releases from 2020" 목록이 투자 시그널 승인까지 받았다. 링크 밀도 검사는
    // 확인 대상에만 둔다. 메뉴 링크가 많은 사이트에서는 짧은 정상 공지까지 떨어뜨리기 때문이다.
    const verdict = verifyFetchedArticle({ title: resolvedTitle, content,
      html: row.link_verdict === "fetch_to_verify" ? html : "", usableTitle: usable });
    if (!verdict.ok) return exclude(resolvedTitle || row.title, row.url, verdict.reason);
    return { ...outcome, paced: true, row: {
      ...row,
      title: resolvedTitle,
      ...dates,
      content_text: limitedContent,
      content_source_url: document.resolvedUrl,
      content_excerpt: contentExcerpt(limitedContent, args.contentExcerptLimit),
      content_word_count: limitedContent.split(/\s+/).filter(Boolean).length,
      ...(fromFeedSummary ? { content_source: "feed_summary" } : {}),
      content_fetch_status: contentFetchStatus,
      content_fetched_at: collectedAt,
    } };
  } catch (error) {
    errors.push({
      target_no: row.target_no,
      company: row.company,
      source: "official_detail",
      source_url: row.url,
      source_name: row.source,
      error: error.message,
      ...(error.decodeFailure ? { decode_failure: error.decodeFailure } : {}),
    });
    if (row.link_verdict === 'fetch_to_verify') return exclude(row.title, row.url, 'unverified_fetch_error');
    // 받아오지 못한 기사도 제목·URL에 남은 날짜는 살린다. 2026-08 실행에서 /2026/04/ 경로의 Air Products
    // 실적 발표가 날짜 미상으로 남아 8월 수집 보완 대상에 섞였다.
    return { ...outcome, paced: true, row: {
      ...row,
      ...chooseDateEvidence([
        ...(row.date_candidates || []),
        dateEvidence(extractDateFromText(row.title) || extractMonthFromText(row.title), "text", "context"),
        dateEvidence(sitemapUrlDate(row.url), "url", "context"),
      ]),
      // 원문이 막혀도(403·500 등) 피드가 준 요약이 기준을 넘으면 그것을 근거로 남긴다. 받은 주소가 없으므로
      // content_source_url 은 비워 둔다. 보고서 출처 링크(report_content.py source_url)가 피드 XML 을 가리키면 안 된다.
      ...summaryFields,
      content_fetch_status: "error",
      content_fetched_at: collectedAt,
    } };
  }
}

// 사업동향(kind=relevant) 탐색. 기존 google_news 대체 수집은 공식 자료가 없을 때만 돌기 때문에,
// 공식 보도자료가 한 건이라도 있으면 타겟 품목을 다루는 외부 기사를 통째로 놓쳤다. 2026-08 실행의
// Norsk Hydro 가 그랬다: 공식 뉴스룸에서 전력계약·알루미나 감산 네 건을 가져왔으므로 대체 수집이
// 생략됐고, 같은 달 GM Cadillac OPTIQ 에 Hydro CIRCAL 을 공급한다는 발표는 수집되지 않았다.
// 그래서 대체 수집과 별개로, 공식 자료가 있든 없든 "회사명 + 타겟 기술" 질의를 한 번 더 돌린다.
//
// 비용은 세 가지로 묶는다. 기업당 요청은 1회, 후보는 기술 키워드가 제목·발췌에 실제로 있는 기사만,
// 그 가운데 최대 maxTrendDiscovery 건이다. 키워드는 LLM 에 보낼 후보를 고르는 데만 쓰고 판정에는
// 쓰지 않는다. 판정은 기존과 같이 기사 1건당 한 번의 호출에서 S1~S5 와 사업동향을 함께 본다.

// 질의어는 영문 뉴스 기준이라 영문 키워드만 쓴다. 한글 키워드는 hl=en-US 결과에 거의 걸리지 않으면서
// 질의만 길게 만든다. 키워드가 많으면 Google 이 뒤쪽을 버리므로 가장 구체적인 것부터 제한해 넣는다.
export const TREND_QUERY_KEYWORD_LIMIT = 6;
const isLatinKeyword = (term) => /^[\x20-\x7e]+$/.test(term);

// 수집 식별자에 넣는 탐색 입력. 기술 매핑과 키워드 목록이 바뀌면 캐시된 수집을 다시 돌려야 한다.
// 상한이 0이면 탐색을 아예 돌리지 않으므로 두 파일은 식별자에 넣지 않는다.
export function trendDigestInputs(args, technology = trendTechnology, keywordConfig = trendKeywordConfig,
  searchTerms = trendSearchTerms) {
  if (!(args.maxTrendDiscovery > 0)) return null;
  return { maxTrendDiscovery: args.maxTrendDiscovery, technology, keywordConfig, searchTerms };
}

// 출처 설정에서 기업 이름을 키로 갖는 항목. 수집기는 여기서 자기 기업 몫만 읽는다(collectOfficialFeeds·
// collectOfficialPages·collectOfficialSitemaps·collectSecFilings 와 publisher_recovery 의 configuredOfficialHosts).
const PER_COMPANY_SOURCE_KEYS = new Set(["official_feeds", "official_pages", "official_sitemaps", "sec_filers"]);

// 기업 체크포인트 식별자. 전에는 출처 설정 전체를 넣어, 한 기업의 출처만 고쳐도 77개 기업을 모두 다시 받았다.
// 이제 그 기업의 결과를 바꿀 수 있는 것만 넣는다: 회사 항목, 출처 설정의 자기 몫, 사업동향 탐색 입력의 자기 몫,
// 수집 설정 전체(기간·출처 목록·상한·링크 정책 등), 수집 버전.
// 기업별 항목이 아닌 출처 설정 최상위 값은 통째로 넣는다. 수집기가 나중에 전역 값을 읽게 돼도 빠지지 않게 하려는
// 것이다. 설명문을 고쳐도 다시 받게 되지만 드문 일이다.
export function companySourceConfig(sourceConfig, company) {
  return Object.fromEntries(Object.entries(sourceConfig || {}).map(([key, value]) =>
    [key, PER_COMPANY_SOURCE_KEYS.has(key) ? value?.[company.company] ?? null : value]));
}

// 사업동향 탐색 입력의 기업 몫. 탐색은 기술 매핑의 자기 항목, 그 항목의 기술 그룹 키워드, 자기 검색어만 쓴다.
// 키워드 파일의 groups 밖 값은 전역 값이라 통째로 넣는다. 상한이 0이면 탐색을 돌리지 않으므로 넣지 않는다.
export function companyTrendInputs(args, company, technology = trendTechnology, keywordConfig = trendKeywordConfig,
  searchTerms = trendSearchTerms) {
  if (!(args.maxTrendDiscovery > 0)) return null;
  const entry = companyTechnology(company, technology);
  const { groups, ...keywordSettings } = keywordConfig || {};
  // 질의용 회사명은 적은 기업에만 키를 넣는다. 빈 값을 모든 기업에 넣으면 그것만으로 77개 기업의 식별자가
  // 바뀌어 캐시된 수집을 통째로 다시 돈다.
  const searchNames = companySearchNames(company, searchTerms);
  return { maxTrendDiscovery: args.maxTrendDiscovery, technology: entry, keywordSettings,
    keywordGroup: entry ? groups?.[entry.technology_group] ?? null : null,
    searchTerms: companySearchTerms(company, searchTerms), ...(searchNames.length ? { searchNames } : {}) };
}

function companyTechnology(company, technology) {
  return technology?.companies?.find(
    (item) => item.company === company.company && item.target_no === company.target_no) || null;
}

export function companyCollectionIdentity({ company, sourceConfig, args, selectedSources, dateRange, trendInputs }) {
  const { outDir, refresh, ...settings } = args;
  return { version: CONTENT_COLLECTION_VERSION, company, sourceConfig: companySourceConfig(sourceConfig, company),
    trend: trendInputs, settings, active_sources: selectedSources,
    period: { from: dateRange.fromDate, to: dateRange.toDate } };
}

// 기업별로 손으로 적는 검색어. 카탈로그는 기술 그룹 단위라 제품명·시장 표현을 담지 못한다.
// Norsk Hydro 의 8월 사업동향이 그 틈으로 빠졌다: 외부 보도 제목이 "recycled alu alloy" 였고
// 그룹 키워드에는 그 표현도, 미국식 철자 "aluminum" 도 없었다. 여기 적으면 질의에 먼저 들어가고
// 사전 필터도 같이 통과시킨다. 없으면 없는 대로 카탈로그만 쓴다.
export function companySearchTerms(company, searchTerms) {
  const entry = searchTerms?.companies?.[company?.company];
  return (Array.isArray(entry) ? entry : []).map((term) => String(term || "").trim()).filter(Boolean);
}

// 사업동향 질의에만 쓰는 회사명. 기사에서 실제로 부르는 이름이 기업 목록의 표시명·별칭과 다른 기업이 있다.
// 2026-09 에는 EMM(Umicore) 가 "EMM(Umicore)"·"EMM Umicore"·"Umicore EMM" 으로만 검색돼 0건이었는데,
// 같은 기간 "Umicore" 로 찾으면 HS Hyosung 과 울산 실리콘 음극재 공장에 투자한다는 기사가 나왔다.
// Toppan Holdings 도 "TOPPAN Holdings" 로만 찾았다. 기사는 대개 "Toppan" 이라 쓴다.
// 별칭(target_companies.json 의 query_aliases)을 고치지 않고 여기 두는 것은, 별칭이 판정 모델에 가는
// 기업 식별 정보(target_identity)라 고치면 그 기업의 저장된 판정이 모두 무효가 되기 때문이다.
// 여기 적은 이름은 질의에만 쓰고 판정에는 가지 않는다. 적으면 기본 이름 대신 이것만 쓴다.
export function companySearchNames(company, searchTerms) {
  const entry = searchTerms?.company_names?.[company?.company];
  return (Array.isArray(entry) ? entry : []).map((name) => String(name || "").trim()).filter(Boolean);
}

export function trendKeywords(technology, keywordConfig, company = null, searchTerms = null) {
  if (!technology) return [];
  const group = keywordConfig?.groups?.[technology.technology_group];
  const terms = [...companySearchTerms(company, searchTerms), technology.target_technology_en,
    ...(group?.keywords || []), technology.target_technology]
    .map((term) => String(term || "").trim())
    .filter(Boolean);
  // 대소문자만 다른 중복을 없애고 원래 순서를 지킨다.
  return [...new Map(terms.map((term) => [term.toLowerCase(), term])).values()];
}

// 질의어 여섯 자리를 무엇으로 채울지. 설정 파일 순서는 사람이 적은 순서일 뿐 구체성과 무관하다.
// 카탈로그는 일부러 넓어서 "scrap", "recycling" 같은 항목이 앞자리를 차지하면, 회사명과 AND 로
// 묶여도 그 회사의 아무 기사나 걸려 여섯 자리를 낭비한다. 구체적인 것부터 넣는다.
//
// 등급 0: 기업별로 손으로 적은 검색어. 제품명·시장 표현이라 가장 구체적이다.
// 등급 1: 두 낱말 이상의 구(句). "recycled aluminium", "machine vision" 처럼 뜻이 좁다.
// 등급 2: 한 낱말이되 일반어도 약어도 아닌 것. "remelting", "electrodialysis" 처럼 분야어다.
// 등급 3: 일반어와 짧은 대문자 약어. "scrap", "recycling", "PEM", "AEM" 이 여기 든다.
//         앞 등급으로 여섯 자리가 차지 않을 때만 쓴다.
// 등급 4: 기술 매핑에서 자동 생성된 영문명. 실제 기사 표현인 카탈로그에도 같은 말이 있으면 제외한다.
const GENERIC_TREND_TERMS = new Set([
  "scrap", "recycling", "recycled", "recovery", "materials", "material", "metal", "metals",
  "non-ferrous", "nonferrous", "semiconductor", "semiconductors", "battery", "batteries",
  "chemical", "chemicals", "equipment", "manufacturing", "production", "technology", "technologies",
  "membrane", "membranes", "sensor", "sensors", "motor", "motors", "robot", "robotics",
]);
const isAcronym = (term) => /^[A-Z0-9-]{2,6}$/.test(term);

export function trendTermRank(term, overrides = [], generated = []) {
  if (overrides.some((item) => item.toLowerCase() === term.toLowerCase())) return 0;
  if (generated.some((item) => item.toLowerCase() === term.toLowerCase())) return 4;
  const words = term.split(/\s+/).filter(Boolean);
  if (words.length > 1) return 1;
  if (GENERIC_TREND_TERMS.has(term.toLowerCase()) || isAcronym(term)) return 3;
  return 2;
}

export function rankTrendQueryTerms(keywords, overrides = [], generated = []) {
  return keywords
    .filter(isLatinKeyword)
    .map((term, index) => ({ term, rank: trendTermRank(term, overrides, generated), index }))
    // 같은 등급에서는 카탈로그 순서를 지킨다. 그 순서는 실제 기사에서 쓰는 대표 표현을 먼저 적어 둔
    // 순서라, 글자 수만 긴 드문 표현이 앞서는 것을 막고 실행마다 질의가 흔들리지 않게 한다.
    .sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
    .map((item) => item.term);
}

// 검색 창을 보고 기간에 맞춘다. when:Nd 는 "요청 시점에서 N일 전"이라, 마감 한참 뒤에 수집을
// 돌리면 그 사이의 새 기사가 결과 자리를 채우고 정작 그 달 기사는 밀려난다. 2026-09-18 에
// Norsk Hydro 를 when:50d 로 찾으면 6건 가운데 8월은 2건뿐이었고, 같은 질의를 after/before 로
// 바꾸면 3건이 모두 8월이었다(8/20 기사는 when 쪽에 아예 없었다).
// after 는 적은 날짜를 포함하고 before 는 제외한다. 확인: after:2026-08-03 before:2026-08-06 →
// 8/3·8/4·8/5 만 돌아온다. 그래서 끝날은 하루를 더해 넘긴다.
export function trendSearchWindow(dateRange) {
  if (dateRange?.mode === "explicit" && dateRange.fromDate && dateRange.toDate) {
    const dayAfter = new Date(Date.parse(`${dateRange.toDate}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
    return `after:${dateRange.fromDate} before:${dayAfter}`;
  }
  // 기간을 명시하지 않은 조회용 실행은 예전처럼 상대 창을 쓴다.
  return `when:${dateRange?.lookbackDays || 45}d`;
}

// 질의는 recall 을 맡고 정밀도는 사전 필터가 맡는다. 기업별 제품명·시장 표현을 가장 먼저 쓰고,
// 나머지는 구체적인 카탈로그 표현, 분야 단일어, 일반 단일어·약어 순으로 채운다. target_technology_en
// 같은 자동 생성 문구는 길다는 이유만으로 구체적인 표현처럼 보일 수 있지만 기자가 그대로 쓰지 않는다.
// 같은 시점 A/B 에서 이를 앞세우자 Albemarle 결과가 13건에서 0건, Nabtesco 가 2건에서 0건이 됐다.
// 따라서 자동 생성 문구는 사전 필터에는 남기되, 카탈로그에 같은 표현이 없을 때만 질의 맨 뒤로 민다.
export function selectTrendQueryTerms(keywords, overrides = [], limit = TREND_QUERY_KEYWORD_LIMIT,
  generated = []) {
  return rankTrendQueryTerms(keywords, overrides, generated).slice(0, limit);
}

export function trendCompanyNames(company, overrides, searchNames = []) {
  // 사람이 질의용으로 적은 이름이 있으면 그것만 쓴다. 표시명이 기사에 나오지 않는 이름이라
  // 기본 이름과 섞으면 세 자리 가운데 쓸모없는 자리만 늘어난다.
  if (searchNames.length) {
    return [...new Map(searchNames.map((name) => [name.toLowerCase(), name])).values()].slice(0, 3);
  }
  const names = relevantAliases(company);
  // 일반 Google 검색에서는 Hydro 같은 짧고 흔한 별칭을 빼야 하지만, 기업별 제품명·시장 표현과
  // 함께 찾을 때는 오탐 범위가 충분히 좁다. Norsk Hydro 정식명만 쓰면 제목이 "Hydro brings ..."
  // 로 시작하는 CIRCAL 기사가 검색 결과에서 빠졌다. 수동 검색어가 있는 기업에만 별칭을 복원한다.
  if (overrides.length) {
    for (const alias of company.query_aliases || []) {
      if (String(alias || "").trim().length >= 3) names.push(String(alias).trim());
    }
  }
  return [...new Map(names.map((name) => [name.toLowerCase(), name])).values()].slice(0, 3);
}

export function buildTrendQuery(company, technology, keywordConfig, dateRange, searchTerms = null) {
  const overrides = companySearchTerms(company, searchTerms);
  const keywords = trendKeywords(technology, keywordConfig, company, searchTerms);
  const catalogTerms = keywordConfig?.groups?.[technology.technology_group]?.keywords || [];
  const appearsInCatalog = (term) => catalogTerms.some((item) =>
    String(item || "").trim().toLowerCase() === String(term || "").trim().toLowerCase());
  const generatedOnly = [technology.target_technology_en, technology.target_technology]
    .filter((term) => term && !appearsInCatalog(term));
  // 영문 키워드가 하나도 없으면 질의를 만들지 않는다. 회사명만으로 검색하면 기술과 무관한
  // 기사가 쏟아져 사전 필터가 전부 걸러내고 요청만 버린다.
  const terms = selectTrendQueryTerms(keywords, overrides, TREND_QUERY_KEYWORD_LIMIT,
    generatedOnly);
  if (!terms.length) return "";
  const names = trendCompanyNames(company, overrides, companySearchNames(company, searchTerms));
  const nameClause = names.length > 1 ? `(${names.map((name) => `"${name}"`).join(" OR ")})` : `"${names[0]}"`;
  return `${nameClause} (${terms.map((term) => `"${term}"`).join(" OR ")}) ${trendSearchWindow(dateRange)}`;
}

// 사전 필터. 제목과 발췌에 타겟 기술 키워드가 실제로 있는 기사만 남긴다. Google 질의는 OR 를
// 느슨하게 해석해 회사명만 맞는 기사도 돌려주므로, 여기서 결정적으로 한 번 더 거른다.
// 이 판단은 후보 선택일 뿐 판정이 아니다. 걸러 남은 기사도 최종 판정은 LLM 이 한다.
const normalizeForMatch = (value) => articleTitleKey(value);

export function matchedTrendKeywords(row, keywords) {
  const haystack = normalizeForMatch(`${row.title || ""} ${row.discovery_snippet || ""}`);
  if (!haystack) return [];
  return keywords.filter((term) => {
    const needle = normalizeForMatch(term);
    if (needle.length < 3) return false;
    // 넓은 단일어는 형태가 다른 단어의 일부로 맞지 않게 한다. "scrap"이 "scrapped cars"를
    // 통과시켜 Hydro와 무관한 Mercedes 기사를 LLM 후보로 만든 실측 오탐을 막는다.
    if (/^[a-z0-9-]+$/i.test(needle)) {
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(haystack);
    }
    return haystack.includes(needle);
  });
}

// 이미 수집된 기사와 겹치는지. 추적 파라미터를 뗀 URL(articleUrlKey) 과 공백을 정리한 제목으로 본다.
// dedupeRows 와 같은 기준이라 뒤에서 한 번 더 걸러도 결과가 달라지지 않는다.
export function isDuplicateTrendRow(row, existingRows) {
  const urls = new Set(existingRows.map((item) => articleUrlKey(item.url)).filter(Boolean));
  const titles = new Set(existingRows.map((item) => articleTitleKey(item.title)).filter(Boolean));
  const rowUrl = articleUrlKey(row.url);
  if (rowUrl && urls.has(rowUrl)) return true;
  const rowTitle = articleTitleKey(row.title);
  return Boolean(rowTitle) && rowTitle.length > 15 && titles.has(rowTitle);
}

// 키워드 목록은 일부러 넓다("scrap", "recycling" 같은 항목이 있다). 그래서 통과한 기사 가운데
// 상한만큼의 자리를 어디에 줄지는 얼마나 구체적으로 맞았는지로 정한다. 맞은 키워드가 많을수록,
// 가장 긴 키워드가 길수록 앞에 둔다. 거르는 기준은 그대로이고 순서만 정하는 것이다.
function trendSpecificity(matched) {
  return [matched.length, Math.max(...matched.map((term) => term.length))];
}

export function selectTrendRows(rows, existingRows, keywords, limit) {
  const scored = [];
  for (const row of rows) {
    const matched = matchedTrendKeywords(row, keywords);
    if (matched.length) scored.push({ row, matched, rank: trendSpecificity(matched) });
  }
  // 동점이면 검색 결과 순서를 지킨다.
  scored.sort((a, b) => (b.rank[0] - a.rank[0]) || (b.rank[1] - a.rank[1]));
  const selected = [];
  const seen = [...existingRows];
  for (const { row, matched } of scored) {
    if (selected.length >= limit) break;
    if (isDuplicateTrendRow(row, seen)) continue;
    selected.push({ ...row, trend_discovery: true, trend_matched_terms: matched });
    seen.push(row);
  }
  return selected;
}

// Google News 검색 한 번. 실패해도 요청 한 건을 보냈으므로, 오류에 요청 수를 실어 collectCompany 가 세게 한다.
async function searchGoogleNews(params, timeoutSeconds) {
  try {
    return await fetchText(`https://news.google.com/rss/search?${params.toString()}`, timeoutSeconds);
  } catch (error) {
    throw Object.assign(error, { requestCount: 1 });
  }
}

async function collectTrendDiscovery(company, technology, keywordConfig, dateRange, timeoutSeconds, collectedAt, searchTerms = null) {
  const query = buildTrendQuery(company, technology, keywordConfig, dateRange, searchTerms);
  if (!query) return { rows: [], requestCount: 0, query: "" };
  const params = new URLSearchParams({ q: query, hl: "en-US", gl: "US", ceid: "US:en" });
  const xml = await searchGoogleNews(params, timeoutSeconds);
  // RSS 의 <description> 은 사전 필터가 보는 snippet 이다. parseRssOrAtom 은 공식 피드와 공용이라
  // 필드를 늘리지 않고, 여기서 제목으로 맞춰 붙인다. 본문을 받아오기 전이라 이것이 가진 전부다.
  const snippets = new Map();
  for (const item of blocks(xml, "item")) {
    const title = cleanText(tagText(item, "title"));
    if (title) snippets.set(title, cleanText(tagText(item, "description")));
  }
  const rows = filterByDateRange(
    parseRssOrAtom(xml, company, collectedAt, "google_news_trend", query, "Google News"),
    dateRange,
  ).map((row) => ({ ...row, ...fallbackSourceFields(90), official_source_url: "",
    discovery_snippet: snippets.get(row.title) || "" }))
    .filter((row) => !stockCommentary(row));
  return { rows, requestCount: 1, query };
}

async function collectGoogleNews(company, dateRange, maxPerSource, timeoutSeconds, collectedAt) {
  const query = buildQuery(company, dateRange);
  const params = new URLSearchParams({
    q: query,
    hl: "en-US",
    gl: "US",
    ceid: "US:en",
  });
  const xml = await searchGoogleNews(params, timeoutSeconds);
  return {
    rows: filterByDateRange(
      parseRssOrAtom(xml, company, collectedAt, "google_news_rss", query, "Google News"),
      dateRange,
    )
      .map((row) => ({
        ...row,
        ...fallbackSourceFields(90),
        official_source_url: "",
      }))
      // 상한보다 먼저 거른다. 뒤에서 거르면 주가 해설이 차지한 자리가 빈 채로 남는다.
      .filter((row) => !stockCommentary(row))
      .slice(0, maxPerSource),
    requestCount: 1,
  };
}

async function collectKoreaNews(company, dateRange, timeoutSeconds, collectedAt) {
  const query = buildKoreaQuery(company, dateRange);
  const params = new URLSearchParams({ q: query, hl: "en-US", gl: "US", ceid: "US:en" });
  const xml = await searchGoogleNews(params, timeoutSeconds);
  const rows = filterByDateRange(
    parseRssOrAtom(xml, company, collectedAt, "google_news_korea", query, "Google News"),
    dateRange,
  ).map((row) => ({ ...row, ...fallbackSourceFields(90), official_source_url: "" }))
    .filter((row) => !stockCommentary(row) && titleNamesCompany(row.title, relevantAliases(company)));
  return { rows, requestCount: 1, query };
}

// 같은 기사인지 볼 URL 키. 추적 파라미터와 # 만 뗀다(stripTracking). 예전에는 쿼리 전체를 지우고 경로를 소문자로
// 바꿔서, ?releaseid=1 과 ?releaseid=2 처럼 쿼리로 기사를 가르는 보도자료가 한 건으로 합쳐졌다.
export function articleUrlKey(url) {
  const text = String(url || "").trim();
  return text ? stripTracking(text) : "";
}

// 같은 기사인지 볼 제목 키. 대소문자와 공백만 맞춘다. 사업동향 사전 필터(normalizeForMatch)도 같은 정규화다.
export function articleTitleKey(title) {
  return String(title || "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function dedupeRows(rows) {
  const seen = new Set();
  const seenTitles = new Set();
  const deduped = [];
  for (const row of rows) {
    const urlKey = articleUrlKey(row.url);
    const key = `${row.company.toLowerCase()}|${urlKey || row.title.toLowerCase()}`;
    const titleKey = `${row.company.toLowerCase()}|${articleTitleKey(row.title)}`;
    if (seen.has(key)) continue;
    if (row.title.length > 15 && seenTitles.has(titleKey)) continue;
    seen.add(key);
    seenTitles.add(titleKey);
    deduped.push(row);
  }
  return deduped;
}

function rowDateEvidence(row) {
  if (Array.isArray(row.date_candidates) && row.date_candidates.length) return row.date_candidates;
  return [dateEvidence(row.published_at || row.published_month, row.published_at_source || 'none', 'published')].filter(Boolean);
}

// Exact official/relay duplicates should be one review article, but the Google
// feed can carry a useful publication date that the official index omitted.
// Merge that evidence into the retained official row; confirmed disagreement
// becomes a date conflict through the shared date policy.
export function mergePublisherDuplicateDates(officialRows, fallbackRows) {
  const byDirect = new Map();
  for (const row of fallbackRows) {
    if (!row.source_direct_url) continue;
    if (!byDirect.has(row.source_direct_url)) byDirect.set(row.source_direct_url, []);
    byDirect.get(row.source_direct_url).push(row);
  }
  const matched = new Set();
  const mergedOfficial = officialRows.map(row => {
    const direct = row.source_direct_url || row.url;
    const copies = byDirect.get(direct) || [];
    if (!copies.length) return row;
    copies.forEach(copy => matched.add(copy));
    const dates = chooseDateEvidence([row, ...copies].flatMap(rowDateEvidence));
    return { ...row, ...dates, publisher_resolution: 'official_exact_title_duplicate',
      publisher_resolution_source_url: copies[0].publisher_resolution_source_url,
      publisher_discovery_url: copies[0].url };
  });
  return { officialRows: mergedOfficial, fallbackRows: fallbackRows.filter(row => !matched.has(row)) };
}

// maxPerCompany 로 자를 때 무엇을 먼저 버릴지 정한다. link_rank 는 0=지금도 걷던 기사,
// 1=새로 받아들인 기사, 2=받아봐야 아는 후보다. 표시 순서가 아니라 잘라내는 순서라서,
// 자른 뒤에 sortRows 로 다시 정렬한다. 기본 정책에서는 모든 행이 0이라 아무것도 달라지지 않는다.
export function trimByRank(rows, limit) {
  // 같은 링크 순위 안에서는 정정·수정 공시를 뒤로 보낸다(correctionsLast 와 같은 이유).
  return [...rows].sort((a, b) => (a.link_rank ?? 0) - (b.link_rank ?? 0) || correctionLast(a) - correctionLast(b))
    .slice(0, limit);
}

// 대체 수집 뒤 기업 자리(maxPerCompany)를 채우는 순서: 이번 달로 쓸 수 있는 기사, 나머지 자체 출처,
// 대체 수집, 상세 페이지를 받아 보니 기간 밖이던 자체 출처. 목록에 날짜가 없어 자리를 받은 기사가
// 받아 보면 기간 밖인 경우가 많다. 2026-08 실행(34921453566)에서 538행 중 161행이 그랬고, BASF·Shin-Etsu·Maxon 은
// 이번 달 기사가 없어 Google News 를 찾고도 기간 밖 공식 기사 10건 뒤에 서서 남은 대체 기사가 없었다.
// 상세 페이지를 받기 전의 첫 상한은 링크 순위로만 자른다(trimByRank). 목록 날짜나 제목 연도만으로 기간 밖인 행은
// 출처 수집기가 이미 걸러 두었기 때문이다(filterByDateRange). 예전의 capCompanyRows 는 그런 행을 뒤로 미뤘지만
// 그 분기에 닿는 행이 없었다.
export function rankCompanyRows({ usable, rows, fallbackRows, dateRange, limit }) {
  const period = dateRangePeriod(dateRange);
  const outside = row => periodPlacement(row, period).placement === 'out_of_period';
  return trimByRank(dedupeRows([...usable, ...rows.filter(row => !outside(row)), ...fallbackRows, ...rows.filter(outside)]), limit);
}

export function selectDetailRows(rows, maxVerify = DEFAULT_MAX_VERIFY_PER_COMPANY) {
  return [...rows].filter(row => maxVerify > 0 || row.link_verdict !== 'fetch_to_verify')
    .sort((a, b) => acceptFirst(a) - acceptFirst(b));
}

function sortRows(rows) {
  return [...rows].sort((a, b) => {
    // 공식 보도자료를 항상 최우선으로 노출한다.
    const pressA = a.is_press_release ? 0 : 1;
    const pressB = b.is_press_release ? 0 : 1;
    if (pressA !== pressB) return pressA - pressB;
    const priority = Number(a.source_priority || 99) - Number(b.source_priority || 99);
    if (priority !== 0) return priority;
    const bDate = Date.parse(b.published_at || "") || 0;
    const aDate = Date.parse(a.published_at || "") || 0;
    return bDate - aDate;
  });
}

function toCsv(rows) {
  const escapeCell = (value) => {
    const raw = value === null || value === undefined ? "" : String(value);
    return /[",\n\r]/.test(raw) ? `"${raw.replace(/"/g, "\"\"")}"` : raw;
  };
  return [FIELDNAMES.join(","), ...rows.map((row) => FIELDNAMES.map((field) => escapeCell(row[field])).join(","))].join(
    "\n",
  ) + "\n";
}

async function writeResults(rows, summary, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  const timestamp = summary.run_started_at.replace(/[-:]/g, "");
  const paths = {
    json: path.join(outDir, `company_signals_${timestamp}.json`),
    csv: path.join(outDir, `company_signals_${timestamp}.csv`),
    summary: path.join(outDir, `collection_summary_${timestamp}.json`),
    latest_json: path.join(outDir, "latest_company_signals.json"),
    latest_csv: path.join(outDir, "latest_company_signals.csv"),
    latest_summary: path.join(outDir, "latest_collection_summary.json"),
  };
  summary.outputs = paths;
  await fs.writeFile(paths.json, JSON.stringify(rows, null, 2) + "\n", "utf8");
  await fs.writeFile(paths.csv, "\ufeff" + toCsv(rows), "utf8");
  await fs.writeFile(paths.summary, JSON.stringify(summary, null, 2) + "\n", "utf8");
  await fs.writeFile(paths.latest_json, JSON.stringify(rows, null, 2) + "\n", "utf8");
  await fs.writeFile(paths.latest_csv, "\ufeff" + toCsv(rows), "utf8");
  await fs.writeFile(paths.latest_summary, JSON.stringify(summary, null, 2) + "\n", "utf8");
}

async function loadJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (fallback !== null && error.code === "ENOENT") return fallback;
    throw error;
  }
}

// 기업 자리는 공식 출처와 발행사 요청의 동시 처리 수다. Google 링크는 전역 차례(createPublisherProbe)가
// 따로 한 번에 하나로 묶으므로, 그 차례를 기다리는 기업은 worker 에 넘기는 yieldSlot 으로 자리를 내놓는다.
// 2026-09-15 실행에서는 60초 휴식 세 번 동안 네 자리가 모두 Google 을 기다리며 묶여 있었다.
// 차례가 끝난 기업은 아직 시작하지 않은 기업보다 먼저 자리를 받아, 하던 기업을 먼저 끝내고 체크포인트를 남긴다.
export async function mapWithConcurrency(items, concurrency, worker) {
  let free = Math.max(1, Number(concurrency) || 1);
  const resuming = [], starting = [];
  const acquire = (waiters) => {
    if (free > 0) { free -= 1; return Promise.resolve(); }
    return new Promise(resolve => waiters.push(resolve));
  };
  const release = () => {
    const next = resuming.shift() || starting.shift();
    if (next) next(); else free += 1;
  };
  const yieldSlot = async (task) => {
    release();
    try { return await task(); } finally { await acquire(resuming); }
  };
  return Promise.all(items.map(async (item, index) => {
    await acquire(starting);
    try { return await worker(item, index, yieldSlot); } finally { release(); }
  }));
}

// Coverage for the Google News fallback decision only. A dated in-month row
// counts whether or not its body could be fetched: a press release we could
// only reach as a PDF is still real coverage for that month, and calling it
// absent sends the company to Google News instead. That trade is a bad one.
// Short target names ("EVG", "JSR", "Besi") match unrelated articles there, so
// the fallback replaces a press release we merely could not parse with one
// about a different company entirely.
// 다만 그 날짜는 확정된 것이어야 한다. URL·본문에서 미루어 짐작한 날짜 하나로 대체 수집을
// 멈추면 그 달 취재를 확인되지 않은 자료가 대신하게 된다.
export function usableMonthlySource(row, dateRange) {
  return reportEligible(row, dateRangePeriod(dateRange));
}

// 대체 수집을 돌릴지. 그달 기사가 하나도 없거나, 있어도 본문을 하나도 못 받았으면 돌린다.
// 본문 없는 기사는 판정에서 규칙으로 버려져, 그 기업은 그달 근거가 사실상 0건이 된다(2026-09: ASML, Syensqo,
// Safran, DNP). 위에서 걱정한 공식 보도자료 밀어내기는 rankCompanyRows 가 대체 기사를 맨 뒤에 두어 막으므로,
// 대체 기사는 남는 자리만 채우고 본문 없는 공식 기사도 그대로 남는다.
export function needsFallback(usableRows, minResults) {
  return usableRows.length < minResults || !usableRows.some(row => hasArticleBody(row));
}

// ---------------------------------------------------------------- SEC EDGAR 8-K
// 미국 상장 타겟기업의 수시공시. 뉴스룸이 수집을 막아도(403) 게시일과 원문이 확실하다.
// 대상은 설정의 sec_filers 에 티커로 확정한 CIK 만 쓴다. 이름 매칭은 Merck KGaA 를 미국
// Merck & Co. 로 잘못 잇는다. 내부자 거래(Form 3·4·144)는 8-K 가 아니므로 들어오지 않는다.
const SEC_ITEM_LABELS = {
  "1.01": "Entry into a Material Definitive Agreement",
  "1.02": "Termination of a Material Definitive Agreement",
  "2.01": "Completion of Acquisition or Disposition of Assets",
  "2.02": "Results of Operations and Financial Condition",
  "2.03": "Creation of a Direct Financial Obligation",
  "2.05": "Costs Associated with Exit or Disposal Activities",
  "2.06": "Material Impairments",
  "3.02": "Unregistered Sales of Equity Securities",
  "5.02": "Departure or Appointment of Directors or Officers",
  "5.03": "Amendments to Articles of Incorporation or Bylaws",
  "5.07": "Submission of Matters to a Vote of Security Holders",
  "7.01": "Regulation FD Disclosure",
  "8.01": "Other Events",
};

export function resolveSources(value, env = process.env) {
  const sources = String(value || "").split(",").map((source) => source.trim()).filter(Boolean);
  if (sources.includes("sec_filings") && !String(env.SEC_USER_AGENT || "").trim()) {
    return { sources: sources.filter((source) => source !== "sec_filings"), skipped: ["sec_filings: SEC_USER_AGENT not set"] };
  }
  return { sources, skipped: [] };
}

export function secFilingRows(company, filer, submissions, dateRange, collectedAt, maxPerSource = 6) {
  const recent = submissions?.filings?.recent || {};
  const cik = String(Number(filer.cik));
  const listUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${filer.cik}&type=8-K`;
  const rows = [];
  (recent.form || []).forEach((form, index) => {
    if (!/^8-K(\/A)?$/.test(form)) return;
    const accession = String(recent.accessionNumber?.[index] || "");
    const document = String(recent.primaryDocument?.[index] || "");
    if (!accession || !document) return;
    const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, "")}/${document}`;
    const items = String(recent.items?.[index] || "").split(",").map((item) => item.trim())
      .filter((item) => item && item !== "9.01");
    const labels = items.map((item) => `Item ${item} ${SEC_ITEM_LABELS[item] || ""}`.trim());
    rows.push({
      target_no: company.target_no,
      company: company.company,
      title: `${company.company} ${form}: ${labels.join("; ") || "Current report"}`,
      url,
      source: `${company.company} - SEC EDGAR / ${form}`,
      ...chooseDateEvidence([dateEvidence(recent.acceptanceDateTime?.[index] || recent.filingDate?.[index], "feed", "published")]),
      collected_at: collectedAt,
      collector: "sec_edgar",
      query: listUrl,
      ...officialSourceFields("filing", "SEC filing", url),
      official_source_url: listUrl,
      source_direct_url: url,
      sec_items: items,
    });
  });
  return filterByDateRange(rows, dateRange).slice(0, maxPerSource);
}

// SEC 공정 접근 정책(초당 10건 이하)을 넉넉히 지키려고 SEC 요청은 한 줄로 세운다.
let secQueue = Promise.resolve();
function secFetchText(url, timeoutSeconds) {
  const run = secQueue.then(() => fetchText(url, timeoutSeconds));
  secQueue = run.then(() => sleep(150), () => sleep(150));
  return run;
}

async function collectSecFilings(company, sourceConfig, dateRange, maxPerSource, timeoutSeconds, collectedAt) {
  const filer = sourceConfig.sec_filers?.[company.company];
  if (!filer) return { rows: [], requestCount: 0 };
  let requestCount = 1;
  const submissions = JSON.parse(await secFetchText(`https://data.sec.gov/submissions/CIK${filer.cik}.json`, timeoutSeconds));
  const rows = secFilingRows(company, filer, submissions, dateRange, collectedAt, maxPerSource);
  for (const row of rows) {
    // 실적·보도자료 8-K 의 본문은 첨부 EX-99 에 있다. 본 문서는 항목 목록뿐인 경우가 많다.
    try {
      requestCount += 1;
      const index = JSON.parse(await secFetchText(row.url.replace(/[^/]+$/, "index.json"), timeoutSeconds));
      const exhibit = (index.directory?.item || []).map((item) => item.name)
        .find((name) => /ex-?99/i.test(name) && /\.html?$/i.test(name));
      if (exhibit) {
        row.sec_primary_document_url = row.url;
        row.url = row.url.replace(/[^/]+$/, exhibit);
        row.source_direct_url = row.url;
      }
    } catch {
      // 첨부 목록을 못 읽으면 본 문서를 그대로 쓴다.
    }
  }
  return { rows, requestCount };
}

// ---------------------------------------------------------------- dated news sitemaps
// 사이트맵의 lastmod 는 게시일이 아니다(2026-08 조사: 8월 lastmod 874건 중 제품·옛 페이지가 대부분).
// URL 에 박힌 게시 시점만 쓴다. /2026/08/, infxx202607-113, ze260803 세 모양을 읽는다.
export function sitemapUrlDate(url) {
  const direct = extractDateFromUrl(url);
  if (direct) return direct;
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const yearMonth = pathname.match(/\/((?:19|20)\d{2})\/(0[1-9]|1[0-2])\//);
  if (yearMonth) return `${yearMonth[1]}-${yearMonth[2]}`;
  const folder = pathname.match(/\/((?:19|20)\d{2})\/[a-z]*(\d{6,8})(?:[-_.]|$)/i);
  if (!folder) return null;
  const [, year, digits] = folder;
  const valid = (month, day) => Number(month) >= 1 && Number(month) <= 12 && (!day || (Number(day) >= 1 && Number(day) <= 31));
  if (digits.startsWith(year)) {
    const month = digits.slice(4, 6);
    const day = digits.length >= 8 ? digits.slice(6, 8) : "";
    if (!valid(month, day)) return null;
    return day ? isoDate(year, month, day) : `${year}-${month}`;
  }
  if (digits.length === 6 && digits.slice(0, 2) === year.slice(2)) {
    const month = digits.slice(2, 4);
    const day = digits.slice(4, 6);
    return valid(month, day) ? isoDate(year, month, day) : null;
  }
  return null;
}

export function sitemapRows(xml, company, entry, dateRange, collectedAt) {
  const include = entry.include ? new RegExp(entry.include, "i") : null;
  const sourceName = entry.source || `${company.company} - Official news sitemap`;
  const rows = [];
  for (const match of String(xml || "").matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
    const loc = (match[1].match(/<loc>\s*([^<\s]+)\s*<\/loc>/i) || [])[1];
    if (!loc || (include && !include.test(loc))) continue;
    const when = sitemapUrlDate(loc);
    if (!when) continue;
    rows.push({
      target_no: company.target_no,
      company: company.company,
      // URL 에서 뽑은 제목이 짧으면 비워 둔다. URL 을 제목으로 넣으면 상세 페이지 제목으로 바뀌지 않는다.
      title: titleFromUrl(loc),
      url: loc,
      source: sourceName,
      ...chooseDateEvidence([dateEvidence(when, "url", "context")]),
      collected_at: collectedAt,
      collector: "official_sitemap",
      query: entry.url,
      ...officialSourceFields(entry.kind || "press_release", sourceName, entry.url, loc),
      official_source_url: entry.url,
      source_direct_url: directUrlCandidate(loc),
    });
  }
  return filterByDateRange(rows, dateRange)
    .sort((a, b) => String(b.published_at || b.published_month || "").localeCompare(String(a.published_at || a.published_month || "")));
}

async function collectOfficialSitemaps(company, sourceConfig, dateRange, maxPerSource, timeoutSeconds, collectedAt) {
  const entries = sourceConfig.official_sitemaps?.[company.company] || [];
  const rows = [];
  const errors = [];
  let requestCount = 0;
  for (const entry of entries) {
    try {
      requestCount += 1;
      const xml = await fetchText(entry.url, timeoutSeconds);
      rows.push(...correctionsLast(sitemapRows(xml, company, entry, dateRange, collectedAt)).slice(0, maxPerSource));
    } catch (error) {
      errors.push({ source_url: entry.url, source_name: entry.source || "Official news sitemap", kind: "sitemap", error: error.message });
    }
  }
  return { rows, requestCount, errors };
}

function collectSource(source, company, sourceConfig, args, dateRange, collectedAt) {
  if (source === "official_feeds") {
    return collectOfficialFeeds(company, sourceConfig, dateRange, args.maxPerSource, args.timeoutSeconds, collectedAt, args.contentCharLimit);
  } else if (source === "official_pages") {
    return collectOfficialPages(company, sourceConfig, dateRange, args.maxPerSource, args.timeoutSeconds, collectedAt);
  } else if (source === "official_sitemaps") {
    return collectOfficialSitemaps(company, sourceConfig, dateRange, args.maxPerSource, args.timeoutSeconds, collectedAt);
  } else if (source === "sec_filings") {
    return collectSecFilings(company, sourceConfig, dateRange, args.maxPerSource, args.timeoutSeconds, collectedAt);
  }
  throw new Error(`Unknown source: ${source}`);
}

// options: yieldSlot·probe·log 는 상세 페이지 받기로 넘긴다(enrichOfficialRowsWithContent).
// log 의 단계는 출처 하나, 대체 수집 검색, 사업동향 검색, 상세 페이지 한 건이다. 이어 받을 때 다시 쓴 단계의
// 요청은 이번 실행의 요청 수에 더하지 않는다(collectWithCheckpoint 의 cached 기업과 같다).
// 기간 없이 돌린 조회의 검색 창(when:Nd)은 실행 날짜에 따라 달라지지만, 이어 받을 때는 처음 받은 검색 결과를 쓴다.
// 처음부터 다시 받는 기업은 지금처럼 새로 검색한다. trend: 시험용으로 사업동향 탐색 입력을 바꿔 넣는다.
// 링크 판정·제외 집계(tally)는 다시 쓴 단계까지 세어 stats 에 싣는다. 그래야 체크포인트·이어 받기와 무관하게 같다.
export async function collectCompany(company, sourceConfig, selectedSources, args, dateRange, collectedAt, options = {}) {
  const { log = createStepLog(), trend = {} } = options;
  const tally = createTally();
  const slot = { ...options, log, tally };
  const { technologyMap = trendTechnology, keywordConfig = trendKeywordConfig, searchTerms = trendSearchTerms } = trend;
  const companyRows = [];
  const publisherCandidates = [];
  const errors = [];
  let requestCount = 0;

  for (const source of selectedSources) {
    // Decide after official detail/date enrichment, not from undated listing links.
    if (source === "google_news") continue;
    let result = { rows: [], requestCount: 0 };
    let replayed = false;
    try {
      const step = await log.run(`source:${source}`, async () => {
        try {
          return await collectSource(source, company, sourceConfig, args, dateRange, collectedAt);
        } catch (error) {
          return { failed: error.message };
        }
      });
      replayed = step.replayed;
      if (step.value.failed !== undefined) throw new Error(step.value.failed);
      result = step.value;
      mergeTally(tally, result.tally);
      companyRows.push(...result.rows);
      publisherCandidates.push(...(result.recoveryCandidates || result.rows || []));
      if (!replayed) requestCount += result.requestCount;
      for (const sourceError of result.errors || []) {
        errors.push({
          target_no: company.target_no,
          company: company.company,
          source,
          ...sourceError,
        });
      }
    } catch (error) {
      errors.push({
        target_no: company.target_no,
        company: company.company,
        source,
        error: error.message,
      });
    }
    if (!replayed && result.requestCount > 0) {
      await sleep(args.rateLimitSeconds * 1000);
    }
  }

  // Drop disabled probes before the company cap; keep priority through fetching.
  // 확인 대상을 받아 보지 않기로 했으면(maxVerifyPerCompany=0) 여기서 빠지는 링크도 제외로 센다. 예전에는 기록 없이 사라졌다.
  const dedupedRows = sortRows(dedupeRows(companyRows));
  const candidateRows = selectDetailRows(dedupedRows, args.maxVerifyPerCompany);
  if (candidateRows.length < dedupedRows.length) {
    for (const row of dedupedRows.filter(item => !candidateRows.includes(item))) {
      recordExclusion(tally, row.company, row.title, row.url, "verify_budget_exhausted");
    }
  }
  // 출처 수집기가 이미 기간 밖 행을 걸러 두었으므로(filterByDateRange) 남은 행은 링크 순위로만 자른다.
  const selectedCompanyRows = trimByRank(candidateRows, args.maxPerCompany);
  const enriched = await enrichOfficialRowsWithContent(selectedCompanyRows, args, collectedAt, company, slot);
  requestCount += enriched.requestCount;
  errors.push(...enriched.errors);
  let rows = enriched.rows;
  const usable = rows.filter((row) => usableMonthlySource(row, dateRange));
  // 기업 자리와 대체 수집 생략이 이번 달 근거를 얼마나 가렸는지 남긴다. 이 기록 없이는 상한을 늘릴지 판단할 수 없다.
  const stats = { candidates: candidateRows.length, cut_by_company_cap: candidateRows.length - selectedCompanyRows.length,
    out_of_period_after_fetch: rows.filter(row => periodPlacement(row, dateRangePeriod(dateRange)).placement === 'out_of_period').length,
    usable_monthly: usable.length, fallback: selectedSources.includes("google_news") ? "skipped_has_monthly_source" : "not_selected" };
  if (selectedSources.includes("google_news") &&
      (args.fallbackMode !== "missing" || needsFallback(usable, args.fallbackMinResults))) {
    stats.fallback = "run";
    try {
      const { value: fallback, replayed } = await log.run("google_news",
        () => collectGoogleNews(company, dateRange, args.maxPerSource, args.timeoutSeconds, collectedAt));
      stats.fallback_found = fallback.rows.length;
      if (!replayed) requestCount += fallback.requestCount;
      if (!replayed && fallback.requestCount > 0) await sleep(args.rateLimitSeconds * 1000);
      const recoveredFallback = fallback.rows
        .map(row => recoverPublisherRow(row, publisherCandidates, sourceConfig));
      const split = mergePublisherDuplicateDates(rows.filter(row => row.source_type === 'official'), recoveredFallback);
      rows = [...split.officialRows, ...rows.filter(row => row.source_type !== 'official')];
      // Dated monthly evidence first, then the rest of what this company's own
      // sources returned, and only then the fallback. Ranking Google News above
      // an undated or unfetched official row let it push real press releases
      // out of maxPerCompany: 26 official rows were lost that way in the
      // 2026-08 run while fallback rows grew from 37 to 142.
      // Official rows the detail page dated outside the period go last (rankCompanyRows).
      rows = rankCompanyRows({ usable, rows, fallbackRows: split.fallbackRows, dateRange, limit: args.maxPerCompany });
      // 'always' 에서는 공식 기사가 기업 자리를 다 채워도 외부 기사 maxExternalNews 건까지는 상한 밖에 덧붙인다.
      // 순위로만 두면 공식 기사가 8건 이상인 기업(9월 77개사 중 28개사)은 외부 기사가 거의 들어오지 못한다.
      const keptFallback = rows.filter(row => row.source_type !== 'official').length;
      const reserved = args.fallbackMode === 'always' ? Math.max(0, args.maxExternalNews - keptFallback) : 0;
      if (reserved) {
        const extra = [];
        for (const row of split.fallbackRows) {
          if (extra.length >= reserved) break;
          if (!isDuplicateTrendRow(row, [...rows, ...extra])) extra.push(row);
        }
        rows = [...rows, ...extra];
        stats.fallback_reserved = extra.length;
      }
      const fallbackRows = rows.filter(row => row.source_type !== 'official');
      stats.fallback_kept = fallbackRows.length;
      const detailedFallback = await enrichOfficialRowsWithContent(fallbackRows, args, collectedAt, company, slot);
      requestCount += detailedFallback.requestCount;
      errors.push(...detailedFallback.errors);
      // 보강 결과를 그대로 쓴다. 본문 단계에서 뺀 대체 기사(no_article_title, verified_index_page 등)는 돌아오지
      // 않는다. 예전에는 빠진 행 자리에 원래 행을 다시 넣어, 제외로 집계된 기사가 결과에 남았다. 공식·사업동향 경로와 같다.
      const byUrl = new Map(detailedFallback.rows.map(row => [row.url, row]));
      rows = rows.flatMap(row => (row.source_type === 'official' ? [row] : byUrl.has(row.url) ? [byUrl.get(row.url)] : []));
    } catch (error) {
      stats.fallback = "error";
      requestCount += error.requestCount || 0;
      errors.push({ target_no: company.target_no, company: company.company, source: "google_news", error: error.message });
    }
  }

  // 사업동향 탐색은 대체 수집과 달리 공식 자료가 있어도 돌린다. 기업 자리(maxPerCompany)를 두고
  // 다투게 하면 공식 보도자료를 밀어내므로, 그 상한을 적용한 뒤에 최대 maxTrendDiscovery 건만 덧붙인다.
  const technology = companyTechnology(company, technologyMap);
  stats.trend_discovery = "not_selected";
  if (selectedSources.includes("google_news") && args.maxTrendDiscovery > 0 && technology) {
    stats.trend_discovery = "run";
    try {
      const { value: discovered, replayed } = await log.run("google_news_trend",
        () => collectTrendDiscovery(company, technology, keywordConfig, dateRange, args.timeoutSeconds, collectedAt, searchTerms));
      if (!replayed) requestCount += discovered.requestCount;
      if (!replayed && discovered.requestCount > 0) await sleep(args.rateLimitSeconds * 1000);
      if (!discovered.query) stats.trend_discovery = "no_query";
      stats.trend_discovery_found = discovered.rows.length;
      const keywords = trendKeywords(technology, keywordConfig, company, searchTerms);
      const selected = selectTrendRows(discovered.rows, rows, keywords, args.maxTrendDiscovery);
      stats.trend_discovery_kept = selected.length;
      if (selected.length) {
        const recovered = selected.map(row => recoverPublisherRow(row, publisherCandidates, sourceConfig));
        const detailed = await enrichOfficialRowsWithContent(recovered, args, collectedAt, company, slot);
        requestCount += detailed.requestCount;
        errors.push(...detailed.errors);
        rows = [...rows, ...detailed.rows];
      }
    } catch (error) {
      stats.trend_discovery = "error";
      requestCount += error.requestCount || 0;
      errors.push({ target_no: company.target_no, company: company.company, source: "google_news_trend", error: error.message });
    }
  }

  // 한국 관련 검색. 사업동향 탐색처럼 기업 자리를 다투지 않고 맨 뒤에 최대 maxKoreaNews 건을 덧붙인다.
  stats.korea_news = "not_selected";
  if (selectedSources.includes("google_news") && args.maxKoreaNews > 0) {
    stats.korea_news = "run";
    try {
      const { value: found, replayed } = await log.run("google_news_korea",
        () => collectKoreaNews(company, dateRange, args.timeoutSeconds, collectedAt));
      if (!replayed) requestCount += found.requestCount;
      if (!replayed && found.requestCount > 0) await sleep(args.rateLimitSeconds * 1000);
      stats.korea_news_found = found.rows.length;
      const selected = [];
      for (const row of found.rows) {
        if (selected.length >= args.maxKoreaNews) break;
        if (!isDuplicateTrendRow(row, [...rows, ...selected])) selected.push({ ...row, korea_discovery: true });
      }
      stats.korea_news_kept = selected.length;
      if (selected.length) {
        const recovered = selected.map(row => recoverPublisherRow(row, publisherCandidates, sourceConfig));
        const detailed = await enrichOfficialRowsWithContent(recovered, args, collectedAt, company, slot);
        requestCount += detailed.requestCount;
        errors.push(...detailed.errors);
        rows = [...rows, ...detailed.rows];
      }
    } catch (error) {
      stats.korea_news = "error";
      requestCount += error.requestCount || 0;
      errors.push({ target_no: company.target_no, company: company.company, source: "google_news_korea", error: error.message });
    }
  }
  return { rows, requestCount, errors, stats: { ...stats, ...tally } };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let companies = await loadJson(args.companies);
  const numbers = companies.map((company) => Number(company.target_no));
  if (numbers.length !== 77 || numbers.some((number, index) => number !== index + 1)) {
    throw new Error(`Expected target_no 1..77 in ${args.companies}`);
  }
  if (args.companyLimit > 0) {
    companies = companies.slice(0, args.companyLimit);
  }

  fetchRetries = Number.isFinite(args.fetchRetries) && args.fetchRetries >= 0 ? args.fetchRetries : 2;
  linkPolicy = args.linkPolicy === "proposed" ? "proposed" : "current";

  const sourceConfig = await loadJson(args.sourceConfig, {});
  // 파일이 없으면 탐색만 건너뛴다. 나머지 수집은 그대로 돈다.
  trendTechnology = await loadJson(args.technologyMap, null);
  trendKeywordConfig = await loadJson(args.keywordConfig, null);
  // 기업별 검색어는 선택 사항이다. 파일이 없으면 카탈로그만 쓴다.
  trendSearchTerms = await loadJson(args.searchTerms, {});
  if (args.maxTrendDiscovery > 0 && !(trendTechnology && trendKeywordConfig)) {
    console.warn(`Skipping business-trend discovery: ${args.technologyMap} or ${args.keywordConfig} is unavailable`);
  }
  // SEC 는 연락처가 든 User-Agent 없이 요청하지 않는다. 설정이 없으면 그 출처만 건너뛰고 요약에 남긴다.
  const { sources: selectedSources, skipped: skippedSources } = resolveSources(args.sources);
  for (const skipped of skippedSources) console.warn(`Skipping source ${skipped}`);
  const collectedAt = utcNow();
  const dateRange = buildDateRange(args, collectedAt);
  const rows = [];
  const errors = [];
  let requestCount = 0;

  const companyResults = await mapWithConcurrency(
    companies,
    args.companyConcurrency,
    async (company, index, yieldSlot) => {
      const started = Date.now();
      const result = await collectWithCheckpoint({ directory: path.join(args.outDir, 'company_progress'),
        identity: companyCollectionIdentity({ company, sourceConfig, args, selectedSources, dateRange,
          trendInputs: companyTrendInputs(args, company) }), refresh: args.refresh, toDate: dateRange.toDate,
        collect: (log) => collectCompany(company, sourceConfig, selectedSources, args, dateRange, collectedAt, { yieldSlot, log }) });
      result.timing = { company: company.company, elapsed_ms: Date.now() - started,
        request_count: result.requestCount, result_count: result.rows.length, cached: result.cached,
        ...(result.resumed ? { resumed: true } : {}) };
      console.log(`Collected ${company.company}: ${result.rows.length} rows in ${(result.timing.elapsed_ms / 1000).toFixed(1)}s`);
      return result;
    },
  );
  for (const result of companyResults) {
    rows.push(...result.rows);
    requestCount += result.requestCount;
    errors.push(...result.errors);
  }

  const finalRows = sortRows(dedupeRows(rows));
  const tally = companyResults.reduce((total, result) => mergeTally(total, result.stats), createTally());
  const samplesByReason = summarySamples(tally.excluded_non_article_samples);
  const countsByCompany = Object.fromEntries(companies.map((company) => [company.company, 0]));
  const officialCountsByCompany = Object.fromEntries(companies.map((company) => [company.company, 0]));
  for (const row of finalRows) {
    countsByCompany[row.company] += 1;
    if (row.source_type === "official") {
      officialCountsByCompany[row.company] += 1;
    }
  }

  const summary = {
    run_started_at: collectedAt,
    collection_resume_version: 1,
    collection_input_digest: collectionInputDigest(companies, sourceConfig, trendDigestInputs(args), newsDigestInputs(args)),
    html_network: domainGuard.stats,
    cached_company_count: companyResults.filter(result => result.cached).length,
    // 재시도할 까닭이 상세 페이지 단계에만 남아, 받아 둔 단계는 다시 쓰고 실패·멈춘 기사만 다시 받은 기업.
    resumed_company_count: companyResults.filter(result => result.resumed).length,
    retryable_company_count: companyResults.filter(retryableCollection).length,
    collection_coverage: companies.map((company, index) => ({ company: company.company,
      status: collectionBlockingErrors(companyResults[index].errors).length ? 'incomplete' : 'completed',
      retryable: retryableCollection(companyResults[index]), cached: companyResults[index].cached })),
    run_finished_at: utcNow(),
    company_timings: companyResults.map(result => result.timing),
    // 체크포인트에서 온 옛 결과에는 stats 가 없어 기업 이름만 남는다.
    // 제외 표본은 아래 excluded_non_article_samples 에 모으므로 기업별 줄에서는 뺀다.
    company_collection_stats: companies.map((company, index) => {
      const { excluded_non_article_samples, ...stats } = companyResults[index].stats || {};
      return { company: company.company, ...stats };
    }),
    companies_cut_by_company_cap: companyResults.filter(result => result.stats?.cut_by_company_cap > 0).length,
    fallback_skipped_company_count: companyResults.filter(result => result.stats?.fallback === 'skipped_has_monthly_source').length,
    // 사업동향 탐색이 실제로 몇 건을 보탰는지. 이 숫자가 곧 늘어난 LLM 호출 수다.
    trend_discovery_company_count: companyResults.filter(result => result.stats?.trend_discovery === 'run').length,
    trend_discovery_found: companyResults.reduce((total, result) => total + (result.stats?.trend_discovery_found || 0), 0),
    trend_discovery_kept: companyResults.reduce((total, result) => total + (result.stats?.trend_discovery_kept || 0), 0),
    trend_discovery_per_company: args.maxTrendDiscovery,
    // 공식 기사가 자리를 채워도 상한 밖에 덧붙인 외부 기사(fallbackMode always), 한국 관련 검색이 보탠 기사.
    external_news_reserved: companyResults.reduce((total, result) => total + (result.stats?.fallback_reserved || 0), 0),
    external_news_per_company: args.maxExternalNews,
    korea_news_found: companyResults.reduce((total, result) => total + (result.stats?.korea_news_found || 0), 0),
    korea_news_kept: companyResults.reduce((total, result) => total + (result.stats?.korea_news_kept || 0), 0),
    korea_news_per_company: args.maxKoreaNews,
    // Google News 기사가 발행사 본문에 닿은 두 경로를 따로 센다. 예전 publisher_resolution_count 는 제목 대조만
    // 세서, 해독으로 50건을 받은 9월 28일 실행에서도 0이라 해독이 안 되는 것처럼 읽혔다.
    google_news_rows: finalRows.filter(row => isGoogle(row.url)).length,
    // 중계 주소를 해독(또는 리다이렉트)해 발행사 본문을 받은 행.
    google_news_decoded_count: finalRows.filter(row => isGoogle(row.url) && !row.publisher_resolution &&
      row.content_fetch_status === 'fetched' && row.content_source_url && !isGoogle(row.content_source_url)).length,
    // 같은 제목의 공식 보도자료로 바꿔 받은 행(recoverPublisherRow).
    official_title_recovery_count: finalRows.filter(row => row.publisher_resolution === 'official_exact_title').length,
    // 시도했지만 해독도 리다이렉트도 발행사에 닿지 못한 행과, 그 해독 실패 사유.
    google_news_unresolved_count: errors.filter(error => error.error === 'publisher_url_unresolved').length,
    google_news_decode_failures: errors.reduce((counts, error) => {
      if (error.decode_failure) counts[error.decode_failure] = (counts[error.decode_failure] || 0) + 1;
      return counts;
    }, {}),
    // Google 확인이 멈춰 요청을 보내지 않은 행. 0보다 크면 그 기업들은 재시도 대상이다.
    google_probe_paused_count: finalRows.filter(row => row.content_fetch_status === 'google_probe_paused').length,
    // Google 차례의 이번 실행 기록: 보낸 요청, 429 수, 쉰 횟수와 시간, 429 뒤 다시 보낸 기사, 막혀서 요청 없이 넘긴 기사.
    // 9월 15일 점검에서 이런 기록이 없어 막힘이 시간을 얼마나 먹었는지 가를 수 없었다. 이어 받은 단계는 세지 않는다.
    google_probe_stats: { ...probePublisher.stats },
    // 원문을 못 읽어 피드 요약을 본문으로 쓴 행. 판정은 요약만 보고 한 것이다.
    feed_summary_body_count: finalRows.filter(row => row.content_source === 'feed_summary').length,
    company_count: companies.length,
    canonical_company_count: 77,
    sources: selectedSources,
    skipped_sources: skippedSources,
    days: args.days,
    date_range_mode: dateRange.mode,
    from_date: dateRange.fromDate,
    to_date: dateRange.toDate,
    lookback_days: dateRange.lookbackDays,
    max_per_source: args.maxPerSource,
    max_per_company: args.maxPerCompany,
    company_concurrency: args.companyConcurrency,
    fetch_official_content: args.fetchOfficialContent,
    content_collection_version: CONTENT_COLLECTION_VERSION,
    content_char_limit: args.contentCharLimit,
    max_detail_per_company: args.maxDetailPerCompany,
    fallback_mode: args.fallbackMode,
    fallback_min_results: args.fallbackMinResults,
    request_count: requestCount,
    fetch_retries: args.fetchRetries,
    retry_count: retryCount,
    result_count: finalRows.length,
    official_result_count: finalRows.filter((row) => row.source_type === "official").length,
    press_release_result_count: finalRows.filter((row) => row.is_press_release).length,
    undated_result_count: finalRows.filter((row) => resolveDateState(row).status === "unknown").length,
    // 날짜 상태별 집계. 복구한 건수와 보류 중인 건수를 회차마다 비교할 수 있어야 기준 변경의 효과를 본다.
    date_status_counts: finalRows.reduce((counts, row) => {
      const status = resolveDateState(row).status;
      counts[status] = (counts[status] || 0) + 1;
      return counts;
    }, {}),
    month_only_result_count: finalRows.filter((row) => resolveDateState(row).precision === "month").length,
    date_conflict_result_count: finalRows.filter((row) => row.date_conflict === true).length,
    undated_with_body_count: finalRows.filter((row) => resolveDateState(row).status === "unknown" && hasArticleBody(row)).length,
    link_policy: linkPolicy,
    // 링크 판정·제외 집계는 체크포인트에서 다시 쓴 기업과 이어 받은 기업까지 모든 기업의 합이다(createTally).
    // request_count·retry_count 는 이번 실행이 실제로 보낸 요청과 재시도만 센다.
    link_verdict_counts: tally.link_verdict_counts,
    max_verify_per_company: args.maxVerifyPerCompany,
    excluded_non_article_count: tally.excluded_non_article_count,
    excluded_non_article_reasons: tally.excluded_non_article_reasons,
    excluded_non_article_sample_count: [...samplesByReason.values()].flat().length,
    excluded_non_article_samples: [...samplesByReason.values()].flat(),
    excluded_non_article_sample_reasons: Object.fromEntries(
      [...samplesByReason].map(([reason, rows]) => [reason, rows.length]),
    ),
    published_at_source_counts: finalRows.reduce((counts, row) => {
      const key = row.published_at_source || "none";
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {}),
    fallback_result_count: finalRows.filter((row) => row.source_type !== "official").length,
    companies_with_results: Object.values(countsByCompany).filter((count) => count > 0).length,
    companies_with_official_results: Object.values(officialCountsByCompany).filter((count) => count > 0).length,
    companies_without_results: Object.entries(countsByCompany)
      .filter(([, count]) => count === 0)
      .map(([company]) => company),
    counts_by_company: countsByCompany,
    official_counts_by_company: officialCountsByCompany,
    error_count: errors.length,
    errors,
  };

  await writeResults(finalRows, summary, args.outDir);
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
