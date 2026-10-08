import { dateParam, rangeProblem } from "../../lib/date_range.mjs";
import { previousMonthRange } from "../../../scripts/report_month.mjs";
import { envValue, githubConfig, githubHeaders, missingGithubEnv } from "../../lib/github_env.mjs";
import { dispatchFor, loadPipelineStatus } from "../../lib/report_pipeline.mjs";

export const dynamic = "force-dynamic";

function collectEnv() {
  const config = githubConfig();
  return { config, missing: missingGithubEnv(config) };
}

function failureHint(status, config, workflowFile = config.workflowFile) {
  const target = `${config.owner}/${config.repo} · ${workflowFile} · ${config.ref}`;
  if (status === 401) {
    return `GitHub 토큰이 만료되었거나 잘못되었습니다. Vercel의 GITHUB_TOKEN을 새 토큰으로 교체한 뒤 재배포해 주세요. (대상: ${target})`;
  }
  if (status === 403) {
    return `토큰 권한이 거부되었습니다. 토큰의 Actions 권한(Read and write)과 조직(SSO/토큰 승인) 설정을 확인해 주세요. (대상: ${target})`;
  }
  if (status === 404) {
    return `저장소·워크플로·브랜치를 찾지 못했습니다. GITHUB_OWNER/GITHUB_REPO/GITHUB_WORKFLOW_FILE/GITHUB_PUBLISH_WORKFLOW_FILE/GITHUB_REF 값과 토큰의 해당 저장소 접근 권한을 확인해 주세요. (대상: ${target})`;
  }
  if (status === 422) {
    return `워크플로가 요청한 입력값을 받지 못했습니다. 워크플로의 workflow_dispatch inputs 정의를 확인해 주세요. (대상: ${target})`;
  }
  return `GitHub API가 ${status} 응답을 반환했습니다. (대상: ${target})`;
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const stage = body.stage === "publish" ? "publish" : "collect";
    const days = String(body.days || envValue("DEFAULT_CRAWL_DAYS", "45"));
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
    if (stage === "publish") {
      const pipeline = await loadPipelineStatus(config);
      if (!pipeline.can_publish) {
        const reason = pipeline.active
          ? `지금 ${pipeline.label} 상태입니다. 끝난 뒤에 다시 눌러 주세요.`
          : "끝난 판정이 없습니다. '크롤링 수행'으로 판정을 먼저 끝내 주세요.";
        return Response.json({ error: `발행을 시작하지 않았습니다. ${reason}`, pipeline }, { status: 409 });
      }
    }

    const { workflowFile, inputs } = dispatchFor(stage, config, { days, fromDate, toDate, issueNumber });
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
      GITHUB_PUBLISH_WORKFLOW_FILE: config.publishWorkflowFile || "없음",
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
    const workflowUrl = (file) => `https://api.github.com/repos/${config.owner}/${config.repo}/actions/workflows/${file}`;
    const [tokenRes, workflowRes, publishRes] = await Promise.all([
      fetch("https://api.github.com/user", { headers: githubHeaders(config.token), cache: "no-store" }),
      fetch(workflowUrl(config.workflowFile), { headers: githubHeaders(config.token), cache: "no-store" }),
      fetch(workflowUrl(config.publishWorkflowFile), { headers: githubHeaders(config.token), cache: "no-store" }),
    ]);

    const tokenPayload = await tokenRes.json().catch(() => ({}));
    checks.token = {
      status: tokenRes.status,
      ok: tokenRes.ok,
      login: tokenRes.ok ? tokenPayload.login || null : null,
      message: tokenRes.ok ? null : tokenPayload.message || null,
    };

    const workflowCheck = async (res) => {
      const payload = await res.json().catch(() => ({}));
      return {
        status: res.status,
        ok: res.ok,
        state: res.ok ? payload.state || null : null,
        message: res.ok ? null : payload.message || null,
      };
    };
    checks.workflow = await workflowCheck(workflowRes);
    checks.publish_workflow = await workflowCheck(publishRes);

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
    } else if (!publishRes.ok) {
      result.conclusion = `판정 워크플로는 정상이지만 발행 워크플로에 접근하지 못했습니다 (HTTP ${publishRes.status}). ${failureHint(
        publishRes.status,
        config,
        config.publishWorkflowFile,
      )}`;
    } else {
      result.conclusion = "환경변수와 토큰, 워크플로 접근이 모두 정상입니다. 크롤링 버튼 실패가 계속되면 실제 오류 메시지의 HTTP 코드를 확인해 주세요.";
    }
  } catch (error) {
    result.conclusion = `GitHub API 호출 중 오류: ${error.message}`;
  }

  return Response.json(result);
}
