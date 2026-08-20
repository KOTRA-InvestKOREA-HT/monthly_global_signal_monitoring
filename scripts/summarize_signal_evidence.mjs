#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULTS = {
  investmentSignals: "outputs/latest_investment_signals.json",
  relevantSignals: "outputs/latest_relevant_signals.json",
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
  const snippets = [
    ...(Array.isArray(row.evidence_snippets) ? row.evidence_snippets : []),
    ...(Array.isArray(row.technology_evidence_snippets) ? row.technology_evidence_snippets : []),
  ];
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
    `본문/근거: ${cleanText([snippets.join(" "), row.content_excerpt, row.content_text].filter(Boolean).join(" "))}`,
  ].join("\n");
  return shortText(body, maxInputChars);
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
  let completed = 0;
  const updated = await mapLimit(targetRows, args.concurrency, async ({ row, shouldSummarize }) => {
    if (!shouldSummarize) return row;
    try {
      const summarized = await summarizeRow(row, args, apiKey);
      completed += 1;
      process.stderr.write(`[${kind}] ${completed}/${targetRows.filter((item) => item.shouldSummarize).length} ${row.company}\n`);
      return summarized;
    } catch (error) {
      return {
        ...row,
        ai_summary_quality: "failed",
        ai_summary_reason: error.message,
        ai_summary_created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
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

  if (!apiKey) {
    const summary = {
      run_started_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      status: args.optional ? "skipped_missing_openai_api_key" : "failed_missing_openai_api_key",
      note: "Set OPENAI_API_KEY in GitHub Secrets or the local environment to enable AI Korean summaries.",
    };
    await fs.writeFile(path.join(args.outDir, "latest_ai_summary_summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(summary, null, 2));
    if (!args.optional) process.exitCode = 1;
    return;
  }

  const [investmentRows, relevantRows] = await Promise.all([
    readJson(args.investmentSignals, []),
    readJson(args.relevantSignals, []),
  ]);

  const investmentUpdated = await summarizeRows(investmentRows, args, apiKey, "investment");
  const relevantUpdated = await summarizeRows(relevantRows, args, apiKey, "relevant");
  const [investmentOutputs, relevantOutputs] = await Promise.all([
    writeOutputs(investmentUpdated, args.investmentSignals, args.outDir, "investment_signals_ai_summary"),
    writeOutputs(relevantUpdated, args.relevantSignals, args.outDir, "relevant_signals_ai_summary"),
  ]);

  const allRows = [...investmentUpdated, ...relevantUpdated];
  const summary = {
    run_started_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    status: "completed",
    method: "luna_first_terra_retry",
    luna_model: args.lunaModel,
    terra_model: args.terraModel,
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
