/** @type {import('next').NextConfig} */

// Only ship files each Node route reads. Python's Vercel function has its own
// bundle; local/self-hosted builds still need the Python renderer's inputs.
const latestOutputFiles = [
  "./outputs/latest_company_signals.json",
  "./outputs/latest_collection_summary.json",
  "./outputs/latest_relevant_signals.json",
  "./outputs/latest_relevance_summary.json",
  "./outputs/latest_investment_signals.json",
  "./outputs/latest_investment_signal_summary.json",
];

const archivedOutputFiles = ["./outputs/*_20*.json", "./outputs/*_20*.csv"];
const pythonReportFiles = [
  ...latestOutputFiles.filter(file => !file.endsWith('/latest_collection_summary.json')),
  "./assets/fonts/NOTOSANSKR-VF.TTF",
  "./assets/fonts/NotoSansKR-*.ttf",
  "./assets/images/*.png",
  "./scripts/build_pdf_report.py",
  "./data/target_companies.json",
  "./data/company_technology_map.json",
  "./config/investment_signal_indicators.json",
  "./config/date_evidence_sources.json",
];
const vercel = process.env.VERCEL === "1";

const nextConfig = {
  reactStrictMode: true,
  outputFileTracingExcludes: {
    "/*": archivedOutputFiles,
    "/api/*": archivedOutputFiles,
    ...(vercel ? {
      "/api/report": [...archivedOutputFiles, ...pythonReportFiles],
      "/api/signals": [...archivedOutputFiles, ...latestOutputFiles],
    } : {}),
  },
  outputFileTracingIncludes: {
    // 이 파일들은 readGitHubJson 이 GITHUB_OWNER/REPO/TOKEN 중 하나라도 없을 때 쓰는
    // 로컬 폴백에만 필요하다. Vercel 에는 셋 다 설정돼 있어(크롤링 버튼이 같은 값을
    // 쓴다) 배포된 함수는 이 5.65MB 를 한 번도 열지 않는다. 로컬과 자체호스팅은
    // 그대로 싣는다. 자격증명 없이 배포할 일이 생기면 이 조건만 되돌리면 된다.
    "/api/signals": vercel ? [] : latestOutputFiles,
    "/api/report": [
      "./outputs/latest_collection_summary.json",
      "./public/reports/latest_report.pdf",
      "./public/reports/latest_report_en.pdf",
      "./assets/report-overlay/SemiBold.ttf",
      "./assets/report-overlay/DemiLight.ttf",
      ...(vercel ? [] : pythonReportFiles),
    ],
  },
};

export default nextConfig;
