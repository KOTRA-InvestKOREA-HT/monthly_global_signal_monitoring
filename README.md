# Company Signal Collector

Collect public news, press releases, and IR material for 77 target companies, classify investment signals, verify report evidence with AI, and publish Korean/English PDF reports plus a dashboard.

## Files

- `data/target_companies.json`: canonical 77-company target list from PDF page 2.
- `data/target_companies.csv`: spreadsheet-friendly version of the same list.
- `data/company_technology_map.json`: 77-company target technology mapping from the reference PDF.
- `data/company_technology_map.csv`: spreadsheet-friendly version of the technology mapping.
- `config/company_sources.json`: official Newsroom/Press/IR pages, official RSS feeds (or a JSON newsroom feed with `"format": "json"` and a `json` field map, for newsrooms rendered by JavaScript), SEC 8-K filers (confirmed by ticker) and dated news sitemaps by company. SEC collection runs only when `SEC_USER_AGENT` (a User-Agent with a contact address, per SEC fair-access policy) is set; in Actions this comes from the `SEC_USER_AGENT` repository variable.
- `config/technology_keywords.json`: broad Korean/English synonym keyword catalog for relevance filtering.
- `config/date_evidence_sources.json`: publication-date evidence grades shared by the collector, the review path, the PDF builder, and the dashboard.
- `config/approval_policy.json`: the investment-signal approval constants shared by `scripts/validate_report_inputs.mjs` (judging/validation) and `scripts/report_content.py` (publishing). The human-readable criteria, and the text sent to the model, stay in `docs/local_report_review.md`.
- `scripts/report_month.mjs`: the single definition of which month "the previous month" is (Asia/Seoul), shared by the Actions run, the crawl button and the dashboard.
- `.github/workflows/collect-company-signals.yml`: stage 1 — collect, judge and verify (no report copy, no PDF). The dashboard button runs this with `auto_publish=true`, so a finished judgement starts stage 2; manual runs judge only unless that box is ticked.
- `.github/workflows/publish-report.yml`: stage 2 — write the report copy for the finished judgement and build both PDFs. Also the dashboard's `발행만 실행` button.
- `app/`: Vercel dashboard and API routes for the `크롤링 수행` button and the web PDF download.
- `api/report-view-model.py`: the Vercel Python function that computes the report content for the web download.
- `scripts/extract_pdf_companies.py`: validates PDF page 2 against the canonical list.
- `scripts/build_company_technology_map.py`: extracts and normalizes company-to-technology mapping from the reference PDF.
- `scripts/collect_company_signals.mjs`: collects signals from official feeds and pages, SEC filings, news sitemaps and Google News RSS without third-party packages.
- `scripts/review_report.mjs`: stage 1 — automated collection, article judgement and second-stage verification. The judge writes quotes, reason and verdicts only.
- `scripts/publish_report.mjs`: stage 2 — takes over a finished judgement, writes the Korean/English copy with `scripts/summary_writer.mjs`, and builds both PDFs.
- `scripts/report_period.mjs`: shared reporting-period resolver for the CLI and Actions.
- `scripts/validate_report_inputs.mjs`: rejects incomplete or contradictory AI decisions before report publication.
- `scripts/date_state.mjs`: the single definition of publication-date state (confirmed/estimated/unknown/conflicting) and what each state means for review and for the report.
- `scripts/report_content.py`: decides what goes into the report — approval, date reading, selection and prose shaping. No reportlab, no page coordinates.
- `scripts/report_view_model.py`: turns those decisions into the report's view model (JSON). It measures text with reportlab's font tables through `scripts/report_measure.py`; reportlab does not draw the PDFs.
- `scripts/report_html.mjs` and `scripts/build_html_report.mjs`: render the view model as HTML and print the Korean/English PDFs with Chrome. The web download prints the same HTML.
- `outputs/`: generated JSON results.

See `docs/github_vercel_button_workflow.md` for the GitHub upload, Vercel deployment, and button-trigger workflow.
Publication-date handling — how a date is graded and what a date hold means for review and for the PDF — is recorded in `docs/date_criteria_2026-09-07.md`.
Dated investigation and review notes, including the accuracy controls in
`docs/archive/signal_accuracy_improvements_2026-09-03.md`, are kept in `docs/archive/`; they describe the code as it was then.

## Commands

### Automated monthly report (CLI and GitHub Actions)

The monthly report runs in two stages, usually on two days so each stays within the
Gemini free-tier daily limit. Both stages resume from saved progress when they stop.

`npm run report:review` and the `collect-company-signals`
workflow execute stage 1, `scripts/review_report.mjs`:

```text
Resolve period → collect/resume → judge all monthly article candidates
→ second-stage verification → save the judgement (status.json marks it finished)
```

`npm run report:publish` and the `publish-report` workflow execute stage 2,
`scripts/publish_report.mjs`, for the same dates:

```text
Take over the finished judgement → write Korean/English copy for approved candidates
(and near-miss business rows) → build Korean/English PDFs → update latest report files
```

The judge call writes no report copy. The writer (`gemini-3.5-flash-lite`, `GEMINI_WRITER_MODEL`)
gets the evidence quotes, the article body and the wording rules, and uses the `GEMINI_FOR_SUMMARY` key
(falling back to `GEMINI_API_KEY`). The writer and the copy reviewer handle up to
`REPORT_CONCURRENCY` (default 4) articles at a time while keeping the per-request start interval.
If the writer hits its quota or stays unavailable, the run stops and the next run continues.
Each summary records the model that wrote it. Copy that fails a grounding,
number, format or style check is written again with the failed checks named, up to three
times; a signal whose copy never passes is left out of that report, kept on the dashboard,
and written again on the next publish run.

Keyword classification does not remove articles from this review queue. Each
reviewable article is checked against all five investment indicators and business
activity criteria; articles with insufficient date/body evidence remain deferred.

Set the provider and its credentials in the environment before running. For an
existing Gemini setup in PowerShell:

```powershell
$env:REPORT_PROVIDER = 'gemini'
# GEMINI_API_KEY and GEMINI_FREE_TIER_CONFIRMED must already be configured.
$env:REPORT_FROM_DATE = '2026-10-01'
$env:REPORT_TO_DATE = '2026-10-31'
# The issue printed on the cover. There is no default; publishing without it fails.
$env:REPORT_ISSUE_NUMBER = '5'
npm run report:review
```

Both dates omitted means the previous completed calendar month in `Asia/Seoul`.
One missing date, an impossible date, or a reversed range is rejected. To inspect
the resolved period without crawling or calling a model:

```sh
node scripts/report_period.mjs
```

Provider selection is explicit configuration: the Actions form defaults to Gemini;
the direct script retains its existing NVIDIA default. Set `REPORT_PROVIDER` to
the same value for equivalent local/Actions runs. Gemini uses `GEMINI_API_KEY`
and requires `GEMINI_FREE_TIER_CONFIRMED=true` after the project has been checked;
NVIDIA uses the existing `OPENAI_API_KEY` secret. Model settings
are `GEMINI_MODEL` / `NVIDIA_MODEL`; in Actions they, and the verifier, writer and
reviewer model settings, come from repository variables of the same name.

`REPORT_MAX_REQUESTS` (1–600), `REPORT_CONCURRENCY` (1–12), `REPORT_DELAY_MS`,
`REPORT_REFRESH`, `REPORT_REREVIEW`, and `REPORT_ISSUE_NUMBER` use the same implementation in both
environments. Progress lives in `outputs/review_work`; rerun the same period to
resume. `REPORT_REREVIEW=true` (the Actions `rereview` checkbox) discards saved
article reviews and reviews every article again; if that run pauses, rerun with it
off so the next run resumes instead of starting over. A review stopped by the request budget or a provider error exits with code 75 and does not publish new PDFs; articles that still fail evidence validation after retries no longer block the report and are marked as incomplete evidence.
Successful CLI runs update `outputs/latest_*.json` and both `public/reports` PDFs;
only Actions additionally commits the outputs. Python dependencies from
`requirements-python.txt` and Chrome/Edge are required to build the reports.

The retired `prepare-report-brief` and `build-report-from-brief` workflows called
missing scripts and have been removed. Use the automated command above, or the
API-free local workflow below.

### Local monthly report without model API calls

Ask Codex in this project to create a monthly report using
[`docs/local_report_review.md`](docs/local_report_review.md). Codex reads the article
files and saves reviews directly; no chat-to-JSON copy/paste is needed. Included
subscription usage limits still apply. The scripts themselves never call a model API.

```bash
# Reuse the checked-in collection (does not crawl or call a model). outputs/latest_* holds
# one month; from_date in outputs/latest_collection_summary.json says which.
npm run report:local -- prepare --month 2026-09

# For a new collection, add --collect. All output stays in a separate local directory.
npm run report:local -- prepare --month 2026-10 --collect

# Use the run_dir printed by prepare. Codex writes the pending article reviews.
npm run report:local -- status --run-dir RUN_DIR
npm run report:local -- build --run-dir RUN_DIR --python python3
```

`prepare` writes two documents next to the article files. `PROMPT.md` is the full
system instruction the API path sends, policy document included, so the local
reviewer judges under the same rules as the model. `REVIEW.md` is the policy
document on its own, for reading the criteria without the surrounding
instruction. Changing the instruction changes the article ids, so reviews written
under an older instruction are not reused.

Preparation filters the report month before review and groups candidates by target
company and article. Reviews are reused only for matching evidence and policy.
All candidates need decisions; only approved rows need bilingual report prose.
Build rejects missing, stale, contradictory, or ungrounded approvals and reuses
the existing report validator and HTML/Chrome PDF renderer with a Python data model. Install
`requirements-python.txt` in the selected Python environment before building.
Each successful build produces Korean/English PDFs and a complete decision log in
a new `outputs/local_reports/.../report-*` folder. Existing dashboard outputs and
published PDFs are not overwritten. A Codex task must perform the review step;
`prepare` alone does not generate AI decisions.

Validate that the PDF page 2 list matches `data/target_companies.json`. The script
reads the Issue 2 reference PDF committed in `docs/`; pass another file with
`-- --pdf "<path>"`. Output goes to the ignored `outputs/pdf_verify/`.

```bash
npm run validate:pdf
```

Run a full 77-company collection test with Node.js and no package install:

```bash
node --use-system-ca scripts/collect_company_signals.mjs --companies data/target_companies.json --source-config config/company_sources.json --out-dir outputs --sources official_feeds,official_pages,official_sitemaps,sec_filings,google_news --days 45 --max-per-source 3 --max-per-company 4 --fallback-mode missing --fallback-min-results 1 --rate-limit-seconds 0.5
```

Official RSS/Atom feeds and official Newsroom/Press/IR pages are read first. Google News is used only when a company has no official result in the run.

Build the company-to-technology mapping from the reference company-information PDF
(not in the repository; pass its path):

```bash
npm run build:technology-map -- --pdf "<path to the company information PDF>"
```

The shared report-input validator can also be run on its own:

```bash
npm run validate:report-inputs
```

Manual workflow runs use the previous completed calendar month when `from_date` and `to_date` are blank. Supplying only one date, an invalid date, or a reversed range stops the run.

## Output Schema

Each collected row is normalized to:

- `target_no`
- `company`
- `title`
- `url`
- `source`
- `published_at`
- `collected_at`
- `collector`
- `query`
- `source_type`
- `source_priority`
- `official_source_url`

`latest_company_signals.json` is overwritten on each run for dashboard/API consumption.
The monthly review also writes `latest_relevant_signals.json` (technology-related
candidates), `latest_investment_signals.json` and their summaries, and stage 2 writes
`latest_ai_summary_summary.json` (issue number, period, writer and reviewer results).
Only these JSON files and the two PDFs are committed.

AI-evaluated report rows additionally include `ai_entity_supported`, `ai_target_technology_supported`, `ai_indicator_supported`, `ai_leading_indicator_supported`, `ai_event_stage`, `ai_signal_supported`, `ai_summary_quality`, bilingual summaries, and a decision reason. Older cached rows that lack these fields are invalid report inputs and must be regenerated.

## Vercel

The web app uses Next.js. Its PDF download renders the same HTML report as
Actions and prints it with `puppeteer-core` and `@sparticuz/chromium-min`. The
browser is not bundled: a cold start downloads the Chromium pack named in
`app/lib/report_pdf.mjs` (override with `CHROMIUM_PACK_URL`), whose version must
match the pinned `@sparticuz/chromium-min`. The report content (view model) comes
from the separate `api/report-view-model.py` function, which uses root
`requirements.txt`. Monthly collection/review runs in Actions or locally.

The download needs an issue number and only covers the period of the deployed
`outputs/latest_*` data; other months are refused with HTTP 400. The deployment
relies on Vercel Deployment Protection; the API routes have no authentication of their own.

## Versions and tests

Node 22 and Python 3.12 (`.nvmrc`, `.python-version`, `engines`), the same as the
Actions workflows. Python packages are pinned: `requirements.txt` for the Vercel
function, `requirements-python.txt` (which includes it) for everything else.

```bash
npm test
python -m pip install -r requirements-python.txt
python -m unittest discover tests
```

`.github/workflows/test.yml` runs both suites on pushes to `main` and on pull requests.
Without reportlab some Node tests that call Python are skipped locally; in CI they fail instead.


### Signal review policy (September 2026 correction)

Local preparation now includes **every dated source article in the requested month**, even if the technology or indicator keyword filters rejected it. Each article is checked against all five indicators and the business-activity criteria. This increases review coverage; it does not approve a keyword match automatically.

`ai_event_stage=precursor` denotes a verified enabling activity under indicators 1, 3, 4 or 5 (supply-chain action, investment financing, specific R&D collaboration or strategic personnel activity). Its announcement may be complete while a final investment remains unconfirmed. Final committed/completed investment projects remain excluded, and production expansion (indicator 2) cannot use `precursor`. Entity and technology requirements remain in force. The investment API prompt version is bumped to invalidate old decisions; local policy fingerprints also change.

A local build keeps the dated-but-unconfirmed rows in `date_pending.json` in the run folder. Missing monthly sources and `needs_review` evidence are distinguished from reviewed negative results in the matrix counts. Google News fallback now checks usable monthly evidence **after** official detail/date enrichment. Live collection success still depends on the source sites.

### GitHub Actions로 월간 보고서 실행

두 워크플로를 차례로 실행한다. 무료 등급 하루 한도를 나눠 쓰도록 보통 이틀에 걸쳐 돌린다.

1. `collect-company-signals`(대시보드 버튼과 같음): 제공자와 기간을 골라 수집·판정·2차 검증을 한다.
   수동 실행은 `auto_publish`가 꺼져 있어 판정만 한다. 켜면(대시보드 버튼은 항상 켠다) 판정이 끝났을 때 같은 기간·호수로
   `publish-report`를 이어서 실행한다.
   요청 한도에는 재시도가 포함되며, 한도에 도달하면 진행분을 저장하고 중단한다. 같은 기간으로
   다시 실행하면 유효한 판정을 재사용한다. 판정이 끝나면 실행 요약에 "Judgement complete"가 나온다.
   이 단계는 PDF를 만들거나 커밋하지 않는다.
2. `publish-report`: 같은 기간으로 실행한다(둘 다 비워 두면 지난달). 끝난 판정을 이어받아 보고서
   문안을 쓰고 한·영 PDF를 만들어 커밋한다. 판정이 끝나지 않았으면 문안을 쓰지 않고 멈춘다.
   문안 모델이 할당량으로 멈추면 쓴 문안은 저장되므로 다시 실행하면 이어서 쓴다.
   문안을 쓴 뒤 검토 모델(`gemini-3.5-flash-lite`, 저장소 변수 `GEMINI_REVIEWER_MODEL=off`로 끔)이 시제·근거 없는 사실·
   없는 한국어 용어·한영 불일치를 짚는다. 보고서에 실리는 문안의 시제 지적과 투자 시그널 카드의 근거 지적은
   문안 모델에게 돌려 한 번 다시 쓰게 한다. 다시 쓴 문안은 다시 검토하지 않고, 실행 요약에 다시 확인하지 않은
   카드 수로 적는다(`summary_reviewer.unchecked`). 검토 지적만으로 항목을 빼지는 않으며, 나머지 지적은 기록만 한다.
   지적은 실행 요약과 `outputs/latest_ai_summary_summary.json`의 `summary_reviewer`에 남는다.

두 워크플로는 같은 동시 실행 그룹이라 한쪽이 도는 동안 다른 쪽은 기다린다. GitHub 는 그룹마다 대기 실행을
하나만 두므로, 대시보드는 실행이 대기 중이거나 도는 동안 새 실행을 보내지 않는다.
수동 실행에서 `auto_publish` 를 켜면 `issue_number` 도 넣어야 한다(기본값 없음).
