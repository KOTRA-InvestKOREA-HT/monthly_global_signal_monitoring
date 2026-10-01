import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { groupArticles, importReview, summaryNumberProblems, summaryQuoteProblems } from '../scripts/local_report.mjs';
import { policySection } from '../scripts/review_report.mjs';
import {
  buildWriterInstruction, writerPolicySection, writerRequest, writerBody, resolveWriter, writeSummaries, summaryStyleProblems,
  DEFAULT_WRITER_MODEL, WRITER_ATTEMPTS, WRITER_EXAMPLES,
} from '../scripts/summary_writer.mjs';
import { issueNumberFor, judgementFor, summaryApiKey } from '../scripts/publish_report.mjs';

const doc = fs.readFileSync(new URL('../docs/local_report_review.md', import.meta.url), 'utf8');
const wording = writerPolicySection(doc);
const quote = 'Acme priced EUR 500 million of senior notes to fund a new wafer plant in Dresden, Germany.';
const TAIL = 'The company said construction would begin once permits are granted, and that the plant would first serve ' +
  'qualification volumes for its existing customers before a wider ramp next year.';
const row = { company: 'Acme', target_no: 1, title: 'Acme prices senior notes', url: 'https://example.com/notes',
  published_at: '2026-08-11', content_text: `${quote} ${TAIL}`, target_technology: 'wafer', target_technology_en: 'wafer',
  investment_signal_no: 3, investment_signal_label_en: 'Capital Raising & Financing' };
const article = groupArticles([row], [], { from_date: '2026-08-01', to_date: '2026-08-31' })[0];
// 판정 호출은 문안을 쓰지 않는다. 판정 파일의 결정에는 인용·사유·판정만 있다.
const judge = {
  candidate_id: 'investment:3', entity_supported: true, target_technology_supported: true, indicator_supported: true,
  leading_indicator_supported: true, event_stage: 'precursor', quality: 'pass', reason: 'New notes fund a new plant.',
  evidence_quotes: [quote],
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
  return { root, reviewDir, read };
}
const run = (ws, fetchImpl, articles = [article]) => writeSummaries({ articles, reviewDir: ws.reviewDir, writer,
  apiKey: 'AIza-test', policyWording: wording, fetchImpl, sleep: async () => {}, log: () => {} });

const bodyText = init => JSON.parse(init.body).contents[0].parts[0].text;

test('the fixture is an approved judgement that the report cannot import until it has copy', () => {
  assert.equal(importReview(article, review, { summaries: false })[0].supported, true);
  assert.throws(() => importReview(article, review), /missing ai_summary_ko/);
});

test('the writer is gemini-3.5-flash-lite alone, with high thinking, four requests at a time, and cannot be switched off', () => {
  assert.equal(DEFAULT_WRITER_MODEL, 'gemini-3.5-flash-lite');
  const resolved = resolveWriter({});
  assert.equal(resolved.model, 'gemini-3.5-flash-lite');
  assert.equal(resolved.thinkingLevel, 'high');
  assert.equal(resolved.delayMs, 4500);
  assert.equal(resolved.concurrency, 4);
  // 503 으로 막히는 기본 모델에서 넘어가던 대체 모델 단계는 없다.
  assert.equal('fallback' in resolved, false);
  assert.equal(resolveWriter({ GEMINI_WRITER_MODEL: 'gemini-3.8-flash' }).model, 'gemini-3.8-flash');
  assert.equal(resolveWriter({ REPORT_CONCURRENCY: '2' }).concurrency, 2);
  assert.throws(() => resolveWriter({ REPORT_CONCURRENCY: '0' }), /REPORT_CONCURRENCY/);
  // 보고서 문안은 이 단계만 쓴다. 꺼 두면 보고서를 만들 수 없으므로 끄는 선택지를 두지 않는다.
  assert.equal(resolveWriter({ REVIEW_WRITER: 'off' }).model, 'gemini-3.5-flash-lite');
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
  assert.match(instruction, /American spelling/);
});

test('the good examples pass the checks the report applies to real summaries', () => {
  for (const example of WRITER_EXAMPLES) {
    const decision = { candidate_id: example.kind === 'investment' ? 'investment:3' : 'relevant', ...example.good };
    const problems = summaryStyleProblems({ ...article, company: 'Example' }, decision)
      .filter(problem => problem !== 'company_name_not_latin');
    assert.deepEqual(problems, [], example.good.summary_ko);
  }
});

test('the writer request carries evidence only, plus the checks a previous copy failed', () => {
  const request = writerRequest(article, [judge]);
  const text = JSON.stringify(request);
  assert.equal(text.includes(judge.reason), false);
  assert.deepEqual(request.items[0].evidence_quotes, [quote]);
  assert.equal(request.items[0].indicator, 'Capital Raising & Financing');
  assert.equal('rejected_because' in request.items[0], false);
  // 투자 시그널 문안도 본문을 받는다. 인용이 제목 한 줄이면 인용만으로는 맥락을 쓸 수 없다.
  assert.match(request.article_evidence, /construction would begin once permits are granted/);
  const retry = writerRequest(article, [judge], { 'investment:3': ['ungrounded_numbers:800'] },
    { 'investment:3': { summary_en: 'The company raised USD 800 million.', summary_ko: '자금 조달 - 8억 달러를 조달했음.' } });
  // 코드만 보내지 않고 무엇이 틀렸는지 풀어 쓴 안내를 보낸다. 원래 코드는 끝에 남는다.
  assert.match(retry.items[0].rejected_because[0], /^Number not in the article: .*\[ungrounded_numbers:800\]$/);
  assert.deepEqual(retry.items[0].previous_copy, { summary_en: 'The company raised USD 800 million.', summary_ko: '자금 조달 - 8억 달러를 조달했음.' });
  // 걸린 문제가 없으면 이전 문안도 보내지 않는다.
  assert.equal('previous_copy' in writerRequest(article, [judge], {}, { 'investment:3': { summary_en: 'x', summary_ko: 'y' } }).items[0], false);
  const body = writerBody(writer, buildWriterInstruction(wording), request);
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'high');
  assert.deepEqual(Object.keys(body.generationConfig.responseSchema.properties.summaries.items.properties),
    ['candidate_id', 'source_quotes', 'summary_en', 'summary_ko']);
});

// 인용 밖 사실은 본문에서 가져올 수 있지만, 가져온 문장을 source_quotes 로 적어야 하고 그 문장은 본문에 그대로 있어야 한다.
test('copy may add facts from the article body when it cites the exact sentence they come from', async () => {
  const extra = 'Tessaro Engineering will build the plant, which is due to open in 2028.';
  const withBody = groupArticles([{ ...row, content_text: `${quote} ${extra} ${TAIL}` }], [],
    { from_date: '2026-08-01', to_date: '2026-08-31' })[0];
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'writer-body-'));
  const reviewDir = path.join(root, 'reviews');
  await fsp.mkdir(reviewDir);
  const file = path.join(reviewDir, `${withBody.id}.json`);
  const reset = () => fsp.writeFile(file, JSON.stringify({ ...review, article_id: withBody.id }));
  const write = answer => writeSummaries({ articles: [withBody], reviewDir, writer, apiKey: 'AIza-test', policyWording: wording,
    fetchImpl: async () => gemini([answer]), sleep: async () => {}, log: () => {}, attempts: 1 });
  const rich = { ...good,
    summary_en: 'Acme priced EUR 500 million of senior notes to fund a new wafer plant in Dresden, Germany, that Tessaro Engineering will build for a 2028 opening.' };

  await reset();
  const cited = await write({ ...rich, source_quotes: [extra] });
  assert.equal(cited.written, 1);
  const saved = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.deepEqual(saved.decisions[0].summary_quotes, [extra]);
  assert.equal(importReview(withBody, saved)[0].row.ai_summary_en, rich.summary_en);

  // 근거 문장 없이 본문의 이름을 쓰면 이름 검사에 걸린다.
  await reset();
  assert.equal((await write(rich)).rejected.ungrounded_names, 1);
  // 본문에 없는 근거 문장은 받지 않는다.
  await reset();
  assert.equal((await write({ ...rich, source_quotes: ['Tessaro Engineering will build and operate the plant.'] })).rejected.source_quote_not_in_article, 1);
  // 보고서 가져오기도 같은 기준이다. 저장된 근거 문장이 본문에 없으면 승인 후보를 가져오지 않는다.
  const forged = { ...saved, decisions: [{ ...saved.decisions[0], summary_quotes: ['Tessaro Engineering will operate the plant.'] }] };
  assert.throws(() => importReview(withBody, forged), /summary_quotes must be exact passages/);
});

// 판정 인용과 멀리 떨어진 근거 문장도 본문에 있으면 받는다. 한때 거리로 막았으나 근거로 삼은 3M 사례를 잘못 읽었고
// 맞게 쓴 Evonik 카드를 떨어뜨렸다. 다른 사안을 잇는지는 검토 단계가 본다.
test('a source quote is accepted anywhere in the article body', () => {
  const footnote = 'Guidance does not yet reflect the acquisition of Tessaro Engineering, which closed on July 1, 2026.';
  const far = groupArticles([{ ...row, content_text: `${footnote} ${'Segment detail follows. '.repeat(200)}${quote} ${TAIL}` }], [],
    { from_date: '2026-08-01', to_date: '2026-08-31' })[0];
  assert.deepEqual(summaryQuoteProblems(far, { ...judge, summary_quotes: [footnote] }), []);
  assert.deepEqual(summaryQuoteProblems(far, { ...judge, summary_quotes: ['Tessaro Engineering closed the deal.'] }), ['not_in_article']);
});

// Issue 3 Veolia: "11억 5천만 유로"의 천을 읽지 못해 "11억 5"만 읽혔고 맞게 옮긴 카드가 빠졌다.
test('a Korean amount written with 천 is read in full', () => {
  const source = ['a two-tranche transaction totaling € 1.15 billion: a 4-year bond for 650 million euros and an 8-year bond for 500 million euros'];
  assert.deepEqual(summaryNumberProblems('총 11억 5천만 유로 규모 채권을 발행했음', source, 'ko'), []);
  assert.deepEqual(summaryNumberProblems('6억 5천만 유로와 5억 유로', source, 'ko'), []);
  assert.deepEqual(summaryNumberProblems('총 11억 6천만 유로', source, 'ko'), ['11억 6천만 유로']);
});

// 9월 29일 실행 Amkor 한국어 문안이 "…회동하고 있음음음"으로 끝났다.
test('Korean copy with a syllable repeated three times is rejected as garbled', async () => {
  const ws = await workspace();
  const stats = await run(ws, async () => gemini([{ ...good, summary_ko: good.summary_ko.replace(/음\.$/, '음음음') }]));
  assert.equal(stats.rejected.garbled_korean, 1);
});

test('written copy is saved into the judgement and reused without another request', async () => {
  const ws = await workspace();
  let calls = 0;
  const stats = await run(ws, async () => { calls += 1; return gemini([good]); });
  assert.equal(calls, 1);
  assert.equal(stats.written, 1);
  assert.deepEqual(stats.failed, []);
  const saved = await ws.read();
  assert.equal(saved.decisions[0].summary_ko, good.summary_ko);
  assert.equal(saved.decisions[0].summary_writer.model, 'gemini-3.5-flash-lite');
  assert.equal('summary_failed' in saved, false);
  assert.equal(importReview(article, saved)[0].row.ai_summary_en, good.summary_en);
  const again = await run(ws, async () => { calls += 1; return gemini([good]); });
  assert.equal(calls, 1);
  assert.equal(again.requests, 0);
  assert.equal(again.cached, 1);
});

test('copy that fails a check is written again with the failed check named, and the clean answer is kept', async () => {
  const ws = await workspace();
  const wrong = { ...good, summary_en: 'Acme priced EUR 800 million of senior notes to fund a new wafer plant in Dresden, Germany.' };
  const bodies = [];
  const stats = await run(ws, async (url, init) => { bodies.push(bodyText(init)); return gemini([bodies.length === 1 ? wrong : good]); });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].includes('rejected_because'), false);
  assert.match(bodies[1], /rejected_because/);
  assert.match(bodies[1], /ungrounded_numbers/);
  assert.equal(stats.written, 1);
  assert.deepEqual(stats.failed, []);
  assert.equal((await ws.read()).decisions[0].summary_en, good.summary_en);
});

test('copy that never passes leaves the signal out of this report, keeps it for the dashboard, and is tried again next run', async () => {
  const ws = await workspace();
  const wrong = { ...good, summary_en: 'Acme priced EUR 800 million of senior notes to fund a new wafer plant in Dresden, Germany.' };
  const models = [];
  const stats = await run(ws, async url => { models.push(String(url).match(/models\/([^:]+)/)[1]); return gemini([wrong]); });
  // 세 번 써 본 뒤 포기한다.
  assert.deepEqual(models, Array(WRITER_ATTEMPTS).fill('gemini-3.5-flash-lite'));
  assert.equal(stats.failed.length, 1);
  assert.equal(stats.rejected.ungrounded_numbers, 1);
  const saved = await ws.read();
  assert.equal(saved.decisions[0].summary_en, '');
  assert.deepEqual(saved.summary_failed.candidate_ids, ['investment:3']);
  // 근거 없는 문안을 싣지 않는다. 판정은 살아 있으므로 대시보드용 행으로 남는다.
  const [result] = importReview(article, saved);
  assert.equal(result.supported, false);
  assert.equal(result.near_miss, true);
  assert.equal(result.row.ai_signal_supported, false);
  // 다음 실행은 다시 쓴다. 통과하면 실패 표시가 지워지고 보고서에 실린다.
  const retry = await run(ws, async () => gemini([good]));
  assert.equal(retry.written, 1);
  const fixed = await ws.read();
  assert.equal('summary_failed' in fixed, false);
  assert.equal(importReview(article, fixed)[0].supported, true);
});

test('a missing Korean headline, an English headline or Hangul in English is rejected', async () => {
  const cases = [
    [{ ...good, summary_ko: 'Acme는 5억 유로 규모의 선순위채를 발행했음.' }, 'korean_headline_missing'],
    [{ ...good, summary_en: 'Plant Funding - ' + good.summary_en }, 'english_headline'],
    [{ ...good, summary_en: good.summary_en.replace('Dresden', 'Dresden(드레스덴)') }, 'hangul_in_english'],
  ];
  for (const [answer, problem] of cases) {
    const ws = await workspace();
    const stats = await run(ws, async () => gemini([answer]));
    assert.equal(stats.rejected[problem], 1, problem);
  }
});

test('a near-miss business row gets copy too, so it can fill the business box', async () => {
  const business = { ...row, url: 'https://example.com/plant', title: 'Acme opens plant', investment_signal_no: undefined,
    investment_signal_label_en: undefined };
  const withBusiness = groupArticles([], [business], { from_date: '2026-08-01', to_date: '2026-08-31' })[0];
  // 품목 연계만 모자란 사업동향 판정은 근접 후보다.
  const decision = { candidate_id: 'relevant', entity_supported: true, target_technology_supported: false, indicator_supported: true,
    leading_indicator_supported: true, event_stage: 'not_applicable', quality: 'pass', reason: 'Plant funding.', evidence_quotes: [quote] };
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'writer-business-'));
  const reviewDir = path.join(root, 'reviews');
  await fsp.mkdir(reviewDir);
  const file = path.join(reviewDir, `${withBusiness.id}.json`);
  await fsp.writeFile(file, JSON.stringify({ article_id: withBusiness.id, reviewer: 'gemini/test', provider: 'gemini', decisions: [decision] }));
  const prose = { candidate_id: 'relevant', summary_en: good.summary_en,
    summary_ko: 'Acme는 독일 Dresden 신규 웨이퍼 공장 건설 자금을 마련하기 위해 5억 유로 규모의 선순위채를 발행했음.' };
  const stats = await writeSummaries({ articles: [withBusiness], reviewDir, writer, apiKey: 'AIza-test', policyWording: wording,
    fetchImpl: async () => gemini([prose]), sleep: async () => {}, log: () => {} });
  assert.equal(stats.written, 1);
  const [result] = importReview(withBusiness, JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.equal(result.near_miss, true);
  assert.equal(result.row.ai_summary_ko, prose.summary_ko);
});

const modelOf = url => String(url).match(/models\/([^:]+)/)[1];
const quota = () => new Response('{"error":{"message":"quota"}}', { status: 429 });

test('a quota or a repeated outage stops the run without marking failures', async () => {
  const ws = await workspace();
  let calls = 0;
  const stats = await run(ws, async () => { calls += 1; return quota(); });
  assert.equal(calls, 1);
  assert.deepEqual(stats.stopped, { reason: 'quota', http_status: 429 });
  const saved = await ws.read();
  // 다 쓰지 못한 후보는 실패가 아니라 미완료다. 다음 실행이 이어서 쓴다. 문안이 없으므로 보고서는 만들 수 없다.
  assert.equal('summary_failed' in saved, false);
  assert.throws(() => importReview(article, saved), /missing ai_summary_ko/);
  const ws2 = await workspace();
  let tries = 0;
  const timeout = await run(ws2, async () => { tries += 1; throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); });
  // 일시 장애는 두 번 더 기다려 본 뒤 멈춘다.
  assert.equal(tries, 3);
  assert.equal(timeout.stopped.reason, 'timeout');
});

// Issue 4(10월 1일 실행)는 문안 100여 건을 한 건씩 응답을 기다리며 써서 오래 걸렸다.
test('articles are written four at a time while request starts stay spaced by the delay', async () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({ ...row, url: `https://example.com/notes-${index}`, title: `Acme prices notes ${index}` }));
  const articles = groupArticles(rows, [], { from_date: '2026-08-01', to_date: '2026-08-31' });
  assert.equal(articles.length, 6);
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'writer-pool-'));
  const reviewDir = path.join(root, 'reviews');
  await fsp.mkdir(reviewDir);
  for (const item of articles) {
    await fsp.writeFile(path.join(reviewDir, `${item.id}.json`), JSON.stringify({ ...review, article_id: item.id }));
  }
  let inFlight = 0, peak = 0;
  const waits = [];
  const stats = await writeSummaries({ articles, reviewDir, writer: { ...writer, delayMs: 4500, concurrency: 4 }, apiKey: 'AIza-test',
    policyWording: wording, sleep: async ms => { waits.push(ms); }, log: () => {},
    fetchImpl: async () => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 20));
      inFlight -= 1;
      return gemini([good]);
    } });
  assert.equal(stats.written, 6);
  assert.equal(peak, 4);
  // 첫 요청을 뺀 다섯 요청이 앞 요청 시작에서 간격만큼 뒤에 나가도록 기다린다.
  assert.equal(waits.filter(ms => ms > 0).length, 5);
});

test('the summary stage uses its own key when one is set', () => {
  assert.equal(summaryApiKey({ GEMINI_FOR_SUMMARY: ' AIza-summary ', GEMINI_API_KEY: 'AIza-judge' }), 'AIza-summary');
  assert.equal(summaryApiKey({ GEMINI_FOR_SUMMARY: '', GEMINI_API_KEY: 'AIza-judge' }), 'AIza-judge');
  assert.equal(summaryApiKey({}), '');
});

test('publish takes over only a finished judgement for the same dates', () => {
  const period = { from_date: '2026-08-01', to_date: '2026-08-31' };
  const judged = { stage: 'judgement', judged: true, status: 'completed', period, run_dir: '2026-08-abc', issue_number: '3' };
  assert.equal(judgementFor(judged, period), judged);
  assert.throws(() => judgementFor(null, period), /No judgement for 2026-08-01\.\.2026-08-31/);
  assert.throws(() => judgementFor({ ...judged, period: { from_date: '2026-07-01', to_date: '2026-07-31' } }, period), /No judgement/);
  assert.throws(() => judgementFor({ ...judged, judged: false, status: 'paused', reason: 'quota', completed: 200, total: 380 }, period),
    /not finished \(paused: 200\/380 articles, quota\)/);
  // 호수는 이 단계의 입력이 우선이고, 비어 있으면 판정 단계에서 받은 값을 쓴다.
  assert.equal(issueNumberFor('4', judged), '4');
  assert.equal(issueNumberFor('', judged), '3');
  assert.equal(issueNumberFor('', {}), '2');
});

// ---- Issue 3(9월 28일 실행) 검토에서 나온 세 가지 ----

test('copy that invents a year is sent back, and so is cached copy that no longer passes the checks', async () => {
  const ws = await workspace();
  const invented = { ...good, summary_en: 'Acme priced EUR 500 million of senior notes in 2015 to fund a new wafer plant in Dresden, Germany.' };
  const bodies = [];
  await run(ws, async (url, init) => { bodies.push(bodyText(init)); return gemini([bodies.length === 1 ? invented : good]); });
  assert.equal(bodies.length, 2);
  assert.match(bodies[1], /ungrounded_dates:2015/);
  // 예전 검사로 통과해 저장된 문안도, 지금 검사에 걸리면 다시 쓴다.
  const saved = await ws.read();
  await fsp.writeFile(path.join(ws.reviewDir, `${article.id}.json`), JSON.stringify({ ...saved,
    decisions: saved.decisions.map(decision => ({ ...decision, summary_en: invented.summary_en })) }));
  let calls = 0;
  const again = await run(ws, async () => { calls += 1; return gemini([good]); });
  assert.equal(calls, 1);
  assert.equal(again.cached, 0);
  assert.equal((await ws.read()).decisions[0].summary_en, good.summary_en);
});

test('an amount written as $1.4B in the source grounds $1.4 billion in the copy', () => {
  const source = ['Additive ~$1.4B debt issued; $0.7B cash to 3M; ~$450M sales'];
  assert.deepEqual(summaryNumberProblems('3M issued about $1.4 billion of debt and received $0.7 billion in cash.', source, 'en'), []);
  assert.deepEqual(summaryNumberProblems('3M는 약 14억 달러의 부채를 발행했음.', source, 'ko'), []);
  assert.deepEqual(summaryNumberProblems('Sales of about $450 million.', source, 'en'), []);
  assert.deepEqual(summaryNumberProblems('3M issued about $2.4 billion of debt.', source, 'en'), ['$2.4 billion']);
});

// Issue 3 Veolia: 프랑스어 원문 "1,15 Md €"를 읽지 못해 맞게 옮긴 문안이 근거 없음으로 떨어졌다.
test('a French amount with a decimal comma and Md grounds the translated amount', () => {
  const source = ['26 août 2026 Veolia émet avec succès 1,15 Md € sur le marché obligataire'];
  assert.deepEqual(summaryNumberProblems('채권 발행 - 11억 5000만 유로 규모의 채권을 발행했음.', source, 'ko'), []);
  assert.deepEqual(summaryNumberProblems('Veolia issued EUR 1.15 billion of bonds.', source, 'en'), []);
  assert.deepEqual(summaryNumberProblems('Veolia issued EUR 1.5 billion of bonds.', source, 'en'), ['EUR 1.5 billion']);
  assert.deepEqual(summaryNumberProblems('Siemens Energy raised EUR 2.4 billion.', ['Kapitalerhöhung über 2,4 Mrd. Euro'], 'en'), []);
  // 쉼표 뒤가 세 자리면 여전히 천 단위 구분이다.
  assert.deepEqual(summaryNumberProblems('Orders reached 3,349 MW.', ['Orders reached 3,349 MW.'], 'en'), []);
  assert.deepEqual(summaryNumberProblems('Orders reached 3.349 MW.', ['Orders reached 3,349 MW.'], 'en'), ['3.349']);
});
