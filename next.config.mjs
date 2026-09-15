/** @type {import('next').NextConfig} */

// Only ship files each Node route reads. Python's Vercel function has its own
// bundle; local/self-hosted builds still need the Python view model's inputs.
const latestOutputFiles = [
  "./outputs/latest_company_signals.json",
  "./outputs/latest_collection_summary.json",
  "./outputs/latest_relevant_signals.json",
  "./outputs/latest_relevance_summary.json",
  "./outputs/latest_investment_signals.json",
  "./outputs/latest_investment_signal_summary.json",
];

const archivedOutputFiles = ["./outputs/*_20*.json", "./outputs/*_20*.csv"];
// The HTML report's own fonts and images, read by Chromium through file:// URLs.
const reportRenderFiles = [
  "./assets/fonts/NotoSansKR-DemiLight.ttf",
  "./assets/fonts/NotoSansKR-Medium.ttf",
  "./assets/fonts/NotoSansKR-SemiBold.ttf",
  "./assets/fonts/NotoSansKR-ExtraBold.ttf",
  "./assets/images/*.png",
];
// Inputs for scripts/report_view_model.py. On Vercel api/report-view-model.py
// computes the view model, so the Node route never ships these.
const viewModelFiles = [
  ...latestOutputFiles,
  "./assets/fonts/NOTOSANSKR-VF.TTF",
  "./scripts/report_view_model.py",
  "./scripts/build_pdf_report.py",
  "./data/target_companies.json",
  "./data/company_technology_map.json",
  "./config/investment_signal_indicators.json",
  "./config/date_evidence_sources.json",
];
// @sparticuz/chromium decompresses its browser from these files at runtime; the
// tracer does not follow them on its own. pnpm keeps the real copy under .pnpm.
const chromiumFiles = [
  "./node_modules/@sparticuz/chromium/bin/**",
  "./node_modules/.pnpm/@sparticuz+chromium@*/node_modules/@sparticuz/chromium/bin/**",
];
const vercel = process.env.VERCEL === "1";

const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
  outputFileTracingExcludes: {
    "/*": archivedOutputFiles,
    "/api/*": archivedOutputFiles,
    ...(vercel ? {
      "/api/report": [...archivedOutputFiles, ...viewModelFiles],
      "/api/signals": [...archivedOutputFiles, ...latestOutputFiles],
    } : {}),
  },
  outputFileTracingIncludes: {
    // 이 파일들은 readGitHubJson 이 GITHUB_OWNER/REPO/TOKEN 중 하나라도 없을 때 쓰는
    // 로컬 폴백에만 필요하다. Vercel 에는 셋 다 설정돼 있어(크롤링 버튼이 같은 값을
    // 쓴다) 배포된 함수는 이 5.65MB 를 한 번도 열지 않는다. 로컬과 자체호스팅은
    // 그대로 싣는다. 자격증명 없이 배포할 일이 생기면 이 조건만 되돌리면 된다.
    "/api/signals": vercel ? [] : latestOutputFiles,
    "/api/report": [...reportRenderFiles, ...(vercel ? chromiumFiles : viewModelFiles)],
  },
};

export default nextConfig;
