"use client";

import { Calendar, Download, ExternalLink, Eye, EyeOff, ListChecks, Play, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

const SIGNAL_IGNORE_STORAGE_KEY = "global-signal-monitor.ignored-signals.v2";

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function shortList(values, limit = 6) {
  if (!Array.isArray(values)) return [];
  return values.filter(Boolean).slice(0, limit);
}

function sourceUrl(item) {
  const candidates = [
    item?.direct_source_url,
    item?.source_direct_url,
    item?.detail_url,
    item?.article_url,
    item?.canonical_url,
    item?.document_url,
    item?.url,
    item?.official_source_url,
  ];
  return candidates.find((value) => /^https?:\/\//i.test(String(value || "").trim())) || "#";
}

function normalizeSummaryText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/중순수%/g, "한 자릿수 중반대")
    .replace(/저순수%/g, "한 자릿수 초반대")
    .replace(/고순수%/g, "한 자릿수 후반대")
    .replace(/중순수/g, "한 자릿수 중반대")
    .replace(/저순수/g, "한 자릿수 초반대")
    .replace(/고순수/g, "한 자릿수 후반대")
    .replace(/중반 두 자릿수/g, "두 자릿수 중반대")
    .replace(/초반 두 자릿수/g, "두 자릿수 초반대")
    .replace(/후반 두 자릿수/g, "두 자릿수 후반대")
    .replace(/중반대 두 자릿수/g, "두 자릿수 중반대")
    .replace(/초반대 두 자릿수/g, "두 자릿수 초반대")
    .replace(/후반대 두 자릿수/g, "두 자릿수 후반대")
    .replace(/उपलब्ध성/g, "가용성")
    .trim();
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripSummaryLead(value, item) {
  let text = normalizeSummaryText(value);
  const company = item?.company ? escapeRegExp(item.company) : "";
  if (company) {
    text = text.replace(new RegExp(`^${company}(은|는|이|가)\\s+`), "");
  }
  return text
    .replace(/^[A-Za-z0-9().&/-]+(?:\s+[A-Za-z0-9().&/-]+){0,3}(은|는|이|가)\s+/, "")
    .replace(/^[가-힣A-Za-z0-9().·&/-]+(?:와\s+[가-힣A-Za-z0-9().·&/-]+)?(은|는|이|가)\s+/, "")
    .replace(/^(이는|다만|또한)\s+/g, "")
    .replace(/([A-Za-z][A-Za-z0-9().·&/-]*)의\s+/g, "$1 ")
    .trim();
}

function phraseEndingText(value) {
  let text = String(value || "").trim();
  const replacements = [
    [/확인되지\s+(않았다|않는다)$/g, "확인되지 않음"],
    [/제시되지\s+(않았다|않는다)$/g, "제시되지 않음"],
    [/나타나지\s+(않았다|않는다)$/g, "나타나지 않음"],
    [/부족하다$/g, "부족"],
    [/필요하다$/g, "필요"],
    [/계획이다$/g, "계획"],
    [/예정이다$/g, "예정"],
    [/목표로\s+하고\s+있다$/g, "목표"],
    [/추진\s+중이다$/g, "추진"],
    [/검토\s+중이다$/g, "검토"],
    [/진행\s+중이다$/g, "진행"],
    [/이어지고\s+있다$/g, "지속"],
    [/진행하고\s+있다$/g, "진행"],
    [/추진하고\s+있다$/g, "추진"],
    [/검토하고\s+있다$/g, "검토"],
    [/보여준다$/g, "시사"],
    [/시사한다$/g, "시사"],
    [/해석된다$/g, "해석"],
    [/판단된다$/g, "판단"],
    [/예상된다$/g, "예상"],
    [/확인된다$/g, "확인"],
    [/확인됐다$/g, "확인"],
    [/나타났다$/g, "확인"],
    [/언급됐다$/g, "언급"],
    [/언급했다$/g, "언급"],
    [/발표됐다$/g, "발표"],
    [/발표했다$/g, "발표"],
    [/공개했다$/g, "공개"],
    [/밝혔다$/g, "공개"],
    [/체결했다$/g, "체결"],
    [/서명했다$/g, "서명"],
    [/선임했다$/g, "선임"],
    [/인수했다$/g, "인수"],
    [/완료했다$/g, "완료"],
    [/가동했다$/g, "가동"],
    [/기록했다$/g, "기록"],
    [/제공한다$/g, "제공"],
    [/제공했다$/g, "제공"],
    [/지원한다$/g, "지원"],
    [/지원했다$/g, "지원"],
    [/적용한다$/g, "적용"],
    [/적용했다$/g, "적용"],
    [/수용했다$/g, "수용"],
    [/확대한다$/g, "확대"],
    [/확대했다$/g, "확대"],
    [/강화한다$/g, "강화"],
    [/강화했다$/g, "강화"],
    [/구축한다$/g, "구축"],
    [/구축했다$/g, "구축"],
    [/개발한다$/g, "개발"],
    [/개발했다$/g, "개발"],
    [/운영한다$/g, "운영"],
    [/운영했다$/g, "운영"],
    [/있다$/g, ""],
    [/없다$/g, "없음"],
    [/된다$/g, ""],
    [/됐다$/g, ""],
    [/한다$/g, ""],
    [/했다$/g, ""],
    [/이다$/g, ""],
  ];
  for (const [pattern, replacement] of replacements) {
    text = text.replace(pattern, replacement);
  }
  return text.trim();
}

function phraseifySummaryText(value, item) {
  const connectorMap = {
    "구축하고": "구축",
    "확보하고": "확보",
    "강화하고": "강화",
    "확대하고": "확대",
    "공급하고": "공급",
    "체결하고": "체결",
    "수행하고": "수행",
    "협력하고": "협력",
    "진행하고": "진행",
    "도입하고": "도입",
    "설치하고": "설치",
    "시연하고": "시연",
    "개발하고": "개발",
    "운영하고": "운영",
    "공개하고": "공개",
    "투자하고": "투자",
    "언급하고": "언급",
    "기록하고": "기록",
    "가동하고": "가동",
    "완료하고": "완료",
    "발표하고": "발표",
    "제공하며": "제공",
    "적용하며": "적용",
    "추진하며": "추진",
    "검토하며": "검토",
    "밝혔으며": "공개",
    "발표했으며": "발표",
    "체결했으며": "체결",
    "기록했으며": "기록",
    "확인했으며": "확인",
  };
  const connectorPattern = new RegExp(`(${Object.keys(connectorMap).join("|")})(,\\s*|\\s+|$)`, "g");
  const text = stripSummaryLead(value, item)
    .replace(/([A-Za-z][A-Za-z0-9().·&/-]*)의\s+/g, "$1 ")
    .replace(connectorPattern, (_, verb, separator) => `${connectorMap[verb]}${separator?.includes(",") ? ", " : " "}`)
    .replace(/영향을\s+(줄|미칠)\s+수\s+있다고\s+밝혔다/g, "영향 가능성 언급")
    .replace(/수\s+있다고\s+밝혔다/g, "가능성 언급")
    .replace(/됐다고\s+(공개|발표|언급)/g, " $1")
    .replace(/했다고\s+(공개|발표|언급)/g, " $1")
    .replace(/([가-힣A-Za-z0-9/·().-]+)(됐|되었|했다|였다|었다|았다)고\s+(공개|발표|언급)/g, "$1 $3")
    .replace(/(이라고 밝혔다|라고 밝혔다|다고 밝혔다|다고 발표했다|다고 설명했다|으로 확인됐다|로 확인됐다|이 확인됐다|가 확인됐다|를 확인했다|을 확인했다)/g, "")
    .replace(/\s+(다만|또한|그리고)\s+/g, ", ")
    .replace(/[.!?。]+/g, ". ");

  return text
    .split(/\s*\.\s*|\s*;\s*/)
    .map((clause) => phraseEndingText(clause.replace(/^(이는|다만|또한|그리고)\s+/g, "")))
    .filter(Boolean)
    .join(", ")
    .replace(/\s*,\s*,\s*/g, ", ")
    .replace(/(을|를)\s+(발표|공개|추진|검토|확보|제공|지원|적용|수용|확대|강화|구축|개발|운영|체결|서명|선임|인수|완료|가동|기록|시연|도입)(?=,|$)/g, " $2")
    .replace(/(을|를)\s+단계적으로\s+추진/g, " 단계적 추진")
    .replace(/확대할\s+계획/g, "확대 계획")
    .replace(/(을|를)\s+위험요인으로\s+언급/g, " 위험요인 언급")
    .replace(/영향을\s+위험요인으로\s+언급/g, "영향 위험요인 언급")
    .replace(/(에|에서|와|과|으로|로)\s+(서명|참여|협력|착수|진입|진출|투자|가동|운영|적용)(?=,|$)/g, " $2")
    .replace(/(이|가|은|는)\s+(확인|예상|증가|감소|지속|필요|부족|완료)(?=,|$)/g, " $2")
    .replace(/(재활용|가동|확보|활용|도입|설치|시연|개발|운영|제공|적용|수행|체결|추진|완료)해\s+/g, "$1·")
    .replace(/([가-힣A-Za-z0-9/·().-]+)하는\s+/g, "$1 ")
    .replace(/([가-힣A-Za-z0-9/·().-]+)하려는\s+움직임으로\s+해석/g, "$1 움직임")
    .replace(/계획은 확인되지 않음/g, "계획 확인되지 않음")
    .replace(/사실은 확인되지 않음/g, "사실 확인되지 않음")
    .replace(/근거는 확인되지 않음/g, "근거 확인되지 않음")
    .replace(/내용은 확인되지 않음/g, "내용 확인되지 않음")
    .replace(/관련성은 확인되지 않음/g, "관련성 확인되지 않음")
    .replace(/직접 연계는 확인되지 않음/g, "직접 연계 확인되지 않음")
    .replace(/직접적 연관성은 확인되지 않음/g, "직접 연관성 확인되지 않음")
    .replace(/연계도 확인되지 않음/g, "연계 확인되지 않음")
    .replace(/,\s+[가-힣A-Za-z0-9().·&/-]+(?:와\s+[가-힣A-Za-z0-9().·&/-]+)?(은|는)\s+/g, ", ")
    .replace(/가능성을\s+시사/g, "가능성")
    .replace(/,\s*(다만|또한)\s+/g, ", ")
    .replace(/\s*·\s*/g, "·")
    .replace(/\s+/g, " ")
    .trim();
}

function compactSummaryPhrase(value, limit = 90, item = null) {
  const text = phraseifySummaryText(value, item);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function summaryParts(item) {
  const headline = compactSummaryPhrase(item?.ai_summary_headline_ko, 58, item);
  const detail = compactSummaryPhrase(item?.ai_summary_detail_ko, 120, item);
  if (headline || detail) {
    return { headline: headline || compactSummaryPhrase(item?.ai_summary_ko, 58, item), detail };
  }

  const text = normalizeSummaryText(item?.ai_summary_ko);
  const dashed = text.split(/\s[-–—]\s/);
  if (dashed.length >= 2) {
    return {
      headline: compactSummaryPhrase(dashed[0], 58, item),
      detail: compactSummaryPhrase(dashed.slice(1).join(" - "), 120, item),
    };
  }
  const sentences = text.split(/(?<=[.!?。])\s+/).filter(Boolean);
  if (sentences.length >= 2) {
    return {
      headline: compactSummaryPhrase(sentences[0], 58, item),
      detail: compactSummaryPhrase(sentences.slice(1).join(" "), 120, item),
    };
  }
  const clauses = text.split(/,\s*/).filter(Boolean);
  if (clauses.length >= 2) {
    return {
      headline: compactSummaryPhrase(clauses[0], 58, item),
      detail: compactSummaryPhrase(clauses.slice(1).join(", "), 120, item),
    };
  }
  return { headline: compactSummaryPhrase(text, 58, item), detail: "" };
}

function AiSummaryText({ item }) {
  const parts = summaryParts(item);
  if (!parts.headline && !parts.detail) return null;
  return (
    <p className="evidenceText structuredSummary">
      <strong>{parts.headline}</strong>
      {parts.detail ? (
        <>
          <span className="summaryDash"> - </span>
          <span className="summaryDetail">{parts.detail}</span>
        </>
      ) : null}
    </p>
  );
}

function BusinessSummaryText({ item }) {
  const text = normalizeSummaryText(item?.ai_summary_ko);
  if (!text) return null;
  return <p className="evidenceText businessSummary">{text}</p>;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function defaultMonthValue() {
  const now = new Date();
  const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${previousMonth.getFullYear()}-${pad2(previousMonth.getMonth() + 1)}`;
}

function monthRange(monthValue) {
  const [yearText, monthText] = String(monthValue || defaultMonthValue()).split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const lastDay = new Date(year, month, 0).getDate();
  return {
    year,
    month,
    fromDate: `${year}-${pad2(month)}-01`,
    toDate: `${year}-${pad2(month)}-${pad2(lastDay)}`,
    label: `${year}년 ${month}월`,
  };
}

function dateOnly(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function isWithinPeriod(item, period) {
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
    .filter((value) => value !== undefined && value !== null && value !== "")
    .join("|");
}

function signalKey(item) {
  const bytes = new TextEncoder().encode(signalFingerprint(item));
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function investmentSortKey(item, mode) {
  const signalNo = Number(item.investment_signal_no) || 99;
  const targetNo = Number(item.target_no) || 999;
  const company = String(item.company || "");
  const published = new Date(item.published_at || 0).getTime() || 0;
  if (mode === "company") {
    return [targetNo, company, signalNo, -published];
  }
  return [signalNo, targetNo, company, -published];
}

function compareSortKeys(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

export default function HomePage() {
  const initialMonth = defaultMonthValue();
  const [monthValue, setMonthValue] = useState(initialMonth);
  const [pickerYear, setPickerYear] = useState(Number(initialMonth.slice(0, 4)));
  const [pickerMonth, setPickerMonth] = useState(Number(initialMonth.slice(5, 7)));
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);
  const [reportDialogOpen, setReportDialogOpen] = useState(false);
  const [ignoreDialogOpen, setIgnoreDialogOpen] = useState(false);
  const [issueNumber, setIssueNumber] = useState("2");
  const [signals, setSignals] = useState([]);
  const [relevantSignals, setRelevantSignals] = useState([]);
  const [investmentSignals, setInvestmentSignals] = useState([]);
  const [summary, setSummary] = useState(null);
  const [relevanceSummary, setRelevanceSummary] = useState(null);
  const [investmentSummary, setInvestmentSummary] = useState(null);
  const [investmentSortMode, setInvestmentSortMode] = useState("signal");
  const [ignoredSignalKeys, setIgnoredSignalKeys] = useState([]);
  const [crawlStatus, setCrawlStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [downloadingReport, setDownloadingReport] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const selectedPeriod = useMemo(() => monthRange(monthValue), [monthValue]);

  function openMonthPicker() {
    const current = monthRange(monthValue);
    setPickerYear(current.year);
    setPickerMonth(current.month);
    setMonthPickerOpen(true);
  }

  function applyMonthPicker() {
    const year = Number(pickerYear);
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      setError("조회 연도를 2000년부터 2100년 사이로 입력해 주세요.");
      return;
    }
    setMonthValue(`${year}-${pad2(pickerMonth)}`);
    setMonthPickerOpen(false);
    setError("");
  }

  async function downloadReport() {
    const safeIssue = String(issueNumber).replace(/[^\d]/g, "") || "2";
    setIssueNumber(safeIssue);
    const params = new URLSearchParams({
      issue: safeIssue,
      month: monthValue,
      from: selectedPeriod.fromDate,
      to: selectedPeriod.toDate,
    });
    if (ignoredSignalKeys.length) {
      params.set("ignored", ignoredSignalKeys.join(","));
    }
    setDownloadingReport(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/report?${params.toString()}`, { cache: "no-store" });
      if (!response.ok) {
        let errorMessage = "보고서를 생성하지 못했습니다.";
        try {
          const payload = await response.json();
          errorMessage = payload.error || errorMessage;
        } catch {
          errorMessage = await response.text();
        }
        throw new Error(errorMessage);
      }
      const blob = await response.blob();
      const objectUrl = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `global-signal-monitor-issue-${safeIssue}.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(objectUrl);

      const fallbackReason = response.headers.get("X-Report-Fallback");
      if (fallbackReason) {
        setMessage("선택 조건 반영 보고서 생성이 제한되어 최신 보고서 양식으로 다운로드했습니다.");
      }
      setReportDialogOpen(false);
    } catch (err) {
      setError(err.message || "보고서 다운로드에 실패했습니다.");
    } finally {
      setDownloadingReport(false);
    }
  }

  function ignoreSignal(item) {
    const key = signalKey(item);
    setIgnoredSignalKeys((current) => (current.includes(key) ? current : [...current, key]));
  }

  function unignoreSignal(key) {
    setIgnoredSignalKeys((current) => current.filter((item) => item !== key));
  }

  async function loadSignals() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/signals", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "데이터를 불러오지 못했습니다.");
      setSignals(payload.signals || []);
      setRelevantSignals(payload.relevantSignals || []);
      setInvestmentSignals(payload.investmentSignals || []);
      setSummary(payload.summary || null);
      setRelevanceSummary(payload.relevanceSummary || null);
      setInvestmentSummary(payload.investmentSummary || null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadCrawlStatus() {
    try {
      const response = await fetch("/api/crawl-status", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "크롤링 상태를 확인하지 못했습니다.");
      setCrawlStatus(payload);
      if (payload.label === "완료" || payload.label === "실패" || payload.label === "취소") {
        loadSignals();
      }
    } catch (err) {
      setCrawlStatus({ label: "확인 실패", status: "error", error: err.message });
    }
  }

  async function triggerCrawl() {
    setTriggering(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/trigger-crawl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromDate: selectedPeriod.fromDate,
          toDate: selectedPeriod.toDate,
          issueNumber,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "크롤링 실행 요청에 실패했습니다.");
      setCrawlStatus({ label: "진행 중", status: "queued", requested_at: payload.requested_at });
      setMessage(`${selectedPeriod.label} 기준으로 GitHub Actions 크롤링 실행을 요청했습니다. 진행 상태가 자동으로 갱신됩니다.`);
      window.setTimeout(loadCrawlStatus, 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setTriggering(false);
    }
  }

  useEffect(() => {
    loadSignals();
    loadCrawlStatus();
  }, []);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(SIGNAL_IGNORE_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          setIgnoredSignalKeys(parsed.filter(Boolean));
        }
      }
    } catch {
      setIgnoredSignalKeys([]);
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIGNAL_IGNORE_STORAGE_KEY, JSON.stringify(ignoredSignalKeys));
    } catch {
      // Ignore localStorage failures; the current in-memory choice still applies.
    }
  }, [ignoredSignalKeys]);

  useEffect(() => {
    if (crawlStatus?.label !== "진행 중") return undefined;
    const timer = window.setInterval(loadCrawlStatus, 10000);
    return () => window.clearInterval(timer);
  }, [crawlStatus?.label]);

  const displayedSignals = useMemo(() => signals.filter((item) => isWithinPeriod(item, selectedPeriod)), [selectedPeriod, signals]);
  const displayedRelevantSignals = useMemo(
    () => relevantSignals.filter((item) => isWithinPeriod(item, selectedPeriod)),
    [relevantSignals, selectedPeriod],
  );
  const ignoredSignalSet = useMemo(() => new Set(ignoredSignalKeys), [ignoredSignalKeys]);
  const periodInvestmentSignals = useMemo(
    () => investmentSignals.filter((item) => isWithinPeriod(item, selectedPeriod)),
    [investmentSignals, selectedPeriod],
  );
  const ignoredSignalEntries = useMemo(() => {
    const rowByKey = new Map();
    for (const item of periodInvestmentSignals) {
      const key = signalKey(item);
      if (!rowByKey.has(key)) {
        rowByKey.set(key, item);
      }
    }
    return ignoredSignalKeys.map((key) => ({ key, item: rowByKey.get(key) || null }));
  }, [ignoredSignalKeys, periodInvestmentSignals]);
  const displayedInvestmentSignals = useMemo(() => {
    return [...periodInvestmentSignals]
      .filter((item) => !ignoredSignalSet.has(signalKey(item)))
      .sort((left, right) => compareSortKeys(investmentSortKey(left, investmentSortMode), investmentSortKey(right, investmentSortMode)));
  }, [ignoredSignalSet, investmentSortMode, periodInvestmentSignals]);
  const collectedCompanyCount = useMemo(() => new Set(displayedSignals.map((item) => item.company).filter(Boolean)).size, [displayedSignals]);
  const officialCount = displayedSignals.filter((item) => item.source_type === "official").length;

  return (
    <main className="shell">
      <section className="topbar">
        <div>
          <h1>Global Signal Monitor</h1>
          <p>77개 타겟기업의 월간 뉴스, 보도자료, IR 신호를 확인합니다.</p>
        </div>
        <div className="actions">
          <div className="field">
            <span>조회 기간</span>
            <button className="periodButton" type="button" onClick={openMonthPicker}>
              <Calendar size={17} />
              <strong>{selectedPeriod.label}</strong>
              <small>
                {selectedPeriod.fromDate} ~ {selectedPeriod.toDate}
              </small>
            </button>
          </div>
          <button className="primary" onClick={triggerCrawl} disabled={triggering}>
            {triggering ? <RefreshCw className="spin" size={18} /> : <Play size={18} />}
            <span>{triggering ? "요청 중" : "크롤링 수행"}</span>
          </button>
          <button className="secondary" onClick={loadSignals} disabled={loading}>
            <RefreshCw className={loading ? "spin" : ""} size={18} />
            <span>새로고침</span>
          </button>
          <button className="downloadButton" type="button" onClick={() => setReportDialogOpen(true)}>
            <Download size={18} />
            <span>보고서 다운로드</span>
          </button>
        </div>
      </section>

      {monthPickerOpen ? (
        <div className="modalBackdrop" role="presentation" onMouseDown={() => setMonthPickerOpen(false)}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="month-picker-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modalHeader">
              <h2 id="month-picker-title">조회 기간</h2>
              <p>선택한 월의 1일부터 말일까지 자동으로 조회합니다.</p>
            </div>
            <label className="modalField">
              <span>연도</span>
              <input
                type="number"
                value={pickerYear}
                onChange={(event) => setPickerYear(event.target.value)}
                min="2000"
                max="2100"
              />
            </label>
            <div className="monthGrid" role="list" aria-label="월 선택">
              {Array.from({ length: 12 }, (_, index) => index + 1).map((month) => (
                <button
                  className={`monthOption ${Number(pickerMonth) === month ? "selected" : ""}`}
                  key={month}
                  type="button"
                  onClick={() => setPickerMonth(month)}
                >
                  {month}월
                </button>
              ))}
            </div>
            <div className="modalActions">
              <button className="secondary" type="button" onClick={() => setMonthPickerOpen(false)}>
                취소
              </button>
              <button className="primary" type="button" onClick={applyMonthPicker}>
                적용
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {reportDialogOpen ? (
        <div className="modalBackdrop" role="presentation" onMouseDown={() => setReportDialogOpen(false)}>
          <section className="modal compactModal" role="dialog" aria-modal="true" aria-labelledby="report-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modalHeader">
              <h2 id="report-dialog-title">보고서 다운로드</h2>
              <p>표지에 표시할 Issue 번호를 선택합니다.</p>
            </div>
            <label className="modalField">
              <span>Issue 번호</span>
              <input
                type="number"
                min="1"
                value={issueNumber}
                onChange={(event) => setIssueNumber(event.target.value)}
              />
            </label>
            <div className="modalActions">
              <button className="secondary" type="button" onClick={() => setReportDialogOpen(false)}>
                취소
              </button>
              <button className="primary" type="button" onClick={downloadReport} disabled={downloadingReport}>
                {downloadingReport ? "생성 중" : "다운로드"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {ignoreDialogOpen ? (
        <div className="modalBackdrop" role="presentation" onMouseDown={() => setIgnoreDialogOpen(false)}>
          <section className="modal ignoredModal" role="dialog" aria-modal="true" aria-labelledby="ignore-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modalHeader">
              <h2 id="ignore-dialog-title">무시 목록</h2>
              <p>
                {ignoredSignalKeys.length
                  ? `${ignoredSignalKeys.length}건의 시그널이 보고서와 화면 목록에서 제외됩니다.`
                  : "현재 무시한 시그널이 없습니다."}
              </p>
            </div>

            {ignoredSignalEntries.length ? (
              <div className="ignoredList">
                {ignoredSignalEntries.map(({ key, item }) => (
                  <article className="ignoredItem" key={key}>
                    <div>
                      <div className="ignoredMeta">
                        <span className="ignoredSignalNo">{item?.investment_signal_no || "-"}</span>
                        <strong>{item?.investment_signal_label || "현재 조회 기간에 없는 무시 항목"}</strong>
                        {item?.company ? <span>{item.company}</span> : null}
                      </div>
                      <p className="ignoredTitle">{item?.title || "이전 데이터에서 저장된 무시 항목입니다. 취소하면 목록에서 제거됩니다."}</p>
                      {item?.source ? <p className="ignoredSource">{item.source}</p> : null}
                    </div>
                    <button className="unignoreButton" type="button" onClick={() => unignoreSignal(key)}>
                      <Eye size={15} />
                      <span>무시 취소</span>
                    </button>
                  </article>
                ))}
              </div>
            ) : (
              <p className="ignoredEmpty">무시 처리한 항목이 생기면 이곳에서 개별로 되돌릴 수 있습니다.</p>
            )}

            <div className="modalActions">
              {ignoredSignalKeys.length ? (
                <button className="secondary" type="button" onClick={() => setIgnoredSignalKeys([])}>
                  전체 초기화
                </button>
              ) : null}
              <button className="primary" type="button" onClick={() => setIgnoreDialogOpen(false)}>
                닫기
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {message ? <div className="notice success">{message}</div> : null}
      {error ? <div className="notice error">{error}</div> : null}

      <section className="metrics">
        <div>
          <span>대상 기업</span>
          <strong>{summary?.company_count ?? 77}</strong>
        </div>
        <div>
          <span>수집 기업</span>
          <strong>{loading ? "-" : collectedCompanyCount}</strong>
        </div>
        <div>
          <span>수집 건수</span>
          <strong>{displayedSignals.length}</strong>
        </div>
        <div>
          <span>공식 출처</span>
          <strong>{officialCount}</strong>
        </div>
        <div>
          <span>기술 관련 후보</span>
          <strong>{relevanceSummary?.relevant_signal_count ?? relevantSignals.length}</strong>
        </div>
        <div>
          <span>투자 시그널</span>
          <strong>{displayedInvestmentSignals.length}</strong>
        </div>
        <div>
          <span>크롤링 상태</span>
          <strong className={crawlStatus?.label === "진행 중" ? "statusRunning" : ""}>
            {triggering ? "요청 중" : crawlStatus?.label || "대기"}
          </strong>
        </div>
        <div>
          <span>최근 실행</span>
          <strong>{formatDate(summary?.run_started_at)}</strong>
        </div>
      </section>

      <section className="panel investmentPanel">
        <div className="panelHeader">
          <div className="panelTitle">
            <h2>5대 투자동향 시그널</h2>
            <span>
              {loading
                ? "불러오는 중"
                : `${displayedInvestmentSignals.length}건 표시${ignoredSignalKeys.length ? ` · ${ignoredSignalKeys.length}건 무시` : ""}`}
            </span>
          </div>
          <div className="panelTools" aria-label="투자동향 시그널 표시 옵션">
            <div className="segmentedControl" role="group" aria-label="정렬 방식">
              <button
                className={investmentSortMode === "signal" ? "selected" : ""}
                type="button"
                onClick={() => setInvestmentSortMode("signal")}
                aria-pressed={investmentSortMode === "signal"}
              >
                시그널 순
              </button>
              <button
                className={investmentSortMode === "company" ? "selected" : ""}
                type="button"
                onClick={() => setInvestmentSortMode("company")}
                aria-pressed={investmentSortMode === "company"}
              >
                기업명 순
              </button>
            </div>
            <button className="resetIgnoreButton" type="button" onClick={() => setIgnoreDialogOpen(true)}>
              <ListChecks size={15} />
              <span>무시 목록 확인</span>
            </button>
          </div>
        </div>
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>시그널</th>
                <th>기업</th>
                <th>유치필요 품목</th>
                <th>제목 및 근거</th>
                <th>출처</th>
                <th>게시일</th>
                <th aria-label="open" />
                <th>처리</th>
              </tr>
            </thead>
            <tbody>
              {displayedInvestmentSignals.map((item) => (
                <tr key={`investment-${item.investment_signal_id}-${item.company}-${item.url}`}>
                  <td>
                    <div className="signalStack">
                      <span className="signalNo">{item.investment_signal_no}</span>
                      <strong>{item.investment_signal_label}</strong>
                    </div>
                  </td>
                  <td>{item.company}</td>
                  <td>
                    <div className="titleStack">
                      <strong>{item.target_technology}</strong>
                      {shortList(item.technology_matched_terms, 4).length ? (
                        <p className="reasonText">기술 매칭: {shortList(item.technology_matched_terms, 4).join(", ")}</p>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <div className="titleStack">
                      <strong>{item.title}</strong>
                      {item.investment_signal_reason ? <p className="reasonText">{item.investment_signal_reason}</p> : null}
                      {item.ai_summary_ko ? (
                        <AiSummaryText item={item} />
                      ) : (
                        shortList(item.evidence_snippets, 1).map((snippet) => (
                          <p className="evidenceText" key={snippet}>
                            {snippet}
                          </p>
                        ))
                      )}
                      {item.ai_summary_tier ? <p className="reasonText">AI 요약: {item.ai_summary_tier === "terra" ? "Terra 재요약" : "Luna 1차 요약"}</p> : null}
                      {shortList(item.matched_terms).length ? (
                        <div className="keywordList">
                          {shortList(item.matched_terms).map((term) => (
                            <span className="keywordPill" key={term}>
                              {term}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <div className="sourceStack">
                      <span className={`sourceBadge ${item.source_type === "official" ? "official" : "fallback"}`}>
                        {item.source_type === "official" ? "공식" : "대체"}
                      </span>
                      <span>{item.source}</span>
                    </div>
                  </td>
                  <td>{formatDate(item.published_at)}</td>
                  <td>
                    <a href={sourceUrl(item)} target="_blank" rel="noreferrer" aria-label={`${item.company} 투자 시그널 열기`}>
                      <ExternalLink size={17} />
                    </a>
                  </td>
                  <td>
                    <button className="ignoreButton" type="button" onClick={() => ignoreSignal(item)}>
                      <EyeOff size={15} />
                      <span>무시</span>
                    </button>
                  </td>
                </tr>
              ))}
              {!loading && displayedInvestmentSignals.length === 0 ? (
                <tr>
                  <td colSpan="8" className="empty">
                    표시할 투자동향 시그널이 없습니다.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel relevancePanel">
        <div className="panelHeader">
          <h2>기술 관련 후보</h2>
          <span>{loading ? "불러오는 중" : `${displayedRelevantSignals.length}건 전체 표시`}</span>
        </div>
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>기업</th>
                <th>유치필요 품목</th>
                <th>제목</th>
                <th>출처</th>
                <th>게시일</th>
                <th aria-label="open" />
              </tr>
            </thead>
            <tbody>
              {displayedRelevantSignals.map((item) => (
                <tr key={`relevant-${item.company}-${item.url}`}>
                  <td>{item.company}</td>
                  <td>{item.target_technology}</td>
                  <td>
                    <div className="titleStack">
                      <strong>{item.title}</strong>
                      {item.relevance_reason ? <p className="reasonText">{item.relevance_reason}</p> : null}
                      {item.ai_summary_ko ? (
                        <BusinessSummaryText item={item} />
                      ) : (
                        shortList(item.evidence_snippets, 1).map((snippet) => (
                          <p className="evidenceText" key={snippet}>
                            {snippet}
                          </p>
                        ))
                      )}
                      {item.ai_summary_tier ? <p className="reasonText">AI 요약: {item.ai_summary_tier === "terra" ? "Terra 재요약" : "Luna 1차 요약"}</p> : null}
                      {shortList(item.matched_terms).length ? (
                        <div className="keywordList">
                          {shortList(item.matched_terms).map((term) => (
                            <span className="keywordPill" key={term}>
                              {term}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <div className="sourceStack">
                      <span className={`sourceBadge ${item.source_type === "official" ? "official" : "fallback"}`}>
                        {item.source_type === "official" ? "공식" : "대체"}
                      </span>
                      <span>{item.source}</span>
                    </div>
                  </td>
                  <td>{formatDate(item.published_at)}</td>
                  <td>
                    <a href={sourceUrl(item)} target="_blank" rel="noreferrer" aria-label={`${item.company} 관련 후보 열기`}>
                      <ExternalLink size={17} />
                    </a>
                  </td>
                </tr>
              ))}
              {!loading && displayedRelevantSignals.length === 0 ? (
                <tr>
                  <td colSpan="6" className="empty">
                    표시할 기술 관련 후보가 없습니다.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="content">
        <div className="panel">
          <div className="panelHeader">
            <h2>전체 수집 결과</h2>
            <span>{loading ? "불러오는 중" : `${displayedSignals.length}건 전체 표시`}</span>
          </div>
          <div className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th>기업</th>
                  <th>제목</th>
                  <th>출처</th>
                  <th>게시일</th>
                  <th aria-label="open" />
                </tr>
              </thead>
              <tbody>
                {displayedSignals.map((item) => (
                  <tr key={`${item.company}-${item.url}`}>
                    <td>{item.company}</td>
                    <td>
                      <div className="titleStack">
                        <strong>{item.title}</strong>
                        {item.content_excerpt ? <p className="reasonText">{item.content_excerpt}</p> : null}
                      </div>
                    </td>
                    <td>
                      <div className="sourceStack">
                        <span className={`sourceBadge ${item.source_type === "official" ? "official" : "fallback"}`}>
                          {item.source_type === "official" ? "공식" : "대체"}
                        </span>
                        <span>{item.source}</span>
                      </div>
                    </td>
                    <td>{formatDate(item.published_at)}</td>
                    <td>
                      <a href={sourceUrl(item)} target="_blank" rel="noreferrer" aria-label={`${item.company} 기사 열기`}>
                        <ExternalLink size={17} />
                      </a>
                    </td>
                  </tr>
                ))}
                {!loading && displayedSignals.length === 0 ? (
                  <tr>
                    <td colSpan="5" className="empty">
                      표시할 수집 결과가 없습니다.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <aside className="panel sidePanel">
          <div className="panelHeader">
            <h2>미수집 기업</h2>
            <span>{summary?.companies_without_results?.length ?? 0}개</span>
          </div>
          <ul>
            {(summary?.companies_without_results || []).map((company) => (
              <li key={company}>{company}</li>
            ))}
          </ul>
        </aside>
      </section>
    </main>
  );
}
