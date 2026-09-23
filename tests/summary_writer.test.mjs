import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { groupArticles, importReview } from '../scripts/local_report.mjs';
import { policySection, summaryStyleProblems } from '../scripts/review_report.mjs';
import {
  buildWriterInstruction, writerPolicySection, writerRequest, writerBody, resolveWriter, writeSummaries,
  DEFAULT_WRITER_MODEL, WRITER_EXAMPLES,
} from '../scripts/summary_writer.mjs';

const doc = fs.readFileSync(new URL('../docs/local_report_review.md', import.meta.url), 'utf8');
const wording = writerPolicySection(doc);
const quote = 'Acme priced EUR 500 million of senior notes to fund a new wafer plant in Dresden, Germany.';
const TAIL = 'The company said construction would begin once permits are granted, and that the plant would first serve ' +
  'qualification volumes for its existing customers before a wider ramp next year.';
const row = { company: 'Acme', target_no: 1, title: 'Acme prices senior notes', url: 'https://example.com/notes',
  published_at: '2026-08-11', content_text: `${quote} ${TAIL}`, target_technology: 'wafer', target_technology_en: 'wafer',
  investment_signal_no: 3, investment_signal_label_en: 'Capital Raising & Financing' };
const article = groupArticles([row], [], { from_date: '2026-08-01', to_date: '2026-08-31' })[0];
const judge = {
  candidate_id: 'investment:3', entity_supported: true, target_technology_supported: true, indicator_supported: true,
  leading_indicator_supported: true, event_stage: 'precursor', quality: 'pass', reason: 'New notes fund a new plant.',
  evidence_quotes: [quote],
  summary_ko: '5억 유로 채권 발행 성공 - Acme는 드레스덴 신규 웨이퍼 공장 자금을 위해 5억 유로 규모 시니어 노트를 성공적으로 프라이싱했음.',
  summary_en: 'Acme successfully priced EUR 500 million of senior notes for a new wafer plant in Dresden, Germany.',
};
const review = { article_id: article.id, reviewer: 'gemini/test', provider: 'gemini', decisions: [judge] };
const good = {
  candidate_id: 'investment:3',
  summary_en: 'Acme priced EUR 500 million of senior notes to fund a new wafer plant in Dresden, Germany.',
  summary_ko: '독일 신규 웨이퍼 공장 건설 자금 조달 - Acme는 독일 Dresden 신규 웨이퍼 공장 건설 자금을 마련하기 위해 5억 유로 규모의 선순위채를 발행했음.',
};
const writer = { ...resolveWriter({}), delayMs: 0 };
const gemini = summaries => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP',
  content: { parts: [{ text: JSON.stringify({ summaries }) }] } }] }));

async function workspace() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'writer-'));
  const reviewDir = path.join(root, 'reviews');
  await fsp.mkdir(reviewDir);
  await fsp.writeFile(path.join(reviewDir, `${article.id}.json`), JSON.stringify(review));
  const read = async () => JSON.parse(await fsp.readFile(path.join(reviewDir, `${article.id}.json`), 'utf8'));
  return { root, reviewDir, cacheDir: path.join(root, 'written'), read };
}
const run = (ws, fetchImpl) => writeSummaries({ articles: [article], reviewDir: ws.reviewDir, cacheDir: ws.cacheDir, writer,
  apiKey: 'AIza-test', policyWording: wording, styleProblems: summaryStyleProblems, fetchImpl, sleep: async () => {}, log: () => {} });

test('the fixture is an approved candidate the report would import', () => {
  assert.equal(importReview(article, review)[0].supported, true);
});

test('the writer defaults to gemini-3.7-flash with low thinking and can be switched off', () => {
  assert.equal(DEFAULT_WRITER_MODEL, 'gemini-3.7-flash');
  assert.equal(resolveWriter({}).model, 'gemini-3.7-flash');
  assert.equal(resolveWriter({}).thinkingLevel, 'low');
  assert.equal(resolveWriter({ GEMINI_WRITER_MODEL: 'gemini-3.8-flash' }).model, 'gemini-3.8-flash');
  assert.equal(resolveWriter({ REVIEW_WRITER: 'off' }), null);
  assert.throws(() => resolveWriter({ GEMINI_WRITER_THINKING_LEVEL: 'max' }));
});

test('the writer prompt carries style rules and examples, not the judgement criteria', () => {
  const instruction = buildWriterInstruction(wording);
  // 판정 기준을 넣지 않는 것이 분리의 목적이다.
  assert.equal(instruction.includes(policySection(doc)), false);
  assert.equal(instruction.includes('S2 production expansion and diversification intent'), false);
  assert.match(instruction, /Korean terminology/);
  assert.match(instruction, /Write summary_en first, then summary_ko/);
  for (const example of WRITER_EXAMPLES) assert.ok(instruction.includes(example.good.summary_ko));
  assert.match(instruction, /BAD summary_ko/);
  // 가상의 예시 기업이 실제 문안으로 새지 않게 경고한다.
  assert.match(instruction, /Fictional company: never reuse its names or facts/);
});

test('the good examples pass the checks the report applies to real summaries', () => {
  for (const example of WRITER_EXAMPLES) {
    const decision = { candidate_id: example.kind === 'investment' ? 'investment:3' : 'relevant', ...example.good };
    const problems = summaryStyleProblems({ ...article, company: 'Example' }, decision)
      .filter(problem => problem !== 'company_name_not_latin');
    assert.deepEqual(problems, [], example.good.summary_ko);
  }
});

test('the writer request hides the judge summary and reason so the copy is written from evidence', () => {
  const request = writerRequest(article, [judge]);
  const text = JSON.stringify(request);
  assert.equal(text.includes(judge.summary_ko), false);
  assert.equal(text.includes(judge.summary_en), false);
  assert.equal(text.includes(judge.reason), false);
  assert.deepEqual(request.items[0].evidence_quotes, [quote]);
  assert.equal(request.items[0].indicator, 'Capital Raising & Financing');
  // 투자 시그널만 있는 기사는 본문을 보내지 않는다.
  assert.equal('article_evidence' in request, false);
  const body = writerBody(writer, buildWriterInstruction(wording), request);
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'low');
  assert.deepEqual(Object.keys(body.generationConfig.responseSchema.properties.summaries.items.properties),
    ['candidate_id', 'summary_en', 'summary_ko']);
});

test('a written summary replaces the judge summary, keeps the original and is reused without another request', async () => {
  const ws = await workspace();
  let calls = 0;
  const stats = await run(ws, async () => { calls += 1; return gemini([good]); });
  assert.equal(calls, 1);
  assert.equal(stats.written, 1);
  const saved = await ws.read();
  assert.equal(saved.decisions[0].summary_ko, good.summary_ko);
  assert.equal(saved.decisions[0].judge_summary_ko, judge.summary_ko);
  assert.equal(saved.decisions[0].summary_writer.model, 'gemini-3.7-flash');
  assert.equal(importReview(article, saved)[0].row.ai_summary_en, good.summary_en);
  const again = await run(ws, async () => { calls += 1; return gemini([good]); });
  assert.equal(calls, 1);
  assert.equal(again.requests, 0);
});

test('a written summary that fails the grounding checks falls back to the judge summary', async () => {
  const ws = await workspace();
  const wrong = { ...good, summary_en: 'Acme priced EUR 800 million of senior notes to fund a new wafer plant in Dresden, Germany.' };
  const stats = await run(ws, async () => gemini([wrong]));
  assert.equal(stats.fallback, 1);
  assert.equal(stats.rejected.ungrounded_numbers, 1);
  const saved = await ws.read();
  assert.equal(saved.decisions[0].summary_en, judge.summary_en);
  assert.equal('summary_writer' in saved.decisions[0], false);
});

test('a missing Korean headline or an English headline is rejected', async () => {
  const ws = await workspace();
  const stats = await run(ws, async () => gemini([{ ...good, summary_ko: 'Acme는 5억 유로 규모의 선순위채를 발행했음.' }]));
  assert.equal(stats.rejected.korean_headline_missing, 1);
  const ws2 = await workspace();
  const stats2 = await run(ws2, async () => gemini([{ ...good, summary_en: 'Plant Funding - ' + good.summary_en }]));
  assert.equal(stats2.rejected.english_headline, 1);
});

test('an English summary with Hangul in it is rejected and the prompt asks for American spelling', async () => {
  const ws = await workspace();
  const stats = await run(ws, async () => gemini([{ ...good, summary_en: good.summary_en.replace('Dresden', 'Dresden(드레스덴)') }]));
  assert.equal(stats.rejected.hangul_in_english, 1);
  assert.match(buildWriterInstruction(wording), /American spelling/);
});

test('a free-tier 429 or timeout keeps the judge summary, stops asking and never blocks the report', async () => {
  const ws = await workspace();
  let calls = 0;
  const stats = await run(ws, async () => { calls += 1; return new Response('{"error":{"message":"quota"}}', { status: 429 }); });
  assert.equal(stats.fallback, 1);
  assert.equal(stats.stopped, 'quota');
  assert.equal((await ws.read()).decisions[0].summary_en, judge.summary_en);
  const ws2 = await workspace();
  const timeout = await run(ws2, async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); });
  assert.equal(timeout.errors.timeout, 1);
  assert.equal(timeout.stopped, undefined);
  assert.equal((await ws2.read()).decisions[0].summary_en, judge.summary_en);
});
