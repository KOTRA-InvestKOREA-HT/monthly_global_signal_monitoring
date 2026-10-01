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

// 보고서 호수. 워크플로 입력이 비어 있으면 판정 단계에서 받은 호수를 쓴다(대시보드 버튼이 거기에 넘긴다).
export function issueNumberFor(input, judged) {
  const pick = [input, judged?.issue_number].map(value => String(value || '').replace(/[^\d]/g, '')).find(Boolean);
  return pick || '2';
}

// 문안 단계 전용 키. 판정 단계와 다른 키(다른 프로젝트)를 쓰면 무료 한도를 서로 나눠 쓰지 않는다.
// 비어 있으면 판정 단계와 같은 GEMINI_API_KEY 를 쓴다.
export function summaryApiKey(env = process.env) {
  return [env.GEMINI_FOR_SUMMARY, env.GEMINI_API_KEY].map(value => String(value || '').trim()).find(Boolean) || '';
}

function writerSummary(stats) {
  const byModel = Object.entries(stats.written_by || {}).map(([model, n]) => `${model} ${n}`).join(', ');
  return `### Report copy (${stats.model})\n` +
    `${stats.articles} articles; ${stats.requests} requests; ${stats.cached} summaries reused; ` +
    `${stats.written} written${byModel ? ` (${byModel})` : ''}; ${stats.failed.length} gave up` +
    `${Object.keys(stats.errors).length ? `; errors ${JSON.stringify(stats.errors)}` : ''}` +
    `${Object.keys(stats.rejected).length ? `; rejected by ${JSON.stringify(stats.rejected)}` : ''}.\n` +
    stats.failed.map(item => `- ${item.company} ${item.candidate_id}: left out of this report (${item.problems.join('; ') || 'no usable copy'})\n`).join('') +
    (stats.stopped ? `Stopped: ${stats.stopped.reason}${stats.stopped.http_status ? ` (HTTP ${stats.stopped.http_status})` : ''}. ` +
      'Written copy is saved; run publish-report again for the same dates to continue. Existing published PDFs are unchanged.\n' : '');
}

function reviewerSummary(stats) {
  if (!stats) return '### Copy review\nOff (GEMINI_REVIEWER_MODEL=off).\n';
  if (stats.error) return `### Copy review\nFailed: ${stats.error}. The report was built without it.\n`;
  return `### Copy review (${stats.model})\n` +
    `${stats.reviewed} summaries reviewed; ${stats.requests} review requests; ` +
    `first pass flagged ${stats.first_flagged} issues (${stats.first_enforce} signal cards sent back for rewriting); ` +
    `${stats.rounds.length} rewrite round(s); ` +
    `${stats.flagged.length} issues left; ${stats.discarded} unverifiable flags discarded` +
    `${Object.keys(stats.errors).length ? `; errors ${JSON.stringify(stats.errors)}` : ''}` +
    `${stats.stopped ? `; stopped after ${stats.stopped.reason}` : ''}.\n` +
    stats.flagged.map(item => `- ${item.company} ${item.candidate_id} [${item.check}] "${item.copy_phrase}"` +
      `${item.source_phrase ? ` vs "${item.source_phrase}"` : ''}: ${item.note}\n`).join('');
}

async function main() {
  const period = resolveReportPeriod();
  process.env.REPORT_FROM_DATE = period.from_date;
  process.env.REPORT_TO_DATE = period.to_date;
  await write(STATUS_FILE, { status: 'running', stage: 'setup', period, ...runIdentity() });
  await fs.rm(BUILD_FAILURE_FILE, { force: true });
  let stage = 'setup';
  try {
    const judged = judgementFor(await read(path.join(ROOT, 'status.json')).catch(() => null), period);
    const writer = resolveWriter();
    const apiKey = process.env.GEMINI_FREE_TIER_CONFIRMED === 'true' ? summaryApiKey() : '';
    if (!apiKey) {
      throw new Error('GEMINI_FOR_SUMMARY (or GEMINI_API_KEY) with GEMINI_FREE_TIER_CONFIRMED=true is required to write the report copy. ' +
        'Set GEMINI_FREE_TIER_CONFIRMED only after confirming the key belongs to a project with no paid billing.');
    }
    const runDir = path.join(ROOT, judged.run_dir);
    const snapshot = await read(path.join(runDir, 'snapshot.json'));
    const policyDoc = await fs.readFile('docs/local_report_review.md', 'utf8');

    stage = 'write';
    const stats = await writeSummaries({ articles: snapshot.articles, reviewDir: path.join(ROOT, 'reviews'), writer, apiKey,
      policyWording: writerPolicySection(policyDoc) });
    console.log(JSON.stringify({ summary_writer: stats }));
    if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, writerSummary(stats));
    if (stats.stopped) {
      await write(STATUS_FILE, { status: 'paused', stage, reason: stats.stopped.reason, summary_writer: stats, period, ...runIdentity() });
      process.exitCode = 75;
      return;
    }

    // 문안 검토. 시제 지적과 투자 시그널의 근거 지적은 문안 단계로 돌려 한 번 다시 쓰게 한다. 항목을 빼지는 않는다.
    // 검토 호출이 실패하면 검토 없이 보고서를 만든다. 문안 검사는 이미 통과한 문안이다.
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

    stage = 'build';
    process.env.REPORT_BUILD_FAILURE_FILE = BUILD_FAILURE_FILE;
    const reviewFailed = publishableReviewFailures(judged);
    const issueNumber = issueNumberFor(process.env.REPORT_ISSUE_NUMBER, judged);
    const reportDir = await build({ runDir, issueNumber, reviewFailed });

    stage = 'publish';
    const investment = await read(path.join(reportDir, 'investment.json'));
    const relevant = await read(path.join(reportDir, 'relevant.json'));
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
      ...judgement, status: reviewFailed.length ? 'completed_with_review_failures' : judgement.status,
      judgement_run: run || null, summary_writer: stats, summary_reviewer: reviewStats, issue_number: issueNumber, period, provider,
      model: judged.model });
    await fs.mkdir('public/reports', { recursive: true });
    await fs.copyFile(path.join(reportDir, 'report_ko.pdf'), 'public/reports/latest_report.pdf');
    await fs.copyFile(path.join(reportDir, 'report_en.pdf'), 'public/reports/latest_report_en.pdf');
    await fs.rm(reportDir, { recursive: true, force: true });
    await write(STATUS_FILE, { status: 'completed', stage, issue_number: issueNumber, summary_writer: stats,
      review_failures: reviewFailed.length, period, ...runIdentity() });
  } catch (error) {
    const buildFailure = await read(BUILD_FAILURE_FILE).catch(() => null);
    await write(STATUS_FILE, { status: 'failed', stage, reason: error.publish_reason || 'validation_or_execution',
      error_message: String(error.message || '').slice(0, 500), ...(buildFailure ? { build_failure: buildFailure } : {}),
      period, ...runIdentity() }).catch(() => {});
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
