import fs from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";

async function readLocalJson(filePath) {
  const fullPath = path.join(process.cwd(), filePath);
  return JSON.parse(await fs.readFile(fullPath, "utf8"));
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

  if (!response.ok) {
    throw new Error(`GitHub file read failed: ${response.status}`);
  }

  const payload = await response.json();
  const decoded = Buffer.from(payload.content || "", "base64").toString("utf8");
  return JSON.parse(decoded);
}

async function readOptionalGitHubJson(filePath, fallbackValue) {
  try {
    return await readGitHubJson(filePath);
  } catch {
    return fallbackValue;
  }
}

export async function GET() {
  try {
    const [signals, summary, relevantSignals, relevanceSummary] = await Promise.all([
      readGitHubJson("outputs/latest_company_signals.json"),
      readGitHubJson("outputs/latest_collection_summary.json"),
      readOptionalGitHubJson("outputs/latest_relevant_signals.json", []),
      readOptionalGitHubJson("outputs/latest_relevance_summary.json", null),
    ]);
    return Response.json({ signals, summary, relevantSignals, relevanceSummary });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
