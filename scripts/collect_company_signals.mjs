import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { chooseDateEvidence, hasArticleBody, periodPlacement, reportEligible, resolveDateState } from "./date_state.mjs";
export const CONTENT_COLLECTION_VERSION = 'article-body-v3';

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
  "content_excerpt",
  "content_word_count",
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

// 기사가 아니라고 판단해 제외한 링크. 필터가 과했는지 사후에 검증할 수 있어야 한다.
// 집계는 전량을 세고, 샘플만 상한을 둔다. 예전에는 둘 다 상한에 걸려 총 제외 건수를 알 수 없었다.
const excludedRows = [];
const excludedCounts = new Map();
let excludedTotal = 0;
const EXCLUDED_SAMPLE_LIMIT = 120;
const EXCLUDED_SAMPLE_PER_COMPANY = 4;

function recordExclusion(company, title, url, reason) {
  excludedTotal += 1;
  excludedCounts.set(reason, (excludedCounts.get(reason) || 0) + 1);
  // 한 회사가 샘플을 다 차지하면 다른 회사의 오제외를 못 본다. 회사당 몇 건씩만 남긴다.
  const seenForCompany = excludedRows.filter((row) => row.company === company).length;
  if (excludedRows.length < EXCLUDED_SAMPLE_LIMIT && seenForCompany < EXCLUDED_SAMPLE_PER_COMPANY) {
    excludedRows.push({ company, title: cleanText(title).slice(0, 120), url, reason });
  }
}

function parseArgs(argv) {
  const args = {
    companies: "data/target_companies.json",
    sourceConfig: "config/company_sources.json",
    outDir: "outputs",
    sources: "official_feeds,official_pages,google_news",
    days: 45,
    fromDate: "",
    toDate: "",
    maxPerSource: 3,
    maxPerCompany: 6,
    fallbackMinResults: 1,
    fallbackMode: "missing",
    rateLimitSeconds: 1.0,
    timeoutSeconds: 20,
    companyLimit: 0,
    companyConcurrency: 1,
    fetchOfficialContent: true,
    contentCharLimit: 24000,
    contentExcerptLimit: 800,
    maxDetailPerCompany: 8,
    fetchRetries: 2,
  };
  const keyMap = {
    "--companies": "companies",
    "--source-config": "sourceConfig",
    "--out-dir": "outDir",
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
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!keyMap[key]) continue;
    const mapped = keyMap[key];
    const value = argv[index + 1];
    index += 1;
    if (
      [
        "days",
        "maxPerSource",
        "maxPerCompany",
        "fallbackMinResults",
        "timeoutSeconds",
        "companyLimit",
        "companyConcurrency",
        "contentCharLimit",
        "contentExcerptLimit",
        "maxDetailPerCompany",
        "fetchRetries",
      ].includes(mapped)
    ) {
      args[mapped] = Number.parseInt(value, 10);
    } else if (mapped === "rateLimitSeconds") {
      args[mapped] = Number.parseFloat(value);
    } else if (mapped === "fetchOfficialContent") {
      args[mapped] = !["0", "false", "no"].includes(String(value).toLowerCase());
    } else {
      args[mapped] = value;
    }
  }
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

function cleanHtmlText(value = "") {
  return decodeXml(value)
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

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

// 목록 페이지 URL에 흔히 붙는 로케일 세그먼트. en-us, ko_KR, zh-hans 형태를 모두 받는다.
const LOCALE_SEGMENT = /^[a-z]{2}([-_][a-z0-9]{2,5})?$/;

// 코드 대신 언어 이름을 쓰는 사이트도 많다. sumitomo-chem.co.jp/english/news/ 같은 경우.
const LOCALE_WORDS = new Set([
  "english",
  "japanese",
  "korean",
  "chinese",
  "deutsch",
  "german",
  "french",
  "francais",
  "spanish",
  "espanol",
  "italiano",
  "portugues",
]);

function isLocaleSegment(segment) {
  return LOCALE_SEGMENT.test(segment) || LOCALE_WORDS.has(segment);
}

// 기사 한 건이 아니라 기사 묶음을 가리키는 경로 조각.
const INDEX_SEGMENTS = new Set([
  "en",
  "global",
  "corporate",
  "company",
  "about",
  "about-us",
  "news",
  "news-events",
  "news-and-events",
  "news-and-insights",
  "news-insights",
  "newsroom",
  "news-room",
  "newsreleases",
  "news-release",
  "news-releases",
  "media",
  "media-center",
  "media-centre",
  "mediacenter",
  "media-gallery",
  "media-library",
  "medialibrary",
  "social-media",
  "video-center",
  "video-centre",
  "press",
  "pressroom",
  "press-room",
  "press-kit",
  "press-kits",
  "press-release",
  "press-releases",
  "pressreleases",
  "releases",
  "stories",
  "featured-stories",
  "blog",
  "blogs",
  "events",
  "insights",
  "publications",
  "library",
  "resources",
  "investor",
  "investors",
  "investor-relations",
  "ir",
  "announcements",
  "announcement",
  "annual-general-meeting",
  "financial-results",
  "results",
  "reports",
  "sustainability",
  "esg",
  "responsibility",
  "overview",
  "archive",
  "archives",
  "all",
  "latest",
  "index",
  "home",
  "default",
]);

// 목록 페이지임을 확정적으로 드러내는 경로. 카테고리·태그·페이지네이션은 기사 URL이 될 수 없다.
function hasIndexOnlyPathMarker(parsed) {
  const pathname = parsed.pathname.toLowerCase();
  if (/\/(category|categories|kategorie|tag|tags|topic|topics|subject|filter|search|page)\//.test(pathname)) return true;
  if (/\/page[/-]\d+\/?$/.test(pathname)) return true;
  for (const key of parsed.searchParams.keys()) {
    // ?p=123 은 워드프레스에서 개별 글을 가리키므로 페이지네이션으로 보지 않는다.
    if (/^(page|paged|offset|start|category|cat|tag|topic|filter|label)$/i.test(key)) return true;
  }
  return false;
}

// 치환되지 않은 템플릿 자리표시자나 앵커 문법이 남은 URL. 유효한 문서가 아니다.
function looksLikeBrokenUrl(value) {
  const text = String(value || "");
  if (/\.(cta|href|link)\.url(\?|#|$)/i.test(text)) return true;
  if (/[/:][A-Z][A-Z0-9_-]{3,}$/.test(text.replace(/^https?:\/\//i, ""))) return true;
  if (/\$\{|\{\{|%7b/i.test(text)) return true;
  return false;
}

function stripPageExtension(segment) {
  return segment.replace(/\.(html?|aspx?|php|jsp|cfm)$/i, "");
}

function looksLikeSourceIndexUrl(value) {
  if (!isHttpUrl(value)) return false;
  try {
    const parsed = new URL(value);
    const pathname = parsed.pathname.replace(/\/+$/, "").toLowerCase();
    if (!pathname || pathname === "") return true;
    if (/(\/|^)(rss|feed|atom)(\/|$)/i.test(pathname)) return true;
    if (hasIndexOnlyPathMarker(parsed)) return true;
    // 확장자와 로케일 세그먼트를 걷어낸 뒤 남은 조각이 전부 목록용 단어면 기사 URL이 아니다.
    const segments = pathname
      .split("/")
      .filter(Boolean)
      .map(stripPageExtension)
      .filter((segment) => segment && !isLocaleSegment(segment));
    if (segments.length === 0) return true;
    if (segments.length <= 4 && segments.every((segment) => INDEX_SEGMENTS.has(segment))) return true;
    // /company/newsroom/featured-stories/automotive 처럼 상위 경로가 전부 목록이고
    // 마지막 조각이 짧은 낱말이면 기사가 아니라 카테고리 탭이다.
    // 실제 기사 슬러그는 보통 단어 3개 이상이거나 날짜·번호를 포함한다.
    const last = segments[segments.length - 1];
    const parents = segments.slice(0, -1);
    const lastLooksLikeCategory = !/\d/.test(last) && last.split("-").length <= 2 && last.length <= 24;
    return parents.length > 0 && parents.every((segment) => INDEX_SEGMENTS.has(segment)) && lastLooksLikeCategory;
  } catch {
    return false;
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

function parseDate(value) {
  if (!value) return null;
  const gdelt = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (gdelt) {
    return `${gdelt[1]}-${gdelt[2]}-${gdelt[3]}T${gdelt[4]}:${gdelt[5]}:${gdelt[6]}Z`;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().replace(/\.\d{3}Z$/, "Z");
}

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function monthNumberFromName(name) {
  const key = String(name || "").toLowerCase().replace(/\.$/, "");
  const index = MONTH_NAMES.findIndex((month) => month === key || (key.length >= 3 && month.startsWith(key)));
  return index === -1 ? 0 : index + 1;
}

const MONTH_NAME_PATTERN = "January|February|March|April|May|June|July|August|September|October|November|December|Jan\\.?|Feb\\.?|Mar\\.?|Apr\\.?|Jun\\.?|Jul\\.?|Aug\\.?|Sept?\\.?|Oct\\.?|Nov\\.?|Dec\\.?";

function isoMonth(year, month) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

// "2026-08"이나 "August 2026"처럼 일자가 없는 값. Date는 이런 값을 그 달 1일로 읽어버리므로
// 게시일로 쓰기 전에 걸러내고 월 단위 근거로만 남긴다.
function parseMonthOnly(value) {
  const text = cleanText(String(value ?? ""));
  if (!text) return "";
  const iso = text.match(/^(20\d{2})[-/](0?[1-9]|1[0-2])$/);
  if (iso) return isoMonth(iso[1], iso[2]);
  const korean = text.match(/^(20\d{2})\s*년\s*(0?[1-9]|1[0-2])\s*월$/);
  if (korean) return isoMonth(korean[1], korean[2]);
  const named = text.match(new RegExp(`^(${MONTH_NAME_PATTERN}),?\\s+(20\\d{2})$`, "i"));
  const namedNumber = named ? monthNumberFromName(named[1]) : 0;
  return namedNumber ? isoMonth(named[2], namedNumber) : "";
}

// 일자까지 적히지 않은 본문 표기. 게시월 근거로만 쓰고 임의로 1일을 채우지 않는다.
// 판정 단계의 날짜 검증(local_report.mjs)도 이 파서를 그대로 쓴다. 단계마다 날짜 문법이
// 다르면 수집에서 못 읽은 날짜를 판정에서 받아들이는 일이 생긴다.
export function extractMonthFromText(value = "") {
  const text = cleanText(String(value ?? ""));
  const korean = text.match(/(20\d{2})\s*년\s*(0?[1-9]|1[0-2])\s*월/);
  if (korean) return isoMonth(korean[1], korean[2]);
  const named = text.match(new RegExp(`\\b(${MONTH_NAME_PATTERN}),?\\s+(20\\d{2})\\b`, "i"));
  const namedNumber = named ? monthNumberFromName(named[1]) : 0;
  return namedNumber ? isoMonth(named[2], namedNumber) : "";
}

// parseDate는 해석에 실패하면 입력 문자열을 그대로 돌려준다. 날짜로 확신할 수 있을 때만 받고 싶은 곳에서 쓴다.
function parseStrictDate(value) {
  // Date는 "2026"을 1월 1일로 읽는다. 연도만 적힌 값은 게시일 근거가 아니다.
  if (/^\s*20\d{2}\s*$/.test(String(value || "")) || parseMonthOnly(value)) return null;
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
  const korean = text.match(/(20\d{2})\s*년\s*(0?[1-9]|1[0-2])\s*월\s*(0?[1-9]|[12]\d|3[01])\s*일/);
  if (korean) {
    return isoDate(korean[1], korean[2], korean[3]);
  }
  const japanese = text.match(/(20\d{2})\s*年\s*(0?[1-9]|1[0-2])\s*月\s*(0?[1-9]|[12]\d|3[01])\s*日/);
  if (japanese) {
    return isoDate(japanese[1], japanese[2], japanese[3]);
  }
  const numeric = text.match(/\b(20\d{2})[./-](0?[1-9]|1[0-2])[./-](0?[1-9]|[12]\d|3[01])\b/);
  if (numeric) {
    return parseDate(`${numeric[1]}-${numeric[2].padStart(2, "0")}-${numeric[3].padStart(2, "0")}`);
  }
  // 유럽식 점 표기(31.12.2026). 앞자리가 12를 넘으면 일-월 순서가 확정된다.
  const dayFirst = text.match(/\b(0?[1-9]|[12]\d|3[01])\.(0?[1-9]|1[0-2])\.(20\d{2})\b/);
  if (dayFirst) {
    return isoDate(dayFirst[3], dayFirst[2], dayFirst[1]);
  }
  // 미국식 슬래시 표기(12/31/2026).
  const monthFirst = text.match(/\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(20\d{2})\b/);
  if (monthFirst) {
    return isoDate(monthFirst[3], monthFirst[1], monthFirst[2]);
  }
  const monthName = text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan\.?|Feb\.?|Mar\.?|Apr\.?|Jun\.?|Jul\.?|Aug\.?|Sept?\.?|Oct\.?|Nov\.?|Dec\.?)\s+([0-3]?\d),?\s+(20\d{2})\b/i,
  );
  if (monthName) {
    // 월 이름 표기를 Date에 그대로 넘기면 현지 시간대로 읽혀 하루가 밀린다.
    return isoDate(monthName[3], monthNumberFromName(monthName[1]), monthName[2]);
  }
  const dayMonth = text.match(
    /\b([0-3]?\d)\s+(January|February|March|April|May|June|July|August|September|October|November|December|Jan\.?|Feb\.?|Mar\.?|Apr\.?|Jun\.?|Jul\.?|Aug\.?|Sept?\.?|Oct\.?|Nov\.?|Dec\.?)\s+(20\d{2})\b/i,
  );
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
  const ymd = text.match(/(?:^|\D)(20\d{2})[/_-](0?[1-9]|1[0-2])[/_-](0?[1-9]|[12]\d|3[01])(?:\D|$)/);
  if (ymd) return isoDate(ymd[1], ymd[2], ymd[3]);
  const mdy = text.match(/(?:^|\D)(0?[1-9]|1[0-2])[/_-](0?[1-9]|[12]\d|3[01])[/_-](20\d{2})(?:\D|$)/);
  if (mdy) return isoDate(mdy[3], mdy[1], mdy[2]);
  const compact = text.match(/(?:^|\D)(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:\D|$)/);
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
function extractDateFromTimeTag(html) {
  for (const match of html.matchAll(/<time\b([^>]*)>([\s\S]*?)<\/time>/gi)) {
    const attrs = match[1] || "";
    const parsed = extractAttribute(attrs, "datetime") || match[2];
    if (dateEvidence(parsed, "time_tag")) return parsed;
    const text = extractDateFromText(match[2]);
    if (text) return text;
  }
  for (const match of html.matchAll(/<time\b([^>]*)\/>/gi)) {
    const parsed = extractAttribute(match[1] || "", "datetime");
    if (dateEvidence(parsed, "time_tag")) return parsed;
  }
  return null;
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
  const headText = cleanHtmlText(html.slice(0, 5000));
  return [
    dateEvidence(extractMetaContent(html, PUBLISHED_META_NAMES), "meta", "published"),
    dateEvidence(jsonLdPublished?.[1], "jsonld", "published"),
    dateEvidence(extractDateFromTimeTag(html), "time_tag", "published"),
    dateEvidence(extractDateFromItemprop(html), "itemprop", "published"),
    dateEvidence(extractMetaContent(html, MODIFIED_META_NAMES), "modified_meta", "modified"),
    dateEvidence(jsonLdModified?.[1], "modified_jsonld", "modified"),
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

function extractArticleText(html) {
  const candidates = [];
  for (const pattern of [
    /<article\b[^>]*>([\s\S]*?)<\/article>/i,
    /<main\b[^>]*>([\s\S]*?)<\/main>/i,
    /<div\b[^>]*(?:class|id)=["'][^"']*(?:article|press|release|news|content|body)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<body\b[^>]*>([\s\S]*?)<\/body>/i,
  ]) {
    const match = html.match(pattern);
    if (match) candidates.push(cleanHtmlText(match[1]));
  }
  return candidates.sort((a, b) => b.length - a.length)[0] || cleanHtmlText(html);
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

// 수집 단계는 기간 밖이라고 확인된 기사만 버린다. 날짜 미상·추정·충돌 기사는 그대로 보관해
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
  return headers;
}

async function fetchTextOnce(url, timeoutSeconds) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: requestHeaders(url),
    });
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} ${response.statusText}`);
      error.status = response.status;
      error.retryAfterSeconds = Number.parseInt(response.headers.get("retry-after") || "", 10) || 0;
      throw error;
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function isRetryableFetchError(error) {
  // 상태 코드가 없으면 네트워크 오류나 타임아웃이므로 재시도한다.
  return error.status === undefined ? true : RETRYABLE_STATUS.has(error.status);
}

async function fetchText(url, timeoutSeconds) {
  let lastError;
  for (let attempt = 0; attempt <= fetchRetries; attempt += 1) {
    if (attempt > 0) {
      retryCount += 1;
      // 서버가 Retry-After로 대기 시간을 지정했으면 그 값을 따른다.
      const backoffMs = 700 * 2 ** (attempt - 1) + Math.floor(Math.random() * 400);
      const retryAfterMs = (lastError?.retryAfterSeconds || 0) * 1000;
      await sleep(Math.min(Math.max(backoffMs, retryAfterMs), 30000));
    }
    try {
      return await fetchTextOnce(url, timeoutSeconds);
    } catch (error) {
      lastError = error;
      if (!isRetryableFetchError(error)) throw error;
    }
  }
  throw lastError;
}

async function fetchJson(url, timeoutSeconds) {
  return JSON.parse(await fetchText(url, timeoutSeconds));
}

function relevantAliases(company) {
  const names = [company.company];
  for (const alias of company.query_aliases || []) {
    const key = alias.toLowerCase();
    if (alias.length >= 5 && !["hydro", "maxon", "evonik"].includes(key)) {
      names.push(alias);
    }
  }
  return [...new Map(names.map((name) => [name.toLowerCase(), name])).values()].slice(0, 3);
}

function buildQuery(company, days) {
  const names = relevantAliases(company);
  let nameClause = names.map((name) => `"${name}"`).join(" OR ");
  if (names.length > 1) nameClause = `(${nameClause})`;
  return `${nameClause} (${SIGNAL_TERMS.join(" OR ")}) when:${days}d`;
}

function buildGdeltQuery(company) {
  const names = relevantAliases(company);
  let nameClause = names.map((name) => `"${name}"`).join(" OR ");
  if (names.length > 1) nameClause = `(${nameClause})`;
  const terms = SIGNAL_TERMS.filter((term) => term !== "Korea").join(" OR ");
  return `${nameClause} (${terms})`;
}

function parseRssOrAtom(xml, company, collectedAt, collector, query, defaultSource, feedKind = "") {
  const rows = [];
  const isOfficialCollector = collector.startsWith("official_");
  const sourceFieldsFor = (itemUrl) =>
    isOfficialCollector
      ? officialSourceFields(feedKind, defaultSource, query, itemUrl)
      : fallbackSourceFields(90);
  for (const item of blocks(xml, "item")) {
    const sourceText = tagText(item, "source");
    const itemUrl = bestRssItemUrl(item, query);
    rows.push({
      target_no: company.target_no,
      company: company.company,
      title: tagText(item, "title"),
      url: itemUrl,
      source: sourceText ? `${defaultSource}: ${sourceText}` : defaultSource,
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
    });
  }
  return rows.filter((row) => row.title && row.url);
}

function parseAnchors(html, baseUrl) {
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
          html.slice(Math.max(0, match.index - 260), Math.min(html.length, match.index + match[0].length + 260)),
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
function isUsableTitle(title, company) {
  const text = cleanText(title).trim();
  if (text.length < 8) return false;
  if (isGenericOfficialTitle(text)) return false;
  if (isCompanyNameOnlyTitle(text, company)) return false;
  return true;
}

function titleFromUrl(url) {
  try {
    const parsed = new URL(url);
    // 문서 링크는 경로가 난수 ID이고 실제 이름이 fileName 같은 쿼리에 담기는 경우가 많다.
    for (const key of ["fileName", "filename", "file", "name"]) {
      const value = parsed.searchParams.get(key);
      if (!value) continue;
      const fromParam = decodeURIComponent(value)
        .replace(/\.(pdf|xlsx?|pptx?|docx?|html?|aspx|php)$/i, "")
        .replace(/[-_]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (fromParam.length >= 16) return fromParam;
    }
    const segments = parsed.pathname.split("/").filter(Boolean);
    const last = segments.reverse().find((segment) => !/^(default|index|news|press|releases?|details?|en|global|ir)$/i.test(segment));
    if (!last) return "";
    const cleaned = decodeURIComponent(last)
      .replace(/\.(html?|aspx|php)$/i, "")
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

function discoverFeedLinks(html, baseUrl) {
  const urls = [];
  const linkRegex = /<link\b([^>]*)>/gi;
  for (const match of html.matchAll(linkRegex)) {
    const attrs = match[1] || "";
    if (!/(application\/rss\+xml|application\/atom\+xml|rss|atom|feed)/i.test(attrs)) continue;
    const hrefMatch = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    const href = decodeXml(hrefMatch[1]);
    if (/xmlrpc\.php|rsd/i.test(href)) continue;
    try {
      urls.push(stripTracking(new URL(href, baseUrl).toString()));
    } catch {
      continue;
    }
  }
  for (const anchor of parseAnchors(html, baseUrl)) {
    if (/(rss|atom|feed)/i.test(`${anchor.title} ${anchor.url}`)) {
      urls.push(anchor.url);
    }
  }
  return [...new Set(urls)].slice(0, 3);
}

function isRelevantOfficialLink(anchor, pageUrl) {
  const title = officialTitle(anchor);
  const direct = `${title} ${anchor.url}`.toLowerCase();
  const detectedDate = extractDateFromText(`${anchor.title} ${anchor.context} ${anchor.url}`);
  if (looksLikeSourceIndexUrl(anchor.url)) return false;
  if (looksLikeBrokenUrl(anchor.url)) return false;
  const pathLooksDetailed =
    /\/(news-release-details|press-releases?|newsroom|news|media|article|announcements?)\//i.test(anchor.url) ||
    /\b20\d{2}\b/.test(anchor.url);
  // 링크 텍스트가 "More information" 같은 라벨이면 title이 비는데, 목적지가 상세 페이지로 보이면
  // 여기서 버리지 않고 통과시킨다. 진짜 제목은 상세 페이지를 받아본 뒤 확정한다.
  if (title.length < 8 && !pathLooksDetailed) return false;
  if (!detectedDate && !pathLooksDetailed) return false;
  if (/\.(jpg|jpeg|png|gif|svg|webp|mp4|zip)$/i.test(anchor.url)) return false;
  if (/privacy|cookie|terms|subscribe|contact|career|linkedin|facebook|twitter|youtube|instagram/i.test(direct)) {
    return false;
  }
  if (
    /^(investor relations home|corporate governance|corporate directory|corporate citizenship|management|contact us|about us|products?|solutions?|careers?)$/i.test(
      title,
    )
  ) {
    return false;
  }
  const keywords =
    /press|release|news|financial|results|earnings|quarter|annual|report|presentation|announcement|acquisition|expansion|partnership|investment|korea|plant|facility|manufactur/i;
  if (keywords.test(direct)) return true;
  try {
    const sourceHost = new URL(pageUrl).hostname.replace(/^www\./, "");
    const targetHost = new URL(anchor.url).hostname.replace(/^www\./, "");
    return (
      sourceHost === targetHost &&
      /\/(news|press|release|media|investor|ir|financial|results|announcements?)\b/i.test(new URL(anchor.url).pathname)
    );
  } catch {
    return false;
  }
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

async function collectOfficialFeeds(company, sourceConfig, dateRange, maxPerSource, timeoutSeconds, collectedAt) {
  const feeds = sourceConfig.official_feeds?.[company.company] || [];
  const rows = [];
  let requestCount = 0;
  for (const feed of feeds) {
    const feedUrl = typeof feed === "string" ? feed : feed.url;
    const sourceName =
      typeof feed === "string" ? `Official feed: ${company.company}` : feed.source || `Official feed: ${company.company}`;
    const feedKind = typeof feed === "string" ? "" : feed.kind || "";
    if (!feedUrl) continue;
    const xml = await fetchText(feedUrl, timeoutSeconds);
    requestCount += 1;
    rows.push(
      ...filterByDateRange(
        parseRssOrAtom(xml, company, collectedAt, "official_feed", feedUrl, sourceName, feedKind),
        dateRange,
      ).slice(0, maxPerSource),
    );
  }
  return { rows, requestCount };
}

async function collectOfficialPages(company, sourceConfig, dateRange, maxPerSource, timeoutSeconds, collectedAt) {
  const pages = normalizeOfficialPageEntries(sourceConfig.official_pages?.[company.company] || []);
  const rows = [];
  const errors = [];
  let requestCount = 0;
  for (const page of pages) {
    try {
      const html = await fetchText(page.url, timeoutSeconds);
      requestCount += 1;
      for (const feedUrl of discoverFeedLinks(html, page.url)) {
        try {
          const feedXml = await fetchText(feedUrl, timeoutSeconds);
          requestCount += 1;
          rows.push(
            ...filterByDateRange(
              parseRssOrAtom(feedXml, company, collectedAt, "official_feed_discovered", feedUrl, `${page.source} RSS`, page.kind),
              dateRange,
            ).slice(0, maxPerSource),
          );
        } catch (error) {
          errors.push({ source_url: feedUrl, source_name: `${page.source} RSS`, error: error.message });
        }
      }
      const anchors = parseAnchors(html, page.url).filter((anchor) => {
        if (isRelevantOfficialLink(anchor, page.url)) return true;
        // 목록·카테고리 페이지와 깨진 링크는 제외 사유를 남긴다. 나머지 무관한 링크는 기록하지 않는다.
        if (looksLikeSourceIndexUrl(anchor.url)) {
          recordExclusion(company.company, anchor.title, anchor.url, "index_or_category_page");
        } else if (looksLikeBrokenUrl(anchor.url)) {
          recordExclusion(company.company, anchor.title, anchor.url, "broken_url");
        }
        return false;
      });
      const sourceRows = dedupeRows(
        anchors.map((anchor) => ({
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
        })),
      );
      rows.push(...filterByDateRange(sourceRows, dateRange).slice(0, maxPerSource));
    } catch (error) {
      errors.push({ source_url: page.url, source_name: page.source, error: error.message });
    }
  }
  return { rows, requestCount, errors };
}

function canFetchDetailContent(url) {
  return !/\.(xlsx?|pptx?|docx?|zip|jpg|jpeg|png|gif|svg|webp|mp4|mov)(?:[?#]|$)/i.test(url);
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

export function createPublisherProbe(limit = 3) {
  let failures = 0, queue = Promise.resolve();
  return async (url, request) => {
    if (!isGoogle(url)) return request();
    // Serialize Google probes across company workers so the failure threshold
    // cannot be exceeded by already queued requests. Other publishers run freely.
    const result = queue.then(async () => {
      if (failures >= limit) return null;
      try {
        const document = await request();
        failures = 0;
        return document;
      } catch (error) {
        failures = error.message === 'publisher_url_unresolved' ? failures + 1 : 0;
        throw error;
      }
    });
    queue = result.catch(() => {});
    return result;
  };
}
// In-memory only: each collector execution starts with fresh probes.
const probePublisher = createPublisherProbe();

export async function readLimitedPdf(response, limit = 20 * 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error('pdf_too_large');
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
        throw new Error('pdf_too_large');
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

export function extractPdfText(bytes) {
  return new Promise((resolve, reject) => {
    const child = spawn('python', ['-X', 'utf8', PDF_EXTRACTOR],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    let size = 0, failure = null;
    const timer = setTimeout(() => { failure = new Error('pdf_extraction_timeout'); child.kill(); }, 30000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) { failure = new Error('pdf_text_too_large'); child.kill(); }
      else chunks.push(chunk);
    });
    child.stdin.on('error', () => {}); // close/error determines the extraction result
    child.on('close', code => {
      clearTimeout(timer);
      if (failure || code !== 0) reject(failure || new Error('pdf_extraction_failed'));
      else resolve(Buffer.concat(chunks).toString('utf8').trim());
    });
    child.stdin.end(bytes);
  });
}

export async function fetchArticleDocument(url, timeoutSeconds, fetchImpl = fetch) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutSeconds * 1000),
    redirect: 'follow', headers: requestHeaders(url) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const resolvedUrl = response.url || url;
  // Google consent/RSS wrapper text is not publisher evidence.
  if (/(^|\.)google\.com$/.test(new URL(resolvedUrl).hostname)) {
    await response.body?.cancel();
    throw new Error('publisher_url_unresolved');
  }
  const isPdf = /application\/pdf/i.test(response.headers.get('content-type') || '') || /\.pdf(?:[?#]|$)/i.test(resolvedUrl);
  if (!isPdf) return { html: await response.text(), resolvedUrl };
  const bytes = await readLimitedPdf(response);
  return { html: '', content: await extractPdfText(bytes), resolvedUrl };
}

function chooseBetterTitle(currentTitle, pageTitle, url, company) {
  // 사이트 <title>이 회사명뿐이거나 메뉴 이름이면 링크 텍스트보다 나을 게 없다.
  // onsemi 뉴스룸의 <title>이 "onsemi"라서 제목이 회사명으로 덮이던 문제를 막는다.
  const usablePageTitle = pageTitle && isUsableTitle(pageTitle, company) ? pageTitle : "";
  if (!usablePageTitle) return currentTitle;
  if (!currentTitle || currentTitle.length < 16 || isGenericOfficialTitle(currentTitle)) return usablePageTitle;
  const urlTitle = titleFromUrl(url);
  if (urlTitle && currentTitle.toLowerCase() === urlTitle.toLowerCase()) return usablePageTitle;
  return currentTitle;
}

async function enrichOfficialRowsWithContent(rows, args, collectedAt, company) {
  if (!args.fetchOfficialContent) {
    return { rows, requestCount: 0, errors: [] };
  }

  const enriched = [];
  const errors = [];
  let requestCount = 0;
  let detailCount = 0;

  for (const row of rows) {
    if (row.content_text) {
      enriched.push(row);
      continue;
    }
    const detailUrl = detailSourceUrl(row);

    // 본문을 받아오지 않는 두 경로에서는 링크 텍스트와 URL만으로 제목을 확보해야 한다.
    if (detailCount >= args.maxDetailPerCompany || !canFetchDetailContent(row.url)) {
      const skipStatus = detailCount >= args.maxDetailPerCompany ? "skipped_detail_limit" : "skipped_non_html";
      const skipTitle = isUsableTitle(row.title, company) ? row.title : titleFromUrl(row.url);
      if (!isUsableTitle(skipTitle, company)) {
        recordExclusion(row.company, row.title, row.url, "no_article_title");
        continue;
      }
      // PDF·XLS 링크는 본문을 열 수 없으니 파일명에 남은 날짜라도 살린다. 다만 URL 날짜는 정황 근거다.
      enriched.push({
        ...row,
        title: skipTitle,
        ...chooseDateEvidence([
          ...(row.date_candidates || []),
          dateEvidence(extractDateFromUrl(row.url), "url", "context"),
        ]),
        content_fetch_status: skipStatus,
      });
      continue;
    }

    try {
      const document = await probePublisher(detailUrl, async () => {
        requestCount += 1;
        detailCount += 1;
        return row.source_type === 'official' && !/\.pdf(?:[?#]|$)/i.test(detailUrl)
          ? { html: await fetchText(detailUrl, args.timeoutSeconds), resolvedUrl: detailUrl }
          : await fetchArticleDocument(detailUrl, args.timeoutSeconds);
      });
      if (!document) {
        enriched.push({ ...row, content_fetch_status: 'publisher_url_unresolved' });
        continue;
      }
      const html = document.html;
      const content = document.content ?? extractArticleText(html);
      const limitedContent = content.slice(0, args.contentCharLimit);
      const pageTitle = extractPageTitle(html);
      // 목록에 날짜가 있어도 기사 페이지를 다시 읽는다. 더 강한 근거가 있는지, 두 날짜가 어긋나는지는
      // 상세 페이지를 보고 나서야 알 수 있다.
      const bodyHead = content.slice(0, 4000);
      const dates = chooseDateEvidence([
        ...(row.date_candidates || []),
        ...collectHtmlDateEvidence(html, row.url),
        dateEvidence(extractDateFromText(bodyHead) || extractMonthFromText(bodyHead), "body_text", "context"),
      ]);
      const resolvedTitle = chooseBetterTitle(row.title, pageTitle, row.url, company);
      // 상세 페이지를 받아본 뒤에도 쓸 만한 제목이 없으면 기사로 인정하지 않는다.
      // 링크 텍스트로 추측하는 대신 실제 받아온 문서로 판정하는 지점이다.
      if (!isUsableTitle(resolvedTitle, company)) {
        recordExclusion(row.company, resolvedTitle || row.title, row.url, "no_article_title");
        continue;
      }
      enriched.push({
        ...row,
        title: resolvedTitle,
        ...dates,
        content_text: limitedContent,
        content_source_url: document.resolvedUrl,
        content_excerpt: contentExcerpt(limitedContent, args.contentExcerptLimit),
        content_word_count: content.split(/\s+/).filter(Boolean).length,
        content_fetch_status: content ? "fetched" : "empty",
        content_fetched_at: collectedAt,
      });
    } catch (error) {
      errors.push({
        target_no: row.target_no,
        company: row.company,
        source: "official_detail",
        source_url: row.url,
        source_name: row.source,
        error: error.message,
      });
      enriched.push({
        ...row,
        content_fetch_status: "error",
        content_fetched_at: collectedAt,
      });
    }

    if (args.rateLimitSeconds > 0) {
      await sleep(args.rateLimitSeconds * 1000);
    }
  }

  return { rows: enriched, requestCount, errors };
}

async function collectGoogleNews(company, dateRange, maxPerSource, timeoutSeconds, collectedAt) {
  const query = buildQuery(company, dateRange.lookbackDays);
  const params = new URLSearchParams({
    q: query,
    hl: "en-US",
    gl: "US",
    ceid: "US:en",
  });
  const xml = await fetchText(`https://news.google.com/rss/search?${params.toString()}`, timeoutSeconds);
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
      .slice(0, maxPerSource),
    requestCount: 1,
  };
}

async function collectGdelt(company, dateRange, maxPerSource, timeoutSeconds, collectedAt) {
  const query = buildGdeltQuery(company);
  const params = new URLSearchParams({
    query,
    mode: "ArtList",
    format: "json",
    maxrecords: String(maxPerSource),
    sort: "HybridRel",
    timespan: `${dateRange.lookbackDays}d`,
  });
  const payload = await fetchJson(`https://api.gdeltproject.org/api/v2/doc/doc?${params.toString()}`, timeoutSeconds);
  const rows = (payload.articles || [])
    .map((article) => ({
      target_no: company.target_no,
      company: company.company,
      title: cleanText(article.title || ""),
      url: article.url || "",
      source: `GDELT: ${article.domain || article.sourceCountry || "unknown"}`,
      ...chooseDateEvidence([dateEvidence(parseDate(article.seendate), "gdelt_seen", "context")]),
      collected_at: collectedAt,
      collector: "gdelt_doc_api",
      query,
      ...fallbackSourceFields(95),
      official_source_url: "",
    }))
    .filter((row) => row.title && row.url);
  return { rows: filterByDateRange(rows, dateRange).slice(0, maxPerSource), requestCount: 1 };
}

function dedupeRows(rows) {
  const seen = new Set();
  const seenTitles = new Set();
  const deduped = [];
  for (const row of rows) {
    const urlKey = row.url.replace(/[?#].*$/, "").toLowerCase();
    const key = `${row.company.toLowerCase()}|${urlKey || row.title.toLowerCase()}`;
    const titleKey = `${row.company.toLowerCase()}|${row.title.toLowerCase().replace(/\s+/g, " ").trim()}`;
    if (seen.has(key)) continue;
    if (row.title.length > 15 && seenTitles.has(titleKey)) continue;
    seen.add(key);
    seenTitles.add(titleKey);
    deduped.push(row);
  }
  return deduped;
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

async function mapWithConcurrency(items, concurrency, worker) {
  const limit = Math.max(1, Number(concurrency) || 1);
  const results = new Array(items.length);
  let cursor = 0;

  async function runNext() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runNext()),
  );
  return results;
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

async function collectCompany(company, sourceConfig, selectedSources, args, dateRange, collectedAt) {
  const companyRows = [];
  const errors = [];
  let requestCount = 0;

  for (const source of selectedSources) {
    let result = { rows: [], requestCount: 0 };
    try {
      if (source === "official_feeds") {
        result = await collectOfficialFeeds(company, sourceConfig, dateRange, args.maxPerSource, args.timeoutSeconds, collectedAt);
      } else if (source === "official_pages") {
        result = await collectOfficialPages(company, sourceConfig, dateRange, args.maxPerSource, args.timeoutSeconds, collectedAt);
      } else if (source === "google_news") {
        // Decide after official detail/date enrichment, not from undated listing links.
        continue;
      } else if (source === "gdelt") {
        result = await collectGdelt(company, dateRange, args.maxPerSource, args.timeoutSeconds, collectedAt);
      } else {
        throw new Error(`Unknown source: ${source}`);
      }
      companyRows.push(...result.rows);
      requestCount += result.requestCount;
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
    if (result.requestCount > 0) {
      await sleep(args.rateLimitSeconds * 1000);
    }
  }

  const selectedCompanyRows = sortRows(dedupeRows(companyRows)).slice(0, args.maxPerCompany);
  const enriched = await enrichOfficialRowsWithContent(selectedCompanyRows, args, collectedAt, company);
  requestCount += enriched.requestCount;
  errors.push(...enriched.errors);
  let rows = enriched.rows;
  const usable = rows.filter((row) => usableMonthlySource(row, dateRange));
  if (selectedSources.includes("google_news") &&
      (args.fallbackMode !== "missing" || usable.length < args.fallbackMinResults)) {
    try {
      const fallback = await collectGoogleNews(company, dateRange, args.maxPerSource, args.timeoutSeconds, collectedAt);
      requestCount += fallback.requestCount;
      if (fallback.requestCount > 0) await sleep(args.rateLimitSeconds * 1000);
      // Dated monthly evidence first, then the rest of what this company's own
      // sources returned, and only then the fallback. Ranking Google News above
      // an undated or unfetched official row let it push real press releases
      // out of maxPerCompany: 26 official rows were lost that way in the
      // 2026-08 run while fallback rows grew from 37 to 142.
      rows = dedupeRows([...usable, ...rows, ...fallback.rows]).slice(0, args.maxPerCompany);
      const fallbackRows = rows.filter(row => row.source_type !== 'official');
      const detailedFallback = await enrichOfficialRowsWithContent(fallbackRows, args, collectedAt, company);
      requestCount += detailedFallback.requestCount;
      errors.push(...detailedFallback.errors);
      const byUrl = new Map(detailedFallback.rows.map(row => [row.url, row]));
      rows = rows.map(row => byUrl.get(row.url) || row);
    } catch (error) {
      errors.push({ target_no: company.target_no, company: company.company, source: "google_news", error: error.message });
    }
  }
  return { rows, requestCount, errors };
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

  const sourceConfig = await loadJson(args.sourceConfig, {});
  const selectedSources = args.sources.split(",").map((source) => source.trim()).filter(Boolean);
  const collectedAt = utcNow();
  const dateRange = buildDateRange(args, collectedAt);
  const rows = [];
  const errors = [];
  let requestCount = 0;

  const companyResults = await mapWithConcurrency(
    companies,
    args.companyConcurrency,
    async (company) => {
      const started = Date.now();
      const result = await collectCompany(company, sourceConfig, selectedSources, args, dateRange, collectedAt);
      result.timing = { company: company.company, elapsed_ms: Date.now() - started,
        request_count: result.requestCount, result_count: result.rows.length };
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
    run_finished_at: utcNow(),
    company_timings: companyResults.map(result => result.timing),
    skipped_unresolved_publisher_count: finalRows.filter(row => row.content_fetch_status === 'publisher_url_unresolved').length,
    company_count: companies.length,
    canonical_company_count: 77,
    sources: selectedSources,
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
    excluded_non_article_count: excludedTotal,
    excluded_non_article_reasons: Object.fromEntries(excludedCounts),
    excluded_non_article_sample_count: excludedRows.length,
    excluded_non_article_samples: excludedRows,
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
