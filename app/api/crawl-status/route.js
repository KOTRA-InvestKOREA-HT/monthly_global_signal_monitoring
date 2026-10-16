import { githubConfig, missingGithubEnv } from "../../lib/github_env.mjs";
import { loadPipelineStatus } from "../../lib/report_pipeline.mjs";

export const dynamic = "force-dynamic";

// 판정(collect-company-signals)과 발행(publish-report) 중 더 최근 실행의 상태를 돌려준다.
// 한도로 멈춘 실행은 "일시정지"로, 그 밖의 실패는 "실패"로 나눠 보여 준다.
export async function GET() {
  try {
    const config = githubConfig();

    // 토큰 없이 부르면 비공개 저장소는 404 가 오고, 404 는 "실행 없음"으로 읽혀 "대기"로 잘못 보였다.
    const missing = missingGithubEnv(config);
    if (missing.length) {
      return Response.json({ label: "설정 필요", status: "unknown", active: false, paused: false, can_publish: false,
        message: `GitHub 환경변수가 없습니다: ${missing.join(", ")}` });
    }

    return Response.json(await loadPipelineStatus(config));
  } catch (error) {
    return Response.json(
      { label: "확인 실패", status: "error", error: error.message },
      { status: error.status ? 502 : 500 },
    );
  }
}
