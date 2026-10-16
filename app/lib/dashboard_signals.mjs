// The dashboard needs summaries and source links, not the full review evidence.
// Keep field absence intact: published_at_source missing means legacy feed data.
// 화면(app/page.jsx)도 이 모듈을 불러온다. 브라우저 번들에 들어가므로 node: 모듈을 가져오지 않는다.
//
// 레거시 키워드·요약 스크립트만 만들던 필드(matched_terms, evidence_snippets, ai_summary_tier,
// ai_summary_headline_ko, direct_source_url 등)는 2026-09 데이터에 한 건도 없어 뺐다.
export const DASHBOARD_SIGNAL_FIELDS = [
  'target_no', 'company', 'title', 'url', 'source', 'source_type', 'source_kind',
  'is_press_release', 'official_source_url', 'source_direct_url',
  'published_at', 'published_month', 'published_at_source', 'date_conflict',
  'target_technology', 'investment_signal_no', 'investment_signal_id',
  'investment_signal_label', 'content_excerpt',
  'ai_signal_supported', 'ai_summary_ko', 'ai_summary_reason',
];

export function dashboardSignals(rows) {
  return rows.map(row => Object.fromEntries(DASHBOARD_SIGNAL_FIELDS
    .filter(field => Object.hasOwn(row, field)).map(field => [field, row[field]])));
}

const MONTH_ONLY = /^(20\d{2})-(0[1-9]|1[0-2])$/;

// 게시월만 확인된 항목의 월. 일자가 있는 항목은 그 일자가 우선이다.
export function monthOnlyValue(item) {
  const published = String(item?.published_at || '').trim();
  if (published) return MONTH_ONLY.test(published) ? published : '';
  const month = String(item?.published_month || '').trim();
  return MONTH_ONLY.test(month) ? month : '';
}

function dateOnly(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

// period 는 { fromDate, toDate } (YYYY-MM-DD). 날짜를 모르는 항목은 남겨 검토 후보로 보인다.
export function isWithinPeriod(item, period) {
  // 게시월만 확인된 항목은 그 달이 조회 기간과 겹치면 남긴다.
  const month = monthOnlyValue(item);
  if (month) return month >= period.fromDate.slice(0, 7) && month <= period.toDate.slice(0, 7);
  const published = dateOnly(item?.published_at);
  if (!published) return true;
  return published >= period.fromDate && published <= period.toDate;
}

function signalFingerprint(item) {
  return [
    item.target_no,
    item.company,
    item.investment_signal_no,
  ]
    .filter((value) => value !== undefined && value !== null && value !== '')
    .join('|');
}

// 무시 목록의 키. 보고서 생성기(report_content.py)가 같은 FNV-1a 해시로 행을 찾는다.
// 바꾸면 저장된 무시 목록과 보고서가 어긋난다(키를 달별·기사별로 바꿀지는 보류 중, 감사 §4-6).
export function signalKey(item) {
  const bytes = new TextEncoder().encode(signalFingerprint(item));
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
