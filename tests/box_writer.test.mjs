import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { groupArticles, loadBoxCopy } from '../scripts/local_report.mjs';
import { resolveWriter, writerPolicySection } from '../scripts/summary_writer.mjs';
import { boxCopyTargets, boxProblems, boxRequest, repeatsSignal, writeBoxCopy } from '../scripts/box_writer.mjs';
import { reportEligible } from '../scripts/date_state.mjs';

// 위 지표 칸 말고는 실을 사업동향 문안이 없는 기업의 상자 문안(2026-10-22 사용자 요청).
const doc = fs.readFileSync(new URL('../docs/local_report_review.md', import.meta.url), 'utf8');
const wording = writerPolicySection(doc);
const quote = 'Acme priced EUR 500 million of senior notes to fund a new wafer plant in Dresden, Germany.';
const tail = 'The plant will make silicon carbide power wafers for electric vehicle inverters, and Acme expects to hire 400 people at the site.';
const period = { from_date: '2026-08-01', to_date: '2026-08-31' };
const row = { company: 'Acme', target_no: 1, title: 'Acme prices senior notes', url: 'https://example.com/notes',
  published_at: '2026-08-11', content_text: `${quote} ${tail}`, target_technology: 'wafer', target_technology_en: 'wafer',
  investment_signal_no: 3, investment_signal_label_en: 'Capital Raising & Financing' };
const article = groupArticles([row], [], period)[0];
const signal = {
  candidate_id: 'investment:3', entity_supported: true, target_technology_supported: true, indicator_supported: true,
  leading_indicator_supported: true, event_stage: 'precursor', quality: 'pass', reason: 'New notes fund a new plant.',
  evidence_quotes: [quote],
  summary_en: 'Acme priced EUR 500 million of senior notes to fund a new wafer plant in Dresden, Germany.',
  summary_ko: '독일 신규 웨이퍼 공장 건설 자금 조달 - Acme는 독일 Dresden 신규 웨이퍼 공장 건설 자금을 마련하기 위해 5억 유로 규모의 선순위채를 발행했음.',
};
const review = { article_id: article.id, reviewer: 'gemini/test', provider: 'gemini', decisions: [signal] };
const fresh = {
  source_quotes: [tail],
  summary_en: 'The Dresden plant will make silicon carbide power wafers for electric vehicle inverters, and Acme expects to hire 400 people there.',
  summary_ko: 'Dresden 공장은 전기차 인버터용 탄화규소 전력 웨이퍼를 생산할 예정이며, Acme는 현지에서 400명을 채용할 계획임.',
};
const writer = { ...resolveWriter({}), delayMs: 0 };
const gemini = answer => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP',
  content: { parts: [{ text: JSON.stringify(answer) }] } }] }));

async function workspace(reviews = [review]) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'box-'));
  const reviewDir = path.join(root, 'reviews');
  await fsp.mkdir(reviewDir);
  for (const item of reviews) await fsp.writeFile(path.join(reviewDir, `${item.article_id}.json`), JSON.stringify(item));
  return { root, reviewDir, boxDir: path.join(root, 'box_copy') };
}
const run = (ws, fetchImpl, articles = [article]) => writeBoxCopy({ articles, reviewDir: ws.reviewDir, boxDir: ws.boxDir,
  writer, apiKey: 'AIza-test', policyWording: wording, fetchImpl, sleep: async () => {} });

test('only companies with no business copy of their own get a box copy', () => {
  assert.equal(boxCopyTargets([article], new Map([[article.id, review]])).length, 1);
  const business = { ...row, url: 'https://example.com/plant', title: 'Acme opens a wafer line' };
  delete business.investment_signal_no;
  const other = groupArticles([], [business], period)[0];
  const decision = { candidate_id: other.candidates[0].id, entity_supported: true, target_technology_supported: true,
    indicator_supported: true, leading_indicator_supported: true, event_stage: 'not_applicable', quality: 'pass',
    reason: 'A new line.', evidence_quotes: [quote], summary_en: 'Acme opened a wafer line.', summary_ko: 'Acme는 웨이퍼 라인을 열었음.' };
  const reviews = new Map([[article.id, review], [other.id, { article_id: other.id, reviewer: 'gemini/test', decisions: [decision] }]]);
  assert.deepEqual(boxCopyTargets([article, other], reviews), []);
});

// 4호 재발행의 Corning: 다른 사업동향 기사(Verizon·AT&T 계약)에 문안은 있었지만 게시월이 추정뿐이라 보고서에서
// 빠졌다. 그 기사를 문안이 있는 것으로 세면 상자 문안을 받지 못하고 위 지표 칸을 되풀이한다.
test('a business article the report holds back for its date does not count as business copy', () => {
  const business = { ...row, url: 'https://example.com/2026/08/plant', title: 'Acme opens a wafer line' };
  delete business.investment_signal_no;
  delete business.published_at;
  const other = groupArticles([], [business], period)[0];
  assert.equal(reportEligible(other.candidates[0].row, period), false, 'fixture must be held back for its date');
  const decision = { candidate_id: other.candidates[0].id, entity_supported: true, target_technology_supported: true,
    indicator_supported: true, leading_indicator_supported: true, event_stage: 'not_applicable', quality: 'pass',
    reason: 'A new line.', evidence_quotes: [quote], summary_en: 'Acme opened a wafer line.', summary_ko: 'Acme는 웨이퍼 라인을 열었음.' };
  const reviews = new Map([[article.id, review], [other.id, { article_id: other.id, reviewer: 'gemini/test', decisions: [decision] }]]);
  assert.deepEqual(boxCopyTargets([article, other], reviews).map(target => target.article.id), [article.id]);
});

test('the request shows what the signal card already says and asks for the rest of the article', () => {
  const request = boxRequest(article, [signal]);
  assert.deepEqual(request.already_said, [signal.summary_en]);
  assert.deepEqual(request.signal_quotes, [quote]);
  assert.ok(request.article_evidence.includes(tail));
});

test('copy that restates the signal card, or has no source passage, is rejected', () => {
  assert.equal(repeatsSignal(signal.summary_en, [signal.summary_en]), true);
  assert.equal(repeatsSignal(fresh.summary_en, [signal.summary_en]), false);
  assert.deepEqual(boxProblems(article, fresh, [signal.summary_en]), []);
  assert.ok(boxProblems(article, { ...fresh, summary_en: signal.summary_en }, [signal.summary_en]).includes('repeats_signal'));
  assert.ok(boxProblems(article, { ...fresh, source_quotes: [] }, [signal.summary_en]).includes('source_quotes_missing'));
  assert.ok(boxProblems(article, { ...fresh, source_quotes: ['Acme will build a fab on the moon.'] }, [signal.summary_en])
    .some(problem => problem.startsWith('source_quote_')));
  // 둘 다 비면 쓸 내용이 없다는 답이다.
  assert.deepEqual(boxProblems(article, { summary_en: '', summary_ko: '', source_quotes: [] }, [signal.summary_en]), []);
});

test('box copy is saved apart from the judgement, loaded for the build, and reused without another request', async () => {
  const ws = await workspace();
  let calls = 0;
  const stats = await run(ws, async () => { calls += 1; return gemini(fresh); });
  assert.equal(stats.written, 1);
  assert.equal(calls, 1);
  const saved = JSON.parse(await fsp.readFile(path.join(ws.boxDir, `${article.id}.json`), 'utf8'));
  assert.deepEqual(saved.candidate_ids, ['investment:3']);
  // 판정 파일은 그대로다.
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(ws.reviewDir, `${article.id}.json`), 'utf8')), review);
  const copies = await loadBoxCopy(ws.boxDir, [{ article_id: article.id }]);
  assert.equal(copies.get(article.id).summary_en, fresh.summary_en);
  const again = await run(ws, async () => { calls += 1; return gemini(fresh); });
  assert.equal(again.cached, 1);
  assert.equal(calls, 1);
});

test('a repeat is sent back once with the reason, and an article with nothing new is remembered as such', async () => {
  const ws = await workspace();
  const bodies = [];
  const answers = [{ ...fresh, summary_en: signal.summary_en }, fresh];
  await run(ws, async (url, init) => { bodies.push(JSON.parse(JSON.parse(init.body).contents[0].parts[0].text)); return gemini(answers.shift()); });
  assert.equal(bodies.length, 2);
  assert.match(bodies[1].rejected_because.join(' '), /restates already_said/);

  const empty = await workspace();
  const stats = await run(empty, async () => gemini({ source_quotes: [], summary_en: '', summary_ko: '' }));
  assert.equal(stats.nothing_new, 1);
  assert.equal((await loadBoxCopy(empty.boxDir, [{ article_id: article.id }])).size, 0);
});

test('a quota stop leaves no file and does not count as a failure', async () => {
  const ws = await workspace();
  const stats = await run(ws, async () => new Response('{}', { status: 429 }));
  assert.equal(stats.stopped?.reason, 'quota');
  assert.deepEqual(stats.failed, []);
  assert.equal(fs.existsSync(path.join(ws.boxDir, `${article.id}.json`)), false);
});
