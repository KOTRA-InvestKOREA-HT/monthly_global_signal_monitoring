import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createDomainGuard, collectWithCheckpoint, retryableCollection, collectionInputDigest } from './collection_resilience.mjs';
import { ARTICLE_BODY_MIN_CHARS, chooseDateEvidence, hasArticleBody, periodPlacement, reportEligible, resolveDateState } from "./date_state.mjs";
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
export const CONTENT_COLLECTION_VERSION = 'article-body-v14-out-of-period-behind-fallback';
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
const linkVerdictCounts = new Map();

function countLinkVerdict(verdict) {
  linkVerdictCounts.set(verdict, (linkVerdictCounts.get(verdict) || 0) + 1);
}

// 기사가 아니라고 판단해 제외한 링크. 필터가 과했는지 사후에 검증할 수 있어야 한다.
// 집계는 전량을 세고, 샘플만 상한을 둔다. 예전에는 둘 다 상한에 걸려 총 제외 건수를 알 수 없었다.
//
// 샘플은 사유별로 따로 담는다. 한 통에 담으면 압도적으로 많은 사유 하나가 표본을 다 먹는다.
// 실제로 9,998건 제외 중 9,782건이 index_or_category_page 라서, 120건 표본이 전부 그 사유로
// 채워지고 no_article_title 22건은 한 건도 눈에 띄지 않았다. 확인이 필요한 쪽은 늘 소수 사유다.
const excludedByReason = new Map();
const excludedCounts = new Map();
let excludedTotal = 0;
const EXCLUDED_SAMPLE_PER_REASON = 24;
const EXCLUDED_SAMPLE_PER_COMPANY_PER_REASON = 2;

function recordExclusion(company, title, url, reason) {
  excludedTotal += 1;
  excludedCounts.set(reason, (excludedCounts.get(reason) || 0) + 1);
  if (!excludedByReason.has(reason)) excludedByReason.set(reason, []);
  const bucket = excludedByReason.get(reason);
  if (bucket.length >= EXCLUDED_SAMPLE_PER_REASON) return;
  // 한 회사가 사유별 표본을 다 차지하면 다른 회사의 오제외를 못 본다.
  const seenForCompany = bucket.filter((row) => row.company === company).length;
  if (seenForCompany >= EXCLUDED_SAMPLE_PER_COMPANY_PER_REASON) return;
  bucket.push({ company, title: cleanText(title).slice(0, 120), url, reason });
}

function excludedSamples() {
  return [...excludedByReason.values()].flat();
}

export function parseArgs(argv) {
  const args = {
    companies: "data/target_companies.json",
    sourceConfig: "config/company_sources.json",
    outDir: "outputs",
    refresh: false,
    sources: "official_feeds,official_pages,official_sitemaps,sec_filings,google_news",
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
    // Keep recovered accept links; uncertain document verification is opt-in.
    linkPolicy: DEFAULT_LINK_POLICY,
    maxVerifyPerCompany: DEFAULT_MAX_VERIFY_PER_COMPANY,
  };
  const keyMap = {
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
        "maxVerifyPerCompany",
      ].includes(mapped)
    ) {
      args[mapped] = Number.parseInt(value, 10);
    } else if (mapped === "rateLimitSeconds") {
      args[mapped] = Number.parseFloat(value);
    } else if (mapped === "fetchOfficialContent" || mapped === 'refresh') {
      args[mapped] = !["0", "false", "no"].includes(String(value).toLowerCase());
    } else {
      args[mapped] = value;
    }
  }
  if (!['current', 'proposed'].includes(args.linkPolicy)) throw new Error('Invalid --link-policy');
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

function parseDate(value) {
  if (!value) return null;
  const gdelt = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (gdelt) {
    return `${gdelt[1]}-${gdelt[2]}-${gdelt[3]}T${gdelt[4]}:${gdelt[5]}:${gdelt[6]}Z`;
  }
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
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return value;
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  // 시간대 표기가 없는 값(08/05/26, 2026-08-05T00:00:00)을 Date 는 실행 기기의 현지 시각으로 읽는다.
  // Actions(UTC)에서는 8월 5일이던 Albemarle JSON-LD "08/05/26" 가 한국 시간 PC에서는 8월 4일 15시가 되어
  // 메타 태그의 8월 5일과 충돌했다. 표기가 없으면 적힌 시각을 UTC 로 읽는다. 날짜만 있는 ISO 값은
  // Date 가 이미 UTC 로 읽으므로 그대로 둔다. RSS 의 "16:00:00 EST" 같은 미국 시간대 약어도 Date 가
  // 제대로 읽는 시간대 표기다.
  const text = String(value).trim();
  const zoned = /(?:Z|[+-]\d{2}:?\d{2}|\b(?:GMT|UTC|[ECMP][SD]T)\b)$/i.test(text) || /^\d{4}-\d{2}-\d{2}$/.test(text);
  const utc = zoned ? parsed : new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(),
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

// parseDate는 해석에 실패하면 입력 문자열을 그대로 돌려준다. 날짜로 확신할 수 있을 때만 받고 싶은 곳에서 쓴다.
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
    return parseDate(`${numeric[1]}-${numeric[2].padStart(2, "0")}-${numeric[3].padStart(2, "0")}`);
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
  const monthName = text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan\.?|Feb\.?|Mar\.?|Apr\.?|Jun\.?|Jul\.?|Aug\.?|Sept?\.?|Oct\.?|Nov\.?|Dec\.?)\s+([0-3]?\d),?\s+((?:19|20)\d{2})\b/i,
  );
  if (monthName) {
    // 월 이름 표기를 Date에 그대로 넘기면 현지 시간대로 읽혀 하루가 밀린다.
    return isoDate(monthName[3], monthNumberFromName(monthName[1]), monthName[2]);
  }
  const dayMonth = text.match(
    /\b([0-3]?\d)\s+(January|February|March|April|May|June|July|August|September|October|November|December|Jan\.?|Feb\.?|Mar\.?|Apr\.?|Jun\.?|Jul\.?|Aug\.?|Sept?\.?|Oct\.?|Nov\.?|Dec\.?)\s+((?:19|20)\d{2})\b/i,
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
  const headText = cleanHtmlText(html.slice(0, 5000));
  return [
    dateEvidence(extractMetaContent(html, PUBLISHED_META_NAMES), "meta", "published"),
    dateEvidence(jsonLdPublished?.[1], "jsonld", "published"),
    ...extractDatesFromTimeTags(html),
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
  if (error.noRetry) return false;
  // 상태 코드가 없으면 네트워크 오류나 타임아웃이므로 재시도한다.
  return error.status === undefined ? true : RETRYABLE_STATUS.has(error.status);
}

export async function fetchText(url, timeoutSeconds) {
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
      return await domainGuard.run(url, () => fetchTextOnce(url, timeoutSeconds));
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

export function parseRssOrAtom(xml, company, collectedAt, collector, query, defaultSource, feedKind = "") {
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
      .replace(/\.(pdf|html?|aspx|php)$/i, "")
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
    .sort((a, b) => acceptFirst(a.row) - acceptFirst(b.row) || undated(a.row) - undated(b.row) || a.index - b.index)
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

async function collectOfficialFeeds(company, sourceConfig, dateRange, maxPerSource, timeoutSeconds, collectedAt) {
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
      const xml = await fetchText(feedUrl, timeoutSeconds);
      requestCount += 1;
      rows.push(
        ...filterByDateRange(
          parseRssOrAtom(xml, company, collectedAt, "official_feed", feedUrl, sourceName, feedKind)
            // IR 피드는 이사·애널리스트 소개 페이지도 새 항목으로 싣는다. 기사가 아니다.
            .filter((row) => !isPersonOrCoveragePage(row.url)),
          dateRange,
        ).slice(0, maxPerSource),
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
  let requestCount = 0;
  for (const page of pages) {
    try {
      const html = await fetchText(page.url, timeoutSeconds);
      requestCount += 1;
      for (const feedUrl of discoverFeedLinks(html, page.url)) {
        try {
          const feedXml = await fetchText(feedUrl, timeoutSeconds);
          requestCount += 1;
          const feedRows = filterByDateRange(
            parseRssOrAtom(feedXml, company, collectedAt, "official_feed_discovered", feedUrl, `${page.source} RSS`, page.kind),
            dateRange,
          );
          rows.push(...feedRows.slice(0, maxPerSource));
          recoveryCandidates.push(...feedRows.map(row => ({ ...row, source_page_url: feedUrl })));
        } catch (error) {
          errors.push({ source_url: feedUrl, source_name: `${page.source} RSS`, kind: "discovered_feed", error: error.message });
        }
      }
      const kept = [];
      for (const anchor of parseAnchors(html, page.url)) {
        // Keep raw configured-newsroom anchors only for exact-title recovery of
        // an opaque Google discovery URL. They do not enter collection unless
        // the ordinary link policy accepts them.
        if (!looksLikeSourceIndexUrl(anchor.url) && !looksLikeBrokenUrl(anchor.url)) {
          recoveryCandidates.push({ company: company.company, title: officialTitle(anchor),
            url: anchor.url, source_page_url: page.url });
        }
        const judged = judgeAnchor(anchor, page.url, linkPolicy);
        countLinkVerdict(judged.verdict);
        if (judged.verdict === "hard_reject") {
          if (judged.reason) recordExclusion(company.company, anchor.title, anchor.url, judged.reason);
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
  return { rows, requestCount, errors, recoveryCandidates };
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

// 연속 실패가 limit 에 닿으면 멈추는 대신 pauseMs 만큼 쉬고 다시 시도한다. 쉬고 나서도 다시 막히기를
// maxPauses 번 되풀이하면 그때 이번 실행의 Google 확인을 멈춘다.
// 2026-08 보고서(9월 14일 실행)에서는 Schott Pharma 에서 세 번 연속 실패한 뒤 Google 확인을 통째로 껐다.
// 그 뒤 순서의 기사 51건이 본문 없이 남았는데, 같은 링크를 로컬에서 다시 풀면 전부 1초 안에 풀렸다.
// 일시적인 차단이었다.
export function createPublisherProbe(limit = 3, { pauseMs = 60000, maxPauses = 3, sleepFn = sleep } = {}) {
  let failures = 0, pauses = 0, queue = Promise.resolve();
  return async (url, request) => {
    if (!isGoogle(url)) return request();
    // Serialize Google probes across company workers so the failure threshold
    // cannot be exceeded by already queued requests. Other publishers run freely.
    const result = queue.then(async () => {
      if (failures >= limit) {
        if (pauses >= maxPauses) return null;
        pauses += 1;
        failures = 0;
        await sleepFn(pauseMs);
      }
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

// Google News RSS 가 싣는 기사 주소는 발행사 주소를 감춘 중계 주소다. 따라가도 동의 페이지나 스크립트
// 이동에서 멈춘다. 2026-08 실행에서 이렇게 본문 없이 남은 기사가 98건이었다(Yahoo Finance, Reuters,
// Business Wire 등). 중계 페이지에 실린 서명으로 Google News 자체의 해독 요청을 보내 발행사 주소를 받는다.
// 어느 단계든 실패하면 null 이다. 호출하는 쪽은 예전처럼 리다이렉트를 따라가 본다.
export async function decodeGoogleNewsUrl(url, timeoutSeconds, fetchImpl = fetch) {
  let id;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'news.google.com') return null;
    id = parsed.pathname.match(/\/articles\/([^/?#]+)/)?.[1];
  } catch {
    return null;
  }
  if (!id) return null;
  // 429·5xx 는 잠깐 쉬고 두 번까지 다시 보낸다. 해독 요청이 몰리면 Google 이 잠시 거절한다.
  const send = async (target, init) => {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetchImpl(target, { ...init, signal: AbortSignal.timeout(timeoutSeconds * 1000) });
      if ((response.status !== 429 && response.status < 500) || attempt >= 2) return response;
      await response.body?.cancel();
      await sleep(2000 * 2 ** attempt);
    }
  };
  const page = await send(`https://news.google.com/articles/${id}`, { headers: { 'User-Agent': USER_AGENT } });
  if (!page.ok) return null;
  const html = await page.text();
  const signature = html.match(/data-n-a-sg="([^"]+)"/)?.[1];
  const timestamp = html.match(/data-n-a-ts="([^"]+)"/)?.[1];
  if (!signature || !timestamp) return null;
  const request = ['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1],
    'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, Number(timestamp), signature];
  const response = await send('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': USER_AGENT },
    body: `f.req=${encodeURIComponent(JSON.stringify([[['Fbv4je', JSON.stringify(request), null, 'generic']]]))}`,
  });
  if (!response.ok) return null;
  try {
    const payload = (await response.text()).split('\n\n')[1];
    const decoded = JSON.parse(JSON.parse(payload)[0][2])[1];
    return /^https?:\/\//i.test(decoded) && !isGoogle(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

// Google 차례에서 할 일만 한다. 발행사 본문 다운로드는 차례 밖 downloadArticleDocument 가 맡는다.
// 2026-09-15 실행에서는 해독 뒤의 본문·PDF 받기까지 차례 안에서 해서, 다른 기업의 Google 링크가 그걸 기다렸다.
// 해독이 안 되면 예전처럼 중계 주소를 따라가 보는데, 드물게 발행사에 닿으면 그 응답은 여기서 끝까지 읽는다.
// 본문을 차례 밖으로 넘기면 기업 자리를 기다리는 동안 요청 제한 시간이 지나 버린다.
export async function resolveArticleSource(url, timeoutSeconds, fetchImpl = fetch) {
  if (!isGoogle(url)) return { target: url };
  const publisherUrl = await decodeGoogleNewsUrl(url, timeoutSeconds, fetchImpl).catch(() => null);
  if (publisherUrl) return { target: publisherUrl };
  return { document: await downloadArticleDocument(url, timeoutSeconds, fetchImpl) };
}

export async function fetchArticleDocument(url, timeoutSeconds, fetchImpl = fetch) {
  const source = await resolveArticleSource(url, timeoutSeconds, fetchImpl);
  return source.document || downloadArticleDocument(source.target, timeoutSeconds, fetchImpl);
}

export async function downloadArticleDocument(target, timeoutSeconds, fetchImpl = fetch) {
  const response = await fetchImpl(target, { signal: AbortSignal.timeout(timeoutSeconds * 1000),
    redirect: 'follow', headers: requestHeaders(target) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const resolvedUrl = response.url || target;
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
export async function enrichOfficialRowsWithContent(rows, args, collectedAt, company, { yieldSlot = task => task() } = {}) {
  rows = selectDetailRows(rows, args.maxVerifyPerCompany);
  if (!args.fetchOfficialContent) {
    return { rows: rows.filter(row => row.link_verdict !== 'fetch_to_verify'), requestCount: 0, errors: [] };
  }

  const enriched = [];
  const errors = [];
  let requestCount = 0;
  let detailCount = 0;
  let verifyCount = 0;

  for (const row of rows) {
    if (row.content_text && row.link_verdict !== 'fetch_to_verify') {
      enriched.push(row);
      continue;
    }
    // 확인 대상은 회사마다 몇 건까지만 받아본다. 확실한 기사가 먼저 줄을 서 있으므로,
    // 이 상한에 걸리는 것은 언제나 그다음으로 가능성이 낮은 링크다.
    if (row.link_verdict === "fetch_to_verify") {
      if (verifyCount >= args.maxVerifyPerCompany) {
        recordExclusion(row.company, row.title, row.url, "verify_budget_exhausted");
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
        recordExclusion(row.company, row.title, row.url, "no_article_title");
        continue;
      }
      // 확인 대상은 문서를 봐야 판정이 끝난다. 못 받아봤으면 링크만 보고 들일 수 없다.
      if (row.link_verdict === "fetch_to_verify") {
        recordExclusion(row.company, skipTitle, row.url, "unverified_no_fetch");
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
        recordExclusion(row.company, skipTitle, row.url, "unreadable_undated_file");
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

    try {
      let document;
      if (row.source_type === 'official' && !/\.pdf(?:[?#]|$)/i.test(detailUrl)) {
        requestCount += 1;
        detailCount += 1;
        document = { html: await fetchText(detailUrl, args.timeoutSeconds), resolvedUrl: detailUrl };
      } else {
        const resolve = () => probePublisher(detailUrl, async () => {
          requestCount += 1;
          detailCount += 1;
          return resolveArticleSource(detailUrl, args.timeoutSeconds);
        });
        const source = isGoogle(detailUrl) ? await yieldSlot(resolve) : await resolve();
        document = source && (source.document || await downloadArticleDocument(source.target, args.timeoutSeconds));
      }
      if (!document) {
        if (row.link_verdict === 'fetch_to_verify') {
          recordExclusion(row.company, row.title, row.url, 'unverified_no_fetch');
          continue;
        }
        enriched.push({ ...row, content_fetch_status: 'publisher_url_unresolved' });
        continue;
      }
      const html = document.html;
      let content = document.content ?? extractArticleText(html);
      const pageTitle = extractPageTitle(html);
      const resolvedTitle = chooseBetterTitle(row.title, pageTitle, row.url, company);
      if (row.publisher_resolution === 'official_exact_title' &&
          !fetchedTitleMatchesPublisherArticle(row, pageTitle || content.split(/\r?\n/, 1)[0])) {
        throw new Error('publisher_article_title_mismatch');
      }
      let contentFetchStatus = content ? 'fetched' : 'empty';
      // Some official AEM pages return only a title shell in HTML. After an
      // independently discovered same-host exact-title URL, try that page's
      // same-path model once. The model helper accepts content only when its
      // own title identifies the same article.
      if (row.publisher_resolution === 'official_exact_title' && content.length < ARTICLE_BODY_MIN_CHARS) {
        const modelUrl = aemModelUrl(document.resolvedUrl);
        try {
          requestCount += 1;
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
      const limitedContent = content.slice(0, args.contentCharLimit);
      // 목록에 날짜가 있어도 기사 페이지를 다시 읽는다. 더 강한 근거가 있는지, 두 날짜가 어긋나는지는
      // 상세 페이지를 보고 나서야 알 수 있다.
      const bodyHead = content.slice(0, 4000);
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
      if (!verdict.ok) {
        recordExclusion(row.company, resolvedTitle || row.title, row.url, verdict.reason);
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
        content_fetch_status: contentFetchStatus,
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
      if (row.link_verdict === 'fetch_to_verify') {
        recordExclusion(row.company, row.title, row.url, 'unverified_fetch_error');
        continue;
      }
      // 받아오지 못한 기사도 제목·URL에 남은 날짜는 살린다. 2026-08 실행에서 /2026/04/ 경로의 Air Products
      // 실적 발표가 날짜 미상으로 남아 8월 수집 보완 대상에 섞였다.
      enriched.push({
        ...row,
        ...chooseDateEvidence([
          ...(row.date_candidates || []),
          dateEvidence(extractDateFromText(row.title) || extractMonthFromText(row.title), "text", "context"),
          dateEvidence(sitemapUrlDate(row.url), "url", "context"),
        ]),
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
  return [...rows].sort((a, b) => (a.link_rank ?? 0) - (b.link_rank ?? 0)).slice(0, limit);
}

// 대체 수집 뒤 기업 자리(maxPerCompany)를 채우는 순서: 이번 달로 쓸 수 있는 기사, 나머지 자체 출처,
// 대체 수집, 상세 페이지를 받아 보니 기간 밖이던 자체 출처. 목록에 날짜가 없어 자리를 받은 기사가
// 받아 보면 기간 밖인 경우가 많다. 2026-08 실행(34921453566)에서 538행 중 161행이 그랬고, BASF·Shin-Etsu·Maxon 은
// 이번 달 기사가 없어 Google News 를 찾고도 기간 밖 공식 기사 10건 뒤에 서서 남은 대체 기사가 없었다.
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
      const xml = await fetchText(entry.url, timeoutSeconds);
      requestCount += 1;
      rows.push(...sitemapRows(xml, company, entry, dateRange, collectedAt).slice(0, maxPerSource));
    } catch (error) {
      errors.push({ source_url: entry.url, source_name: entry.source || "Official news sitemap", kind: "sitemap", error: error.message });
    }
  }
  return { rows, requestCount, errors };
}

async function collectCompany(company, sourceConfig, selectedSources, args, dateRange, collectedAt, slot = {}) {
  const companyRows = [];
  const publisherCandidates = [];
  const errors = [];
  let requestCount = 0;

  for (const source of selectedSources) {
    let result = { rows: [], requestCount: 0 };
    try {
      if (source === "official_feeds") {
        result = await collectOfficialFeeds(company, sourceConfig, dateRange, args.maxPerSource, args.timeoutSeconds, collectedAt);
      } else if (source === "official_pages") {
        result = await collectOfficialPages(company, sourceConfig, dateRange, args.maxPerSource, args.timeoutSeconds, collectedAt);
      } else if (source === "official_sitemaps") {
        result = await collectOfficialSitemaps(company, sourceConfig, dateRange, args.maxPerSource, args.timeoutSeconds, collectedAt);
      } else if (source === "sec_filings") {
        result = await collectSecFilings(company, sourceConfig, dateRange, args.maxPerSource, args.timeoutSeconds, collectedAt);
      } else if (source === "google_news") {
        // Decide after official detail/date enrichment, not from undated listing links.
        continue;
      } else if (source === "gdelt") {
        result = await collectGdelt(company, dateRange, args.maxPerSource, args.timeoutSeconds, collectedAt);
      } else {
        throw new Error(`Unknown source: ${source}`);
      }
      companyRows.push(...result.rows);
      publisherCandidates.push(...(result.recoveryCandidates || result.rows || []));
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

  // Drop disabled probes before the company cap; keep priority through fetching.
  const candidateRows = selectDetailRows(sortRows(dedupeRows(companyRows)), args.maxVerifyPerCompany);
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
      (args.fallbackMode !== "missing" || usable.length < args.fallbackMinResults)) {
    stats.fallback = "run";
    try {
      const fallback = await collectGoogleNews(company, dateRange, args.maxPerSource, args.timeoutSeconds, collectedAt);
      stats.fallback_found = fallback.rows.length;
      requestCount += fallback.requestCount;
      if (fallback.requestCount > 0) await sleep(args.rateLimitSeconds * 1000);
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
      const fallbackRows = rows.filter(row => row.source_type !== 'official');
      stats.fallback_kept = fallbackRows.length;
      const detailedFallback = await enrichOfficialRowsWithContent(fallbackRows, args, collectedAt, company, slot);
      requestCount += detailedFallback.requestCount;
      errors.push(...detailedFallback.errors);
      const byUrl = new Map(detailedFallback.rows.map(row => [row.url, row]));
      rows = rows.map(row => byUrl.get(row.url) || row);
    } catch (error) {
      stats.fallback = "error";
      errors.push({ target_no: company.target_no, company: company.company, source: "google_news", error: error.message });
    }
  }
  return { rows, requestCount, errors, stats };
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
      const { outDir, refresh, ...settings } = args;
      const result = await collectWithCheckpoint({ directory: path.join(args.outDir, 'company_progress'),
        identity: { version: CONTENT_COLLECTION_VERSION, company, sourceConfig, settings, active_sources: selectedSources,
          period: { from: dateRange.fromDate, to: dateRange.toDate } }, refresh,
        collect: () => collectCompany(company, sourceConfig, selectedSources, args, dateRange, collectedAt, { yieldSlot }) });
      result.timing = { company: company.company, elapsed_ms: Date.now() - started,
        request_count: result.requestCount, result_count: result.rows.length, cached: result.cached };
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
    collection_resume_version: 1,
    collection_input_digest: collectionInputDigest(companies, sourceConfig),
    html_network: domainGuard.stats,
    cached_company_count: companyResults.filter(result => result.cached).length,
    retryable_company_count: companyResults.filter(retryableCollection).length,
    collection_coverage: companies.map((company, index) => ({ company: company.company,
      status: collectionBlockingErrors(companyResults[index].errors).length ? 'incomplete' : 'completed',
      retryable: retryableCollection(companyResults[index]), cached: companyResults[index].cached })),
    run_finished_at: utcNow(),
    company_timings: companyResults.map(result => result.timing),
    // 체크포인트에서 온 옛 결과에는 stats 가 없어 기업 이름만 남는다.
    company_collection_stats: companies.map((company, index) => ({ company: company.company, ...(companyResults[index].stats || {}) })),
    companies_cut_by_company_cap: companyResults.filter(result => result.stats?.cut_by_company_cap > 0).length,
    fallback_skipped_company_count: companyResults.filter(result => result.stats?.fallback === 'skipped_has_monthly_source').length,
    skipped_unresolved_publisher_count: finalRows.filter(row => row.content_fetch_status === 'publisher_url_unresolved').length,
    publisher_resolution_count: finalRows.filter(row => row.publisher_resolution === 'official_exact_title').length,
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
    link_verdict_counts: Object.fromEntries(linkVerdictCounts),
    max_verify_per_company: args.maxVerifyPerCompany,
    excluded_non_article_count: excludedTotal,
    excluded_non_article_reasons: Object.fromEntries(excludedCounts),
    excluded_non_article_sample_count: excludedSamples().length,
    excluded_non_article_samples: excludedSamples(),
    excluded_non_article_sample_reasons: Object.fromEntries(
      [...excludedByReason].map(([reason, rows]) => [reason, rows.length]),
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
