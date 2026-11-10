#!/usr/bin/env node
// 두 번째 단계: 판정이 끝난 월의 보고서 문안을 쓰고 한·영 PDF 를 만든다.
//
// 첫 단계(review_report.mjs, collect-company-signals 워크플로)는 수집·판정·2차 검증만 하고 문안을 쓰지 않는다.
// 이 단계는 그 판정(outputs/review_work 의 status.json·스냅샷·판정 파일)을 이어받아 문안 모델로 승인 후보의
// 한·영 문안을 쓰고, 보고서를 만들어 outputs/latest_*.json 과 public/reports 에 놓는다. 두 단계를 나눈 것은
// 판정 호출이 문안 규칙까지 떠안지 않게 하고, 무료 등급 하루 한도를 두 날에 나눠 쓰기 위해서다.
//
// 할당량이나 장애로 문안을 다 쓰지 못하면 보고서를 만들지 않고 종료 코드 75 로 끝난다. 쓴 문안은 판정 파일에
// 남으므로 같은 기간으로 다시 돌리면 이어서 쓴다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from './local_report.mjs';
import { publishableReviewFailures, publishedSignalCounts, runIdentity } from './review_report.mjs';
import { resolveReportPeriod } from './report_period.mjs';
import { resolveWriter, writeSummaries, writerPolicySection } from './summary_writer.mjs';
import { resolveReviewer, reviewAndRewrite } from './summary_reviewer.mjs';
import { writeBoxCopy } from './box_writer.mjs';
import { retryableCompanies } from './collection_resilience.mjs';

const ROOT = path.resolve('outputs/review_work');
const STATUS_FILE = path.join(ROOT, 'publish_status.json');
const BUILD_FAILURE_FILE = path.join(ROOT, 'build_failure.json');

const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const write = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n');
  await fs.rename(`${file}.tmp`, file);
};

// 이어받을 판정. 같은 기간이고 판정이 끝났다고 표시된 것만 받는다. 끝나지 않은 판정으로 보고서를 만들면
// 아직 판정하지 않은 기사의 시그널이 조용히 빠진다.
export function judgementFor(status, period) {
  const { from_date: from, to_date: to } = period;
  if (!status || status.stage !== 'judgement' || status.period?.from_date !== from || status.period?.to_date !== to) {
    throw Object.assign(new Error(`No judgement for ${from}..${to} in outputs/review_work. ` +
      'Run the collect-company-signals workflow for the same dates first.'), { publish_reason: 'judgement_missing' });
  }
  if (!status.judged) {
    throw Object.assign(new Error(`Judgement for ${from}..${to} is not finished (${status.status}: ${status.completed}/${status.total} articles` +
      `${status.reason ? `, ${status.reason}` : ''}). Run collect-company-signals again for the same dates with refresh and rereview off; ` +
      'it continues where it stopped.'), { publish_reason: 'judgement_incomplete' });
  }
  if (!status.run_dir) throw Object.assign(new Error('The judgement status does not name its snapshot folder.'), { publish_reason: 'judgement_missing' });
  return status;
}

// 수집 미완료로 멈출 때의 종료 코드. 워크플로가 이 코드를 받으면 "Held - retryable companies remain" 단계로
// 실행을 실패시키고, 대시보드가 그 단계 이름(app/lib/report_pipeline.mjs HELD_STEP)으로 "발행 보류"를 알아본다.
// 75(한도로 멈춤)와 다른 번호여야 한다. 65 는 sysexits 의 EX_DATAERR(입력 자료가 올바르지 않음)다.
export const HELD_EXIT_CODE = 65;

// 판정이 쓴 수집에 재시도 대상 기업이 남았는지. 남았으면 문안을 쓰기 전에 멈춘다(held).
// Issue 5(2026-10)는 수집 요약에 재시도 대상 8개 기업(Dupont, Chemours, 3M, Ouster, HyproMag, Texcell, DNP,
// Shanghai Electric Wind Power)이 남은 채 발행됐다. 이 단계는 판정이 끝났는지만 봤고, 대시보드도 그 목록을 보여 주지
// 않아 아무도 다시 수집하지 않았다. 그 기업들이 10월에 낸 기사는 보고서에서 빠졌을 수 있다(DNP 는 본문을 모두 잃었다).
// 판정 단계가 이미 한 번 더 받아 봤으므로(review_report.mjs collectWithRetryPass) 여기서는 다시 받지 않는다.
// 매달 같은 오류를 주는 사이트도 있어, 다시 수집해도 남으면 사람이 allow 로 넘긴다(워크플로 입력
// allow_retryable_companies, 대시보드 "발행만 실행"의 체크 상자). 멈춤은 막다른 길이 아니다. 2026-11 확인으로 DNP 의
// 설정 주소 https://www.dnp.co.jp/en/ir/ 는 늘 500(Fastly "unknown domain")이어서 DNP 가 매 실행 재시도 대상으로
// 남았다. 넘김이 없었다면 그 주소 하나가 매달 발행을 막았다(2026-11-10 설정에서 뺐다. IR 소식은 IR News RSS 가 받는다).
// 이렇게 영구히 깨진 설정 주소가 보이면 넘기기만 하지 말고 설정을 고친다. 접근 거부(403) 같은 영구 오류는 재시도 대상이
// 아니라서 여기서 멈추지 않는다. 그 기업은 지금처럼 보고서에 수집 미완료로 나간다.
export function collectionRetryable(summary, allow = false) {
  const companies = retryableCompanies(summary);
  // 기업 목록이 없는 옛 요약도 수만 있으면 멈춘다.
  const count = Math.max(companies.length, Number(summary?.retryable_company_count) || 0);
  return { companies, count, held: count > 0 && !allow, allowed: count > 0 && allow };
}

export function heldMessage(retryable, period) {
  return `${retryable.count} companies still have temporary collection errors in the judged collection` +
    `${retryable.companies.length ? `: ${retryable.companies.join(', ')}` : ''}. Their articles may be missing, so the report ` +
    `was not built and no copy was written. Run collect-company-signals again for ${period.from_date}..${period.to_date} ` +
    '(the dashboard button does this and publishes again; within a day it collects only these companies again), ' +
    'or run publish-report with allow_retryable_companies on to publish without them.';
}

// local_report.mjs build 가 실행 폴더 안에 만드는 report-* 빌드 폴더를 지운다.
export async function removeBuildDirs(runDir) {
  const names = await fs.readdir(runDir).catch(() => []);
  await Promise.all(names.filter(name => name.startsWith('report-'))
    .map(name => fs.rm(path.join(runDir, name), { recursive: true, force: true })));
}

// 보고서 호수. 워크플로 입력이 비어 있으면 판정 단계에서 받은 호수를 쓴다(대시보드 버튼이 거기에 넘긴다).
// 둘 다 없으면 멈춘다. 예전에는 "2"로 채워, 호수 없이 돌린 발행이 "Issue 2" PDF 를 main 에 커밋할 수 있었다(4호 시점).
export function issueNumberFor(input, judged) {
  const pick = [input, judged?.issue_number].map(value => String(value || '').replace(/[^\d]/g, '')).find(Boolean);
  if (!pick) {
    throw Object.assign(new Error('No issue number: set the issue_number input (REPORT_ISSUE_NUMBER) or run the judgement with one.'),
      { publish_reason: 'issue_number_missing' });
  }
  return pick;
}

// 문안 단계 전용 키. 판정 단계와 다른 키(다른 프로젝트)를 쓰면 무료 한도를 서로 나눠 쓰지 않는다.
// 비어 있으면 판정 단계와 같은 GEMINI_API_KEY 를 쓴다.
export function summaryApiKey(env = process.env) {
  return summaryApiKeys(env)[0] || '';
}

// 문안 단계의 키 순서. 문안 키가 할당량(429)에 걸리면 판정 키로 이어 쓴다. 판정 단계는 반대 순서로 순환한다
// (review_report.mjs judgementKeys). 문안은 판정 파일에 저장되므로 다음 키로 다시 부르면 쓴 문안은 그대로 둔다.
export function summaryApiKeys(env = process.env) {
  return [...new Set([env.GEMINI_FOR_SUMMARY, env.GEMINI_API_KEY].map(value => String(value || '').trim()).filter(Boolean))];
}

// 할당량으로 멈추면 다음 키로 같은 일을 다시 부른다. 마지막으로 쓴 키를 돌려줘 뒤 단계(검토·상자 문안)가 이어 쓴다.
export async function writeWithKeyRotation(keys, write, log = console.log) {
  const runs = [];
  let stats = null, index = 0;
  for (; index < keys.length; index++) {
    stats = await write(keys[index]);
    runs.push({ key: index + 1, requests: stats.requests, ...(stats.stopped ? { stopped: stats.stopped.reason } : {}) });
    if (stats.stopped?.reason !== 'quota' || index === keys.length - 1) break;
    log(`Copy key ${index + 1} hit its quota; continuing with key ${index + 2}`);
  }
  return { stats: { ...stats, requests: runs.reduce((sum, run) => sum + (run.requests || 0), 0), key_runs: runs },
    apiKey: keys[Math.min(index, keys.length - 1)] };
}

// 끝내 쓰지 못한 후보는 마지막으로 걸린 문안을 함께 적는다. 5호(2026-10) Siemens Gamesa S5 는 사유 코드만 남아 문안이 정말
// 틀렸는지 검사가 잘못 걸었는지 실행 뒤에 가릴 수 없었다.
export function writerSummary(stats) {
  const byModel = Object.entries(stats.written_by || {}).map(([model, n]) => `${model} ${n}`).join(', ');
  return `### Report copy (${stats.model})\n` +
    `${stats.articles} articles; ${stats.requests} requests; ${stats.cached} summaries reused; ` +
    `${stats.written} written${byModel ? ` (${byModel})` : ''}; ${stats.failed.length} gave up` +
    `${Object.keys(stats.errors).length ? `; errors ${JSON.stringify(stats.errors)}` : ''}` +
    `${Object.keys(stats.rejected).length ? `; rejected by ${JSON.stringify(stats.rejected)}` : ''}.\n` +
    stats.failed.map(item => `- **${item.company} ${item.candidate_id}: left out of this report** (${item.problems.join('; ') || 'no usable copy'})\n` +
      (item.rejected_copy ? `  - last rejected EN: ${item.rejected_copy.summary_en || '(empty)'}\n` +
        `  - last rejected KO: ${item.rejected_copy.summary_ko || '(empty)'}\n` : '')).join('') +
    (stats.stopped ? `Stopped: ${stats.stopped.reason}${stats.stopped.http_status ? ` (HTTP ${stats.stopped.http_status})` : ''}. ` +
      'Written copy is saved; run publish-report again for the same dates to continue. Existing published PDFs are unchanged.\n' : '');
}

export function reviewerSummary(stats) {
  if (!stats) return '### Copy review\nOff (GEMINI_REVIEWER_MODEL=off).\n';
  if (stats.error) return `### Copy review\nFailed: ${stats.error}. The report was built without it.\n`;
  return `### Copy review (${stats.model})\n` +
    `${stats.reviewed} summaries reviewed; ${stats.requests} review requests; ` +
    `first pass flagged ${stats.first_flagged} issues (${stats.first_enforce} signal cards sent back for rewriting); ` +
    `${stats.rounds.length} rewrite round(s); ${stats.unchecked.length} rewritten cards not re-checked; ` +
    `${stats.kept?.length || 0} cards kept their previous copy; ` +
    `${stats.flagged.length} issues left on copy that was not rewritten; ${stats.discarded} unverifiable flags discarded` +
    `${Object.keys(stats.errors).length ? `; errors ${JSON.stringify(stats.errors)}` : ''}` +
    `${stats.stopped ? `; stopped after ${stats.stopped.reason}` : ''}.\n` +
    (stats.rounds.find(round => round.stopped) ? `Rewriting stopped after ${stats.rounds.find(round => round.stopped).stopped.reason}; ` +
      'the cards it did not rewrite keep their previous copy in this report, and a later publish-report run sends them back for rewriting.\n' : '') +
    (stats.kept || []).map(item => `- ${item.company} ${item.candidate_id}: previous copy kept (${item.reason})\n`).join('') +
    stats.flagged.map(item => `- ${item.company} ${item.candidate_id} [${item.check}] "${item.copy_phrase}"` +
      `${item.source_phrase ? ` vs "${item.source_phrase}"` : ''}: ${item.note}\n`).join('');
}

// 승인됐지만 문안이 끝내 검사를 통과하지 못해 이번 보고서에서 빠진 시그널. 빌드가 만든 행에서 센다(importReview 가 붙이는
// ai_summary_failed). 문안 단계의 기록(stats.failed)만 보면 검토 지적으로 다시 쓰다 가져오기 검사에 걸려 빠진 카드를 놓친다.
// 5호(2026-10) Siemens Gamesa S5 가 bilingual_month_mismatch 로 빠졌을 때 실행은 초록으로 끝났고, 출력 상태는 판정 실패 때문에
// completed_with_review_failures 였을 뿐 이 누락은 summary_writer.failed 안쪽과 실행 요약 한 줄에만 있었다.
// 보고서를 막지는 않는다. 판정 실패(publishableReviewFailures)처럼, 막으면 카드 한 장이 매달 보고서 전체를 세울 수 있다.
export function copyFailures(investment, relevant) {
  return [...investment.map(row => ['investment', row]), ...relevant.map(row => ['business', row])]
    .filter(([, row]) => Array.isArray(row.ai_summary_failed))
    .map(([kind, row]) => ({ company: row.company, kind,
      ...(kind === 'investment' ? { investment_signal_no: row.investment_signal_no } : {}),
      title: row.title, url: row.url, problems: row.ai_summary_failed }));
}

// 발행 상태. 판정 실패와 문안 실패를 함께 드러낸다. 판정 실패만 있을 때의 값(completed_with_review_failures)은 그대로다.
export function publishedStatus(judgementStatus, reviewFailed, copyFailed) {
  const kinds = [reviewFailed.length ? 'review' : '', copyFailed.length ? 'copy' : ''].filter(Boolean);
  return kinds.length ? `completed_with_${kinds.join('_and_')}_failures` : judgementStatus;
}

// GitHub Actions 경고 주석. 실행 화면 맨 위에 노란 경고로 뜬다. 메시지의 %·줄바꿈은 Actions 규칙대로 바꾼다.
export function copyFailureAnnotations(failures) {
  const escape = text => String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  return failures.map(item => `::warning title=Approved signal left out of the report::` +
    escape(`${item.company} ${item.kind === 'investment' ? `S${item.investment_signal_no}` : 'business'} "${item.title}": ` +
      `the copy never passed the checks (${item.problems.join('; ') || 'no usable copy'}). It stays on the dashboard and is written again next run.`));
}

function copyFailureSummary(failures) {
  if (!failures.length) return '';
  return `### Approved signals left out of this report\n**${failures.length} approved signal(s) are missing from both PDFs** because their copy ` +
    'never passed the checks. They stay on the dashboard (ai_summary_failed) and publish-report writes them again next run.\n' +
    failures.map(item => `- ${item.company} ${item.kind === 'investment' ? `S${item.investment_signal_no}` : 'business'}: ` +
      `${item.title} (${item.problems.join('; ') || 'no usable copy'})\n`).join('');
}

async function main() {
  const period = resolveReportPeriod();
  process.env.REPORT_FROM_DATE = period.from_date;
  process.env.REPORT_TO_DATE = period.to_date;
  await write(STATUS_FILE, { status: 'running', stage: 'setup', period, ...runIdentity() });
  await fs.rm(BUILD_FAILURE_FILE, { force: true });
  let stage = 'setup';
  let reportDir = null;
  try {
    const judged = judgementFor(await read(path.join(ROOT, 'status.json')).catch(() => null), period);
    // 문안을 쓰기 전에 확인한다. 다 쓰고 나서 호수 때문에 멈추면 그 호출이 헛돈다.
    const issueNumber = issueNumberFor(process.env.REPORT_ISSUE_NUMBER, judged);
    const runDir = path.join(ROOT, judged.run_dir);
    const snapshot = await read(path.join(runDir, 'snapshot.json'));
    // 문안 모델·키를 고르기 전에 본다. 멈춰도 쓴 문안이 없으니 헛도는 호출이 없고, 키가 없는 실행도 같은 이유로 멈춘다.
    const retryable = collectionRetryable(snapshot.summary, process.env.REPORT_ALLOW_RETRYABLE_COMPANIES === 'true');
    if (retryable.held) {
      const message = heldMessage(retryable, period);
      console.error(message);
      if (process.env.GITHUB_ACTIONS === 'true') console.log(`::error title=Collection incomplete::${message}`);
      if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `### Collection incomplete\n${message}\n`);
      await write(STATUS_FILE, { status: 'held', stage, reason: 'collection_retryable', retryable_companies: retryable.companies,
        retryable_company_count: retryable.count, period, ...runIdentity() });
      process.exitCode = HELD_EXIT_CODE;
      return;
    }
    if (retryable.allowed) {
      console.log(`Publishing with ${retryable.count} retryable companies (allow_retryable_companies): ${retryable.companies.join(', ')}`);
      if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,
        `### Collection incomplete (allowed)\nPublished although ${retryable.count} companies still have temporary collection errors: ` +
        `${retryable.companies.join(', ')}.\n`);
    }
    const writer = resolveWriter();
    const apiKeys = process.env.GEMINI_FREE_TIER_CONFIRMED === 'true' ? summaryApiKeys() : [];
    if (!apiKeys.length) {
      throw new Error('GEMINI_FOR_SUMMARY (or GEMINI_API_KEY) with GEMINI_FREE_TIER_CONFIRMED=true is required to write the report copy. ' +
        'Set GEMINI_FREE_TIER_CONFIRMED only after confirming the key belongs to a project with no paid billing.');
    }
    const policyDoc = await fs.readFile('docs/local_report_review.md', 'utf8');

    stage = 'write';
    const { stats, apiKey } = await writeWithKeyRotation(apiKeys, key => writeSummaries({ articles: snapshot.articles,
      reviewDir: path.join(ROOT, 'reviews'), writer, apiKey: key, policyWording: writerPolicySection(policyDoc) }));
    console.log(JSON.stringify({ summary_writer: stats }));
    if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, writerSummary(stats));
    if (stats.stopped) {
      await write(STATUS_FILE, { status: 'paused', stage, reason: stats.stopped.reason, summary_writer: stats, period, ...runIdentity() });
      process.exitCode = 75;
      return;
    }

    // 문안 검토. 시제 지적과 투자 시그널의 근거 지적은 문안 단계로 돌려 한 번 다시 쓰게 한다. 다시 쓴 문안은 다시
    // 검토하지 않는다(summary_reviewer.mjs reviewAndRewrite). 항목을 빼지는 않는다.
    // 검토 호출이 실패하면 검토 없이 보고서를 만든다. 문안 검사는 이미 통과한 문안이다.
    // 다시 쓰기가 할당량으로 멈춰도 같다. 다시 쓰지 못한 카드는 원래 문안을 그대로 두므로(summary_writer.mjs) 멈추지 않고 만든다.
    stage = 'review';
    const reviewer = resolveReviewer();
    let reviewStats = null;
    if (reviewer) {
      const reviewDir = path.join(ROOT, 'reviews');
      try {
        reviewStats = await reviewAndRewrite({ articles: snapshot.articles, reviewDir, reviewer, apiKey,
          rewrite: feedback => writeSummaries({ articles: snapshot.articles, reviewDir, writer, apiKey,
            policyWording: writerPolicySection(policyDoc), feedback }) });
      } catch (error) {
        reviewStats = { model: reviewer.model, error: String(error.message || error).slice(0, 300) };
      }
    }
    console.log(JSON.stringify({ summary_reviewer: reviewStats }));
    if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, reviewerSummary(reviewStats));

    // 사업현황 상자 문안. 위 지표 칸 말고는 실을 사업동향 문안이 없는 기업만 쓴다(box_writer.mjs).
    // 실패하거나 할당량으로 멈춰도 보고서는 만든다. 그 상자는 "확인되지 않음" 문구로 나간다.
    stage = 'box_copy';
    let boxStats = null;
    try {
      boxStats = await writeBoxCopy({ articles: snapshot.articles, reviewDir: path.join(ROOT, 'reviews'),
        boxDir: path.join(ROOT, 'box_copy'), writer, apiKey, policyWording: writerPolicySection(policyDoc) });
    } catch (error) {
      boxStats = { error: String(error.message || error).slice(0, 300) };
    }
    console.log(JSON.stringify({ box_writer: boxStats }));

    stage = 'build';
    process.env.REPORT_BUILD_FAILURE_FILE = BUILD_FAILURE_FILE;
    const reviewFailed = publishableReviewFailures(judged);
    // 지난 실행이 남긴 빌드 폴더를 치운다. 실패한 발행의 report-* 폴더가 캐시된 실행 폴더에 쌓였다.
    await removeBuildDirs(runDir);
    reportDir = await build({ runDir, issueNumber, reviewFailed });

    stage = 'publish';
    const investment = await read(path.join(reportDir, 'investment.json'));
    const relevant = await read(path.join(reportDir, 'relevant.json'));
    const copyFailed = copyFailures(investment, relevant);
    for (const line of copyFailureAnnotations(copyFailed)) console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY && copyFailed.length) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, copyFailureSummary(copyFailed));
    // 워크플로는 두 PDF 가 모두 만들어진 뒤에만 이 파일들을 함께 커밋한다.
    for (const [source, target] of [['signals.json', 'latest_company_signals.json'], ['summary.json', 'latest_collection_summary.json'],
      ['investment.json', 'latest_investment_signals.json'], ['relevant.json', 'latest_relevant_signals.json']]) {
      await fs.copyFile(path.join(reportDir, source), path.join('outputs', target));
    }
    const provider = judged.provider;
    await write('outputs/latest_investment_signal_summary.json', { investment_signal_count: investment.length,
      companies_with_investment_signals: new Set(investment.map(r => r.company)).size, ...publishedSignalCounts(investment, period), provider });
    await write('outputs/latest_relevance_summary.json', { relevant_signal_count: relevant.length,
      companies_with_relevant_signals: new Set(relevant.map(r => r.company)).size, ...publishedSignalCounts(relevant, period), provider });
    // 판정 단계의 상태에 이 단계의 문안 통계를 붙인다. 실행 식별자는 두 단계가 따로 남는다.
    const { stage: _stage, judged: _judged, run_dir: _runDir, run, ...judgement } = judged;
    await write('outputs/latest_ai_summary_summary.json', {
      ...judgement, status: publishedStatus(judgement.status, reviewFailed, copyFailed), copy_failures: copyFailed,
      judgement_run: run || null, summary_writer: stats, summary_reviewer: reviewStats, box_writer: boxStats, issue_number: issueNumber, period, provider,
      model: judged.model,
      // 사람이 allow 로 넘긴 발행이면 그때 남아 있던 기업을 남긴다. 다음 달 감사가 "기사 없음"과 가를 수 있게 한다.
      ...(retryable.allowed ? { published_with_retryable_companies: retryable.companies } : {}) });
    await fs.mkdir('public/reports', { recursive: true });
    await fs.copyFile(path.join(reportDir, 'report_ko.pdf'), 'public/reports/latest_report.pdf');
    await fs.copyFile(path.join(reportDir, 'report_en.pdf'), 'public/reports/latest_report_en.pdf');
    await write(STATUS_FILE, { status: 'completed', stage, issue_number: issueNumber, summary_writer: stats,
      review_failures: reviewFailed.length, copy_failures: copyFailed, period, ...runIdentity() });
  } catch (error) {
    const buildFailure = await read(BUILD_FAILURE_FILE).catch(() => null);
    await write(STATUS_FILE, { status: 'failed', stage, reason: error.publish_reason || 'validation_or_execution',
      error_message: String(error.message || '').slice(0, 500), ...(buildFailure ? { build_failure: buildFailure } : {}),
      period, ...runIdentity() }).catch(() => {});
    throw error;
  } finally {
    // 성공해도 실패해도 빌드 폴더는 남기지 않는다. 결과는 outputs/·public/reports 로 옮겼고, 진단은
    // build_failure.json 과 실행 폴더의 date_pending.json 에 있다. 예전에는 성공할 때만 지워 실패한 폴더가 쌓였다.
    if (reportDir) await fs.rm(reportDir, { recursive: true, force: true }).catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
