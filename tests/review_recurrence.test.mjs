// 2026-08 보고서(실행 35167466191) 검토에서 확인된 실패 사례의 재발 방지.
// 이 테스트들은 재검토 대상 선택과 저장 경로를 검증한다. 모델의 의미 판정 자체를 검증하지는 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reviewArticles, requestReview, facilityStageSuspects, fundingSuspects, needsFundingReview, needsFacilityStageReview,
  needsTechnologyReview, needsSummaryRefresh, summaryStyleProblems, salvageCandidateEvidence, acquisitionSuspects, cachedRecheck,
  bilingualFactProblems, nearestEvidence, pruneReviewWork } from '../scripts/review_report.mjs';
import { groupArticles, importReview, sourceCandidates, ungroundedSummaryNames } from '../scripts/local_report.mjs';

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
const base = { entity_supported: true, target_technology_supported: true, quality: 'pass', reason: '근거 확인' };
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

// 실행 35175067142: Nexeon 은 두 번째 응답의 S3 문안 하나가 검증에 걸려 1억 파운드 조달 기사 전체가 다시 빠졌다.
test('an approvable candidate with unverifiable evidence becomes pending while the rest of the article is kept', async () => {
  const a = nexeon();
  const review = decisions => ({ article_id: a.id, reviewer: 'test', decisions });
  // 승인 후보의 틀린 인용: 인용은 빼고, 그 후보는 문안을 비운 채 미완료로 둔다. AI 승인으로는 싣지 않는다.
  const salvaged = salvageCandidateEvidence(a, review([approvedS2, { ...approvedS3, evidence_quotes: [ROUND, 'Invented.'] }, rejectedS5, business]));
  // S5 는 탈락 판정이라 틀린 인용만 빠지고 미완료로 두지 않는다.
  assert.deepEqual(salvaged.semantic_recheck_pending.candidate_ids, ['investment:3']);
  const s3 = salvaged.decisions.find(d => d.candidate_id === 'investment:3');
  assert.deepEqual(s3.evidence_quotes, [ROUND]);
  assert.equal(s3.summary_ko, '');
  const results = Object.fromEntries(importReview(a, salvaged).map(r => [r.candidate_id, r]));
  // AI 승인으로는 싣지 않되, 무엇이 보류됐는지 볼 수 있게 대시보드용 행으로는 남긴다.
  assert.equal(results['investment:3'].supported, false);
  assert.equal(results['investment:3'].near_miss, true);
  assert.equal(results['investment:3'].row.ai_signal_supported, false);
  assert.equal(results['investment:3'].row.ai_summary_ko, '');
  assert.equal(results['investment:2'].supported, true);
  assert.equal(results.relevant.supported, true);
  // 인용 밖 고유명사를 쓴 승인 후보도 같은 방식으로 그 후보만 미완료가 된다.
  const named = salvageCandidateEvidence(a, review([approvedS2, { ...approvedS3,
    summary_en: 'Completion of round - Nexeon completed a round led by Barclays Capital.' }, rejectedS5, business]));
  assert.deepEqual(named.semantic_recheck_pending.candidate_ids, ['investment:3']);
  // 사업동향의 틀린 인용: 사람 검토 단계가 없으므로 미완료 동안 싣지 않는다.
  const relevant = salvageCandidateEvidence(a, review([approvedS2, approvedS3, { ...rejectedS5, evidence_quotes: [] },
    { ...business, evidence_quotes: ['Invented.'] }]));
  assert.equal(importReview(a, relevant).find(r => r.candidate_id === 'relevant').supported, false);
  // 발행될 후보가 모두 근거를 잃으면 살릴 판정이 없으므로 실패로 둔다.
  assert.equal(salvageCandidateEvidence(a, review([{ ...approvedS2, evidence_quotes: ['Invented.'] },
    { ...approvedS3, evidence_quotes: ['Invented.'] }, { ...rejectedS5, evidence_quotes: [] }, { ...business, evidence_quotes: ['Invented.'] }])), null);
  // 첫 응답에서는 되묻기가 우선이다. 재시도 전에는 인용을 빼지 않는다.
  await assert.rejects(requestReview(a, '', 'key', async () => reply([approvedS2, approvedS3, rejectedS5, business])), /evidence_mismatch/);
  // "UK-based" 의 based 는 이름이 아니다.
  assert.deepEqual(ungroundedSummaryNames('Round - Nexeon will build a UK-based pilot facility.', [ROUND], 'Nexeon £100m round'), []);
});

// 실행 35175067142: 재시도 요청은 "후보 X 인용이 틀렸다"만 알려 줘, 중간을 건너뛴 Vestas 표 인용이 두 번째에도 틀렸다.
test('the retry names each unmatched quote and shows the source text from where it diverged', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'retry-quotes-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const a = nexeon();
  const skipped = 'The National Wealth Fund’s commitment of £52.6 million marks the completion of Nexeon’s latest investment round.';
  assert.match(nearestEvidence([ROUND.replace(/[’]/g, "'")], skipped.replace(/[’]/g, "'")), /^The National Wealth Fund's commitment of £52\.6 million marks the completion of Nexeon's latest investment round totalling/);
  const bodies = [];
  await reviewArticles({ articles: [a], reviewDir, policy: '', config, sleep: async () => {},
    fetchImpl: async (_, init) => { bodies.push(init.body); return reply([approvedS2, { ...approvedS3, evidence_quotes: [skipped] },
      { ...rejectedS5, evidence_quotes: [] }, business]); } });
  assert.equal(bodies.length, 2);
  assert.match(bodies[1], /unmatched_quotes/);
  assert.match(bodies[1], /totalling £100 million/);
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

// 실행 35175067142: Vestas 는 저장된 판정의 기술 연결 재검토가 두 번 실패했는데 옛 판정이 그대로 남아,
// 실행 상태는 실패인데 보고서는 검토 완료로 셌다.
test('a saved review whose recheck fails is kept as pending instead of silently counting as reviewed', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cached-recheck-failed-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const a = nexeon();
  const { MODEL } = await import('../scripts/review_report.mjs');
  const saved = { article_id: a.id, reviewer: `${MODEL}/article-review-v1`, provider: 'nvidia',
    decisions: [approvedS2, approvedS3, { ...rejectedS5, evidence_quotes: [] }, business], summary_accuracy_version: 'summary-accuracy-v1' };
  await fs.writeFile(path.join(reviewDir, `${a.id}.json`), JSON.stringify(saved));
  assert.equal(cachedRecheck(a, saved).reason, 'technology_link');
  const args = { articles: [a], reviewDir, policy: '', config, sleep: async () => {} };
  const state = await reviewArticles({ ...args, fetchImpl: async () => new Response('{"choices":[{"finish_reason":"stop","message":{"content":"not json"}}]}') });
  assert.deepEqual(state.failed_articles, []);
  assert.equal(state.recheck_pending.length, 1);
  assert.match(state.recheck_pending[0].reason, /^technology_link:/);
  const stored = JSON.parse(await fs.readFile(path.join(reviewDir, `${a.id}.json`), 'utf8'));
  assert.deepEqual(stored.decisions, saved.decisions);
  assert.deepEqual(stored.semantic_recheck_pending.candidate_ids.sort(), ['investment:2', 'investment:3', 'relevant']);
  // 미완료 후보는 AI 승인으로 싣지 않는다. 다음 실행은 다시 묻는다.
  assert.equal(importReview(a, stored).filter(r => r.supported).length, 0);
  let calls = 0;
  await reviewArticles({ ...args, fetchImpl: async () => { calls++; return reply([approvedS2, approvedS3, { ...rejectedS5, evidence_quotes: [] }, business]); } });
  assert.equal(calls, 1);
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
  // 재검토 미완료 후보는 AI 승인으로 싣지 않는다. 대시보드용 근접 후보로만 남고,
  // 미완료 기록이 다음 실행에서 이 기사를 다시 판정하게 한다.
  const [result] = importReview(a, stored);
  assert.equal(result.supported, false);
  assert.equal(result.row.ai_signal_supported, false);

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
  assert.equal(needsTechnologyReview(article(false), { decisions: [decision], technology_review_version: 'technology-link-v2' }), false);
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
  assert.deepEqual(summaryStyleProblems(article, { ...decision, summary_ko: 'Qualcomm 매출 목표 상향 - 목표를 약 70억 달러로 올렸음.',
    summary_en: 'Target raised - Qualcomm raised its target to about $7 billion.' }), []);
  // 투자 시그널 문안은 회사명을 반복하지 않는 것이 규칙이다. 이름이 없다는 것만으로 음차로 보지 않는다.
  assert.deepEqual(summaryStyleProblems(article, { ...decision, summary_ko: '매출 목표 상향 - 자동차 매출 목표를 약 70억 달러로 올렸음.',
    summary_en: 'Target raised - Qualcomm raised its automotive target to about $7 billion.' }), []);
  assert.deepEqual(summaryStyleProblems(article, { ...decision, summary_ko: '매출 목표 상향 - 퀄컴은 자동차 매출 목표를 올렸음.',
    summary_en: 'Target raised - Qualcomm raised its automotive target.' }), ['company_name_not_latin']);
  const review = { decisions: [decision], summary_accuracy_version: 'summary-accuracy-v1', summary_numbers_version: 'summary-numbers-v1' };
  assert.equal(needsSummaryRefresh(article, review), true);
  assert.equal(needsSummaryRefresh(article, { ...review, summary_style_version: 'summary-style-v2' }), false);
});

// 실행 35175067142: HyproMag S1 이 모회사의 인수 완료와 인수에 딸린 원료 재고를 공급망 전조로 승인했다.
test('S1 or S4 approvals that rest on a completed acquisition are asked again', () => {
  const article = { candidates: [{ id: 'investment:1' }] };
  const decision = { candidate_id: 'investment:1', entity_supported: true, indicator_supported: true, event_stage: 'precursor',
    evidence_quotes: ['the Company has completed the acquisition of the Remloy rare earth magnet recycling business'] };
  assert.equal(acquisitionSuspects(article, [decision]).length, 1);
  assert.equal(cachedRecheck({ candidates: article.candidates }, { decisions: [decision] }).reason, 'acquisition_event');
  assert.equal(acquisitionSuspects(article, [{ ...decision, evidence_quotes: ['signed a new long-term feedstock supply agreement'] }]).length, 0);
  assert.equal(acquisitionSuspects(article, [{ ...decision, candidate_id: 'investment:2' }]).length, 0);
  // 기술 기업 소수 지분투자는 지침상 S4 사건이다(Maxon–Synapticon).
  assert.equal(acquisitionSuspects({ candidates: [{ id: 'investment:4' }] }, [{ ...decision, candidate_id: 'investment:4',
    evidence_quotes: ['maxon Group has acquired a strategic minority stake in Synapticon'] }]).length, 0);
});

// 같은 실행: Renishaw 한국어 문안에만 9월·10월 전시 일정이 있었다.
test('Korean and English summaries that state different months or percentages are refreshed', () => {
  const decision = { summary_ko: '2026년 9월 SEMICON Taiwan과 10월 SEMICON West에서 공개 예정임.', summary_en: 'It will be shown at SEMICON Taiwan and SEMICON West.' };
  assert.deepEqual(bilingualFactProblems(decision), ['bilingual_month_mismatch']);
  assert.deepEqual(bilingualFactProblems({ ...decision, summary_en: 'It will be shown at SEMICON Taiwan in September and SEMICON West in October.' }), []);
  assert.deepEqual(bilingualFactProblems({ summary_ko: '매출이 26% 증가했음.', summary_en: 'Revenue rose 62 percent.' }), ['bilingual_percent_mismatch']);
  // 같은 실행의 오역: scheme of arrangement → 멤버십 배치 방식, late-stage → 말기.
  const article = { company: 'ASM', candidates: [{ id: 'relevant', row: {} }] };
  assert.deepEqual(summaryStyleProblems(article, { candidate_id: 'relevant', summary_ko: 'Energy Fuels가 멤버십 배치 방식으로 인수를 완료했음.',
    summary_en: 'Energy Fuels completed the acquisition by way of a scheme of arrangement.' }), ['mistranslated_term']);
  assert.deepEqual(summaryStyleProblems(article, { candidate_id: 'relevant', summary_ko: 'Moderna가 말기 임상 결과를 발표했음.',
    summary_en: 'Moderna reported late-stage trial results.' }), ['mistranslated_term']);
  assert.deepEqual(summaryStyleProblems(article, { candidate_id: 'relevant', summary_ko: 'Moderna가 후기 단계 임상시험 결과를 발표했음.',
    summary_en: 'Moderna reported late-stage trial results.' }), []);
});

// 같은 실행: 지시만으로는 Infineon 우주용 전력반도체와 NXP 차량용 UWB 가 RF 반도체로 다시 승인됐다.
test('a technology scope reaches only the candidates of its group, so other article ids do not change', () => {
  const signal = company => ({ company, target_no: 1, url: `https://example.com/${company}`, title: 'News', published_at: '2026-08-10T00:00:00Z',
    content_text: BODY });
  const technology = { companies: [
    { company: 'NXP', target_no: 1, technology_group: 'satellite_radar_rf_semiconductor', target_technology: 'RF' },
    { company: 'Nexeon', target_no: 1, technology_group: 'silicon_anode_sic', target_technology: 'anode' }] };
  const indicators = { indicators: [] };
  const scopes = { satellite_radar_rf_semiconductor: { excludes_en: 'automotive UWB chips' } };
  const withScope = sourceCandidates([signal('NXP'), signal('Nexeon')], technology, indicators, period, scopes);
  const without = sourceCandidates([signal('NXP'), signal('Nexeon')], technology, indicators, period, {});
  const ids = c => Object.fromEntries(groupArticles(c.investment, c.relevant, period).map(a => [a.company, a]));
  assert.deepEqual(ids(withScope).NXP.candidates[0].target_technology_scope, scopes.satellite_radar_rf_semiconductor);
  assert.notEqual(ids(withScope).NXP.id, ids(without).NXP.id);
  assert.equal(ids(withScope).Nexeon.id, ids(without).Nexeon.id);
  assert.equal('target_technology_scope' in ids(withScope).Nexeon.candidates[0], false);
});

// 2차 검증: 1차 판정 모델은 그대로 두고, 규칙이 고른 의심 후보만 Gemini 검증 모델이 다시 판정한다.
const geminiReply = ds => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP',
  content: { parts: [{ text: JSON.stringify({ decisions: ds, published_date: '', published_date_quote: '' }) }] } }], usageMetadata: {} }));
const verifierConfig = { ...config, verifierApiKey: 'AIzaVerifier' };

test('suspicious candidates of a fresh answer go to the verifier model, and only their decisions are replaced', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verifier-fresh-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const { VERIFIER } = await import('../scripts/review_report.mjs');
  const a = nexeon();
  const s5 = { ...rejectedS5, evidence_quotes: [] };
  // 1차: S3 를 completed 로 봤고(단계 의심), 나머지는 기술 연결로 발행될 후보라 함께 검증 대상이다.
  const primary = [approvedS2, { ...approvedS3, event_stage: 'completed', summary_ko: '', summary_en: '' }, s5, business];
  const calls = [];
  const state = await reviewArticles({ articles: [a], reviewDir, policy: '', config: verifierConfig, sleep: async () => {},
    fetchImpl: async (url, init) => {
      calls.push({ url, body: init.body });
      if (!String(url).includes('generativelanguage')) return reply(primary);
      // 검증 모델은 S3 를 precursor 로 고치고, 1차가 승인한 사업동향은 구체적 사업 활동이 아니라고 본다.
      return geminiReply([{ ...approvedS2, reason: '검증: 파일럿 제조시설 계획 확인' }, approvedS3, s5,
        { ...business, indicator_supported: false, summary_ko: '', summary_en: '' }]);
    } });
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, new RegExp(VERIFIER.model.replace(/\./g, '\\.')));
  assert.equal(VERIFIER.model, 'gemini-3.5-flash-lite');
  const verifyBody = JSON.stringify(JSON.parse(calls[1].body));
  assert.match(verifyBody, /Second-stage audit/);
  assert.match(verifyBody, /verify_candidate_ids/);
  // 같은 모델이 자기 답에 끌려가지 않도록 1차 답은 보내지 않고, 후보별 확인 질문을 보낸다.
  assert.doesNotMatch(verifyBody, /primary_decisions/);
  assert.match(verifyBody, /Name the specific product, service or activity/);
  assert.match(verifyBody, /Is that event itself the final investment/);
  assert.equal(state.verification.requested, 1);
  assert.equal(state.verification.changed, 1);
  const stored = JSON.parse(await fs.readFile(path.join(reviewDir, `${a.id}.json`), 'utf8'));
  assert.deepEqual(stored.verification.candidate_ids.sort(), ['investment:2', 'investment:3', 'relevant']);
  assert.deepEqual(stored.verification.changed.sort(), ['investment:3', 'relevant']);
  assert.equal(stored.verification.model, 'gemini-3.5-flash-lite');
  // 의심 대상이 아닌 S5 는 1차 판정 그대로다.
  assert.deepEqual(stored.decisions.find(d => d.candidate_id === 'investment:5'), s5);
  const results = Object.fromEntries(importReview(a, stored).map(r => [r.candidate_id, r.supported]));
  assert.deepEqual(results, { 'investment:2': true, 'investment:3': true, 'investment:5': false, relevant: false });
  // 검증을 마친 판정은 다음 실행에서 다시 검증하지 않는다.
  let again = 0;
  await reviewArticles({ articles: [a], reviewDir, policy: '', config: verifierConfig, sleep: async () => {},
    fetchImpl: async () => { again++; return reply(primary); } });
  assert.equal(again, 0);
});

// 실행 35181768089: 검증 첫 요청이 503 한 번을 받자 보조 요청이 모두 멈춰, 의심 후보 42건이 빠진 보고서가 발행됐다.
test('a verifier that stays unavailable after retries pauses the run so no report is built without verification', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verifier-failed-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const a = nexeon();
  const primary = [approvedS2, approvedS3, { ...rejectedS5, evidence_quotes: [] }, business];
  let verifierCalls = 0;
  const state = await reviewArticles({ articles: [a], reviewDir, policy: '', config: verifierConfig, sleep: async () => {},
    fetchImpl: async url => (String(url).includes('generativelanguage') ? (verifierCalls++, new Response('', { status: 503 })) : reply(primary)) });
  // 1차 판정처럼 두 번 재시도한 뒤 멈춘다.
  assert.equal(verifierCalls, 3);
  assert.equal(state.status, 'paused');
  assert.equal(state.reason, 'verifier_unavailable');
  assert.equal(state.http_status, 503);
  const { publishableReviewFailures } = await import('../scripts/review_report.mjs');
  assert.deepEqual(publishableReviewFailures(state), [], 'a verifier pause must not build the report');
  assert.equal(state.verification.failed, 1);
  assert.deepEqual(state.verification.errors, { '503:unspecified': 3 });
  assert.equal(state.recheck_pending.length, 1);
  // 받은 1차 판정은 미완료로 저장돼 다음 실행에서 검증만 다시 한다. 검증 전에는 승인으로 싣지 않는다.
  const stored = JSON.parse(await fs.readFile(path.join(reviewDir, `${a.id}.json`), 'utf8'));
  assert.equal(stored.semantic_recheck_pending.reason, 'verifier_unavailable');
  assert.equal(importReview(a, stored).filter(r => r.supported).length, 0);
  // 다음 실행은 1차 판정을 다시 사지 않고 검증만 다시 시도한다.
  const urls = [];
  await reviewArticles({ articles: [a], reviewDir, policy: '', config: verifierConfig, sleep: async () => {},
    fetchImpl: async url => { urls.push(String(url)); return geminiReply(primary); } });
  assert.equal(urls.length, 1);
  assert.match(urls[0], /generativelanguage/);
  const verified = JSON.parse(await fs.readFile(path.join(reviewDir, `${a.id}.json`), 'utf8'));
  assert.equal('semantic_recheck_pending' in verified, false);
  assert.equal(importReview(a, verified).filter(r => r.supported).length, 3);
});

test('a verifier model the API rejects stops the run instead of quietly withholding every suspicious approval', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verifier-config-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const a = nexeon();
  const primary = [approvedS2, approvedS3, { ...rejectedS5, evidence_quotes: [] }, business];
  for (const concurrency of [1, 2]) {
    await assert.rejects(reviewArticles({ articles: [a], reviewDir, policy: '', config: { ...verifierConfig, concurrency }, sleep: async () => {},
      fetchImpl: async url => (String(url).includes('generativelanguage') ? new Response('{"error":{"message":"model not found"}}', { status: 404 }) : reply(primary)) }),
      /Verifier gemini-3\.5-flash-lite rejected the request \(HTTP 404\)/);
  }
});

test('a single verifier 503 is retried and the verification completes', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verifier-retry-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const a = nexeon();
  const primary = [approvedS2, approvedS3, { ...rejectedS5, evidence_quotes: [] }, business];
  let verifierCalls = 0;
  const waits = [];
  const state = await reviewArticles({ articles: [a], reviewDir, policy: '', config: verifierConfig, sleep: async ms => { waits.push(ms); },
    random: () => 0, fetchImpl: async url => {
      if (!String(url).includes('generativelanguage')) return reply(primary);
      return ++verifierCalls === 1 ? new Response('{"error":{"message":"The model is overloaded"}}', { status: 503 }) : geminiReply(primary);
    } });
  assert.equal(verifierCalls, 2);
  assert.ok(waits.includes(15000));
  assert.equal(state.status, 'completed');
  assert.deepEqual(state.recheck_pending, []);
  assert.equal(state.verification.requested, 2);
});

test('with parallel workers one unavailable verifier stops verification for every article without stopping judgements', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verifier-parallel-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const articles = ['Nexeon', 'NexeonB', 'NexeonC'].map((company, i) => {
    const row = { company, target_no: 52 + i, url: `https://example.com/${company}`, title: `${company} £100m round`,
      published_at: '2026-08-31T00:00:00Z', target_technology: 'silicon anode', content_text: BODY };
    return groupArticles([2, 3, 5].map(investment_signal_no => ({ ...row, investment_signal_no })), [row], period)[0];
  });
  const primary = [approvedS2, approvedS3, { ...rejectedS5, evidence_quotes: [] }, business];
  let judgements = 0, verifierCalls = 0;
  const state = await reviewArticles({ articles, reviewDir, policy: '', config: { ...verifierConfig, concurrency: 3, delayMs: 0 },
    sleep: async () => {}, fetchImpl: async url => {
      if (String(url).includes('generativelanguage')) { verifierCalls++; return new Response('', { status: 503 }); }
      judgements++; return reply(primary);
    } });
  assert.equal(judgements, 3);
  assert.equal(state.completed, 3);
  assert.equal(state.status, 'paused');
  assert.equal(state.reason, 'verifier_unavailable');
  assert.ok(verifierCalls <= 9, `verifier calls ${verifierCalls}`);
  assert.equal(state.recheck_pending.length, 3);
});

// 실행 35182571472: 무료 등급 일일 할당량이 소진된 상태에서 검증 요청이 재시도로 반복됐다.
test('an exhausted verifier quota is not retried and the error is recorded', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verifier-quota-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const a = nexeon();
  const primary = [approvedS2, approvedS3, { ...rejectedS5, evidence_quotes: [] }, business];
  let verifierCalls = 0;
  const state = await reviewArticles({ articles: [a], reviewDir, policy: '', config: verifierConfig, sleep: async () => {},
    fetchImpl: async url => {
      if (!String(url).includes('generativelanguage')) return reply(primary);
      verifierCalls++;
      return new Response('{"error":{"message":"You exceeded your current quota"}}', { status: 429 });
    } });
  assert.equal(verifierCalls, 1);
  assert.equal(state.status, 'paused');
  assert.equal(state.reason, 'verifier_unavailable');
  assert.equal(state.provider_reason, 'credits_exhausted');
  assert.deepEqual(state.verification.errors, { '429:credits_exhausted': 1 });
});

// 실행 35198796190: 검증 지시대로 대상 밖 후보에 빈 reason 를 돌려주자 검증 응답 33건이 모두 형식 검사에서 거부됐다.
test('verifier answers for candidates outside verify_candidate_ids are replaced by the primary decisions before validation', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verifier-unlisted-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const a = nexeon();
  const s5 = { ...rejectedS5, evidence_quotes: [] };
  const primary = [approvedS2, approvedS3, s5, business];
  const state = await reviewArticles({ articles: [a], reviewDir, policy: '', config: verifierConfig, sleep: async () => {},
    fetchImpl: async url => (String(url).includes('generativelanguage')
      ? geminiReply([approvedS2, approvedS3, { ...s5, reason: '', entity_supported: false, event_stage: 'not_applicable' }, business])
      : reply(primary)) });
  assert.equal(state.status, 'completed');
  assert.equal(state.verification.failed, 0);
  assert.deepEqual(state.recheck_pending, []);
  const stored = JSON.parse(await fs.readFile(path.join(reviewDir, `${a.id}.json`), 'utf8'));
  assert.deepEqual(stored.decisions.find(d => d.candidate_id === 'investment:5'), s5);
});

// 검증 요청에 대상 후보만 싣게 된 뒤의 정상 형태: 검증 모델은 그 후보만 답하고, 나머지는
// 1차 판정에서 온다. 예전처럼 후보 전부를 답해 오는 모델도 그대로 받는다(위 테스트).
test('a verifier that answers only the audited candidate still yields a complete review', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verifier-narrow-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const a = nexeon();
  const s5 = { ...rejectedS5, evidence_quotes: [] };
  const primary = [approvedS2, approvedS3, s5, business];
  let audited = null;
  const state = await reviewArticles({ articles: [a], reviewDir, policy: '', config: verifierConfig, sleep: async () => {},
    fetchImpl: async (url, options) => {
      if (!String(url).includes('generativelanguage')) return reply(primary);
      const sent = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);
      audited = sent.candidates.map(c => c.id);
      // 받은 후보만 답한다.
      return geminiReply(primary.filter(d => audited.includes(d.candidate_id)));
    } });
  assert.equal(state.status, 'completed');
  assert.equal(state.verification.failed, 0);
  assert.ok(audited && audited.length, 'the verifier was asked about something');
  assert.ok(audited.length < a.candidates.length, 'only the audited candidates were sent');
  const stored = JSON.parse(await fs.readFile(path.join(reviewDir, `${a.id}.json`), 'utf8'));
  assert.equal(stored.decisions.length, a.candidates.length, 'every candidate is still judged');
  // 검증 대상이 아니었던 후보는 1차 판정 그대로다.
  for (const id of primary.map(d => d.candidate_id).filter(id => !audited.includes(id))) {
    assert.deepEqual(stored.decisions.find(d => d.candidate_id === id),
      primary.find(d => d.candidate_id === id), id);
  }
});

test('a verifier whose every answer is rejected pauses the run instead of publishing without the suspicious candidates', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verifier-rejected-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const articles = ['Nexeon', 'NexeonB', 'NexeonC', 'NexeonD'].map((company, i) => {
    const row = { company, target_no: 52 + i, url: `https://example.com/${company}`, title: `${company} £100m round`,
      published_at: '2026-08-31T00:00:00Z', target_technology: 'silicon anode', content_text: BODY };
    return groupArticles([2, 3, 5].map(investment_signal_no => ({ ...row, investment_signal_no })), [row], period)[0];
  });
  const primary = [approvedS2, approvedS3, { ...rejectedS5, evidence_quotes: [] }, business];
  let verifierCalls = 0;
  const state = await reviewArticles({ articles, reviewDir, policy: '', config: verifierConfig, sleep: async () => {},
    fetchImpl: async url => {
      if (!String(url).includes('generativelanguage')) return reply(primary);
      verifierCalls++;
      return geminiReply(primary.map(d => ({ ...d, reason: '' })));
    } });
  // 기사마다 한 번 더 물은 뒤 거부로 센다. 세 기사 연속 거부되면 멈춘다.
  assert.equal(verifierCalls, 6);
  assert.equal(state.status, 'paused');
  assert.equal(state.reason, 'verifier_unavailable');
  assert.equal(state.recheck_pending.length, 4);
});

test('a rejected verifier answer is asked once more with the validation message and can then succeed', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verifier-revalidate-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const a = nexeon();
  const primary = [approvedS2, approvedS3, { ...rejectedS5, evidence_quotes: [] }, business];
  const bodies = [];
  const state = await reviewArticles({ articles: [a], reviewDir, policy: '', config: verifierConfig, sleep: async () => {},
    fetchImpl: async (url, init) => {
      if (!String(url).includes('generativelanguage')) return reply(primary);
      bodies.push(init.body);
      // 첫 검증 응답은 승인할 S3 의 요약을 빠뜨린다.
      return geminiReply(bodies.length === 1 ? primary.map(d => d.candidate_id === 'investment:3' ? { ...d, summary_ko: '', summary_en: '' } : d) : primary);
    } });
  assert.equal(bodies.length, 2);
  assert.match(bodies[1], /previous_response_rejected/);
  assert.equal(state.status, 'completed');
  assert.equal(state.verification.failed, 0);
  assert.deepEqual(state.recheck_pending, []);
});

// 실행 35200022672: 첫 검증 요청({mode:'verify'})이 재시도로 취급돼, 인용 오류가 보정 요청 없이 곧바로 salvage 되고 미완료가 됐다.
const verifyRequest = ids => ({ mode: 'verify', verify_candidate_ids: ids, checks: {} });
const WRONG_QUOTE = 'Nexeon closed a round of one hundred million pounds.';

test('the first verifier answer is not treated as a repair: evidence and number errors are rejected, not salvaged or downgraded', async () => {
  const { VERIFIER } = await import('../scripts/review_report.mjs');
  const a = nexeon();
  const primary = [approvedS2, approvedS3, { ...rejectedS5, evidence_quotes: [] }, business];
  const wrongQuote = primary.map(d => d.candidate_id === 'investment:3' ? { ...d, evidence_quotes: [WRONG_QUOTE] } : d);
  await assert.rejects(requestReview(a, '', 'key', async () => geminiReply(wrongQuote), verifyRequest(['investment:3']), VERIFIER,
    { keepDecisions: primary }), /evidence_mismatch/);
  const wrongNumber = primary.map(d => d.candidate_id === 'investment:3'
    ? { ...d, summary_en: 'Completion of £900 million round - Nexeon completed its £900 million investment round.' } : d);
  await assert.rejects(requestReview(a, '', 'key', async () => geminiReply(wrongNumber), verifyRequest(['investment:3']), VERIFIER,
    { keepDecisions: primary }), /summary_number_ungrounded/);
  // 보정 응답에서만 기존 완화가 적용된다.
  const salvaged = await requestReview(a, '', 'key', async () => geminiReply(wrongQuote), verifyRequest(['investment:3']), VERIFIER,
    { keepDecisions: primary, repairAttempt: true });
  assert.deepEqual(salvaged.semantic_recheck_pending.candidate_ids, ['investment:3']);
});

test('a rejected first verifier answer gets one repair request with the unmatched quote, and a clean repair counts as verified', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verifier-repair-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const a = nexeon();
  const primary = [approvedS2, approvedS3, { ...rejectedS5, evidence_quotes: [] }, business];
  const bodies = [];
  const state = await reviewArticles({ articles: [a], reviewDir, policy: '', config: verifierConfig, sleep: async () => {},
    fetchImpl: async (url, init) => {
      if (!String(url).includes('generativelanguage')) return reply(primary);
      bodies.push(init.body);
      return geminiReply(bodies.length === 1
        ? primary.map(d => d.candidate_id === 'investment:3' ? { ...d, evidence_quotes: [WRONG_QUOTE] } : d) : primary);
    } });
  assert.equal(bodies.length, 2);
  assert.match(bodies[1], /unmatched_quotes/);
  assert.equal(state.verification.verified, 1);
  assert.equal(state.verification.rejected_responses, 1);
  assert.deepEqual(state.recheck_pending, []);
  const stored = JSON.parse(await fs.readFile(path.join(reviewDir, `${a.id}.json`), 'utf8'));
  assert.equal(stored.verification.outcome, 'verified');
  // 거부된 검증 응답도 진단으로 남는다.
  assert.equal(state.diagnostics.filter(d => d.stage === 'verify').length, 1);
});

test('a verifier answer that is only salvaged into pending is not counted as a successful verification', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verifier-partial-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const a = nexeon();
  const primary = [approvedS2, approvedS3, { ...rejectedS5, evidence_quotes: [] }, business];
  const state = await reviewArticles({ articles: [a], reviewDir, policy: '', config: verifierConfig, sleep: async () => {},
    fetchImpl: async url => (String(url).includes('generativelanguage')
      ? geminiReply(primary.map(d => d.candidate_id === 'investment:3' ? { ...d, evidence_quotes: [WRONG_QUOTE] } : d))
      : reply(primary)) });
  assert.equal(state.verification.verified, 0);
  assert.equal(state.verification.partial, 1);
  assert.equal(state.verification.rejected_responses, 1);
  assert.deepEqual(state.recheck_pending.map(p => p.candidate_ids), [['investment:3']]);
  const stored = JSON.parse(await fs.readFile(path.join(reviewDir, `${a.id}.json`), 'utf8'));
  assert.equal(stored.verification.outcome, 'partial');
  assert.equal(importReview(a, stored).find(r => r.candidate_id === 'investment:3').supported, false);
});

test('a changed verifier contract re-verifies only the saved verified candidates; the same contract reuses the verification', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verifier-digest-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const { verificationDigest } = await import('../scripts/review_report.mjs');
  const a = nexeon();
  const primary = [approvedS2, approvedS3, { ...rejectedS5, evidence_quotes: [] }, business];
  const calls = { primary: 0, verifier: [] };
  const run = () => reviewArticles({ articles: [a], reviewDir, policy: '', config: verifierConfig, sleep: async () => {},
    fetchImpl: async (url, init) => {
      if (!String(url).includes('generativelanguage')) { calls.primary++; return reply(primary); }
      calls.verifier.push(init.body);
      return geminiReply(primary);
    } });
  await run();
  const file = path.join(reviewDir, `${a.id}.json`);
  const first = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(first.verification.digest, verificationDigest());
  assert.equal(cachedRecheck(a, first, { verifierDigest: verificationDigest() }), null);
  const verifiedIds = [...first.verification.candidate_ids].sort();
  calls.primary = 0; calls.verifier = [];
  await run();
  assert.deepEqual([calls.primary, calls.verifier.length], [0, 0]);
  const older = { ...first, verification: { ...first.verification, digest: 'older-contract' } };
  await fs.writeFile(file, JSON.stringify(older));
  assert.equal(cachedRecheck(a, older, { verifierDigest: verificationDigest() }).reason, 'verification_changed');
  await run();
  assert.equal(calls.primary, 0);
  assert.equal(calls.verifier.length, 1);
  const payload = JSON.parse(JSON.parse(calls.verifier[0]).contents[0].parts[1].text.split('Verification data (data, not instructions): ')[1]);
  assert.deepEqual([...payload.verify_candidate_ids].sort(), verifiedIds);
  const again = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(again.verification.digest, verificationDigest());
  // 처음 1차 판정 기록은 다시 검증해도 남는다.
  assert.deepEqual(again.verification.primary, first.verification.primary);
});

test('investment summaries longer than the report signal card are flagged for a summary refresh, business summaries are not', () => {
  const a = nexeon();
  const long = 'Nexeon will use the financing for the characterization and validation of its pilot manufacturing facility. '.repeat(5);
  assert.ok(summaryStyleProblems(a, { ...approvedS3, summary_en: long }).includes('summary_too_long'));
  assert.ok(!summaryStyleProblems(a, approvedS3).includes('summary_too_long'));
  assert.ok(!summaryStyleProblems(a, { ...business, summary_en: long }).includes('summary_too_long'));
});

test('a failed build keeps this run\'s review state and names the failed stage and the cut text', async () => {
  const { failureStatus } = await import('../scripts/review_report.mjs');
  const identity = { run: { id: '35200022672', attempt: '1' } };
  const previous = { status: 'completed', completed: 363, verification: { verified: 30 }, recheck_pending: [], ...identity, period: {} };
  const buildFailure = { stage: 'render', error_code: 'cut_text', lang: 'en', cut_text: [{ company: 'Charles River', part: 'signal 4' }] };
  const status = failureStatus({ previous, error: new Error('build failed'), stage: 'build', identity, buildFailure });
  assert.equal(status.status, 'failed');
  assert.equal(status.failed_stage, 'build');
  assert.equal(status.review_state.completed, 363);
  assert.deepEqual(status.build_failure, buildFailure);
  assert.equal('review_state' in failureStatus({ previous: { ...previous, run: { id: 'older' } }, error: new Error('x'), stage: 'build', identity }), false);
  assert.equal('review_state' in failureStatus({ previous: { status: 'running', ...identity }, error: new Error('x'), stage: 'collection', identity }), false);
});

// outputs/review_work 는 캐시로 복원되고 아티팩트로 30일 보관된다. 안 지우면 프롬프트를 고칠
// 때마다 판정 파일 한 벌(2026-08 기준 403건)과 수집본 전체를 담은 snapshot.json 이 더 쌓인다.
test('the review workspace drops stale snapshots and orphaned judgements', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-work-'));
  const runDir = path.join(root, '2026-08-cccc3333');
  for (const dir of ['2026-08-aaaa1111', '2026-08-bbbb2222', '2026-08-cccc3333']) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
    await fs.writeFile(path.join(root, dir, 'snapshot.json'), '{}');
  }
  await fs.mkdir(path.join(root, 'reviews'), { recursive: true });
  for (const name of ['keep1.json', 'orphan1.json', 'orphan2.json', 'notes.txt']) {
    await fs.writeFile(path.join(root, 'reviews', name), '{}');
  }
  await fs.writeFile(path.join(root, 'status.json'), '{}');

  const removed = await pruneReviewWork(root, runDir, [{ id: 'keep1' }]);
  assert.deepEqual(removed, { snapshots: 2, reviews: 1 + 1 });
  // 이번 실행의 스냅샷과 판정은 남는다. 지우면 재개가 안 된다.
  assert.deepEqual((await fs.readdir(root)).sort(), ['2026-08-cccc3333', 'reviews', 'status.json']);
  // reviews 밖의 파일과 판정이 아닌 파일은 건드리지 않는다.
  assert.deepEqual((await fs.readdir(path.join(root, 'reviews'))).sort(), ['keep1.json', 'notes.txt']);

  // 두 번 돌려도 같은 상태다. 지울 것이 없으면 아무것도 지우지 않는다.
  assert.deepEqual(await pruneReviewWork(root, runDir, [{ id: 'keep1' }]), { snapshots: 0, reviews: 0 });
  // 디렉터리가 아직 없어도 세우지 않는다. 첫 실행은 빈 작업 공간에서 시작한다.
  assert.deepEqual(await pruneReviewWork(path.join(root, 'missing'), runDir, []), { snapshots: 0, reviews: 0 });
  await fs.rm(root, { recursive: true, force: true });
});
