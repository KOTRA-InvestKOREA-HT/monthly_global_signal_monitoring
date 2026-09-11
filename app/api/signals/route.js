import fs from "node:fs/promises";
import path from "node:path";
import { dashboardSignals } from "../../lib/dashboard_signals.mjs";

export const dynamic = "force-dynamic";

// 아직 만들어지지 않은 파일과 읽다가 실패한 파일은 다르다. 앞은 빈 결과가 맞고, 뒤는
// 빈 결과로 위장하면 안 된다. 토큰 만료나 호출 한도로 조회가 깨졌는데 화면에 "투자
// 시그널 없음"이 뜨면, 실제로 없는 달과 구분할 수가 없다.
class MissingFile extends Error {}

async function readLocalJson(filePath) {
  const fullPath = path.join(process.cwd(), filePath);
  try {
    return JSON.parse(await fs.readFile(fullPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new MissingFile(filePath);
    throw error;
  }
}

async function readGitHubJson(filePath) {
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const ref = process.env.GITHUB_REF || "main";
  const token = process.env.GITHUB_TOKEN;

  if (!owner || !repo || !token) {
    return readLocalJson(filePath);
  }

  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${encodeURIComponent(ref)}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
    },
  );

  if (response.status === 404) throw new MissingFile(filePath);
  if (!response.ok) {
    throw new Error(`GitHub file read failed: ${response.status} (${filePath})`);
  }

  const payload = await response.json();
  if (payload.content) {
    const decoded = Buffer.from(payload.content, "base64").toString("utf8");
    return JSON.parse(decoded);
  }

  if (payload.download_url) {
    const rawResponse = await fetch(payload.download_url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      cache: "no-store",
    });
    if (!rawResponse.ok) {
      throw new Error(`GitHub raw file read failed: ${rawResponse.status}`);
    }
    return JSON.parse(await rawResponse.text());
  }

  throw new Error(`GitHub file payload did not include readable content: ${filePath}`);
}

async function readOptionalGitHubJson(filePath, fallbackValue) {
  try {
    return await readGitHubJson(filePath);
  } catch (error) {
    if (error instanceof MissingFile) return fallbackValue;
    throw error;
  }
}

export async function GET() {
  try {
    const [signals, summary, relevantSignals, relevanceSummary, investmentSignals, investmentSummary] = await Promise.all([
      readGitHubJson("outputs/latest_company_signals.json"),
      readGitHubJson("outputs/latest_collection_summary.json"),
      readOptionalGitHubJson("outputs/latest_relevant_signals.json", []),
      readOptionalGitHubJson("outputs/latest_relevance_summary.json", null),
      readOptionalGitHubJson("outputs/latest_investment_signals.json", []),
      readOptionalGitHubJson("outputs/latest_investment_signal_summary.json", null),
    ]);
    return Response.json({ signals: dashboardSignals(signals), summary,
      relevantSignals: dashboardSignals(relevantSignals), relevanceSummary,
      investmentSignals: dashboardSignals(investmentSignals), investmentSummary });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
