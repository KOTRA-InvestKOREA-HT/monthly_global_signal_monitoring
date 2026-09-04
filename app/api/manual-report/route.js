export const dynamic = "force-dynamic";

// API 키 없이 보고서를 만드는 경로의 웹 배선.
//
//   action=prepare  수집 + 브리프 생성 워크플로를 실행한다.
//   action=build    붙여넣은 판정을 저장소에 올린 뒤 PDF 생성 워크플로를 실행한다.
//
// 판정 본문은 5만 자가 넘어 workflow_dispatch 입력으로 보내기에 크다. 그래서 파일로 먼저
// 커밋하고 워크플로는 그 파일을 읽는다. trigger-crawl과 같은 환경변수를 쓴다.

const REQUIRED_ENV_KEYS = ["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO"];
const REPLY_PATH = "outputs/manual_summary/responses/reply.json";
const PREPARE_WORKFLOW = "prepare-report-brief.yml";
const BUILD_WORKFLOW = "build-report-from-brief.yml";

function envValue(name, fallback = "") {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return fallback;
  // Vercel 환경변수에 줄바꿈/공백/따옴표가 섞여 들어가는 실수가 잦아 여기서 정리한다.
  return String(raw).trim().replace(/^["']|["']$/g, "");
}

function collectEnv() {
  const config = {
    token: envValue("GITHUB_TOKEN"),
    owner: envValue("GITHUB_OWNER"),
    repo: envValue("GITHUB_REPO"),
    ref: envValue("GITHUB_MANUAL_REF", envValue("GITHUB_REF", "main")),
  };
  return { config, missing: REQUIRED_ENV_KEYS.filter((key) => !envValue(key)) };
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

// 팀원이 읽고 스스로 고칠 수 있는 문장으로 바꾼다. 상태코드만 보여주면 막힌다.
// 어느 단계에서 거부됐는지(파일 저장 / 실행 요청) 함께 알려야 어느 권한을 손볼지 알 수 있다.
const NEEDED_PERMISSION = {
  upload: "저장소 내용 쓰기(Contents: Read and write)",
  dispatch: "워크플로 실행(Actions: Read and write)",
};

function githubMessage(detail) {
  try {
    const parsed = JSON.parse(detail);
    return parsed.message || "";
  } catch {
    return "";
  }
}

function humanHint(status, config, stage = "dispatch", detail = "") {
  const what = stage === "upload" ? "답변 파일을 저장하는 중" : "워크플로를 실행하는 중";
  const message = githubMessage(detail);
  const suffix = message ? ` GitHub 응답: "${message}"` : "";
  if (status === 401) return `${what} GitHub 토큰이 거부됐습니다. 토큰이 만료되었을 수 있습니다.${suffix}`;
  if (status === 403) {
    return [
      `${what} 권한이 거부됐습니다.`,
      `이 단계에는 ${NEEDED_PERMISSION[stage]} 권한이 필요합니다.`,
      `대상: ${config.owner}/${config.repo} · 브랜치 ${config.ref}.`,
      "조직 저장소면 토큰의 SSO 승인 여부도 확인해 주세요.",
      suffix,
    ].join(" ");
  }
  if (status === 404) {
    return `${what} 대상을 찾지 못했습니다(${config.owner}/${config.repo} · ${config.ref}).${suffix}`;
  }
  if (status === 422) return `${what} GitHub이 요청을 거부했습니다.${suffix}`;
  return `${what} GitHub이 ${status} 응답을 반환했습니다.${suffix}`;
}

async function dispatchWorkflow(config, workflowFile, inputs = {}) {
  const response = await fetch(
    `https://api.github.com/repos/${config.owner}/${config.repo}/actions/workflows/${workflowFile}/dispatches`,
    {
      method: "POST",
      headers: githubHeaders(config.token),
      body: JSON.stringify({ ref: config.ref, inputs }),
    },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return { ok: false, status: response.status, detail };
  }
  return { ok: true };
}

// 같은 경로에 이미 파일이 있으면 sha를 함께 보내야 덮어쓸 수 있다.
async function existingFileSha(config, path) {
  const response = await fetch(
    `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${path}?ref=${encodeURIComponent(config.ref)}`,
    { headers: githubHeaders(config.token) },
  );
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  return body?.sha || null;
}

async function putReply(config, content) {
  const sha = await existingFileSha(config, REPLY_PATH);
  const response = await fetch(`https://api.github.com/repos/${config.owner}/${config.repo}/contents/${REPLY_PATH}`, {
    method: "PUT",
    headers: githubHeaders(config.token),
    body: JSON.stringify({
      message: "Add the pasted evaluation for the manual report",
      content: Buffer.from(content, "utf8").toString("base64"),
      branch: config.ref,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return { ok: false, status: response.status, detail };
  }
  return { ok: true };
}

// 붙여넣은 내용이 판정 결과처럼 보이는지 본다. 세부 검증은 병합 단계가 fail-closed로 한다.
//
// 가장 흔한 실수는 요청서를 그대로 다시 붙여넣는 것이다. 요청서 안에 출력 형식 예시가 들어
// 있어서 ref와 대괄호만 보고는 통과해버리므로, 요청서 고유의 문구로 먼저 걸러낸다.
const BRIEF_MARKERS = ["월간 글로벌 투자시그널 판정 요청", "## 판정 규칙", "판정 대상:"];

export function looksLikeEvaluation(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return { ok: false, message: "붙여넣은 내용이 없습니다. 채팅 답변을 붙여넣어 주세요." };

  if (BRIEF_MARKERS.some((marker) => trimmed.includes(marker))) {
    return {
      ok: false,
      message:
        "요청서를 그대로 붙여넣으신 것 같습니다. 2단계에서 복사한 요청서를 ChatGPT나 Claude 대화창에 먼저 넣고, " +
        "거기서 나온 답변(JSON)을 여기에 붙여넣어 주세요.",
    };
  }

  const refCount = (trimmed.match(/"ref"/g) || []).length;
  if (!refCount || !trimmed.includes("[")) {
    return { ok: false, message: "판정 결과로 보이지 않습니다. 채팅이 답한 JSON 부분을 통째로 붙여넣어 주세요." };
  }
  if (!trimmed.includes("]")) {
    return {
      ok: false,
      message: '답변이 중간에 끊긴 것 같습니다. 채팅에 "계속"이라고 입력한 뒤, 이어서 나온 내용까지 함께 붙여넣어 주세요.',
    };
  }
  // 판정 대상은 100건이 넘는다. 몇 건뿐이면 답변의 일부만 가져온 것이다.
  if (refCount < 20) {
    return {
      ok: false,
      message: `판정이 ${refCount}건뿐입니다. 답변 전체를 붙여넣었는지, 끊겼다면 "계속"으로 받은 뒷부분까지 넣었는지 확인해 주세요.`,
    };
  }
  return { ok: true };
}

// 진행 상황을 화면에 보여주기 위한 조회. 버튼만 있고 상태가 없으면 사용자는 눌렸는지조차
// 알 수 없어 계속 다시 누르게 되고, 그러면 실행이 서로를 취소한다.
const STEP_LABELS = [
  [/collect_company_signals/, "기업 자료 수집 중"],
  [/filter_relevant_signals/, "기술 관련성 확인 중"],
  [/classify_investment_signals/, "투자 시그널 분류 중"],
  [/Clear replies/, "이전 회차 정리 중"],
  [/build_report_brief/, "요청서 만드는 중"],
  [/Merge the pasted|merge_summary_batches/, "판정 반영 중"],
  [/Validate|validate_report_inputs/, "판정 검증 중"],
  [/English/, "영문 보고서 만드는 중"],
  [/build_pdf_report/, "한글 보고서 만드는 중"],
  [/auto-commit|Sync latest/, "결과 저장 중"],
];

function describeStep(name) {
  for (const [pattern, label] of STEP_LABELS) {
    if (pattern.test(name)) return label;
  }
  return "진행 중";
}

// GitHub이 느릴 때 화면 전체가 그만큼 멈추지 않도록 상한을 둔다. 상태 조회는 못 해도
// 페이지는 계속 동작해야 한다.
async function getJson(url, token, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: githubHeaders(token), cache: "no-store", signal: controller.signal });
    if (!response.ok) return null;
    return await response.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function latestRun(config, workflowFile) {
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/actions/workflows/${workflowFile}/runs?branch=${encodeURIComponent(config.ref)}&per_page=1`;
  const run = (await getJson(url, config.token))?.workflow_runs?.[0];
  if (!run) return null;

  const state =
    run.status !== "completed"
      ? "running"
      : run.conclusion === "success"
        ? "success"
        : run.conclusion === "cancelled"
          ? "cancelled"
          : "failed";
  const summary = { state, startedAt: run.run_started_at || run.created_at, updatedAt: run.updated_at, url: run.html_url, step: "" };

  // 단계 이름은 실행 중일 때만 필요하다. 끝난 실행까지 조회하면 왕복이 두 배가 된다.
  if (state === "running") {
    const jobs = await getJson(
      `https://api.github.com/repos/${config.owner}/${config.repo}/actions/runs/${run.id}/jobs`,
      config.token,
    );
    const current = jobs?.jobs?.[0]?.steps?.find((step) => step.status === "in_progress");
    summary.step = current ? describeStep(current.name) : "시작하는 중";
  }
  return summary;
}

// Vercel 환경변수는 배포 시점에 주입된다. 값을 추가하거나 적용 환경을 바꿔도 이미 만들어진
// 배포에는 반영되지 않으므로, 값이 비어 보이면 재배포가 필요한 경우가 대부분이다.
function envHint(missing) {
  const where = process.env.VERCEL_ENV ? `현재 배포 환경: ${process.env.VERCEL_ENV}` : "로컬 실행";
  return [
    `서버 설정을 읽지 못했습니다(${missing.join(", ")}).`,
    `${where}.`,
    "Vercel Settings → Environment Variables에서 이 환경에도 값이 켜져 있는지 확인하고,",
    "값을 추가·변경했다면 반드시 재배포해야 적용됩니다. 기존 배포에는 반영되지 않습니다.",
  ].join(" ");
}

export async function GET() {
  const { config, missing } = collectEnv();
  if (missing.length) {
    return Response.json({ error: envHint(missing) }, { status: 500 });
  }
  // 이 응답이 늦으면 화면은 "진행 상황 확인 중…"에 머문다. 느릴 때 원인이 GitHub 왕복인지
  // 함수 콜드스타트인지 브라우저에서 바로 구분할 수 있도록 걸린 시간을 헤더로 남긴다.
  const startedAt = Date.now();
  const [prepare, build] = await Promise.all([
    latestRun(config, PREPARE_WORKFLOW).catch(() => null),
    latestRun(config, BUILD_WORKFLOW).catch(() => null),
  ]);
  return Response.json(
    { prepare, build },
    { headers: { "Server-Timing": `github;desc="workflow status";dur=${Date.now() - startedAt}` } },
  );
}

// 병합은 워크플로에서 fail-closed로 다시 검사하지만, 빠진 항목은 여기서 미리 잡는다.
// 2분 기다렸다가 실패 로그를 열어보게 하는 대신 누른 자리에서 어떤 ref가 없는지 알려준다.
async function manifestRefs(config) {
  const body = await getJson(
    `https://api.github.com/repos/${config.owner}/${config.repo}/contents/outputs/manual_summary/manifest.json?ref=${encodeURIComponent(config.ref)}`,
    config.token,
    6000,
  );
  if (!body?.content) return null;
  try {
    const manifest = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
    return Array.isArray(manifest?.rows) ? manifest.rows.map((row) => row.ref) : null;
  } catch {
    return null;
  }
}

export function compareRefs(expected, reply) {
  const seen = new Map();
  for (const match of String(reply).matchAll(/"ref"\s*:\s*"([^"]+)"/g)) {
    seen.set(match[1], (seen.get(match[1]) || 0) + 1);
  }
  const expectedSet = new Set(expected);
  return {
    missing: expected.filter((ref) => !seen.has(ref)),
    unknown: [...seen.keys()].filter((ref) => !expectedSet.has(ref)),
    duplicated: [...seen.entries()].filter(([, count]) => count > 1).map(([ref]) => ref),
  };
}

function refProblemMessage({ missing, unknown, duplicated }) {
  const list = (refs) => refs.slice(0, 12).join(", ") + (refs.length > 12 ? ` 외 ${refs.length - 12}건` : "");
  if (missing.length) {
    return [
      `판정 ${missing.length}건이 빠졌습니다: ${list(missing)}.`,
      "대화창에 이 번호를 알려주고 해당 항목만 같은 형식으로 더 받은 뒤,",
      "받은 내용을 지금 붙여넣은 것 뒤에 이어붙여서 다시 눌러 주세요.",
    ].join(" ");
  }
  if (duplicated.length) return `같은 번호가 두 번 있습니다: ${list(duplicated)}. 중복된 쪽을 지우고 다시 눌러 주세요.`;
  if (unknown.length) {
    return `자료에 없는 번호가 들어 있습니다: ${list(unknown)}. 답변을 다시 받아 주세요.`;
  }
  return "";
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const action = body.action === "build" ? "build" : "prepare";
    const { config, missing } = collectEnv();
    if (missing.length) return Response.json({ error: envHint(missing) }, { status: 500 });

    if (action === "prepare") {
      const result = await dispatchWorkflow(config, PREPARE_WORKFLOW, {
        from_date: typeof body.fromDate === "string" ? body.fromDate : "",
        to_date: typeof body.toDate === "string" ? body.toDate : "",
        max_article_chars: String(body.maxArticleChars || "900"),
      });
      if (!result.ok) return Response.json({ error: humanHint(result.status, config, "dispatch", result.detail) }, { status: 502 });
      return Response.json({
        status: "started",
        message: "자료를 준비하고 있습니다. 5~10분 뒤에 아래 자료 받기 버튼이 열립니다.",
      });
    }

    const check = looksLikeEvaluation(body.reply);
    if (!check.ok) return Response.json({ error: check.message }, { status: 400 });

    // manifest를 못 읽으면 그냥 넘어간다. 병합 단계가 어차피 같은 검사를 다시 한다.
    const expected = await manifestRefs(config).catch(() => null);
    if (expected?.length) {
      const problem = refProblemMessage(compareRefs(expected, body.reply));
      if (problem) return Response.json({ error: problem }, { status: 400 });
    }

    const uploaded = await putReply(config, String(body.reply));
    if (!uploaded.ok) return Response.json({ error: humanHint(uploaded.status, config, "upload", uploaded.detail) }, { status: 502 });

    const started = await dispatchWorkflow(config, BUILD_WORKFLOW);
    if (!started.ok) return Response.json({ error: humanHint(started.status, config, "dispatch", started.detail) }, { status: 502 });

    return Response.json({
      status: "started",
      message: "보고서를 만들고 있습니다. 2~3분 뒤에 보고서 받기 버튼을 눌러 주세요.",
    });
  } catch (error) {
    return Response.json({ error: `요청을 처리하지 못했습니다: ${error.message}` }, { status: 500 });
  }
}
