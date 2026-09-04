#!/usr/bin/env node
// OPENAI_API_KEY로 수집 파이프라인이 실제로 쓰는 경로가 열려 있는지만 확인한다.
// 전체 실행은 174행·243회 호출이 나가므로, 키 교체 뒤에는 이 스크립트로 먼저 점검한다.
//
// 확인 순서는 실패 지점을 구분하기 위한 것이다.
//   1) 키 존재       - 환경변수만 확인, 값은 출력하지 않는다
//   2) 모델 목록     - GET /v1/models, 토큰을 쓰지 않는다
//   3) 응답 1건      - POST /v1/responses, 운영과 같은 strict json_schema로 최소 호출
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULTS = {
  lunaModel: process.env.AI_SUMMARY_LUNA_MODEL || "gpt-5.6-luna",
  terraModel: process.env.AI_SUMMARY_TERRA_MODEL || "gpt-5.6-terra",
  reasoningEffort: process.env.AI_SUMMARY_REASONING_EFFORT || "low",
  maxOutputTokens: 512,
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
  args.maxOutputTokens = Math.max(64, Number(args.maxOutputTokens) || DEFAULTS.maxOutputTokens);
  return args;
}

// 어디서 막혔는지에 따라 대응이 달라지므로 상태코드와 오류 문구를 함께 본다.
export function classifyFailure(status, message = "") {
  const text = String(message);
  if (status === 401) {
    return { cause: "invalid_key", advice: "키가 유효하지 않거나 폐기됐다. 값을 다시 발급받아 등록한다." };
  }
  if (status === 403) {
    return { cause: "forbidden", advice: "키는 인식되지만 이 조직·프로젝트에 권한이 없다. 관리자에게 해당 모델 사용 허용을 요청한다." };
  }
  if (status === 404 || /does not exist|do not have access/i.test(text)) {
    return { cause: "model_unavailable", advice: "키는 유효하지만 이 모델을 쓸 수 없다. 허용된 모델명을 AI_SUMMARY_LUNA_MODEL/TERRA_MODEL로 지정한다." };
  }
  if (status === 429 || /quota|rate limit/i.test(text)) {
    return { cause: "rate_or_quota", advice: "인증은 통과했고 한도에 걸렸다. 잔여 크레딧과 분당 한도를 확인한다." };
  }
  if (status === 400 && /schema|response_format|json_schema|verbosity|reasoning/i.test(text)) {
    return { cause: "unsupported_request_shape", advice: "인증은 통과했으나 이 모델이 strict json_schema 또는 reasoning 옵션을 지원하지 않는다." };
  }
  if (status === 0) {
    return { cause: "network", advice: "요청 자체가 나가지 못했다. 프록시와 사내망 차단을 확인한다." };
  }
  return { cause: "unknown", advice: "위 분류에 없는 응답이다. 아래 raw 메시지를 확인한다." };
}

async function listModels(apiKey) {
  const response = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ok: false, status: response.status, message: body.error?.message || response.statusText, ids: [] };
  }
  return { ok: true, status: response.status, ids: (body.data || []).map((item) => item.id) };
}

// 운영 코드와 같은 요청 형태를 쓴다. 여기서 통과하면 요약 단계가 형태 때문에 실패하지는 않는다.
async function probeResponses(apiKey, model, args) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      store: false,
      reasoning: { effort: args.reasoningEffort },
      max_output_tokens: args.maxOutputTokens,
      input: [
        { role: "system", content: [{ type: "input_text", text: "정상 동작 확인용이다. ok는 true, note는 'ready'로 답한다." }] },
        { role: "user", content: [{ type: "input_text", text: "확인" }] },
      ],
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "access_check",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: { ok: { type: "boolean" }, note: { type: "string" } },
            required: ["ok", "note"],
          },
        },
      },
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ok: false, status: response.status, message: body.error?.message || response.statusText };
  }
  return {
    ok: true,
    status: response.status,
    responseStatus: body.status || "unknown",
    outputTokens: body.usage?.output_tokens ?? null,
    totalTokens: body.usage?.total_tokens ?? null,
  };
}

// 실행 로그 다운로드는 저장소 admin 권한이 필요하다. 진단이 로그 안에만 있으면 권한 없는
// 사람은 exit code 1만 보게 되므로, 같은 내용을 실행 요약 페이지에도 남긴다.
function writeStepSummary(lines) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) return;
  try {
    fs.appendFileSync(target, `## OpenAI 접근 점검\n\n\`\`\`text\n${lines.join("\n")}\n\`\`\`\n`, "utf8");
  } catch {
    // 요약 기록 실패가 점검 결과를 뒤집지는 않는다.
  }
}

async function runCheck(report) {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    report("OPENAI_API_KEY: 미설정");
    report("이 환경에 키가 없다. GitHub secret 또는 로컬 환경변수를 먼저 등록한다.");
    process.exitCode = 1;
    return;
  }
  // 값은 절대 출력하지 않는다. 자리 확인용으로 길이만 남긴다.
  report(`OPENAI_API_KEY: 설정됨 (길이 ${apiKey.length})`);

  const models = await listModels(apiKey).catch((error) => ({ ok: false, status: 0, message: error.message, ids: [] }));
  if (!models.ok) {
    const { cause, advice } = classifyFailure(models.status, models.message);
    report(`모델 목록 조회 실패: HTTP ${models.status} (${cause})`);
    report(`  ${advice}`);
    report(`  raw: ${models.message}`);
    process.exitCode = 1;
    return;
  }
  report(`모델 목록 조회: 성공 (${models.ids.length}개 접근 가능)`);

  const wanted = [args.lunaModel, args.terraModel];
  for (const model of wanted) {
    report(`  ${model}: ${models.ids.includes(model) ? "목록에 있음" : "목록에 없음"}`);
  }

  // 실제 호출은 1차 모델 한 번만 한다. 목록에 없더라도 호출은 시도해 원인을 확정한다.
  const probe = await probeResponses(apiKey, args.lunaModel, args).catch((error) => ({
    ok: false,
    status: 0,
    message: error.message,
  }));
  if (!probe.ok) {
    const { cause, advice } = classifyFailure(probe.status, probe.message);
    report(`응답 호출 실패: HTTP ${probe.status} (${cause})`);
    report(`  ${advice}`);
    report(`  raw: ${probe.message}`);
    process.exitCode = 1;
    return;
  }

  report(`응답 호출: 성공 (status=${probe.responseStatus}, output_tokens=${probe.outputTokens}, total_tokens=${probe.totalTokens})`);
  const missing = wanted.filter((model) => !models.ids.includes(model));
  if (missing.length) {
    report(`주의: ${missing.join(", ")}이(가) 모델 목록에 없다. 요약 단계가 이 모델에서 막힐 수 있다.`);
  }
  report("결론: 이 키로 수집 파이프라인의 AI 요약 경로를 쓸 수 있다.");
}

async function main() {
  const lines = [];
  const report = (line) => {
    lines.push(line);
    console.log(line);
  };
  try {
    await runCheck(report);
  } catch (error) {
    report(`점검 중 예외: ${error.message}`);
    process.exitCode = 1;
  } finally {
    writeStepSummary(lines);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
