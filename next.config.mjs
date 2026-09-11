/** @type {import('next').NextConfig} */

// 함수 번들은 배포마다 통째로 저장되고 Hobby 의 Deployment Storage 한도는 10GB 다.
// 읽지 않는 파일 하나가 배포 횟수만큼 쌓이므로, 실제로 읽는 것만 싣는다.
// 아래 목록은 app/api/signals/route.js 와 app/api/report/route.js,
// api/report-dynamic.py 가 여는 경로를 대조해서 추린 것이다.
//
// 뺀 것: latest_*.csv 3개(3.0MB)와 latest_*_classification.json 2개(5.9MB).
// app/ 과 api/ 어디에서도 열지 않는다. 저장소에는 그대로 두고 번들에서만 뺀다.
const latestOutputFiles = [
  "./outputs/latest_company_signals.json",
  "./outputs/latest_collection_summary.json",
  "./outputs/latest_relevant_signals.json",
  "./outputs/latest_relevance_summary.json",
  "./outputs/latest_investment_signals.json",
  "./outputs/latest_investment_signal_summary.json",
];

const archivedOutputFiles = ["./outputs/*_20*.json", "./outputs/*_20*.csv"];

const nextConfig = {
  reactStrictMode: true,
  outputFileTracingExcludes: {
    "/*": archivedOutputFiles,
    "/api/*": archivedOutputFiles,
  },
  outputFileTracingIncludes: {
    "/api/signals": latestOutputFiles,
    "/api/report": [
      ...latestOutputFiles,
      "./public/reports/latest_report.pdf",
      "./public/reports/latest_report_en.pdf",
      // 글롭이던 것을 실제로 열리는 세 개로 좁힌다. route.js 는 pdf-lib 후처리에
      // SemiBold 와 DemiLight 를, build_pdf_report.py 는 가변 폰트 하나를 쓴다.
      // Medium 과 ExtraBold 는 HTML 렌더러만 쓰는데 그쪽은 GitHub Actions 에서 돈다.
      // 저장소에는 남겨 둔다. 지우면 보고서 빌드가 깨진다.
      "./assets/fonts/NOTOSANSKR-VF.TTF",
      "./assets/fonts/NotoSansKR-SemiBold.ttf",
      "./assets/fonts/NotoSansKR-DemiLight.ttf",
      "./scripts/build_pdf_report.py",
      // 시그널 제외·기간 변경 PDF 를 만들 때 build_pdf_report.py 가 여는 데이터다.
      // 파이썬이 여는 경로는 추적기가 볼 수 없어 직접 적어야 한다.
      "./data/target_companies.json",
      "./data/company_technology_map.json",
      "./config/investment_signal_indicators.json",
      "./config/date_evidence_sources.json",
    ],
  },
};

export default nextConfig;
