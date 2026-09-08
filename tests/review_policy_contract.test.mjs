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
  assert.match(CRITERIA, /각 필드는 독립적으로 판단한다/);
  for (const field of ['entity_supported', 'target_technology_supported', 'indicator_supported',
    'leading_indicator_supported', 'quality']) {
    assert.match(CRITERIA, new RegExp(field), `${field} 가 독립 판단 대상으로 명시되어야 한다`);
  }
  assert.match(CRITERIA, /다른 필드의 판정 근거로 옮기지 않는다/);
});

test('a technology exemption is not allowed to travel into indicator or quality', () => {
  const exemption = CRITERIA.split('\n').find(line => /relevance_exempt=true/.test(line));
  assert.ok(exemption, 'relevance_exempt 규칙이 판정 기준에 있어야 한다');
  // 면제 후보의 target_technology_supported=false 는 사실대로 기록하되 다른 필드로 번지지 않는다.
  assert.match(exemption, /사실 그대로 기록/);
  assert.match(exemption, /`indicator_supported`(이|나) *`?quality`?/);
  assert.match(exemption, /탈락 사유로 다시 쓰지 않는다/);
});

test('event_stage is judged on the candidate event, not on how the sentence is worded', () => {
  assert.match(CRITERIA, /`event_stage`는 이 후보 사건이 최종 투자에 대해 어느 단계인지/);
  assert.match(CRITERIA, /"체결"·"완료"라고 적혀 있는지가 아니라/);
  // 지표별 전조 예시가 남아 있어야 한다.
  assert.match(CRITERIA, /자금 확보\(S3\)/);
  assert.match(CRITERIA, /연구협업\(S4\)/);
});

test('quality=pass states evidence sufficiency, never approval', () => {
  assert.match(CRITERIA, /`quality`는 근거의 충분성만 말한다/);
  assert.match(CRITERIA, /`pass`는 승인이나 긍정 판정이 아니며/);
  assert.match(CRITERIA, /명확한 부적합도 `?pass`?/);
});

test('the existing safeguards are still stated in the criteria', () => {
  // 이번 변경은 완화가 아니다. 기존 게이트 문구가 그대로 남아 있어야 한다.
  assert.match(CRITERIA, /`entity_supported`: 사건이 타겟 기업 자체에 귀속되는가/);
  assert.match(CRITERIA, /생산 증설 지표 2에는 이 단계를 쓸 수 없다/);
  assert.match(CRITERIA, /committed\/completed: 최종 생산시설 투자·인수 등의 확정·완료 사실 자체/);
  assert.match(CRITERIA, /이를 precursor로 우회 승인하지 않는다/);
  assert.match(CRITERIA, /`evidence_quotes`는 원문에서 그대로 가져온 문장 배열/);
  assert.match(CRITERIA, /단순 문자열 일치 검사는 의미 검증을 대신하지 않는다/);
  assert.match(CRITERIA, /승인에 쓰는 인용은 준비본의 `evidence`에 실제로 있어야 한다/);
  assert.match(CRITERIA, /게시일이 불확실하다는 이유로 내용 판정을 낮추거나 후보를 탈락시키지 않는다/);
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
  assert.match(CRITERIA, /이 단계는 후보 지표의 사건이 최종 투자 그 자체일 때만 쓴다/);
  assert.match(CRITERIA, /조달·임명·협약·인증처럼 최종 투자를 향한 중간 활동이 끝난 것은/);
  assert.match(CRITERIA, /그 활동이 완료된 것이지 최종 투자가 완료된 것이 아니며/);
  assert.match(CRITERIA, /그런 후보의 단계는 해당 지표의 precursor다\(지표 2 제외\)/);
  // 지표 2 의 precursor 금지는 두 곳 모두에서 살아 있어야 한다.
  assert.match(CRITERIA, /생산 증설 지표 2에는 이 단계를 쓸 수 없다/);
});

test('independence never means asserting a field without evidence', () => {
  assert.match(CRITERIA, /독립성은 근거 없이 true를 주라는 뜻이 아니다/);
  assert.match(CRITERIA, /그 필드의 근거가 확인되지 않으면 false/);
  // 사유가 근거 부재를 말하면서 같은 필드를 true 로 두는 모순을 금지한다.
  assert.match(CRITERIA, /사유에 그 근거가 없다고 적으면서 같은 필드를 true로 두지 않는다/);
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
