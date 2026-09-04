import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

// 섀도 판정을 사람이 읽는 표로 옮긴다.
//
// 규칙을 켜기 전에 확인해야 하는 것은 두 가지다. 얼마나 줄어드는가, 그리고 줄어든 것 중에
// 살렸어야 할 것이 있는가. 앞은 여기서 바로 보이고, 뒤는 이 목록을 이번 회차의 실제 AI 판정과
// 대조해야 알 수 있다. 그래서 걸러졌을 행을 회사·지표까지 남긴다.

const SUMMARY_PATH = process.argv[2] || "outputs/latest_investment_signal_summary.json";
const MAX_LISTED = 25;

export function renderShadowReport(summary) {
  const proximity = summary?.indicator_proximity;
  if (!proximity) return "### 지표 근접 규칙\n\n요약 파일에 판정 기록이 없습니다.\n";
  if (proximity.mode === "off") return "### 지표 근접 규칙\n\n꺼져 있습니다.\n";

  const { evaluated = 0, near_company: near = 0, far_from_company: far = 0, mode } = proximity;
  const share = evaluated ? Math.round((100 * far) / evaluated) : 0;
  const lines = [
    "### 지표 근접 규칙",
    "",
    mode === "enforce"
      ? `적용됨. ${evaluated}건 중 ${far}건(${share}%)을 제외하고 ${near}건을 판정 대상으로 넘겼습니다.`
      : `기록만 함(shadow). ${evaluated}건 중 **${far}건(${share}%)**이 걸러졌을 것이고, ${near}건이 남습니다.`,
    "",
  ];

  const dropped = proximity.would_drop || [];
  if (mode === "shadow" && dropped.length) {
    lines.push(
      `걸러졌을 행 ${dropped.length}건 중 상위 ${Math.min(MAX_LISTED, dropped.length)}건입니다.`,
      "이번 회차의 AI 판정에서 이 중 승인된 것이 있으면 규칙이 너무 강한 것이므로 켜면 안 됩니다.",
      "",
      "| 기업 | 지표 | 점수 | 기사 |",
      "| --- | --- | ---: | --- |",
      ...dropped
        .slice(0, MAX_LISTED)
        .map((row) => `| ${row.company || "-"} | ${row.indicator || "-"} | ${row.score ?? "-"} | ${cell(row.title)} |`),
      "",
    );
    if (dropped.length > MAX_LISTED) {
      lines.push(`나머지 ${dropped.length - MAX_LISTED}건은 \`${SUMMARY_PATH}\`의 \`indicator_proximity.would_drop\`에 있습니다.`, "");
    }
  }
  return `${lines.join("\n")}\n`;
}

// 표 안에서 파이프와 줄바꿈은 칸을 깨뜨린다.
function cell(value) {
  const text = String(value || "-").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  return text.length > 80 ? `${text.slice(0, 79)}…` : text || "-";
}

async function main() {
  try {
    process.stdout.write(renderShadowReport(JSON.parse(await fs.readFile(SUMMARY_PATH, "utf8"))));
  } catch (error) {
    // 이 보고는 참고용이다. 읽지 못했다고 수집 전체를 실패시키지 않는다.
    process.stdout.write(`### 지표 근접 규칙\n\n판정 기록을 읽지 못했습니다: ${error.message}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
