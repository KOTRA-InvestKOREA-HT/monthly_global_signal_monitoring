// 웹 계층이 GitHub 를 부를 때 쓰는 설정. 세 라우트가 각자 환경변수를 읽던 것을 모았다.
//
// trigger-crawl 만 값을 다듬었고 crawl-status 와 signals 는 원값을 그대로 썼다. Vercel
// 환경변수에 따옴표나 줄바꿈이 섞여 들어가는 실수가 잦은데, 그러면 실행 버튼은 동작하지만
// 상태 표시는 "확인 실패"가 되고 신호 조회는 말없이 로컬 파일로 떨어진다. 화면에는 크롤링이
// 돌아간 흔적이 없는 것처럼 보인다. 읽는 방법을 한 곳에 둬야 세 화면이 같은 저장소를 본다.

// GITHUB_WORKFLOW_FILE, GITHUB_REF는 기본값이 있어 필수 항목에서 제외한다.
export const REQUIRED_GITHUB_ENV = ["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO"];

const CONFIG_KEY = {
  GITHUB_TOKEN: "token",
  GITHUB_OWNER: "owner",
  GITHUB_REPO: "repo",
  GITHUB_WORKFLOW_FILE: "workflowFile",
  GITHUB_REF: "ref",
};

export function envValue(name, fallback = "") {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return fallback;
  // Vercel 환경변수에 줄바꿈/공백/따옴표가 섞여 들어가는 실수가 잦아 여기서 정리한다.
  const cleaned = String(raw).trim().replace(/^["']|["']$/g, "");
  return cleaned || fallback;
}

export function githubConfig() {
  return {
    token: envValue("GITHUB_TOKEN"),
    owner: envValue("GITHUB_OWNER"),
    repo: envValue("GITHUB_REPO"),
    workflowFile: envValue("GITHUB_WORKFLOW_FILE", "collect-company-signals.yml"),
    ref: envValue("GITHUB_REF", "main"),
  };
}

export function missingGithubEnv(config = githubConfig()) {
  return REQUIRED_GITHUB_ENV.filter((name) => !config[CONFIG_KEY[name]]);
}

export function githubHeaders(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}
