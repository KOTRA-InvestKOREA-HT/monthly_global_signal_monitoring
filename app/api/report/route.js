import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb } from "pdf-lib";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function issueNumber(value) {
  return String(value || "2").replace(/[^\d]/g, "") || "2";
}

function ignoredSignalKeys(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function pythonCandidates() {
  const localCodexPython = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe")
    : "";
  return [process.env.PYTHON_PATH, localCodexPython, "python3", "python"].filter(Boolean);
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
      reject(new Error("보고서 생성 시간이 초과되었습니다."));
    }, 45000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error((stderr || stdout || `Python exited with code ${code}`).trim()));
    });
  });
}

async function buildReportWithIgnoredSignals(issue, ignored) {
  const outPath = path.join(tmpdir(), `global-signal-report-${randomUUID()}.pdf`);
  const args = [
    "scripts/build_pdf_report.py",
    "--signals",
    "outputs/latest_company_signals.json",
    "--summary",
    "outputs/latest_collection_summary.json",
    "--relevant",
    "outputs/latest_relevant_signals.json",
    "--relevance-summary",
    "outputs/latest_relevance_summary.json",
    "--investment-signals",
    "outputs/latest_investment_signals.json",
    "--investment-summary",
    "outputs/latest_investment_signal_summary.json",
    "--indicator-config",
    "config/investment_signal_indicators.json",
    "--font",
    "assets/fonts/NOTOSANSKR-VF.TTF",
    "--issue-number",
    issue,
    "--ignored-signals",
    ignored.join(","),
    "--out",
    outPath,
  ];

  let lastError = null;
  for (const command of pythonCandidates()) {
    try {
      await runPython(command, args);
      const output = await fs.readFile(outPath);
      await fs.rm(outPath, { force: true });
      return output;
    } catch (error) {
      lastError = error;
    }
  }
  await fs.rm(outPath, { force: true });
  throw new Error(`무시 항목을 반영한 보고서 생성에 실패했습니다. ${lastError?.message || ""}`.trim());
}

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const issue = issueNumber(url.searchParams.get("issue"));
    const ignored = ignoredSignalKeys(url.searchParams.get("ignored"));
    const sourcePath = path.join(process.cwd(), "public", "reports", "latest_report.pdf");
    const fontDir = path.join(process.cwd(), "assets", "fonts");
    const semiBoldPath = path.join(fontDir, "NotoSansKR-SemiBold.ttf");
    const demiLightPath = path.join(fontDir, "NotoSansKR-DemiLight.ttf");
    const [sourceBytes, semiBoldBytes, demiLightBytes] = await Promise.all([
      ignored.length ? buildReportWithIgnoredSignals(issue, ignored) : fs.readFile(sourcePath),
      fs.readFile(semiBoldPath),
      fs.readFile(demiLightPath),
    ]);

    const pdf = await PDFDocument.load(sourceBytes);
    pdf.registerFontkit(fontkit);
    const issueFont = await pdf.embedFont(semiBoldBytes, { subset: false });
    const bodyFont = await pdf.embedFont(demiLightBytes, { subset: false });
    const pages = pdf.getPages();
    const navy = rgb(0x12 / 255, 0x28 / 255, 0x44 / 255);
    const muted = rgb(0x85 / 255, 0x91 / 255, 0xa3 / 255);
    const footerBg = rgb(0xef / 255, 0xf4 / 255, 0xf8 / 255);
    const issueText = `Issue ${issue}`;

    if (pages[0]) {
      const { width, height } = pages[0].getSize();
      pages[0].drawRectangle({
        x: width - 166,
        y: height - 68,
        width: 124,
        height: 30,
        color: navy,
      });
      pages[0].drawText(issueText, {
        x: width - 112,
        y: height - 58,
        size: 18,
        font: issueFont,
        color: rgb(1, 1, 1),
      });
    }

    for (const page of pages.slice(1)) {
      page.drawRectangle({
        x: 38,
        y: 8,
        width: 312,
        height: 18,
        color: footerBg,
      });
      page.drawText(`Invest KOREA · 타겟기업 글로벌 투자시그널 모니터링 · ${issueText}`, {
        x: 42,
        y: 16,
        size: 8,
        font: bodyFont,
        color: muted,
      });
    }

    const output = await pdf.save();
    return new Response(output, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="global-signal-monitor-issue-${issue}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
