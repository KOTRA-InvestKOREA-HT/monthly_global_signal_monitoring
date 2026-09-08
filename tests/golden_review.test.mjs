import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { groupArticles } from '../scripts/local_report.mjs';
import { MODEL } from '../scripts/review_report.mjs';
import { selectGoldenArticles, compareArticle, assertIsolatedOutDir, runGolden } from '../scripts/golden_review.mjs';

const period = { from_date: '2026-08-01', to_date: '2026-08-31' };
const source = (company, url) => ({ target_no: 1, company, url, title: `${company} plans a pilot`,
  published_at: '2026-08-10T00:00:00Z', target_technology: 'target material', investment_signal_no: 2,
  content_text: `${company} is considering a new pilot plant for its target material.` });
const build = (rows, policy) => groupArticles(rows, [], period, policy);
const decision = (article, overrides = {}) => ({ candidate_id: 'investment:2',
  entity_supported: true, target_technology_supported: true, indicator_supported: true,
  leading_indicator_supported: true, event_stage: 'planned', quality: 'pass',
  reason_ko: '타겟 소재의 생산시설 검토가 본문에 명시됨', evidence_quotes: [article.candidates[0].row.content_text],
  summary_ko: '타겟 소재 파일럿 시설 검토', summary_en: 'Target-material pilot plant under consideration', ...overrides });
const review = (article, overrides = {}) => ({ article_id: article.id, reviewer: `${MODEL}/article-review-v1`,
  provider: 'nvidia', decisions: [decision(article, overrides)] });
const apiResponse = (article, overrides = {}) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop',
  message: { content: JSON.stringify({ decisions: [decision(article, overrides)], published_date: '', published_date_quote: '' }) } }], usage: {} }));

test('the golden list selects exactly its own articles and refuses to run short', () => {
  const articles = build(['Alpha', 'Beta', 'Gamma'].map(c => source(c, `https://example.com/${c}`)), 'new-policy');
  const golden = { articles: [{ company: 'Gamma', url: 'https://example.com/Gamma' }, { company: 'Alpha', url: 'https://example.com/Alpha' }] };
  const { selected, missing } = selectGoldenArticles(articles, golden);
  assert.deepEqual(selected.map(a => a.company), ['Gamma', 'Alpha']);
  assert.deepEqual(missing, []);
  // 골든 항목이 수집분에 없으면 조용히 빠지지 않고 드러나야 한다. 비교가 통째로 어긋난다.
  const short = selectGoldenArticles(articles, { articles: [{ company: 'Delta', url: 'https://example.com/Delta' }] });
  assert.deepEqual(short.missing, [{ company: 'Delta', url: 'https://example.com/Delta' }]);
  assert.deepEqual(short.selected, []);
});

test('a golden run calls the API once per selected article and for nobody else', async t => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'golden-'));
  t.after(() => fs.rm(outDir, { recursive: true, force: true }));
  const all = build(['Alpha', 'Beta', 'Gamma'].map(c => source(c, `https://example.com/${c}`)), 'new-policy');
  const selected = all.slice(0, 2);
  const asked = [];
  const state = await runGolden({ articles: selected, outDir, policyText: 'criteria',
    config: { apiKey: 'k', maxRequests: 40, delayMs: 0, concurrency: 1 }, sleep: async () => {},
    fetchImpl: async (url, init) => {
      const article = JSON.parse(JSON.parse(init.body).messages[1].content);
      asked.push(article.company);
      return apiResponse(all.find(a => a.company === article.company));
    } });
  assert.equal(state.status, 'completed');
  assert.deepEqual(asked.sort(), ['Alpha', 'Beta']);
  assert.equal(state.requests, 2);
  // 결과는 골든 디렉터리 안에만 쌓인다.
  assert.deepEqual((await fs.readdir(path.join(outDir, 'reviews'))).sort(),
    selected.map(a => `${a.id}.json`).sort());
});

test('a golden run leaves production outputs and the operational review cache untouched', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'golden-isolation-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const productionReviews = path.join(temp, 'outputs', 'review_work', 'reviews');
  await fs.mkdir(productionReviews, { recursive: true });
  const latest = path.join(temp, 'outputs', 'latest_investment_signals.json');
  await fs.writeFile(latest, '[{"company":"Alpha"}]');
  const article = build([source('Alpha', 'https://example.com/Alpha')], 'new-policy')[0];
  // 운영 캐시에는 옛 정책으로 저장된 판정이 들어 있다.
  const stale = build([source('Alpha', 'https://example.com/Alpha')], 'old-policy')[0];
  const staleFile = path.join(productionReviews, `${stale.id}.json`);
  const staleBody = JSON.stringify(review(stale));
  await fs.writeFile(staleFile, staleBody);
  const outDir = path.join(temp, 'outputs', 'golden_eval');
  let calls = 0;
  await runGolden({ articles: [article], outDir, policyText: 'criteria',
    config: { apiKey: 'k', maxRequests: 40, delayMs: 0, concurrency: 1 }, sleep: async () => {},
    fetchImpl: async () => { calls++; return apiResponse(article); } });
  // 옛 정책의 판정은 새 정책 기사의 캐시가 아니다. 그대로 두고 새로 호출한다.
  assert.equal(calls, 1);
  assert.equal(await fs.readFile(staleFile, 'utf8'), staleBody);
  assert.deepEqual(await fs.readdir(productionReviews), [`${stale.id}.json`]);
  assert.equal(await fs.readFile(latest, 'utf8'), '[{"company":"Alpha"}]');
  assert.deepEqual((await fs.readdir(path.join(temp, 'outputs'))).sort(),
    ['golden_eval', 'latest_investment_signals.json', 'review_work']);
});

test('the golden out-dir cannot be pointed at the operational review directory', () => {
  assert.throws(() => assertIsolatedOutDir(path.resolve('outputs/review_work')), /operational/i);
  assert.throws(() => assertIsolatedOutDir(path.resolve('outputs/review_work/reviews')), /operational/i);
  assert.throws(() => assertIsolatedOutDir(path.resolve('outputs')), /operational/i);
  assert.doesNotThrow(() => assertIsolatedOutDir(path.resolve('outputs/golden_eval')));
});

test('the comparison names what moved per candidate and flags a new approval', () => {
  const src = source('Alpha', 'https://example.com/Alpha');
  const baselineArticle = build([src], 'old-policy')[0];
  const article = build([src], 'new-policy')[0];
  // 이전에는 기술 연결 실패가 지표까지 끌고 내려가 탈락했다.
  const baselineReview = review(baselineArticle, { target_technology_supported: false, indicator_supported: false });
  const compared = compareArticle({ article, baselineArticle, baselineReview,
    review: review(article, { target_technology_supported: false }), entry: { expect: 'negative' } });
  const row = compared.candidates[0];
  assert.equal(row.candidate_id, 'investment:2');
  assert.equal(row.before.supported, false);
  assert.equal(row.after.supported, false);
  assert.equal(row.before.indicator_supported, false);
  assert.equal(row.after.indicator_supported, true);
  assert.deepEqual(row.changed, ['indicator_supported']);
  assert.equal(row.transition, 'kept_negative');
  // 면제 후보라면 같은 판정이 승인으로 바뀐다. 기대가 negative 였다면 사람이 봐야 한다.
  const exemptSrc = { ...src, excluded_from_relevance: true };
  const exemptBaseline = build([exemptSrc], 'old-policy')[0];
  const exempt = build([exemptSrc], 'new-policy')[0];
  const flagged = compareArticle({ article: exempt, baselineArticle: exemptBaseline,
    baselineReview: review(exemptBaseline, { target_technology_supported: false, indicator_supported: false }),
    review: review(exempt, { target_technology_supported: false }), entry: { expect: 'negative' } });
  assert.equal(flagged.candidates[0].transition, 'newly_approved');
  assert.equal(flagged.candidates[0].needs_adjudication, true);
  // 기대가 positive 였다면 되찾은 것이므로 표시하지 않는다.
  const wanted = compareArticle({ article: exempt, baselineArticle: exemptBaseline,
    baselineReview: review(exemptBaseline, { target_technology_supported: false, indicator_supported: false }),
    review: review(exempt, { target_technology_supported: false }), entry: { expect: 'positive' } });
  assert.equal(wanted.candidates[0].needs_adjudication, false);
});

test('a baseline that no longer validates is reported, not silently treated as a rejection', () => {
  const src = source('Alpha', 'https://example.com/Alpha');
  const baselineArticle = build([src], 'old-policy')[0];
  const article = build([src], 'new-policy')[0];
  const broken = { ...review(baselineArticle), decisions: [] };
  const compared = compareArticle({ article, baselineArticle, baselineReview: broken, review: review(article) });
  assert.equal(compared.baseline_error !== undefined, true);
  assert.equal(compared.candidates[0].before, null);
  assert.equal(compared.candidates[0].transition, 'no_baseline');
  // baseline 이 아예 없는 경우도 같은 방식으로 드러난다.
  const none = compareArticle({ article, baselineArticle: null, baselineReview: null, review: review(article) });
  assert.equal(none.candidates[0].transition, 'no_baseline');
  assert.equal(none.candidates[0].after.supported, true);
});
