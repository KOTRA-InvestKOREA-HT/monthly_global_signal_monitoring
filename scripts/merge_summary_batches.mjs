#!/usr/bin/env node
// 채팅에서 받은 판정 JSON을 보고서 입력에 되돌려 넣는다.
//
// 손으로 옮기는 경로이므로 깨진 JSON, 누락된 행, 없는 행 추가, 잘못된 ref가 반드시 생긴다.
// 그래서 병합은 fail-closed로 동작한다. 하나라도 어긋나면 원본 파일을 건드리지 않고 종료한다.
// 승인값은 API 경로와 같은 computeSignalSupport()로 계산한다. 모델이 스스로 적은
// signal_supported를 그대로 믿지 않는 것도 API 경로와 같다.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  cleanText,
  computeSignalSupport,
  englishHeadlineDetail,
  normalizeKoreanSummaryText,
  rowIdentity,
  summaryHeadlineDetail,
} from "./summarize_signal_evidence.mjs";

const DEFAULTS = {
  investmentSignals: "outputs/latest_investment_signals.json",
  relevantSignals: "outputs/latest_relevant_signals.json",
  dir: "outputs/manual_summary",
  model: "manual-chat",
  dryRun: false,
};

const REQUIRED_FIELDS = [
  "signal_supported",
  "entity_supported",
  "target_technology_supported",
  "indicator_supported",
  "leading_indicator_supported",
  "event_stage",
  "quality",
  "reason",
];

const EVENT_STAGES = ["exploratory", "planned", "committed", "completed", "not_applicable", "unclear"];

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
  args.dryRun = args.dryRun === true || args.dryRun === "true";
  return args;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

// 채팅은 코드펜스나 짧은 머리말을 붙이곤 한다. 배열만 도려낸다.
export function parseResponseArray(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("빈 응답 파일");
  const candidates = [];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(trimmed);
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start !== -1 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed?.items)) return parsed.items;
    } catch {
      // 다음 후보를 시도한다.
    }
  }
  throw new Error("JSON 배열을 찾지 못함");
}

export function validateEntry(entry, ref) {
  const errors = [];
  for (const field of REQUIRED_FIELDS) {
    if (entry[field] === undefined || entry[field] === null) errors.push(`${ref}: ${field} 누락`);
  }
  for (const field of REQUIRED_FIELDS.slice(0, 5)) {
    if (entry[field] !== undefined && typeof entry[field] !== "boolean") {
      errors.push(`${ref}: ${field}는 boolean이어야 함 (받은 값 ${JSON.stringify(entry[field])})`);
    }
  }
  if (entry.event_stage !== undefined && !EVENT_STAGES.includes(entry.event_stage)) {
    errors.push(`${ref}: event_stage 값이 정의에 없음 (${entry.event_stage})`);
  }
  if (entry.quality !== undefined && !["pass", "needs_review"].includes(entry.quality)) {
    errors.push(`${ref}: quality는 pass 또는 needs_review여야 함 (${entry.quality})`);
  }
  if (!cleanText(entry.summary_ko)) errors.push(`${ref}: summary_ko 비어 있음`);
  if (!cleanText(entry.summary_en)) errors.push(`${ref}: summary_en 비어 있음`);
  if (!cleanText(entry.reason)) errors.push(`${ref}: reason 비어 있음`);
  return errors;
}

// API 경로가 만드는 것과 같은 모양의 ai_* 필드를 만든다.
export function buildSummaryFields(entry, { kind, relevanceExempt, model }) {
  const isBusinessSummary = kind === "relevant";
  const support = computeSignalSupport({ parsed: entry, isBusinessSummary, relevanceExempt });
  const common = {
    ai_signal_supported: support.computedSignalSupported,
    ai_entity_supported: support.entitySupported,
    ai_target_technology_supported: support.targetTechnologySupported,
    ai_indicator_supported: support.indicatorSupported,
    ai_leading_indicator_supported: support.leadingIndicatorSupported,
    ai_event_stage: entry.event_stage,
    ai_summary_quality: entry.quality,
    ai_summary_confidence: Number(entry.confidence) || 0,
    ai_summary_reason: normalizeKoreanSummaryText(entry.reason),
    ai_summary_model: model,
    ai_summary_tier: "manual",
    ai_summary_source: "manual_chat_handoff",
    ai_summary_created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    ai_summary_cache_status: "manual",
  };

  if (isBusinessSummary) {
    return {
      ...common,
      ai_summary_ko: normalizeKoreanSummaryText(entry.summary_ko),
      ai_summary_headline_ko: "",
      ai_summary_detail_ko: "",
      ai_summary_en: cleanText(entry.summary_en),
      ai_summary_headline_en: "",
      ai_summary_detail_en: "",
    };
  }

  // 투자 시그널은 API 경로와 같은 문구 정리를 거쳐야 PDF에서 같은 문체로 보인다.
  const parts = summaryHeadlineDetail({
    headline: entry.summary_headline_ko,
    detail: entry.summary_detail_ko,
    summary: entry.summary_ko,
  });
  const englishParts = englishHeadlineDetail({
    headline: entry.summary_headline_en,
    detail: entry.summary_detail_en,
    summary: entry.summary_en,
  });
  return {
    ...common,
    ai_summary_ko: normalizeKoreanSummaryText(`${parts.headline}${parts.detail ? ` - ${parts.detail}` : ""}`),
    ai_summary_headline_ko: parts.headline,
    ai_summary_detail_ko: parts.detail,
    ai_summary_en: cleanText(`${englishParts.headline}${englishParts.detail ? ` - ${englishParts.detail}` : ""}`),
    ai_summary_headline_en: englishParts.headline,
    ai_summary_detail_en: englishParts.detail,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = path.join(args.dir, "manifest.json");
  let manifest;
  try {
    manifest = await readJson(manifestPath);
  } catch {
    console.error(`${manifestPath}를 읽지 못했다. 먼저 export_summary_batches.mjs를 실행한다.`);
    process.exitCode = 1;
    return;
  }

  const byRef = new Map(manifest.rows.map((row) => [row.ref, row]));
  const responseDir = path.join(args.dir, "responses");
  const files = (await fs.readdir(responseDir).catch(() => []))
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (!files.length) {
    console.error(`${responseDir}에 응답 파일(.json)이 없다.`);
    process.exitCode = 1;
    return;
  }

  const errors = [];
  const entries = new Map();
  for (const file of files) {
    let list;
    try {
      list = parseResponseArray(await fs.readFile(path.join(responseDir, file), "utf8"));
    } catch (error) {
      errors.push(`${file}: ${error.message}`);
      continue;
    }
    for (const entry of list) {
      const ref = cleanText(entry?.ref);
      if (!ref) {
        errors.push(`${file}: ref 없는 항목`);
        continue;
      }
      if (!byRef.has(ref)) {
        errors.push(`${file}: manifest에 없는 ref ${ref}`);
        continue;
      }
      if (entries.has(ref)) {
        errors.push(`${file}: ref ${ref} 중복`);
        continue;
      }
      errors.push(...validateEntry(entry, ref));
      entries.set(ref, entry);
    }
  }

  const missing = manifest.rows.filter((row) => !entries.has(row.ref)).map((row) => row.ref);
  if (missing.length) {
    errors.push(`응답이 없는 행 ${missing.length}건: ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? " ..." : ""}`);
  }

  if (errors.length) {
    console.error(JSON.stringify({ status: "failed", error_count: errors.length, errors: errors.slice(0, 60) }, null, 2));
    console.error("");
    console.error("원본 파일은 변경하지 않았다.");
    process.exitCode = 1;
    return;
  }

  // 여기까지 왔으면 모든 행이 정확히 한 번씩 응답을 받았고 형식도 맞다.
  const bySource = new Map();
  for (const row of manifest.rows) {
    if (!bySource.has(row.source)) bySource.set(row.source, await readJson(row.source));
  }

  let applied = 0;
  const identityErrors = [];
  for (const row of manifest.rows) {
    const rows = bySource.get(row.source);
    const target = rows[row.index];
    // 내보낸 뒤 원본이 다시 생성됐으면 인덱스가 다른 행을 가리킬 수 있다.
    if (!target || rowIdentity(target) !== row.identity) {
      identityErrors.push(`${row.ref}: 원본 행이 내보낼 때와 다르다. 수집 결과가 바뀌었으면 다시 내보내야 한다.`);
      continue;
    }
    Object.assign(
      target,
      buildSummaryFields(entries.get(row.ref), {
        kind: row.kind,
        relevanceExempt: row.relevance_exempt === true,
        model: args.model,
      }),
    );
    applied += 1;
  }

  if (identityErrors.length) {
    console.error(JSON.stringify({ status: "failed", errors: identityErrors.slice(0, 40) }, null, 2));
    console.error("");
    console.error("원본 파일은 변경하지 않았다.");
    process.exitCode = 1;
    return;
  }

  const result = {
    status: args.dryRun ? "validated" : "applied",
    applied_rows: applied,
    files: [...bySource.keys()],
    approved: {},
  };
  for (const [source, rows] of bySource) {
    result.approved[source] = rows.filter((row) => row.ai_signal_supported === true).length;
    if (!args.dryRun) await fs.writeFile(source, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify(result, null, 2));
  if (!args.dryRun) {
    console.log("");
    console.log("이제 node scripts/validate_report_inputs.mjs 로 게시 검증을 실행한다.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
