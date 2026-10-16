// 로컬·자체 호스팅에서 보고서 내용(view model)을 Python 으로 계산한다. Vercel 에서는 api/report-view-model.py 가 맡는다.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// 사용자에게 보여도 되는 오류. 나머지(Python 의 stderr, 파일 경로 등)는 서버 로그에만 남긴다.
export function publicError(message, status = 500) {
  return Object.assign(new Error(message), { expose: true, status });
}

// reportlab 이 깔린 해석기를 PYTHON_PATH 로 지정한다. 개인 PC 경로는 넣지 않는다.
export function pythonCandidates(env = process.env) {
  return [
    env.PYTHON_PATH,
    env.PYTHON,
    "/usr/local/bin/python3",
    "/usr/bin/python3",
    "python3",
    "py",
    "python",
  ]
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index);
}

// 해석기가 없거나(ENOENT) 필요한 패키지가 없는 해석기다. 이때만 다음 후보로 넘어간다.
// 보고서 계산 자체가 실패한 것이면 다른 해석기로 다시 돌려도 같은 오류가 나므로 바로 멈춘다.
const WRONG_INTERPRETER = /ModuleNotFoundError|No module named/;

function runPython(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(publicError("보고서 내용 계산 시간이 초과되었습니다."));
    }, 45000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`${command}: ${error.message}`), { missing: error.code === "ENOENT" }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const detail = (stderr || stdout || `Python exited with code ${code}`).trim();
      reject(Object.assign(new Error(`${command}: ${detail}`), { wrongInterpreter: WRONG_INTERPRETER.test(detail) }));
    });
  });
}

// 보고서에 무엇을 싣는지(기간·무시한 시그널·기업 상태·문안)는 Python 이 계산한다. 글자 폭 측정이
// reportlab 에 있어서다.
export async function viewModelFromPython({ issue, ignored, fromDate, toDate, lang }, { candidates = pythonCandidates(), run = runPython } = {}) {
  const outPath = path.join(tmpdir(), `global-signal-view-model-${randomUUID()}.json`);
  const args = [
    "-X", "utf8", "scripts/report_view_model.py",
    "--signals", "outputs/latest_company_signals.json",
    "--summary", "outputs/latest_collection_summary.json",
    "--relevant", "outputs/latest_relevant_signals.json",
    "--investment-signals", "outputs/latest_investment_signals.json",
    "--indicator-config", "config/investment_signal_indicators.json",
    "--font", "assets/fonts/PretendardJP-Regular.ttf",
    "--issue-number", issue,
    "--lang", lang,
    "--ignored-signals", ignored.join(","),
    ...(fromDate ? ["--from-date", fromDate] : []),
    ...(toDate ? ["--to-date", toDate] : []),
    "--out", outPath,
  ];
  const errors = [];
  try {
    for (const command of candidates) {
      try {
        await run(command, args);
        return JSON.parse(await fs.readFile(outPath, "utf8"));
      } catch (error) {
        if (!error.missing && !error.wrongInterpreter) throw error;
        errors.push(error);
      }
    }
  } finally {
    await fs.rm(outPath, { force: true });
  }
  // 모든 후보가 아예 없는 해석기였을 때만 noInterpreter 다. 그때는 Python 함수(vercel dev)로 넘어갈 수 있다.
  throw Object.assign(new Error(`보고서 내용을 계산할 Python 을 찾지 못했습니다. ${errors.map((error) => error.message).join(" | ")}`.trim()),
    { noInterpreter: errors.every((error) => error.missing) });
}
