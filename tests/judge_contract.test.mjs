import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { LOCAL_SUMMARY_INSTRUCTION, SUMMARY_ENGLISH_FIRST_INSTRUCTION, SUMMARY_ENGLISH_STYLE_INSTRUCTION,
  SUMMARY_GROUNDING_INSTRUCTION, SUMMARY_STYLE_INSTRUCTION, buildLocalInstruction, buildSystemInstruction,
  decisionProperties, decisionsEnvelopeFor, promptContract, reviewPromptDigest } from '../scripts/review_prompts.mjs';
import { GEMINI, NVIDIA } from '../scripts/review_providers.mjs';
import { policySection } from '../scripts/review_report.mjs';
import { buildWriterInstruction, writerPolicySection } from '../scripts/summary_writer.mjs';

// 판정과 문안을 두 단계로 나눴다(collect-company-signals → publish-report). 판정 호출이 문안 규칙을
// 다시 떠안으면 나눈 의미가 없으므로, 판정 요청에 문안 지시·문안 필드가 없다는 것을 여기서 고정한다.

const policyDoc = fs.readFileSync(new URL('../docs/local_report_review.md', import.meta.url), 'utf8');

test('the judge is asked for quotes, reason and verdicts only', () => {
  const fields = Object.keys(decisionProperties);
  assert.deepEqual(fields, ['candidate_id', 'evidence_quotes', 'reason', 'entity_supported', 'target_technology_supported',
    'indicator_supported', 'leading_indicator_supported', 'event_stage', 'quality']);
  const schema = JSON.stringify(decisionsEnvelopeFor());
  assert.equal(/summary_/.test(schema), false);
  for (const provider of [GEMINI, NVIDIA]) {
    const body = JSON.stringify(provider.body({ article: { candidates: [] }, policy: policySection(policyDoc), retry: false, model: provider.model }));
    assert.equal(body.includes('summary_ko'), false, provider.id);
    assert.equal(body.includes('summary_en'), false, provider.id);
  }
});

test('the judge instruction carries no summary rules, and its policy stops before the wording section', () => {
  const system = buildSystemInstruction(policySection(policyDoc));
  for (const rule of [SUMMARY_GROUNDING_INSTRUCTION, SUMMARY_ENGLISH_STYLE_INSTRUCTION, SUMMARY_STYLE_INSTRUCTION,
    SUMMARY_ENGLISH_FIRST_INSTRUCTION]) {
    assert.equal(system.includes(rule), false);
  }
  assert.equal(system.includes('## Summary wording'), false);
  assert.equal(system.includes('### Korean terminology'), false);
  assert.equal(system.includes('### Layout targets'), false);
  // 판정 기준과 날짜 규칙은 그대로 받는다.
  assert.ok(system.includes('### Approval'));
  assert.ok(system.includes('## Date handling'));
  assert.ok(system.includes('5. Article-level publication date'));
  // 인용은 이제 문안 단계가 받는 유일한 근거다. 승인 후보의 핵심 사실을 인용하라고 판정자에게 말한다.
  assert.match(system, /quote every sentence that states its essential facts/);
});

test('the local reviewer still gets the summary rules, because it writes both in one file', () => {
  const local = buildLocalInstruction(policyDoc);
  assert.ok(local.startsWith(buildSystemInstruction(policyDoc)));
  assert.ok(local.includes(LOCAL_SUMMARY_INSTRUCTION));
  assert.ok(local.includes(SUMMARY_ENGLISH_FIRST_INSTRUCTION));
  const source = fs.readFileSync(new URL('../scripts/local_report.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('buildLocalInstruction(policyText)'));
});

test('the writer gets the wording rules and none of the judgement criteria', () => {
  const writer = buildWriterInstruction(writerPolicySection(policyDoc));
  assert.ok(writer.includes(SUMMARY_GROUNDING_INSTRUCTION));
  assert.ok(writer.includes('### Layout targets'));
  assert.equal(writer.includes('### Additional judgement boundaries'), false);
  assert.equal(writer.includes('Summary eligibility (local review)'), false);
  assert.match(writer, /rejected_because/);
});

test('a change to the response schema alone invalidates the judgement cache', () => {
  const contract = promptContract();
  assert.ok(contract.schema, '스키마가 계약에 들어 있어야 digest 가 그것을 읽는다');
  const schemaOnly = { ...contract, schema: { ...contract.schema, properties: { ...contract.schema.properties, extra: { type: 'STRING' } } } };
  assert.equal(schemaOnly.system, contract.system);
  assert.notEqual(reviewPromptDigest('policy', schemaOnly), reviewPromptDigest('policy', contract));
});
