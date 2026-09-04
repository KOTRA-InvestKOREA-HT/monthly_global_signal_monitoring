"use client";

// API 키 없이 보고서를 만드는 팀원용 화면.
// 설치·명령어·파일저장 없이 버튼과 붙여넣기만으로 끝나야 한다.
//
// 버튼만 있고 상태가 없으면 눌렸는지조차 알 수 없어 사용자가 계속 다시 누르게 되고, 그러면
// 실행이 서로를 취소한다. 그래서 진행 상황을 계속 조회해 지금 무슨 단계인지 보여주고,
// 실행 중에는 버튼을 잠근다. 실패할 때는 상태코드 대신 다음에 할 일을 문장으로 쓴다.
import { useCallback, useEffect, useState } from "react";

const BRIEF_URL = "/brief/report_brief.md";
const REPORT_URL = "/reports/latest_report.pdf";
const REPORT_EN_URL = "/reports/latest_report_en.pdf";
const POLL_MS = 6000;

const STATE_TEXT = {
  running: "진행 중",
  success: "완료",
  failed: "실패",
  cancelled: "취소됨",
};

function elapsed(startedAt) {
  if (!startedAt) return "";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds}초째`;
  return `${Math.floor(seconds / 60)}분 ${seconds % 60}초째`;
}

function RunStatus({ title, run, runningHint }) {
  if (!run) return <p className="statusLine muted">아직 실행한 적이 없습니다.</p>;
  return (
    <p className={`statusLine ${run.state}`}>
      <b>{title} {STATE_TEXT[run.state] || run.state}</b>
      {run.state === "running" ? <> · {run.step || "시작하는 중"} · {elapsed(run.startedAt)}</> : null}
      {run.state === "running" && runningHint ? <> · {runningHint}</> : null}
      {run.state === "failed" ? <> · <a href={run.url} target="_blank" rel="noreferrer">원인 보기</a></> : null}
    </p>
  );
}

export default function ManualReportPage() {
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/manual-report", { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setStatusError(body.error || "진행 상황을 확인하지 못했습니다.");
        return;
      }
      setStatus(body);
      setStatusError("");
    } catch (caught) {
      setStatusError(`서버에 연결하지 못했습니다: ${caught.message}`);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const preparing = status?.prepare?.state === "running";
  const building = status?.build?.state === "running";

  async function send(payload, label) {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/manual-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `요청이 거부되었습니다 (${response.status}).`);
      setNotice(body.message);
      setTimeout(refresh, 2500);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy("");
    }
  }

  async function copyBrief() {
    setError("");
    try {
      const response = await fetch(`${BRIEF_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error("아직 요청서가 없습니다. 1단계를 끝낸 뒤 다시 눌러 주세요.");
      await navigator.clipboard.writeText(await response.text());
      setCopied(true);
      setTimeout(() => setCopied(false), 4000);
    } catch (caught) {
      setError(caught.message);
    }
  }

  return (
    <main className="wrap">
      <h1>월간 보고서 만들기</h1>
      <p className="lead">아래 순서대로 하면 보고서가 만들어집니다. 프로그램 설치나 명령어 입력은 필요 없습니다.</p>

      {statusError ? (
        <p className="error">
          {statusError}
          <br />
          <span className="small">이 상태에서는 버튼을 눌러도 아무 일도 일어나지 않습니다. 관리자에게 알려 주세요.</span>
        </p>
      ) : null}

      <section className="step">
        <h2><span className="num">1</span> 자료 준비</h2>
        <p>기업 자료를 모아 판정 요청서를 만듭니다. 5~10분 걸립니다.</p>
        <button type="button" onClick={() => send({ action: "prepare" }, "prepare")} disabled={busy === "prepare" || preparing}>
          {busy === "prepare" ? "시작하는 중…" : preparing ? "진행 중…" : "자료 준비 시작"}
        </button>
        <RunStatus title="자료 준비" run={status?.prepare} runningHint="끝날 때까지 기다려 주세요" />
      </section>

      <section className="step">
        <h2><span className="num">2</span> AI에게 판정 요청</h2>
        <p>요청서를 복사해 ChatGPT나 Claude 대화창에 붙여넣으세요. 따로 질문을 적을 필요는 없습니다.</p>
        <div className="row">
          <button type="button" onClick={copyBrief} disabled={preparing}>{copied ? "복사했습니다" : "요청서 복사"}</button>
          <a className="link" href={BRIEF_URL} download>파일로 받기</a>
        </div>
        <p className="hint">답변이 중간에 끊기면 대화창에 <b>계속</b>이라고 입력하세요. 이어서 나온 내용까지 모두 필요합니다.</p>
      </section>

      <section className="step">
        <h2><span className="num">3</span> 답변 붙여넣기</h2>
        <p>AI가 답한 내용을 그대로 붙여넣으세요. 나눠 받았다면 이어서 모두 붙여넣습니다.</p>
        <textarea value={reply} onChange={(event) => setReply(event.target.value)} placeholder="AI 답변을 여기에 붙여넣으세요" rows={10} />
        <div className="row">
          <button
            type="button"
            onClick={() => send({ action: "build", reply }, "build")}
            disabled={busy === "build" || building || !reply.trim()}
          >
            {busy === "build" ? "시작하는 중…" : building ? "진행 중…" : "보고서 만들기"}
          </button>
          <span className="hint">{reply.trim() ? `${reply.trim().length.toLocaleString()}자 붙여넣음` : ""}</span>
        </div>
        <RunStatus title="보고서 생성" run={status?.build} runningHint="2~3분 걸립니다" />
      </section>

      <section className="step">
        <h2><span className="num">4</span> 보고서 받기</h2>
        <div className="row">
          <a className="link" href={REPORT_URL} target="_blank" rel="noreferrer">한글 보고서</a>
          <a className="link" href={REPORT_EN_URL} target="_blank" rel="noreferrer">영문 보고서</a>
        </div>
      </section>

      {notice ? <p className="notice">{notice}</p> : null}
      {error ? <p className="error">{error}</p> : null}

      <p className="foot">
        판정에 빠진 항목이 있거나 형식이 맞지 않으면 보고서를 만들지 않고 멈춥니다. 이때 기존 보고서는 그대로
        남으므로, 답변을 다시 받아 3단계부터 하시면 됩니다.
      </p>

      <style jsx>{`
        .wrap { max-width: 720px; margin: 0 auto; padding: 40px 20px 80px; color: #10243e; font-size: 15px; line-height: 1.7; }
        h1 { font-size: 26px; margin: 0 0 8px; }
        .lead { color: #56687b; margin: 0 0 24px; }
        .step { border: 1px solid #e4eaf0; border-radius: 10px; padding: 20px 22px; margin-bottom: 16px; background: #fff; }
        .step h2 { font-size: 17px; margin: 0 0 6px; display: flex; align-items: center; gap: 10px; }
        .num { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 50%; background: #122844; color: #fff; font-size: 14px; }
        .step p { margin: 0 0 14px; color: #56687b; }
        .row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
        button { background: #122844; color: #fff; border: 0; border-radius: 7px; padding: 11px 20px; font-size: 15px; cursor: pointer; }
        button:disabled { background: #98a4b4; cursor: default; }
        .link { color: #122844; text-decoration: underline; font-size: 15px; }
        textarea { width: 100%; box-sizing: border-box; border: 1px solid #d8dde4; border-radius: 7px; padding: 12px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; margin-bottom: 12px; resize: vertical; }
        .hint { color: #8591a3; font-size: 13.5px; margin: 12px 0 0; }
        .small { color: #8591a3; font-size: 13px; }
        .statusLine { margin: 14px 0 0; font-size: 14px; padding-top: 12px; border-top: 1px dashed #e4eaf0; }
        .statusLine.running { color: #0a7c72; }
        .statusLine.success { color: #10243e; }
        .statusLine.failed { color: #c0334d; }
        .statusLine.cancelled, .statusLine.muted { color: #8591a3; }
        .notice { background: #eaf7f4; border: 1px solid #9edcd3; border-radius: 7px; padding: 14px 16px; margin: 20px 0 0; }
        .error { background: #fdeef1; border: 1px solid #f4b8c4; border-radius: 7px; padding: 14px 16px; margin: 20px 0 0; }
        .foot { color: #8591a3; font-size: 13.5px; margin-top: 28px; }
      `}</style>
    </main>
  );
}
