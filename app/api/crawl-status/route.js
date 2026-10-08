import { githubConfig } from "../../lib/github_env.mjs";
import { loadPipelineStatus } from "../../lib/report_pipeline.mjs";

export const dynamic = "force-dynamic";

// 판정(collect-company-signals)과 발행(publish-report) 중 더 최근 실행의 상태를 돌려준다.
// 한도로 멈춘 실행은 "일시정지"로, 그 밖의 실패는 "실패"로 나눠 보여 준다.
export async function GET() {
  try {
    const config = githubConfig();

    if (!config.owner || !config.repo) {
      return Response.json({ label: "대기", status: "unknown", message: "GitHub 저장소 환경변수가 없습니다." });
    }

    return Response.json(await loadPipelineStatus(config));
  } catch (error) {
    return Response.json(
      { label: "확인 실패", status: "error", error: error.message },
      { status: error.status ? 502 : 500 },
    );
  }
}
