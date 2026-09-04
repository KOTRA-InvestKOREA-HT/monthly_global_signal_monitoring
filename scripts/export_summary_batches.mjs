#!/usr/bin/env node
// API 키 없이 AI 근거 평가 단계를 사람이 채팅으로 대신할 때 쓰는 내보내기.
//
// 파이프라인에서 API가 필요한 단계는 summarize_signal_evidence.mjs 하나뿐이다. 수집·필터·분류·
// 검증·PDF는 전부 로컬 계산이다. 그래서 그 한 단계의 입력을 붙여넣기 가능한 묶음으로 꺼내고,
// 답을 merge_summary_batches.mjs로 되돌려 넣으면 나머지 파이프라인은 그대로 돈다.
//
// 판정 기준은 API 경로와 같은 프롬프트 규칙을 쓴다. 규칙을 여기서 새로 쓰면 어느 경로로 만든
// 보고서냐에 따라 승인 기준이 달라진다.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isRelevanceExempt, rowIdentity, sourceMaterial } from "./summarize_signal_evidence.mjs";

const DEFAULTS = {
  investmentSignals: "outputs/latest_investment_signals.json",
  relevantSignals: "outputs/latest_relevant_signals.json",
  outDir: "outputs/manual_summary",
  maxInputChars: 3600,
  maxRows: 12,
  maxBatchChars: 45000,
};

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
  args.maxInputChars = Math.max(800, Number(args.maxInputChars) || DEFAULTS.maxInputChars);
  args.maxRows = Math.max(1, Number(args.maxRows) || DEFAULTS.maxRows);
  args.maxBatchChars = Math.max(4000, Number(args.maxBatchChars) || DEFAULTS.maxBatchChars);
  return args;
}

async function readJson(filePath, fallback = []) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export function batchRows(items, { maxRows, maxBatchChars }) {
  const batches = [];
  let current = [];
  let currentChars = 0;
  for (const item of items) {
    const size = item.input.length;
    // 한 행이 통째로 상한을 넘으면 혼자라도 한 배치에 넣는다. 자르면 판정 근거가 사라진다.
    if (current.length && (current.length >= maxRows || currentChars + size > maxBatchChars)) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(item);
    currentChars += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

// 요약 규칙은 kind마다 다르므로 배치도 kind를 섞지 않는다.
function rulesFor(kind) {
  const isBusiness = kind === "relevant";
  return [
    "너는 KOTRA 투자유치 모니터링 보고서 편집자다.",
    "각 항목의 '본문/근거'에 실제로 적힌 사실만 사용한다. 본문에 없는 내용을 추론하거나 지어내지 않는다.",
    "",
    "## 판정 규칙",
    "- entity_supported: 사건이 검토 기업 자체에 귀속될 때만 true. 모회사·관계사 자료는 본문에 검토 기업명, 해당 사업부, 제품 또는 임원이 명시될 때만 true.",
    "- target_technology_supported: 사건이 '유치필요 품목/기술'과 직접 연결될 때만 true. 같은 기업의 다른 사업부·제품·일반 경영활동이면 false.",
    isBusiness
      ? "- indicator_supported, leading_indicator_supported: 사업동향 항목이므로 항상 true로 둔다."
      : "- indicator_supported: 본문이 해당 '시그널' 정의에 맞는 구체적 사건을 보여줄 때만 true. 키워드 언급, 위험고지·전망 상용문구, 일반 재무항목만 있으면 false.",
    isBusiness
      ? "- event_stage: 항상 not_applicable."
      : "- leading_indicator_supported: 향후 투자결정의 선행 징후로 볼 근거가 있을 때만 true. 이미 확정·완료된 투자·인수·자금조달 사실 자체만 근거인 후행 사건이면 false.",
    isBusiness
      ? ""
      : "- event_stage: exploratory, planned, committed, completed, unclear 중 하나. 이미 확정·발표·계약·자금조달·인수·가동이 끝났으면 committed 또는 completed.",
    "- quality: 근거가 부족하면 needs_review, 충분하면 pass.",
    "- confidence: 0~1 사이 숫자.",
    "- signal_supported: 위 개별 판정의 논리곱. 하나라도 false이거나 불명확하면 false.",
    "- reason: 그렇게 판정한 이유를 한국어 한두 문장으로.",
    "- 항목에 `relevance_exempt: true`가 붙어 있으면 그 기업은 유치필요 품목(기술) 관련성 검사에서 제외된 대상이다. target_technology_supported는 본문 근거대로 그대로 보고하되, 이 항목만은 signal_supported의 논리곱에서 제외한다.",
    "",
    "## 요약문 규칙",
    "- signal_supported가 false인 항목: summary_ko와 summary_en에 본문 사실을 한 문장으로만 적는다(각 40~90자). 나머지 요약 필드는 빈 문자열.",
    "- signal_supported가 true인 항목만 아래 보고서용 요약을 작성한다.",
    isBusiness
      ? "  - summary_ko: 3~4문장, 260~360자. 보고서체로 쓰고 존대말·구어체를 쓰지 않는다. '습니다', '합니다', '했습니다'는 쓰지 않는다. summary_headline_ko와 summary_detail_ko는 빈 문자열."
      : "  - summary_headline_ko: 18~42자 명사구, 종결어미 없이. summary_detail_ko: 35~85자, 종결어미 없이. summary_ko는 'headline - detail' 형식.",
    isBusiness
      ? "  - summary_en: 같은 내용의 영문 3~4문장, 300~460자. summary_headline_en과 summary_detail_en은 빈 문자열."
      : "  - summary_headline_en: 40~90자 명사구 영문 표제. summary_detail_en: 70~180자 영문 캡션체. 둘 다 마침표로 끝내지 않는다. summary_en은 'headline - detail' 형식.",
    "- 영문은 한국어 직역이 아니라 같은 사실을 영어 보고서 문체로 쓴 것이어야 하며, 두 언어의 사실관계는 일치해야 한다.",
    "- 성장률 표현: mid-single-digit=한 자릿수 중반대, low-single-digit=한 자릿수 초반대, high-single-digit=한 자릿수 후반대.",
    "",
    "## 출력 형식",
    "설명이나 머리말 없이 JSON 배열 하나만 출력한다. 항목 수와 ref는 입력과 정확히 같아야 한다.",
    "```json",
    "[",
    '  {"ref":"<입력의 ref 그대로>","summary_ko":"","summary_headline_ko":"","summary_detail_ko":"",',
    '   "summary_en":"","summary_headline_en":"","summary_detail_en":"",',
    '   "signal_supported":false,"entity_supported":false,"target_technology_supported":false,',
    '   "indicator_supported":false,"leading_indicator_supported":false,',
    `   "event_stage":"${isBusiness ? "not_applicable" : "unclear"}","quality":"needs_review","confidence":0.0,"reason":""}`,
    "]",
    "```",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function renderBatch({ kind, batchNo, batchCount, items }) {
  const header = [
    `# 시그널 근거 평가 배치 ${batchNo}/${batchCount} (${kind === "relevant" ? "글로벌 사업현황" : "투자 시그널"})`,
    "",
    `이 배치에는 ${items.length}개 항목이 있다. 모든 항목에 대해 아래 규칙대로 판정과 요약을 작성한다.`,
    "",
    rulesFor(kind),
    "",
    "## 항목",
    "",
  ].join("\n");

  const body = items
    .map((item) =>
      [
        `### ref: ${item.ref}`,
        item.relevanceExempt ? "relevance_exempt: true" : null,
        "",
        item.input,
        "",
      ]
        .filter((line) => line !== null)
        .join("\n"),
    )
    .join("\n");

  return `${header}${body}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [investmentRows, relevantRows] = await Promise.all([
    readJson(args.investmentSignals, []),
    readJson(args.relevantSignals, []),
  ]);

  await fs.mkdir(path.join(args.outDir, "batches"), { recursive: true });
  await fs.mkdir(path.join(args.outDir, "responses"), { recursive: true });

  const manifest = { generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), rows: [] };
  const summary = { batches: [], row_count: 0, input_chars: 0 };

  for (const [kind, rows, sourcePath, prefix] of [
    ["investment", investmentRows, args.investmentSignals, "INV"],
    ["relevant", relevantRows, args.relevantSignals, "REL"],
  ]) {
    const items = rows.map((row, index) => {
      const ref = `${prefix}-${String(index + 1).padStart(3, "0")}`;
      manifest.rows.push({
        ref,
        kind,
        source: sourcePath,
        index,
        identity: rowIdentity(row),
        company: row.company || "",
        relevance_exempt: isRelevanceExempt(row),
      });
      return { ref, input: sourceMaterial(row, args.maxInputChars), relevanceExempt: isRelevanceExempt(row) };
    });

    const batches = batchRows(items, args);
    for (const [batchIndex, batchItems] of batches.entries()) {
      const batchNo = batchIndex + 1;
      const name = `${prefix.toLowerCase()}_batch_${String(batchNo).padStart(2, "0")}.md`;
      const text = renderBatch({ kind, batchNo, batchCount: batches.length, items: batchItems });
      await fs.writeFile(path.join(args.outDir, "batches", name), `${text}\n`, "utf8");
      summary.batches.push({ file: name, kind, rows: batchItems.length, chars: text.length });
      summary.row_count += batchItems.length;
      summary.input_chars += text.length;
    }
  }

  await fs.writeFile(path.join(args.outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(args.outDir, "export_summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  console.log(JSON.stringify(summary, null, 2));
  console.log("");
  console.log(`배치 ${summary.batches.length}개를 ${path.join(args.outDir, "batches")}에 썼다.`);
  console.log(`각 파일을 통째로 채팅에 붙여넣고, 받은 JSON 배열을 ${path.join(args.outDir, "responses")}에 같은 이름의 .json으로 저장한다.`);
  console.log("그다음 node scripts/merge_summary_batches.mjs 를 실행한다.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
