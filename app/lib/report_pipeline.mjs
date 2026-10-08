// 월간 보고서는 두 워크플로로 돈다. 판정(collect-company-signals)이 끝나면 발행(publish-report)이 이어받는다.
// 대시보드 버튼은 판정을 auto_publish 로 실행해 두 단계가 이어서 돌고, "발행만 실행"은 발행만 돌린다.
// 화면의 상태 표시와 발행 버튼의 사전 확인이 같은 판단을 쓰도록 여기에 모은다.

import { githubHeaders } from "./github_env.mjs";

// 두 워크플로가 종료 코드 75(한도로 멈춤)일 때만 실패시키는 단계의 이름이다. 워크플로 파일과 같아야 한다.
// 실행의 결론만으로는 일시정지와 오류가 둘 다 failure 라 구분되지 않는다.
export const PAUSED_STEP = "Paused - run again to resume";

const LABELS = {
  collect: { active: "판정 중", success: "판정 완료", paused: "판정 일시정지", failure: "판정 실패", cancelled: "취소" },
  publish: { active: "발행 중", success: "완료", paused: "발행 일시정지", failure: "발행 실패", cancelled: "취소" },
};

const HINTS = {
  collect: {
    success: "판정이 끝났습니다. 발행이 시작되지 않았다면 '발행만 실행'을 누르세요.",
    paused: "하루 한도 등으로 판정이 멈췄습니다. 같은 기간으로 '크롤링 수행'을 다시 누르면 이어서 판정합니다.",
    failure: "판정 중 오류가 났습니다. GitHub Actions 실행 기록을 확인해 주세요.",
  },
  publish: {
    success: "보고서를 발행했습니다.",
    paused: "보고서 문안 작성이 한도로 멈췄습니다. 같은 기간으로 '발행만 실행'을 누르면 이어서 씁니다.",
    failure: "발행 중 오류가 났습니다. GitHub Actions 실행 기록을 확인해 주세요.",
  },
};

export function runOutcome(run, paused = false) {
  if (!run) return null;
  if (run.status !== "completed") return "active";
  if (run.conclusion === "success") return "success";
  if (run.conclusion === "cancelled") return "cancelled";
  return paused ? "paused" : "failure";
}

// 지금 단계는 더 늦게 만들어진 실행이다. 버튼이 시작한 발행은 판정 실행이 끝나기 직전에 만들어지므로 판정보다 늦다.
export function pipelineStatus({ collect = null, publish = null, collectPaused = false, publishPaused = false } = {}) {
  const publishIsLatest = Boolean(publish) && (!collect || Date.parse(publish.created_at) >= Date.parse(collect.created_at));
  const stage = publishIsLatest ? "publish" : collect ? "collect" : null;
  const collectOutcome = runOutcome(collect, collectPaused);
  const publishOutcome = runOutcome(publish, publishPaused);
  // 발행은 끝난 판정이 있어야 한다. 판정의 가장 최근 실행이 성공했고 아무것도 돌고 있지 않을 때만 연다.
  // 이미 발행했어도 막지 않는다. 문구를 고친 뒤 같은 판정으로 다시 발행하는 경우가 있다.
  const canPublish = collectOutcome === "success" && publishOutcome !== "active";
  if (!stage) {
    return { stage, label: "대기", status: "unknown", active: false, paused: false, can_publish: canPublish, hint: null };
  }
  const run = stage === "publish" ? publish : collect;
  const outcome = stage === "publish" ? publishOutcome : collectOutcome;
  return {
    stage,
    label: LABELS[stage][outcome],
    hint: HINTS[stage][outcome] || null,
    active: outcome === "active",
    paused: outcome === "paused",
    can_publish: canPublish,
    status: run.status || "unknown",
    conclusion: run.conclusion || null,
    title: run.display_title || null,
    run_number: run.run_number || null,
    run_id: run.id || null,
    html_url: run.html_url || null,
    created_at: run.created_at || null,
    run_started_at: run.run_started_at || null,
    updated_at: run.updated_at || null,
  };
}

// 실행할 워크플로와 입력. "크롤링 수행"은 판정을 auto_publish 로 실행해 판정이 끝나면 발행까지 이어 가고,
// "발행만 실행"(stage=publish)은 끝난 판정으로 보고서만 다시 쓴다. publish-report 는 days 를 입력으로
// 정의하지 않아서 보내면 GitHub 가 422 로 거절한다.
export function dispatchFor(stage, config, { days, fromDate, toDate, issueNumber }) {
  if (stage === "publish") {
    return { workflowFile: config.publishWorkflowFile,
      inputs: { from_date: fromDate, to_date: toDate, issue_number: issueNumber } };
  }
  return { workflowFile: config.workflowFile,
    inputs: { days, from_date: fromDate, to_date: toDate, issue_number: issueNumber, auto_publish: "true" } };
}

function githubError(message, status) {
  return Object.assign(new Error(message), { status });
}

async function latestRun(config, workflowFile) {
  const response = await fetch(
    `https://api.github.com/repos/${config.owner}/${config.repo}/actions/workflows/${workflowFile}/runs?branch=${encodeURIComponent(
      config.ref,
    )}&per_page=1`,
    { headers: githubHeaders(config.token), cache: "no-store" },
  );
  // 발행 워크플로가 아직 기본 브랜치에 없으면 404 다. 실행이 없는 것과 같다.
  if (response.status === 404) return null;
  if (!response.ok) throw githubError(`GitHub Actions 상태 확인 실패: ${response.status} (${workflowFile})`, response.status);
  const payload = await response.json();
  return payload.workflow_runs?.[0] || null;
}

// 실패로 끝난 실행만 단계를 열어 본다. 성공·진행 중에는 호출하지 않는다.
async function stoppedByPause(config, run) {
  if (!run || run.status !== "completed" || run.conclusion !== "failure") return false;
  const response = await fetch(
    `https://api.github.com/repos/${config.owner}/${config.repo}/actions/runs/${run.id}/jobs?per_page=100`,
    { headers: githubHeaders(config.token), cache: "no-store" },
  );
  if (!response.ok) return false;
  const payload = await response.json();
  return (payload.jobs || []).some((job) =>
    (job.steps || []).some((step) => step.name === PAUSED_STEP && step.conclusion === "failure"));
}

export async function loadPipelineStatus(config) {
  const [collect, publish] = await Promise.all([
    latestRun(config, config.workflowFile),
    latestRun(config, config.publishWorkflowFile),
  ]);
  const [collectPaused, publishPaused] = await Promise.all([stoppedByPause(config, collect), stoppedByPause(config, publish)]);
  return pipelineStatus({ collect, publish, collectPaused, publishPaused });
}
