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
function humanHint(status, config) {
  if (status === 401) return "GitHub 토큰이 만료되었습니다. 관리자에게 Vercel의 GITHUB_TOKEN 교체를 요청해 주세요.";
  if (status === 403) return "GitHub 토큰 권한이 부족합니다. 관리자에게 Actions 쓰기 권한 확인을 요청해 주세요.";
  if (status === 404) {
    return `워크플로 또는 브랜치를 찾지 못했습니다(${config.owner}/${config.repo} · ${config.ref}). 관리자에게 문의해 주세요.`;
  }
  if (status === 422) return "GitHub이 요청을 거부했습니다. 잠시 후 다시 시도해 주세요.";
  return `GitHub이 ${status} 응답을 반환했습니다. 잠시 후 다시 시도해 주세요.`;
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

// 붙여넣은 내용이 판정 결과처럼 보이는지만 본다. 세부 검증은 병합 단계가 fail-closed로 한다.
export function looksLikeEvaluation(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return { ok: false, message: "붙여넣은 내용이 없습니다. 채팅 답변을 붙여넣어 주세요." };
  if (!/\bref\b/.test(trimmed) || !trimmed.includes("[")) {
    return { ok: false, message: "판정 결과로 보이지 않습니다. 채팅이 답한 JSON 부분을 통째로 붙여넣어 주세요." };
  }
  if (!trimmed.includes("]")) {
    return {
      ok: false,
      message: '답변이 중간에 끊긴 것 같습니다. 채팅에 "계속"이라고 입력한 뒤, 이어서 나온 내용까지 함께 붙여넣어 주세요.',
    };
  }
  return { ok: true };
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const action = body.action === "build" ? "build" : "prepare";
    const { config, missing } = collectEnv();
    if (missing.length) {
      return Response.json(
        { error: `서버 설정이 끝나지 않았습니다(${missing.join(", ")}). 관리자에게 문의해 주세요.` },
        { status: 500 },
      );
    }

    if (action === "prepare") {
      const result = await dispatchWorkflow(config, PREPARE_WORKFLOW, {
        from_date: typeof body.fromDate === "string" ? body.fromDate : "",
        to_date: typeof body.toDate === "string" ? body.toDate : "",
        max_article_chars: String(body.maxArticleChars || "900"),
      });
      if (!result.ok) return Response.json({ error: humanHint(result.status, config) }, { status: 502 });
      return Response.json({
        status: "started",
        message: "자료를 준비하고 있습니다. 5~10분 뒤에 아래 자료 받기 버튼이 열립니다.",
      });
    }

    const check = looksLikeEvaluation(body.reply);
    if (!check.ok) return Response.json({ error: check.message }, { status: 400 });

    const uploaded = await putReply(config, String(body.reply));
    if (!uploaded.ok) return Response.json({ error: humanHint(uploaded.status, config) }, { status: 502 });

    const started = await dispatchWorkflow(config, BUILD_WORKFLOW);
    if (!started.ok) return Response.json({ error: humanHint(started.status, config) }, { status: 502 });

    return Response.json({
      status: "started",
      message: "보고서를 만들고 있습니다. 2~3분 뒤에 보고서 받기 버튼을 눌러 주세요.",
    });
  } catch (error) {
    return Response.json({ error: `요청을 처리하지 못했습니다: ${error.message}` }, { status: 500 });
  }
}
