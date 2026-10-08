// 보고서 라우트(Node)는 같은 배포의 Python 함수(/api/report-view-model)를 서버에서 한 번 더 부른다.
// 배포 보호(Vercel Authentication)가 켜져 있으면 이 호출은 로그인 화면으로 돌려보내진다. 브라우저의 로그인
// 쿠키는 보고서 라우트까지만 오고 이 호출에는 실리지 않기 때문이다. 2026-10-08 첫 보호 배포에서 다운로드가
// 로그인 화면 HTML 을 오류 문구로 띄웠다. 받은 쿠키를 넘기고, 자동화 우회 비밀값이 있으면 함께 보낸다.

// Settings → Deployment Protection → Protection Bypass for Automation 을 켜면 Vercel 이 이 변수를 넣어 준다.
export function internalRequestHeaders(incoming, env = process.env) {
  const headers = {};
  const cookie = incoming?.get?.("cookie");
  if (cookie) headers.cookie = cookie;
  const bypass = String(env.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim();
  if (bypass) headers["x-vercel-protection-bypass"] = bypass;
  return headers;
}

// 보호에 막힌 응답이면 그 사실을 알리는 문구, 아니면 null. 리디렉션을 따라가지 않으므로 막히면 3xx 나 401 이 온다.
// 본문(로그인 화면 HTML)을 그대로 오류로 내보내면 화면에 페이지 소스가 찍힌다.
export function protectionError(status, body = "") {
  const text = String(body || "");
  const blocked = (status >= 300 && status < 400) || status === 401
    || /^\s*<(!doctype|html)/i.test(text) || /Vercel Authentication/i.test(text);
  if (!blocked) return null;
  return `Vercel 배포 보호(Vercel Authentication)가 보고서 내용 계산 함수 호출을 막았습니다 (HTTP ${status}). `
    + "Vercel 프로젝트 Settings → Deployment Protection 에서 Protection Bypass for Automation 을 켠 뒤 재배포해 주세요.";
}
