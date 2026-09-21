import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { previousMonthRange } from './report_month.mjs';

// CLI and Actions must choose the same month even at a UTC/Korea month boundary.
// 전월이 언제인지는 report_month.mjs 가 정한다. 실행 버튼과 화면도 같은 함수를 쓴다.
export function resolveReportPeriod(env = process.env, now = new Date()) {
  const from = String(env.REPORT_FROM_DATE || '').trim();
  const to = String(env.REPORT_TO_DATE || '').trim();
  if (from || to) {
    if (!from || !to) throw new Error('REPORT_FROM_DATE and REPORT_TO_DATE must be supplied together');
    for (const value of [from, to]) {
      const parsed = new Date(`${value}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed.getTime()) ||
          parsed.toISOString().slice(0, 10) !== value) {
        throw new Error(`Invalid reporting date: ${value}; expected YYYY-MM-DD`);
      }
    }
    if (from > to) throw new Error('REPORT_FROM_DATE must not be after REPORT_TO_DATE');
    return { from_date: from, to_date: to };
  }
  const previous = previousMonthRange(now);
  return { from_date: previous.from_date, to_date: previous.to_date };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--github-output')) {
    throw new Error('Usage: node scripts/report_period.mjs [--github-output]');
  }
  const period = resolveReportPeriod();
  if (args[0] === '--github-output') {
    if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
    await fs.appendFile(process.env.GITHUB_OUTPUT,
      `from_date=${period.from_date}\nto_date=${period.to_date}\n`);
  }
  console.log(JSON.stringify(period));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
