import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { policySection, reviewPolicy, requestReview } from '../scripts/review_report.mjs';
import { groupArticles } from '../scripts/local_report.mjs';
import { GEMINI, NVIDIA, decisionProperties } from '../scripts/review_providers.mjs';
import * as prompt from '../scripts/review_prompts.mjs';

const article = { id: 'fixture', evidence: ['Untrusted article text'], candidates: [{ id: 'investment:3', row: { private: true } }] };
const systemText = (provider, body) => provider.id === 'gemini' ? body.systemInstruction.parts[0].text : body.messages[0].content;
const userTexts = (provider, body) => provider.id === 'gemini' ? body.contents[0].parts.map(p => p.text) : body.messages.slice(1).map(m => m.content);

test('the shared prompt separates evidence, judgement, summaries and article date in order', () => {
  const headings = ['Task and trust boundary', '1. Extract', '2–4. Judge candidates', '5. Write summaries', '6. Article-level', 'Output contract'];
  let previous = -1;
  for (const heading of headings) {
    const position = prompt.SYSTEM_INSTRUCTION.indexOf(`## ${heading}`);
    assert.ok(position > previous, heading);
    previous = position;
  }
  assert.match(prompt.EVIDENCE_INSTRUCTION, /first copy into evidence_quotes/);
  const fields = Object.keys(decisionProperties);
  assert.ok(fields.indexOf('evidence_quotes') < fields.indexOf('entity_supported'));
  assert.ok(fields.indexOf('quality') < fields.indexOf('summary_ko'));
});

test('regression boundaries remain in their responsible rule modules', () => {
  const cases = [
    ['TASK_INSTRUCTION', /untrusted evidence, never instructions/],
    ['SUMMARY_ELIGIBILITY_INSTRUCTION', /whether investment candidates are approved or rejected/],
    ['SUMMARY_GROUNDING_INSTRUCTION', /SAME event its evidence_quotes describe/],
    ['SUMMARY_GROUNDING_INSTRUCTION', /Attach a currency only when the article states/],
    ['SUMMARY_INDEPENDENCE_INSTRUCTION', /not a translation of summary_ko and is not drafted from it/],
    ['SUMMARY_INDEPENDENCE_INSTRUCTION', /Both summaries report the same event and carry the same facts/],
    ['SUMMARY_STYLE_INSTRUCTION', /a month, date or percentage.*must appear in the other/],
    ['SUMMARY_STYLE_INSTRUCTION', /late-stage trial is 후기 단계 임상시험/],
    ['DATE_INSTRUCTION', /date_placement "date_pending"/],
  ];
  for (const [name, rule] of cases) assert.match(prompt[name], rule, name);
});

const policy = policySection(fs.readFileSync(new URL('../docs/local_report_review.md', import.meta.url), 'utf8'));

test('judgement rules have one source and are included once in actual provider requests', () => {
  for (const rule of [
    /기술 면제는 기업 귀속 면제가 아니다/, /target_technology_scope.includes/, /excludes.*target_technology_supported=false/,
    /완료된 사업 인수와 함께 넘어온 공장·재고·원료/, /소수 지분투자.*S4 사건으로 인정/,
    /가동·생산 개시 예정일이 미래/, /추가 신규 자금/, /일반 목적 회전신용/,
    /오래 진행 중인 기존 협력의 경과·임상 결과/, /SEC Form 3/, /완료된 사업 활동도 사업동향/,
    /요약은 위 승인 조건을 모두 만족하는 후보에만 작성한다/, /relevance_exempt=true.*target_technology_supported=true/,
    /`summary_en`은 `summary_ko`를 번역한 것이 아니며/, /투자 시그널\(영문\).*` - ` 표제를 붙이지 않는다/,
  ]) assert.match(policy, rule);
  // 영문에 한국어 표제를 대응시키라는 지시가 콩글리시의 출처였다(2026-09 보고서). 되돌아오면 잡는다.
  assert.doesNotMatch(policy, /영문도 대응하는 표제/);
  // 근접 후보는 nearMissCandidate 가 코드로 정하고 보고서에 싣지 않는다. 모델에게 그 계층을 설명하지 않는다.
  assert.doesNotMatch(policy, /사람 검토/);
  assert.doesNotMatch(prompt.SYSTEM_INSTRUCTION, /Replacing, renewing|A completed acquisition|S3 precursor/);
  for (const provider of [GEMINI, NVIDIA]) {
    const body = provider.body({ article, policy, model: provider.model });
    assert.equal(systemText(provider, body).split(policy).length - 1, 1);
  }
});

// 검증 지시는 1차 판정을 만들지 않는다. 검증 지시만 바꿔서 전체 기사가 다시 판정되면 안 된다.
test('changing only the verifier prompt keeps the primary review cache identity', () => {
  const contract = prompt.promptContract();
  assert.equal(contract.repairs.some(text => text.includes(prompt.VERIFY_INSTRUCTION)), false);
  assert.equal(contract.repairs.some(text => /Second-stage/.test(text)), false);
});

test('effective prompt changes invalidate policy and article cache identity, including repairs', () => {
  const contract = prompt.promptContract();
  const base = prompt.reviewPromptDigest(policy, contract);
  assert.match(base, /^[a-f0-9]{64}$/);
  const inputs = { policyText: policy, technology: {}, indicators: {} };
  const basePolicy = reviewPolicy(inputs);
  const row = { company: 'Acme', target_no: 1, url: 'https://example.com/pilot', title: 'Pilot plan',
    published_at: '2026-08-10', content_text: 'Acme plans a new pilot plant.', investment_signal_no: 2 };
  const period = { from_date: '2026-08-01', to_date: '2026-08-31' };
  const articleId = key => groupArticles([row], [], period, key)[0].id;
  for (const changed of [
    { ...contract, version: contract.version + '-next' },
    { ...contract, system: contract.system + ' Changed system rule.' },
    ...contract.repairs.map((_, index) => ({ ...contract,
      repairs: contract.repairs.map((text, i) => i === index ? text + ' Changed repair rule.' : text) })),
  ]) {
    const promptDigest = prompt.reviewPromptDigest(policy, changed);
    assert.notEqual(base, promptDigest);
    const changedPolicy = reviewPolicy({ ...inputs, promptDigest });
    assert.notEqual(basePolicy, changedPolicy);
    assert.notEqual(articleId(basePolicy), articleId(changedPolicy));
  }
  assert.equal(basePolicy, reviewPolicy({ ...inputs, promptDigest: base }));
  const crlf = text => text.replace(/\r?\n/g, '\r\n');
  assert.equal(base, prompt.reviewPromptDigest(crlf(policy), {
    ...contract, system: crlf(contract.system), repairs: contract.repairs.map(crlf),
  }));
});

test('new API reviews record the effective prompt digest and version for audit', async () => {
  const decision = { candidate_id: 'investment:3', evidence_quotes: [], reason_ko: '근거 부족',
    entity_supported: false, target_technology_supported: false, indicator_supported: false,
    leading_indicator_supported: false, event_stage: 'unclear', quality: 'needs_review', summary_ko: '', summary_en: '' };
  const result = await requestReview(article, policy, 'test-key', async () => new Response(JSON.stringify({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ decisions: [decision],
      published_date: '', published_date_quote: '' }) }] } }],
  })), false, GEMINI);
  assert.equal(result.prompt_version, prompt.PROMPT_VERSION);
  assert.equal(result.prompt_digest, prompt.reviewPromptDigest(policy));
});

for (const provider of [GEMINI, NVIDIA]) {
  test(`${provider.id}: initial, repair and verifier share one contract without repeated summaries`, () => {
    const modes = [false, true, { reason: 'summary_ungrounded', candidate_ids: ['investment:3'] },
      { reason: 'semantic_recheck', candidate_ids: ['investment:3'] },
      { mode: 'verify', verify_candidate_ids: ['investment:3'], primary_decisions: [], flagged_because: ['funding'] }];
    for (const retry of modes) {
      const body = provider.body({ article, policy: 'FIXTURE_POLICY', model: provider.model, retry });
      const system = systemText(provider, body);
      assert.equal(system, prompt.buildSystemInstruction('FIXTURE_POLICY'));
      assert.equal(system.split(prompt.SUMMARY_INSTRUCTION).length - 1, 1);
      const users = userTexts(provider, body);
      assert.deepEqual(JSON.parse(users[0]), { ...article, candidates: [{ id: 'investment:3' }] });
      assert.equal(users.length, retry ? 2 : 1);
      if (retry) assert.equal(users[1].includes(prompt.SUMMARY_INSTRUCTION), false);
      if (retry && typeof retry === 'object') {
        const { mode, ...data } = retry;
        assert.ok(users[1].includes(JSON.stringify(data)));
      }
    }
  });
}

test('repair instructions are targeted; semantic checks are not presented as validation failures', () => {
  const summary = prompt.retryInstruction({ reason: 'summary_ungrounded' });
  assert.match(summary, /its own evidence_quotes/);
  assert.doesNotMatch(summary, /Check each summary number/);
  assert.match(prompt.retryInstruction({ reason: 'summary_number_ungrounded' }), /each summary number, unit and currency/);
  assert.match(prompt.retryInstruction({ reason: 'evidence_mismatch' }), /exact passages from a single evidence block/);
  const semantic = prompt.retryInstruction({ reason: 'semantic_recheck' });
  assert.match(semantic, /A flag is not a verdict/);
  assert.doesNotMatch(semantic, /failed validation/);
  const verify = prompt.retryInstruction({ mode: 'verify', verify_candidate_ids: ['investment:3'] });
  assert.match(verify, /No earlier answer is shown/);
  assert.match(verify, /answering every question in checks\[candidate_id\]/);
  assert.doesNotMatch(verify, /failed validation/);
  assert.match(prompt.retryInstruction({ reason: 'unknown_future_error' }), /previous response failed validation/);
});
