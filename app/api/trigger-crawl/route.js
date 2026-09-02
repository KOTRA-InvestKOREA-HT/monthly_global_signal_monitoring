export const dynamic = "force-dynamic";

// GITHUB_WORKFLOW_FILE, GITHUB_REF는 기본값이 있어 필수 항목에서 제외한다.
const REQUIRED_ENV_KEYS = ["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO"];

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
    workflowFile: envValue("GITHUB_WORKFLOW_FILE", "collect-company-signals.yml"),
    ref: envValue("GITHUB_REF", "main"),
  };
  const missing = REQUIRED_ENV_KEYS.filter((key) => !envValue(key));
  return { config, missing };
}

function githubHeaders(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function failureHint(status, config) {
  const target = `${config.owner}/${config.repo} · ${config.workflowFile} · ${config.ref}`;
  if (status === 401) {
    return `GitHub 토큰이 만료되었거나 잘못되었습니다. Vercel의 GITHUB_TOKEN을 새 토큰으로 교체한 뒤 재배포해 주세요. (대상: ${target})`;
  }
  if (status === 403) {
    return `토큰 권한이 거부되었습니다. 토큰의 Actions 권한(Read and write)과 조직(SSO/토큰 승인) 설정을 확인해 주세요. (대상: ${target})`;
  }
  if (status === 404) {
    return `저장소·워크플로·브랜치를 찾지 못했습니다. GITHUB_OWNER/GITHUB_REPO/GITHUB_WORKFLOW_FILE/GITHUB_REF 값과 토큰의 해당 저장소 접근 권한을 확인해 주세요. (대상: ${target})`;
  }
  if (status === 422) {
    return `워크플로가 요청한 입력값을 받지 못했습니다. 워크플로의 workflow_dispatch inputs 정의를 확인해 주세요. (대상: ${target})`;
  }
  return `GitHub API가 ${status} 응답을 반환했습니다. (대상: ${target})`;
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function previousMonthRange() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const firstDay = new Date(Date.UTC(year, month - 1, 1));
  const lastDay = new Date(Date.UTC(year, month, 0));
  const format = (date) => date.toISOString().slice(0, 10);
  return { fromDate: format(firstDay), toDate: format(lastDay) };
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const days = String(body.days || envValue("DEFAULT_CRAWL_DAYS", "45"));
    const fallbackRange = previousMonthRange();
    const fromDate = isIsoDate(body.fromDate) ? body.fromDate : fallbackRange.fromDate;
    const toDate = isIsoDate(body.toDate) ? body.toDate : fallbackRange.toDate;
    const issueNumber = String(body.issueNumber || "2").replace(/[^\d]/g, "") || "2";

    const { config, missing } = collectEnv();
    if (missing.length) {
      return Response.json(
        {
          error: `Vercel 환경변수가 설정되지 않았습니다: ${missing.join(", ")}. Vercel 프로젝트 Settings → Environment Variables(Production)에 등록한 뒤 재배포해 주세요.`,
          missing,
        },
        { status: 500 },
      );
    }

    const response = await fetch(
      `https://api.github.com/repos/${config.owner}/${config.repo}/actions/workflows/${config.workflowFile}/dispatches`,
      {
        method: "POST",
        headers: { ...githubHeaders(config.token), "Content-Type": "application/json" },
        body: JSON.stringify({
          ref: config.ref,
          inputs: {
            days,
            from_date: fromDate,
            to_date: toDate,
            issue_number: issueNumber,
          },
        }),
      },
    );

    if (response.status !== 204) {
      const text = await response.text();
      let githubMessage = "";
      try {
        githubMessage = JSON.parse(text)?.message || "";
      } catch {
        githubMessage = text.slice(0, 200);
      }
      const hint = failureHint(response.status, config);
      return Response.json(
        {
          error: `GitHub Actions 실행 요청에 실패했습니다 (HTTP ${response.status}). ${hint}${
            githubMessage ? ` GitHub 응답: ${githubMessage}` : ""
          }`,
          status: response.status,
          hint,
          detail: githubMessage || text.slice(0, 500),
        },
        { status: 502 },
      );
    }

    return Response.json(
      {
        ok: true,
        days,
        fromDate,
        toDate,
        issueNumber,
        ref: config.ref,
        requested_at: new Date().toISOString(),
      },
      { status: 202 },
    );
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

// 진단용: 브라우저에서 /api/trigger-crawl 을 그대로 열면 어느 단계가 막혔는지 확인할 수 있다.
// 토큰 값 자체는 절대 노출하지 않고, 설정 여부와 GitHub 응답 코드만 보여 준다.
export async function GET() {
  const { config, missing } = collectEnv();
  const checks = {};

  const result = {
    env: {
      GITHUB_TOKEN: config.token ? `설정됨 (${config.token.length}자, ${config.token.slice(0, 4)}…)` : "없음",
      GITHUB_OWNER: config.owner || "없음",
      GITHUB_REPO: config.repo || "없음",
      GITHUB_WORKFLOW_FILE: config.workflowFile || "없음",
      GITHUB_REF: config.ref || "없음",
    },
    missing,
    checks,
  };

  if (missing.length) {
    result.conclusion = `Vercel 환경변수 누락: ${missing.join(", ")}. Production 환경에 등록한 뒤 재배포해야 합니다.`;
    return Response.json(result);
  }

  try {
    const [tokenRes, workflowRes] = await Promise.all([
      fetch("https://api.github.com/user", { headers: githubHeaders(config.token), cache: "no-store" }),
      fetch(
        `https://api.github.com/repos/${config.owner}/${config.repo}/actions/workflows/${config.workflowFile}`,
        { headers: githubHeaders(config.token), cache: "no-store" },
      ),
    ]);

    const tokenPayload = await tokenRes.json().catch(() => ({}));
    checks.token = {
      status: tokenRes.status,
      ok: tokenRes.ok,
      login: tokenRes.ok ? tokenPayload.login || null : null,
      message: tokenRes.ok ? null : tokenPayload.message || null,
    };

    const workflowPayload = await workflowRes.json().catch(() => ({}));
    checks.workflow = {
      status: workflowRes.status,
      ok: workflowRes.ok,
      state: workflowRes.ok ? workflowPayload.state || null : null,
      message: workflowRes.ok ? null : workflowPayload.message || null,
    };

    if (!tokenRes.ok) {
      result.conclusion = `GITHUB_TOKEN이 GitHub에서 거부되었습니다 (HTTP ${tokenRes.status}). ${failureHint(
        tokenRes.status,
        config,
      )}`;
    } else if (!workflowRes.ok) {
      result.conclusion = `토큰은 유효하지만 워크플로에 접근하지 못했습니다 (HTTP ${workflowRes.status}). ${failureHint(
        workflowRes.status,
        config,
      )}`;
    } else {
      result.conclusion = "환경변수와 토큰, 워크플로 접근이 모두 정상입니다. 크롤링 버튼 실패가 계속되면 실제 오류 메시지의 HTTP 코드를 확인해 주세요.";
    }
  } catch (error) {
    result.conclusion = `GitHub API 호출 중 오류: ${error.message}`;
  }

  return Response.json(result);
}
