import test from 'node:test';
import assert from 'node:assert/strict';
import { GEMINI, NVIDIA, SUMMARY_INSTRUCTION } from '../scripts/review_providers.mjs';
import { requestReview } from '../scripts/review_report.mjs';
import { groupArticles, importReview } from '../scripts/local_report.mjs';

// The failed EPIC response supplied S4 summaries but omitted both relevant summaries.
// Use a technology-exempt company so false technology is not mistaken for rejection.
const quote = 'Acme and University will jointly develop advanced chip packaging processes.';
const row = { company: 'Acme', target_no: 1, title: 'Research collaboration',
  url: 'https://example.com/research', published_at: '2026-08-11', content_text: quote,
  target_technology: 'hybrid bonding', excluded_from_relevance: true };
const article = groupArticles([{ ...row, investment_signal_no: 4 }], [row],
  { from_date: '2026-08-01', to_date: '2026-08-31' })[0];
const decisions = article.candidates.map(c => ({ candidate_id: c.id,
  entity_supported: true, target_technology_supported: false, indicator_supported: true,
  leading_indicator_supported: true, event_stage: c.kind === 'relevant' ? 'not_applicable' : 'precursor',
  quality: 'pass', reason_ko: '구체적 반도체 공정 공동연구가 확인됨', evidence_quotes: [quote],
  summary_ko: '대학과 첨단 칩 패키징 공정을 공동 개발할 예정임.',
  summary_en: 'Acme and University will jointly develop advanced chip packaging processes.' }));

function response(provider, ds) {
  const text = JSON.stringify({ decisions: ds, published_date: '', published_date_quote: '' });
  return new Response(JSON.stringify(provider.id === 'gemini'
    ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] }
    : { choices: [{ finish_reason: 'stop', message: { content: text } }] }));
}

for (const provider of [GEMINI, NVIDIA]) {
  test(`${provider.id}: initial and retry payloads require separate bilingual relevant summaries`, () => {
    const body = retry => provider.body({ article, policy: 'POLICY', retry, model: provider.model });
    const initial = body(false), retried = body(true);
    const system = provider.id === 'gemini' ? initial.systemInstruction.parts[0].text : initial.messages[0].content;
    const retry = provider.id === 'gemini' ? retried.contents[0].parts[1].text : retried.messages[2].content;
    assert.ok(system.includes(SUMMARY_INSTRUCTION));
    assert.ok(retry.includes(SUMMARY_INSTRUCTION));
    assert.match(retry, /missing summary_ko or summary_en, especially relevant/);
    assert.match(system, /whether investment candidates are approved or rejected/);
    assert.match(system, /either relevance_exempt=true or target_technology_supported=true/);
    assert.match(system, /Do not change evidence-based fields or quality/);
  });

  test(`${provider.id}: EPIC-style missing relevant text is rejected; complete retry preserves decisions`, async () => {
    for (const missing of [['summary_ko'], ['summary_en'], ['summary_ko', 'summary_en']]) {
      const broken = decisions.map(d => d.candidate_id === 'relevant'
        ? { ...d, ...Object.fromEntries(missing.map(key => [key, ''])) } : d);
      await assert.rejects(requestReview(article, '', 'test-key', async () => response(provider, broken), false, provider),
        error => {
          assert.equal(error.response_code, 'review_validation');
          for (const key of missing) assert.ok(error.diagnostic.validation_message.includes(`missing ai_${key}`));
          return true;
        });
    }
    const review = await requestReview(article, '', 'test-key', async () => response(provider, decisions), true, provider);
    assert.deepEqual(review.decisions, decisions);
    assert.deepEqual(importReview(article, review).map(r => r.supported), [true, true]);

    // Business summaries remain required when no investment signal qualifies.
    const businessOnly = decisions.map(d => d.candidate_id === 'investment:4'
      ? { ...d, indicator_supported: false, leading_indicator_supported: false, event_stage: 'unclear',
        summary_ko: '', summary_en: '' } : d);
    const businessReview = await requestReview(article, '', 'test-key', async () => response(provider, businessOnly), false, provider);
    assert.deepEqual(importReview(article, businessReview).map(r => r.supported), [false, true]);
    // A quote fabricated to fill the output obligation must still fail.
    const fabricated = decisions.map(d => ({ ...d, evidence_quotes: ['An invented agreement.'] }));
    await assert.rejects(requestReview(article, '', 'test-key', async () => response(provider, fabricated), true, provider),
      error => error.response_code === 'evidence_mismatch');
  });
}
