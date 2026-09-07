// 게시일 판정 기준을 한 곳에 둔다. 수집·검토·PDF가 각자 기준을 가지면 같은 기사가
// 화면과 보고서에서 다르게 취급된다.
// 날짜 상태와 내용 평가는 서로 독립이다. 날짜가 확정되지 않았다고 내용 판정까지 버리지 않는다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GRADES = JSON.parse(fs.readFileSync(path.join(ROOT, "config/date_evidence_sources.json"), "utf8"));
const CONFIRMED_SOURCES = new Set(GRADES.confirmed);
const PRIORITY = GRADES.priority;

export const DATE_STATUS_LABEL_KO = {
  confirmed: "게시일 확정",
  estimated: "게시일 추정",
  conflicting: "게시일 근거 충돌",
  unknown: "게시일 미상",
};

const MONTH_PATTERN = /^(20\d{2})-(0[1-9]|1[0-2])$/;

// 오프셋이 없는 값은 PDF 생성기와 같게 UTC로 읽는다. 기간 비교는 하루 단위 문자열로만 한다.
export function dayOf(value) {
  let text = String(value || "").trim();
  if (!text || MONTH_PATTERN.test(text)) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text)) text += "Z";
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : "";
}

export function monthOf(value) {
  const text = String(value || "").trim();
  if (MONTH_PATTERN.test(text)) return text;
  const day = dayOf(text);
  return day ? day.slice(0, 7) : "";
}

export function evidenceGrade(source) {
  return CONFIRMED_SOURCES.has(String(source || "")) ? "confirmed" : "estimated";
}

export function hasArticleBody(row) {
  return Boolean(String(row?.content_text || row?.content_excerpt || "").trim());
}

function rank(item) {
  const index = PRIORITY.indexOf(String(item?.source || ""));
  return index === -1 ? PRIORITY.length : index;
}

// 정밀도가 다른 두 근거는 겹치는 범위가 있으면 같은 날짜로 본다.
// 8월 기사에 붙은 "2026-08"과 "2026-08-14"는 어긋난 근거가 아니다.
function sameDate(left, right) {
  if (left.date && right.date) return dayOf(left.date) === dayOf(right.date);
  return monthOf(left.month || left.date) === monthOf(right.month || right.date);
}

// 근거가 여럿이면 가장 강한 것을 게시일로 삼고, 나머지는 충돌 판정과 사후 확인을 위해 남긴다.
export function chooseDateEvidence(candidates = []) {
  // 같은 근거가 수집·보강 단계마다 다시 들어오므로 한 번만 남긴다.
  const unique = new Map();
  for (const item of candidates) {
    if (!item || !(item.date || item.month)) continue;
    const key = `${item.source}|${item.kind}|${item.date || item.month}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  const evidence = [...unique.values()].sort((a, b) => rank(a) - rank(b));
  const published = evidence.filter((item) => item.kind === "published");
  const chosen = published[0] || evidence[0] || null;
  const modified = evidence.find((item) => item.kind === "modified");
  const empty = {
    published_at: null,
    published_month: "",
    published_at_source: "",
    published_at_precision: "none",
    published_at_status: "unknown",
    modified_at: modified?.date || "",
    date_conflict: false,
    date_candidates: evidence,
  };
  if (!chosen) return empty;
  // 확정 근거끼리 어긋나면 어느 한쪽을 임의로 고르지 않고 충돌로 남긴다.
  // 공식 목록은 8월인데 기사 게시일이 7월인 경우가 여기에 해당한다.
  const conflict = published
    .filter((item) => evidenceGrade(item.source) === "confirmed")
    .some((item) => !sameDate(item, chosen));
  return {
    published_at: chosen.date || null,
    published_month: chosen.month || monthOf(chosen.date),
    published_at_source: chosen.source || "",
    published_at_precision: chosen.date ? "day" : "month",
    published_at_status: conflict ? "conflicting" : evidenceGrade(chosen.source),
    modified_at: modified?.date || "",
    date_conflict: conflict,
    date_candidates: evidence,
  };
}

// 근거 추적 이전에 모은 자료는 published_at_source 필드 자체가 없다. 그때의 날짜는 피드 게시일뿐이었으므로
// 확정으로 본다. 필드가 있는데 비어 있다면 근거를 찾다 실패한 것이므로 추정으로 낮춘다.
export function resolveDateState(row = {}) {
  const day = dayOf(row.published_at);
  const month = day ? day.slice(0, 7) : monthOf(row.published_month || row.published_at);
  const candidates = Array.isArray(row.date_candidates) ? row.date_candidates : [];
  if (!day && !month) return { status: "unknown", precision: "none", day: "", month: "", source: "", candidates };
  const tracked = "published_at_source" in row;
  const source = tracked ? String(row.published_at_source || "") : "legacy_feed";
  const grade = tracked ? evidenceGrade(source) : "confirmed";
  return {
    status: row.date_conflict === true ? "conflicting" : grade,
    precision: day ? "day" : "month",
    day,
    month,
    source,
    candidates,
  };
}

function lastDayOfMonth(month) {
  const next = new Date(`${month}-01T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return new Date(next.getTime() - 86400000).toISOString().slice(0, 10);
}

function coversWholeMonth(period, month) {
  return period.from_date <= `${month}-01` && period.to_date >= lastDayOfMonth(month);
}

function dayInPeriod(day, period) {
  return Boolean(day) && day >= period.from_date && day <= period.to_date;
}

function monthTouchesPeriod(month, period) {
  return Boolean(month) && `${month}-01` <= period.to_date && lastDayOfMonth(month) >= period.from_date;
}

function touchesPeriod(state, period) {
  return state.precision === "day" ? dayInPeriod(state.day, period) : monthTouchesPeriod(state.month, period);
}

// 기간 배치는 세 갈래다.
// in_period: 게시월까지 확정돼 월간 보고서 본문에 쓸 수 있다.
// date_pending: 내용 검토는 하되 날짜가 보강되기 전에는 본문에 넣지 않는다.
// out_of_period: 확인된 근거가 이번 기간을 가리키지 않는다.
export function periodPlacement(row, period) {
  const state = resolveDateState(row);
  const hold = (reason) => ({ placement: "date_pending", state, reason });
  if (state.status === "unknown") return hold("게시일 근거가 전혀 없음");
  const touches = touchesPeriod(state, period);
  if (state.status === "conflicting") {
    const anyTouches = touches || state.candidates.some((item) =>
      touchesPeriod({ precision: item.date ? "day" : "month", day: dayOf(item.date), month: monthOf(item.month || item.date) }, period));
    return anyTouches ? hold("게시일 근거가 서로 어긋남") : { placement: "out_of_period", state, reason: "충돌한 근거가 모두 기간 밖" };
  }
  if (!touches) return { placement: "out_of_period", state, reason: "확인된 게시일이 기간 밖" };
  if (state.status === "estimated") return hold(`추정 근거(${state.source})만 확인됨`);
  // 공식 자료로 게시월까지 확인되면 정확한 일자가 없어도 그 달 보고서 후보로 인정한다.
  // 다만 선택 기간이 월 전체가 아니면 그 구간에 들어가는지 따로 확인해야 한다.
  if (state.precision === "month" && !coversWholeMonth(period, state.month)) {
    return hold("게시월만 확정되어 선택 기간 포함 여부를 확인할 수 없음");
  }
  return { placement: "in_period", state, reason: "" };
}

export function reportEligible(row, period) {
  return periodPlacement(row, period).placement === "in_period";
}

// 미상 기사까지 무제한으로 검토 대상에 넣으면 한정된 호출을 날짜가 아니라 빈 링크에 쓰게 된다.
// 본문이 있는 기사부터 검토하고, 본문도 근거도 없는 링크는 수집 보완 대상으로 남긴다.
export function reviewCandidate(row, period) {
  const placement = periodPlacement(row, period);
  if (placement.placement === "out_of_period") return { ...placement, included: false };
  if (placement.placement === "date_pending" && placement.state.status === "unknown" && !hasArticleBody(row)) {
    return { ...placement, included: false, reason: "게시일 근거와 본문이 모두 없어 수집 보완 대상" };
  }
  return { ...placement, included: true };
}

export function dateLabelKo(row) {
  const state = resolveDateState(row);
  if (state.status === "unknown") return "게시일 미상";
  const [year, month] = state.month.split("-");
  const date = state.precision === "day"
    ? state.day.replace(/-/g, ".")
    : `${year}년 ${Number(month)}월 · 일자 미상`;
  return state.status === "confirmed" ? date : `${date} (${DATE_STATUS_LABEL_KO[state.status]})`;
}
