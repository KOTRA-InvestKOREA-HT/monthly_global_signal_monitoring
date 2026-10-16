#!/usr/bin/env node
// 판정 기준을 고친 뒤, 운영 302건을 다시 부르지 않고 지정한 소수의 기사만 새 기준으로 판정해
// 이전 판정과 나란히 놓고 본다. 운영 산출물(outputs/latest_*, public/reports)과 운영 판정 캐시
// (outputs/review_work)는 읽기만 하고 쓰지 않는다.
//
// 사용법:
//   node scripts/golden_review.mjs --golden config/golden_articles.json --data-dir outputs \
//     --month 2026-08 [--baseline-snapshot <snapshot.json>] [--baseline-reviews <dir>] \
//     [--out-dir outputs/golden_eval] [--provider nvidia] [--model <id>] [--set dev] \
//     [--allow-missing] [--run]
//
// --run 이 없으면 대상과 예상 요청 수만 계산하고 API 를 호출하지 않는다. 준비 상태를 확인하는 기본값이다.
// 골든 목록(--golden)은 { "articles": [{ "company", "url", "set", "expect": "positive|negative|unknown", "note" }] } 이다.
// company 와 url 로 지정하는 이유는, 판정 기준이 바뀌면 기사 id 가 바뀌기 때문이다. 그 둘은 정책과 무관하다.
//
// --set 은 비교 실험의 개발·검증 분리다. dev 는 이번에 오류를 발견한 기사, holdout 은 그 수정에 쓰지 않은
// 기사다. 둘을 섞어 재면 이번 사례만 맞힌 과적합이 일반화된 개선으로 읽힌다.
// 목록의 기사가 수집본에 없으면 멈춘다. 비교 대상이 말없이 달라지는 것을 막기 위해서다. 링크가 도는
// 뉴스 피드처럼 되살릴 수 없는 기사가 섞이면 --allow-missing 으로 한 번 인정하고 지나간다. 그때 무엇이
// 빠졌는지는 plan.json 과 comparison.json 에 남아, 뒤에 결과를 읽는 사람이 그 사실을 함께 본다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sourceCandidates, groupArticles, importReview, monthPeriod } from './local_report.mjs';
import { PROVIDER, MODEL, VERIFIER, configuration, policySection, reviewPolicy, reviewArticles } from './review_report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const write = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
};

// 후보 하나에 대해 전후로 비교하는 값. 승인 여부와 그 승인을 이루는 필드들이다.
const FIELDS = ['entity_supported', 'target_technology_supported', 'indicator_supported',
  'leading_indicator_supported', 'event_stage', 'quality'];

// 운영 판정 캐시나 운영 산출물 위에 골든 결과를 쓰면, 실험 결과가 운영 결과로 읽힌다.
// outputs 바로 아래나 review_work 안쪽은 거부한다.
export function assertIsolatedOutDir(outDir) {
  const resolved = path.resolve(outDir);
  const operational = path.resolve('outputs', 'review_work');
  const outputs = path.resolve('outputs');
  const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
  if (inside(operational, resolved) || resolved === outputs) {
    throw new Error(`Refusing to write golden results into the operational path ${resolved}`);
  }
}

// 개발용(dev)과 검증용(holdout)을 가른다. set 이 적히지 않은 항목은 holdout 으로 본다. 표시를 잊은
// 기사가 조용히 개발용으로 섞이면, 이번 사례만 맞힌 결과가 일반화된 개선으로 읽힌다.
export const GOLDEN_SETS = ['dev', 'holdout', 'all'];
export function goldenEntries(golden, set = 'all') {
  if (!GOLDEN_SETS.includes(set)) throw new Error(`Unknown set: ${set}. Known: ${GOLDEN_SETS.join(', ')}`);
  const entries = golden.articles || [];
  return set === 'all' ? entries : entries.filter(entry => (entry.set || 'holdout') === set);
}

// 골든 목록은 company 와 url 로 기사를 가리킨다. 하나라도 못 찾으면 비교가 어긋나므로 드러낸다.
export function selectGoldenArticles(articles, golden, set = 'all') {
  const byKey = new Map(articles.map(article => [`${article.company}\u0000${article.url || article.title}`, article]));
  const selected = [], missing = [];
  for (const entry of goldenEntries(golden, set)) {
    const article = byKey.get(`${entry.company}\u0000${entry.url || entry.title}`);
    if (article) selected.push(article); else missing.push(entry);
  }
  return { selected, missing };
}

// 한 기사의 판정을 후보별 값으로 편다. importReview 가 승인 여부를 계산하고, 개별 필드는 판정문에서 읽는다.
function verdicts(article, review) {
  // 판정 호출은 문안을 쓰지 않는다. 판정만 비교한다.
  const results = importReview(article, review, { summaries: false });
  const byId = new Map((review.decisions || []).map(decision => [decision.candidate_id, decision]));
  return new Map(results.map(result => [result.candidate_id, {
    supported: result.supported,
    ...Object.fromEntries(FIELDS.map(field => [field, byId.get(result.candidate_id)?.[field]])),
  }]));
}

export function compareArticle({ article, baselineArticle, baselineReview, review, entry = {} }) {
  let before = null, baselineError;
  if (baselineArticle && baselineReview) {
    // 옛 판정이 지금 계약으로는 통과하지 못할 수 있다. 그것은 "거부됐다"가 아니라 "비교 불가"다.
    try { before = verdicts(baselineArticle, baselineReview); }
    catch (error) { baselineError = error.message; }
  }
  const after = verdicts(article, review);
  const candidates = [...after].map(([candidate_id, now]) => {
    const was = before?.get(candidate_id) ?? null;
    const changed = was ? FIELDS.filter(field => was[field] !== now[field]) : [];
    const transition = !was ? 'no_baseline'
      : was.supported && now.supported ? 'kept_positive'
      : was.supported && !now.supported ? 'lost_positive'
      : !was.supported && now.supported ? 'newly_approved' : 'kept_negative';
    return { candidate_id, kind: article.candidates.find(c => c.id === candidate_id)?.kind,
      before: was, after: now, changed, transition,
      // 새로 승인된 후보가 옳은지는 자동으로 알 수 없다. 기대가 negative 였다면 사람이 봐야 한다.
      needs_adjudication: transition === 'newly_approved' && entry.expect !== 'positive' };
  });
  return { article_id: article.id, baseline_article_id: baselineArticle?.id ?? null,
    company: article.company, url: article.url, expect: entry.expect ?? 'unknown',
    ...(baselineError ? { baseline_error: baselineError } : {}), candidates };
}

// 판정 자체는 운영과 같은 경로를 쓴다. 다른 것은 어디에 저장하느냐뿐이다.
export async function runGolden({ articles, outDir, policyText, config, fetchImpl, sleep }) {
  assertIsolatedOutDir(outDir);
  return reviewArticles({ articles, reviewDir: path.join(outDir, 'reviews'), policy: policyText, config,
    ...(fetchImpl ? { fetchImpl } : {}), ...(sleep ? { sleep } : {}) });
}

// 계획 단계에서 보여 주는 요청 수. 예전에는 1차 판정만 세어(기사당 1건, 최악 2건) 2차 검증과 재검토 되묻기가 빠졌다.
// 검증기가 켜져 있으면 1차 판정 뒤 의심 후보가 있는 기사마다 검증 요청이 나간다. 면제가 아닌 기술 연결 승인은 늘 의심
// 후보라 기사당 1건으로 잡는다. 최악은 기사당 1차 판정과 그 재시도 2건에, 검증과 거부된 검증 응답의 보정 2건이다.
// 검증기가 꺼져 있으면 재시도 뒤에 재검토 되묻기 1건이 더 붙을 수 있다(3건). 일시 장애 재시도는 세지 않는다.
export function requestEstimate(articleCount, { verifier = false } = {}) {
  return { expected_requests: articleCount * (verifier ? 2 : 1), worst_case_requests: articleCount * (verifier ? 4 : 3) };
}

// 재시도와 검증 실패는 진단 파일에 기사별로 남는다. 요약에서 세어 둔다.
function attempts(state) {
  const counts = {};
  for (const item of state.diagnostics || []) {
    counts[item.article_id] ??= { validation_failures: 0, attempts: 0 };
    counts[item.article_id].validation_failures += 1;
    counts[item.article_id].attempts = Math.max(counts[item.article_id].attempts, item.attempt);
  }
  return counts;
}

function parseArgs(argv) {
  const args = { outDir: 'outputs/golden_eval', dataDir: 'outputs', golden: 'config/golden_articles.json', set: 'all' };
  const options = new Set(['golden', 'data-dir', 'month', 'baseline-snapshot', 'baseline-reviews', 'out-dir', 'provider', 'model', 'set']);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--run') { args.run = true; continue; }
    if (argv[i] === '--allow-missing') { args.allowMissing = true; continue; }
    const key = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !options.has(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error(`Invalid option: ${argv[i]}`);
    }
    args[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // 프로바이더와 모델은 판정 캐시 식별자에 들어간다. 골든과 운영이 다른 모델을 쓰면 비교가 무의미하므로,
  // 값을 여기서 바꾸지 않고 요청한 값과 다르면 멈춘다. 바꾸는 곳은 REPORT_PROVIDER 와 <PROVIDER>_MODEL 이다.
  if (args.provider && args.provider !== PROVIDER.id) {
    throw new Error(`Requested provider ${args.provider} but REPORT_PROVIDER resolves to ${PROVIDER.id}`);
  }
  if (args.model && args.model !== MODEL) {
    throw new Error(`Requested model ${args.model} but ${PROVIDER.id.toUpperCase()}_MODEL resolves to ${MODEL}`);
  }
  const outDir = path.resolve(args.outDir);
  assertIsolatedOutDir(outDir);

  const dataDir = path.resolve(args.dataDir);
  const [summary, signals, technology, indicators, policyDoc, golden] = await Promise.all([
    read(path.join(dataDir, 'latest_collection_summary.json')), read(path.join(dataDir, 'latest_company_signals.json')),
    read(path.join(ROOT, 'data/company_technology_map.json')), read(path.join(ROOT, 'config/investment_signal_indicators.json')),
    fs.readFile(path.join(ROOT, 'docs/local_report_review.md'), 'utf8'), read(path.resolve(args.golden)),
  ]);
  const period = monthPeriod(args.month || summary.from_date?.slice(0, 7));
  const policyText = policySection(policyDoc);
  // 운영(review_report.mjs main)과 같은 인자로 부른다. 그래야 같은 기사 id 를 얻는다.
  const policy = reviewPolicy({ policyText });
  const candidates = sourceCandidates(signals, technology, indicators, period);
  const articles = groupArticles(candidates.investment, candidates.relevant, period, policy);
  const { selected, missing } = selectGoldenArticles(articles, golden, args.set);
  const absent = missing.map(entry => `${entry.company} ${entry.url}`);
  if (missing.length && !args.allowMissing) {
    throw new Error(`Golden articles not present in this collection: ${JSON.stringify(absent)}. `
      + 'Collect again, or pass --allow-missing to compare the rest and record these as absent.');
  }
  if (!selected.length) throw new Error(`No golden articles in set ${args.set} of ${args.golden}`);

  // 옛 판정은 옛 기사 id 로 저장돼 있다. 그 id 는 옛 스냅샷에만 있으므로 company·url 로 다시 잇는다.
  const baselineArticles = args.baselineSnapshot ? (await read(path.resolve(args.baselineSnapshot))).articles : [];
  const baselineByKey = new Map(baselineArticles.map(a => [`${a.company}\u0000${a.url || a.title}`, a]));
  const baselineDir = args.baselineReviews ? path.resolve(args.baselineReviews) : null;
  const baselines = new Map();
  for (const article of selected) {
    const old = baselineByKey.get(`${article.company}\u0000${article.url || article.title}`);
    if (!old || !baselineDir) continue;
    try { baselines.set(article.id, { article: old, review: await read(path.join(baselineDir, `${old.id}.json`)) }); }
    catch { /* 옛 판정이 없는 기사는 baseline 없음으로 남는다 */ }
  }

  // 운영(configuration)과 같은 조건으로 검증기가 켜지는지 본다. 키 값은 계획에 남기지 않는다.
  const verifier = Boolean(VERIFIER) && process.env.GEMINI_FREE_TIER_CONFIRMED === 'true' && Boolean(String(process.env.GEMINI_API_KEY || '').trim());
  const plan = { provider: PROVIDER.id, model: MODEL, set: args.set,
    policy, out_dir: outDir, period,
    golden_articles: selected.length,
    ...(absent.length ? { missing_articles: absent } : {}),
    candidates: selected.reduce((n, a) => n + a.candidates.length, 0),
    with_baseline: baselines.size,
    verifier_model: verifier ? VERIFIER.model : null,
    ...requestEstimate(selected.length, { verifier }),
    articles: selected.map(a => ({ id: a.id, company: a.company, url: a.url,
      baseline_article_id: baselines.get(a.id)?.article.id ?? null })) };
  await write(path.join(outDir, 'plan.json'), plan);
  if (!args.run) {
    console.log(JSON.stringify({ ...plan, status: 'planned', note: 'Add --run to call the API.' }, null, 2));
    return;
  }

  const config = configuration();
  const state = await runGolden({ articles: selected, outDir, policyText, config });
  const retries = attempts(state);
  const comparisons = [];
  for (const article of selected) {
    const entry = (golden.articles || []).find(e => e.company === article.company && (e.url || e.title) === (article.url || article.title)) || {};
    let review = null;
    try { review = await read(path.join(outDir, 'reviews', `${article.id}.json`)); } catch { continue; }
    const baseline = baselines.get(article.id);
    comparisons.push({ ...compareArticle({ article, baselineArticle: baseline?.article ?? null,
      baselineReview: baseline?.review ?? null, review, entry }),
      set: entry.set || 'holdout', evidence: article.evidence || [], ...(retries[article.id] || {}) });
  }
  const rows = comparisons.flatMap(item => item.candidates);
  const count = name => rows.filter(row => row.transition === name).length;
  const report = { ...plan, status: state.status, requests: state.requests, completed: state.completed,
    failed_articles: state.failed_articles, reviewed_articles: comparisons.length,
    summary: { candidates: rows.length, kept_positive: count('kept_positive'), lost_positive: count('lost_positive'),
      newly_approved: count('newly_approved'), kept_negative: count('kept_negative'), no_baseline: count('no_baseline'),
      needs_adjudication: rows.filter(row => row.needs_adjudication).length,
      validation_failures: (state.diagnostics || []).length },
    comparisons };
  await write(path.join(outDir, 'comparison.json'), report);
  console.log(JSON.stringify({ ...report, comparisons: undefined }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
