import test from 'node:test';
import assert from 'node:assert/strict';
import { GEMINI, NVIDIA, decisionProperties } from '../scripts/review_providers.mjs';
import * as prompt from '../scripts/review_prompts.mjs';

const article = { id: 'fixture', evidence: ['Untrusted article text'], candidates: [{ id: 'investment:3', row: { private: true } }] };
const systemText = (provider, body) => provider.id === 'gemini' ? body.systemInstruction.parts[0].text : body.messages[0].content;
const userTexts = (provider, body) => provider.id === 'gemini' ? body.contents[0].parts.map(p => p.text) : body.messages.slice(1).map(m => m.content);

test('the shared prompt separates evidence, judgement, summaries and article date in order', () => {
  const headings = ['Task and trust boundary', '1. Extract', '2. Judge identity', '3. Judge candidate', '4. Apply indicator', '5. Write summaries', '6. Article-level', 'Output contract'];
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
    ['IDENTITY_TECHNOLOGY_INSTRUCTION', /technology exemption never exempts entity identity/],
    ['IDENTITY_TECHNOLOGY_INSTRUCTION', /falls under excludes is target_technology_supported=false/],
    ['EVENT_STAGE_INSTRUCTION', /future start-up date alone does not make it planned/],
    ['EVENT_STAGE_INSTRUCTION', /reporting_period.from_date and reporting_period.to_date/],
    ['S1_ACQUISITION_INSTRUCTION', /plants, stock or feedstock that came with it/],
    ['S1_ACQUISITION_INSTRUCTION', /minority equity investment.*remains an S4 event/],
    ['S2_CAPACITY_INSTRUCTION', /order backlog.*not production expansion/],
    ['S3_FUNDING_INSTRUCTION', /unless the evidence states additional new money/],
    ['S3_FUNDING_INSTRUCTION', /general-purpose revolving facility.*leading_indicator_supported=false/],
    ['S4_TECHNOLOGY_INSTRUCTION', /Progress or trial results.*not a new collaboration/],
    ['S5_PERSONNEL_INSTRUCTION', /merely lists an officer title does not prove an appointment/],
    ['BUSINESS_ACTIVITY_INSTRUCTION', /Completed business activity can qualify/],
    ['SUMMARY_ELIGIBILITY_INSTRUCTION', /fails exactly ONE other approval condition/],
    ['SUMMARY_ELIGIBILITY_INSTRUCTION', /whether investment candidates are approved or rejected/],
    ['SUMMARY_GROUNDING_INSTRUCTION', /SAME event its evidence_quotes describe/],
    ['SUMMARY_GROUNDING_INSTRUCTION', /Attach a currency only when the article states/],
    ['SUMMARY_STYLE_INSTRUCTION', /a month, date or percentage.*must appear in the other/],
    ['SUMMARY_STYLE_INSTRUCTION', /late-stage trial is 후기 단계 임상시험/],
    ['DATE_INSTRUCTION', /date_placement "date_pending"/],
  ];
  for (const [name, rule] of cases) assert.match(prompt[name], rule, name);
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
  assert.match(verify, /not in verify_candidate_ids return the primary decision unchanged/);
  assert.doesNotMatch(verify, /failed validation/);
  assert.match(prompt.retryInstruction({ reason: 'unknown_future_error' }), /previous response failed validation/);
});
