// 사용: node outputs/review_2026-09-17/apply.mjs <원본 review 폴더> <snapshot run 폴더> <새 review 폴더>
// 원본 review 를 새 폴더로 복사한 뒤 adjudication.mjs 의 재판정·문안 수정을 적용한다.
// 각 기사는 importReview(strictNumbers) 로 검증하고, 수정 전후 비교를 changes.json 으로 남긴다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ADJUDICATIONS, REVIEWER } from './adjudication.mjs';

const [sourceDir, runDir, targetDir] = process.argv.slice(2);
if (!sourceDir || !runDir || !targetDir) throw new Error('Usage: apply.mjs SOURCE_REVIEWS RUN_DIR TARGET_REVIEWS');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..');
const { importReview } = await import(pathToFileURL(path.join(root, 'scripts/local_report.mjs')).href);
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));

const snapshot = await read(path.join(runDir, 'snapshot.json'));
const articles = new Map(snapshot.articles.map(article => [article.id, article]));
await fs.mkdir(targetDir, { recursive: true });
for (const file of await fs.readdir(sourceDir)) {
  if (file.endsWith('.json')) await fs.copyFile(path.join(sourceDir, file), path.join(targetDir, file));
}

const verdicts = (article, review) => {
  if (!review) return null;
  return Object.fromEntries(importReview(article, review).map(result => [result.candidate_id,
    result.supported ? 'approved' : result.human_review ? 'human_review' : 'rejected']));
};

const changes = [];
for (const [id, item] of Object.entries(ADJUDICATIONS)) {
  const article = articles.get(id);
  if (!article) throw new Error(`Article not in snapshot: ${id}`);
  const file = path.join(targetDir, `${id}.json`);
  const before = await read(file).catch(() => null);
  let after;
  if (item.decisions) {
    after = { article_id: id, reviewer: REVIEWER, adjudication: { kind: item.kind, note: item.note }, decisions: item.decisions };
  } else {
    if (!before) throw new Error(`No saved review to patch: ${id}`);
    const unknown = Object.keys(item.patch).filter(candidate => !before.decisions.some(d => d.candidate_id === candidate));
    if (unknown.length) throw new Error(`${id}: unknown candidates ${unknown}`);
    after = { ...before, adjudication: { kind: item.kind, note: item.note, reviewer: REVIEWER,
      original_reviewer: before.reviewer, patched_candidates: Object.keys(item.patch) },
      decisions: before.decisions.map(d => (item.patch[d.candidate_id] ? { ...d, ...item.patch[d.candidate_id] } : d)) };
  }
  // 새 판정·문안은 운영 응답과 같은 기준(숫자 검증 포함)으로 통과해야 한다.
  importReview(article, after, { strictNumbers: true });
  const was = before ? verdicts(article, before) : null;
  const now = verdicts(article, after);
  changes.push({ article_id: id, company: article.company, title: article.title, kind: item.kind, note: item.note,
    candidates: article.candidates.map(c => {
      const old = before?.decisions.find(d => d.candidate_id === c.id);
      const cur = after.decisions.find(d => d.candidate_id === c.id);
      return { candidate_id: c.id, before: was?.[c.id] ?? 'no_review', after: now[c.id],
        before_stage: old?.event_stage ?? null, after_stage: cur.event_stage,
        before_reason: old?.reason_ko ?? null, after_reason: cur.reason_ko,
        before_summary_ko: old?.summary_ko ?? null, after_summary_ko: cur.summary_ko };
    }).filter(c => c.before !== c.after || c.before_summary_ko !== c.after_summary_ko || c.before_reason !== c.after_reason) });
  await fs.writeFile(file, `${JSON.stringify(after, null, 2)}\n`);
}
await fs.writeFile(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'changes.json'),
  `${JSON.stringify(changes, null, 2)}\n`);
for (const change of changes) {
  console.log(`${change.company} ${change.article_id} [${change.kind}]`);
  for (const c of change.candidates) console.log(`  ${c.candidate_id}: ${c.before} -> ${c.after}`);
}
