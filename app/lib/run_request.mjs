// 버튼으로 보낸 실행을 화면이 끝까지 따라가게 한다. 브라우저에서도 불러오므로 다른 모듈을 가져오지 않는다.
//
// 디스패치가 받아들여져도 GitHub 가 새 실행을 목록에 올리기까지 몇 초가 걸린다. 그 사이 상태 API 는 지난 실행
// (이미 끝남)을 돌려줘서, 그대로 믿으면 active=false 가 되어 10초 폴링이 멈추고 새로고침 전에는 진행도 완료도
// 보이지 않았다. 화면은 보낸 요청을 기억해 두고, 요청 시각보다 먼저 만들어진 실행은 "아직 시작 전"으로 본다.

// 새 실행이 목록에 나타나기를 기다리는 시간. 보통 몇 초다. 넘으면 디스패치가 말없이 사라진 것으로 보고 알린다.
export const START_WAIT_MS = 5 * 60 * 1000;
// 버튼이 보낸 판정은 끝나면서 발행을 시작한다. 판정 완료 뒤 발행 실행이 나타나기를 기다리는 시간.
export const HANDOFF_WAIT_MS = 3 * 60 * 1000;
// requested_at 은 Vercel 시계, created_at 은 GitHub 시계이고 created_at 은 초 단위로 잘린다.
const CLOCK_SKEW_MS = 15 * 1000;
// 10초마다 확인하므로 30번이면 5분이다.
const MAX_STATUS_ERRORS = 30;

const WAITING = { collect: "판정 대기", publish: "발행 대기" };

export const NOT_STARTED_LABEL = "시작 확인 안 됨";

export function runRequest(stage, requestedAt, now = Date.now()) {
  return { stage: stage === "publish" ? "publish" : "collect", requested_at: requestedAt, start_deadline: now + START_WAIT_MS };
}

// 지난 실행의 제목·링크·결론은 이번 실행의 것이 아니므로 넘기지 않는다. 기다리는 동안 발행 버튼은 닫는다.
function waiting(stage, request) {
  return { stage, label: WAITING[stage], status: "requested", active: true, paused: false, can_publish: false, hint: null,
    requested_at: request.requested_at };
}

// 디스패치 직후, 첫 확인 전에 보일 상태.
export function requestedStatus(request) {
  return waiting(request.stage, request);
}

// 상태 API 의 응답(또는 확인 실패)과 기억해 둔 요청으로 화면에 보일 상태와 계속 따라갈 요청을 정한다.
// 요청이 null 이 되면 더 따라가지 않고, 응답을 그대로 보인다.
export function followRequest(status, request, now = Date.now()) {
  if (!request) return { status, request: null };
  // 상태 확인이 한 번 실패했다고 따라가기를 그만두지 않는다. 연달아 실패하면(약 5분) 그만둔다.
  if (!status || status.status === "error") {
    const errors = (request.errors || 0) + 1;
    if (errors > MAX_STATUS_ERRORS) return { status, request: null };
    return { status: { ...status, active: true }, request: { ...request, errors } };
  }
  request = request.errors ? { ...request, errors: 0 } : request;
  const created = Date.parse(status.created_at || "");
  const requested = Date.parse(request.requested_at || "");
  // 요청 시각을 모르면(예전 응답) 지금 보이는 실행을 이번 실행으로 본다.
  const ours = Number.isFinite(requested) ? Number.isFinite(created) && created >= requested - CLOCK_SKEW_MS : true;

  if (!ours) {
    if (now <= request.start_deadline) return { status: waiting(request.stage, request), request };
    const minutes = Math.round(START_WAIT_MS / 60000);
    return {
      status: {
        ...status,
        label: NOT_STARTED_LABEL,
        active: false,
        paused: false,
        html_url: null,
        hint: `실행을 요청하고 ${minutes}분이 지나도 GitHub Actions에 새 실행이 보이지 않습니다. Actions 실행 기록을 확인한 뒤 필요하면 다시 눌러 주세요.`,
      },
      request: null,
    };
  }

  if (request.stage === "collect" && status.stage === "collect" && status.status === "completed" && status.conclusion === "success") {
    const handoffDeadline = request.handoff_deadline ?? now + HANDOFF_WAIT_MS;
    // 기다려도 발행이 보이지 않으면 판정 완료를 그대로 보인다. 그 안내가 '발행만 실행'을 권한다.
    if (now > handoffDeadline) return { status, request: null };
    return { status: waiting("publish", request), request: { ...request, handoff_deadline: handoffDeadline } };
  }

  // 판정이 도는 동안에는 끝난 뒤 이어질 발행까지 따라가야 하므로 요청을 들고 있는다.
  return { status, request: status.active ? request : null };
}
