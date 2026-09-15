#!/usr/bin/env node
// Local product path: collect/prepare -> agent-authored reviews -> existing PDF renderer.
// This script never calls a model API or changes outputs/latest_*.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateRows, investmentStageSupported } from "./validate_report_inputs.mjs";
import { dateLabelKo, hasArticleBody, periodPlacement, reportEligible, resolveDateState, reviewCandidate } from "./date_state.mjs";
// 수집기의 날짜 파서를 그대로 쓴다. 검토 단계가 자기 날짜 문법을 갖게 되면, 수집기가 날짜로
// 읽지 못한 표기를 검토 단계가 받아들여 두 단계의 게시일 판정이 갈린다.
import { extractDateFromText, extractMonthFromText } from "./collect_company_signals.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_VERSION = "local-report-v3";
const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
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
const NAME_STOPWORDS = new Set(["the", "and", "for", "with", "from", "group", "inc", "corp",
  "ltd", "llc", "gmbh", "plc", "company", "technologies", "holdings", "limited"]);

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
    const words = name.split(/[^A-Za-z0-9]+/)
      .filter((word) => word.length >= 4 && !NAME_STOPWORDS.has(word.toLowerCase()));
    return words.length > 0 && words.some((word) => !grounded.includes(word.toLowerCase()));
  });
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
      const candidate = {
        id: kind === "investment" ? `investment:${row.investment_signal_no}` : "relevant",
        kind,
        target_technology: row.target_technology || "",
        relevance_exempt: row.excluded_from_relevance === true || row.technology_gate_decision === "relevance_exempt",
        indicator: row.investment_signal_label || "품목 연계 사업동향",
        description: row.investment_signal_description || "타겟 품목·기술과 직접 연계된 사업 활동",
      };
      if (article.candidates.some((item) => item.id === candidate.id)) {
        throw new Error(`Duplicate candidate: ${row.company} ${row.url} ${candidate.id}`);
      }
      article.candidates.push({ ...candidate, row });
    }
  }
  return [...groups.values()].map((article) => {
    article.evidence.sort();
    article.candidates.sort((a, b) => a.id.localeCompare(b.id));
    // 기사 ID에는 날짜를 넣지 않는다. 날짜를 보강했다고 이미 끝난 내용 판정을 버리면
    // 한정된 검토 호출을 같은 기사에 두 번 쓰게 된다. 발행사도 같은 이유로 넣지 않는다.
    // 어느 매체가 썼는지는 후속 확인용 정보지 모델이 판정하는 근거가 아니다. 넣으면 필드가
    // 생긴 것만으로 모든 기사 ID가 바뀌어 캐시된 판정 전부를 다시 사는 셈이 된다.
    const { published_at, published_month, date_status, date_placement, date_note, date_label,
      publisher, publisher_home_url, ...content } = article;
    const material = { ...content, policy, candidates: article.candidates.map(({ row, ...item }) => item) };
    return { ...material, published_at, published_month, date_status, date_placement, date_note, date_label,
      publisher, publisher_home_url, id: hash(material), candidates: article.candidates };
  });
}

// Every in-month source reaches the agent, including keyword/technology filter misses.
export function sourceCandidates(signals, technology, indicators, period) {
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
    const row = { ...withoutAI(signal), ...tech, company: signal.company,
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

// 인용문이 실제로 말하고 있는 날짜. 일자까지 적혔으면 일자와 월을, 월만 적혔으면 월만 돌려준다.
// 아무 날짜도 읽히지 않으면 null 이고, 그때 제안은 근거 없는 날짜다.
function dateStatedInQuote(quote) {
  const day = extractDateFromText(quote);
  if (day) return { day: day.slice(0, 10), month: day.slice(0, 7) };
  const month = extractMonthFromText(quote);
  return month ? { day: "", month } : null;
}

// 승인 조건 중 무엇이 모자랐는지. 모두 갖췄으면 빈 배열(승인)이고, 사람 검토 후보가 아니면 null이다.
// 캐시 재검토와 문안 보강도 같은 기준을 쓴다.
//
// 사람 검토 후보는 "아깝게 떨어진" 투자 후보만이다. 기업 귀속과 지표 사건이 확인되고, 나머지 승인
// 조건 가운데 딱 하나만 모자라야 한다. 둘 이상 모자라면 승인과 거리가 멀다. 2026-08 실행에서
// 감산 조치·지분 평가이익·타 사업 채권 발행이 이렇게 들어와 사람이 거를 목록만 늘렸다.
// 이미 끝난 사건(completed)도 뺀다. 이 보고서는 앞으로의 투자 전조를 찾으므로, 실적·연차 자료가
// 다시 적은 완료된 증설·조달·가동 현황은 정의상 신호가 아니다. 확정됐으나 진행 전인 committed와
// 단계를 판단하지 못한 unclear는 사람이 볼 가치가 있어 남긴다.
export function humanReviewGaps(candidate, decision) {
  if (candidate?.kind !== "investment" || !decision.entity_supported || !decision.indicator_supported) return null;
  const gaps = [
    ...(candidate.relevance_exempt || decision.target_technology_supported ? [] : ["target_technology"]),
    ...(decision.leading_indicator_supported ? [] : ["leading_indicator"]),
    ...(investmentStageSupported(decision.event_stage, candidate.row?.investment_signal_no) ? [] : ["event_stage"]),
    ...(decision.quality === "pass" ? [] : ["quality"]),
  ];
  return gaps.length > 1 || decision.event_stage === "completed" ? null : gaps;
}

// 모델 판정 가운데 코드로 확인할 수 있는 두 가지를 승인 전에 적용한다. 저장된 판정에도 그대로 걸린다.
// 본문 없는 기사는 승인도 사람 검토도 하지 않는다(null). 제목은 사건을 가리킬 뿐 세부를 보여 주지 않는다.
// 2026-08 첫 실행(34915776314)에서 Ouster 제목 159자 하나로 S4 와 사업동향이 승인됐다. 이런 기사는
// articleCoverageGap 이 no_body 로 드러내고, 본문이 들어오면 근거가 바뀌어 기사 ID 도 바뀌므로 다시 검토된다.
// 같은 기사의 사업동향이 타겟 기술과 무관하다고 봤는데 투자 후보만 기술을 인정하면 그 인정은 쓰지 않는다.
// 같은 실행에서 GE Healthcare 의 CT 임상 협력이 '배양·정제 시스템' S4 로 승인됐다. 사람 검토 후보로 내린다.
export function decisionForApproval(article, decisions, decision) {
  if (!article.candidates.some((candidate) => hasArticleBody(candidate.row))) return null;
  const candidate = article.candidates.find((item) => item.id === decision.candidate_id);
  const business = decisions.find((item) => item.candidate_id === "relevant");
  if (candidate?.kind === "investment" && !candidate.relevance_exempt &&
      decision.target_technology_supported === true && business?.target_technology_supported === false) {
    return { ...decision, target_technology_supported: false };
  }
  return decision;
}

// Checks the review import boundary, then delegates report-row consistency to the existing validator.
// A quote match proves provenance only, not the truth of a model's interpretation.
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
    if (!clean(decision.reason_ko)) throw new Error(`${context}: reason_ko is required`);
    if (candidate.kind === "relevant" && !decision.leading_indicator_supported) {
      throw new Error(`${context}: business rows use true for the non-applicable leading indicator field`);
    }
    // Everything an approval needs except the investment event stage.
    const approvableExceptStage = decision.entity_supported && (candidate.relevance_exempt || decision.target_technology_supported) &&
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
    const gated = decisionForApproval(article, review.decisions, decision);
    const supported = Boolean(gated) && gated.entity_supported && (candidate.relevance_exempt || gated.target_technology_supported) &&
      gated.indicator_supported && gated.leading_indicator_supported && gated.quality === "pass" &&
      (candidate.kind === "relevant" || investmentStageSupported(decision.event_stage, candidate.row.investment_signal_no));
    const quotes = decision.evidence_quotes;
    if (!Array.isArray(quotes) || quotes.some((quote) => typeof quote !== 'string' || !normalizeQuote(quote) || !evidence.some((text) => text.includes(normalizeQuote(quote))))) {
      throw new Error(`${context}: evidence_quotes must be exact passages from this article`);
    }
    if (supported && !quotes.length) throw new Error(`${context}: approved candidate needs an evidence quote`);
    // 다섯 지표 칸에만 건다. 사업동향 문안은 기사 전체를 풀어 쓰는 것이 일이라 지명·부문명이
    // 인용문 밖에서 나오는 것이 정상이고, 같은 기준을 대면 근거 있는 요약까지 막힌다.
    if (supported && candidate.kind === "investment") {
      const ungrounded = ungroundedSummaryNames(decision.summary_en, quotes, article.title);
      if (ungrounded.length) {
        throw new Error(`${context}: summary names ${ungrounded.join(", ")} without an evidence quote. ` +
          `Quote the passage the summary describes, or summarize only the quoted event.`);
      }
    }
    const gaps = supported || !gated ? null : humanReviewGaps(candidate, gated);
    const reviewGaps = gaps?.length ? gaps : null;
    const humanReview = Boolean(reviewGaps);
    // 보고서에 실리는 판정의 문안 숫자. 새로 받은 응답에서만 막는다. 저장된 판정과 보고서 생성은 이 검사로
    // 막히지 않는다(옛 판정은 review_report 의 요약 새로고침이 한 번 다시 받는다).
    if (strictNumbers && (supported || humanReview)) {
      const numbers = decisionNumberProblems(article, decision);
      if (numbers.length) throw new Error(`${context}: summary numbers ${numbers.join(", ")} are not stated in this article`);
    }
    // 승인 후보는 위에서 근거 없는 고유명사를 거부했다. 검토 후보의 문안은 그 검사를 받지 않았으므로
    // 같은 결함이 있으면 문안만 비우고 후보는 남긴다.
    const groundedSummary = supported || !ungroundedSummaryNames(decision.summary_en, quotes, article.title).length;
    let row = null;
    if (supported || humanReview) {
      row = {
        ...candidate.row,
        ai_signal_supported: supported,
        ...(humanReview ? { ai_review_tier: "human_review", ai_review_gaps: reviewGaps } : {}),
        ...Object.fromEntries(BOOLEANS.map((field) => [`ai_${field}`, gated[field]])),
        ...(gated.target_technology_supported !== decision.target_technology_supported ? { ai_technology_conflict: true } : {}),
        ai_event_stage: decision.event_stage, ai_summary_quality: decision.quality,
        ai_summary_reason: clean(decision.reason_ko),
        ai_summary_ko: groundedSummary ? clean(decision.summary_ko) : "",
        ai_summary_en: groundedSummary ? clean(decision.summary_en) : "",
        ai_summary_source: review.provider ? `${review.provider}_article_review` : "local_agent_review", ai_summary_reviewer: review.reviewer,
        ai_summary_cache_key: article.id, ai_evidence_quotes: quotes,
      };
      const errors = validateRows([row], candidate.kind);
      if (errors.length) throw new Error(errors.join("\n"));
    }
    return { candidate_id: candidate.id, kind: candidate.kind, supported, human_review: humanReview, row, reason_ko: decision.reason_ko };
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
  const policy = `${POLICY_VERSION}:${hash([policyText, indicators, technology])}`;
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
  console.log(JSON.stringify({ run_dir: runDir, review_dir: path.join(outDir, "reviews"),
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
  const approved = (kind) => results.filter((item) => item.supported && item.kind === kind).map((item) => item.row);
  // 투자 시그널에는 사람 검토 후보도 함께 싣는다. 행의 ai_review_tier 로 구분된다.
  const investment = results.filter((item) => item.kind === "investment" && (item.supported || item.human_review)).map((item) => item.row);
  const relevant = approved("relevant");
  const datePending = (rows) => rows.filter((row) => !reportEligible(row, snapshot.period));
  const errors = [...validateRows(investment, "investment"), ...validateRows(relevant, "relevant")];
  if (errors.length) throw new Error(errors.join("\n"));
  // A failed build never overwrites an earlier PDF, either here or in public/reports.
  const buildDir = await fs.mkdtemp(path.join(runDir, "report-"));
  try {
    const reviewByArticle = new Map(reviews.map((review) => [review.article_id, review]));
    const deferred = snapshot.date_deferred || sourceCandidates(snapshot.signals, snapshot.technology, snapshot.indicators, snapshot.period).deferred;
    // 보고서에 실리는 판정(승인·사람 검토)이 나온 기사. 게시일 보류가 커버리지를 막는지 여기서 갈린다.
    const publishedArticles = new Set(results.filter((item) => item.supported || item.human_review).map((item) => item.article_id));
    const coverage = snapshot.targets.map((target) => {
      const deferredArticles = deferred.filter(article => article.company === target.company);
      const articles = snapshot.articles.filter((article) => article.company === target.company);
      const incomplete = companyCoverageGaps(articles, reviewByArticle, publishedArticles);
      const datePending = articles.filter((article) => article.date_placement === "date_pending");
      return { company: target.company, monthly_articles: articles.length,
        needs_review_articles: incomplete.length,
        date_pending_articles: datePending.length,
        deferred_articles: deferredArticles.length,
        status: coverageStatus(articles, reviewByArticle,
          snapshot.summary.collection_coverage?.find(item => item.company === target.company)?.status, deferredArticles.length, publishedArticles),
        follow_up: [...followUpEvents(incomplete), ...deferredArticles],
        // 날짜 때문에 보류된 기사는 시그널이 없는 기업과 구분해서 남긴다.
        date_follow_up: datePending.map((article) => ({ url: article.url, title: article.title, reason: article.date_note })) };
    });
    const files = {
      "signals.json": snapshot.signals,
      "summary.json": { ...snapshot.summary, review_coverage: coverage, review_failed_articles: reviewFailedArticles },
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
      reviewed_candidates: results.length, approved_investment: investment.filter((row) => row.ai_signal_supported).length,
      human_review_investment: investment.filter((row) => row.ai_review_tier === "human_review").length, approved_business: relevant.length,
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
