import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("missing API key does not overwrite report inputs without complete current cache coverage", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "signal-summary-test-"));
  const investmentPath = path.join(tempDir, "investment.json");
  const relevantPath = path.join(tempDir, "relevant.json");
  const cachePath = path.join(tempDir, "cache.json");
  const investmentSource = `${JSON.stringify([{ company: "Example", investment_signal_no: 1, title: "Candidate", url: "https://example.com/a" }], null, 2)}\n`;
  const relevantSource = `${JSON.stringify([{ company: "Example", title: "Business candidate", url: "https://example.com/b" }], null, 2)}\n`;

  try {
    await Promise.all([
      fs.writeFile(investmentPath, investmentSource, "utf8"),
      fs.writeFile(relevantPath, relevantSource, "utf8"),
      fs.writeFile(cachePath, '{"version":1,"entries":{}}\n', "utf8"),
    ]);
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    const result = spawnSync(
      process.execPath,
      [
        path.resolve("scripts/summarize_signal_evidence.mjs"),
        "--investment-signals",
        investmentPath,
        "--relevant-signals",
        relevantPath,
        "--cache",
        cachePath,
        "--out-dir",
        tempDir,
        "--optional",
        "false",
      ],
      { cwd: path.resolve("."), env, encoding: "utf8" },
    );

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(await fs.readFile(investmentPath, "utf8"), investmentSource);
    assert.equal(await fs.readFile(relevantPath, "utf8"), relevantSource);
    const summary = JSON.parse(await fs.readFile(path.join(tempDir, "latest_ai_summary_summary.json"), "utf8"));
    assert.equal(summary.status, "failed_missing_openai_api_key");
    assert.equal(summary.outputs.investment, null);
    assert.equal(summary.outputs.relevant, null);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
