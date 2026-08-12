export const dynamic = "force-dynamic";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} 환경변수가 설정되지 않았습니다.`);
  return value;
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
    const days = String(body.days || process.env.DEFAULT_CRAWL_DAYS || "45");
    const fallbackRange = previousMonthRange();
    const fromDate = isIsoDate(body.fromDate) ? body.fromDate : fallbackRange.fromDate;
    const toDate = isIsoDate(body.toDate) ? body.toDate : fallbackRange.toDate;
    const issueNumber = String(body.issueNumber || "2").replace(/[^\d]/g, "") || "2";
    const owner = requiredEnv("GITHUB_OWNER");
    const repo = requiredEnv("GITHUB_REPO");
    const workflowFile = requiredEnv("GITHUB_WORKFLOW_FILE");
    const ref = process.env.GITHUB_REF || "main";
    const token = requiredEnv("GITHUB_TOKEN");

    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          ref,
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
      return Response.json(
        { error: "GitHub Actions 실행 요청에 실패했습니다.", status: response.status, detail: text },
        { status: 502 },
      );
    }

    return Response.json(
      { ok: true, days, fromDate, toDate, issueNumber, ref, requested_at: new Date().toISOString() },
      { status: 202 },
    );
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
