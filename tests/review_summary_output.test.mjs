import test from 'node:test';
import assert from 'node:assert/strict';
import { GEMINI, NVIDIA } from '../scripts/review_providers.mjs';
import { SUMMARY_GROUNDING_INSTRUCTION } from '../scripts/review_prompts.mjs';
import fs from 'node:fs';
import { requestReview, policySection } from '../scripts/review_report.mjs';
import { groupArticles, importReview } from '../scripts/local_report.mjs';

// 판정 호출은 문안을 쓰지 않는다. 예전에는 EPIC 응답이 사업동향 문안을 빠뜨렸다는 이유로 거부됐고,
// 근거 있는 판정이 문안 형식 때문에 기사째 빠졌다. 이제 문안 없는 판정이 정상이며, 인용 검증은 그대로다.
// Use a technology-exempt company so false technology is not mistaken for rejection.
const policy = policySection(fs.readFileSync(new URL('../docs/local_report_review.md', import.meta.url), 'utf8'));
const quote = 'Acme and University will jointly develop advanced chip packaging processes.';
// 본문 없는 기사는 승인되지 않으므로 기사 길이의 본문을 둔다.
const TAIL = 'The work starts with qualification volumes, and both partners said the first results are expected next year ' +
  'once the shared line has been installed.';
const row = { company: 'Acme', target_no: 1, title: 'Research collaboration',
  url: 'https://example.com/research', published_at: '2026-08-11', content_text: `${quote} ${TAIL}`,
  target_technology: 'hybrid bonding', target_technology_en: 'hybrid bonding', excluded_from_relevance: true };
const article = groupArticles([{ ...row, investment_signal_no: 4 }], [row],
  { from_date: '2026-08-01', to_date: '2026-08-31' })[0];
const decisions = article.candidates.map(c => ({ candidate_id: c.id,
  entity_supported: true, target_technology_supported: false, indicator_supported: true,
  leading_indicator_supported: true, event_stage: c.kind === 'relevant' ? 'not_applicable' : 'precursor',
  quality: 'pass', reason: '구체적 반도체 공정 공동연구가 확인됨', evidence_quotes: [quote] }));

function response(provider, ds) {
  const text = JSON.stringify({ decisions: ds, published_date: '', published_date_quote: '' });
  return new Response(JSON.stringify(provider.id === 'gemini'
    ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] }
    : { choices: [{ finish_reason: 'stop', message: { content: text } }] }));
}

for (const provider of [GEMINI, NVIDIA]) {
  test(`${provider.id}: initial and retry payloads carry no summary rules or summary repair`, () => {
    const body = retry => provider.body({ article, policy, retry, model: provider.model });
    const initial = body(false), retried = body(true);
    const system = provider.id === 'gemini' ? initial.systemInstruction.parts[0].text : initial.messages[0].content;
    const retry = provider.id === 'gemini' ? retried.contents[0].parts[1].text : retried.messages[2].content;
    assert.equal(system.includes(SUMMARY_GROUNDING_INSTRUCTION), false);
    assert.equal(/summary_ko|summary_en/.test(system), false);
    assert.equal(/summary/i.test(retry), false);
    // Retries inherit the system contract unchanged.
    const retrySystem = provider.id === 'gemini' ? retried.systemInstruction.parts[0].text : retried.messages[0].content;
    assert.equal(retrySystem, system);
    const feedback = { reason: 'review_validation', validation_message: 'S4: missing boolean entity_supported' };
    const targeted = body(feedback);
    const targetedText = provider.id === 'gemini' ? targeted.contents[0].parts[1].text : targeted.messages[2].content;
    assert.ok(targetedText.includes(JSON.stringify(feedback)));
  });

  test(`${provider.id}: a judgement without summaries is accepted; quotes are still verified`, async () => {
    const review = await requestReview(article, '', 'test-key', async () => response(provider, decisions), false, provider);
    assert.deepEqual(review.decisions, decisions);
    assert.deepEqual(importReview(article, review, { summaries: false }).map(r => r.supported), [true, true]);
    // 보고서를 만드는 가져오기는 문안을 요구한다. 문안 단계가 아직 돌지 않은 판정으로 보고서를 만들지 않는다.
    assert.throws(() => importReview(article, review), /missing ai_summary_ko/);
    // A quote fabricated to fill the output must still fail.
    const fabricated = decisions.map(d => ({ ...d, evidence_quotes: ['An invented agreement.'] }));
    await assert.rejects(requestReview(article, '', 'test-key', async () => response(provider, fabricated), true, provider),
      error => error.response_code === 'evidence_mismatch');
  });
}
