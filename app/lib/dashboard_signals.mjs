// The dashboard needs summaries and source links, not the full review evidence.
// Keep field absence intact: published_at_source missing means legacy feed data.
export const DASHBOARD_SIGNAL_FIELDS = [
  'target_no', 'company', 'title', 'url', 'source', 'source_type', 'source_kind',
  'is_press_release', 'official_source_url', 'direct_source_url', 'source_direct_url',
  'detail_url', 'article_url', 'canonical_url', 'document_url',
  'published_at', 'published_month', 'published_at_source', 'date_conflict',
  'target_technology', 'investment_signal_no', 'investment_signal_id',
  'investment_signal_label', 'investment_signal_reason', 'relevance_reason',
  'technology_matched_terms', 'matched_terms', 'evidence_snippets', 'content_excerpt',
  'ai_signal_supported', 'ai_summary_headline_ko', 'ai_summary_detail_ko',
  'ai_summary_ko', 'ai_summary_tier',
];

export function dashboardSignals(rows) {
  return rows.map(row => Object.fromEntries(DASHBOARD_SIGNAL_FIELDS
    .filter(field => Object.hasOwn(row, field)).map(field => [field, row[field]])));
}
