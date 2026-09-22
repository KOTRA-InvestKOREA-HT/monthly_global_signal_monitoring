#!/usr/bin/env node
// Local product path: collect/prepare -> agent-authored reviews -> existing PDF renderer.
// This script never calls a model API or changes outputs/latest_*.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { APPROVAL_POLICY, validateRows, investmentStageSupported, targetTechnologyRequired } from "./validate_report_inputs.mjs";
// 로컬 판정자도 API 가 받는 지시문을 그대로 받는다. 예전에는 정책 문서(REVIEW.md)만 주었고,
// 그 문서 밖에 있는 지시(근거 인용 방법, 문안 작성 규칙, 날짜 처리, 응답 형식)는 전달되지 않았다.
// 같은 기준으로 판정하라면서 기준의 3분의 1을 빼고 주던 셈이다.
import { DEFAULT_VARIANT, buildSystemInstruction, promptContract, reviewPromptDigest } from "./review_prompts.mjs";
import { modelCandidate, technologyTranslationError } from "./model_input.mjs";
import { dateLabelKo, hasArticleBody, periodPlacement, reportEligible, resolveDateState, reviewCandidate } from "./date_state.mjs";
// 수집기의 날짜 파서를 그대로 쓴다. 검토 단계가 자기 날짜 문법을 갖게 되면, 수집기가 날짜로
// 읽지 못한 표기를 검토 단계가 받아들여 두 단계의 게시일 판정이 갈린다.
import { extractDateFromText, extractMonthFromText } from "./collect_company_signals.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 기술 그룹별로 무엇이 타겟 품목이고 무엇이 아닌지 적은 범위. 기술 매핑(company_technology_map.json)과 따로 두는 것은
// 매핑을 바꾸면 정책 식별자가 바뀌어 전체 기사가 다시 판정되기 때문이다. 범위가 붙은 기사만 ID 가 바뀌어 다시 판정된다.
export const TECHNOLOGY_SCOPES = (() => {
  try { return JSON.parse(readFileSync(path.join(ROOT, "config/technology_scope.json"), "utf8")).groups || {}; }
  catch (error) { if (error.code === "ENOENT") return {}; throw error; }
})();
const POLICY_VERSION = "local-report-v3";
const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
// Read old saved reviews without rewriting them. A present but empty new field
// must fail validation, not silently fall back to an old explanation.
export const decisionReason = decision => clean(Object.hasOwn(decision, 'reason') ? decision.reason : decision.reason_ko);
// Compare typographic equivalents only; preserve words, numbers and block boundaries.
// 수집 본문에는 &ouml; 같은 이름 있는 HTML 엔티티가 풀리지 않은 채 남기도 한다. 모델은 이를 "Göschwitz"로
// 옮겨 적으므로, 엔티티를 풀지 않으면 올바른 인용도 원문에 없다고 판정된다. 2026-08 전체 재검토에서 Jenoptik
// 기사가 이 때문에 첫 시도에서 떨어졌고, 재시도까지 실패해 보고서 생성이 멈췄다.
const LATIN1_ENTITY_NAMES = ("nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn " +
  "sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring " +
  "AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash " +
  "Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml " +
  "igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml").split(" ");
const HTML_ENTITIES = {
  // U+00A0 부터 U+00FF 까지 순서대로 붙은 이름이다.
  ...Object.fromEntries(LATIN1_ENTITY_NAMES.map((name, index) => [name, String.fromCodePoint(0xa0 + index)])),
  OElig: 'Œ', oelig: 'œ', Scaron: 'Š', scaron: 'š', Yuml: 'Ÿ', euro: '€', hellip: '…', bull: '•', trade: '™',
  sbquo: '‚', bdquo: '„', lsaquo: '‹', rsaquo: '›', minus: '−',
  // 인용 대조용으로 모양을 맞춘다. 공백·따옴표·대시는 아래에서 한 가지 모양으로 모은다.
  amp: '&', quot: '"', apos: "'", nbsp: ' ', lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', ndash: '-', mdash: '-',
};

export function normalizeQuote(value) {
  const entities = HTML_ENTITIES;
  return clean(String(value || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (match, entity) => {
    if (!entity.startsWith('#')) return Object.hasOwn(entities, entity) ? entities[entity] : match;
    const code = /^#x/i.test(entity) ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
  }).normalize('NFC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/[₀-₉]/g, digit => String(digit.charCodeAt(0) - 0x2080)))
    // Financial tables pad currency prefixes and percent suffixes with NBSP.
    // Do not collapse spaces between numbers or otherwise alter numeric values.
    .replace(/([$€£¥₩]) +(?=\d)/g, '$1')
    .replace(/(\d) +%/g, '$1%');
}
// 인용 검증은 "이 문장이 기사에 있었다"만 증명한다. 요약이 그 문장에 대해 말하는지는
// 증명하지 않는다. 34546694524 실행의 Applied Materials S4 가 그 틈으로 나갔다: 승인 근거는
// "Announced three additional EPIC Center partnerships." 한 줄인데, 보고서에 실린 문안은
// 같은 기사의 분기 하이라이트 목록에 있던 6월 16일 에실로룩소티카 공동개발 계약이었다.
// 인용은 원문에 있었고 요약도 기사 안에 있었지만, 둘은 서로 다른 사건이다.
//
// 그래서 시그널 문안이 인용문에 없는 제3자를 새로 불러오지 못하게 한다. 이름의 표기 차이
// ("Volkswagen's PowerCo" 대 "Volkswagen Group-owned PowerCo")로 막히면 안 되므로,
// 구절 전체가 아니라 이름을 이루는 낱말 단위로 대조한다.
// "UK-based", "Germany-based" 의 based 는 이름이 아니다. 실행 35175067142 에서 Nexeon S3 요약의 "UK-based" 가
// 이 검사에 걸려 1억 파운드 조달 기사 전체가 저장되지 않았다(국가 표기 UK 는 두 글자라 원래 검사하지 않는다).
const NAME_STOPWORDS = new Set(["the", "and", "for", "with", "from", "group", "inc", "corp",
  "ltd", "llc", "gmbh", "plc", "company", "technologies", "holdings", "limited", "based"]);

// 직함은 이름이 아니다. 영어는 직함을 대문자로 적으므로 대문자 규칙만으로는 기관명과 구분되지 않는다.
// 실행 35549566837 의 Jenoptik 이 그랬다. 독일어 원문 "Vorstandsvorsitzender" 를 정상 번역한
// "Chief Executive Officer" 가 인용문에 그 영어 낱말이 없다는 이유로 근거 없는 이름이 됐다.
// 기관 종류를 뜻하는 낱말(ministry, university, institute)은 넣지 않는다. 그것이 빠지면
// 인용에 없는 기관을 새로 불러오는 요약을 놓친다.
const ROLE_WORDS = new Set(["chief", "executive", "officer", "president", "vice", "chairman", "chairwoman",
  "chairperson", "chair", "director", "managing", "deputy", "senior", "head", "interim", "acting",
  "general", "manager", "board", "member", "founder", "cofounder", "partner", "secretary", "treasurer",
  "principal", "lead", "global", "regional", "operating", "financial", "technology", "technical",
  "commercial", "scientific", "medical", "digital", "strategy", "marketing", "sales", "human", "resources"]);

// 달력 낱말도 이름이 아니다. Veolia 요약의 "August" 가 이름 검사에 걸렸다. 월 이름이 이름이 아닌 것과
// 그 날짜에 근거가 있는지는 서로 다른 질문이라, 날짜는 ungroundedSummaryDates 가 따로 본다.
const CALENDAR_WORDS = new Set(["january", "february", "march", "april", "june", "july", "august",
  "september", "october", "november", "december", "monday", "tuesday", "wednesday", "thursday",
  "friday", "saturday", "sunday", "quarter", "half", "year", "month", "week"]);

// May 와 March 는 달 이름이면서 보통 낱말이고 회사 이름일 수도 있다. 달로 읽히는 자리에서만 달로 본다.
const AMBIGUOUS_MONTH = /\b(May|March)\b(?=\s+\d|\s+of\b|\s*,\s*\d)|(?<=\b(?:in|on|by|since|until|from|during)\s)\b(?:May|March)\b/;

const nameWords = (phrase) => phrase.split(/[^A-Za-z0-9]+/).filter((word) => {
  const lower = word.toLowerCase();
  return word.length >= 4 && !NAME_STOPWORDS.has(lower) && !ROLE_WORDS.has(lower) && !CALENDAR_WORDS.has(lower);
});

// 모델이 붙이는 " - " 앞 머리글은 항목에 이름을 붙이는 말이지 제3자에 대한 주장이 아니다.
const summaryBody = (text) => {
  const value = clean(text);
  const cut = value.indexOf(" - ");
  return cut >= 0 ? value.slice(cut + 3) : value;
};

// 문장 첫머리 대문자는 이름의 근거가 되지 못하므로 건너뛴다. 대문자가 두 번 이상 나오거나
// (UC Berkeley, EssilorLuxottica) 첫 글자만 대문자인 한 낱말(Bitterfeld)을 이름으로 본다.
export function summaryNames(text) {
  const names = [];
  for (const sentence of summaryBody(text).split(/(?<=[.!?])\s+/)) {
    const pattern = /\b([A-Z][A-Za-z0-9&.-]*(?:'s)?(?:\s+[A-Z][A-Za-z0-9&.-]*(?:'s)?)*)/g;
    let match;
    while ((match = pattern.exec(sentence))) {
      const phrase = match[1].replace(/[.'\s]+$/, "").trim();
      if (match.index === 0) continue;
      if (phrase.length < 4) continue;
      if (!/[A-Z].*[A-Z]/.test(phrase) && !/^[A-Z][a-z]{3,}$/.test(phrase)) continue;
      names.push(phrase);
    }
  }
  return [...new Set(names)];
}

// 인용문과 기사 제목에 낱말이 하나도 빠짐없이 남아 있어야 근거 있는 이름이다.
export function ungroundedSummaryNames(summaryEn, quotes, title) {
  const grounded = clean([...(quotes || []), title].join(" ")).toLowerCase();
  return summaryNames(summaryEn).filter((name) => {
    const words = nameWords(name);
    // 직함과 달력 낱말만 남은 구절은 이름이 아니다. 검사할 낱말이 없으면 이름으로 세지 않는다.
    return words.length > 0 && words.some((word) => !grounded.includes(word.toLowerCase()));
  });
}

// 요약이 말하는 달이 이 기사에 있는지. 예전에는 월 이름이 고유명사 검사에 걸려 우연히 막혔고,
// 그래서 정상 번역된 직함까지 같은 검사에 걸렸다. 두 질문을 갈라 놓는다.
// 근거는 인용문이 아니라 기사 본문 전체로 본다. 사건의 달은 기사 단위 사실이라 고른 인용문 밖에
// 있을 수 있다. 기사 어디에도 없는 달이면 요약이 지어낸 것이다.
const SUMMARY_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december"];
export function ungroundedSummaryDates(summaryEn, evidence, title) {
  const text = summaryBody(clean(summaryEn));
  const grounded = clean([...(evidence || []), title].join(" ")).toLowerCase();
  const stated = new Set();
  for (const month of SUMMARY_MONTHS) {
    const pattern = new RegExp(`\\b${month}\\b`, "i");
    if (!pattern.test(text)) continue;
    // May·March 는 달 이름이면서 보통 낱말이다. 달로 읽히는 자리에서만 센다.
    if ((month === "may" || month === "march") && !AMBIGUOUS_MONTH.test(text)) continue;
    if (!pattern.test(grounded)) stated.add(month[0].toUpperCase() + month.slice(1));
  }
  // 연-월-일 표기도 같은 기준으로 본다.
  for (const [iso] of text.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)) {
    if (!grounded.includes(iso.toLowerCase())) stated.add(iso);
  }
  return [...stated];
}

// 요약에 적힌 숫자·금액·통화가 기사에 있는지 본다. 인용 검증은 문장이 기사에 있었다는 것만 증명하고,
// 요약이 그 숫자를 제대로 옮겼는지는 보지 않는다. 2026-08 보고서(9월 14일 실행)에서 원문 "61%"가 한글
// 요약에 "69%"로 실렸고, 통화 기호가 없는 ASML "9.33 billion"에는 "달러"가 붙었다.
// 억·만 단위 금액은 값으로 바꿔 billion·million 과 대조한다. 날짜·분기·순번, 연도, 한 자리 정수,
// 영문자에 붙은 번호(RLE100, Q3, FY26)는 보지 않는다. 표기 차이로 생기는 오탐이 남으므로 importReview 는
// 새로 받은 응답에서만(strictNumbers) 되묻고, 재시도 뒤에도 숫자만 걸리면 경고를 남기고 받는다.
// 통화 코드를 앞에 두고 백만 단위를 m 으로 적는 공시가 있다(2026-08 Vestas "EUR 4,723m").
const AMOUNT_SCALE = { trillion: 1e12, tn: 1e12, billion: 1e9, bn: 1e9, million: 1e6, mn: 1e6, m: 1e6, thousand: 1e3, k: 1e3,
  "兆": 1e12, "億": 1e8, "万": 1e4, "조": 1e12, "억": 1e8, "만": 1e4 };
const CURRENCY_CODE = { "$": "USD", "US$": "USD", "A$": "USD", "C$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "₩": "KRW",
  usd: "USD", dollar: "USD", dollars: "USD", "달러": "USD", eur: "EUR", euro: "EUR", euros: "EUR", "유로": "EUR",
  gbp: "GBP", pound: "GBP", pounds: "GBP", "파운드": "GBP", jpy: "JPY", yen: "JPY", "円": "JPY", "엔": "JPY",
  krw: "KRW", "원": "KRW", chf: "CHF", franc: "CHF", francs: "CHF", "프랑": "CHF" };
const CURRENCY_MARKER = { USD: /\$|\bUSD\b|dollar/i, EUR: /€|\bEUR\b|euro/i, GBP: /£|\bGBP\b|pound|sterling/i,
  JPY: /¥|円|\bJPY\b|\byen\b/i, KRW: /₩|\bKRW\b|\bwon\b|원/i, CHF: /\bCHF\b|franc/i };
const LATIN_AMOUNT = /(US\$|A\$|C\$|[$€£¥₩]|(?:USD|EUR|GBP|JPY|CHF)(?=\s?\d))?\s?(?<![A-Za-z0-9.,])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s?(%|percent\b|trillion\b|billion\b|million\b|thousand\b|tn\b|bn\b|mn\b|m\b|k\b|兆|億|万)|(?![A-Za-z0-9]))(?:\s?(?:(USD|EUR|GBP|JPY|KRW|CHF|dollars?|euros?|pounds?|yen|francs?)\b|(円)))?/gi;
const KOREAN_AMOUNT = /(?<![A-Za-z0-9.,])((?:\d+(?:\.\d+)?\s?[조억만]\s?)*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?![A-Za-z0-9.,])\s?([조억만])?\s?(%|퍼센트|달러|유로|파운드|엔|원|프랑|년|월|일|분기|개월|주년|주|차|번째|위|세대|호|시|분|배)?/g;
const KOREAN_SKIP = new Set(["년", "월", "일", "분기", "개월", "주년", "주", "차", "번째", "위", "세대", "호", "시", "분", "배"]);

const sameValue = (a, b) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-6);
const plainNumber = (text) => Number(String(text).replace(/,/g, ""));

function koreanValue(digits, unit = "") {
  let total = 0;
  for (const [, number, scale] of `${String(digits).replace(/,/g, "")}${unit}`.matchAll(/(\d+(?:\.\d+)?)\s?([조억만])?/g)) {
    total += Number(number) * (AMOUNT_SCALE[scale] || 1);
  }
  return total;
}

function sourceAmounts(text) {
  return [...text.matchAll(LATIN_AMOUNT)].map((match) => {
    const raw = plainNumber(match[2]);
    return { raw, scaled: raw * (AMOUNT_SCALE[String(match[3] || "").toLowerCase()] || 1),
      start: match.index, end: match.index + match[0].length };
  });
}

function summaryAmounts(summary, lang) {
  const text = normalizeQuote(summary);
  if (lang === "ko") {
    return [...text.matchAll(KOREAN_AMOUNT)].flatMap((match) => {
      const suffix = match[3] || "";
      if (KOREAN_SKIP.has(suffix)) return [];
      const scaled = Boolean(match[2]) || /[조억만]/.test(match[1]);
      return [{ label: match[0].trim(), value: scaled ? koreanValue(match[1], match[2]) : plainNumber(match[1]),
        scaled, percent: suffix === "%" || suffix === "퍼센트", currency: CURRENCY_CODE[suffix] || "" }];
    });
  }
  return [...text.matchAll(LATIN_AMOUNT)].map((match) => {
    const unit = String(match[3] || "").toLowerCase();
    const word = String(match[4] || match[5] || "").toLowerCase();
    return { label: match[0].trim(), value: plainNumber(match[2]) * (AMOUNT_SCALE[unit] || 1), scaled: Boolean(AMOUNT_SCALE[unit]),
      percent: unit === "%" || unit === "percent", currency: CURRENCY_CODE[match[1] || ""] || CURRENCY_CODE[String(match[1] || "").toLowerCase()] || CURRENCY_CODE[word] || "" };
  });
}

const worthChecking = (item) => item.percent || item.scaled || item.currency ||
  !(Number.isInteger(item.value) && (item.value < 10 || (item.value >= 1900 && item.value <= 2100)));

export function summaryNumberProblems(summary, evidenceTexts, lang = "en") {
  if (!clean(summary)) return [];
  const source = (evidenceTexts || []).map(normalizeQuote).join("\n");
  const amounts = sourceAmounts(source);
  const problems = [];
  for (const item of summaryAmounts(summary, lang).filter(worthChecking)) {
    const found = amounts.filter((amount) => sameValue(amount.raw, item.value) || sameValue(amount.scaled, item.value));
    if (!found.length) {
      problems.push(item.label);
    } else if (item.currency && !found.some((amount) =>
      CURRENCY_MARKER[item.currency].test(source.slice(Math.max(0, amount.start - 8), amount.end + 14)))) {
      problems.push(`${item.label} (${item.currency} not stated for this amount)`);
    }
  }
  return [...new Set(problems)];
}

export function decisionNumberProblems(article, decision) {
  return [...summaryNumberProblems(decision.summary_ko, article.evidence, "ko"),
    ...summaryNumberProblems(decision.summary_en, article.evidence, "en")];
}

const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
const read = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const write = async (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

export function monthPeriod(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || "")) throw new Error("Use --month YYYY-MM");
  const start = `${month}-01`;
  const next = new Date(`${start}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { from_date: start, to_date: new Date(next.getTime() - 86400000).toISOString().slice(0, 10) };
}

// 보고서 본문에 쓸 수 있는 기사인지 본다. 게시월까지 확정된 기사만 참이다.
// 검토 대상 여부는 이보다 넓다. reviewCandidate가 그 판단을 맡는다.
export function inPeriod(row, period) {
  return reportEligible(row, period);
}

function dateFields(row, period) {
  const placement = periodPlacement(row, period);
  return {
    published_at: row.published_at || null,
    published_month: placement.state.month,
    date_status: placement.state.status,
    date_placement: placement.placement,
    date_note: placement.reason,
    date_label: dateLabelKo(row),
  };
}

function withoutAI(row) {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("ai_")));
}

export function groupArticles(investment, relevant, period, policy = POLICY_VERSION) {
  const groups = new Map();
  for (const [kind, rows] of [["investment", investment], ["relevant", relevant]]) {
    for (const original of rows) {
      // 날짜가 확정되지 않아도 내용 판정 기회는 준다. 보고서 반영 여부는 date_placement가 따로 들고 있다.
      if (!reviewCandidate(original, period).included) continue;
      const row = withoutAI(original);
      const key = JSON.stringify([row.target_no, row.company, row.url || row.title]);
      if (!groups.has(key)) groups.set(key, {
        company: row.company, target_no: row.target_no, url: row.url, title: row.title,
        reporting_period: { from_date: period.from_date, to_date: period.to_date },
        target_identity: row.target_identity || { names: [row.company, ...(row.query_aliases || [])] },
        content_source_url: row.content_source_url || "",
        source: row.source, source_type: row.source_type,
        publisher: row.publisher || "", publisher_home_url: row.publisher_home_url || "",
        ...dateFields(row, period),
        evidence: [], candidates: [],
      });
      const article = groups.get(key);
      for (const text of [row.title, row.content_text, row.content_excerpt,
        ...(row.evidence_snippets || []), ...(row.technology_evidence_snippets || [])]) {
        // 이미 실린 근거 안에 그대로 들어 있는 글은 다시 싣지 않는다. 본문 발췌는 본문 앞부분을 자른 것이라
        // 둘 다 보내면 같은 내용이 두 번 간다(2026-08 HyproMag: 803자 발췌가 19,464자 본문에 그대로 있었다).
        if (clean(text) && !article.evidence.some((block) => block.includes(clean(text)))) article.evidence.push(clean(text));
      }
      // 모델이 보는 표현은 model_input.mjs 가 정한다. 지표 이름·설명은 후보에 싣지 않는다.
      // 후보 id 가 판정 기준의 S1~S5 를 가리키고, 그 정의는 기준 문서 한 곳에만 있다.
      // 한국어 원본은 아래 row 에 그대로 붙어 보고서·화면·수집 설정이 쓰던 그대로 남는다.
      const candidate = modelCandidate({ kind, row });
      if (article.candidates.some((item) => item.id === candidate.id)) {
        throw new Error(`Duplicate candidate: ${row.company} ${row.url} ${candidate.id}`);
      }
      article.candidates.push({ ...candidate, row });
    }
  }
  return [...groups.values()].map((article) => {
    article.evidence.sort();
    article.candidates.sort((a, b) => a.id.localeCompare(b.id));
    // 신규 사건 판정에는 보고 기간과 기사 날짜가 쓰인다. 날짜 보강으로 판단 근거가
    // 달라지면 재검토한다. 표시용 설명과 발행사 메타데이터만 캐시 식별자에서 제외한다.
    const { date_note, date_label, publisher, publisher_home_url, ...content } = article;
    const material = { ...content, policy, candidates: article.candidates.map(({ row, ...item }) => item) };
    return { ...material, date_note, date_label,
      publisher, publisher_home_url, id: hash(material), candidates: article.candidates };
  });
}

// Every in-month source reaches the agent, including keyword/technology filter misses.
export function sourceCandidates(signals, technology, indicators, period, scopes = TECHNOLOGY_SCOPES) {
  const investment = [], relevant = [], seen = new Set(), deferred = [];
  for (const signal of signals) {
    const placement = reviewCandidate(signal, period);
    if (!placement.included) {
      // 근거도 본문도 없어 검토를 미룬 기사는 세어 둔다. 수집 보완 대상이지 판정이 끝난 기사가 아니다.
      if (placement.placement === "date_pending") deferred.push({ company: signal.company, url: signal.url, title: signal.title, reason: placement.reason });
      continue;
    }
    const key = JSON.stringify([signal.target_no, signal.company, signal.url || signal.title]);
    if (seen.has(key)) throw new Error(`Duplicate source article: ${signal.company} ${signal.url}`);
    seen.add(key);
    const tech = technology.companies.find((item) => item.company === signal.company && item.target_no === signal.target_no);
    if (!tech) throw new Error(`Missing target technology: ${signal.company}`);
    // 모델 입력은 영어 기술 표현을 쓴다. 번역이 없는 기업을 빈 문자열이나 한국어로 조용히 보내지
    // 않고 여기서 멈춘다. 기술 그룹 ID 를 함께 적어 어느 번역을 채워야 하는지 드러낸다.
    const translationError = technologyTranslationError(tech);
    if (translationError) throw new Error(translationError);
    const scope = scopes[tech.technology_group];
    const row = { ...withoutAI(signal), ...tech, company: signal.company,
      ...(scope ? { target_technology_scope: scope } : {}),
      technology_gate_decision: tech.excluded_from_relevance ? "relevance_exempt" : "agent_review",
      candidate_origin: "all_month_sources",
      date_status: placement.state.status, date_placement: placement.placement, date_note: placement.reason };
    relevant.push(row);
    for (const indicator of indicators.indicators) investment.push({ ...row,
      investment_signal_no: indicator.no, investment_signal_id: indicator.id,
      investment_signal_label: indicator.label_ko, investment_signal_label_en: indicator.label_en,
      investment_signal_description: indicator.description_ko,
    });
  }
  return { investment, relevant, deferred };
}

const BOOLEANS = ["entity_supported", "target_technology_supported", "indicator_supported", "leading_indicator_supported"];

// 이 후보가 승인되려면 품목 연결 근거가 필요한가. 면제 기업과 기업 단위 지표(3·5)는 필요하지 않다.
// 판정 자체는 언제나 근거대로 기록된다. 여기서 가르는 것은 그 판정을 승인 조건으로 쓸지뿐이다.
const technologyRequired = (candidate) =>
  targetTechnologyRequired(candidate?.row?.investment_signal_no, candidate?.relevance_exempt);
const technologyMet = (candidate, decision) =>
  !technologyRequired(candidate) || decision.target_technology_supported;

// 인용문이 실제로 말하고 있는 날짜. 일자까지 적혔으면 일자와 월을, 월만 적혔으면 월만 돌려준다.
// 아무 날짜도 읽히지 않으면 null 이고, 그때 제안은 근거 없는 날짜다.
function dateStatedInQuote(quote) {
  const day = extractDateFromText(quote);
  if (day) return { day: day.slice(0, 10), month: day.slice(0, 7) };
  const month = extractMonthFromText(quote);
  return month ? { day: "", month } : null;
}

// 승인 조건은 후보별로 정해진 것을 하나도 양보하지 않는다. 한때 조건과 무관하게 "딱 하나만
// 모자란" 투자 후보를 승인한 적이 있는데, 그렇게 실린 8건 가운데 6건이 타겟 기술 미확인이었고
// 2건은 이미 확정된 시설투자(committed)였다. 전조 아닌 사건·근거 부족은 이 보고서가 지금까지
// 잡아온 바로 그 오류라, 그 방어벽을 승인 단계에서 낮추지 않는다.
// 품목 연결을 어느 후보에 요구하는지는 targetTechnologyRequired 가 정한다. 기업 단위 지표(3·5)에서
// 그 조건을 빼는 것은 "하나 모자라도 통과"가 아니라 그 후보의 승인 조건이 처음부터 다르다는 뜻이다.
//
// 대신 아깝게 떨어진 후보는 대시보드에서 볼 수 있게 남긴다. 기업 귀속과 지표 사건이 확인되고
// 나머지 조건 가운데 모자란 것이 하나뿐인 투자 후보다. 둘 이상 모자라면 승인과 거리가 멀다.
// 2026-08 실행에서 감산 조치·지분 평가이익·타 사업 채권 발행이 그렇게 들어와 목록만 늘렸다.
// 이미 끝난 사건(completed)도 뺀다. 이 보고서는 앞으로의 투자 전조를 찾으므로, 실적·연차 자료가
// 다시 적은 완료된 증설·조달·가동 현황은 정의상 신호가 아니다.
//
// 이 행은 ai_signal_supported=false 로 나간다. 매트릭스와 다섯 지표 칸에는 실리지 않는다.
// 투자 후보의 근접 행은 대시보드가 사람에게 보여 주는 "확인해 볼 만한 후보" 목록이고,
// 사업동향의 근접 행은 그 기업의 사업현황 상자가 비는 것을 막는 데 쓰인다(report_content.best_business_row).
//
// 사업동향 후보도 같은 기준으로 센다. 예전에는 kind 가 investment 가 아니면 바로 false 였고,
// 그래서 사업동향은 근접 단계 자체가 없었다. 2026-08 실행의 Skyworks·Evonik·Jenoptik 은 승인된
// 사업동향이 0건이라 사업현황 상자가 세 기업 모두 "확인되지 않음"으로 나갔고, 무엇이 왜 떨어졌는지
// 출력에 남지 않아 볼 수도 없었다.
//
// 사업동향의 단계는 not_applicable 하나뿐이므로 투자 단계 조건은 세지 않는다. 그 대신 단계가
// 사업동향의 고정값인지를 먼저 확인한다. 투자 단계 조건을 그대로 대면 모든 사업동향 후보가
// 그 조건 하나를 늘 못 채운 것으로 세어져, 실제로 모자란 것이 하나일 때도 둘이 된다.
export function nearMissCandidate(candidate, decision) {
  if (candidate?.kind !== "investment" && candidate?.kind !== "relevant") return false;
  if (!decision.entity_supported || !decision.indicator_supported) return false;
  if (decision.event_stage === "completed") return false;
  const business = candidate.kind === "relevant";
  if (business && decision.event_stage !== APPROVAL_POLICY.business_stage) return false;
  const unmet = [
    technologyMet(candidate, decision),
    decision.leading_indicator_supported,
    business || investmentStageSupported(decision.event_stage, candidate.row?.investment_signal_no),
    decision.quality === "pass",
  ].filter((met) => !met).length;
  return unmet === 1;
}

// 모델 판정 가운데 코드로 확인할 수 있는 두 가지를 승인 전에 적용한다. 저장된 판정에도 그대로 걸린다.
// 본문 없는 기사는 승인하지 않는다(null). 제목은 사건을 가리킬 뿐 세부를 보여 주지 않는다.
// 2026-08 첫 실행(34915776314)에서 Ouster 제목 159자 하나로 S4 와 사업동향이 승인됐다. 이런 기사는
// articleCoverageGap 이 no_body 로 드러내고, 본문이 들어오면 근거가 바뀌어 기사 ID 도 바뀌므로 다시 검토된다.
// 같은 기사의 사업동향이 타겟 기술과 무관하다고 봤는데 투자 후보만 기술을 인정하면 그 인정은 쓰지 않는다.
// 같은 실행에서 GE Healthcare 의 CT 임상 협력이 '배양·정제 시스템' S4 로 승인됐다. 그 기술 인정을 취소한다.
export function decisionForApproval(article, decisions, decision) {
  if (!article.candidates.some((candidate) => hasArticleBody(candidate.row))) return null;
  // 명시적으로 식별된 동명 회사의 자체 사이트이고 타겟 정식명도 없으면 귀속을
  // 인정하지 않는다. 제3자 언론과 타겟을 명시한 협업 기사는 모델 판단을 유지한다.
  const identity = article.target_identity;
  let host = "";
  try { host = new URL(article.content_source_url || article.url).hostname.toLowerCase(); } catch {}
  const otherCompany = (identity?.unrelated_domains || []).some(domain => host === domain || host.endsWith(`.${domain}`));
  const text = (article.evidence || []).join(" ").toLowerCase();
  if (otherCompany && identity?.legal_name && !text.includes(identity.legal_name.toLowerCase())) {
    return { ...decision, entity_supported: false };
  }
  const candidate = article.candidates.find((item) => item.id === decision.candidate_id);
  const business = decisions.find((item) => item.candidate_id === "relevant");
  if (candidate?.kind === "investment" && !candidate.relevance_exempt &&
      decision.target_technology_supported === true && business?.target_technology_supported === false &&
      sameEventAsBusiness(decision, business)) {
    return { ...decision, target_technology_supported: false };
  }
  return decision;
}

// 같은 기사라는 것만으로 같은 사건이라고 볼 수 없다. 기사 하나가 증설 발표와 다른 부문 판매 실적을
// 함께 싣는 일이 흔하다. 두 후보가 같은 문장을 근거로 들었을 때만 같은 사건의 모순으로 본다.
// GE Healthcare 회귀는 이 기준으로도 잡힌다. 그 건은 CT 임상 협력이라는 한 사건을 두 후보가 같은
// 인용으로 판정했고, 사업동향만 타겟 기술이 아니라고 봤다.
export function sameEventAsBusiness(decision, business) {
  const quotes = (list) => new Set((list || []).map(normalizeQuote).filter(Boolean));
  const investmentQuotes = quotes(decision.evidence_quotes);
  const businessQuotes = quotes(business?.evidence_quotes);
  // 어느 쪽이든 인용이 없으면 같은 사건인지 가릴 수 없다. 예전처럼 사업동향 판정을 따른다.
  if (!investmentQuotes.size || !businessQuotes.size) return true;
  for (const quote of investmentQuotes) {
    for (const other of businessQuotes) {
      if (quote === other || quote.includes(other) || other.includes(quote)) return true;
    }
  }
  return false;
}

// Checks the review import boundary, then delegates report-row consistency to the existing validator.
// A quote match proves provenance only, not the truth of a model's interpretation.
// 인용·문안 검증과 무관한 판정 결과. 승인 여부만 본다.
// 후보별 승인 조건을 모두 만족해야 승인한다. 조건 하나가 모자란 투자 후보는 근접 후보로만 남긴다.
export function decisionOutcome(article, decisions, decision) {
  const candidate = article.candidates.find((item) => item.id === decision.candidate_id);
  if (!candidate) return { supported: false };
  const gated = decisionForApproval(article, decisions, decision);
  if (!gated) return { supported: false, gated };
  const supported = gated.entity_supported && technologyMet(candidate, gated) &&
    gated.indicator_supported && gated.leading_indicator_supported && gated.quality === "pass" &&
    (candidate.kind === "relevant" || investmentStageSupported(decision.event_stage, candidate.row?.investment_signal_no));
  // nearMiss 는 승인이 아니다. 대시보드에만 남는 근접 후보라 보고서에는 실리지 않는다.
  return { supported, nearMiss: !supported && nearMissCandidate(candidate, gated), gated };
}

export function importReview(article, review, { strictNumbers = false } = {}) {
  if (review.article_id !== article.id) throw new Error(`${article.company}: stale or mismatched article_id`);
  if (!clean(review.reviewer)) throw new Error(`${article.company}: reviewer is required`);
  if (!Array.isArray(review.decisions) || review.decisions.length !== article.candidates.length) {
    throw new Error(`${article.company}: review must cover every candidate exactly once`);
  }
  const seen = new Set();
  const evidence = article.evidence.map(normalizeQuote);
  // 검토자가 날짜를 제안하면 근거 문구를 함께 받는다. 인용이 확인돼도 게시일을 확정으로 올리지는 않는다.
  // 본문에서 처음 보이는 날짜는 사건 발생일일 수 있기 때문이다. 보강 단서로만 남긴다.
  if (clean(review.published_date) || clean(review.published_date_quote)) {
    const proposed = clean(review.published_date);
    if (!/^\d{4}-\d{2}(-\d{2})?$/.test(proposed)) {
      throw new Error(`${article.company}: published_date must be YYYY-MM-DD or YYYY-MM`);
    }
    const quote = normalizeQuote(review.published_date_quote);
    if (!quote || !evidence.some((text) => text.includes(quote))) {
      throw new Error(`${article.company}: published_date_quote must be an exact passage from this article`);
    }
    // 인용 검증은 그 문장이 기사에 있었다는 것만 증명한다. 그 문장이 이 날짜를 말한다는 것은
    // 증명하지 않으므로, 파서가 인용문에서 같은 날짜를 다시 뽑아낼 때만 제안을 받는다.
    // 제안한 정밀도로 대조한다. 일자까지 제안했으면 인용문에도 일자가 있어야 하고, 월만
    // 제안했으면 인용문의 날짜가 그 달이기만 하면 된다(정밀도를 낮춰 잡는 쪽은 안전하다).
    const stated = dateStatedInQuote(quote);
    if (!stated || (proposed.length === 10 ? stated.day !== proposed : stated.month !== proposed)) {
      throw new Error(`${article.company}: published_date_quote does not state ${proposed}`);
    }
  }
  return review.decisions.map((decision) => {
    const candidate = article.candidates.find((item) => item.id === decision.candidate_id);
    if (!candidate || seen.has(decision.candidate_id)) throw new Error(`${article.company}: unknown or duplicate candidate_id`);
    seen.add(decision.candidate_id);
    const context = `${article.company} ${candidate.id}`;
    for (const field of BOOLEANS) {
      if (typeof decision[field] !== "boolean") throw new Error(`${context}: missing boolean ${field}`);
    }
    if (!["pass", "needs_review"].includes(decision.quality)) throw new Error(`${context}: invalid quality`);
    if (!decisionReason(decision)) throw new Error(`${context}: reason is required`);
    if (candidate.kind === "relevant" && !decision.leading_indicator_supported) {
      throw new Error(`${context}: business rows use true for the non-applicable leading indicator field`);
    }
    // Everything an approval needs except the investment event stage.
    const approvableExceptStage = decision.entity_supported && technologyMet(candidate, decision) &&
      decision.indicator_supported && decision.leading_indicator_supported && decision.quality === "pass";
    const stages = candidate.kind === "relevant" ? ["not_applicable"] : ["exploratory", "planned", "precursor", "committed", "completed", "unclear"];
    // The provider schema offers not_applicable to both kinds, and a rejected
    // investment candidate has no event to stage. Accept that representation:
    // investmentStageSupported() never approves it, so it only records the
    // rejection the decision already made. Keep rejecting it when the stage is
    // the one thing standing between this decision and approval, because that
    // contradiction is what the retry exists to resolve and letting it through
    // would silently drop a supported signal.
    const noInvestmentEvent = candidate.kind === "investment" &&
      decision.event_stage === "not_applicable" && !approvableExceptStage;
    if (!stages.includes(decision.event_stage) && !noInvestmentEvent) throw new Error(`${context}: invalid event_stage`);
    const { supported, nearMiss, gated } = decisionOutcome(article, review.decisions, decision);
    // 재검토를 끝내지 못한 후보. 의심 판정을 AI 승인으로 발행하지 않는다. 인용이 원문과 맞지 않아
    // 뺀 후보도 여기에 들어오므로 엄격 검사를 걸지 않는다. 다음 실행이 이 기사를 다시 판정한다.
    const recheckPending = (review.semantic_recheck_pending?.candidate_ids || []).includes(candidate.id) &&
      (supported || nearMiss);
    // 승인 후보의 인용·문안 결함만 실행을 세운다. 결함을 고칠 재시도가 이 검사를 위해 존재한다.
    // 대시보드에만 남는 근접 후보는 세우지 않는다.
    const enforce = supported && !recheckPending;
    const quotes = decision.evidence_quotes;
    if (!Array.isArray(quotes) || quotes.some((quote) => typeof quote !== 'string' || !normalizeQuote(quote) || !evidence.some((text) => text.includes(normalizeQuote(quote))))) {
      throw new Error(`${context}: evidence_quotes must be exact passages from this article`);
    }
    // 다섯 지표 칸에만 건다. 사업동향 문안은 기사 전체를 풀어 쓰는 것이 일이라 지명·부문명이
    // 인용문 밖에서 나오는 것이 정상이고, 같은 기준을 대면 근거 있는 요약까지 막힌다.
    if (enforce && candidate.kind === "investment") {
      const ungrounded = ungroundedSummaryNames(decision.summary_en, quotes, article.title);
      if (ungrounded.length) {
        throw new Error(`${context}: summary names ${ungrounded.join(", ")} without an evidence quote. ` +
          `Quote the passage the summary describes, or summarize only the quoted event.`);
      }
      // 달 이름을 고유명사 검사에서 뺀 자리를 이 검사가 메운다. 근거는 기사 본문 전체로 본다.
      const dates = ungroundedSummaryDates(decision.summary_en, article.evidence, article.title);
      if (dates.length) {
        throw new Error(`${context}: summary dates ${dates.join(", ")} are not stated in this article. ` +
          `State only a date the article itself gives.`);
      }
    }
    // 보고서에 실리는 판정의 문안 숫자. 새로 받은 응답에서만 막는다. 저장된 판정과 보고서 생성은 이 검사로
    // 막히지 않는다(옛 판정은 review_report 의 요약 새로고침이 한 번 다시 받는다).
    if (strictNumbers && (supported || nearMiss)) {
      const numbers = decisionNumberProblems(article, decision);
      if (numbers.length) throw new Error(`${context}: summary numbers ${numbers.join(", ")} are not stated in this article`);
    }
    // 승인 후보는 위에서 근거 없는 고유명사를 거부했다. 근접 후보의 문안은 그 검사를 받지 않았으므로
    // 같은 결함이 있으면 문안만 비우고 후보는 남긴다.
    //
    // 사업동향 후보는 그 검사에서 빼 둔다. 위 enforce 검사가 investment 에만 걸리는 것과 같은 이유다:
    // 사업동향 문안은 기사 전체를 풀어 쓰는 것이 일이라 지명·부문명이 인용문 밖에서 나오는 것이 정상이다.
    // 여기서 같은 기준을 대면 근접 사업동향 행의 문안이 거의 다 비워지고, 문안 없는 행은 사업현황
    // 상자를 채울 수 없어(근거 발췌를 그대로 실으면 한국어판에 영문 본문이 나간다) 이 경로가 무용해진다.
    const groundedSummary = enforce || candidate.kind === "relevant" ||
      !ungroundedSummaryNames(decision.summary_en, quotes, article.title).length;
    const approved = supported && !recheckPending;
    // 재검토를 끝내지 못해 승인에서 내려온 후보도 대시보드에는 남긴다. 판정 자체는 살아 있고
    // 다음 실행이 다시 물으므로, 조용히 사라지면 그 사이 무엇이 보류됐는지 볼 수 없다.
    const keepForDashboard = nearMiss || (supported && recheckPending);
    let row = null;
    if (approved || keepForDashboard) {
      row = {
        ...candidate.row,
        // 근접 후보는 승인이 아니다. 매트릭스와 상세 카드는 이 값이 true 인 행만 싣는다.
        ai_signal_supported: approved,
        ...Object.fromEntries(BOOLEANS.map((field) => [`ai_${field}`, gated[field]])),
        ...(gated.target_technology_supported !== decision.target_technology_supported ? { ai_technology_conflict: true } : {}),
        ai_event_stage: decision.event_stage, ai_summary_quality: decision.quality,
        ai_summary_reason: decisionReason(decision),
        ai_summary_ko: groundedSummary ? clean(decision.summary_ko) : "",
        ai_summary_en: groundedSummary ? clean(decision.summary_en) : "",
        ai_summary_source: review.provider ? `${review.provider}_article_review` : "local_agent_review", ai_summary_reviewer: review.reviewer,
        ai_summary_cache_key: article.id, ai_evidence_quotes: quotes,
      };
      if (approved && !quotes.length) throw new Error(`${context}: approved candidate needs an evidence quote`);
      const errors = validateRows([row], candidate.kind);
      if (errors.length) throw new Error(errors.join("\n"));
    }
    return { candidate_id: candidate.id, kind: candidate.kind, supported: approved,
      near_miss: Boolean(row) && !approved, row, reason: decisionReason(decision) };
  });
}

// 날짜 보류 기사에 대해 검토자가 제안한 게시일과 그 근거 문구. 다음 수집·확인 작업의 출발점이다.
// status 는 언제나 estimated 다. 모델이 읽어낸 날짜는 공식 근거가 아니므로 confirmed 로 올리지
// 않는다. 올리는 순간 인용 하나로 그 기사가 보고서 본문에 들어간다.
export function dateHints(snapshot, reviews) {
  const articles = new Map(snapshot.articles.map((article) => [article.id, article]));
  return reviews
    .filter((review) => clean(review.published_date) && articles.get(review.article_id)?.date_placement === "date_pending")
    .map((review) => ({
      article_id: review.article_id,
      company: articles.get(review.article_id).company,
      url: articles.get(review.article_id).url,
      published_date: clean(review.published_date),
      published_date_quote: clean(review.published_date_quote),
      status: "estimated",
    }));
}

function execute(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
}

async function collect(month, outDir) {
  const period = monthPeriod(month);
  const dataDir = await fs.mkdtemp(path.join(outDir, "collection-"));
  execute(process.execPath, ["scripts/collect_company_signals.mjs", "--companies", "data/target_companies.json",
    "--source-config", "config/company_sources.json", "--out-dir", dataDir,
    "--sources", "official_feeds,official_pages,google_news", "--from-date", period.from_date, "--to-date", period.to_date,
    "--max-per-source", "6", "--max-per-company", "10", "--max-detail-per-company", "10",
    "--fallback-mode", "missing", "--fallback-min-results", "1", "--rate-limit-seconds", "0.5", "--company-concurrency", "4"]);
  return dataDir;
}

async function prepare(args) {
  const outDir = path.resolve(args.outDir || "outputs/local_reports");
  await fs.mkdir(outDir, { recursive: true });
  const dataDir = args.collect ? await collect(args.month, outDir) : path.resolve(args.dataDir || "outputs");
  const [summary, signals, targets, technology, indicators, policyText] = await Promise.all([
    read(path.join(dataDir, "latest_collection_summary.json")), read(path.join(dataDir, "latest_company_signals.json")),
    read(path.join(ROOT, "data/target_companies.json")), read(path.join(ROOT, "data/company_technology_map.json")),
    read(path.join(ROOT, "config/investment_signal_indicators.json")), fs.readFile(path.join(ROOT, "docs/local_report_review.md"), "utf8"),
  ]);
  const month = args.month || summary.from_date?.slice(0, 7);
  const period = monthPeriod(month);
  if (summary.from_date !== period.from_date || summary.to_date !== period.to_date) {
    throw new Error(`Collection period does not cover exactly ${month}. Use prepare --month ${month} --collect for fresh data.`);
  }
  // 승인 상수도 식별자에 넣는다. 어느 후보가 승인되는지가 바뀌면 문안이 필요한 후보도 바뀐다.
  // 지시문 다이제스트도 넣는다. 판정자가 그 지시문을 받고 판정하므로, 지시문이 바뀌면 옛 판정은
  // 새 기준의 결과가 아니다. API 경로의 reviewPolicy 가 같은 이유로 promptDigest 를 넣는다.
  // 두 경로의 식별자는 여전히 다르다. API 쪽은 provider·model·추론 단계까지 넣기 때문이고,
  // 로컬 산출물이 배포 판정을 덮지 않게 하는 이 스크립트의 분리와 같은 방향이다.
  // API 경로와 같은 변형을 쓴다. 기본값을 옮겼을 때 여기가 baseline 에 머무르면 로컬 판정자는
  // 다른 지시문을 읽고 다른 순서로 쓰면서 식별자만 같아 보인다.
  const promptDigest = reviewPromptDigest(policyText, promptContract(DEFAULT_VARIANT));
  const policy = `${POLICY_VERSION}:${hash([policyText, indicators, technology, APPROVAL_POLICY, promptDigest])}`;
  const candidates = sourceCandidates(signals, technology, indicators, period);
  const articles = groupArticles(candidates.investment, candidates.relevant, period, policy);
  const snapshot = { policy, period, summary, signals: signals.map(withoutAI), articles, targets, technology, indicators,
    date_deferred: candidates.deferred };
  // 저장하는 형태로 해시를 낸다. loadSnapshot 이 같은 형태로 변조를 검사하기 때문이다.
  const stored = packSnapshot(snapshot);
  const runDir = path.join(outDir, `${month}-${hash(stored)}`);
  await fs.mkdir(path.join(runDir, "articles"), { recursive: true });
  await fs.mkdir(path.join(outDir, "reviews"), { recursive: true });
  // Immutable snapshot: a repeated prepare may repair identical article files but cannot replace a different run.
  await fs.writeFile(path.join(runDir, "snapshot.json"), `${JSON.stringify(stored, null, 2)}\n`, { flag: "wx" })
    .catch(async (error) => {
      if (error.code !== "EEXIST") throw error;
      await loadSnapshot(runDir);
    });
  for (const article of articles) {
    await write(path.join(runDir, "articles", `${article.id}.json`), {
      ...article, candidates: article.candidates.map(({ row, ...candidate }) => candidate),
    });
  }
  await fs.writeFile(path.join(runDir, "REVIEW.md"), policyText);
  // API 가 보내는 시스템 지시문 전문. 정책 문서를 그 안에 품고 있으므로 판정자는 이것만 읽어도
  // 된다. REVIEW.md 는 정책 문서만 따로 보려는 사람을 위해 그대로 둔다.
  await fs.writeFile(path.join(runDir, "PROMPT.md"), `${buildSystemInstruction(policyText, DEFAULT_VARIANT)}\n`);
  console.log(JSON.stringify({ run_dir: runDir, review_dir: path.join(outDir, "reviews"),
    prompt: path.join(runDir, "PROMPT.md"),
    collection_rows: signals.length, excluded_from_month: signals.length - articles.length,
    candidate_rows: articles.reduce((n, article) => n + article.candidates.length, 0), articles: articles.length,
    // 날짜 확정분과 날짜 보류분을 나눠 보여준다. 보류분도 검토는 하되 본문에는 날짜 보강 뒤에 들어간다.
    report_ready_articles: articles.filter((article) => article.date_placement === "in_period").length,
    date_pending_articles: articles.filter((article) => article.date_placement === "date_pending").length,
    date_pending_reasons: articles.filter((article) => article.date_placement === "date_pending")
      .reduce((counts, article) => ({ ...counts, [article.date_note]: (counts[article.date_note] || 0) + 1 }), {}),
    collection_gap_rows: candidates.deferred.length }, null, 2));
  await status(runDir);
}

// 한 기사의 후보들은 같은 원문을 공유한다. sourceCandidates 가 지표마다 행을 하나씩
// 만들기 때문이다. 그대로 저장하면 본문이 후보 수만큼 반복된다. 34546694524 스냅샷은
// 26.2MB 였고 그중 8.1MB 가 같은 글자의 사본이었다(345기사, 후보 최대 6개).
// 값이 후보마다 다르면 접지 않는다. 그래야 펴낸 것이 원래와 같다.
const SHARED_ROW_FIELDS = ["content_text", "content_excerpt"];

export function packArticle(article) {
  const rows = (article.candidates || []).map((candidate) => candidate.row).filter(Boolean);
  if (rows.length < 2) return article;
  const shared = {};
  for (const field of SHARED_ROW_FIELDS) {
    const first = rows[0][field];
    if (first && rows.every((row) => row[field] === first)) shared[field] = first;
  }
  if (!Object.keys(shared).length) return article;
  // 키 순서까지 되돌려야 한다. 펴면서 앞에 붙이면 값은 같아도 JSON 글자가 달라지고,
  // build 가 이 행을 그대로 outputs 에 쓰므로 뜻 없는 큰 diff 가 커밋된다.
  return { ...article, shared_row: shared, row_keys: Object.keys(rows[0]),
    candidates: article.candidates.map((candidate) => (candidate.row
      ? { ...candidate, row: Object.fromEntries(Object.entries(candidate.row).filter(([key]) => !(key in shared))) }
      : candidate)) };
}

export function unpackArticle(article) {
  const { shared_row: shared, row_keys: order, ...rest } = article;
  if (!shared) return rest;
  const restore = (row) => {
    // 후보가 자기 값을 갖고 있으면 그쪽이 이긴다. 접을 때 같은 값만 뺐으므로 실제로는 없다.
    const merged = { ...shared, ...row };
    const keys = order || [];
    const known = keys.filter((key) => key in merged);
    const extra = Object.keys(merged).filter((key) => !keys.includes(key));
    return Object.fromEntries([...known, ...extra].map((key) => [key, merged[key]]));
  };
  return { ...rest, candidates: (rest.candidates || []).map((candidate) => (candidate.row
    ? { ...candidate, row: restore(candidate.row) } : candidate)) };
}

const packSnapshot = (snapshot) => ({ ...snapshot, articles: (snapshot.articles || []).map(packArticle) });
const unpackSnapshot = (snapshot) => ({ ...snapshot, articles: (snapshot.articles || []).map(unpackArticle) });

async function loadSnapshot(runDir) {
  const stored = await read(path.join(runDir, "snapshot.json"));
  // 변조 검사는 저장된 형태 그대로 한다. 펴는 것은 통과한 뒤다.
  const expected = `${stored.period.from_date.slice(0, 7)}-${hash(stored)}`;
  if (path.basename(runDir) !== expected) {
    throw new Error("Prepared snapshot was modified. Prepare the source again with a different --out-dir.");
  }
  return unpackSnapshot(stored);
}

async function loadReviews(runDir) {
  const snapshot = await loadSnapshot(runDir);
  const pending = [], invalid = [], results = [], reviews = [];
  for (const article of snapshot.articles) {
    const file = path.join(path.dirname(runDir), "reviews", `${article.id}.json`);
    try {
      const review = await read(file);
      results.push(...importReview(article, review).map((result) => ({ ...result, article_id: article.id, company: article.company })));
      reviews.push(review);
    } catch (error) {
      if (error.code === "ENOENT") pending.push({ company: article.company, article_id: article.id, file });
      else invalid.push({ company: article.company, article_id: article.id, error: error.message });
    }
  }
  return { snapshot, pending, invalid, results, reviews };
}

async function status(runDir) {
  const { snapshot, pending, invalid, results } = await loadReviews(runDir);
  console.log(JSON.stringify({ articles: snapshot.articles.length, reviewed_articles: snapshot.articles.length - pending.length - invalid.length,
    approved_candidates: results.filter((row) => row.supported).length, pending, invalid }, null, 2));
  return pending.length === 0 && invalid.length === 0;
}

// news.google.com 기사 링크는 본문을 자바스크립트로 받아오는 중계 페이지다. 사람이 열어도
// 원문이 아니므로 사건의 대표 주소로 쓰지 않는다.
const isNewsRelay = (url) => { try { return new URL(url).hostname === "news.google.com"; } catch { return false; } };

// "제목 - 발행사" 꼬리를 떼고 남는 부분이 사건 이름이다.
const eventKey = (title) => clean(title).replace(/\s+[-–—|]\s+[^-–—|]{1,40}$/, "")
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// 후속 확인 목록의 각 줄에 어느 매체가 썼는지와 그 매체 홈페이지를 함께 남긴다. 중계
// 링크만 적혀 있으면 사람이 어디로 가야 하는지 알 수 없기 때문이다.
// 묶음은 제목이 같은 행까지만 한다. 제목 낱말 겹침으로 바꿔 쓴 기사까지 묶어 보았지만,
// 34546694524 의 117행에서 Prodrive 의 서로 다른 두 기록 경신과 Asahi Glass 의 서로 다른
// 두 시장 보고서가 한 건으로 합쳐졌다. 사건 하나를 가리는 손해가 중복을 줄이는 이득보다
// 크므로 쓰지 않는다. Mkango 인수처럼 매체마다 제목이 다른 중복은 그대로 남는다.
export function followUpEvents(articles) {
  const events = new Map();
  for (const article of articles) {
    const key = eventKey(article.title) || article.url;
    if (!events.has(key)) events.set(key, { title: article.title, url: article.url, publishers: [] });
    const event = events.get(key);
    // 중계 링크뿐이던 사건에 직접 주소가 생기면 그쪽을 대표로 올린다.
    if (isNewsRelay(event.url) && !isNewsRelay(article.url)) {
      event.url = article.url;
      event.title = article.title;
    }
    if (article.publisher && !event.publishers.some((item) => item.publisher === article.publisher)) {
      event.publishers.push({ publisher: article.publisher, home_url: article.publisher_home_url || "" });
    }
  }
  return [...events.values()];
}

// 기업 커버리지는 "이번 달 신호를 놓쳤을 수 있는가"를 묻는다. 기사 하나가 그 답을 막는 경우는 셋이다.
// 검토자가 근거가 모자라 판단을 미뤘다(needs_review). 본문 없이 제목만으로 기업과 지표 사건이 맞다고
// 봤다(본문 없는 후보는 승인될 수 없으므로 신호가 묻혀 있을 수 있다). 신호가 나왔는데 게시일이 보류돼
// 보고서 본문에 싣지 못했다.
// 신호가 없다고 판단을 끝낸 기사는 본문이 없든 게시일이 어느 달이든 이번 달 결론을 바꾸지 않는다.
// 2026-08 실행은 날짜 보류나 본문 없는 기사가 하나만 있어도 막아 77곳 중 63곳이 근거 부족이었다.
// 대부분 목록 페이지, 제품 소개, 주가 해설 기사처럼 신호 없음이 분명한 것이었다.
export function articleCoverageGap(article, review, published = false) {
  // 보고서까지 판정 없이 온 기사는 재시도해도 인용 검증을 통과하지 못한 것뿐이다(build 의 reviewFailed).
  // 읽어 보지 못했으니 신호가 없다고 할 수 없다.
  if (!review) return 'review_failed';
  // 재검토를 끝내지 못한 판정은 신호 유무를 확정하지 못한 것이다.
  if (review.semantic_recheck_pending) return 'recheck_pending';
  const decisions = review.decisions || [];
  if (decisions.some((decision) => decision.quality === 'needs_review')) return 'needs_review';
  if (!article.candidates.some((candidate) => hasArticleBody(candidate.row)) &&
    decisions.some((decision) => decision.entity_supported && decision.indicator_supported)) return 'no_body';
  if (article.date_placement === 'date_pending' && published) return 'date_pending';
  return null;
}

// 기업 하나의 커버리지 공백 기사. 이번 달 기사가 모두 본문 없이 제목뿐이면 전부 공백이다. 읽어 본 근거가
// 하나도 없는데 제목만으로 "검토 후 미포착"이라 할 수는 없다. 2026-08 보고서(9월 14일 실행)에서
// Google News 확인이 멈춘 뒤 Airbus 6건, Heraeus 5건, Schott Pharma 6건이 본문 없이 이렇게 표시됐다.
export function companyCoverageGaps(articles, reviewByArticle, publishedArticleIds = new Set()) {
  if (articles.length && !articles.some((article) => article.candidates.some((candidate) => hasArticleBody(candidate.row)))) {
    return articles;
  }
  return articles.filter((article) => articleCoverageGap(article, reviewByArticle.get(article.id), publishedArticleIds.has(article.id)));
}

// 근거 부족 기업이 왜 그런지. 한 기업이 여러 사유를 가질 수 있다. 실행 35167466191 보고서는 77개사 중 43개사를
// 근거 부족으로만 표시해 수집 미완료·판정 실패·게시일 보류·근거 불충분을 구분할 수 없었다.
export function coverageReasons(gapArticles, reviewByArticle, publishedArticleIds = new Set(), collectionStatus = '', deferredCount = 0) {
  const reasons = new Set();
  if (collectionStatus === 'incomplete') reasons.add('collection_incomplete');
  if (deferredCount > 0) reasons.add('date_deferred');
  for (const article of gapArticles) {
    // companyCoverageGaps 가 제목뿐인 기사 전체를 돌려준 경우에는 기사별 사유가 없다. 그때는 본문 미수집이다.
    reasons.add(articleCoverageGap(article, reviewByArticle.get(article.id), publishedArticleIds.has(article.id)) || 'no_body');
  }
  return [...reasons];
}

export function coverageStatus(articles, reviewByArticle, collectionStatus, deferredCount = 0, publishedArticleIds = new Set()) {
  if (collectionStatus === 'incomplete' || deferredCount > 0) return 'incomplete_evidence';
  if (!articles.length) return 'no_monthly_sources';
  return companyCoverageGaps(articles, reviewByArticle, publishedArticleIds).length ? 'incomplete_evidence' : 'reviewed';
}

// 보고서를 막는 판정 공백. 재시도까지 인용 검증에 실패한 기사(reviewFailed)는 막지 않는다. 2026-08 판정
// (34939670823)에서 영상 자막 파일·번역된 인용 같은 6건이 매 실행 다시 실패해 PDF 가 한 번도 나오지 않을 수
// 있었다. 그 기사는 판정 없이 두고 해당 기업을 근거 부족으로 표시한다. 아직 시도하지 못한 기사는 여전히 막는다.
export function reportBlockers({ pending, invalid }, reviewFailed = new Set()) {
  const waiting = pending.filter((item) => !reviewFailed.has(item.article_id));
  return waiting.length || invalid.length ? { pending: waiting.length, invalid: invalid.length } : null;
}

export async function build(args) {
  const runDir = path.resolve(args.runDir);
  const { snapshot, pending, invalid, results, reviews } = await loadReviews(runDir);
  const reviewFailed = new Set(args.reviewFailed || []);
  const blockers = reportBlockers({ pending, invalid }, reviewFailed);
  if (blockers) {
    throw new Error(`Report blocked: ${blockers.pending} pending articles, ${blockers.invalid} invalid reviews. Run status --run-dir ${runDir}`);
  }
  const reviewFailedArticles = snapshot.articles.filter((article) => reviewFailed.has(article.id) &&
    pending.some((item) => item.article_id === article.id))
    .map((article) => ({ company: article.company, title: article.title, url: article.url, article_id: article.id }));
  // 승인된 판정은 날짜 상태와 무관하게 모두 남긴다. 게시월이 확정된 행만 PDF 본문에 들어가고,
  // 날짜 보류 행은 같은 파일에 남아 대시보드의 검토 후보가 된다. PDF 생성기가 같은 기준으로 거른다.
  // 두 파일 모두 근접 후보를 함께 넣는다. ai_signal_supported=false 라 매트릭스와 다섯 지표 칸에는
  // 실리지 않는다. 투자 쪽은 대시보드에서 "아깝게 떨어진 건"으로 사람이 확인하는 용도이고,
  // 사업동향 쪽은 승인된 사업동향이 없는 기업의 사업현황 상자를 채우는 데 쓴다. 예전에는 사업동향
  // 근접 행을 버려서, 상자가 빈 기업이 왜 비었는지 출력만 보고는 알 수 없었다.
  const withNearMiss = (kind) => results.filter((item) => item.kind === kind && (item.supported || item.near_miss))
    .map((item) => item.row);
  const investment = withNearMiss("investment");
  const relevant = withNearMiss("relevant");
  const datePending = (rows) => rows.filter((row) => !reportEligible(row, snapshot.period));
  const errors = [...validateRows(investment, "investment"), ...validateRows(relevant, "relevant")];
  if (errors.length) throw new Error(errors.join("\n"));
  // A failed build never overwrites an earlier PDF, either here or in public/reports.
  const buildDir = await fs.mkdtemp(path.join(runDir, "report-"));
  try {
    const reviewByArticle = new Map(reviews.map((review) => [review.article_id, review]));
    const deferred = snapshot.date_deferred || sourceCandidates(snapshot.signals, snapshot.technology, snapshot.indicators, snapshot.period).deferred;
    // 승인 판정이 나온 기사. 게시일 보류가 커버리지를 막는지 여기서 갈린다.
    const publishedArticles = new Set(results.filter((item) => item.supported).map((item) => item.article_id));
    const coverage = snapshot.targets.map((target) => {
      const deferredArticles = deferred.filter(article => article.company === target.company);
      const articles = snapshot.articles.filter((article) => article.company === target.company);
      const incomplete = companyCoverageGaps(articles, reviewByArticle, publishedArticles);
      const datePending = articles.filter((article) => article.date_placement === "date_pending");
      const collectionStatus = snapshot.summary.collection_coverage?.find(item => item.company === target.company)?.status;
      return { company: target.company, monthly_articles: articles.length,
        needs_review_articles: incomplete.length,
        date_pending_articles: datePending.length,
        deferred_articles: deferredArticles.length,
        status: coverageStatus(articles, reviewByArticle, collectionStatus, deferredArticles.length, publishedArticles),
        reasons: coverageReasons(incomplete, reviewByArticle, publishedArticles, collectionStatus, deferredArticles.length),
        follow_up: [...followUpEvents(incomplete), ...deferredArticles],
        // 날짜 때문에 보류된 기사는 시그널이 없는 기업과 구분해서 남긴다.
        date_follow_up: datePending.map((article) => ({ url: article.url, title: article.title, reason: article.date_note })) };
    });
    const collection = snapshot.summary.collection_coverage || [];
    // 보고서 앞쪽의 검토 범위 표시용. 기사 수·기업 수·수집 상태는 서로 다른 단위이므로 이름을 나눠 둔다.
    const reviewScope = {
      articles: snapshot.articles.length,
      reviewed_articles: reviews.length,
      review_failed_articles: reviewFailedArticles.length,
      // 원문 기준 재판정(판정 실패·오판정)과 문안만 고친 수정은 따로 센다.
      adjudicated_articles: reviews.filter((review) => review.adjudication && review.adjudication.kind !== "wording").length,
      wording_fixed_articles: reviews.filter((review) => review.adjudication?.kind === "wording").length,
      // 실행 상태의 recheck_pending 과 같은 단위(후보 수)로 센다. 사업동향 후보는 PDF 에 없으므로 행으로는 셀 수 없다.
      recheck_pending_candidates: reviews.reduce((n, review) => n + (review.semantic_recheck_pending?.candidate_ids?.length || 0), 0),
      date_pending_investment_rows: datePending(investment).length,
      date_pending_business_rows: datePending(relevant).length,
      deferred_articles: deferred.length,
      collection_completed_companies: collection.filter((item) => item.status === "completed").length,
      collection_incomplete_companies: collection.filter((item) => item.status === "incomplete").length,
    };
    const files = {
      "signals.json": snapshot.signals,
      "summary.json": { ...snapshot.summary, review_coverage: coverage, review_failed_articles: reviewFailedArticles, review_scope: reviewScope },
      "coverage.json": coverage,
      "investment.json": investment, "relevant.json": relevant,
      "investment-summary.json": { investment_signal_count: investment.length - datePending(investment).length },
      "date-pending.json": { investment: datePending(investment), relevant: datePending(relevant),
        deferred, hints: dateHints(snapshot, reviews) },
      "targets.json": snapshot.targets, "technology.json": snapshot.technology, "indicators.json": snapshot.indicators,
      "reviews.json": reviews,
      "decisions.json": results.map(({ row, ...item }) => item),
    };
    for (const [name, value] of Object.entries(files)) await write(path.join(buildDir, name), value);
    // reportlab 캔버스 대신 HTML 을 헤드리스 Chrome 으로 인쇄한다. collect-company-signals
    // 워크플로(Vercel 크롤링 버튼이 부르는 것)가 이 경로로 PDF 를 만들므로, 여기가 안 바뀌면
    // 보고서 대부분은 여전히 reportlab 으로 나온다.
    // HTML 은 이 실행 안에서만 쓰는 중간 형식이라 buildDir 에 두고 나가는 것은 PDF 뿐이다.
    // build_html_report.mjs 는 --investment-summary 를 쓰지 않으므로 넘기지 않는다.
    // 뷰 모델은 파이썬이라 --python 으로 준 해석기를 그대로 물려준다.
    if (args.python) process.env.PYTHON = args.python;
    for (const lang of ["ko", "en"]) {
      execute(process.execPath, [path.join(ROOT, "scripts/build_html_report.mjs"),
        "--signals", path.join(buildDir, "signals.json"), "--summary", path.join(buildDir, "summary.json"),
        "--relevant", path.join(buildDir, "relevant.json"), "--investment-signals", path.join(buildDir, "investment.json"),
        "--targets", path.join(buildDir, "targets.json"), "--technology-map", path.join(buildDir, "technology.json"),
        "--indicator-config", path.join(buildDir, "indicators.json"), "--font", path.join(ROOT, "assets/fonts/PretendardJP-Regular.ttf"),
        "--issue-number", args.issueNumber || "2", "--lang", lang,
        "--html", path.join(buildDir, `report_${lang}.html`), "--out", path.join(buildDir, `report_${lang}.pdf`)]);
    }
    console.log(JSON.stringify({ status: "completed", report_dir: buildDir, reviewed_articles: reviews.length,
      reviewed_candidates: results.length,
      approved_investment: investment.filter((row) => row.ai_signal_supported).length,
      near_miss_investment: investment.filter((row) => !row.ai_signal_supported).length,
      approved_business: relevant.filter((row) => row.ai_signal_supported).length,
      near_miss_business: relevant.filter((row) => !row.ai_signal_supported).length,
      date_pending_investment: datePending(investment).length, date_pending_business: datePending(relevant).length,
      incomplete_companies: coverage.filter((item) => item.status !== "reviewed").length,
      review_failed_articles: reviewFailedArticles.length,
      rejected_candidates: results.filter((item) => !item.supported).length }, null, 2));
    return buildDir;
  } catch (error) {
    await fs.rm(buildDir, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const args = {};
  const options = new Set(["month", "data-dir", "out-dir", "run-dir", "python", "issue-number"]);
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, "");
    if (argv[i] === "--collect") { args.collect = true; continue; }
    if (!argv[i].startsWith("--") || !options.has(key) || !argv[i + 1] || argv[i + 1].startsWith("--")) {
      throw new Error(`Invalid option: ${argv[i]}`);
    }
    args[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[++i];
  }
  if (command === "prepare") await prepare(args);
  else if (command === "status" && args.runDir) { if (!await status(path.resolve(args.runDir))) process.exitCode = 1; }
  else if (command === "build" && args.runDir) await build(args);
  else throw new Error("Usage: local_report.mjs prepare [--month YYYY-MM] [--collect] | status --run-dir PATH | build --run-dir PATH [--python PATH]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
