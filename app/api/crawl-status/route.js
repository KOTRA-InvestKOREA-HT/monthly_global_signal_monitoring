export const dynamic = "force-dynamic";

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

function statusLabel(run) {
  if (!run) return "대기";
  if (run.status !== "completed") return "진행 중";
  if (run.conclusion === "success") return "완료";
  if (run.conclusion === "cancelled") return "취소";
  return "실패";
}

export async function GET() {
  try {
    const owner = env("GITHUB_OWNER");
    const repo = env("GITHUB_REPO");
    const workflowFile = env("GITHUB_WORKFLOW_FILE", "collect-company-signals.yml");
    const ref = env("GITHUB_REF", "main");
    const token = env("GITHUB_TOKEN");

    if (!owner || !repo) {
      return Response.json({ label: "대기", status: "unknown", message: "GitHub 저장소 환경변수가 없습니다." });
    }

    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/runs?branch=${encodeURIComponent(
        ref,
      )}&per_page=1`,
      { headers, cache: "no-store" },
    );

    if (!response.ok) {
      const detail = await response.text();
      return Response.json(
        { label: "확인 실패", status: "error", error: `GitHub Actions 상태 확인 실패: ${response.status}`, detail },
        { status: 502 },
      );
    }

    const payload = await response.json();
    const run = payload.workflow_runs?.[0] || null;

    return Response.json({
      label: statusLabel(run),
      status: run?.status || "unknown",
      conclusion: run?.conclusion || null,
      run_number: run?.run_number || null,
      run_id: run?.id || null,
      html_url: run?.html_url || null,
      created_at: run?.created_at || null,
      run_started_at: run?.run_started_at || null,
      updated_at: run?.updated_at || null,
    });
  } catch (error) {
    return Response.json({ label: "확인 실패", status: "error", error: error.message }, { status: 500 });
  }
}
