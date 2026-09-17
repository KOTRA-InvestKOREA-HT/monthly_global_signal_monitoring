#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sourceCandidates, groupArticles, humanReviewGaps, decisionForApproval, decisionOutcome, importReview, normalizeQuote, build, decisionNumberProblems } from './local_report.mjs';
import { resolveProvider, resolveVerifier, describeKeyShape, DATE_HINT_VERSION } from './review_providers.mjs';
import { PROMPT_VERSION, reviewPromptDigest } from './review_prompts.mjs';
import { CONTENT_COLLECTION_VERSION } from './collect_company_signals.mjs';
import { collectionInputDigest, collectionNeedsRefresh } from './collection_resilience.mjs';
import { reportEligible, periodPlacement } from './date_state.mjs';
import { investmentStageSupported } from './validate_report_inputs.mjs';
import { resolveReportPeriod } from './report_period.mjs';

// REPORT_PROVIDER로 제공자를 선택한다. CLI와 Actions는 같은 기사 검토 경로를 쓴다.
// 모델 이름은 정책 다이제스트에 들어가므로, 바꾸면 앞선 판정은 재사용되지 않는다.
export const PROVIDER = resolveProvider();
export const MODEL = PROVIDER.model;
export const VERIFIER = resolveVerifier();
const VERIFICATION_VERSION = 'verifier-v2';
const VERSION = 'article-review-v1';
export function publishedSignalCounts(rows, period) {
  // 사람 검토 후보는 한·영 문안이 있어야 PDF에 실린다(build_pdf_report.signal_needs_human_review).
  // 여기서도 같은 기준으로 세야 요약 파일의 보고서 건수·기업 수가 PDF와 맞는다.
  const inReport = row => reportEligible(row, period) && (row.ai_review_tier !== 'human_review' ||
    Boolean(String(row.ai_summary_ko || '').trim() && String(row.ai_summary_en || '').trim()));
  const published = rows.filter(inReport);
  // 사람 검토 후보도 보고서에 들어가지만 AI 승인은 아니므로 따로 센다.
  const humanReview = rows.filter(row => row.ai_review_tier === 'human_review');
  return { approved_count: rows.length - humanReview.length, human_review_count: humanReview.length,
    report_signal_count: published.length,
    approved_companies_in_report: new Set(published.filter(row => row.ai_review_tier !== 'human_review').map(row => row.company)).size,
    date_pending_count: rows.filter(row => periodPlacement(row, period).placement === 'date_pending').length,
    out_of_period_count: rows.filter(row => periodPlacement(row, period).placement === 'out_of_period').length,
    companies_in_report: new Set(published.map(row => row.company)).size };
}
const STAGE_REVIEW_VERSION = 'candidate-event-v3';
const FORM3_REVIEW_VERSION = 'form3-personnel-event-v1';
const SUMMARY_REVIEW_VERSION = 'human-review-summary-v2';
const FUNDING_REVIEW_VERSION = 'funding-event-v2';
const FACILITY_STAGE_REVIEW_VERSION = 'facility-stage-v1';
// v2: 2차 검증기를 넣은 뒤, 1차 모델만 확인했던 저장된 기술 연결 승인을 한 번 검증기로 보낸다.
const TECHNOLOGY_REVIEW_VERSION = 'technology-link-v2';
const ACQUISITION_REVIEW_VERSION = 'acquisition-event-v1';
const SUMMARY_ACCURACY_VERSION = 'summary-accuracy-v1';
const SUMMARY_STYLE_VERSION = 'summary-style-v1';
// 전조(precursor)를 쓸 수 있는 지표는 1·3·4·5인데, 이 재검토는 오랫동안 4번만 훑었다.
// 그래서 Nexeon 의 1억 파운드 조달(investment:3)처럼 나머지 조건이 모두 true 인데
// 단계 판정 하나로 탈락한 건이 재검토 대상에 아예 오르지 못했다. 범위를 정책과 맞춘다.
// 판정을 자동으로 precursor 로 바꾸지는 않는다. 다시 물어볼 뿐이다.
export function needsStageReview(article, review) {
  return review.stage_review_version !== STAGE_REVIEW_VERSION && stageSuspects(article, review.decisions).length > 0;
}

const technologyOrExempt = (article, d) => d.target_technology_supported ||
  article.candidates.find(c => c.id === d.candidate_id)?.relevance_exempt;
const signalNo = d => String(d.candidate_id || '').split(':')[1];

// 조달·협약·임명처럼 중간 활동이 끝난 것을 최종 투자 완료로 적은 후보. 2026-08 실행 35167466191 의
// Nexeon 1억 파운드 라운드도 새 응답에서 S3=completed 였다. 다시 물을 뿐 단계를 바꾸지는 않는다.
export function stageSuspects(article, decisions) {
  return decisions.filter(d => investmentStageSupported('precursor', signalNo(d)) &&
    ['committed', 'completed'].includes(d.event_stage) &&
    d.entity_supported && d.indicator_supported && technologyOrExempt(article, d));
}

// 같은 실행: Air Liquide 반기보고서의 애리조나 1.6억 달러 생산유닛(신규 계약, 2028년 가동)이 S2 planned 로
// 승인됐다. 결정된 시설투자의 미래 가동일은 미확정 계획이 아니다. 인용에 투자·건설과 가동 시점이 함께 있는
// 승인 가능한 S2 만 한 번 다시 묻는다. 낱말은 재검토 대상을 고를 뿐이고 결론은 새 판정이 내린다.
const FACILITY_START = /\b(?:start[- ]?ups?|commission\w*|come on stream|operational by|begin (?:production|operations)|production (?:is )?(?:planned|scheduled|expected) to (?:begin|start))\b/i;
const FACILITY_DECIDED = /\b(?:invest\w*|build\w*|construct\w*|contracts?)\b/i;
export function facilityStageSuspects(article, decisions) {
  return decisions.filter(d => signalNo(d) === '2' && ['planned', 'exploratory'].includes(d.event_stage) &&
    d.entity_supported && d.indicator_supported && d.leading_indicator_supported && technologyOrExempt(article, d) &&
    (d.evidence_quotes || []).some(quote => FACILITY_START.test(quote) && FACILITY_DECIDED.test(quote)));
}
export function needsFacilityStageReview(article, review) {
  return review.facility_stage_review_version !== FACILITY_STAGE_REVIEW_VERSION && facilityStageSuspects(article, review.decisions).length > 0;
}

// 같은 실행: Infineon 우주망원경용 전력반도체를 위성통신·레이다 RF 반도체로, Plansee 텅스텐 재활용을
// 티타늄·탄탈륨 타겟으로, NXP 차량용 UWB 를 우주항공 RF 반도체로 인정해 사업동향이 실렸다. 기술 연결 지시를 넣기 전에 저장된
// 판정 중 면제가 아닌데 기술 연결로 보고서에 실리는 것만 한 번 다시 묻는다.
export function needsTechnologyReview(article, review) {
  if (review.technology_review_version === TECHNOLOGY_REVIEW_VERSION) return false;
  return review.decisions.some(d => d.target_technology_supported &&
    !article.candidates.find(c => c.id === d.candidate_id)?.relevance_exempt &&
    publishedDecision(article, review.decisions, d));
}

// 실행 35175067142: HyproMag S1 이 모회사의 Remloy 인수 완료와 그 인수로 넘어온 원료 345톤을 공급망 전조로 승인했다.
// 완료된 인수와 그에 딸린 시설·재고는 인수 자체이지 별도의 공급망 조치가 아니다. S1·S4 로 실릴 수 있는 판정 중
// 인용·문안이 인수 완료를 말하는 것만 한 번 다시 묻는다. 결론은 새 판정이 내린다.
const COMPLETED_ACQUISITION = /\b(?:complet\w* (?:the |its |our )?acquisition|acquisition\b.{0,60}\b(?:completed|closed)|following (?:the )?completion|has acquired)\b/i;
// 기술 기업 소수 지분투자는 판정 지침상 S4 사건이다(Maxon 의 Synapticon 소수 지분). 지분 취득은 여기서 고르지 않는다.
const MINORITY_STAKE = /\b(?:minority|stake|equity investment|shareholding)\b/i;
export function acquisitionSuspects(article, decisions) {
  return decisions.filter(d => {
    if (!['1', '4'].includes(signalNo(d)) || !d.entity_supported || !d.indicator_supported ||
      !['precursor', 'planned', 'exploratory'].includes(d.event_stage)) return false;
    const text = [...(d.evidence_quotes || []), d.summary_en].join(' ');
    return COMPLETED_ACQUISITION.test(text) && !MINORITY_STAKE.test(text);
  });
}
export function needsAcquisitionReview(article, review) {
  return review.acquisition_review_version !== ACQUISITION_REVIEW_VERSION && acquisitionSuspects(article, review.decisions).length > 0;
}

// 2차 검증에 보낼 의심 후보와 사유. 재검토 규칙에 걸린 후보, 면제가 아닌데 기술 연결로 발행될 후보, 지난번 확인을
// 끝내지 못한 후보다. 기술 연결은 실행 35167466191·35175067142 에서 가장 자주 반복된 오판이라 발행 전에 늘 검증한다.
// 검증 질문. 1차 답을 보여 주지 않는 대신, 규칙이 걸린 이유를 모델이 근거로 먼저 답해야 하는 질문으로 준다.
// 저장된 판정의 재검토 사유 코드(cachedRecheck)도 같은 질문으로 바꿔 보낸다.
export const VERIFY_QUESTIONS = {
  candidate_event_stage: 'What is this candidate\'s own event (for example a funding round, an agreement, an appointment or a study)? ' +
    'Is that event itself the final investment, such as a plant built or a deal closed, or an intermediate step toward one? ' +
    'Only the final investment itself is committed or completed; an intermediate step is precursor.',
  facility_stage: 'Has the company already decided, contracted or started building the quoted facility? ' +
    'A decided or contracted facility with a future start-up date is committed, not planned.',
  funding_event: 'Does the quoted financing raise new money for a stated use, or does it replace, renew, amend or extend an existing ' +
    'facility? Refinancing an existing facility is not an S3 event.',
  acquisition_event: 'Does the approval rest on an acquisition that is already completed, or on sites, inventory or assets that came ' +
    'with it? A completed acquisition is not an S1 or S4 precursor; only a separate minority stake or a separate collaboration can count.',
  technology_link: 'Name the specific product, service or activity this event is about. Is that product itself within target_technology, ' +
    'and within target_technology_scope includes rather than its excludes? Activity in a different business of the company does not link.',
  form3_personnel_event: 'Does the filing itself announce a new appointment, or does it only report an officer\'s ownership status? ' +
    'A Form 3 alone is not a personnel signal.',
  semantic_recheck_pending: 'The previous check did not complete. Judge this candidate from scratch against every criterion.',
};
export function verificationSuspects(article, review) {
  const reasons = new Map();
  const add = (id, reason) => reasons.set(id, [...new Set([...(reasons.get(id) || []), VERIFY_QUESTIONS[reason] || reason])]);
  for (const d of stageSuspects(article, review.decisions)) add(d.candidate_id, 'candidate_event_stage');
  for (const d of facilityStageSuspects(article, review.decisions)) add(d.candidate_id, 'facility_stage');
  for (const d of fundingSuspects(article, review.decisions)) add(d.candidate_id, 'funding_event');
  for (const d of acquisitionSuspects(article, review.decisions)) add(d.candidate_id, 'acquisition_event');
  for (const d of review.decisions) {
    const candidate = article.candidates.find(c => c.id === d.candidate_id);
    if (d.target_technology_supported && candidate && !candidate.relevance_exempt && publishedDecision(article, review.decisions, d)) {
      add(d.candidate_id, 'technology_link');
    }
  }
  for (const id of review.semantic_recheck_pending?.candidate_ids || []) add(id, 'semantic_recheck_pending');
  if (!reasons.size) return null;
  return { candidate_ids: [...reasons.keys()], flagged_because: Object.fromEntries(reasons) };
}

const RECHECK_VERSIONS = () => ({ stage_review_version: STAGE_REVIEW_VERSION, form3_review_version: FORM3_REVIEW_VERSION,
  funding_review_version: FUNDING_REVIEW_VERSION, facility_stage_review_version: FACILITY_STAGE_REVIEW_VERSION,
  technology_review_version: TECHNOLOGY_REVIEW_VERSION, acquisition_review_version: ACQUISITION_REVIEW_VERSION });

// 검증 결과를 1차 판정에 합친다. 의심 후보의 판정만 검증 모델의 것으로 바꾸고 나머지는 1차 판정 그대로 둔다.
export function mergeVerification(article, primary, checked, suspects, model = VERIFIER?.model) {
  const ids = new Set(suspects.candidate_ids);
  const verified = new Map(checked.decisions.map(d => [d.candidate_id, d]));
  const decisions = primary.decisions.map(d => (ids.has(d.candidate_id) && verified.has(d.candidate_id) ? verified.get(d.candidate_id) : d));
  const outcome = (all, d) => {
    const { supported, gaps } = decisionOutcome(article, all, d);
    return supported ? 'approved' : gaps?.length ? 'human_review' : 'rejected';
  };
  const pending = [...(primary.semantic_recheck_pending?.candidate_ids || []).filter(id => !ids.has(id)),
    ...(checked.semantic_recheck_pending?.candidate_ids || []).filter(id => ids.has(id))];
  const removed = (checked.unverified_quotes_removed || []).filter(item => ids.has(item.candidate_id));
  const { semantic_recheck_pending, ...rest } = primary;
  return {
    ...rest, ...RECHECK_VERSIONS(), decisions,
    ...(removed.length ? { unverified_quotes_removed: removed } : {}),
    ...(pending.length ? { semantic_recheck_pending: { reason: 'verifier_evidence_unverified', candidate_ids: pending } } : {}),
    verification: { version: VERIFICATION_VERSION, model, candidate_ids: [...ids], flagged_because: suspects.flagged_because,
      changed: [...ids].filter(id => {
        const before = primary.decisions.find(d => d.candidate_id === id), after = decisions.find(d => d.candidate_id === id);
        return before && after && (outcome(primary.decisions, before) !== outcome(decisions, after) || before.event_stage !== after.event_stage);
      }),
      primary: primary.decisions.filter(d => ids.has(d.candidate_id)).map(({ candidate_id, entity_supported, target_technology_supported,
        indicator_supported, leading_indicator_supported, event_stage, quality, reason_ko }) => ({ candidate_id, entity_supported,
        target_technology_supported, indicator_supported, leading_indicator_supported, event_stage, quality, reason_ko })) },
  };
}

// 저장된 판정을 다시 묻는 이유와 대상 후보. 다시 묻다가 실패하면 이 후보들을 재검토 미완료로 남긴다.
// 실행 35175067142 의 Vestas 는 기술 연결 재검토가 두 번 실패했는데 옛 판정이 그대로 남아, 실행 상태는 실패인데
// 보고서는 검토 완료로 셌다.
export function cachedRecheck(article, review) {
  const ids = items => [...new Set(items.map(d => d.candidate_id))];
  if (review.semantic_recheck_pending) return { reason: 'semantic_recheck_pending', candidate_ids: review.semantic_recheck_pending.candidate_ids || [] };
  if (needsStageReview(article, review)) return { reason: 'candidate_event_stage', candidate_ids: ids(stageSuspects(article, review.decisions)) };
  if (needsForm3Review(article, review)) return { reason: 'form3_personnel_event', candidate_ids: ['investment:5'] };
  if (needsFundingReview(article, review)) return { reason: 'funding_event', candidate_ids: ids(fundingSuspects(article, review.decisions)) };
  if (needsFacilityStageReview(article, review)) return { reason: 'facility_stage', candidate_ids: ids(facilityStageSuspects(article, review.decisions)) };
  if (needsAcquisitionReview(article, review)) return { reason: 'acquisition_event', candidate_ids: ids(acquisitionSuspects(article, review.decisions)) };
  if (needsTechnologyReview(article, review)) return { reason: 'technology_link', candidate_ids: ids(review.decisions.filter(d =>
    d.target_technology_supported && !article.candidates.find(c => c.id === d.candidate_id)?.relevance_exempt &&
    publishedDecision(article, review.decisions, d))) };
  return null;
}

// A Form 3 records an officer's reporting status but does not itself announce
// an appointment. Older review 9ff5363 inferred a personnel move from the title
// alone. Recheck only previously approved S5 Form 3 candidates once under the
// explicit instruction below. The fresh semantic decision is accepted without
// a wording whitelist, so legitimate appointments phrased differently survive.
export function needsForm3Review(article, review) {
  if (review.form3_review_version === FORM3_REVIEW_VERSION) return false;
  return review.decisions.some(decision => {
    const candidate = article.candidates.find(item => item.id === decision.candidate_id);
    if (candidate?.kind !== 'investment' || Number(candidate.row?.investment_signal_no) !== 5 ||
        candidate.row?.source_kind !== 'filing' ||
        !/(?:\bform\s*3\b|initial statement of beneficial ownership)/i.test(candidate.row?.title || '')) return false;
    const supported = decision.entity_supported && (candidate.relevance_exempt || decision.target_technology_supported) &&
      decision.indicator_supported && decision.leading_indicator_supported && decision.quality === 'pass' &&
      investmentStageSupported(decision.event_stage, 5);
    return supported;
  });
}
// 사람 검토 후보는 한·영 문안이 있어야 PDF에 실린다. 원문 발췌를 대신 싣으면 한국어판에 영어·일본어
// 본문이나 "PDF 3.29 MB" 같은 링크 문구가 그대로 나간다(2026-08 실행). 문안이 빈 후보를 짚어 한 번 더
// 묻고, 그래도 없으면 대시보드에만 남긴다. 버전을 찍으므로 같은 기사를 반복해서 묻지 않는다.
export function missingReviewSummaryIds(article, review) {
  return review.decisions.filter(decision => {
    const candidate = article.candidates.find(item => item.id === decision.candidate_id);
    const gated = candidate ? decisionForApproval(article, review.decisions, decision) : null;
    const gaps = gated ? humanReviewGaps(candidate, gated) : null;
    return Boolean(gaps?.length) && !(String(decision.summary_ko || '').trim() && String(decision.summary_en || '').trim());
  }).map(decision => decision.candidate_id);
}
export function needsReviewSummary(article, review) {
  return review.summary_review_version !== SUMMARY_REVIEW_VERSION && missingReviewSummaryIds(article, review).length > 0;
}
// S3 는 새 자금 조달만 신호다. 2026-08 BorgWarner 기존 회사채 현금 공개매수와 Vestas 기존 채권 상환용
// 유로본드가 투자 재원 확보 후보로 올라왔다. 공개매수·매입·상환·재조달이 제목이나 인용에 나오는 S3
// 판정 중 보고서에 실릴 수 있는 것만 새 지시로 한 번 다시 묻는다. 낱말은 재검토 대상을 고를 뿐이고
// 결론은 새 판정이 내린다.
// 실행 35167466191: 3M 이 같은 42.5억 달러 기존 리볼빙 신용계약을 새 계약으로 대체한 8-K 가 S3 로 승인됐다.
// 대체·갱신·변경 계약도 같은 재검토 대상이다. 인용에 대체 사실이 없어도 요약이 적었으면 잡는다.
const NOT_NEW_FUNDING = /\b(?:tender offers?|repurchas\w*|buy-?backs?|redempt\w*|redeem\w*|repay\w*|refinanc\w*|prepay\w*|replac\w*|renew\w*|amend(?:ed|ment|ments)?)\b/i;
export function fundingSuspects(article, decisions) {
  return decisions.filter(decision => {
    const candidate = article.candidates.find(item => item.id === decision.candidate_id);
    if (candidate?.kind !== 'investment' || Number(candidate.row?.investment_signal_no) !== 3) return false;
    if (!decision.entity_supported || !decision.indicator_supported) return false;
    return NOT_NEW_FUNDING.test([candidate.row?.title, ...(decision.evidence_quotes || []), decision.summary_en].join(' '));
  });
}
export function needsFundingReview(article, review) {
  return review.funding_review_version !== FUNDING_REVIEW_VERSION && fundingSuspects(article, review.decisions).length > 0;
}

// 새 응답 하나에서 위 재검토 규칙에 걸리는 후보. 저장된 판정만 다시 묻던 탓에, 새로 받은 응답이 같은 실수를
// 하면(Nexeon S3=completed) 다음 버전이 오를 때까지 그대로 남았다. 같은 실행 안에서 한 번만 되묻는다.
export function freshRecheckFeedback(article, review) {
  const ids = [...new Set([...stageSuspects(article, review.decisions), ...facilityStageSuspects(article, review.decisions),
    ...fundingSuspects(article, review.decisions), ...acquisitionSuspects(article, review.decisions)].map(d => d.candidate_id))];
  const items = [
    ...stageSuspects(article, review.decisions).map(d => `${d.candidate_id}: event_stage=${d.event_stage} for a completed ` +
      'funding, agreement or appointment. Such an intermediate activity is precursor; committed/completed is only for the final investment itself.'),
    ...facilityStageSuspects(article, review.decisions).map(d => `${d.candidate_id}: event_stage=${d.event_stage}. An investment ` +
      'in a facility that is already decided or contracted is committed even when its start-up date is in the future; check whether ' +
      'the evidence shows an undecided plan and whether it is newly announced in the reporting period.'),
    ...fundingSuspects(article, review.decisions).map(d => `${d.candidate_id}: the evidence mentions replacing, renewing, amending, ` +
      'repaying or refinancing. Replacing an existing facility is not new funding unless additional money and an investment or expansion use are stated.'),
    ...acquisitionSuspects(article, review.decisions).map(d => `${d.candidate_id}: the evidence reports a completed acquisition. ` +
      'The acquisition and the plants, stock or feedstock that came with it are not a supply-chain or technology precursor; approve only a ' +
      'separate action the evidence states, otherwise indicator_supported=false.'),
  ];
  return items.length ? { reason: 'semantic_recheck', candidate_ids: ids,
    validation_message: `Recheck only these judgements against the rules: ${items.join(' ')}` } : null;
}

// 요약 숫자 검증을 넣기 전에 저장된 판정은 틀린 숫자를 가질 수 있다. 보고서에 실리는 문안의 숫자가
// 기사에 없을 때만 문안을 한 번 다시 받는다.
const SUMMARY_NUMBERS_VERSION = 'summary-numbers-v1';

// 보고서에 실리는 판정. 승인된 투자 시그널, 사람 검토 후보, 승인된 사업동향이다.
function publishedDecision(article, decisions, decision) {
  const candidate = article.candidates.find(item => item.id === decision.candidate_id);
  const gated = candidate && decisionForApproval(article, decisions, decision);
  if (!gated || !gated.entity_supported || !gated.indicator_supported) return false;
  if (candidate.kind === 'relevant') {
    return Boolean((candidate.relevance_exempt || gated.target_technology_supported) && gated.quality === 'pass');
  }
  return Array.isArray(humanReviewGaps(candidate, gated));
}

// 요약 정확성 지시(시제·실제 사건·국가명·관계 과장 금지)를 넣기 전에 저장된 판정은 옛 문안이다.
// 보고서에 실리는 판정이 있는 기사만 한 번 다시 묻고, 판정은 옮기지 않고 문안만 옮긴다.
export function needsSummaryRefresh(article, review) {
  const published = review.decisions.filter(decision => publishedDecision(article, review.decisions, decision));
  if (!published.length) return false;
  if (review.summary_accuracy_version !== SUMMARY_ACCURACY_VERSION) return true;
  if (review.summary_style_version !== SUMMARY_STYLE_VERSION &&
    published.some(decision => summaryStyleProblems(article, decision).length > 0)) return true;
  return review.summary_numbers_version !== SUMMARY_NUMBERS_VERSION &&
    published.some(decision => decisionNumberProblems(article, decision).length > 0);
}

// 실행 35167466191 보고서: Qualcomm·Renishaw 한국어 문안이 "~했다/~예정이다"로 끝났고, 영문에는 Qualcomm·
// Air Products·Cognex 로 적은 회사명을 한국어에서는 퀄컴·에어프로덕츠·코그넥스로 음차했다. 둘 다 정책 위반이다.
// 음차 목록을 만들지 않는다. 영문 문장이 회사 영문명으로 시작하는데 한국어 문장은 한글 낱말+조사(은·는·이·가·의)로
// 시작하고 영문명이 없을 때만 잡는다. 투자 시그널 문안은 회사명을 쓰지 않는 것이 규칙이므로 이름이 없는 것만으로는 잡지 않는다.
const KOREAN_PLAIN_ENDING = /(?:다|습니다|요)[.!]?$/;
const detailPart = text => (text.includes(' - ') ? text.slice(text.indexOf(' - ') + 3) : text).trim();
// 한·영 문안이 같은 사실을 담는지. 월과 백분율만 본다. 금액은 단위 표기가 달라 숫자 검증이 따로 맡는다.
// 실행 35175067142: Renishaw 한국어 문안에만 "2026년 9월 SEMICON Taiwan, 10월 SEMICON West" 일정이 있었다.
const EN_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const factSet = values => [...new Set(values)].sort().join(',');
export function bilingualFactProblems(decision) {
  const ko = String(decision.summary_ko || ''), en = String(decision.summary_en || '');
  if (!ko.trim() || !en.trim()) return [];
  const koMonths = factSet([...ko.matchAll(/(?<!\d)(1[0-2]|[1-9])월/g)].map(m => Number(m[1])));
  const enMonths = factSet([...en.matchAll(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/gi)]
    .filter(m => !(m[1].toLowerCase() === 'may' && m[0] === 'may')).map(m => EN_MONTHS.indexOf(m[1].toLowerCase()) + 1));
  const koPercents = factSet([...ko.matchAll(/(\d+(?:\.\d+)?)\s?(?:%|퍼센트)/g)].map(m => Number(m[1])));
  const enPercents = factSet([...en.matchAll(/(\d+(?:\.\d+)?)\s?(?:%|percent\b)/gi)].map(m => Number(m[1])));
  return [...(koMonths !== enMonths ? ['bilingual_month_mismatch'] : []), ...(koPercents !== enPercents ? ['bilingual_percent_mismatch'] : [])];
}

// 보고서 검토에서 확인된 오역. 영문 원어와 짝을 이룰 때만 잡는다(실행 35167466191·35175067142).
const MISTRANSLATIONS = [
  { ko: /멤버십|배치 방식/, en: /scheme of arrangement/i },
  { ko: /말기/, en: /late[- ]stage/i },
  { ko: /함대/, en: /(?:^|[^a-z])fleet(?:[^a-z]|$)/i },
];
export function summaryStyleProblems(article, decision) {
  const ko = String(decision.summary_ko || '').trim();
  if (!ko) return [];
  const problems = [...bilingualFactProblems(decision)];
  if (MISTRANSLATIONS.some(term => term.ko.test(ko) && term.en.test(String(decision.summary_en || '')))) problems.push('mistranslated_term');
  // 투자 시그널 표제(" - " 앞)는 명사구라 문장 끝 검사는 상세·사업동향 문장에만 한다.
  const body = detailPart(ko);
  if (body.split(/(?<=[.!?])\s+/).some(sentence => KOREAN_PLAIN_ENDING.test(sentence.trim()))) problems.push('plain_sentence_ending');
  const candidate = article.candidates.find(item => item.id === decision.candidate_id);
  const names = [article.company, ...(candidate?.row?.query_aliases || [])].filter(Boolean)
    .flatMap(name => [name, name.split(/\s+/)[0]]).filter(name => name.length >= 4).map(name => name.toLowerCase());
  const enBody = detailPart(String(decision.summary_en || '')).toLowerCase();
  const subject = body.match(/^([가-힣]{2,})(?:은|는|이|가|의)\s/);
  if (subject && names.some(name => enBody.startsWith(name)) && !names.some(name => ko.toLowerCase().includes(name))) {
    problems.push('company_name_not_latin');
  }
  return problems;
}

export function mergeRefreshedSummaries(article, review, fresh) {
  const freshById = new Map((fresh?.decisions || []).map(decision => [decision.candidate_id, decision]));
  const decisions = review.decisions.map(decision => {
    const next = freshById.get(decision.candidate_id);
    if (!publishedDecision(article, review.decisions, decision) || !next) return decision;
    if (!String(next.summary_ko || '').trim() || !String(next.summary_en || '').trim()) return decision;
    return { ...decision, summary_ko: next.summary_ko, summary_en: next.summary_en };
  });
  return { ...review, decisions, summary_accuracy_version: SUMMARY_ACCURACY_VERSION, summary_numbers_version: SUMMARY_NUMBERS_VERSION, summary_style_version: SUMMARY_STYLE_VERSION };
}
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const write = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n');
  await fs.rename(`${file}.tmp`, file);
};

export function configuration(env = process.env, provider = resolveProvider(env)) {
  const prefix = provider.id.toUpperCase();
  // Gemini 는 API 가 무료 티어를 강제하지 못하므로 사람이 확인했다는 표시를 요구한다.
  // NVIDIA 무료 키는 선불 크레딧이라 같은 위험이 없다.
  if (provider.requiresFreeTierConfirmation && env[`${prefix}_FREE_TIER_CONFIRMED`] !== 'true') {
    throw new Error(`Set ${prefix}_FREE_TIER_CONFIRMED=true only after confirming this key belongs to a project with no paid billing. The API cannot enforce free-tier billing.`);
  }
  const keyEnv = provider.keyEnv.find(name => env[name]);
  if (!keyEnv) throw new Error(`${provider.keyEnv.join(' or ')} is required`);
  const maxRequests = Number(env[`${prefix}_MAX_REQUESTS`] || env.REPORT_MAX_REQUESTS || 600);
  const delayMs = Number(env[`${prefix}_DELAY_MS`] || env.REPORT_DELAY_MS || provider.defaultDelayMs);
  // 무료 티어의 분당 요청 한도는 동시 실행 수와 무관하게 공유된다. 8 이면 한도에 먼저
  // 부딪혀 429 재시도로 되돌아오는 낭비가 커서 4 로 낮춘다. REPORT_CONCURRENCY 로 올릴 수 있다.
  const concurrency = Number(env.REPORT_CONCURRENCY || 4);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 12) throw new Error('REPORT_CONCURRENCY must be 1..12');
  // 대기 하한은 프로바이더의 관측 RPM 에서 온다(60000 / RPM). 429 가 나도 저장 후 멈추고
  // 다음 실행이 이어간다. 2026-08 첫 판정(34939670823)은 기사 372건에 재시도·보강이 붙어 400건에서
  // 358건만 끝냈다. 600 이면 한 회차가 한 번에 끝난다.
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 600) throw new Error(`${prefix}_MAX_REQUESTS must be 1..600`);
  if (!Number.isFinite(delayMs) || delayMs < provider.minDelayMs || delayMs > 60000) {
    throw new Error(`${prefix}_DELAY_MS must be ${provider.minDelayMs}..60000`);
  }
  // 2차 검증은 Gemini 키와 무료 등급 확인이 있을 때만 켠다. 없으면 기존처럼 1차 모델에게 한 번 되묻는다.
  const verifier = resolveVerifier(env);
  const verifierApiKey = verifier && env.GEMINI_FREE_TIER_CONFIRMED === 'true' ? String(env.GEMINI_API_KEY || '').trim() : '';
  return { apiKey: String(env[keyEnv]).trim(), maxRequests, delayMs, concurrency, ...(verifierApiKey ? { verifierApiKey } : {}) };
}

// 아티팩트만 보고 어느 실행·어느 커밋의 결과인지 알 수 있어야 한다. 로컬 실행에서는 비어 있다.
export function runIdentity(env = process.env) {
  const run = { id: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, sha: env.GITHUB_SHA, ref: env.GITHUB_REF_NAME };
  const named = Object.entries(run).filter(([, value]) => value);
  return named.length ? { run: Object.fromEntries(named) } : {};
}

// status.json 은 캐시(outputs/review_work) 안에 있어 지난 실행의 것이 복원된다. 이번 실행이
// 중단되면 아티팩트에는 남의 실행 결과만 남고, 그것이 이번 실행의 결과로 읽힌다.
// 그래서 긴 작업을 시작하기 전에 이번 실행의 표시로 먼저 덮어쓴다.
export function startingStatus(period) {
  return { status: 'running', started_at: new Date().toISOString(), period,
    provider: PROVIDER.id, model: MODEL, ...runIdentity() };
}

// 429 가 왜 났는지는 본문보다 헤더에 있을 때가 많다. 한도·잔량·리셋 시각을 보내주는
// 게이트웨이라면 여기 있고, 아무것도 안 보낸다면 빈 객체가 그 사실 자체를 기록한다.
// 본문이 아니라 이 메타데이터만 남긴다. date 는 리셋 시각을 서버 시간 기준으로 읽으려고 함께 받는다.
const RATE_LIMIT_HEADER = /^(retry-after|date|x-request-id|x-requestid|(x-)?rate-?limit-)/i;
export function rateLimitHeaders(headers, apiKey) {
  const found = {};
  for (const [name, value] of headers) if (RATE_LIMIT_HEADER.test(name)) found[name] = providerMessage(value, apiKey);
  return found;
}

// 모델에 보내는 판정 계약 구간. 로컬 CLI 작업 지침은 제외한다.
export function policySection(doc) {
  return doc.split('## 판정 기준')[1].split('## 기사별 응답 형식')[0];
}

// 판정 캐시 식별자. 여기 들어가는 값이 하나라도 바뀌면 기사 id 가 바뀌고 앞선 판정은 재사용되지
// 않는다. 판정 기준을 고치면 옛 판정이 새 기준의 결과로 읽히지 않는다는 뜻이고, 그것이 의도다.
// golden 평가도 같은 식을 써야 운영과 같은 기사 id 를 얻는다.
export function reviewPolicy({ policyText, technology, indicators, provider = PROVIDER, promptDigest = reviewPromptDigest(policyText) }) {
  // 줄바꿈은 정규화하고 해시한다. Windows 작업트리는 CRLF, 리눅스 러너는 LF 로 같은 문서를 받으므로,
  // 정규화하지 않으면 같은 커밋이 플랫폼마다 다른 기사 id 를 만든다. 그러면 로컬에서 돌린 golden
  // 평가가 운영과 다른 정책을 재고, 체크아웃 설정이 다른 사람이 캐시를 통째로 무효화한다.
  const normalized = String(policyText).split('\r\n').join('\n');
  // 추론 단계와 실제 프롬프트(재시도·2차 검증 포함)도 판정 결과를 바꾸므로 식별자에 넣는다.
  // 프롬프트 버전 수동 갱신을 잊어도 내용 digest가 달라져 이전 review 파일을 재사용하지 않는다.
  return `${VERSION}:${digest([provider.id, provider.model, provider.thinkingLevel || '', promptDigest, normalized, technology, indicators])}`;
}

function invalidResponse(code, label = PROVIDER.label) {
  return Object.assign(new Error(`${label} invalid response: ${code}`), { response_code: code });
}

// 실패 응답에서 프로바이더가 한 말만 남긴다. 키는 지우고 길이는 자른다.
// 성공 응답 본문은 기사 본문이 섞여 있으므로 여기서도 다루지 않는다.
const PROVIDER_MESSAGE_LIMIT = 300;
export function providerMessage(text, apiKey) {
  const collapsed = String(text || '').replace(/\s+/g, ' ').trim();
  const safe = apiKey ? collapsed.split(apiKey).join('[REDACTED]') : collapsed;
  return safe.length > PROVIDER_MESSAGE_LIMIT ? `${safe.slice(0, PROVIDER_MESSAGE_LIMIT)}…` : safe;
}

// A quote array can contain separate passages. Split joined sentences only
// when EVERY sentence independently matches the SAME source block in order.
// Never fill omitted text, remove ellipses, or use fuzzy/semantic matching.
export function separateVerifiedQuotes(article, decisions) {
  const evidence = article.evidence.map(normalizeQuote);
  const repairs = [];
  return {
    decisions: decisions.map(decision => {
      if (!Array.isArray(decision.evidence_quotes)) return decision;
      const quotes = decision.evidence_quotes.flatMap((quote, quote_index) => {
        if (typeof quote !== 'string' || evidence.some(block => block.includes(normalizeQuote(quote)))) return [quote];
        if (/\.{3}|…/.test(quote)) return [quote];
        const sentences = quote.trim().split(/(?<=[.!?])\s+/);
        if (sentences.length < 2 || sentences.some(s => s.length < 30 || !/[.!?]$/.test(s))) return [quote];
        const normalized = sentences.map(normalizeQuote);
        const blockIndex = evidence.findIndex(block => {
          let offset = 0;
          for (const sentence of normalized) {
            const index = block.indexOf(sentence, offset);
            if (index < 0) return false;
            offset = index + sentence.length;
          }
          return true;
        });
        if (blockIndex < 0) return [quote];
        repairs.push({ candidate_id: decision.candidate_id, quote_index, original_quote: quote,
          separated_quotes: sentences, evidence_block_index: blockIndex });
        return sentences;
      });
      return { ...decision, evidence_quotes: quotes };
    }),
    repairs,
  };
}

// Diagnostic data is never imported as a review. Keep only evidence-related
// fields, not provider bodies, thoughts, summaries, headers or error messages.
const textLength = value => (typeof value === 'string' ? value.trim().length : null);

// 원문과 맞지 않는 인용이 원문 어디에서 갈라졌는지. 인용 앞부분과 가장 길게 일치하는 원문 위치부터 인용 길이만큼
// 잘라 보여 준다. 재시도에 이 구간을 넘겨야 모델이 어느 인용을 어떻게 고칠지 안다. 예전 재시도는 "후보 X 인용이
// 틀렸다"만 알려 줘, Vestas 표 인용처럼 중간을 건너뛴 인용이 두 번째에도 그대로 틀렸다.
export function nearestEvidence(blocks, quote) {
  const words = String(quote || '').split(' ').filter(Boolean);
  if (!words.length) return '';
  let best = { length: 0, block: -1, index: -1 };
  for (let count = Math.min(words.length, 60); count >= 3; count--) {
    const prefix = words.slice(0, count).join(' ');
    const block = blocks.findIndex(text => text.includes(prefix));
    if (block >= 0) { best = { length: count, block, index: blocks[block].indexOf(prefix) }; break; }
  }
  if (best.block < 0) return '';
  return blocks[best.block].slice(best.index, best.index + Math.min(900, String(quote).length + 200));
}

function quoteDiagnostics(article, decisions, apiKey, validationMessage = null) {
  const evidence = article.evidence.map((text, index) => ({ index, text, normalized: normalizeQuote(text) }));
  const detail = {
    company: article.company, url: article.url, title: article.title,
    ...(validationMessage ? { validation_message: validationMessage } : {}),
    expected_candidate_ids: article.candidates.map(c => c.id),
    expected_kinds: Object.fromEntries(article.candidates.map(c => [c.id, c.kind])),
    evidence_blocks: evidence,
    decisions: decisions.map((d, decision_index) => ({
      decision_index,
      candidate_id: typeof d.candidate_id === 'string' ? d.candidate_id : null,
      // enum·불리언은 그대로, 자유 텍스트는 길이만. 어느 검증이 깨졌는지 이걸로 좁힌다.
      event_stage: typeof d.event_stage === 'string' ? d.event_stage : null,
      quality: typeof d.quality === 'string' ? d.quality : null,
      booleans: Object.fromEntries(['entity_supported', 'target_technology_supported', 'indicator_supported', 'leading_indicator_supported']
        .map(k => [k, typeof d[k] === 'boolean' ? d[k] : `(${typeof d[k]})`])),
      reason_ko_length: textLength(d.reason_ko),
      summary_ko_length: textLength(d.summary_ko),
      summary_en_length: textLength(d.summary_en),
      quotes_is_array: Array.isArray(d.evidence_quotes),
      quotes: Array.isArray(d.evidence_quotes) ? d.evidence_quotes.map((quote, quote_index) => {
        if (typeof quote !== 'string') return { quote_index, invalid_type: quote === null ? 'null' : typeof quote };
        const normalized = normalizeQuote(quote);
        return { quote_index, quote, normalized,
          matching_block_indices: normalized ? evidence.filter(block => block.normalized.includes(normalized)).map(block => block.index) : [],
          nearest_evidence: nearestEvidence(evidence.map(block => block.normalized), normalized) };
      }) : [],
    })),
  };
  // Redact the configured key even if it unexpectedly appears in supplied text.
  return JSON.parse(JSON.stringify(detail, (_, value) => typeof value === 'string' && apiKey
    ? value.split(apiKey).join('[REDACTED]') : value));
}

// 판정 요청 하나를 기다리는 시간. 추론 단계를 high 로 올리면 긴 기사(입력 4만 토큰대)는 답이 늦다.
// 120초로는 느린 한 건이 transport 오류로 실행을 멈출 수 있어 넉넉히 둔다.
const REVIEW_REQUEST_TIMEOUT_MS = 300000;

export async function requestReview(article, policy, apiKey, fetchImpl = fetch, retry = false, provider = PROVIDER) {
  const invalid = code => invalidResponse(code, provider.label);
  let response;
  try {
    response = await fetchImpl(provider.url(provider.model), {
      method: 'POST', headers: provider.headers(apiKey),
      signal: AbortSignal.timeout(REVIEW_REQUEST_TIMEOUT_MS),
      body: JSON.stringify(provider.body({ article, policy, retry, model: provider.model })),
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError' || error instanceof TypeError) {
      // 이름과 사유를 함께 남긴다. TimeoutError(프로바이더가 제한시간 안에 답하지 않음)와
      // TypeError(DNS·TLS·연결 실패, 또는 fetch 호출 안에서 난 우리 코드의 결함)는 서로 다른
      // 문제인데 예전에는 둘 다 이름 없는 "transport error" 하나로 뭉뚱그려졌다.
      throw Object.assign(new Error(`${provider.label} transport error`), { transport_error: true,
        transport_reason: error.name || 'Error',
        transport_message: providerMessage(error.cause?.message || error.message, apiKey) });
    }
    throw error;
  }
  // Do not log provider response bodies: they may contain supplied text or credentials.
  if (!response.ok) {
    const error = new Error(`${provider.label} HTTP ${response.status}`);
    error.status = response.status;
    // 본문은 한 번만 읽을 수 있다. 텍스트로 받아 두고 JSON 이면 거기서 메시지를 꺼낸다.
    // 게이트웨이가 JSON 이 아닌 본문이나 다른 필드명을 쓰면 예전 코드는 빈 문자열만 봤고,
    // 그래서 모든 분류가 unspecified 로 떨어졌다.
    const body = await response.text().catch(() => '');
    let detail = null;
    try { detail = JSON.parse(body); } catch { /* JSON 이 아니면 본문 그대로 본다 */ }
    const stated = String(detail?.error?.message || detail?.detail || detail?.message || body || '');
    const message = stated.toLowerCase();
    error.provider_reason = /overload|high demand|capacity/.test(message) ? 'capacity'
      : /model.*not found|model.*not supported/.test(message) ? 'model_unavailable'
      : /api key/.test(message) ? 'api_key'
      // A 429 is either a burst this run can wait out or an exhausted account.
      // One costs a minute and the other costs a day, so name which it was.
      : /credit|quota|balance|exceeded your current/.test(message) ? 'credits_exhausted'
      : /per (minute|second)|rate limit|too many requests/.test(message) ? 'rate_limit'
      : 'unspecified';
    // 분류에 성공하면 프로바이더 본문은 남기지 않는다. 분류가 실패했을 때만, 무엇을 받았길래
    // 알아보지 못했는지 남긴다. 그게 없으면 1분 기다릴 일인지 계정이 빈 것인지 알아낼 방법이 없다.
    if (error.provider_reason === 'unspecified') error.provider_message = providerMessage(stated, apiKey) || '(빈 응답 본문)';
    error.rate_limit = rateLimitHeaders(response.headers, apiKey);
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) error.retry_after = retryAfter;
    throw error;
  }
  const payload = await response.json().catch(() => { throw invalid('invalid_json'); });
  const { text, usage } = provider.parse(payload, invalid);
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw invalid('invalid_json'); }
  if (!parsed || !Array.isArray(parsed.decisions) || parsed.decisions.some(d => !d || typeof d !== 'object')) throw invalid('invalid_decisions');
  // Business activity has no investment-stage test. These are contract constants,
  // not model judgements; entity, technology, concrete activity and quotes still gate approval.
  if (Array.isArray(parsed.decisions)) parsed.decisions = parsed.decisions.map(decision =>
    article.candidates.some(c => c.id === decision.candidate_id && c.kind === 'relevant')
      ? { ...decision, leading_indicator_supported: true, event_stage: 'not_applicable' } : decision);
  const separated = separateVerifiedQuotes(article, parsed.decisions);
  // 게시일 제안은 기사 단위 필드다. 여기서 review 로 옮기지 않으면 스키마를 고쳐도 dateHints 는
  // 계속 비어 있다. 스키마상 항상 문자열이지만, 빠졌거나 문자열이 아니면 제안 없음으로 읽는다.
  const suggested = value => (typeof value === 'string' ? value : '');
  const review = { article_id: article.id, reviewer: `${provider.model}/${VERSION}`, provider: provider.id, decisions: separated.decisions,
    prompt_version: PROMPT_VERSION, prompt_digest: reviewPromptDigest(policy),
    date_hint_version: DATE_HINT_VERSION, stage_review_version: STAGE_REVIEW_VERSION,
    form3_review_version: FORM3_REVIEW_VERSION, funding_review_version: FUNDING_REVIEW_VERSION,
    facility_stage_review_version: FACILITY_STAGE_REVIEW_VERSION, technology_review_version: TECHNOLOGY_REVIEW_VERSION,
    acquisition_review_version: ACQUISITION_REVIEW_VERSION,
    summary_accuracy_version: SUMMARY_ACCURACY_VERSION, summary_numbers_version: SUMMARY_NUMBERS_VERSION,
    published_date: suggested(parsed.published_date), published_date_quote: suggested(parsed.published_date_quote),
    ...(separated.repairs.length ? { quote_repairs: separated.repairs } : {}), usage };
  let problem = null;
  try { importReview(article, review, { strictNumbers: true }); } catch (error) { problem = error; }
  // 날짜 힌트는 보조 정보이고 언제나 추정으로만 쓰인다. 첫 실패는 기존 재시도에 맡기되, 재시도에서도
  // 인용이 그 날짜를 말하지 못하면 힌트만 버리고 판정은 살린다. 근거 있는 판정 전체를 근거 없는
  // 날짜 하나 때문에 잃으면 그 기사는 보고서에서 조용히 사라지고 build 까지 막힌다.
  // 힌트를 지운 뒤 판정을 다시 검증하므로, 판정 자체의 결함은 여기서 가려지지 않는다.
  if (problem && retry && /published_date/.test(problem.message)) {
    const withoutHint = { ...review, published_date: '', published_date_quote: '' };
    try {
      importReview(article, withoutHint);
      console.log(`Article ${article.id}: unusable publication date discarded, content review kept`);
      return withoutHint;
    } catch (error) { problem = error; }
  }
  // 숫자 검증은 틀린 숫자를 알려 한 번 되묻는다. 재시도에서도 숫자만 걸리면 판정은 받고 경고를 남긴다.
  // 표기 차이로 생긴 오탐 하나로 근거 있는 판정 전체를 잃으면 그 기사는 보고서에서 빠지고 생성까지 막힌다.
  if (problem && retry && /summary numbers/.test(problem.message)) {
    try {
      importReview(article, review);
      console.log(`Article ${article.id}: summary numbers still unconfirmed after retry; kept with a warning`);
      return { ...review, summary_number_warning: problem.message };
    } catch (error) { problem = error; }
  }
  // 후보 하나의 인용·문안 근거 결함으로 기사 전체를 잃지 않게 한다. 실행 35167466191·35175067142 의 Nexeon 은
  // 두 번 모두 한 후보(S5 인용, S3 문안)가 검증에 걸려 1억 파운드 조달 기사 전체가 보고서에서 빠졌다.
  // 재시도에서도 걸리면 맞지 않는 인용을 빼고, 그 후보가 발행될 판정이었다면 문안을 비우고 재검토 미완료로 남긴다.
  // 미완료 후보는 AI 승인으로 싣지 않으며(투자 후보는 사람 검토, 사업동향은 제외) 다음 실행이 다시 판정한다.
  // 없는 인용을 통과시키지 않고, 나머지 후보는 모든 검증을 그대로 거친다.
  if (problem && retry && CANDIDATE_EVIDENCE_PROBLEM.test(problem.message)) {
    const salvaged = salvageCandidateEvidence(article, review);
    if (salvaged) {
      console.log(`Article ${article.id}: candidate evidence salvaged` +
        `${salvaged.semantic_recheck_pending ? `; pending ${salvaged.semantic_recheck_pending.candidate_ids.join(', ')}` : ''}`);
      return salvaged;
    }
  }
  if (problem) {
    const failure = invalid(/published_date/.test(problem.message) ? 'date_evidence_mismatch'
      : /evidence_quotes/.test(problem.message) ? 'evidence_mismatch'
      : /summary names/.test(problem.message) ? 'summary_ungrounded'
      : /summary numbers/.test(problem.message) ? 'summary_number_ungrounded'
      : /needs an evidence quote/.test(problem.message) ? 'missing_evidence' : 'review_validation');
    // importReview 의 메시지는 우리가 만든 문구다. 회사명과 후보 id 만 담고 모델 출력은 담지 않는다.
    failure.diagnostic = quoteDiagnostics(article, parsed.decisions, apiKey, problem.message);
    throw failure;
  }
  return review;
}

const CANDIDATE_EVIDENCE_PROBLEM = /(?:evidence_quotes must be exact|needs an evidence quote|summary names)/;
export function salvageCandidateEvidence(article, review) {
  const evidence = article.evidence.map(normalizeQuote);
  const verified = quote => typeof quote === 'string' && Boolean(normalizeQuote(quote)) &&
    evidence.some(text => text.includes(normalizeQuote(quote)));
  const removed = [];
  const pending = new Set(review.semantic_recheck_pending?.candidate_ids || []);
  const publishable = decision => {
    const { supported, gaps } = decisionOutcome(article, review.decisions, decision);
    return supported || gaps?.length > 0;
  };
  let decisions = review.decisions.map(decision => {
    if (!Array.isArray(decision.evidence_quotes)) return decision;
    const unverified = decision.evidence_quotes.filter(quote => !verified(quote));
    if (!unverified.length) return decision;
    removed.push({ candidate_id: decision.candidate_id, removed_quotes: unverified });
    if (publishable(decision)) pending.add(decision.candidate_id);
    return { ...decision, evidence_quotes: decision.evidence_quotes.filter(verified),
      ...(publishable(decision) ? { summary_ko: '', summary_en: '' } : {}) };
  });
  // 인용을 고친 뒤에도 남는 후보별 결함(인용 없는 승인, 인용 밖 고유명사)은 그 후보만 미완료로 돌린다.
  for (let round = 0; round <= decisions.length; round++) {
    const current = { ...review, decisions, ...(removed.length ? { unverified_quotes_removed: removed } : {}),
      ...(pending.size ? { semantic_recheck_pending: { reason: 'candidate_evidence_unverified', candidate_ids: [...pending] } } : {}) };
    try {
      const results = importReview(article, current, { strictNumbers: true });
      if (!removed.length && pending.size <= (review.semantic_recheck_pending?.candidate_ids?.length || 0)) return null;
      // 발행될 후보가 모두 미완료로 돌아가면 살릴 판정이 없다. 그 기사는 지금처럼 판정 실패로 둔다.
      if (pending.size && !results.some(r => !pending.has(r.candidate_id) && (r.supported || r.human_review))) return null;
      return current;
    } catch (error) {
      const failed = /(investment:\d+|relevant): (?:evidence_quotes must be exact|approved candidate needs an evidence quote|summary names)/.exec(error.message);
      if (!failed || pending.has(failed[1])) return null;
      pending.add(failed[1]);
      decisions = decisions.map(d => (d.candidate_id === failed[1] ? { ...d, summary_ko: '', summary_en: '' } : d));
    }
  }
  return null;
}

export async function reviewArticles(options) {
  const { articles, config, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)) } = options;
  const concurrency = config.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 12) throw new Error('REPORT_CONCURRENCY must be 1..12');
  if (concurrency === 1) return reviewArticlesSerial(options);
  // One start-time gate for all workers AND retries. Waiting for a response
  // does not hold this gate. The existing per-article validator/cache is reused.
  let queue = Promise.resolve(), nextStart = 0, requests = 0, index = 0;
  let stopped = null, fatal = null, progressCompleted = 0;
  // 보강 중단은 실행 전체가 공유한다. 기사마다 따로 판단하면 할당량이 끝난 뒤에도 남은 미상 기사
  // 수만큼 계속 두드린다. 판정 중단(stopped)과는 별개다: 보강이 멈춰도 판정은 계속 나간다.
  const supplementStop = { stopped: false }, verifierStop = { stopped: null };
  const results = [];
  // 보조 요청인지는 어느 게이트를 통해 왔는지로 정한다. 이 구분은 게이트 안에만 있고
  // RequestInit 으로 새어나가지 않는다.
  // kind: 'judgement'(1차 판정), 'supplement'(날짜·문안 보강), 'verifier'(2차 검증). 검증 요청의 실패는 판정을 멈추지 않고,
  // 보강이 멈춰도 검증은 막히지 않는다. 검증을 멈출지는 reviewArticlesSerial 의 verify 가 정한다.
  const gate = kind => async (url, init) => {
    const supplement = kind !== 'judgement';
    const blocked = () => stopped || fatal || (kind === 'supplement' && supplementStop.stopped) || (kind === 'verifier' && verifierStop.stopped);
    const slot = queue.then(async () => {
      if (blocked()) return false;
      if (requests >= config.maxRequests) {
        // 날짜 보강은 보조 작업이다. 예산이 바닥나면 실행을 멈추지 않고 스스로 물러난다.
        if (!supplement) stopped = { status: 'paused', reason: 'request_budget' };
        return false;
      }
      while (nextStart > performance.now()) await sleep(nextStart - performance.now());
      if (blocked()) return false;
      requests++;
      nextStart = performance.now() + config.delayMs;
      return true;
    });
    queue = slot.then(() => {}, () => {});
    if (!await slot) throw Object.assign(new Error('Request scheduling stopped'), { scheduling_stopped: true });
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REVIEW_REQUEST_TIMEOUT_MS) });
    // Stop queued requests promptly on quota/auth errors, but let in-flight
    // successful responses finish validation and durable cache writes.
    // 보강의 실패로는 판정 요청을 멈추지 않는다. 할당량이 정말 끝났다면 다음 판정 요청이 같은 응답으로 알아낸다.
    if (!supplement) {
      if (response.status === 429) stopped = { status: 'paused', reason: 'quota', http_status: 429 };
      else if (!response.ok && response.status < 500) stopped = { status: 'paused', reason: 'provider_error', http_status: response.status };
    }
    return response;
  };
  const gatedFetch = gate('judgement'), supplementFetch = gate('supplement'), verifierFetch = gate('verifier');
  await Promise.all(Array.from({ length: Math.min(concurrency, articles.length) }, async () => {
    while (index < articles.length && !fatal) {
      const article = articles[index++];
      try {
        const result = await reviewArticlesSerial({ ...options, articles: [article], fetchImpl: gatedFetch,
          supplementFetchImpl: supplementFetch, supplementStop, verifierFetchImpl: verifierFetch, verifierStop, logReviewed: false });
        results.push(result);
        progressCompleted += result.completed;
        if (result.completed > result.cached) console.log(`Reviewed ${progressCompleted}/${articles.length}: ${article.company}`);
        // 검증기 중단은 판정을 멈추지 않는다. 남은 기사의 1차 판정은 계속 받고, 실행 상태는 끝에서 verifierStop 으로 정한다.
        if (result.status === 'paused' && !['invalid_responses', 'scheduling_stopped', 'verifier_unavailable'].includes(result.reason)) {
          // The gate stops queued work knowing only the status code; the worker
          // also read the provider's own explanation. Preferring the gate's
          // report discarded provider_reason on every 429, which is exactly
          // what separates "retry in a minute" from "the account is out".
          const lessInformative = !stopped || stopped.reason === 'request_budget' ||
            (stopped.http_status === result.http_status && !stopped.provider_reason && result.provider_reason);
          if (lessInformative) stopped = result;
        }
      } catch (error) { fatal ??= error; }
    }
  }));
  if (fatal) throw fatal;
  const failed_articles = results.flatMap(r => r.failed_articles);
  const completed = results.reduce((n, r) => n + r.completed, 0);
  return {
    ...(stopped && completed < articles.length ? stopped
      : verifierStop.stopped ? { status: 'paused', ...verifierStop.stopped, reason: verifierStop.stopped.reason === 'request_budget' ? 'request_budget' : 'verifier_unavailable' }
      : completed === articles.length ? { status: 'completed' } : stopped || { status: 'paused', reason: 'invalid_responses' }),
    requests, cached: results.reduce((n, r) => n + r.cached, 0), completed, total: articles.length,
    date_hints: results.reduce((n, r) => n + (r.date_hints || 0), 0),
    failed_articles, diagnostics: results.flatMap(r => r.diagnostics), concurrency,
    quote_removals: results.flatMap(r => r.quote_removals || []),
    recheck_pending: results.flatMap(r => r.recheck_pending || []),
    verification: results.reduce((total, r) => ({ model: total.model || r.verification?.model || null,
      requested: total.requested + (r.verification?.requested || 0), changed: total.changed + (r.verification?.changed || 0),
      failed: total.failed + (r.verification?.failed || 0),
      errors: Object.entries(r.verification?.errors || {}).reduce((errors, [key, n]) => ({ ...errors, [key]: (errors[key] || 0) + n }), total.errors) }),
      { model: null, requested: 0, changed: 0, failed: 0, errors: {} }),
    // 1차 판정이 먼저 멈춰 실행 상태가 그쪽 사유를 보여 줘도, 검증이 왜 멈췄는지 따로 남긴다.
    ...(verifierStop.stopped ? { verifier_stop: verifierStop.stopped } : {}),
  };
}

// 같은 날짜 규칙으로 이미 물어본 판정은 다시 묻지 않는다. 빈 문자열도 물어본 것이다.
// 프롬프트가 같고 날짜 파서만 바뀌어 DATE_HINT_VERSION 을 올리면 내용 판정을 유지하며 날짜만 묻는다.
// 날짜 프롬프트 자체가 바뀌면 이제 prompt digest가 달라져 전체 판정 캐시 키도 바뀐다.
function needsDateHint(article, review) {
  return article.date_placement === 'date_pending' && review.date_hint_version !== DATE_HINT_VERSION;
}

// 저장된 판정은 그대로 두고, 문안이 빈 사람 검토 후보에만 새 응답의 문안을 옮긴다. 날짜 힌트와 같은
// 이유로 판정 자체는 재현성 없는 재판정으로 덮지 않는다. 옮긴 문안도 가져오기 단계에서 근거 없는
// 고유명사 검사를 받는다. 새 응답에 문안이 없어도 버전을 찍어 같은 기사를 반복해서 묻지 않는다.
export function mergeReviewSummaries(article, review, fresh) {
  const freshById = new Map((fresh?.decisions || []).map(decision => [decision.candidate_id, decision]));
  const decisions = review.decisions.map(decision => {
    const candidate = article.candidates.find(item => item.id === decision.candidate_id);
    const gated = candidate ? decisionForApproval(article, review.decisions, decision) : null;
    const gaps = gated ? humanReviewGaps(candidate, gated) : null;
    const next = freshById.get(decision.candidate_id);
    const hasProse = String(decision.summary_ko || '').trim() && String(decision.summary_en || '').trim();
    if (!gaps?.length || hasProse || !next) return decision;
    return { ...decision, summary_ko: next.summary_ko || '', summary_en: next.summary_en || '' };
  });
  return { ...review, decisions, summary_review_version: SUMMARY_REVIEW_VERSION };
}

async function reviewArticlesSerial({ articles, reviewDir, policy, config, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), random = Math.random, logReviewed = true,
  supplementFetchImpl = fetchImpl, supplementStop = { stopped: false }, verifierFetchImpl = fetchImpl, verifierStop = { stopped: null } }) {
  let requests = 0, cached = 0, completed = 0, dateHints = 0;
  const failed = [];
  const diagnostics = [];
  const quoteRemovals = [], recheckPending = [];
  // errors 는 실패한 검증 요청의 HTTP 상태·분류별 횟수다. 실행 35182571472 는 검증 12회가 모두 실패했는데 무엇으로 실패했는지
  // 남지 않아, 할당량인지 과부하인지 아티팩트만으로 가릴 수 없었다.
  const verifications = { model: config.verifierApiKey ? VERIFIER?.model : null, requested: 0, changed: 0, failed: 0, errors: {} };
  const state = extra => ({ requests, cached, completed, date_hints: dateHints, total: articles.length, failed_articles: failed, diagnostics,
    quote_removals: quoteRemovals, recheck_pending: recheckPending, verification: verifications, ...extra });
  // 의심 후보를 2차 검증 모델에 보낸다. 실패·한도·할당량이면 그 후보를 재검토 미완료로 둔 1차 판정을 돌려준다.
  // 실행 35181768089: 검증 첫 요청이 503 한 번을 받자 보조 요청 전체가 멈춰, 검증 2건만 시도되고 34개 기사의 의심 후보가
  // 미완료로 빠진 보고서가 발행됐다(AI 확인 1개사). 검증은 1차 판정처럼 일시 오류를 재시도하고, 그래도 쓸 수 없으면
  // 실행을 일시정지해 보고서를 새로 만들지 않는다. 날짜·문안 보강의 중단과도 분리한다.
  const verify = async (article, primary, suspects) => {
    const unverified = reason => ({ ...primary, semantic_recheck_pending: { reason,
      candidate_ids: [...new Set([...(primary.semantic_recheck_pending?.candidate_ids || []), ...suspects.candidate_ids])] } });
    if (verifierStop.stopped) return unverified('verifier_unavailable');
    let retries = 0, waitMs = config.delayMs;
    for (;;) {
      if (requests >= config.maxRequests) {
        verifierStop.stopped ??= { reason: 'request_budget' };
        return unverified('request_budget');
      }
      if (requests) await sleep(waitMs);
      waitMs = config.delayMs;
      requests++;
      verifications.requested++;
      try {
        const checked = await requestReview(article, policy, config.verifierApiKey, verifierFetchImpl,
          // 1차 답(primary_decisions)은 보내지 않는다. 같은 모델이 자기 답을 보면 그대로 따라간다.
          { mode: 'verify', verify_candidate_ids: suspects.candidate_ids, checks: suspects.flagged_because }, VERIFIER);
        const merged = mergeVerification(article, primary, checked, suspects);
        importReview(article, merged);
        if (merged.verification.changed.length) verifications.changed++;
        console.log(`Article ${article.id}: verified ${suspects.candidate_ids.join(', ')}${merged.verification.changed.length ? `; changed ${merged.verification.changed.join(', ')}` : ''}`);
        return merged;
      } catch (error) {
        // 모델 이름·키·요청 형식 오류는 기사마다 반복될 설정 문제다. 모든 의심 후보를 조용히 미완료로 돌리지 않고 실행을 멈춘다.
        if ([400, 401, 403, 404].includes(error.status)) {
          throw Object.assign(new Error(`Verifier ${VERIFIER.model} rejected the request (HTTP ${error.status}). ` +
            'Check GEMINI_VERIFIER_MODEL and the Gemini key, or set REVIEW_VERIFIER=off.'), { status: error.status, verifier_config: true });
        }
        if (error.scheduling_stopped) {
          verifierStop.stopped ??= { reason: 'scheduling_stopped' };
          return unverified('verifier_unavailable');
        }
        const errorKey = [error.status || error.transport_reason || error.response_code || 'error', error.provider_reason].filter(Boolean).join(':');
        verifications.errors[errorKey] = (verifications.errors[errorKey] || 0) + 1;
        const transient = error.status === 429 || error.status >= 500 || error.transport_error;
        // 할당량 소진은 몇십 초 기다려도 풀리지 않는다. 재시도로 요청만 쓰지 않고 바로 멈춘다.
        if (transient && retries < 2 && error.provider_reason !== 'credits_exhausted') {
          waitMs = Math.max(config.delayMs, 15000 * 2 ** retries + Math.floor(random() * 1000));
          retries++;
          console.log(`Article ${article.id}: verifier temporarily unavailable (${error.transport_reason || `HTTP ${error.status}`}); retry ${retries}/2 after ${waitMs}ms`);
          continue;
        }
        verifications.failed++;
        console.log(`Article ${article.id}: verification unavailable (${error.response_code || error.status || error.transport_reason || error.message})`);
        if (transient) {
          // 재시도 뒤에도 쓸 수 없다. 남은 기사에서도 같을 것이므로 검증을 멈추고 실행을 일시정지로 끝낸다.
          verifierStop.stopped ??= { reason: 'verifier_unavailable', http_status: error.status || null,
            ...(error.provider_reason ? { provider_reason: error.provider_reason } : {}),
            ...(error.provider_message ? { provider_message: error.provider_message } : {}),
            ...(error.transport_reason ? { transport_reason: error.transport_reason } : {}) };
          return unverified('verifier_unavailable');
        }
        // 검증 응답 자체가 검증을 통과하지 못한 경우(인용 불일치 등)는 이 기사만의 문제다. 이 후보만 미완료로 둔다.
        return unverified(`verifier:${error.response_code || 'error'}`);
      }
    }
  };
  // 문안만 다시 받는 보조 요청이 거절되면 모델이 무엇을 썼는지 남긴다. 2026-08 ASML 사업동향은 요약을 다시
  // 받았는데도 옛 문안이 남았고, 새 응답이 저장되지 않아 무엇이 틀렸는지 알 수 없었다.
  const recordSupplementDiagnostic = async (article, reason, detail) => {
    const diagnosticPath = `${path.basename(reviewDir)}/diagnostics/${article.id}/${crypto.randomUUID()}-${reason}.json`;
    await write(path.join(path.dirname(reviewDir), diagnosticPath), {
      schema_version: 1, article_id: article.id, model: MODEL, created_at: new Date().toISOString(), reason, ...detail });
    diagnostics.push({ article_id: article.id, attempt: 0, reason, file: diagnosticPath });
  };
  // 문안이 빈 사람 검토 후보를 짚어 한 번 더 묻는다. 판정은 옮기지 않고 문안만 옮긴다. 새로 판정한
  // 기사도 같은 실행 안에서 보강한다. 실패하거나 한도에 걸리면 다음 실행에서 다시 묻는다.
  const backfillSummaries = async (article, review, file) => {
    const missing = missingReviewSummaryIds(article, review);
    if (review.summary_review_version === SUMMARY_REVIEW_VERSION || !missing.length ||
        supplementStop.stopped || requests >= config.maxRequests) return review;
    if (requests) await sleep(config.delayMs);
    requests++;
    try {
      const fresh = await requestReview(article, policy, config.apiKey, supplementFetchImpl, {
        reason: 'human_review_summaries_missing',
        validation_message: `summary_ko and summary_en are empty for human-review candidates: ${missing.join(', ')}` });
      const merged = mergeReviewSummaries(article, review, fresh);
      importReview(article, merged);
      await write(file, merged);
      return merged;
    } catch (error) {
      // 문안 보강은 보조 작업이다. 할당량·전송 오류면 남은 기사에서도 같으므로 이번 실행에서는 멈춘다.
      if (error.status || error.transport_error || error.scheduling_stopped) supplementStop.stopped = true;
      console.log(`Article ${article.id}: human-review summary unavailable (${error.response_code || error.status || 'error'})`);
      return review;
    }
  };
  // 보고서에 실리는 판정의 문안을 새 정확성 지시로 한 번 다시 받는다. 새 문안이 인용 검증을 통과하지
  // 못하면 기존 문안을 두고 버전만 찍어 반복 요청을 막는다.
  const refreshSummaries = async (article, review, file) => {
    if (!needsSummaryRefresh(article, review) || supplementStop.stopped || requests >= config.maxRequests) return review;
    if (requests) await sleep(config.delayMs);
    requests++;
    let fresh;
    try {
      fresh = await requestReview(article, policy, config.apiKey, supplementFetchImpl);
    } catch (error) {
      if (error.status || error.transport_error || error.scheduling_stopped) supplementStop.stopped = true;
      console.log(`Article ${article.id}: summary refresh unavailable (${error.response_code || error.status || 'error'})`);
      // 응답이 검증을 통과하지 못했으면 다음 실행에서 다시 물어도 결과가 같기 쉽다. 버전을 찍어 매 실행
      // 같은 기사에 요청을 쓰지 않게 한다. 할당량·전송 오류는 찍지 않고 다음 실행에 맡긴다.
      if (!error.response_code) return review;
      await recordSupplementDiagnostic(article, `summary_refresh_${error.response_code}`, error.diagnostic || {});
      const stamped = { ...review, summary_accuracy_version: SUMMARY_ACCURACY_VERSION, summary_numbers_version: SUMMARY_NUMBERS_VERSION, summary_style_version: SUMMARY_STYLE_VERSION };
      await write(file, stamped);
      return stamped;
    }
    let merged = mergeRefreshedSummaries(article, review, fresh);
    try {
      importReview(article, merged, { strictNumbers: true });
    } catch (error) {
      await recordSupplementDiagnostic(article, 'summary_refresh_rejected', { validation_message: error.message,
        fresh_summaries: (fresh.decisions || []).filter(d => d.summary_ko || d.summary_en)
          .map(d => ({ candidate_id: d.candidate_id, summary_ko: d.summary_ko, summary_en: d.summary_en })) });
      merged = { ...review, summary_accuracy_version: SUMMARY_ACCURACY_VERSION, summary_numbers_version: SUMMARY_NUMBERS_VERSION, summary_style_version: SUMMARY_STYLE_VERSION };
    }
    await write(file, merged);
    return merged;
  };
  for (const article of articles) {
    const file = path.join(reviewDir, `${article.id}.json`);
    // 저장된 판정을 재검토하는 중이면 그 판정과 이유. 재판정이 끝내 실패하면 이 판정을 재검토 미완료로 남긴다.
    let stale = null;
    try {
      let review = await read(file);
      if (review.reviewer !== `${PROVIDER.model}/${VERSION}` || review.provider !== PROVIDER.id) throw new Error('cache provider mismatch');
      importReview(article, review);
      // 지난 실행에서 재검토를 끝내지 못한 판정과 새 재검토 규칙에 걸린 판정은 다시 판정한다.
      const recheck = cachedRecheck(article, review);
      if (recheck && config.verifierApiKey) {
        // 저장된 판정 전체를 다시 사지 않고, 걸린 후보만 2차 검증한다. 나머지 후보의 판정은 흔들지 않는다.
        const suspects = verificationSuspects(article, review) || { candidate_ids: [], flagged_because: {} };
        for (const id of recheck.candidate_ids) {
          if (!suspects.candidate_ids.includes(id)) suspects.candidate_ids.push(id);
          suspects.flagged_because[id] = [...new Set([...(suspects.flagged_because[id] || []), VERIFY_QUESTIONS[recheck.reason] || recheck.reason])];
        }
        const checked = await verify(article, review, suspects);
        await write(file, checked);
        if (checked.semantic_recheck_pending) recheckPending.push({ article_id: article.id,
          candidate_ids: checked.semantic_recheck_pending.candidate_ids, reason: checked.semantic_recheck_pending.reason });
        completed++;
        review = await backfillSummaries(article, checked, file);
        await refreshSummaries(article, review, file);
        continue;
      }
      if (recheck) {
        stale = { review, ...recheck };
        throw new Error(`saved review needs recheck: ${recheck.reason}`);
      }
      cached++; completed++;
      review = await backfillSummaries(article, review, file);
      review = await refreshSummaries(article, review, file);
      // 끝난 내용 판정은 그대로 두고 날짜만 보강한다. 스키마가 바뀌었다고 캐시 식별자를 올리면
      // 날짜와 무관한 기사까지 전부 다시 판정되고, 같은 기사에서 다른 승인이 나올 수 있다.
      // 날짜 상태와 내용 평가는 독립이므로 그 대가를 치를 이유가 없다.
      if (needsDateHint(article, review) && !supplementStop.stopped && requests < config.maxRequests) {
        if (requests) await sleep(config.delayMs);
        requests++;
        try {
          // 보강 전용 게이트로 보낸다. 이 실패가 공유 스케줄러를 멈추면 아직 판정받지 못한
          // 기사들이 날짜와 무관한 이유로 판정 없이 끝난다.
          const fresh = await requestReview(article, policy, config.apiKey, supplementFetchImpl);
          // 새 응답의 판정은 버리고 날짜만 옮긴다. 이미 검증된 판정을 재현성 없는 재판정으로 덮지 않는다.
          await write(file, { ...review, date_hint_version: DATE_HINT_VERSION,
            published_date: fresh.published_date, published_date_quote: fresh.published_date_quote });
          if (fresh.published_date) dateHints++;
        } catch (error) {
          // 힌트는 보조 정보다. 실패해도 캐시된 판정과 실행 상태는 건드리지 않는다. 다만 할당량·
          // 전송 오류라면 남은 기사에서 반복해도 결과가 같으므로 이번 실행에서는 보강을 멈춘다.
          if (error.status || error.transport_error || error.scheduling_stopped) supplementStop.stopped = true;
          console.log(`Article ${article.id}: date hint unavailable (${error.response_code || error.status || 'error'})`);
        }
      }
      continue;
    } catch (error) {
      if (error.verifier_config) throw error;
      if (error.code !== 'ENOENT') console.log(`Rechecking invalid cache: ${article.id}`);
    }
    let providerRetries = 0, waitMs = config.delayMs;
    let maxAttempts = 2, retryFeedback = false;
    // 되묻기 전의 유효한 응답과 되묻은 이유. 되묻기가 실패하거나 멈춰도 이 판정은 잃지 않되, 재검토가 끝난 것으로
    // 저장하지 않는다. 앞 응답에는 최신 재검토 버전이 이미 찍혀 있어, 그대로 저장하면 다음 실행이 다시 묻지 않고
    // 의심 판정을 승인으로 계속 발행한다(3M S3 재현). 미완료 기록을 남기고, 해당 후보는 importReview 가
    // 승인 대신 사람 검토로 내리며, 다음 실행은 이 기사를 다시 판정한다.
    let beforeRecheck = null, recheckFeedback = null;
    const keep = async kept => {
      await write(file, kept);
      if (kept.unverified_quotes_removed) quoteRemovals.push({ article_id: article.id,
        candidate_ids: kept.unverified_quotes_removed.map(item => item.candidate_id) });
      if (kept.semantic_recheck_pending) recheckPending.push({ article_id: article.id,
        candidate_ids: kept.semantic_recheck_pending.candidate_ids, reason: kept.semantic_recheck_pending.reason });
      const backfilled = await backfillSummaries(article, kept, file);
      // 새 판정의 문안도 같은 실행에서 문체·한영 사실 일치를 확인한다. 다음 실행까지 기다리면 이번 보고서에 그대로 실린다.
      await refreshSummaries(article, backfilled, file);
      completed++;
      if (logReviewed) console.log(`Reviewed ${completed}/${articles.length}: ${article.company}`);
    };
    const keepUnrechecked = reason => keep({ ...beforeRecheck, semantic_recheck_pending: {
      reason, candidate_ids: [...new Set([...(beforeRecheck.semantic_recheck_pending?.candidate_ids || []), ...recheckFeedback.candidate_ids])],
      validation_message: recheckFeedback.validation_message } });
    const pause = async extra => {
      if (beforeRecheck) await keepUnrechecked(extra.reason);
      return state(extra);
    };
    for (let attempt = 0; attempt < maxAttempts;) {
      if (requests >= config.maxRequests) {
        if (beforeRecheck) { await keepUnrechecked('request_budget'); break; }
        return state({ status: 'paused', reason: 'request_budget' });
      }
      if (requests) await sleep(waitMs);
      waitMs = config.delayMs;
      requests++;
      let review;
      try {
        review = await requestReview(article, policy, config.apiKey, fetchImpl, retryFeedback);
      } catch (error) {
        // Outage retries and invalid-output retries share the run request budget.
        if (error.scheduling_stopped) return pause({ status: 'paused', reason: 'scheduling_stopped' });
        if ((error.status >= 500 || error.transport_error) && providerRetries < 2) {
          waitMs = Math.max(config.delayMs, 15000 * 2 ** providerRetries + Math.floor(random() * 1000));
          providerRetries++;
          console.log(`Article ${article.id}: transient provider error (${error.transport_reason || `HTTP ${error.status}`}${error.transport_message ? `: ${error.transport_message}` : ''}); retry ${providerRetries}/2 after ${waitMs}ms`);
          continue;
        }
        if (error.status === 429 || error.status >= 500) return pause({ status: 'paused', reason: error.status === 429 ? 'quota' : 'provider_unavailable', http_status: error.status, provider_reason: error.provider_reason, ...(error.provider_message ? { provider_message: error.provider_message } : {}), ...(error.rate_limit ? { rate_limit: error.rate_limit } : {}), ...(error.retry_after ? { retry_after: error.retry_after } : {}) });
        if (error.transport_error) return pause({ status: 'paused', reason: 'transport_error',
          ...(error.transport_reason ? { transport_reason: error.transport_reason } : {}),
          ...(error.transport_message ? { transport_message: error.transport_message } : {}) });
        if (!error.response_code) throw error;
        const recheckFailed = Boolean(beforeRecheck);
        const unmatched = (error.diagnostic?.decisions || []).flatMap(d => (d.quotes || [])
          .filter(q => q.quote && !(q.matching_block_indices || []).length)
          .map(q => ({ candidate_id: d.candidate_id, quote: q.quote, source_text_from_same_start: q.nearest_evidence || '' }))).slice(0, 4);
        retryFeedback = { reason: error.response_code,
          ...(error.diagnostic?.validation_message ? { validation_message: error.diagnostic.validation_message } : {}),
          ...(unmatched.length ? { unmatched_quotes: unmatched, quote_instruction: 'Each unmatched quote must be replaced by one or ' +
            'more exact contiguous passages copied from the source text. Do not skip words inside a quote; split it instead.' } : {}) };
        // A quote repair can expose a separate missing-summary error. Allow one
        // targeted repair, still subject to the shared request budget and all
        // validation checks. Never manufacture text or downgrade the decision.
        if (attempt === 1 && /missing ai_summary_(ko|en)/.test(error.diagnostic?.validation_message || '')) maxAttempts = 3;
        const diagnosticPath = `${path.basename(reviewDir)}/diagnostics/${article.id}/${crypto.randomUUID()}-attempt-${attempt + 1}.json`;
        await write(path.join(path.dirname(reviewDir), diagnosticPath), {
          schema_version: 1, article_id: article.id, model: MODEL,
          created_at: new Date().toISOString(), attempt: attempt + 1,
          reason: error.response_code, ...(error.diagnostic || {}),
        });
        diagnostics.push({ article_id: article.id, attempt: attempt + 1, reason: error.response_code, file: diagnosticPath });
        const failure = { article_id: article.id, reason: error.response_code };
        console.log(`Article ${article.id}: ${error.response_code} (attempt ${attempt + 1}/${maxAttempts})`);
        // 되묻기 응답이 검증을 통과하지 못하면 앞선 판정을 재검토 미완료로 저장한다. 판정 실패 기사로는 세지 않는다.
        if (recheckFailed) { await keepUnrechecked(error.response_code); break; }
        if (attempt === maxAttempts - 1) {
          // 저장된 판정의 재검토가 끝내 실패했다. 옛 판정을 조용히 완료로 두지 않고 대상 후보를 미완료로 남긴다.
          if (stale) {
            await keep({ ...stale.review, semantic_recheck_pending: { reason: `${stale.reason}:${error.response_code}`,
              candidate_ids: stale.candidate_ids } });
            break;
          }
          failed.push(failure);
        }
        attempt++;
        continue;
      }
      if (config.verifierApiKey) {
        const suspects = verificationSuspects(article, review);
        await keep(suspects ? await verify(article, review, suspects) : review);
        break;
      }
      const feedback = beforeRecheck ? null : freshRecheckFeedback(article, review);
      if (feedback) {
        // 재검토 규칙에 걸린 판정은 같은 실행에서 한 번만 되묻는다. 새 응답의 결론을 그대로 받는다.
        beforeRecheck = review;
        recheckFeedback = feedback;
        retryFeedback = feedback;
        maxAttempts = Math.max(maxAttempts, attempt + 2);
        console.log(`Article ${article.id}: semantic recheck requested`);
        attempt++;
        continue;
      }
      if (beforeRecheck) review = { ...review, semantic_recheck: { validation_message: recheckFeedback.validation_message,
        previous: beforeRecheck.decisions.map(({ candidate_id, event_stage, indicator_supported, leading_indicator_supported }) =>
          ({ candidate_id, event_stage, indicator_supported, leading_indicator_supported })) } };
      await keep(review);
      break;
    }
  }
  // 검증기를 쓸 수 없어 멈췄으면 판정은 끝났어도 보고서를 새로 만들지 않는다. 받은 판정은 미완료로 저장돼 다음 실행이 검증한다.
  if (verifierStop.stopped) return state({ status: 'paused', ...verifierStop.stopped, reason: verifierStop.stopped.reason === 'request_budget' ? 'request_budget' : 'verifier_unavailable' });
  return state(failed.length ? { status: 'paused', reason: 'invalid_responses' } : { status: 'completed' });
}

// 요청 한도·할당량으로 멈춘 실행은 다음 실행이 이어 판정해야 하므로 보고서를 만들지 않는다. 모든 기사를
// 시도했고 남은 것이 재시도까지 인용 검증에 실패한 기사뿐일 때만, 그 기사를 판정 실패로 두고 보고서를 만든다.
// 실패한 기사는 저장되지 않아 매 실행 다시 시도되므로, 막아 두면 같은 기사 몇 건이 보고서를 영영 막는다.
export function publishableReviewFailures(state) {
  if (state.status !== 'paused' || state.reason !== 'invalid_responses') return [];
  const ids = [...new Set((state.failed_articles || []).map(item => item.article_id))];
  return ids.length && state.completed + ids.length === state.total ? ids : [];
}

async function main() {
  const period = resolveReportPeriod();
  const { from_date: from, to_date: to } = period;
  // Keep failure status and downstream tools tied to the resolved period too.
  process.env.REPORT_FROM_DATE = from;
  process.env.REPORT_TO_DATE = to;
  const config = configuration(); // fail before crawling or calling any model
  const root = path.resolve('outputs/review_work');
  // 수집·판정보다 먼저 쓴다. 여기서부터 죽더라도 아티팩트는 이번 실행을 말한다.
  await write(path.join(root, 'status.json'), startingStatus(period));
  const policyDoc = await fs.readFile('docs/local_report_review.md', 'utf8');
  // Share the reviewed judgement contract, excluding instructions for the local CLI workflow.
  const policyText = policySection(policyDoc);
  const [targets, technology, indicators] = await Promise.all([
    read('data/target_companies.json'), read('data/company_technology_map.json'), read('config/investment_signal_indicators.json'),
  ]);
  const policy = reviewPolicy({ policyText, technology, indicators });
  const inputDir = path.join(root, `${from}_${to}`);
  const sourceFile = path.join(inputDir, 'latest_company_signals.json');
  if (process.env.REPORT_REFRESH === 'true') await fs.rm(inputDir, { recursive: true, force: true });
  // 저장된 판정을 전부 버리고 모든 기사를 다시 판정한다. 판정·요약 지시가 여러 번 바뀌어 옛 판정과 새 판정이
  // 섞였을 때 쓴다. 요청 한도나 할당량에 걸려 멈추면 다음 실행은 이 옵션을 끄고 돌려야 이어서 판정한다.
  // 켜 둔 채 다시 돌리면 또 처음부터 시작한다.
  if (process.env.REPORT_REREVIEW === 'true') {
    await fs.rm(path.join(root, 'reviews'), { recursive: true, force: true });
    console.log('Discarded saved article reviews; every article will be reviewed again');
  }
  try {
    await fs.access(sourceFile);
    const previous = await read(path.join(inputDir, 'latest_collection_summary.json'));
    const sourceConfig = await read('config/company_sources.json');
    if (collectionNeedsRefresh(previous, { version: CONTENT_COLLECTION_VERSION,
      inputDigest: collectionInputDigest(targets, sourceConfig) })) throw new Error('Refresh stale or incomplete collection');
  }
  catch {
    // 응답 헤더가 Node 기본 한도(16KB)를 넘는 사이트가 있다. Cytiva 뉴스룸과 Yahoo Finance 는 이 한도에서
    // UND_ERR_HEADERS_OVERFLOW 로 실패한다.
    const result = spawnSync(process.execPath, ['--max-http-header-size=131072', 'scripts/collect_company_signals.mjs', '--companies', 'data/target_companies.json', '--source-config', 'config/company_sources.json', '--out-dir', inputDir,
      '--sources', 'official_feeds,official_pages,official_sitemaps,sec_filings,google_news', '--from-date', from, '--to-date', to,
      '--max-per-source', '6', '--max-per-company', '10', '--max-detail-per-company', '10', '--fallback-mode', 'missing', '--fallback-min-results', '1', '--rate-limit-seconds', '0.5', '--company-concurrency', '4'], { stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error('Collection failed');
  }
  const [signals, summary] = await Promise.all([read(sourceFile), read(path.join(inputDir, 'latest_collection_summary.json'))]);
  if (summary.from_date !== from || summary.to_date !== to) throw new Error('Cached collection period mismatch');
  const candidates = sourceCandidates(signals, technology, indicators, period);
  const articles = groupArticles(candidates.investment, candidates.relevant, period, policy);
  const snapshot = { policy, period, summary, signals, articles, targets, technology, indicators, date_deferred: candidates.deferred };
  const runDir = path.join(root, `${from.slice(0, 7)}-${digest(snapshot)}`);
  await write(path.join(runDir, 'snapshot.json'), snapshot);
  const state = await reviewArticles({ articles, reviewDir: path.join(root, 'reviews'), policy: policyText, config });
  await write(path.join(root, 'status.json'), { ...state, period, provider: PROVIDER.id, model: MODEL, ...runIdentity() });
  console.log(JSON.stringify(state));
  const reviewFailed = publishableReviewFailures(state);
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,
    `### ${PROVIDER.label} report\n${state.status}: ${state.completed}/${state.total} articles; ${state.requests} API requests; ${state.cached} cached` +
    `${state.date_hints ? `; ${state.date_hints} date hints` : ''}.\n` +
    (reviewFailed.length ? `Building the report without ${reviewFailed.length} article(s) that failed evidence validation twice; ` +
      'their companies are marked as incomplete evidence.\n' : '') +
    (state.status === 'paused' && !reviewFailed.length ? `Reason: ${state.reason}${state.provider_reason ? ` (${state.provider_reason})` : ''}${state.retry_after ? `, retry-after ${state.retry_after}s` : ''}. ` +
      (state.provider_message ? `${PROVIDER.label} said: ${state.provider_message}
` : '') +
      (state.transport_reason ? `Transport: ${state.transport_reason}${state.transport_message ? ` - ${state.transport_message}` : ''}
` : '') +
      (state.rate_limit ? (Object.keys(state.rate_limit).length
        ? `Rate-limit headers: ${Object.entries(state.rate_limit).map(([k, v]) => `${k}=${v}`).join(', ')}
`
        : `${PROVIDER.label} sent no rate-limit headers with this ${state.http_status}.
`) : '') +
      'Saved progress; rerun the same dates with refresh=false. ' +
      // A burst limit clears in a minute; an exhausted account does not.
      (state.provider_reason === 'credits_exhausted' ? 'The account is out of credits, so an immediate rerun will only 429 again. ' : '') +
      (state.provider_reason === 'rate_limit' ? 'This was a burst limit, so a rerun shortly should continue. ' : '') +
      'Existing published PDFs are unchanged.\n' : '') +
    state.failed_articles.map(item => `- Article ${item.article_id}: ${item.reason}\n`).join('') +
    (state.quote_removals || []).map(item => `- Article ${item.article_id}: unverifiable quotes removed from rejected candidates ${item.candidate_ids.join(', ')}\n`).join('') +
    (state.verification?.requested ? `Second-stage verification (${state.verification.model}): ${state.verification.requested} requests, ` +
      `${state.verification.changed} articles changed, ${state.verification.failed} articles unavailable` +
      `${Object.keys(state.verification.errors || {}).length ? `; errors ${JSON.stringify(state.verification.errors)}` : ''}\n` : '') +
    (state.recheck_pending || []).map(item => `- Article ${item.article_id}: semantic recheck not completed (${item.reason}); ` +
      `${item.candidate_ids.join(', ')} published only as human review and asked again next run\n`).join('') +
    state.diagnostics.map(item => `- Diagnostic in progress artifact: ${item.file} (${item.reason})\n`).join(''));
  if (state.status !== 'completed' && !reviewFailed.length) { process.exitCode = 75; return; }
  const reportDir = await build({ runDir, issueNumber: process.env.REPORT_ISSUE_NUMBER || '2', reviewFailed });
  const finalState = reviewFailed.length ? { ...state, status: 'completed_with_review_failures' } : state;
  const investment = await read(path.join(reportDir, 'investment.json'));
  const relevant = await read(path.join(reportDir, 'relevant.json'));
  // The workflow commits these files together only after both PDFs have succeeded.
  for (const [source, target] of [['signals.json', 'latest_company_signals.json'], ['summary.json', 'latest_collection_summary.json'], ['investment.json', 'latest_investment_signals.json'], ['relevant.json', 'latest_relevant_signals.json']]) {
    await fs.copyFile(path.join(reportDir, source), path.join('outputs', target));
  }
  await write('outputs/latest_investment_signal_summary.json', { investment_signal_count: investment.length, companies_with_investment_signals: new Set(investment.map(r => r.company)).size, ...publishedSignalCounts(investment, period), provider: PROVIDER.id });
  await write('outputs/latest_relevance_summary.json', { relevant_signal_count: relevant.length, companies_with_relevant_signals: new Set(relevant.map(r => r.company)).size, ...publishedSignalCounts(relevant, period), provider: PROVIDER.id });
  await write('outputs/latest_ai_summary_summary.json', { ...finalState, period, provider: PROVIDER.id, model: MODEL });
  if (reviewFailed.length) await write(path.join(root, 'status.json'), { ...finalState, period, provider: PROVIDER.id, model: MODEL, ...runIdentity() });
  await fs.mkdir('public/reports', { recursive: true });
  await fs.copyFile(path.join(reportDir, 'report_ko.pdf'), 'public/reports/latest_report.pdf');
  await fs.copyFile(path.join(reportDir, 'report_en.pdf'), 'public/reports/latest_report_en.pdf');
  await fs.rm(reportDir, { recursive: true, force: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(async error => {
  console.error(error.message);
  await write(path.resolve('outputs/review_work/status.json'), {
    status: 'failed', reason: error.status ? 'provider_error' : 'validation_or_execution',
    http_status: error.status || null, provider: PROVIDER.id, model: MODEL, ...runIdentity(),
    ...(error.provider_message ? { provider_message: error.provider_message } : {}),
    ...(error.rate_limit ? { rate_limit: error.rate_limit } : {}),
    ...(error.transport_reason ? { transport_reason: error.transport_reason, transport_message: error.transport_message } : {}),
    period: { from_date: process.env.REPORT_FROM_DATE || null, to_date: process.env.REPORT_TO_DATE || null },
  }).catch(() => {});
  if (error.provider_message) console.error(`${PROVIDER.label} 응답: ${error.provider_message}`);
  if (error.status === 401 || error.status === 403) {
    const apiKey = PROVIDER.keyEnv.map(name => process.env[name]).find(Boolean);
    const shape = describeKeyShape(apiKey);
    console.error(`${PROVIDER.keyEnv[0]} 이 ${PROVIDER.label} 에서 거절됐다. 키는 찍지 않고 모양만 보고한다:`);
    console.error(`  길이 ${shape.length}, 접두사 ${shape.prefix} (${shape.issuer}), 앞뒤 공백 ${shape.had_surrounding_whitespace ? '있음' : '없음'}`);
    if (PROVIDER.expectedKeyPrefix && !String(apiKey).trim().startsWith(PROVIDER.expectedKeyPrefix)) {
      console.error(`  ${PROVIDER.label} 키는 보통 ${PROVIDER.expectedKeyPrefix} 로 시작한다. 이 시크릿에 다른 서비스 키가 들어 있는지 확인할 것.`);
    }
  }
  if (error.status === 404) {
    // Metadata-only request: report available model IDs, never select a paid fallback.
    try {
      const apiKey = PROVIDER.keyEnv.map(name => process.env[name]).find(Boolean);
      const models = await PROVIDER.listModels(apiKey);
      console.error(models.length ? `Available models: ${models.join(', ')}` : 'Model metadata unavailable');
    } catch { console.error('Model metadata unavailable'); }
  }
  process.exitCode = 1;
});
