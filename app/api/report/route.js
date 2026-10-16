import fs from "node:fs/promises";
import path from "node:path";
import { dataRangeProblem } from "../../lib/date_range.mjs";
import { internalRequestHeaders, protectionError, viewModelOrigin } from "../../lib/internal_request.mjs";
import { publicError, viewModelFromPython } from "../../lib/python_view_model.mjs";
import { reportOptions } from "../../lib/report_request.mjs";
import { browserLaunchOptions, printReportPdf } from "../../lib/report_pdf.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Chromium 을 띄워 품목 카드를 한 번 재고 다시 그려 인쇄한다. 콜드 스타트에는 기본 제한 시간이 빠듯하다.
export const maxDuration = 60;

function pdfResponse(output, issue, lang) {
  return new Response(output, { headers: {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="global-signal-monitor-issue-${issue}${lang === "en" ? "-en" : ""}.pdf"`,
    "Cache-Control": "no-store",
  } });
}

async function viewModelFromFunction(requestUrl, { issue, ignored, fromDate, toDate, lang }, incomingHeaders) {
  const endpoint = new URL("/api/report-view-model", viewModelOrigin(requestUrl));
  endpoint.searchParams.set("issue", issue);
  endpoint.searchParams.set("lang", lang);
  if (ignored.length) endpoint.searchParams.set("ignored", ignored.join(","));
  if (fromDate) endpoint.searchParams.set("from", fromDate);
  if (toDate) endpoint.searchParams.set("to", toDate);

  // 배포 보호를 통과하도록 사용자의 쿠키를 넘긴다. 막히면 로그인 화면으로 넘어가지 않고 그 응답을 그대로 본다.
  const response = await fetch(endpoint, { cache: "no-store", redirect: "manual", headers: internalRequestHeaders(incomingHeaders) });
  const body = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(body);
  } catch {
    // JSON 이 아니면 아래에서 오류로 돌려준다.
  }
  // Python 함수의 400(호수·기간·데이터 범위)은 그대로 사용자에게 돌려준다.
  if (response.status === 400 && payload?.error) throw publicError(payload.error, 400);
  if (!response.ok || !payload) {
    const blocked = protectionError(response.status, body);
    if (blocked) throw publicError(blocked);
    // Python 함수는 자세한 내용을 자기 로그에 남기고 일반 문구만 돌려준다.
    if (payload?.error) throw publicError(payload.error);
    throw new Error(`Vercel Python 보고서 함수 호출 실패 (HTTP ${response.status}): ${body.slice(0, 500)}`);
  }
  return payload;
}

async function reportViewModel(requestUrl, options, incomingHeaders) {
  // Vercel 에는 전용 Python 함수가 있다. Node 함수에서 로컬 해석기를 찾거나 Python 입력을 싣지 않는다.
  if (process.env.VERCEL === "1") return viewModelFromFunction(requestUrl, options, incomingHeaders);
  try {
    return await viewModelFromPython(options);
  } catch (error) {
    // vercel dev 처럼 로컬 Python 이 없고 Python 함수는 떠 있는 경우.
    if (!error.noInterpreter) throw error;
    try {
      return await viewModelFromFunction(requestUrl, options, incomingHeaders);
    } catch (functionError) {
      throw new Error(`${error.message} | ${functionError.message}`);
    }
  }
}

// 로컬·자체 호스팅에서만 쓴다. Vercel 의 Node 함수에는 outputs 가 실리지 않으므로 Python 함수가 같은 검사를 한다.
async function localDataRangeProblem({ fromDate, toDate }) {
  if (process.env.VERCEL === "1" || !fromDate) return null;
  let summary;
  try {
    summary = JSON.parse(await fs.readFile(path.join(process.cwd(), "outputs", "latest_collection_summary.json"), "utf8"));
  } catch {
    return null;
  }
  return dataRangeProblem(fromDate, toDate, summary?.from_date, summary?.to_date);
}

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const { options, error: invalid } = reportOptions(url.searchParams);
    if (invalid) return Response.json({ error: invalid }, { status: 400 });
    const outside = await localDataRangeProblem(options);
    if (outside) return Response.json({ error: outside }, { status: 400 });
    const model = await reportViewModel(url, options, request.headers);
    const { default: puppeteer } = await import("puppeteer-core");
    const output = await printReportPdf(model, {
      puppeteer,
      launch: await browserLaunchOptions(puppeteer),
      assetsDir: path.join(process.cwd(), "assets"),
    });
    return pdfResponse(output, options.issue, options.lang);
  } catch (error) {
    if (error.expose) return Response.json({ error: error.message }, { status: error.status || 500 });
    // stderr 와 파일 경로가 들어 있을 수 있다. 화면에는 일반 문구만 보낸다.
    console.error("[api/report]", error);
    return Response.json({ error: "보고서를 만들지 못했습니다. 서버 로그를 확인해 주세요." }, { status: 500 });
  }
}
