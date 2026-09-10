// 같은 앵커에 링크 판정 규칙 세 가지를 모두 걸어 결과를 비교한다.
//
//   august    2026-08 시점 규칙 (82acb6f)
//   current   html-report-prototype 이 지금 쓰는 규칙
//   proposed  link_policy.mjs 의 세 갈래 판정
//
// 규칙을 바꾸기 전에 무엇이 돌아오고 무엇이 새로 들어오는지 숫자로 봐야 한다.
// 이 도구는 목록 페이지만 받아서 앵커를 판정할 뿐, 기사 본문은 받지 않고 AI도 부르지
// 않는다. outputs/ 에도 쓰지 않는다. 프로덕션 수집 결과는 이 도구를 돌려도 그대로다.
//
//   node scripts/audit_link_rules.mjs --limit 40 --out-dir outputs/link_audit
//
// --cache-dir 에 받은 HTML을 남기므로, 규칙을 고치고 다시 돌릴 때는 네트워크를 타지 않는다.

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { fetchText, judgeLink, parseAnchors } from "./collect_company_signals.mjs";

const SAMPLE_PER_CELL = 40;
const SAMPLE_PER_COMPANY = 3;

function parseArgs(argv) {
  const args = {
    sourceConfig: "config/company_sources.json",
    outDir: "outputs/link_audit",
    cacheDir: ".cache/link_audit",
    limit: 0,
    perCompany: 1,
    timeoutSeconds: 20,
    offline: false,
  };
  const numbers = new Set(["limit", "perCompany", "timeoutSeconds"]);
  const keyMap = {
    "--source-config": "sourceConfig",
    "--out-dir": "outDir",
    "--cache-dir": "cacheDir",
    "--limit": "limit",
    "--per-company": "perCompany",
    "--timeout-seconds": "timeoutSeconds",
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--offline") {
      args.offline = true;
      continue;
    }
    const mapped = keyMap[argv[index]];
    if (!mapped) continue;
    const value = argv[index + 1];
    index += 1;
    args[mapped] = numbers.has(mapped) ? Number.parseInt(value, 10) : value;
  }
  return args;
}

function cacheName(url) {
  return `${crypto.createHash("sha1").update(url).digest("hex").slice(0, 16)}.html`;
}

// 캐시가 있으면 네트워크를 타지 않는다. 규칙을 고치며 여러 번 돌리는 도구라 이게 기본이다.
async function loadPage(url, args) {
  const file = path.join(args.cacheDir, cacheName(url));
  try {
    return { html: await fs.readFile(file, "utf8"), fromCache: true };
  } catch {
    if (args.offline) return null;
  }
  const html = await fetchText(url, args.timeoutSeconds);
  await fs.mkdir(args.cacheDir, { recursive: true });
  await fs.writeFile(file, html, "utf8");
  return { html, fromCache: false };
}

function selectPages(config, args) {
  const pages = [];
  for (const [company, entries] of Object.entries(config.official_pages || {})) {
    const list = (entries || [])
      .map((entry) => (typeof entry === "string" ? { url: entry } : entry))
      .filter((entry) => entry.url);
    // 회사당 Primary 를 먼저 쓴다. 77개사를 고르게 담아야 한 사이트의 버릇이 전체를 흔들지 않는다.
    list.sort((a, b) => (a.crawl_priority === "Primary" ? 0 : 1) - (b.crawl_priority === "Primary" ? 0 : 1));
    for (const entry of list.slice(0, args.perCompany)) pages.push({ company, url: entry.url });
  }
  return args.limit > 0 ? pages.slice(0, args.limit) : pages;
}

// 셀 이름은 세 규칙의 통과 여부 조합이다. 사람이 확인할 표본은 셀별로 따로 모은다.
function cellOf(judgement) {
  const proposed = judgement.proposed.verdict !== "hard_reject";
  return `${judgement.august ? "O" : "X"}${judgement.current ? "O" : "X"}${proposed ? "O" : "X"}`;
}

class Samples {
  constructor() {
    this.cells = new Map();
  }

  add(cell, row) {
    if (!this.cells.has(cell)) this.cells.set(cell, []);
    const bucket = this.cells.get(cell);
    if (bucket.length >= SAMPLE_PER_CELL) return;
    if (bucket.filter((item) => item.company === row.company).length >= SAMPLE_PER_COMPANY) return;
    bucket.push(row);
  }

  toJSON() {
    return Object.fromEntries([...this.cells].map(([cell, rows]) => [cell, rows]));
  }
}

export function summarise(records) {
  const counts = {
    anchors: records.length,
    august_pass: 0,
    current_pass: 0,
    proposed_pass: 0,
    proposed_accept: 0,
    proposed_fetch_to_verify: 0,
    proposed_hard_reject: 0,
    // --link-policy proposed 로 돌렸을 때 수집 경로가 실제로 내리는 처분.
    effective_pass: 0,
    effective_accept: 0,
    effective_fetch_to_verify: 0,
    effective_hard_reject: 0,
    current_pass_lost_by_effective: 0,
    // 사용자가 요청한 최소 집계 다섯 칸.
    old_true_current_false: 0,
    old_true_proposed_false: 0,
    current_false_proposed_true: 0,
    all_true: 0,
    all_false: 0,
  };
  const cells = new Map();
  const recoveredReasons = new Map();
  const rejectReasons = new Map();
  for (const record of records) {
    const { august, current, proposed } = record.judgement;
    const passes = proposed.verdict !== "hard_reject";
    if (august) counts.august_pass += 1;
    if (current) counts.current_pass += 1;
    if (passes) counts.proposed_pass += 1;
    counts[`proposed_${proposed.verdict}`] += 1;
    if (august && !current) counts.old_true_current_false += 1;
    if (august && !passes) counts.old_true_proposed_false += 1;
    if (!current && passes) {
      counts.current_false_proposed_true += 1;
      recoveredReasons.set(proposed.reason, (recoveredReasons.get(proposed.reason) || 0) + 1);
    }
    if (august && current && passes) counts.all_true += 1;
    if (!august && !current && !passes) counts.all_false += 1;
    if (!passes) rejectReasons.set(proposed.reason, (rejectReasons.get(proposed.reason) || 0) + 1);
    const effective = record.judgement.effective;
    if (effective) {
      counts[`effective_${effective.verdict}`] += 1;
      if (effective.verdict !== "hard_reject") counts.effective_pass += 1;
      // 이 칸은 0이어야 한다. 0이 아니면 규칙을 바꾸는 순간 걷던 기사가 사라진다는 뜻이다.
      if (current && effective.verdict === "hard_reject") counts.current_pass_lost_by_effective += 1;
    }
    const cell = cellOf(record.judgement);
    cells.set(cell, (cells.get(cell) || 0) + 1);
  }
  return {
    counts,
    cells: Object.fromEntries([...cells].sort((a, b) => b[1] - a[1])),
    recovered_by_reason: Object.fromEntries([...recoveredReasons].sort((a, b) => b[1] - a[1])),
    hard_reject_by_reason: Object.fromEntries([...rejectReasons].sort((a, b) => b[1] - a[1])),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = JSON.parse(await fs.readFile(args.sourceConfig, "utf8"));
  const pages = selectPages(config, args);
  const records = [];
  const samples = new Samples();
  const pageStatus = [];
  const seen = new Set();

  for (const page of pages) {
    let loaded = null;
    let error = "";
    try {
      loaded = await loadPage(page.url, args);
    } catch (failure) {
      error = failure.message;
    }
    if (!loaded) {
      pageStatus.push({ ...page, anchors: 0, error: error || "not_cached" });
      continue;
    }
    const anchors = parseAnchors(loaded.html, page.url);
    for (const anchor of anchors) {
      // 같은 URL이 한 페이지에 여러 번 걸리면 판정이 아니라 그 사이트의 메뉴를 세게 된다.
      const key = `${page.company} -> ${anchor.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const judgement = judgeLink(anchor, page.url);
      const record = { company: page.company, page: page.url, anchor, judgement };
      records.push(record);
      samples.add(cellOf(judgement), {
        company: page.company,
        title: anchor.title.slice(0, 120),
        url: anchor.url,
        proposed_verdict: judgement.proposed.verdict,
        proposed_reason: judgement.proposed.reason,
      });
    }
    pageStatus.push({ ...page, anchors: anchors.length, cached: loaded.fromCache, error: "" });
  }

  const report = {
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    pages_requested: pages.length,
    pages_read: pageStatus.filter((page) => !page.error).length,
    page_errors: pageStatus.filter((page) => page.error),
    ...summarise(records),
  };

  const cells = samples.toJSON();
  const pick = (...names) => names.flatMap((name) => cells[name] || []);
  await fs.mkdir(args.outDir, { recursive: true });
  await fs.writeFile(path.join(args.outDir, "link_rule_audit.json"), JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(
    path.join(args.outDir, "link_rule_samples.json"),
    JSON.stringify(
      {
        legend: "cell = august/current/proposed 순서, O=통과 X=탈락",
        // 사람이 실제로 확인해야 하는 두 묶음. 셀 이름을 해독하지 않고 바로 읽을 수 있어야 한다.
        recovered_current_false_proposed_true: pick("XXO", "XOO"),
        lost_since_august_old_true_current_false: pick("OXX", "OXO"),
        cells,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
