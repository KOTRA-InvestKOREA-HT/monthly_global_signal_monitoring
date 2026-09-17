// 2026-08 보고서(실행 35167466191) 검토에서 확인된 실패 사례의 재발 방지.
// 이 테스트들은 재검토 대상 선택과 저장 경로를 검증한다. 모델의 의미 판정 자체를 검증하지는 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reviewArticles, requestReview, facilityStageSuspects, fundingSuspects, needsFundingReview, needsFacilityStageReview,
  needsTechnologyReview, needsSummaryRefresh, summaryStyleProblems, withoutUnverifiedRejectedQuotes } from '../scripts/review_report.mjs';
import { groupArticles, importReview } from '../scripts/local_report.mjs';

const period = { from_date: '2026-08-01', to_date: '2026-08-31' };
const ROUND = 'The National Wealth Fund’s commitment of £52.6 million marks the completion of Nexeon’s latest investment round totalling £100 million.';
const USE = 'The financing will support Nexeon’s development of a UK-based pilot manufacturing facility and the expansion of its advanced manufacturing technology unit.';
const BODY = `${ROUND} ${USE} The company thanked its shareholders and said the round strengthens its balance sheet for the next stage of growth, `
  + 'while its management team continues to work with customers on qualification programmes across several regions.';

const nexeon = () => {
  const row = { company: 'Nexeon', target_no: 52, url: 'https://example.com/nexeon-round', title: 'Nexeon £100m round',
    published_at: '2026-08-31T00:00:00Z', target_technology: 'silicon anode', content_text: BODY };
  return groupArticles([2, 3, 5].map(investment_signal_no => ({ ...row, investment_signal_no })), [row], period)[0];
};
const base = { entity_supported: true, target_technology_supported: true, quality: 'pass', reason_ko: '근거 확인' };
const approvedS2 = { ...base, candidate_id: 'investment:2', indicator_supported: true, leading_indicator_supported: true,
  event_stage: 'planned', evidence_quotes: [USE], summary_ko: '영국 파일럿 제조시설 개발 계획 - 자금으로 영국 파일럿 제조시설을 개발할 계획임.',
  summary_en: 'UK pilot manufacturing facility planned - The financing will support a UK-based pilot manufacturing facility.' };
const approvedS3 = { ...base, candidate_id: 'investment:3', indicator_supported: true, leading_indicator_supported: true,
  event_stage: 'precursor', evidence_quotes: [ROUND], summary_ko: '1억 파운드 투자 라운드 완료 - 총 1억 파운드 라운드가 완료됐음.',
  summary_en: 'Completion of £100 million round - Nexeon completed its £100 million investment round.' };
const rejectedS5 = { ...base, candidate_id: 'investment:5', indicator_supported: false, leading_indicator_supported: false,
  event_stage: 'unclear', evidence_quotes: ['Dr Scott Brown was appointed chief executive.'], summary_ko: '', summary_en: '' };
const business = { ...base, candidate_id: 'relevant', indicator_supported: true, leading_indicator_supported: true,
  event_stage: 'not_applicable', evidence_quotes: [ROUND], summary_ko: 'Nexeon은 총 1억 파운드 투자 라운드를 완료했음.',
  summary_en: 'Nexeon completed an investment round totalling £100 million.' };
const reply = ds => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ decisions: ds }) } }], usage: {} }));
const config = { apiKey: 'key', maxRequests: 10, delayMs: 0 };

test('a wrong quote on a rejected candidate no longer discards the approvable candidates of the article', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rejected-quote-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const a = nexeon();
  let calls = 0;
  // 실제 순서: 1차는 승인 후보(S2) 인용이 틀렸고, 2차는 탈락 후보(S5) 인용만 틀렸다.
  const state = await reviewArticles({ articles: [a], reviewDir, policy: '', config, sleep: async () => {},
    fetchImpl: async () => (++calls === 1
      ? reply([{ ...approvedS2, evidence_quotes: ['Invented facility sentence.'] }, approvedS3, rejectedS5, business])
      : reply([approvedS2, approvedS3, rejectedS5, business])) });
  assert.equal(calls, 2);
  assert.equal(state.status, 'completed');
  assert.deepEqual(state.failed_articles, []);
  assert.deepEqual(state.quote_removals, [{ article_id: a.id, candidate_ids: ['investment:5'] }]);
  const stored = JSON.parse(await fs.readFile(path.join(reviewDir, `${a.id}.json`), 'utf8'));
  const s5 = stored.decisions.find(d => d.candidate_id === 'investment:5');
  assert.deepEqual(s5.evidence_quotes, []);
  assert.equal(s5.indicator_supported, false);
  assert.deepEqual(stored.unverified_quotes_removed, [{ candidate_id: 'investment:5', removed_quotes: rejectedS5.evidence_quotes }]);
  // 승인 후보의 인용은 그대로 원문 인용이다.
  assert.deepEqual(stored.decisions.find(d => d.candidate_id === 'investment:3').evidence_quotes, [ROUND]);
});

test('an unverifiable quote is never dropped from a candidate that is approved or goes to human review', async () => {
  const a = nexeon();
  const withBadQuote = decision => ({ article_id: a.id, reviewer: 'test', decisions: [approvedS2, approvedS3, rejectedS5, business]
    .map(d => (d.candidate_id === decision.candidate_id ? decision : d)) });
  // 승인 후보: 맞는 인용과 틀린 인용이 섞여 있어도 받지 않는다.
  assert.equal(withoutUnverifiedRejectedQuotes(a, withBadQuote({ ...approvedS3, evidence_quotes: [ROUND, 'Invented.'] })), null);
  // 사람 검토 후보(기술 연결만 부족): 보고서에 실리므로 받지 않는다.
  assert.equal(withoutUnverifiedRejectedQuotes(a, withBadQuote({ ...approvedS2, target_technology_supported: false,
    evidence_quotes: [USE, 'Invented.'] })), null);
  // 첫 응답에서는 되묻기가 우선이다. 재시도 전에는 인용을 빼지 않는다.
  await assert.rejects(requestReview(a, '', 'key', async () => reply([approvedS2, approvedS3, rejectedS5, business])), /evidence_mismatch/);
});

test('a fresh S3 answer that calls a completed funding round completed is asked once more, and the answer is kept', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stage-recheck-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const a = nexeon();
  const s5 = { ...rejectedS5, evidence_quotes: [] };
  const completedS3 = { ...approvedS3, event_stage: 'completed', summary_ko: '', summary_en: '' };
  const bodies = [];
  const state = await reviewArticles({ articles: [a], reviewDir, policy: '', config, sleep: async () => {},
    fetchImpl: async (_, init) => { bodies.push(JSON.parse(init.body)); return reply(bodies.length === 1
      ? [approvedS2, completedS3, s5, business] : [approvedS2, approvedS3, s5, business]); } });
  assert.equal(bodies.length, 2);
  assert.match(JSON.stringify(bodies[1]), /investment:3: event_stage=completed/);
  assert.equal(state.status, 'completed');
  const stored = JSON.parse(await fs.readFile(path.join(reviewDir, `${a.id}.json`), 'utf8'));
  assert.equal(stored.decisions.find(d => d.candidate_id === 'investment:3').event_stage, 'precursor');
  assert.equal(stored.semantic_recheck.previous.find(d => d.candidate_id === 'investment:3').event_stage, 'completed');
});

// 3M 자료로 재현된 결함: 되묻기 응답이 실패하면 앞 응답을 저장했는데, 그 응답에 최신 재검토 버전이 찍혀 있어
// 다음 실행이 다시 묻지 않고 의심 S3 승인을 계속 발행했다.
const facility = 'The company will build a new plant with start-up planned by 2028 under a signed contract.';
const facilityBody = `${facility} The company thanked its shareholders and said the project strengthens its position for the next stage `
  + 'of growth, while its management team continues to work with customers on qualification programmes across several regions.';
test('a recheck that fails is saved as pending, is not published as approved, and is asked again next run', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'recheck-pending-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const row = { company: 'Air Liquide', target_no: 61, url: 'https://example.com/arizona', title: 'Arizona unit',
    published_at: '2026-08-06T00:00:00Z', target_technology: 'membrane', excluded_from_relevance: true, content_text: facilityBody };
  const a = groupArticles([{ ...row, investment_signal_no: 2 }], [], period)[0];
  const suspicious = { ...base, candidate_id: 'investment:2', target_technology_supported: false, indicator_supported: true,
    leading_indicator_supported: true, event_stage: 'planned', evidence_quotes: [facility],
    summary_ko: '신규 공장 건설 계획 - 2028년 가동 예정인 신규 공장을 건설할 계획임.', summary_en: 'New plant planned - The company will build a new plant.' };
  const args = { articles: [a], reviewDir, policy: '', config, sleep: async () => {} };
  let calls = 0;
  const first = await reviewArticles({ ...args, fetchImpl: async () => (++calls === 1 ? reply([suspicious])
    : reply([{ ...suspicious, evidence_quotes: ['Invented.'] }])) });
  assert.equal(calls, 2);
  assert.equal(first.status, 'completed');
  assert.deepEqual(first.failed_articles, []);
  assert.deepEqual(first.recheck_pending, [{ article_id: a.id, candidate_ids: ['investment:2'], reason: 'evidence_mismatch' }]);
  const stored = JSON.parse(await fs.readFile(path.join(reviewDir, `${a.id}.json`), 'utf8'));
  assert.deepEqual(stored.semantic_recheck_pending.candidate_ids, ['investment:2']);
  // 보고서에는 AI 확인이 아니라 재검토 미완료 사람 검토 후보로만 실린다.
  const [result] = importReview(a, stored);
  assert.equal(result.supported, false);
  assert.equal(result.human_review, true);
  assert.equal(result.row.ai_signal_supported, false);
  assert.deepEqual(result.row.ai_review_gaps, ['semantic_recheck']);

  // 다음 실행은 캐시를 재사용하지 않고 다시 판정한다. 이번에는 committed 로 답해 되묻기 대상이 아니다.
  let next = 0;
  const second = await reviewArticles({ ...args, fetchImpl: async () => { next++;
    return reply([{ ...suspicious, event_stage: 'committed', leading_indicator_supported: false, summary_ko: '', summary_en: '' }]); } });
  assert.equal(next, 1);
  assert.equal(second.cached, 0);
  assert.deepEqual(second.recheck_pending, []);
  const resolved = JSON.parse(await fs.readFile(path.join(reviewDir, `${a.id}.json`), 'utf8'));
  assert.equal('semantic_recheck_pending' in resolved, false);
  assert.equal(importReview(a, resolved)[0].supported, false);

  // 요청 한도에 걸려 되묻지 못한 경우도 미완료로 남는다.
  const budgetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'recheck-budget-'));
  t.after(() => fs.rm(budgetDir, { recursive: true, force: true }));
  const budget = await reviewArticles({ ...args, reviewDir: budgetDir, config: { ...config, maxRequests: 1 }, fetchImpl: async () => reply([suspicious]) });
  assert.equal(budget.recheck_pending[0].reason, 'request_budget');
  assert.ok(JSON.parse(await fs.readFile(path.join(budgetDir, `${a.id}.json`), 'utf8')).semantic_recheck_pending);
});

// 3M 8-K: 같은 42.5억 달러 기존 리볼빙 신용계약을 새 계약으로 대체했다. 인용에는 "new credit agreement" 만 있었고
// 대체 사실은 모델 요약에만 적혔다.
test('a renewed or replaced credit facility is selected for the S3 funding recheck, a new round is not', () => {
  const article = { candidates: [{ id: 'investment:3', kind: 'investment', row: { investment_signal_no: 3, title: '8-K - Current report' } }] };
  const decision = { candidate_id: 'investment:3', entity_supported: true, indicator_supported: true, target_technology_supported: false,
    leading_indicator_supported: true, event_stage: 'precursor', quality: 'pass',
    evidence_quotes: ['On August 17, 2026, 3M Company entered into a new credit agreement with JPMorgan Chase Bank, N.A.'],
    summary_en: 'providing a $4.25 billion unsecured revolving credit facility that replaced its former revolving credit agreement.' };
  assert.equal(needsFundingReview(article, { decisions: [decision] }), true);
  assert.equal(needsFundingReview(article, { decisions: [decision], funding_review_version: 'funding-event-v2' }), false);
  assert.deepEqual(fundingSuspects(article, [{ ...decision, summary_en: 'Nexeon completed a £100 million investment round.' }]), []);
});

// Air Liquide 반기보고서: 결정된 애리조나 생산유닛(2028년 가동)이 S2 planned 로 승인됐다.
test('an S2 plan quoting a decided facility investment with a start-up date is rechecked, an undecided plan is not', () => {
  const article = { candidates: [{ id: 'investment:2', relevance_exempt: true }] };
  const decision = { candidate_id: 'investment:2', entity_supported: true, target_technology_supported: false, indicator_supported: true,
    leading_indicator_supported: true, event_stage: 'planned', quality: 'pass',
    evidence_quotes: ['160 million US dollars investment in Arizona, United States: Air Liquide plans the start-up by 2028 of a new large-scale production unit.'] };
  assert.equal(facilityStageSuspects(article, [decision]).length, 1);
  assert.equal(needsFacilityStageReview(article, { decisions: [decision] }), true);
  assert.equal(needsFacilityStageReview(article, { decisions: [decision], facility_stage_review_version: 'facility-stage-v1' }), false);
  for (const change of [{ event_stage: 'committed' }, { leading_indicator_supported: false },
    { evidence_quotes: ['The company is evaluating sites for a possible new plant.'] }]) {
    assert.equal(facilityStageSuspects(article, [{ ...decision, ...change }]).length, 0);
  }
});

const BODY_TEXT = 'Radiation-hardened power devices are aboard the space telescope, which lifted off successfully. '.repeat(3);
// Infineon·Plansee·NXP: 면제가 아닌 기업의 기술 연결 승인만 한 번 다시 묻는다.
test('saved business approvals that rely on a technology link are rechecked once; exempt companies are not', () => {
  const article = exempt => ({ candidates: [{ id: 'relevant', kind: 'relevant', relevance_exempt: exempt, row: { content_text: BODY_TEXT } }] });
  const decision = { candidate_id: 'relevant', entity_supported: true, target_technology_supported: true, indicator_supported: true,
    leading_indicator_supported: true, event_stage: 'not_applicable', quality: 'pass' };
  assert.equal(needsTechnologyReview(article(false), { decisions: [decision] }), true);
  assert.equal(needsTechnologyReview(article(false), { decisions: [decision], technology_review_version: 'technology-link-v1' }), false);
  assert.equal(needsTechnologyReview(article(true), { decisions: [decision] }), false);
  assert.equal(needsTechnologyReview(article(false), { decisions: [{ ...decision, target_technology_supported: false }] }), false);
});

test('Korean summaries ending in plain sentences or transliterating the company name are refreshed once', () => {
  const article = { company: 'Qualcomm', candidates: [{ id: 'relevant', kind: 'relevant', row: { content_text: BODY_TEXT, query_aliases: [] } }] };
  const decision = { candidate_id: 'relevant', entity_supported: true, target_technology_supported: true, indicator_supported: true,
    leading_indicator_supported: true, event_stage: 'not_applicable', quality: 'pass',
    summary_ko: '퀄컴은 자동차 부문 매출이 61% 증가했다.', summary_en: 'Qualcomm said automotive revenue rose 61%.' };
  assert.deepEqual(summaryStyleProblems(article, decision), ['plain_sentence_ending', 'company_name_not_latin']);
  assert.deepEqual(summaryStyleProblems(article, { ...decision, summary_ko: 'Qualcomm의 자동차 부문 매출이 61% 증가했음. 연간 전망도 올렸음.' }), []);
  // 투자 시그널 표제는 명사구라 문장 끝 검사에서 뺀다.
  assert.deepEqual(summaryStyleProblems(article, { ...decision, summary_ko: 'Qualcomm 매출 목표 상향 - 목표를 약 70억 달러로 올렸음.' }), []);
  // 투자 시그널 문안은 회사명을 반복하지 않는 것이 규칙이다. 이름이 없다는 것만으로 음차로 보지 않는다.
  assert.deepEqual(summaryStyleProblems(article, { ...decision, summary_ko: '매출 목표 상향 - 자동차 매출 목표를 약 70억 달러로 올렸음.',
    summary_en: 'Target raised - Qualcomm raised its automotive target to about $7 billion.' }), []);
  assert.deepEqual(summaryStyleProblems(article, { ...decision, summary_ko: '매출 목표 상향 - 퀄컴은 자동차 매출 목표를 올렸음.',
    summary_en: 'Target raised - Qualcomm raised its automotive target.' }), ['company_name_not_latin']);
  const review = { decisions: [decision], summary_accuracy_version: 'summary-accuracy-v1', summary_numbers_version: 'summary-numbers-v1' };
  assert.equal(needsSummaryRefresh(article, review), true);
  assert.equal(needsSummaryRefresh(article, { ...review, summary_style_version: 'summary-style-v1' }), false);
});
