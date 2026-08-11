"use client";

import { ExternalLink, Play, RefreshCw } from "lucide-react";
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

export default function HomePage() {
  const [days, setDays] = useState("45");
  const [signals, setSignals] = useState([]);
  const [relevantSignals, setRelevantSignals] = useState([]);
  const [summary, setSummary] = useState(null);
  const [relevanceSummary, setRelevanceSummary] = useState(null);
  const [crawlStatus, setCrawlStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function loadSignals() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/signals", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "데이터를 불러오지 못했습니다.");
      setSignals(payload.signals || []);
      setRelevantSignals(payload.relevantSignals || []);
      setSummary(payload.summary || null);
      setRelevanceSummary(payload.relevanceSummary || null);
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
        body: JSON.stringify({ days }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "크롤링 실행 요청에 실패했습니다.");
      setCrawlStatus({ label: "진행 중", status: "queued", requested_at: payload.requested_at });
      setMessage("GitHub Actions 크롤링 실행을 요청했습니다. 진행 상태가 자동으로 갱신됩니다.");
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
  const officialCount = summary?.official_result_count ?? signals.filter((item) => item.source_type === "official").length;

  return (
    <main className="shell">
      <section className="topbar">
        <div>
          <h1>Global Signal Monitor</h1>
          <p>77개 타겟기업의 월간 뉴스, 보도자료, IR 신호를 확인합니다.</p>
        </div>
        <div className="actions">
          <label className="field">
            <span>조회 기간</span>
            <input value={days} onChange={(event) => setDays(event.target.value)} inputMode="numeric" />
          </label>
          <button className="primary" onClick={triggerCrawl} disabled={triggering}>
            {triggering ? <RefreshCw className="spin" size={18} /> : <Play size={18} />}
            <span>{triggering ? "요청 중" : "크롤링 수행"}</span>
          </button>
          <button className="secondary" onClick={loadSignals} disabled={loading}>
            <RefreshCw className={loading ? "spin" : ""} size={18} />
            <span>새로고침</span>
          </button>
        </div>
      </section>

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
