import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionForApproval, decisionOutcome, importReview, sameEventAsBusiness,
  ungroundedSummaryDates, ungroundedSummaryNames } from '../scripts/local_report.mjs';
import { cachedRecheck, freshRecheckFeedback, needsRelevanceReview, relevanceConflictNotes,
  relevanceConflictSuspects, verificationSuspects } from '../scripts/review_report.mjs';

// AI 가 근거를 확인한 후보를 코드의 문자열 휴리스틱이 탈락시키던 세 자리를 고쳤다. 오탐은 줄이되
// 실제 근거 부족은 계속 막아야 하므로, 두 방향을 같은 파일에서 나란히 고정한다.

const BODY = 'Acme reported on its operations. '.repeat(20);

function article({ invQuote = 'Acme signed a membrane materials joint research agreement.',
  bizQuote = 'Acme also sells office furniture across Europe.', no = 4 } = {}) {
  return { id: 'acme', company: 'Acme', url: 'https://example.com/acme',
    title: 'Acme joint research', evidence: [invQuote, bizQuote],
    candidates: [
      { id: `investment:${no}`, kind: 'investment', row: { company: 'Acme', investment_signal_no: no, content_text: BODY } },
      { id: 'relevant', kind: 'relevant', row: { company: 'Acme', content_text: BODY } },
    ] };
}

const investment = (overrides = {}, no = 4) => ({ candidate_id: `investment:${no}`,
  entity_supported: true, target_technology_supported: true, indicator_supported: true,
  leading_indicator_supported: true, event_stage: 'precursor', quality: 'pass',
  evidence_quotes: ['Acme signed a membrane materials joint research agreement.'],
  reason: '타겟 막 소재의 공동연구가 본문에서 확인됨',
  summary_ko: '막 소재 공동연구 체결 - 타겟 막 소재 공동연구를 체결했음',
  summary_en: 'Acme signed a membrane materials joint research agreement.', ...overrides });

const business = (overrides = {}) => ({ candidate_id: 'relevant',
  entity_supported: true, target_technology_supported: true, indicator_supported: true,
  leading_indicator_supported: true, event_stage: 'not_applicable', quality: 'pass',
  evidence_quotes: ['Acme also sells office furniture across Europe.'],
  reason: '사업 활동이 확인됨', summary_ko: '유럽 사업을 이어가고 있음',
  summary_en: 'Acme continues to sell across Europe.', ...overrides });

const reviewOf = decisions => ({ article_id: 'acme', reviewer: 'test', decisions });

// 1. 원문 직함의 정상 영문 번역이 근거 없는 기관명으로 차단되지 않는다.
test('a translated job title is not treated as an ungrounded organisation', () => {
  const quotes = ['Dr. Dominic Dorfner tritt Amt als Vorstandsvorsitzender der JENOPTIK AG an.'];
  const summary = 'Dominic Dorfner became Chief Executive Officer of JENOPTIK AG.';
  assert.deepEqual(ungroundedSummaryNames(summary, quotes, 'Jenoptik leadership'), []);
  // 직함을 풀어 준다고 사람 이름까지 풀어 주지는 않는다.
  assert.deepEqual(ungroundedSummaryNames('Acme appointed Johanna Lindqvist as Chief Financial Officer.',
    ['Acme appointed a new finance chief.'], 'Acme appointment'), ['Johanna Lindqvist']);
});

// 2. 월 이름은 이름 검사에서 빠지지만, 근거 없는 날짜는 따로 검출된다.
test('a month name leaves the name check and enters the date check', () => {
  const summary = 'Veolia completed the acquisition in August 2026 at the Paris site.';
  const quotes = ['Veolia a finalise l acquisition sur le site de Paris.'];
  assert.deepEqual(ungroundedSummaryNames(summary, quotes, 'Veolia acquisition'), []);
  // 기사 본문이 그 달을 말하면 근거 있는 날짜다.
  assert.deepEqual(ungroundedSummaryDates(summary,
    ['Veolia a finalise l acquisition en August 2026 sur le site de Paris.'], 'Veolia acquisition'), []);
  // 기사 어디에도 없으면 요약이 지어낸 날짜다.
  assert.deepEqual(ungroundedSummaryDates(summary, quotes, 'Veolia acquisition', '2026-08-20'), ['August']);
  assert.deepEqual(ungroundedSummaryDates('Signed on 2026-08-14.', ['Signed last summer.'], 'Deal'), ['2026-08-14']);
  // May 는 달 이름이자 보통 낱말이다. 달로 읽히는 자리에서만 센다.
  assert.deepEqual(ungroundedSummaryDates('The plant may expand next year.', ['The plant may expand.'], 'Plant'), []);
  assert.deepEqual(ungroundedSummaryDates('The plant opened in May 2026.', ['The plant opened.'], 'Plant', '2026-08-20'), ['May']);
});

// Issue 3 Veolia: 원문이 "26 août 2026"이라 맞게 옮긴 "August"가 근거 없는 날짜로 걸렸다.
test('a month named in the source language grounds the English month', () => {
  const veolia = ['26 août 2026 Veolia émet avec succès 1,15 Md € sur le marché obligataire'];
  assert.deepEqual(ungroundedSummaryDates('Veolia issued bonds in August 2026.', veolia, 'Communiqués', '2014-02-24'), []);
  assert.deepEqual(ungroundedSummaryDates('Veolia issued bonds in July 2026.', veolia, 'Communiqués', '2014-02-24'), ['July']);
  assert.deepEqual(ungroundedSummaryDates('The order was placed in March 2026.', ['Auftrag im März 2026 erteilt.'], 'Auftrag'), []);
  assert.deepEqual(ungroundedSummaryDates('The plant opened in August 2026.', ['2026年8月3日に工場を開設した。'], '工場'), []);
  // 18月의 8을 8月로 읽지 않는다.
  assert.deepEqual(ungroundedSummaryDates('The plant opened in August 2026.', ['18月 2026'], '工場'), ['August']);
});

// Issue 3 Jenoptik: 원문 "same period last year"가 영문 문안에서 "same period of 2015"가 됐다.
test('a year the article never gives is caught; the publication year, amounts and ISO dates are not', () => {
  const source = ['Revenue of 503.2 million euros in the first half of 2026, up 1.0 percent on the same period last year.'];
  assert.deepEqual(ungroundedSummaryDates('Revenue rose to 503.2 million euros from the same period of 2015.', source, 'H1', '2026-08-12'), ['2015']);
  assert.deepEqual(ungroundedSummaryDates('First-half 2026 revenue rose 1.0 percent.', source, 'H1', '2026-08-12'), []);
  // 게시 연도는 본문에 없어도 근거가 있다.
  assert.deepEqual(ungroundedSummaryDates('Revenue rose in 2026.', ['Revenue rose.'], 'H1', '2026-08-12'), []);
  // 한국어 문안에도 같은 연도 검사가 걸린다.
  assert.deepEqual(ungroundedSummaryDates('2015년 동기 대비 매출이 증가했음.', source, 'H1', '2026-08-12'), ['2015']);
  // 연도처럼 보이는 금액은 연도가 아니다.
  assert.deepEqual(ungroundedSummaryDates('Acme raised $2000 million and 1999 percent.', ['Acme raised funds.'], 'Deal', '2026-08-12'), []);
  assert.deepEqual(ungroundedSummaryDates('Signed on 2026-08-14.', ['Signed on 2026-08-14.'], 'Deal'), []);
  // 두 자리 회계연도 표기는 네 자리 연도의 근거다.
  assert.deepEqual(ungroundedSummaryDates('The first quarterly profit since the fourth quarter of fiscal 2022.',
    ['First quarter with positive result since Q4 FY22'], 'Q3 FY26', '2026-08-05'), []);
});

// 3. 인용에 없는 기업·기관을 새로 불러온 요약은 계속 검출된다.
test('a summary that brings in an organisation the quotes never mention is still caught', () => {
  assert.deepEqual(ungroundedSummaryNames('Acme signed an agreement with Siemens Energy in Berlin.',
    ['Acme signed an agreement in Berlin.'], 'Acme agreement'), ['Siemens Energy']);
  const a = article();
  const decisions = [investment({ summary_en: 'Acme signed a joint research agreement with Fraunhofer Institute.' }), business()];
  assert.throws(() => importReview(a, reviewOf(decisions)), /summary names Fraunhofer Institute/);
});

// 5. 실제 기술 관련성 모순은 재검증 없이 조용히 승인되지 않는다.
test('a reason that really denies the target technology becomes a recheck suspect', () => {
  const a = article();
  const decisions = [investment({ reason: '지표 사건은 확인되나 타겟 기술과의 직접적 연계성은 확인되지 않음' }), business()];
  assert.deepEqual(relevanceConflictSuspects(a, decisions).map(d => d.candidate_id), ['investment:4']);
  assert.match(relevanceConflictNotes(a, decisions)[0], /reason says/);
  assert.equal(needsRelevanceReview(a, reviewOf(decisions)), true);
  assert.equal(cachedRecheck(a, reviewOf(decisions)).reason, 'relevance_conflict');
  // 검증기 질문에도 오르고, 같은 실행 안의 되묻기에도 들어간다.
  assert.ok(verificationSuspects(a, reviewOf(decisions)).flagged_because['investment:4'].some(q => /What exactly does reason deny/.test(q)));
  // 같은 실행 안의 되묻기는 어느 필드와 어느 구절이 충돌하는지 그대로 적어 보낸다.
  assert.match(freshRecheckFeedback(a, reviewOf(decisions)).validation_message,
    /investment:4: target_technology_supported=true but reason says "직접적 연계성은 확인되지"/);
});

// 4. 한국 투자 미언급이 타겟 기술 미연결로 오인되지 않는다.
test('English reasons still flag technology denials without treating Korea investment as technology', () => {
  const a = article();
  const denied = [investment({ reason: 'There is no direct link to the target membrane technology.' }), business()];
  assert.ok(relevanceConflictSuspects(a, denied).length > 0);
  assert.match(relevanceConflictNotes(a, denied)[0], /reason says "no direct link"/);
  const supported = [investment({ reason: 'Joint research on the target membrane is explicit, but investment in Korea is not mentioned.' }), business()];
  assert.deepEqual(relevanceConflictSuspects(a, supported), []);
});

test('a reason denying a different condition is not a relevance conflict', () => {
  const a = article();
  const decisions = [investment({ reason: '타겟 막 소재 공동연구는 명시되어 있으나 한국 투자 자체는 언급되지 않음.' }), business()];
  assert.deepEqual(relevanceConflictSuspects(a, decisions), []);
  assert.equal(needsRelevanceReview(a, reviewOf(decisions)), false);
  // 그리고 승인이 그대로 선다.
  assert.equal(importReview(a, reviewOf(decisions))[0].supported, true);
});

// 6. 한 기사 안 서로 다른 사건의 투자·사업동향 판정이 독립적으로 유지된다.
test('a business judgement about a different event does not reach the investment candidate', () => {
  const a = article();
  const decisions = [investment(), business({ target_technology_supported: false, reason: '사무가구는 타겟 품목이 아님' })];
  assert.equal(sameEventAsBusiness(decisions[0], decisions[1]), false);
  assert.equal(decisionForApproval(a, decisions, decisions[0]).target_technology_supported, true);
  assert.equal(decisionOutcome(a, decisions, decisions[0]).supported, true);
  assert.deepEqual(relevanceConflictSuspects(a, decisions), []);
});

// 7. 같은 사건의 기술 판단 충돌은 검출되고, 예전 GE Healthcare 회귀도 그대로 막힌다.
test('two candidates quoting one passage may not disagree about the technology link', () => {
  const quote = 'Acme signed a membrane materials joint research agreement.';
  const a = article({ bizQuote: quote });
  const decisions = [investment(), business({ evidence_quotes: [quote], target_technology_supported: false,
    reason: '이 제품은 타겟 품목이 아님' })];
  assert.equal(sameEventAsBusiness(decisions[0], decisions[1]), true);
  // 예전처럼 사업동향 판정을 따른다. 승인이 조용히 나가지 않는다.
  assert.equal(decisionForApproval(a, decisions, decisions[0]).target_technology_supported, false);
  assert.equal(decisionOutcome(a, decisions, decisions[0]).supported, false);
  // 그리고 그 충돌을 근거와 함께 다시 묻는다.
  assert.deepEqual(relevanceConflictSuspects(a, decisions).map(d => d.candidate_id), ['investment:4']);
  assert.match(relevanceConflictNotes(a, decisions)[0], /quote the same passage/);
  // 인용이 없는 쪽이 있으면 가릴 수 없으므로 예전처럼 사업동향을 따른다.
  assert.equal(sameEventAsBusiness(investment({ evidence_quotes: [] }), decisions[1]), true);
});

// 8. 재검토를 끝내지 못한 후보는 자동 발행되지 않고, 무관한 후보는 보존된다.
test('an unresolved conflict is held back while the other candidates keep their judgement', () => {
  const quote = 'Acme signed a membrane materials joint research agreement.';
  const a = article({ bizQuote: quote });
  const decisions = [investment(), business({ evidence_quotes: [quote] })];
  const pending = { ...reviewOf(decisions), semantic_recheck_pending: { reason: 'relevance_conflict', candidate_ids: ['investment:4'] } };
  const results = importReview(a, pending);
  const held = results.find(r => r.candidate_id === 'investment:4');
  // 판정은 살아 있지만 보고서에는 실리지 않는다. 대시보드에는 남아 무엇이 보류됐는지 보인다.
  assert.equal(held.supported, false);
  assert.equal(held.row?.ai_signal_supported, false);
  assert.equal(results.find(r => r.candidate_id === 'relevant').supported, true);
});

// 기술 조건이 없는 후보에는 이 검사 자체를 걸지 않는다(기업 단위 지표·면제 기업).
test('candidates that need no target-technology link are never relevance suspects', () => {
  for (const no of [3, 5]) {
    const a = article({ no });
    const decisions = [investment({ reason: '타겟 기술과의 직접적 연계성은 확인되지 않음' }, no), business()];
    assert.deepEqual(relevanceConflictSuspects(a, decisions), [], `S${no}`);
  }
});
