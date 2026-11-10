// 월간 보고서는 두 워크플로로 돈다. 판정(collect-company-signals)이 끝나면 발행(publish-report)이 이어받는다.
// 대시보드 버튼은 판정을 auto_publish 로 실행해 두 단계가 이어서 돌고, "발행만 실행"은 발행만 돌린다.
// 화면의 상태 표시와 발행 버튼의 사전 확인이 같은 판단을 쓰도록 여기에 모은다.

import { githubHeaders } from "./github_env.mjs";

// 두 워크플로가 종료 코드 75(한도로 멈춤)일 때만 실패시키는 단계의 이름이다. 워크플로 파일과 같아야 한다.
// 실행의 결론만으로는 일시정지와 오류가 둘 다 failure 라 구분되지 않는다.
export const PAUSED_STEP = "Paused - run again to resume";
// 발행 워크플로가 종료 코드 65(재시도 대상 기업이 남아 문안을 쓰기 전에 멈춤)일 때 실패시키는 단계의 이름이다.
// Issue 5(2026-10)는 수집이 8개 기업을 재시도 대상으로 남긴 채 발행됐고, 화면에는 그 사실이 어디에도 없었다.
// 이 단계로 멈춘 발행은 "발행 실패"가 아니라 "발행 보류"로 보이고, 다시 수집하거나 넘기는 방법을 안내한다.
export const HELD_STEP = "Held - retryable companies remain";

const LABELS = {
  collect: { active: "판정 중", success: "판정 완료", paused: "판정 일시정지", failure: "판정 실패", cancelled: "취소" },
  publish: { active: "발행 중", success: "완료", paused: "발행 일시정지", held: "발행 보류", failure: "발행 실패", cancelled: "취소" },
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
    // 기업 목록은 실행 기록의 오류 표시(Collection incomplete)에 있다. 화면은 GitHub 실행·단계 이름만 읽는다.
    held: "일시 오류로 수집을 끝내지 못한 기업이 남아 보고서를 만들지 않았습니다(기업 목록은 실행 기록에 있습니다). " +
      "같은 기간으로 '크롤링 수행'을 다시 누르면 그 기업만 다시 받아 판정하고 발행까지 이어 갑니다. " +
      "다시 받아도 같은 기업이 남으면 '발행만 실행'에서 '재시도 대상 기업이 남아도 발행'을 체크하세요.",
    failure: "발행 중 오류가 났습니다. GitHub Actions 실행 기록을 확인해 주세요.",
  },
};

export function runOutcome(run, paused = false, held = false) {
  if (!run) return null;
  if (run.status !== "completed") return "active";
  if (run.conclusion === "success") return "success";
  if (run.conclusion === "cancelled") return "cancelled";
  if (held) return "held";
  return paused ? "paused" : "failure";
}

// 지금 단계는 더 늦게 만들어진 실행이다. 버튼이 시작한 발행은 판정 실행이 끝나기 직전에 만들어지므로 판정보다 늦다.
export function pipelineStatus({ collect = null, publish = null, collectPaused = false, publishPaused = false, publishHeld = false } = {}) {
  const publishIsLatest = Boolean(publish) && (!collect || Date.parse(publish.created_at) >= Date.parse(collect.created_at));
  const stage = publishIsLatest ? "publish" : collect ? "collect" : null;
  const collectOutcome = runOutcome(collect, collectPaused);
  const publishOutcome = runOutcome(publish, publishPaused, publishHeld);
  // 발행은 끝난 판정이 있어야 한다. 판정의 가장 최근 실행이 성공했고 아무것도 돌고 있지 않을 때만 연다.
  // 이미 발행했어도 막지 않는다. 문구를 고친 뒤 같은 판정으로 다시 발행하는 경우가 있다.
  // 발행 보류(held) 뒤에도 연다. 다시 수집해도 남는 기업이면 사람이 '발행만 실행'에서 넘겨 발행한다.
  const canPublish = collectOutcome === "success" && publishOutcome !== "active";
  if (!stage) {
    return { stage, label: "대기", status: "unknown", active: false, paused: false, held: false, can_publish: canPublish, hint: null };
  }
  const run = stage === "publish" ? publish : collect;
  const outcome = stage === "publish" ? publishOutcome : collectOutcome;
  return {
    stage,
    label: LABELS[stage][outcome],
    hint: HINTS[stage][outcome] || null,
    active: outcome === "active",
    paused: outcome === "paused",
    held: outcome === "held",
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
// "발행만 실행"(stage=publish)은 끝난 판정으로 보고서만 다시 쓴다. 워크플로가 정의하지 않은 입력을 보내면
// GitHub 가 422 로 거절한다(publish-report 에는 auto_publish 가 없다).
// allowRetryable: '발행만 실행'에서 사람이 체크했을 때만 allow_retryable_companies 를 보낸다. 판정을 보내는 버튼은
// 넘기지 않는다. 판정이 이어서 시작하는 발행은 늘 재시도 대상 기업에서 멈춰야 하기 때문이다.
export function dispatchFor(stage, config, { fromDate, toDate, issueNumber, allowRetryable = false }) {
  if (stage === "publish") {
    return { workflowFile: config.publishWorkflowFile,
      inputs: { from_date: fromDate, to_date: toDate, issue_number: issueNumber,
        ...(allowRetryable === true ? { allow_retryable_companies: "true" } : {}) } };
  }
  return { workflowFile: config.workflowFile,
    inputs: { from_date: fromDate, to_date: toDate, issue_number: issueNumber, auto_publish: "true" } };
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

// 실패한 단계 이름으로 일시정지(PAUSED_STEP)와 발행 보류(HELD_STEP)를 가른다. 둘 다 아니면 오류다.
export function stopKind(jobs = []) {
  const failed = (name) => jobs.some((job) => (job.steps || []).some((step) => step.name === name && step.conclusion === "failure"));
  return { paused: failed(PAUSED_STEP), held: failed(HELD_STEP) };
}

// 실패로 끝난 실행만 단계를 열어 본다. 성공·진행 중에는 호출하지 않는다.
async function stoppedBy(config, run) {
  const none = { paused: false, held: false };
  if (!run || run.status !== "completed" || run.conclusion !== "failure") return none;
  const response = await fetch(
    `https://api.github.com/repos/${config.owner}/${config.repo}/actions/runs/${run.id}/jobs?per_page=100`,
    { headers: githubHeaders(config.token), cache: "no-store" },
  );
  if (!response.ok) return none;
  const payload = await response.json();
  return stopKind(payload.jobs || []);
}

export async function loadPipelineStatus(config) {
  const [collect, publish] = await Promise.all([
    latestRun(config, config.workflowFile),
    latestRun(config, config.publishWorkflowFile),
  ]);
  const [collectStop, publishStop] = await Promise.all([stoppedBy(config, collect), stoppedBy(config, publish)]);
  return pipelineStatus({ collect, publish, collectPaused: collectStop.paused, publishPaused: publishStop.paused,
    publishHeld: publishStop.held });
}
