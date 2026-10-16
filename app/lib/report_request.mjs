// 보고서 다운로드(/api/report) 요청 값 검사. api/report-view-model.py 가 같은 규칙을 Python 으로 들고 있다.
//
// 예전에는 호수가 비면 "2"로 채웠고(현재 호수는 4), 한쪽 날짜만 주거나 순서가 뒤집혀도 통과했고,
// 무시 목록과 호수에 길이 제한이 없었다. 값이 틀리면 고쳐 쓰지 않고 400 으로 돌려보낸다.
import { rangeProblem } from "./date_range.mjs";

// 호수는 표지에 그대로 찍힌다. 네 자리면 충분하다.
export const MAX_ISSUE_DIGITS = 4;
// 무시 목록은 화면(app/lib/dashboard_signals.mjs signalKey)이 만든 8자리 16진수 키를 쉼표로 잇는다.
export const MAX_IGNORED_KEYS = 500;
const SIGNAL_KEY = /^[0-9a-f]{8}$/i;

function param(params, name) {
  return String(params.get(name) ?? "").trim();
}

// { options } 또는 { error } 를 돌려준다. error 는 사용자에게 그대로 보일 문구다.
export function reportOptions(params) {
  const issue = param(params, "issue");
  if (!issue) return { error: "보고서 호수(Issue 번호)를 입력해 주세요." };
  if (!new RegExp(`^\\d{1,${MAX_ISSUE_DIGITS}}$`).test(issue) || Number(issue) < 1) {
    return { error: `보고서 호수는 1~${MAX_ISSUE_DIGITS}자리 양의 정수여야 합니다.` };
  }

  const ignored = param(params, "ignored").split(",").map((item) => item.trim()).filter(Boolean);
  if (ignored.length > MAX_IGNORED_KEYS) return { error: `무시 목록은 ${MAX_IGNORED_KEYS}건까지 보낼 수 있습니다.` };
  if (ignored.some((key) => !SIGNAL_KEY.test(key))) return { error: "무시 목록 값이 올바르지 않습니다." };

  const fromDate = param(params, "from");
  const toDate = param(params, "to");
  const problem = rangeProblem(fromDate, toDate);
  if (problem) return { error: problem };

  const lang = param(params, "lang").toLowerCase() === "en" ? "en" : "ko";
  return { options: { issue: String(Number(issue)), ignored, fromDate, toDate, lang } };
}
