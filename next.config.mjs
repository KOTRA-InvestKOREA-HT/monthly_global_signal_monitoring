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
    ...(vercel ? { "/api/report": [...archivedOutputFiles, ...pythonReportFiles] } : {}),
  },
  outputFileTracingIncludes: {
    "/api/signals": latestOutputFiles,
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
