#!/usr/bin/env node
// 크롤링 결과 전체를 채팅 한 번에 붙여넣을 수 있는 브리프 파일 하나로 만든다.
//
// 파이프라인에서 API가 필요한 단계는 근거 평가 하나뿐이므로, 그 입력을 사람이 채팅에 넣고
// 답을 되돌려 받으면 PDF까지 그대로 나온다. 문제는 부피인데, 원본 174행을 그대로 내보내면
// 65만 자가 되어 한 번에 넣을 수 없다. 다음 세 가지로 줄인다.
//
//   1) 기사 단위로 합친다      174행 -> 84개 기사. 같은 기사가 여러 시그널로 중복돼 있었다.
//   2) 상용문구를 뺀다         위험고지, 네비게이션, 반복 문단
//   3) 기사당 본문에 상한       기본 900자
//
// 판정은 여전히 행 단위로 받아야 한다. PDF가 (기업 × 시그널) 칸을 그리기 때문이다. 그래서
// 기사 본문은 한 번만 싣고, 그 기사에 걸린 판정 대상 행들을 ref 목록으로 붙인다.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { cleanText, isRelevanceExempt, rowIdentity } from "./summarize_signal_evidence.mjs";

const DEFAULTS = {
  investmentSignals: "outputs/latest_investment_signals.json",
  relevantSignals: "outputs/latest_relevant_signals.json",
  collectionSummary: "outputs/latest_collection_summary.json",
  outDir: "outputs/manual_summary",
  // 팀원이 웹에서 바로 받도록 Vercel이 서비스하는 자리에도 같은 파일을 둔다.
  publicCopy: "public/brief/report_brief.md",
  maxArticleChars: 900,
  minSentenceChars: 40,
};

// 수집 원문에 섞여 들어오는, 판정에 쓸 수 없는 상용 문구.
const BOILERPLATE = new RegExp(
  [
    "forward-looking",
    "Skip to main navigation",
    "View PDF",
    "these risks should be read",
    "continuous disclosure",
    "SEDAR",
    "safe harbor",
    "Terms of Use",
    "Privacy Policy",
    "Cookie",
    "All rights reserved",
    "Investor Relations Financials Stock Info",
  ].join("|"),
  "i",
);

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args[name] = true;
      continue;
    }
    args[name] = next;
    index += 1;
  }
  args.maxArticleChars = Math.max(200, Number(args.maxArticleChars) || DEFAULTS.maxArticleChars);
  return args;
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function rowEvidence(row) {
  const snippets = [
    ...(Array.isArray(row.evidence_snippets) ? row.evidence_snippets : []),
    ...(Array.isArray(row.technology_evidence_snippets) ? row.technology_evidence_snippets : []),
  ];
  return cleanText([snippets.join(" "), row.content_excerpt, row.content_text].filter(Boolean).join(" "));
}

// 수집 본문에는 CSS·스크립트 조각이 섞여 들어온다. 판정에 쓸모가 없을 뿐 아니라, 거기 박힌
// 긴 소수 좌표가 카드번호처럼 보여 기업 DLP가 붙여넣기를 차단한다. 실제로 한 기사에서
// object-position 좌표 두 개가 그렇게 잡혔다.
const MARKUP_NOISE = /[{;]\s*[a-z-]+\s*:\s*[^;{}]*(?:%|px|rem|em|vh|vw)\s*[;}]|object-(?:fit|position)|max-height|min-height|<\/?[a-z][^>]*>/i;

// 판정 근거가 되는 숫자는 금액·비율·연도 정도이고 자릿수가 길지 않다. 9자리를 넘는 연속
// 숫자는 스크래핑 잡음이므로 지운다.
export function stripLongDigitRuns(text) {
  return String(text || "").replace(/\d[\d.,]{8,}/g, (run) => (/^\d[\d.,]*$/.test(run) ? " " : run));
}

// 판정에 쓸 만한 문장만 남긴다. 짧은 조각, 상용문구, 같은 문단 반복을 버린다.
export function usefulSentences(text, { minSentenceChars = DEFAULTS.minSentenceChars } = {}) {
  const seen = new Set();
  const kept = [];
  for (const raw of String(text || "").split(/(?<=[.!?])\s+/)) {
    const sentence = raw.trim();
    if (sentence.length < minSentenceChars) continue;
    if (BOILERPLATE.test(sentence)) continue;
    if (MARKUP_NOISE.test(sentence)) continue;
    const cleaned = stripLongDigitRuns(sentence).replace(/\s+/g, " ").trim();
    if (cleaned.length < minSentenceChars) continue;
    const fingerprint = cleaned.slice(0, 60).toLowerCase();
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    kept.push(cleaned);
  }
  return kept;
}

export function trimToBudget(sentences, budget) {
  let body = "";
  for (const sentence of sentences) {
    if (body.length + sentence.length + 1 > budget) break;
    body += `${sentence} `;
  }
  return body.trim() || (sentences[0] || "").slice(0, budget);
}

// 같은 기사에 걸린 여러 판정 대상을 하나로 묶는다.
export function groupByArticle(entries) {
  const articles = new Map();
  for (const entry of entries) {
    const key = entry.url || entry.title || entry.ref;
    if (!articles.has(key)) {
      articles.set(key, { key, title: entry.title, published_at: entry.published_at, source: entry.source, targets: [], sentences: [] });
    }
    const article = articles.get(key);
    article.targets.push(entry);
    if (!article.sentences.length) article.sentences = entry.sentences;
  }
  return [...articles.values()];
}

function instructions() {
  return `# 월간 글로벌 투자시그널 판정 요청

아래 자료는 타겟기업 공식 보도자료·IR·뉴스에서 수집한 것이다. 각 **판정 대상**에 대해 근거가
실제로 있는지 판정하고, 통과한 것만 보고서용 요약문을 작성한다. 결과는 마지막의 출력 형식대로
JSON 배열 하나로만 답한다.

## 판정 규칙

각 판정 대상은 (기업 × 시그널 × 기사) 조합이다. 기사 본문에 실제로 적힌 사실만 쓴다. 본문에
없는 내용을 추론하거나 지어내지 않는다.

- \`e\` (기업 귀속): 사건이 그 기업 자체에 귀속되면 1. 모회사·관계사 자료는 본문에 해당
  기업명, 사업부, 제품 또는 임원이 명시될 때만 1.
- \`t\` (타겟 기술 연결): 사건이 그 기업의 '유치필요 기술'과 직접 연결되면 1. 같은 기업의 다른
  사업부·제품이나 일반 경영활동이면 0.
- \`i\` (지표 부합): 본문이 그 시그널 정의에 맞는 **구체적 사건**을 보여주면 1. 키워드만 등장하거나
  위험고지·전망 상용문구, 일반 재무항목뿐이면 0. 사업동향(REL) 대상은 항상 1.
- \`l\` (선행성): 앞으로의 투자결정을 시사하는 선행 징후면 1. 이미 확정·완료된 투자·인수·자금조달
  사실 자체만 근거인 후행 사건이면 0. 사업동향(REL) 대상은 항상 1.
- \`stage\` (사건 단계): INV 대상은 exploratory / planned / committed / completed / unclear 중 하나.
  이미 확정·계약·자금조달·인수·가동이 끝났으면 committed 또는 completed. REL 대상은 항상
  not_applicable.
- \`q\` (근거 품질): 근거가 충분하면 pass, 부족하면 needs_review.
- \`c\` (확신도): 0~1 사이 숫자.
- \`why\`: 그렇게 판정한 이유. 한국어 한 문장.
- \`ok\` (종합): 위 판정의 논리곱. 하나라도 0이거나 불명확하면 0.
  단, 판정 대상에 \`면제\` 표시가 있으면 그 대상은 \`t\`를 \`ok\` 계산에서 제외한다.

**판정은 대상마다 독립적으로 한다.** 앞에서 몇 개를 통과시켰는지, 통과 비율이 얼마인지는 다음
대상의 판정에 영향을 주지 않는다. 통과가 적어도 억지로 늘리지 않고, 많아도 억지로 줄이지 않는다.

## 요약문 규칙

- \`ok\`가 0인 대상: \`ko\`와 \`en\`에 기사 사실을 각 한 문장(40~90자)으로만 적는다. 나머지 요약
  필드는 넣지 않는다.
- \`ok\`가 1인 대상만 아래 보고서용 요약을 추가로 작성한다.
  - INV 대상: \`hko\` 18~42자 명사구(종결어미 없이), \`dko\` 35~85자(종결어미 없이),
    \`hen\` 40~90자 영문 표제, \`den\` 70~180자 영문 캡션. 영문은 마침표로 끝내지 않는다.
  - REL 대상: \`ko\` 3~4문장 260~360자 보고서체(존대말·구어체 금지, '습니다' 금지),
    \`en\` 같은 내용의 영문 3~4문장 300~460자. \`hko\`/\`dko\`/\`hen\`/\`den\`은 넣지 않는다.
- 영문은 한국어 직역이 아니라 같은 사실을 영어 보고서 문체로 쓴 것이어야 하며, 두 언어의
  사실관계는 일치해야 한다.
- 성장률: mid-single-digit=한 자릿수 중반대, low-single-digit=한 자릿수 초반대,
  high-single-digit=한 자릿수 후반대.

## 출력 형식

설명·머리말 없이 JSON 배열 하나만 출력한다. \`ref\`는 입력에 나온 것을 그대로 쓰고, **모든 판정
대상이 정확히 한 번씩** 나와야 한다.

\`\`\`json
[
 {"ref":"INV-001","e":1,"t":0,"i":0,"l":0,"stage":"unclear","q":"needs_review","c":0.3,
  "why":"공급망 언급은 위험고지 상용문구이며 구체적 대응 조치가 없음",
  "ko":"분기 실적과 일반적 공급망 위험요인을 언급","en":"Quarterly results note supply-chain risk in general terms"},
 {"ref":"INV-014","e":1,"t":1,"i":1,"l":1,"stage":"planned","q":"pass","c":0.84,
  "why":"수요 증가 시 반응기를 추가하도록 설계했다는 구체적 확장 계획이 확인됨",
  "hko":"군산 실리콘 음극재 생산기지 확장 기반 확보","dko":"수요 증가 시 반응기 증설로 생산능력 확대 가능",
  "hen":"Gunsan silicon anode site built for staged expansion",
  "den":"Reactors can be added as demand grows, giving headroom without a new site",
  "ko":"","en":""}
]
\`\`\`

답변이 길어 한 번에 끝나지 않으면 배열을 도중에 끊고, 이어서 요청하면 나머지를 같은 형식으로
계속 출력한다.`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [investmentRows, relevantRows, collection] = await Promise.all([
    readJson(args.investmentSignals, []),
    readJson(args.relevantSignals, []),
    readJson(args.collectionSummary, {}),
  ]);

  const manifest = { generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), rows: [] };
  const entries = [];
  for (const [kind, rows, source, prefix] of [
    ["investment", investmentRows, args.investmentSignals, "INV"],
    ["relevant", relevantRows, args.relevantSignals, "REL"],
  ]) {
    rows.forEach((row, index) => {
      const ref = `${prefix}-${String(index + 1).padStart(3, "0")}`;
      const exempt = isRelevanceExempt(row);
      manifest.rows.push({ ref, kind, source, index, identity: rowIdentity(row), company: row.company || "", relevance_exempt: exempt });
      entries.push({
        ref,
        kind,
        company: row.company || "",
        targetTechnology: row.target_technology || "",
        signal: row.investment_signal_label ? `S${row.investment_signal_no} ${row.investment_signal_label}` : "글로벌 사업현황",
        signalDescription: row.investment_signal_description || "",
        exempt,
        title: cleanText(row.title),
        url: row.url || "",
        source: cleanText(row.source),
        published_at: (row.published_at || "").slice(0, 10),
        sentences: usefulSentences(rowEvidence(row), args),
      });
    });
  }

  const articles = groupByArticle(entries);
  const signalLegend = new Map();
  for (const entry of entries) {
    if (entry.kind === "investment" && entry.signalDescription) signalLegend.set(entry.signal, entry.signalDescription);
  }

  const lines = [instructions(), ""];
  const period = collection?.from_date ? `${collection.from_date} ~ ${collection.to_date}` : "";
  lines.push(`## 보고 기간`, "", period || "(수집 요약 없음)", "");
  lines.push(`## 5대 투자동향 시그널 정의`, "");
  for (const [label, description] of [...signalLegend].sort()) lines.push(`- **${label}**: ${description}`);
  lines.push("");
  lines.push(`## 자료 (기사 ${articles.length}건 · 판정 대상 ${entries.length}건)`, "");

  for (const [articleIndex, article] of articles.entries()) {
    lines.push(`### ${articleIndex + 1}. ${article.title || "(제목 없음)"}`);
    lines.push(`출처: ${article.source || "-"} · 게시일: ${article.published_at || "미상"}`);
    lines.push("");
    lines.push("판정 대상:");
    for (const target of article.targets) {
      lines.push(
        `- \`${target.ref}\` ${target.company} | 유치필요 기술: ${target.targetTechnology || "-"} | ${target.signal}${target.exempt ? " | **면제**" : ""}`,
      );
    }
    lines.push("");
    lines.push(trimToBudget(article.sentences, args.maxArticleChars) || "(본문 없음)");
    lines.push("");
  }

  await fs.mkdir(args.outDir, { recursive: true });
  await fs.mkdir(path.join(args.outDir, "responses"), { recursive: true });
  const briefPath = path.join(args.outDir, "report_brief.md");
  const text = `${lines.join("\n")}\n`;
  await fs.writeFile(briefPath, text, "utf8");
  if (args.publicCopy) {
    await fs.mkdir(path.dirname(args.publicCopy), { recursive: true });
    await fs.writeFile(args.publicCopy, text, "utf8");
  }
  await fs.writeFile(path.join(args.outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const summary = {
    brief: briefPath,
    articles: articles.length,
    targets: entries.length,
    brief_chars: text.length,
    exempt_targets: entries.filter((entry) => entry.exempt).length,
  };
  console.log(JSON.stringify(summary, null, 2));
  console.log("");
  console.log(`${briefPath} 하나를 채팅에 붙여넣거나 첨부한다.`);
  console.log(`받은 JSON 배열을 ${path.join(args.outDir, "responses")}에 .json으로 저장한 뒤`);
  console.log("node scripts/merge_summary_batches.mjs 를 실행한다.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
