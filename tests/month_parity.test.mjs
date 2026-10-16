// 보고서의 달력 계산은 JS(scripts/report_month.mjs)와 Python(scripts/report_content.py) 두 곳에 있다.
// 수집·발행·실행 버튼은 JS 로 기간을 정하고, 보고서 문구와 기간 필터는 Python 이 같은 기간을 다시 읽는다.
// 예전에는 다섯 곳이 각자 계산했고 두 언어를 대조하는 테스트가 없었다. 같은 입력에 같은 답을 내는지 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isCalendarDate, monthPeriod, monthRange, previousMonthRange } from '../scripts/report_month.mjs';

const PYTHON = process.env.PYTHON || process.env.PYTHON_PATH || 'python';

const INSTANTS = ['2026-08-31T14:59:59Z', '2026-08-31T15:00:00Z', '2026-01-15T00:00:00Z', '2026-01-01T00:00:00Z',
  '2025-12-31T15:00:00Z', '2026-03-15T00:00:00Z', '2024-03-01T00:00:00Z', '2024-02-29T15:00:00Z'];
const MONTHS = ['2024-02', '2025-02', '2026-01', '2026-04', '2026-12', '2100-02', '2000-02'];
const DATES = ['2024-02-29', '2026-02-29', '2026-02-31', '2026-04-31', '2026-12-31', '2026-13-01', '2026-00-10',
  '2026-8-1', ' 2026-08-01 ', 'bad', '', '2026-08-01T00:00:00Z'];

const SCRIPT = `
import json, sys
from datetime import datetime
from pathlib import Path
sys.path.insert(0, str(Path("scripts").resolve()))
import report_content as rc
data = json.loads(sys.stdin.read())
iso = lambda pair: [pair[0].isoformat(), pair[1].isoformat()]
print(json.dumps({
    "previous": [iso(rc.previous_month_range(datetime.fromisoformat(v.replace("Z", "+00:00")))) for v in data["instants"]],
    "fallback": [[d.date().isoformat() for d in rc.report_period({"run_started_at": v})] for v in data["instants"]],
    "months": [iso(rc.month_bounds(m)) for m in data["months"]],
    "dates": [rc.calendar_date(d) is not None for d in data["dates"]],
}))
`;

test('JS and Python agree on the previous month, month bounds and real calendar dates', t => {
  const result = spawnSync(PYTHON, ['-X', 'utf8', '-c', SCRIPT], {
    input: JSON.stringify({ instants: INSTANTS, months: MONTHS, dates: DATES }), encoding: 'utf8',
  });
  if (result.error?.code === 'ENOENT') {
    t.skip(`Python not found (${PYTHON})`);
    return;
  }
  assert.equal(result.status, 0, result.stderr);
  const py = JSON.parse(result.stdout.trim().split('\n').at(-1));

  const previous = INSTANTS.map(now => {
    const range = previousMonthRange(new Date(now));
    return [range.from_date, range.to_date];
  });
  assert.deepEqual(py.previous, previous);
  // 기간 없는 요약의 대체값(report_period)도 같은 전월이다.
  assert.deepEqual(py.fallback, previous);
  assert.deepEqual(py.months, MONTHS.map(month => {
    const { from_date, to_date } = monthPeriod(month);
    assert.deepEqual({ from_date, to_date }, (({ from_date: f, to_date: e }) => ({ from_date: f, to_date: e }))(
      monthRange(Number(month.slice(0, 4)), Number(month.slice(5)))));
    return [from_date, to_date];
  }));
  assert.deepEqual(py.dates, DATES.map(isCalendarDate));
  // 비교가 빈 답으로 통과하지 않도록 참과 거짓이 모두 있었는지 본다.
  assert.ok(py.dates.includes(true) && py.dates.includes(false));
});
