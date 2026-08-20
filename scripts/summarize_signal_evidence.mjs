#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const CACHE_VERSION = 1;
const PROMPT_VERSION = "signal-summary-ko-v1";
const SUMMARY_FIELDS = [
  "ai_summary_ko",
  "ai_summary_quality",
  "ai_summary_confidence",
  "ai_summary_reason",
  "ai_summary_model",
  "ai_summary_tier",
  "ai_summary_luna_draft",
  "ai_summary_source",
  "ai_summary_created_at",
];

const DEFAULTS = {
  investmentSignals: "outputs/latest_investment_signals.json",
  relevantSignals: "outputs/latest_relevant_signals.json",
  cache: "outputs/ai_summary_cache.json",
  outDir: "outputs",
  lunaModel: process.env.AI_SUMMARY_LUNA_MODEL || "gpt-5",
  terraModel: process.env.AI_SUMMARY_TERRA_MODEL || "gpt-5.6",
  concurrency: 2,
  maxInputChars: 3600,
  onlyMissing: true,
  optional: true,
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
  args.concurrency = Math.max(1, Number(args.concurrency) || DEFAULTS.concurrency);
  args.maxInputChars = Math.max(1000, Number(args.maxInputChars) || DEFAULTS.maxInputChars);
  args.onlyMissing = args.onlyMissing !== "false" && args.onlyMissing !== false;
  args.optional = args.optional !== "false" && args.optional !== false;
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

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/<[^>]+>/g, " ")
    .trim();
}

function shortText(value, limit) {
  const text = cleanText(value);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function sourceEvidence(row) {
  const snippets = [
    ...(Array.isArray(row.evidence_snippets) ? row.evidence_snippets : []),
    ...(Array.isArray(row.technology_evidence_snippets) ? row.technology_evidence_snippets : []),
  ];
  return cleanText([snippets.join(" "), row.content_excerpt, row.content_text].filter(Boolean).join(" "));
}

function rowIdentity(row) {
  return [
    row.target_no,
    row.company,
    row.investment_signal_no || row.relevance_decision || "relevant",
    row.url || row.title,
  ]
    .filter((value) => value !== undefined && value !== null && value !== "")
    .join("|");
}

function sourceMaterial(row, maxInputChars) {
  const body = [
    `기업: ${row.company || ""}`,
    `유치필요 품목/기술: ${row.target_technology || ""}`,
    `시그널: ${row.investment_signal_label || row.relevance_decision || ""}`,
    `시그널 설명: ${row.investment_signal_description || ""}`,
    `제목: ${row.title || ""}`,
    `출처: ${row.source || ""}`,
    `게시일: ${row.published_at || ""}`,
    `기존 판정 근거: ${row.investment_signal_reason || row.relevance_reason || ""}`,
    `매칭 키워드: ${(row.matched_terms || row.technology_matched_terms || []).join(", ")}`,
    `본문/근거: ${sourceEvidence(row)}`,
  ].join("\n");
  return shortText(body, maxInputChars);
}

function cachePayload(row, args) {
  return {
    prompt_version: PROMPT_VERSION,
    company: cleanText(row.company),
    target_no: String(row.target_no || ""),
    signal: String(row.investment_signal_no || row.relevance_decision || "relevant"),
    target_technology: cleanText(row.target_technology),
    title: cleanText(row.title),
    url: cleanText(row.url),
    source: cleanText(row.source),
    published_at: cleanText(row.published_at),
    input: sourceMaterial(row, args.maxInputChars),
  };
}

function cacheKey(row, args) {
  return crypto.createHash("sha256").update(JSON.stringify(cachePayload(row, args))).digest("hex").slice(0, 32);
}

function summaryFromRow(row) {
  if (!cleanText(row.ai_summary_ko)) return null;
  const summary = {};
  for (const field of SUMMARY_FIELDS) {
    if (row[field] !== undefined && row[field] !== null && row[field] !== "") {
      summary[field] = row[field];
    }
  }
  return summary;
}

function withoutSummaryFields(row) {
  const next = { ...row };
  for (const field of SUMMARY_FIELDS) delete next[field];
  delete next.ai_summary_cache_hit_at;
  return next;
}

async function readSummaryCache(cachePath) {
  const fallback = { version: CACHE_VERSION, entries: {} };
  const cache = await readJson(cachePath, fallback);
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) return fallback;
  return {
    version: cache.version || CACHE_VERSION,
    updated_at: cache.updated_at || "",
    entries: cache.entries && typeof cache.entries === "object" && !Array.isArray(cache.entries) ? cache.entries : {},
  };
}

function cacheMetadata(row, key) {
  return {
    cache_key: key,
    row_identity: rowIdentity(row),
    company: row.company || "",
    target_no: row.target_no || "",
    investment_signal_no: row.investment_signal_no || "",
    relevance_decision: row.relevance_decision || "",
    title: row.title || "",
    url: row.url || "",
    source: row.source || "",
    published_at: row.published_at || "",
    target_technology: row.target_technology || "",
  };
}

function applyCachedSummaries(rows, args, cache) {
  let hitCount = 0;
  const updated = rows.map((row) => {
    const key = cacheKey(row, args);
    const existingSummary = summaryFromRow(row);
    if (existingSummary && (!row.ai_summary_cache_key || row.ai_summary_cache_key === key)) {
      return { ...row, ai_summary_cache_key: key, ai_summary_cache_status: row.ai_summary_cache_status || "existing" };
    }
    const entry = cache.entries[key];
    const summary = entry ? summaryFromRow(entry) : null;
    if (!summary) {
      const baseRow = existingSummary && row.ai_summary_cache_key !== key ? withoutSummaryFields(row) : row;
      return { ...baseRow, ai_summary_cache_key: key, ai_summary_cache_status: existingSummary ? "miss_changed" : "miss" };
    }
    hitCount += 1;
    return {
      ...row,
      ...summary,
      ai_summary_cache_key: key,
      ai_summary_cache_status: "hit",
      ai_summary_cache_hit_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
  });
  return { rows: updated, hitCount };
}

function updateSummaryCache(cache, rows, args) {
  const next = {
    version: CACHE_VERSION,
    updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    entries: { ...(cache.entries || {}) },
  };
  let storedCount = 0;
  for (const row of rows) {
    const summary = summaryFromRow(row);
    if (!summary || row.ai_summary_quality === "failed") continue;
    const key = row.ai_summary_cache_key || cacheKey(row, args);
    next.entries[key] = {
      ...cacheMetadata(row, key),
      ...summary,
      prompt_version: PROMPT_VERSION,
      cached_at: next.updated_at,
    };
    storedCount += 1;
  }
  return { cache: next, storedCount };
}

function extractOutputText(payload) {
  if (typeof payload.output_text === "string") return payload.output_text;
  const chunks = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") chunks.push(content.text);
      if (typeof content.output_text === "string") chunks.push(content.output_text);
    }
  }
  return chunks.join("\n").trim();
}

function parseModelJson(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("empty model output");
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`non-json model output: ${trimmed.slice(0, 120)}`);
    return JSON.parse(match[0]);
  }
}

async function callOpenAI({ apiKey, model, row, args, tier }) {
  const input = sourceMaterial(row, args.maxInputChars);
  const prompt = [
    "너는 KOTRA 투자유치 모니터링 보고서 편집자다.",
    "주어진 공식 보도자료/IR/뉴스 본문에서 유치필요 품목/기술과 5대 투자동향 시그널에 관련된 사실만 골라 한국어로 요약한다.",
    "투자 확정, 이미 완료된 발표 등 후행 사실은 전조현상처럼 과장하지 말고, 확인 가능한 내용만 쓴다.",
    "보고서 본문에 바로 들어가므로 2~3문장, 160자 이내, 명사형 나열보다 자연스러운 한국어 문장으로 작성한다.",
    "근거가 부족하면 quality를 needs_review로 둔다.",
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      store: false,
      max_output_tokens: 350,
      input: [
        { role: "system", content: [{ type: "input_text", text: prompt }] },
        { role: "user", content: [{ type: "input_text", text: input }] },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "signal_summary",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              summary_ko: { type: "string" },
              quality: { type: "string", enum: ["pass", "needs_review"] },
              confidence: { type: "number" },
              reason: { type: "string" },
            },
            required: ["summary_ko", "quality", "confidence", "reason"],
          },
        },
      },
    }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.error?.message || response.statusText || `HTTP ${response.status}`;
    throw new Error(`${tier} ${model}: ${message}`);
  }

  const parsed = parseModelJson(extractOutputText(body));
  return {
    ai_summary_ko: cleanText(parsed.summary_ko),
    ai_summary_quality: parsed.quality,
    ai_summary_confidence: Number(parsed.confidence) || 0,
    ai_summary_reason: cleanText(parsed.reason),
    ai_summary_model: model,
    ai_summary_tier: tier,
  };
}

function needsTerra(summary) {
  const text = cleanText(summary.ai_summary_ko);
  const koreanChars = (text.match(/[가-힣]/g) || []).length;
  const latinChars = (text.match(/[A-Za-z]/g) || []).length;
  if (!text || text.length < 35) return true;
  if (koreanChars < 15) return true;
  if (latinChars > koreanChars * 1.8) return true;
  if (/요약할 수 없|확인할 수 없|정보가 부족|needs_review/i.test(`${text} ${summary.ai_summary_quality}`)) return true;
  return summary.ai_summary_quality !== "pass" || summary.ai_summary_confidence < 0.72;
}

async function summarizeRow(row, args, apiKey) {
  const base = {
    ai_summary_created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    ai_summary_source: "openai_responses_api",
    ai_summary_cache_status: "new",
  };
  let luna = await callOpenAI({ apiKey, model: args.lunaModel, row, args, tier: "luna" });
  if (!needsTerra(luna)) return { ...row, ...base, ...luna };

  try {
    const terra = await callOpenAI({ apiKey, model: args.terraModel, row, args, tier: "terra" });
    return { ...row, ...base, ...terra, ai_summary_luna_draft: luna.ai_summary_ko };
  } catch (error) {
    return {
      ...row,
      ...base,
      ...luna,
      ai_summary_quality: "needs_review",
      ai_summary_reason: `${luna.ai_summary_reason} / Terra 재요약 실패: ${error.message}`,
    };
  }
}

async function mapLimit(rows, limit, mapper) {
  const result = new Array(rows.length);
  let cursor = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;
      result[index] = await mapper(rows[index], index);
    }
  });
  await Promise.all(workers);
  return result;
}

function allCsvHeaders(rows) {
  const seen = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row)) seen.add(key);
  }
  return [...seen];
}

function toCsvValue(value) {
  if (Array.isArray(value)) return toCsvValue(value.join("; "));
  if (value === null || value === undefined) return "";
  const stringValue = String(value);
  if (/[",\n\r]/.test(stringValue)) return `"${stringValue.replace(/"/g, '""')}"`;
  return stringValue;
}

async function writeCsv(filePath, rows) {
  const headers = allCsvHeaders(rows);
  const lines = [headers.join(",")];
  for (const row of rows) lines.push(headers.map((header) => toCsvValue(row[header])).join(","));
  await fs.writeFile(filePath, `\uFEFF${lines.join("\n")}\n`, "utf8");
}

async function summarizeRows(rows, args, apiKey, kind) {
  const targetRows = rows.map((row) => ({ row, shouldSummarize: !args.onlyMissing || !cleanText(row.ai_summary_ko) }));
  const targetCount = targetRows.filter((item) => item.shouldSummarize).length;
  let completed = 0;
  const updated = await mapLimit(targetRows, args.concurrency, async ({ row, shouldSummarize }) => {
    if (!shouldSummarize) return row;
    try {
      const summarized = await summarizeRow(row, args, apiKey);
      completed += 1;
      process.stderr.write(`[${kind}] ${completed}/${targetCount} ${row.company}\n`);
      return summarized;
    } catch (error) {
      return {
        ...row,
        ai_summary_quality: "failed",
        ai_summary_reason: error.message,
        ai_summary_created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        ai_summary_cache_status: "failed",
      };
    }
  });
  return updated;
}

async function writeOutputs(rows, sourcePath, outDir, prefix) {
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
  const jsonPath = path.join(outDir, `${prefix}_${timestamp}.json`);
  const csvPath = path.join(outDir, `${prefix}_${timestamp}.csv`);
  await fs.writeFile(sourcePath, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  await fs.writeFile(jsonPath, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  await writeCsv(sourcePath.replace(/\.json$/i, ".csv"), rows);
  await writeCsv(csvPath, rows);
  return { latest_json: sourcePath, latest_csv: sourcePath.replace(/\.json$/i, ".csv"), json: jsonPath, csv: csvPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.OPENAI_API_KEY;
  await fs.mkdir(args.outDir, { recursive: true });
  await fs.mkdir(path.dirname(args.cache), { recursive: true });

  const [investmentRows, relevantRows, summaryCache] = await Promise.all([
    readJson(args.investmentSignals, []),
    readJson(args.relevantSignals, []),
    readSummaryCache(args.cache),
  ]);

  const investmentCached = applyCachedSummaries(investmentRows, args, summaryCache);
  const relevantCached = applyCachedSummaries(relevantRows, args, summaryCache);
  const cacheHitCount = investmentCached.hitCount + relevantCached.hitCount;
  const changedStaleCount = [...investmentCached.rows, ...relevantCached.rows].filter(
    (row) => row.ai_summary_cache_status === "miss_changed",
  ).length;

  if (!apiKey) {
    let investmentOutputs = null;
    let relevantOutputs = null;
    if (cacheHitCount || changedStaleCount) {
      [investmentOutputs, relevantOutputs] = await Promise.all([
        writeOutputs(investmentCached.rows, args.investmentSignals, args.outDir, "investment_signals_ai_summary"),
        writeOutputs(relevantCached.rows, args.relevantSignals, args.outDir, "relevant_signals_ai_summary"),
      ]);
    }
    const summary = {
      run_started_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      status: args.optional
        ? cacheHitCount
          ? "cache_only_missing_openai_api_key"
          : "skipped_missing_openai_api_key"
        : "failed_missing_openai_api_key",
      cache_path: args.cache,
      cache_entry_count: Object.keys(summaryCache.entries || {}).length,
      cache_hit_count: cacheHitCount,
      changed_stale_count: changedStaleCount,
      note: cacheHitCount
        ? "OPENAI_API_KEY is missing, so cached Korean summaries were reused and new/changed items were left without AI summaries."
        : "Set OPENAI_API_KEY in GitHub Secrets or the local environment to enable AI Korean summaries.",
      outputs: { investment: investmentOutputs, relevant: relevantOutputs },
    };
    await fs.writeFile(path.join(args.outDir, "latest_ai_summary_summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(summary, null, 2));
    if (!args.optional) process.exitCode = 1;
    return;
  }

  const investmentUpdated = await summarizeRows(investmentCached.rows, args, apiKey, "investment");
  const relevantUpdated = await summarizeRows(relevantCached.rows, args, apiKey, "relevant");
  const allRows = [...investmentUpdated, ...relevantUpdated];
  const cacheUpdate = updateSummaryCache(summaryCache, allRows, args);
  const [investmentOutputs, relevantOutputs] = await Promise.all([
    writeOutputs(investmentUpdated, args.investmentSignals, args.outDir, "investment_signals_ai_summary"),
    writeOutputs(relevantUpdated, args.relevantSignals, args.outDir, "relevant_signals_ai_summary"),
    fs.writeFile(args.cache, `${JSON.stringify(cacheUpdate.cache, null, 2)}\n`, "utf8"),
  ]);

  const summary = {
    run_started_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    status: "completed",
    method: "luna_first_terra_retry",
    luna_model: args.lunaModel,
    terra_model: args.terraModel,
    cache_path: args.cache,
    cache_entry_count: Object.keys(cacheUpdate.cache.entries || {}).length,
    cache_hit_count: allRows.filter((row) => row.ai_summary_cache_status === "hit").length,
    cache_miss_count: allRows.filter((row) => row.ai_summary_cache_status === "new" || row.ai_summary_cache_status === "failed").length,
    cache_stored_count: cacheUpdate.storedCount,
    investment_signal_count: investmentUpdated.length,
    relevant_signal_count: relevantUpdated.length,
    summarized_count: allRows.filter((row) => cleanText(row.ai_summary_ko)).length,
    terra_retry_count: allRows.filter((row) => row.ai_summary_tier === "terra").length,
    failed_count: allRows.filter((row) => row.ai_summary_quality === "failed").length,
    outputs: { investment: investmentOutputs, relevant: relevantOutputs },
  };
  await fs.writeFile(path.join(args.outDir, "latest_ai_summary_summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
