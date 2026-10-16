import { dateParam, rangeProblem } from "../../lib/date_range.mjs";
import { previousMonthRange } from "../../../scripts/report_month.mjs";
import { githubConfig, githubHeaders, missingGithubEnv } from "../../lib/github_env.mjs";
import { dispatchFor, loadPipelineStatus } from "../../lib/report_pipeline.mjs";

export const dynamic = "force-dynamic";

function collectEnv() {
  const config = githubConfig();
  return { config, missing: missingGithubEnv(config) };
}

// config 를 주면 대상 저장소·워크플로를 덧붙인다. 인증 없이 열리는 진단(GET)에서는 주지 않는다.
function failureHint(status, config = null, workflowFile = config?.workflowFile) {
  const target = config ? ` (대상: ${config.owner}/${config.repo} · ${workflowFile} · ${config.ref})` : "";
  if (status === 401) {
    return `GitHub 토큰이 만료되었거나 잘못되었습니다. Vercel의 GITHUB_TOKEN을 새 토큰으로 교체한 뒤 재배포해 주세요.${target}`;
  }
  if (status === 403) {
    return `토큰 권한이 거부되었습니다. 토큰의 Actions 권한(Read and write)과 조직(SSO/토큰 승인) 설정을 확인해 주세요.${target}`;
  }
  if (status === 404) {
    return `저장소·워크플로·브랜치를 찾지 못했습니다. GITHUB_OWNER/GITHUB_REPO/GITHUB_WORKFLOW_FILE/GITHUB_PUBLISH_WORKFLOW_FILE/GITHUB_REF 값과 토큰의 해당 저장소 접근 권한을 확인해 주세요.${target}`;
  }
  if (status === 422) {
    return `워크플로가 요청한 입력값을 받지 못했습니다. 워크플로의 workflow_dispatch inputs 정의를 확인해 주세요.${target}`;
  }
  return `GitHub API가 ${status} 응답을 반환했습니다.${target}`;
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const stage = body.stage === "publish" ? "publish" : "collect";
    const fallbackRange = previousMonthRange();
    // 잘못된 기간을 조용히 전월로 바꿔 실행하면, 요청한 기간이 아닌 기간이 돌아간 것을
    // 부르는 쪽이 알 수 없다. 형식이 틀렸거나 순서가 뒤집혔으면 접수하지 않는다.
    // 아무것도 주지 않았을 때만 전월 범위로 돈다.
    const problem = rangeProblem(body.fromDate, body.toDate);
    if (problem) {
      return Response.json({ error: problem }, { status: 400 });
    }
    const fromDate = dateParam(body.fromDate) || fallbackRange.from_date;
    const toDate = dateParam(body.toDate) || fallbackRange.to_date;
    // 호수는 PDF 표지에 그대로 찍힌다. 비었을 때 "2"로 채우던 탓에 매달 2호로 나갈 뻔했다. 비면 받지 않는다.
    const issueNumber = String(body.issueNumber ?? "").replace(/[^\d]/g, "");
    if (!issueNumber) {
      return Response.json({ error: "보고서 호수(Issue 번호)를 입력해 주세요." }, { status: 400 });
    }

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

    // 판정이 끝나지 않았는데 발행을 보내면 디스패치는 성공하고 실행 안에서 judgement_incomplete 로 실패한다.
    // 화면에서 바로 알 수 있게 보내기 전에 막는다.
    // 판정도 무언가 도는 동안에는 보내지 않는다. 두 워크플로는 같은 동시 실행 그룹이고 GitHub 는 그룹마다
    // 대기 실행을 하나만 둔다. 발행이 기다리는 중에 판정을 보내면 기다리던 발행이 말없이 취소됐다.
    const pipeline = await loadPipelineStatus(config);
    if (stage === "collect" && pipeline.active) {
      return Response.json(
        { error: `크롤링을 시작하지 않았습니다. 지금 ${pipeline.label} 상태입니다. 끝난 뒤에 다시 눌러 주세요.`, pipeline },
        { status: 409 },
      );
    }
    if (stage === "publish" && !pipeline.can_publish) {
      const reason = pipeline.active
        ? `지금 ${pipeline.label} 상태입니다. 끝난 뒤에 다시 눌러 주세요.`
        : "끝난 판정이 없습니다. '크롤링 수행'으로 판정을 먼저 끝내 주세요.";
      return Response.json({ error: `발행을 시작하지 않았습니다. ${reason}`, pipeline }, { status: 409 });
    }

    const { workflowFile, inputs } = dispatchFor(stage, config, { fromDate, toDate, issueNumber });
    // 보내기 전에 잰다. 실행은 응답이 오기 전에 만들어질 수 있고, 화면은 이 시각보다 먼저 만들어진 실행을 지난 실행으로 본다.
    const requestedAt = new Date().toISOString();
    const response = await fetch(
      `https://api.github.com/repos/${config.owner}/${config.repo}/actions/workflows/${workflowFile}/dispatches`,
      {
        method: "POST",
        headers: { ...githubHeaders(config.token), "Content-Type": "application/json" },
        body: JSON.stringify({ ref: config.ref, inputs }),
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
      const hint = failureHint(response.status, config, workflowFile);
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
        stage,
        workflow: workflowFile,
        fromDate,
        toDate,
        issueNumber,
        ref: config.ref,
        requested_at: requestedAt,
      },
      { status: 202 },
    );
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

// 진단용: 브라우저에서 /api/trigger-crawl 을 그대로 열면 어느 단계가 막혔는지 확인할 수 있다.
// 인증 없이 열리는 주소라 설정값은 보여 주지 않는다. 설정 여부와 GitHub 응답 코드만 돌려준다.
// 예전에는 토큰 길이·앞 4글자와 토큰 주인의 GitHub 로그인까지 보여 줬다.
const DIAGNOSTIC_ENV = {
  GITHUB_TOKEN: "token",
  GITHUB_OWNER: "owner",
  GITHUB_REPO: "repo",
  GITHUB_WORKFLOW_FILE: "workflowFile",
  GITHUB_PUBLISH_WORKFLOW_FILE: "publishWorkflowFile",
  GITHUB_REF: "ref",
};

export async function GET() {
  const { config, missing } = collectEnv();
  const checks = {};

  const result = {
    env: Object.fromEntries(Object.entries(DIAGNOSTIC_ENV).map(([name, key]) => [name, config[key] ? "설정됨" : "없음"])),
    missing,
    checks,
  };

  if (missing.length) {
    result.conclusion = `Vercel 환경변수 누락: ${missing.join(", ")}. Production 환경에 등록한 뒤 재배포해야 합니다.`;
    return Response.json(result);
  }

  try {
    const workflowUrl = (file) => `https://api.github.com/repos/${config.owner}/${config.repo}/actions/workflows/${file}`;
    const [tokenRes, workflowRes, publishRes] = await Promise.all([
      fetch("https://api.github.com/user", { headers: githubHeaders(config.token), cache: "no-store" }),
      fetch(workflowUrl(config.workflowFile), { headers: githubHeaders(config.token), cache: "no-store" }),
      fetch(workflowUrl(config.publishWorkflowFile), { headers: githubHeaders(config.token), cache: "no-store" }),
    ]);

    const workflowCheck = async (res) => {
      const payload = await res.json().catch(() => ({}));
      // state 는 active / disabled_manually 같은 값이라 드러나도 괜찮다. 꺼진 워크플로를 찾는 데 쓴다.
      return { status: res.status, ok: res.ok, state: res.ok ? payload.state || null : null };
    };
    checks.token = { status: tokenRes.status, ok: tokenRes.ok };
    checks.workflow = await workflowCheck(workflowRes);
    checks.publish_workflow = await workflowCheck(publishRes);

    if (!tokenRes.ok) {
      result.conclusion = `GITHUB_TOKEN이 GitHub에서 거부되었습니다 (HTTP ${tokenRes.status}). ${failureHint(tokenRes.status)}`;
    } else if (!workflowRes.ok) {
      result.conclusion = `토큰은 유효하지만 워크플로에 접근하지 못했습니다 (HTTP ${workflowRes.status}). ${failureHint(workflowRes.status)}`;
    } else if (!publishRes.ok) {
      result.conclusion = `판정 워크플로는 정상이지만 발행 워크플로에 접근하지 못했습니다 (HTTP ${publishRes.status}). ${failureHint(publishRes.status)}`;
    } else {
      result.conclusion = "환경변수와 토큰, 워크플로 접근이 모두 정상입니다. 크롤링 버튼 실패가 계속되면 실제 오류 메시지의 HTTP 코드를 확인해 주세요.";
    }
  } catch {
    result.conclusion = "GitHub API 호출 중 오류가 났습니다.";
  }

  return Response.json(result);
}
