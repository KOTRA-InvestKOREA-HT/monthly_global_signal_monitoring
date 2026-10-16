import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { collectHtmlDateEvidence } from './collect_company_signals.mjs';
import { chooseDateEvidence, hasArticleBody, periodPlacement, reportEligible, resolveDateState } from './date_state.mjs';
import { groupArticles, sourceCandidates } from './local_report.mjs';
import { resolveReportPeriod } from './report_period.mjs';
import { publishedSignalCounts } from './review_report.mjs';

// 투자 시그널 파일에는 승인 행과 대시보드용 근접 후보(ai_signal_supported=false)가 함께 들어 있다. 예전에는 행 전체를
// 승인으로 세어 근접 후보까지 승인 건수에 들어갔다(35건 대 실제 18건). 보고서와 같은 집계(publishedSignalCounts)를 쓴다.
export function investmentCoverage(rows, period) {
  const counts = publishedSignalCounts(rows, period);
  const approved = rows.filter(row => row.ai_signal_supported !== false);
  return {
    approved_rows: counts.approved_count,
    near_miss_rows: counts.near_miss_count,
    approved_companies: new Set(approved.map(row => row.company)).size,
    report_rows: counts.report_signal_count,
    report_companies: [...new Set(approved.filter(row => reportEligible(row, period)).map(row => row.company))].sort(),
    date_pending_rows: counts.date_pending_count,
    out_of_period_rows: counts.out_of_period_count,
  };
}

function main() {
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  const signals = read('outputs/latest_company_signals.json');
  const summary = read('outputs/latest_collection_summary.json');
  const dateArgs = process.argv.slice(2);
  if (dateArgs.length !== 0 && dateArgs.length !== 2) {
    throw new Error('Usage: node scripts/audit_signal_coverage.mjs [YYYY-MM-DD YYYY-MM-DD]');
  }
  const period = resolveReportPeriod({
    REPORT_FROM_DATE: dateArgs[0] || summary.from_date,
    REPORT_TO_DATE: dateArgs[1] || summary.to_date,
  });
  const investment = read('outputs/latest_investment_signals.json');
  const investmentSummary = read('outputs/latest_investment_signal_summary.json');
  const technology = read('data/company_technology_map.json');
  const indicators = read('config/investment_signal_indicators.json');

  // Re-run only evidence that is preserved in the checked-in row. This measures
  // what the revised parser can recover without claiming that a new crawl ran.
  const reclassifications = [];
  const reparsed = signals.map(row => {
    if (resolveDateState(row).status !== 'unknown') return row;
    const evidenceText = `${row.title || ''} ${(row.content_text || '').slice(0, 4000)}`;
    const dates = chooseDateEvidence([
      ...(row.date_candidates || []),
      ...collectHtmlDateEvidence(evidenceText, row.url),
    ]);
    if (!(dates.published_at || dates.published_month)) return row;
    const updated = { ...row, ...dates };
    reclassifications.push({ company: row.company, title: row.title, url: row.url,
      before: periodPlacement(row, period).placement, after: periodPlacement(updated, period).placement,
      inferred_date: dates.published_at || dates.published_month,
      evidence_source: dates.published_at_source, evidence_status: dates.published_at_status });
    return updated;
  });

  const reviewSize = rows => {
    const candidates = sourceCandidates(rows, technology, indicators, period);
    const articles = groupArticles(candidates.investment, candidates.relevant, period);
    return { articles: articles.length,
      candidate_decisions: articles.reduce((count, article) => count + article.candidates.length, 0),
      deferred_collection_rows: candidates.deferred.length };
  };

  const officialCounts = summary.official_counts_by_company || {};
  const audit = {
    period,
    target_companies: Number(summary.canonical_company_count || summary.company_count),
    collected_rows: signals.length,
    companies_with_results: new Set(signals.map(row => row.company)).size,
    companies_without_results: summary.companies_without_results || [],
    official_rows: signals.filter(row => row.source_type === 'official').length,
    fallback_rows: signals.filter(row => row.source_type !== 'official').length,
    rows_with_any_content: signals.filter(row => String(row.content_text || '').trim()).length,
    rows_with_usable_body: signals.filter(hasArticleBody).length,
    fallback_rows_with_usable_body: signals.filter(row => row.source_type !== 'official' && hasArticleBody(row)).length,
    companies_without_official_results: Object.entries(officialCounts).filter(([, count]) => Number(count) === 0).map(([company]) => company),
    review_queue_before_date_fix: reviewSize(signals),
    review_queue_after_preserved_evidence_reparse: reviewSize(reparsed),
    date_reclassifications: reclassifications,
    investment: { ...investmentCoverage(investment, period), checked_in_summary: investmentSummary },
    interpretation: 'The five configured values are indicator categories. No five-company report cap is applied.',
  };

  console.log(JSON.stringify(audit, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
