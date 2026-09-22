import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { groupArticles } from '../scripts/local_report.mjs';
import { policySection, reviewPolicy } from '../scripts/review_report.mjs';

// 모델에게 실제로 전달되는 구간만 본다. 이 바깥의 문장은 프롬프트가 아니다.
const DOC = fs.readFileSync(path.resolve('docs/local_report_review.md'), 'utf8');
const CRITERIA = policySection(DOC);

test('the criteria sent to the model judge each field independently', () => {
  // 한 필드의 실패를 다른 필드로 옮기지 말라는 지시가 프롬프트에 있어야 한다.
  assert.match(CRITERIA, /Judge each field independently/);
  for (const field of ['entity_supported', 'target_technology_supported', 'indicator_supported',
    'leading_indicator_supported', 'quality']) {
    assert.match(CRITERIA, new RegExp(field), `${field} 가 독립 판단 대상으로 명시되어야 한다`);
  }
  assert.match(CRITERIA, /Do not transfer a false result from one field into the judgement of another/);
});

test('a technology exemption is not allowed to travel into indicator or quality', () => {
  const exemption = CRITERIA.split('\n').find(line => /relevance_exempt=true/.test(line));
  assert.ok(exemption, 'relevance_exempt 규칙이 판정 기준에 있어야 한다');
  // 면제 후보의 target_technology_supported=false 는 사실대로 기록하되 다른 필드로 번지지 않는다.
  assert.match(exemption, /record false as the evidence warrants/);
  assert.match(exemption, /`indicator_supported` or `quality`/);
  assert.match(exemption, /do not reuse it as a rejection reason/);
});

// 모델이 요약을 쓸지 말지는 이 문서의 승인 조건만 보고 정한다. 코드에서 S3·S5 의 품목 연결
// 요구를 빼고 문서를 그대로 두면, 모델은 그 후보를 탈락으로 보고 문안을 비운 채 돌려준다.
test('the criteria state which candidates are exempt from the target-technology condition', () => {
  const approval = CRITERIA.split('\n').find(line => /^Approval requires `entity_supported=true`/.test(line));
  assert.ok(approval, '승인 조건 문장이 판정 기준에 있어야 한다');
  assert.match(approval, /S3\/S5 candidates are exempt from the technology-link condition/);
  // 완화가 거기서 멈춘다는 것도 같은 문장이 말해야 한다.
  assert.match(approval, /S1\/S2\/S4 and business activity\) require `target_technology_supported=true`/);
  // 요약 대상도 같이 넓어져야 그 후보가 문안 없이 승인되지 않는다.
  assert.match(CRITERIA, /S3\/S5 candidates still require summaries with `target_technology_supported=false` when the other approval conditions are met/);
  // 필드 자체는 여전히 근거대로 판단한다. 조건에서 빼는 것이지 true 로 올리는 것이 아니다.
  assert.match(CRITERIA, /Judge this field from evidence even for `relevance_exempt=true`, `investment:3` and `investment:5`/);
});

test('event_stage is judged on the candidate event, not on how the sentence is worded', () => {
  assert.match(CRITERIA, /candidate event's stage relative to the final investment/);
  assert.match(CRITERIA, /not whether the sentence uses "signed" or "completed"/);
  // 지표별 전조 예시가 남아 있어야 한다.
  assert.match(CRITERIA, /funding \(S3\)/);
  assert.match(CRITERIA, /research collaboration \(S4\)/);
});

test('quality=pass states evidence sufficiency, never approval', () => {
  assert.match(CRITERIA, /`quality` describes evidence sufficiency only/);
  assert.match(CRITERIA, /`pass` is not approval or a positive verdict/);
  assert.match(CRITERIA, /a clearly ineligible event also receives `pass`/);
});

test('the existing safeguards are still stated in the criteria', () => {
  // 이번 변경은 완화가 아니다. 기존 게이트 문구가 그대로 남아 있어야 한다.
  assert.match(CRITERIA, /`entity_supported`: Does the event belong to the target company itself/);
  assert.match(CRITERIA, /S2 production expansion cannot use precursor/);
  assert.match(CRITERIA, /committed\/completed: The commitment to or completion of the final production-facility investment or acquisition itself/);
  assert.match(CRITERIA, /Do not relabel it precursor to approve it/);
  assert.match(CRITERIA, /`evidence_quotes` is an array of verbatim source sentences/);
  assert.match(CRITERIA, /String matching is not semantic validation/);
  assert.match(CRITERIA, /Quotes used for approval must exist in the prepared article's `evidence`/);
  assert.match(CRITERIA, /Do not downgrade content judgements or reject candidates because the publication date is uncertain/);
});

test('a criteria change gives every article a new id, so stored reviews are not reused', () => {
  const source = { target_no: 1, company: 'Example', title: 'Example plans a pilot',
    url: 'https://example.com/pilot', published_at: '2026-08-10T00:00:00Z',
    target_technology: 'target material', investment_signal_no: 2,
    content_text: 'Example is considering a new pilot plant for its target material.' };
  const period = { from_date: '2026-08-01', to_date: '2026-08-31' };
  const inputs = { technology: { companies: [] }, indicators: { indicators: [] } };
  const before = reviewPolicy({ policyText: '옛 판정 기준', ...inputs });
  const after = reviewPolicy({ policyText: '새 판정 기준', ...inputs });
  assert.notEqual(before, after);
  assert.notEqual(groupArticles([source], [], period, before)[0].id,
    groupArticles([source], [], period, after)[0].id);
  // 같은 기준이면 같은 식별자여야 재개가 동작한다.
  assert.equal(reviewPolicy({ policyText: '옛 판정 기준', ...inputs }), before);
});

test('committed and completed are reserved for the final investment itself', () => {
  // 완화가 아니라 구별이다. 최종 투자 자체는 그대로 탈락하고, 그것을 향한 중간 활동만 전조로 내려온다.
  assert.match(CRITERIA, /Use these stages only when the candidate indicator event is the final investment itself/);
  assert.match(CRITERIA, /Completed intermediate activities such as financing, appointments, agreements or certification/);
  assert.match(CRITERIA, /complete that activity, not the final investment/);
  assert.match(CRITERIA, /classify them as the corresponding indicator's precursor \(except S2\)/);
  // 지표 2 의 precursor 금지는 두 곳 모두에서 살아 있어야 한다.
  assert.match(CRITERIA, /S2 production expansion cannot use precursor/);
});

test('independence never means asserting a field without evidence', () => {
  assert.match(CRITERIA, /Independence does not permit unsupported true values/);
  assert.match(CRITERIA, /set a field false when its evidence is not established/);
  // 사유가 근거 부재를 말하면서 같은 필드를 true 로 두는 모순을 금지한다.
  assert.match(CRITERIA, /never set it true while the reason says that evidence is absent/);
});

test('the policy digest does not depend on how the checkout stores line endings', () => {
  // Windows 작업트리는 CRLF, 리눅스 러너는 LF 로 같은 문서를 받는다. 정규화하지 않으면 같은 커밋이
  // 플랫폼마다 다른 기사 id 를 만들고, 로컬에서 돌린 golden 평가가 운영과 다른 정책을 재게 된다.
  const inputs = { technology: { companies: [] }, indicators: { indicators: [] } };
  const lf = ['기준 한 줄', '다음 줄', ''].join('\n');
  const crlf = ['기준 한 줄', '다음 줄', ''].join('\r\n');
  assert.equal(reviewPolicy({ policyText: crlf, ...inputs }), reviewPolicy({ policyText: lf, ...inputs }));
  // 줄바꿈만 같게 볼 뿐, 내용이 바뀌면 여전히 달라져야 한다.
  assert.notEqual(reviewPolicy({ policyText: lf, ...inputs }), reviewPolicy({ policyText: '다른 기준', ...inputs }));
});

// 2026-08 전체 재검토 조사: 지표 설명이 "…등" 한 줄뿐이라 인수 잔금 지급이 S3, 사외이사 선임이 S5,
// 인수 찬성 투표가 S1, 실적 전망이 S2 로 승인됐다.
test('each indicator states what counts and what does not', () => {
  for (const no of [1, 2, 3, 4, 5]) {
    const line = CRITERIA.split('\n').find(item => item.includes(`\`investment:${no}\`(S${no}`));
    assert.ok(line, `investment:${no} 정의가 있어야 한다`);
    assert.match(line, /Exclude:/);
  }
  assert.match(CRITERIA, /outgoing payments such as acquisition consideration or remaining balances/);
  assert.match(CRITERIA, /appointments solely to board positions such as outside directors/);
  assert.match(CRITERIA, /sales or earnings forecasts and guidance/);
  assert.match(CRITERIA, /merely reporting results.*has no new precursor activity/);
  assert.match(CRITERIA, /Do not choose a verdict first and retrofit the explanation/);
});

test('the criteria sent to the model contain no step only a local agent can take', () => {
  assert.doesNotMatch(CRITERIA, /원문을 확인한다/);
  assert.doesNotMatch(CRITERIA, /새 준비본을 만든다/);
});
