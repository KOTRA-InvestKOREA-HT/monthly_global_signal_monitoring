#!/usr/bin/env node
// golden_review 실행 결과 둘을 같은 기사·같은 후보끼리 나란히 놓고, 사람이 사실 오류·누락·
// 어색함을 표시할 수 있는 채점지를 만든다. 비교 대상은 두 가지다.
//   - 프롬프트 변형: REPORT_PROMPT_VARIANT 만 다르게 두 번 실행한 결과
//   - 모델 교체: 같은 입력에 모델만 다르게 두 번 실행한 결과
// 둘 다 실행 디렉터리 두 개이므로 이 도구는 무엇이 달랐는지 묻지 않고, 각 실행이 스스로 적어 둔
// provider·model·variant 를 머리말에 옮긴다.
//
// 사용법:
//   node scripts/summary_sheet.mjs --a outputs/golden_eval/baseline --b outputs/golden_eval/shared_facts \
//     [--out docs/summary_comparison.md] [--set dev|holdout|all]
//
// --b 없이 실행하면 한 실행만 읽어 채점지를 만든다. 첫 회차의 기준값을 만들 때 쓴다.
//
// 채점은 문안마다 세 칸이다. 세 가지가 서로 다른 문제이기 때문이다.
//   사실: 근거에 없는 말이거나 근거와 다른 말(주체·상대방·날짜·금액·진행 단계)
//   누락: 근거에 있는데 요약이 떨어뜨린 사실
//   어색: 사실은 맞지만 직역·음차·비문으로 읽히지 않는 문장
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));

// 표 칸 안에서 줄바꿈과 파이프는 표를 깨뜨린다. 내용을 지우지 않고 칸 안에 들어가게만 고친다.
export function cell(text) {
  return String(text ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim() || '(없음)';
}

export function runLabel(report) {
  const parts = [report.provider, report.model, report.variant || 'baseline'].filter(Boolean);
  return parts.join(' / ');
}

// 후보를 기사와 후보 id 로 잇는다. 기사 id 는 정책 다이제스트에서 나오므로 변형끼리 다르다.
export function indexRun(report) {
  const index = new Map();
  for (const article of report.comparisons || []) {
    for (const candidate of article.candidates || []) {
      index.set(`${article.company}\u0000${article.url}\u0000${candidate.candidate_id}`,
        { article, candidate });
    }
  }
  return index;
}

// 근거는 판정 파일에 후보별로 들어 있다. 채점지에서 문안 바로 위에 두어야 사실 확인이 가능하다.
// shared_facts 변형은 문안 앞에 사실 목록을 적는다. 문안이 틀렸을 때 목록부터 틀렸는지, 목록은
// 맞는데 문장이 틀렸는지를 갈라 봐야 변형이 무엇을 바꿨는지 읽을 수 있다.
export async function candidateDetail(dir, articleId) {
  try {
    const review = await read(path.join(dir, 'reviews', `${articleId}.json`));
    return new Map((review.decisions || []).map(d => [d.candidate_id,
      { quotes: d.evidence_quotes || [], facts: d.facts || null }]));
  } catch { return new Map(); }
}

// 사실 목록은 빈 칸을 빼고 한 줄로 적는다. 빈 칸까지 실으면 채점지가 읽히지 않는다.
export function factLine(facts) {
  if (!facts || typeof facts !== 'object') return '';
  const named = Object.entries(facts).filter(([, value]) => String(value ?? '').trim());
  return named.map(([key, value]) => `${key}=${cell(value)}`).join(' · ');
}

export function sheetSection({ key, a, b, labels, detail }) {
  const [, , candidateId] = key.split('\u0000');
  const article = (a || b).article;
  const lines = [];
  lines.push(`#### ${candidateId} (${(a || b).candidate.kind})`);
  const verdict = (run, label) => run ? `${label}: ${run.candidate.after?.supported ? '승인' : '탈락'}` : `${label}: 판정 없음`;
  lines.push('', `${verdict(a, labels.a)}${b || labels.b ? ` · ${verdict(b, labels.b)}` : ''}`, '');
  // 두 실행의 인용을 따로 싣는다. 예전에는 A 의 인용이 있으면 그것만 싣고 두 문안을 그 아래 놓았다.
  // 실행이 서로 다른 문장을 인용하면 채점자가 A 의 근거로 B 의 문안을 읽어, 근거 있는 요약을
  // 근거 없음으로 적게 된다. 같으면 한 번만 싣는다. 채점지가 길어지는 것보다 오판이 비싸다.
  const quotesFor = side => detail[side]?.get(candidateId)?.quotes || [];
  const sides = [['a', labels.a], ['b', labels.b]].filter(([, label]) => label);
  const same = sides.length === 2 && JSON.stringify(quotesFor('a')) === JSON.stringify(quotesFor('b'));
  for (const [side, label] of same ? [[sides[0][0], '']] : sides) {
    const list = quotesFor(side);
    const heading = label ? `근거 (${label})` : '근거';
    lines.push(list.length ? heading : `${heading} (판정 파일에 인용 없음)`);
    for (const quote of list) lines.push(`> ${cell(quote)}`);
    lines.push('');
  }
  for (const [side, label] of sides) {
    const facts = factLine(detail[side]?.get(candidateId)?.facts);
    if (facts) lines.push(`사실 목록 (${label}): ${facts}`, '');
  }
  lines.push('| 실행 | 언어 | 문안 | 사실 | 누락 | 어색 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const [run, label] of [[a, labels.a], [b, labels.b]]) {
    if (!label) continue;
    for (const lang of ['ko', 'en']) {
      lines.push(`| ${label} | ${lang} | ${cell(run?.candidate.after?.[`summary_${lang}`])} |  |  |  |`);
    }
  }
  lines.push('');
  if (article.expect && article.expect !== 'unknown') lines.push(`기대: ${article.expect}`, '');
  return lines;
}

// detail 은 실행별로 따로 받는다. 한 곳에 모으면 두 실행의 기사 id 가 같을 때(같은 모델·같은 변형을
// 두 번 돌린 안정성 비교) 먼저 읽은 쪽이 다른 쪽의 사실 목록으로 실린다.
export function buildSheet({ reportA, reportB, detail = { a: new Map(), b: new Map() }, set = 'all' }) {
  const a = indexRun(reportA), b = reportB ? indexRun(reportB) : new Map();
  const labels = { a: runLabel(reportA), b: reportB ? runLabel(reportB) : '' };
  // 두 실행에서 같은 이름이 나오면 어느 쪽인지 알 수 없다. 그때만 A·B 를 붙인다.
  if (labels.b && labels.a === labels.b) { labels.a = `A ${labels.a}`; labels.b = `B ${labels.b}`; }
  const keys = [...new Set([...a.keys(), ...b.keys()])];
  const lines = [`# 요약문 비교 채점지`, '',
    `- A: ${labels.a || runLabel(reportA)} — ${reportA.set || 'all'} 세트, 기사 ${reportA.reviewed_articles ?? reportA.golden_articles ?? '?'}건`,
    ...(reportB ? [`- B: ${labels.b} — ${reportB.set || 'all'} 세트, 기사 ${reportB.reviewed_articles ?? reportB.golden_articles ?? '?'}건`] : []),
    '',
    '각 문안에 대해 세 칸을 채운다. 사실=근거와 다르거나 근거에 없는 말, 누락=근거에 있는데 빠진 사실,',
    '어색=사실은 맞지만 읽히지 않는 문장. 문제가 없으면 빈칸으로 둔다.',
    '',
    'dev 는 이번 회차에 오류를 발견해 수정 방향을 정하는 데 쓴 기사다. 거기서만 나아졌다면 과적합이고,',
    'holdout 에서도 같이 나아져야 일반화된 개선이다.', ''];

  let index = 0, lastArticle = null;
  for (const key of keys) {
    const entryA = a.get(key), entryB = b.get(key);
    const article = (entryA || entryB).article;
    if (set !== 'all' && (article.set || 'holdout') !== set) continue;
    const articleKey = `${article.company}\u0000${article.url}`;
    if (articleKey !== lastArticle) {
      lastArticle = articleKey;
      index += 1;
      lines.push(`## ${index}. ${article.company} [${article.set || 'holdout'}]`, '', article.url, '');
      for (const defect of article.defects || []) lines.push(`- 이번 회차에 본 문제: ${defect}`);
      if ((article.defects || []).length) lines.push('');
    }
    lines.push(...sheetSection({ key, a: entryA, b: entryB, labels,
      detail: { a: entryA && detail.a?.get(entryA.article.article_id),
        b: entryB && detail.b?.get(entryB.article.article_id) } }));
  }
  return lines.join('\n') + '\n';
}

async function main() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !['a', 'b', 'out', 'set'].includes(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error(`Invalid option: ${argv[i]}`);
    }
    args[key] = argv[++i];
  }
  if (!args.a) throw new Error('--a <golden run dir> is required');
  const reportA = await read(path.join(path.resolve(args.a), 'comparison.json'));
  const reportB = args.b ? await read(path.join(path.resolve(args.b), 'comparison.json')) : null;

  // 골든 목록의 set 과 defects 는 비교 결과에 없다. 채점지에서 개발·검증을 갈라 읽어야 하므로 옮겨 붙인다.
  const golden = await read(path.resolve('config/golden_articles.json'));
  const meta = new Map((golden.articles || []).map(entry => [`${entry.company}\u0000${entry.url}`, entry]));
  for (const report of [reportA, reportB].filter(Boolean)) {
    for (const article of report.comparisons || []) {
      const entry = meta.get(`${article.company}\u0000${article.url}`) || {};
      article.set ??= entry.set || 'holdout';
      article.defects ??= entry.defects || [];
    }
  }

  const detail = { a: new Map(), b: new Map() };
  for (const [side, dir, report] of [['a', args.a, reportA], ['b', args.b, reportB]]) {
    if (!report) continue;
    for (const article of report.comparisons || []) {
      if (detail[side].has(article.article_id)) continue;
      detail[side].set(article.article_id, await candidateDetail(path.resolve(dir), article.article_id));
    }
  }

  const sheet = buildSheet({ reportA, reportB, detail, set: args.set || 'all' });
  if (args.out) {
    await fs.mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
    await fs.writeFile(path.resolve(args.out), sheet);
    console.log(`Wrote ${args.out} (${sheet.split('\n').length} lines)`);
  } else {
    process.stdout.write(sheet);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
