/** @type {import('next').NextConfig} */
const latestOutputFiles = [
  "./outputs/latest_company_signals.json",
  "./outputs/latest_company_signals.csv",
  "./outputs/latest_collection_summary.json",
  "./outputs/latest_relevant_signals.json",
  "./outputs/latest_relevant_signals.csv",
  "./outputs/latest_relevance_summary.json",
  "./outputs/latest_investment_signals.json",
  "./outputs/latest_investment_signals.csv",
  "./outputs/latest_investment_signal_summary.json",
  "./outputs/latest_signal_relevance_classification.json",
  "./outputs/latest_investment_signal_classification.json",
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
      "./assets/fonts/*.ttf",
      "./scripts/build_pdf_report.py",
      "./config/investment_signal_indicators.json",
    ],
  },
};

export default nextConfig;
