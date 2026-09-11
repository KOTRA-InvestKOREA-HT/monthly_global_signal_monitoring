// 웹 계층의 날짜 규칙. trigger-crawl 과 report 가 각자 같은 정규식을 들고 있었고, 둘 다
// 모양만 봤다. 모양은 맞지만 없는 날(2026-02-31)은 Date 에 넣으면 조용히 3월 3일로 밀린다.
// 되돌려 찍어 같은 글자가 나오는지까지 봐야 실제로 있는 날짜다.
export function isCalendarDate(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

// 값이 쓸 만하면 그대로, 아니면 빈 문자열. 호출한 쪽이 없는 것으로 다룬다.
export function dateParam(value) {
  return isCalendarDate(value) ? String(value).trim() : "";
}

// 기간으로 성립하는지. 한쪽만 주거나 시작이 끝보다 늦으면 기간이 아니다.
// 무엇이 잘못됐는지 문자열로 돌려준다. 없으면 null.
export function rangeProblem(fromDate, toDate) {
  const given = [fromDate, toDate].filter((value) => String(value ?? "").trim() !== "");
  if (given.length === 0) return null;
  if (given.length === 1) return "시작일과 종료일을 함께 지정해 주세요.";
  if (!isCalendarDate(fromDate)) return `시작일이 올바른 날짜가 아닙니다: ${fromDate}`;
  if (!isCalendarDate(toDate)) return `종료일이 올바른 날짜가 아닙니다: ${toDate}`;
  if (fromDate > toDate) return `시작일이 종료일보다 늦습니다: ${fromDate} ~ ${toDate}`;
  return null;
}
