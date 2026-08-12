"use client";

import { Calendar, Download, ExternalLink, Play, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

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

export default function HomePage() {
  const initialMonth = defaultMonthValue();
  const [monthValue, setMonthValue] = useState(initialMonth);
  const [pickerYear, setPickerYear] = useState(Number(initialMonth.slice(0, 4)));
  const [pickerMonth, setPickerMonth] = useState(Number(initialMonth.slice(5, 7)));
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);
  const [reportDialogOpen, setReportDialogOpen] = useState(false);
  const [issueNumber, setIssueNumber] = useState("2");
  const [signals, setSignals] = useState([]);
  const [relevantSignals, setRelevantSignals] = useState([]);
  const [investmentSignals, setInvestmentSignals] = useState([]);
  const [summary, setSummary] = useState(null);
  const [relevanceSummary, setRelevanceSummary] = useState(null);
  const [investmentSummary, setInvestmentSummary] = useState(null);
  const [crawlStatus, setCrawlStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);
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

  function downloadReport() {
    const safeIssue = String(issueNumber).replace(/[^\d]/g, "") || "2";
    setIssueNumber(safeIssue);
    const params = new URLSearchParams({
      issue: safeIssue,
      month: monthValue,
      from: selectedPeriod.fromDate,
      to: selectedPeriod.toDate,
    });
    window.open(`/api/report?${params.toString()}`, "_blank", "noopener,noreferrer");
    setReportDialogOpen(false);
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
    if (crawlStatus?.label !== "진행 중") return undefined;
    const timer = window.setInterval(loadCrawlStatus, 10000);
    return () => window.clearInterval(timer);
  }, [crawlStatus?.label]);

  const displayedSignals = useMemo(() => signals, [signals]);
  const displayedRelevantSignals = useMemo(() => relevantSignals, [relevantSignals]);
  const displayedInvestmentSignals = useMemo(() => investmentSignals, [investmentSignals]);
  const officialCount = summary?.official_result_count ?? signals.filter((item) => item.source_type === "official").length;

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
              <button className="primary" type="button" onClick={downloadReport}>
                다운로드
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
          <strong>{summary?.companies_with_results ?? "-"}</strong>
        </div>
        <div>
          <span>수집 건수</span>
          <strong>{summary?.result_count ?? signals.length}</strong>
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
          <strong>{investmentSummary?.investment_signal_count ?? investmentSignals.length}</strong>
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
          <h2>5대 투자동향 시그널</h2>
          <span>{loading ? "불러오는 중" : `${displayedInvestmentSignals.length}건 전체 표시`}</span>
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
                      {shortList(item.evidence_snippets, 1).map((snippet) => (
                        <p className="evidenceText" key={snippet}>
                          {snippet}
                        </p>
                      ))}
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
                    <a href={item.url} target="_blank" rel="noreferrer" aria-label={`${item.company} 투자 시그널 열기`}>
                      <ExternalLink size={17} />
                    </a>
                  </td>
                </tr>
              ))}
              {!loading && displayedInvestmentSignals.length === 0 ? (
                <tr>
                  <td colSpan="7" className="empty">
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
                      {shortList(item.evidence_snippets, 1).map((snippet) => (
                        <p className="evidenceText" key={snippet}>
                          {snippet}
                        </p>
                      ))}
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
                    <a href={item.url} target="_blank" rel="noreferrer" aria-label={`${item.company} 관련 후보 열기`}>
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
                      <a href={item.url} target="_blank" rel="noreferrer" aria-label={`${item.company} 기사 열기`}>
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
