"use client";

// API 키 없이 보고서를 만드는 팀원용 화면.
// 설치·명령어·파일저장 없이 버튼과 붙여넣기만으로 끝나야 한다. 그래서 단계를 셋으로 고정하고,
// 실패할 때는 상태코드 대신 다음에 무엇을 하면 되는지를 문장으로 보여준다.
import { useState } from "react";

const BRIEF_URL = "/brief/report_brief.md";
const REPORT_URL = "/reports/latest_report.pdf";
const REPORT_EN_URL = "/reports/latest_report_en.pdf";

async function postManualReport(payload) {
  const response = await fetch("/api/manual-report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "요청을 처리하지 못했습니다.");
  return body;
}

export default function ManualReportPage() {
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  async function prepare() {
    setBusy("prepare");
    setError("");
    setNotice("");
    try {
      const result = await postManualReport({ action: "prepare" });
      setNotice(result.message);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy("");
    }
  }

  async function copyBrief() {
    setError("");
    try {
      const response = await fetch(`${BRIEF_URL}?t=${Date.now()}`);
      if (!response.ok) throw new Error("아직 자료가 준비되지 않았습니다. 1단계를 먼저 실행하고 5~10분 기다려 주세요.");
      await navigator.clipboard.writeText(await response.text());
      setCopied(true);
      setTimeout(() => setCopied(false), 4000);
    } catch (caught) {
      setError(caught.message);
    }
  }

  async function build() {
    setBusy("build");
    setError("");
    setNotice("");
    try {
      const result = await postManualReport({ action: "build", reply });
      setNotice(result.message);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy("");
    }
  }

  return (
    <main className="wrap">
      <h1>월간 보고서 만들기</h1>
      <p className="lead">
        아래 순서대로 하면 보고서가 만들어집니다. 프로그램을 설치하거나 명령어를 입력할 필요는 없습니다.
      </p>

      <section className="step">
        <h2><span className="num">1</span> 자료 준비</h2>
        <p>기업 자료를 모아 판정 요청서를 만듭니다. 누른 뒤 5~10분 정도 걸립니다.</p>
        <button type="button" onClick={prepare} disabled={busy === "prepare"}>
          {busy === "prepare" ? "시작하는 중…" : "자료 준비 시작"}
        </button>
      </section>

      <section className="step">
        <h2><span className="num">2</span> AI에게 판정 요청</h2>
        <p>
          아래 버튼을 누르면 요청서가 복사됩니다. ChatGPT나 Claude 대화창에 붙여넣고 답변을 받으세요.
          별도로 질문을 적을 필요는 없습니다.
        </p>
        <div className="row">
          <button type="button" onClick={copyBrief}>{copied ? "복사했습니다" : "요청서 복사"}</button>
          <a className="link" href={BRIEF_URL} download>파일로 받기</a>
        </div>
        <p className="hint">
          답변이 중간에 끊기면 대화창에 <b>계속</b>이라고 입력하세요. 이어서 나온 내용까지 모두 필요합니다.
        </p>
      </section>

      <section className="step">
        <h2><span className="num">3</span> 답변 붙여넣기</h2>
        <p>AI가 답한 내용을 그대로 붙여넣으세요. 여러 번에 나눠 받았다면 이어서 모두 붙여넣습니다.</p>
        <textarea
          value={reply}
          onChange={(event) => setReply(event.target.value)}
          placeholder="AI 답변을 여기에 붙여넣으세요"
          rows={10}
        />
        <div className="row">
          <button type="button" onClick={build} disabled={busy === "build" || !reply.trim()}>
            {busy === "build" ? "시작하는 중…" : "보고서 만들기"}
          </button>
          <span className="hint">{reply.trim() ? `${reply.trim().length.toLocaleString()}자 붙여넣음` : ""}</span>
        </div>
      </section>

      <section className="step">
        <h2><span className="num">4</span> 보고서 받기</h2>
        <p>3단계 후 2~3분 뒤에 받을 수 있습니다.</p>
        <div className="row">
          <a className="link" href={REPORT_URL} target="_blank" rel="noreferrer">한글 보고서</a>
          <a className="link" href={REPORT_EN_URL} target="_blank" rel="noreferrer">영문 보고서</a>
        </div>
      </section>

      {notice ? <p className="notice">{notice}</p> : null}
      {error ? <p className="error">{error}</p> : null}

      <p className="foot">
        판정에 빠진 항목이 있거나 형식이 맞지 않으면 보고서를 만들지 않고 멈춥니다. 이때 기존 보고서는
        그대로 남아 있으므로, 답변을 다시 받아 3단계부터 하시면 됩니다.
      </p>

      <style jsx>{`
        .wrap { max-width: 720px; margin: 0 auto; padding: 40px 20px 80px; color: #10243e; font-size: 15px; line-height: 1.7; }
        h1 { font-size: 26px; margin: 0 0 8px; }
        .lead { color: #56687b; margin: 0 0 28px; }
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
        .notice { background: #eaf7f4; border: 1px solid #9edcd3; border-radius: 7px; padding: 14px 16px; margin: 20px 0 0; }
        .error { background: #fdeef1; border: 1px solid #f4b8c4; border-radius: 7px; padding: 14px 16px; margin: 20px 0 0; }
        .foot { color: #8591a3; font-size: 13.5px; margin-top: 28px; }
      `}</style>
    </main>
  );
}
