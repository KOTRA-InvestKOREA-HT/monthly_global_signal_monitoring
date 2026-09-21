// 이 보고서에서 "전월"이 언제인지 정하는 한 곳.
//
// 예전에는 세 곳이 각자 계산했고 기준 시간대가 서로 달랐다.
//   scripts/report_period.mjs      한국 시간
//   app/api/trigger-crawl/route.js UTC
//   app/page.jsx                   브라우저 현지 시간
// 한국 시간 9월 1일 0시 30분(= UTC 8월 31일 15시 30분)에 자동 실행은 8월을 고르는데
// 실행 버튼은 7월을 고른다. 버튼을 누른 사람은 8월 보고서를 기다리지만 7월 수집이 돈다.
// 화면은 브라우저 시간이라 해외에서 열면 또 다른 달을 보여 준다.
//
// 보고서의 기준 시간대는 한국 시간이므로 거기에 맞춘다. 이 모듈은 브라우저 번들에도
// 들어가므로 node: 모듈을 가져오지 않는다.
const REPORT_TIME_ZONE = "Asia/Seoul";

const pad2 = (value) => String(value).padStart(2, "0");

// 지금이 한국에서 몇 년 몇 월인지. Intl 은 브라우저와 Node 양쪽에 있다.
export function currentMonthInSeoul(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: REPORT_TIME_ZONE, year: "numeric", month: "numeric",
  }).formatToParts(now);
  return {
    year: Number(parts.find((part) => part.type === "year").value),
    month: Number(parts.find((part) => part.type === "month").value),
  };
}

// 한 달의 범위. Date.UTC(year, month, 0) 은 그 달의 말일이라 윤년도 따로 다루지 않는다.
// 현지 시간 생성자(new Date(year, month, 0))를 쓰지 않는 이유는 같다: 시간대가 섞인다.
export function monthRange(year, month) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    year, month,
    month_value: `${year}-${pad2(month)}`,
    from_date: `${year}-${pad2(month)}-01`,
    to_date: `${year}-${pad2(month)}-${pad2(lastDay)}`,
  };
}

export function previousMonthRange(now = new Date()) {
  const { year, month } = currentMonthInSeoul(now);
  return month === 1 ? monthRange(year - 1, 12) : monthRange(year, month - 1);
}
