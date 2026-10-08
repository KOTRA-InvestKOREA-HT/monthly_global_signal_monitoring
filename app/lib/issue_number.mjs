// 보고서 호수 짐작. 화면(app/page.jsx)이 쓰므로 GitHub 설정을 읽는 report_pipeline.mjs 와 떼어 둔다.

const monthIndex = (date) => Number(String(date).slice(0, 4)) * 12 + Number(String(date).slice(5, 7));

// 고른 달의 호수. 마지막으로 발행한 달이면 그 호수, 바로 다음 달이면 하나 더한 호수다.
// 그 밖의 달은 호수를 짐작하지 않는다(호수가 달마다 하나씩 늘지만은 않았다). 빈 값이면 사람이 넣는다.
export function suggestedIssue(published, fromDate) {
  const issue = Number(String(published?.issue_number || "").replace(/[^\d]/g, ""));
  const from = published?.period?.from_date;
  if (!issue || !from || !fromDate) return "";
  const months = monthIndex(fromDate) - monthIndex(from);
  if (months === 0) return String(issue);
  if (months === 1) return String(issue + 1);
  return "";
}
