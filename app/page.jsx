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

export default function HomePage() {
  const [days, setDays] = useState("45");
  const [signals, setSignals] = useState([]);
  const [summary, setSummary] = useState(null);
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
      setSummary(payload.summary || null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
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
      setMessage("GitHub Actions 크롤링 실행을 요청했습니다. 완료 후 새로고침하면 최신 결과가 보입니다.");
    } catch (err) {
      setError(err.message);
    } finally {
      setTriggering(false);
    }
  }

  useEffect(() => {
    loadSignals();
  }, []);

  const recentSignals = useMemo(() => signals.slice(0, 40), [signals]);

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
          <span>최근 실행</span>
          <strong>{formatDate(summary?.run_started_at)}</strong>
        </div>
      </section>

      <section className="content">
        <div className="panel">
          <div className="panelHeader">
            <h2>최근 수집 결과</h2>
            <span>{loading ? "불러오는 중" : `${recentSignals.length}건 표시`}</span>
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
                {recentSignals.map((item) => (
                  <tr key={`${item.company}-${item.url}`}>
                    <td>{item.company}</td>
                    <td>{item.title}</td>
                    <td>{item.source}</td>
                    <td>{formatDate(item.published_at)}</td>
                    <td>
                      <a href={item.url} target="_blank" rel="noreferrer" aria-label={`${item.company} 기사 열기`}>
                        <ExternalLink size={17} />
                      </a>
                    </td>
                  </tr>
                ))}
                {!loading && recentSignals.length === 0 ? (
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
