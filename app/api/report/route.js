import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { dateParam } from "../../lib/date_range.mjs";
import { browserLaunchOptions, printReportPdf } from "../../lib/report_pdf.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Chromium 을 띄워 품목 카드를 한 번 재고 다시 그려 인쇄한다. 콜드 스타트에는 기본 제한 시간이 빠듯하다.
export const maxDuration = 60;

function issueNumber(value) {
  return String(value || "2").replace(/[^\d]/g, "") || "2";
}

function ignoredSignalKeys(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function langParam(value) {
  return String(value || "").trim().toLowerCase() === "en" ? "en" : "ko";
}

function pdfResponse(output, issue, lang) {
  return new Response(output, { headers: {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="global-signal-monitor-issue-${issue}${lang === "en" ? "-en" : ""}.pdf"`,
    "Cache-Control": "no-store",
  } });
}

function pythonCandidates() {
  const localCodexPython = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe")
    : "";
  return [
    process.env.PYTHON_PATH,
    process.env.PYTHON,
    localCodexPython,
    "/usr/local/bin/python3",
    "/usr/bin/python3",
    "python3",
    "py",
    "python",
  ]
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index);
}

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
      reject(new Error("보고서 내용 계산 시간이 초과되었습니다."));
    }, 45000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`${command}: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`${command}: ${(stderr || stdout || `Python exited with code ${code}`).trim()}`));
    });
  });
}

// 보고서에 무엇을 싣는지(기간·무시한 시그널·기업 상태·문안)는 Python 이 계산한다. 글자 폭 측정이
// reportlab 에 있어서다. Vercel 에서는 api/report-view-model.py 가, 로컬에서는 같은 스크립트가 맡는다.
async function viewModelFromPython({ issue, ignored, fromDate, toDate, lang }) {
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
    for (const command of pythonCandidates()) {
      try {
        await runPython(command, args);
        return JSON.parse(await fs.readFile(outPath, "utf8"));
      } catch (error) {
        errors.push(error.message);
      }
    }
  } finally {
    await fs.rm(outPath, { force: true });
  }
  throw new Error(`보고서 내용을 계산하지 못했습니다. ${errors.join(" | ")}`.trim());
}

async function viewModelFromFunction(requestUrl, { issue, ignored, fromDate, toDate, lang }) {
  const endpoint = new URL("/api/report-view-model", requestUrl.origin);
  endpoint.searchParams.set("issue", issue);
  endpoint.searchParams.set("lang", lang);
  if (ignored.length) endpoint.searchParams.set("ignored", ignored.join(","));
  if (fromDate) endpoint.searchParams.set("from", fromDate);
  if (toDate) endpoint.searchParams.set("to", toDate);

  const response = await fetch(endpoint, { cache: "no-store" });
  const body = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(body);
  } catch {
    // JSON 이 아니면 아래에서 본문을 오류로 돌려준다.
  }
  if (!response.ok || !payload) {
    throw new Error(payload?.error || body || "Vercel Python 보고서 함수 호출에 실패했습니다.");
  }
  return payload;
}

async function reportViewModel(requestUrl, options) {
  // Vercel 에는 전용 Python 함수가 있다. Node 함수에서 로컬 해석기를 찾거나 Python 입력을 싣지 않는다.
  if (process.env.VERCEL === "1") return viewModelFromFunction(requestUrl, options);
  try {
    return await viewModelFromPython(options);
  } catch (error) {
    // vercel dev 처럼 로컬 Python 이 없고 Python 함수는 떠 있는 경우.
    if (!/ENOENT/i.test(error.message || "")) throw error;
    try {
      return await viewModelFromFunction(requestUrl, options);
    } catch (functionError) {
      throw new Error(`${error.message} | ${functionError.message}`);
    }
  }
}

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const options = {
      issue: issueNumber(url.searchParams.get("issue")),
      ignored: ignoredSignalKeys(url.searchParams.get("ignored")),
      fromDate: dateParam(url.searchParams.get("from")),
      toDate: dateParam(url.searchParams.get("to")),
      lang: langParam(url.searchParams.get("lang")),
    };
    const model = await reportViewModel(url, options);
    const { default: puppeteer } = await import("puppeteer-core");
    const output = await printReportPdf(model, {
      puppeteer,
      launch: await browserLaunchOptions(puppeteer),
      assetsDir: path.join(process.cwd(), "assets"),
    });
    return pdfResponse(output, options.issue, options.lang);
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
