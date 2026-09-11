# Company Signal Collector

Collect public news, press releases, and IR material for 77 target companies, classify investment signals, verify report evidence with AI, and publish Korean/English PDF reports plus a dashboard.

## Files

- `data/target_companies.json`: canonical 77-company target list from PDF page 2.
- `data/target_companies.csv`: spreadsheet-friendly version of the same list.
- `data/company_technology_map.json`: 77-company target technology mapping from the reference PDF.
- `data/company_technology_map.csv`: spreadsheet-friendly version of the technology mapping.
- `config/company_sources.json`: official Newsroom/Press/IR source catalog by company.
- `config/technology_keywords.json`: broad Korean/English synonym keyword catalog for relevance filtering.
- `config/date_evidence_sources.json`: publication-date evidence grades shared by the collector, the review path, the PDF builder, and the dashboard.
- `.github/workflows/collect-company-signals.yml`: manual GitHub Actions workflow for on-demand collection.
- `app/`: Vercel dashboard and API routes for the `크롤링 수행` button.
- `scripts/extract_pdf_companies.py`: validates PDF page 2 against the canonical list.
- `scripts/build_company_technology_map.py`: extracts and normalizes company-to-technology mapping from the reference PDF.
- `scripts/collect_company_signals.mjs`: collects signals from official feeds, Google News RSS, and GDELT without third-party packages.
- `scripts/filter_relevant_signals.mjs`: filters collected signals to target-technology-related items.
- `scripts/classify_investment_signals.mjs`: finds five investment-signal candidates with deterministic keyword rules.
- `scripts/review_report.mjs`: shared automated collection, article review, validation, and bilingual PDF pipeline.
- `scripts/report_period.mjs`: shared reporting-period resolver for the CLI and Actions.
- `scripts/summarize_signal_evidence.mjs`: legacy row-based summary tool, outside the monthly report pipeline.
- `scripts/validate_report_inputs.mjs`: rejects incomplete or contradictory AI decisions before report publication.
- `scripts/date_state.mjs`: the single definition of publication-date state (confirmed/estimated/unknown/conflicting) and what each state means for review and for the report.
- `scripts/build_pdf_report.py`: builds the Korean or English PDF after validation.
- `scripts/collect_company_signals.py`: Python equivalent; use it only when the local Python SSL stack supports outbound HTTPS.
- `outputs/`: generated JSON/CSV results.

See `docs/github_vercel_button_workflow.md` for the GitHub upload, Vercel deployment, and button-trigger workflow.
Publication-date handling — how a date is graded and what a date hold means for review and for the PDF — is recorded in `docs/date_criteria_2026-09-07.md`.
The implemented accuracy controls, verification evidence, known limitations, and Codex hook diagnosis are recorded in `docs/signal_accuracy_improvements_2026-09-03.md`.

## Commands

### Automated monthly report (CLI and GitHub Actions)

`npm run collect:all`, `npm run report:review`, and the
`collect-company-signals` workflow all execute `scripts/review_report.mjs`:

```text
Resolve period → collect/resume → review all monthly article candidates
→ validate decisions → build Korean/English PDFs → update latest report files
```

Keyword classification does not remove articles from this review queue. Each
reviewable article is checked against all five investment indicators and business
activity criteria; articles with insufficient date/body evidence remain deferred.

Set the provider and its credentials in the environment before running. For an
existing Gemini setup in PowerShell:

```powershell
$env:REPORT_PROVIDER = 'gemini'
# GEMINI_API_KEY and GEMINI_FREE_TIER_CONFIRMED must already be configured.
$env:REPORT_FROM_DATE = '2026-08-01'
$env:REPORT_TO_DATE = '2026-08-31'
$env:REPORT_ISSUE_NUMBER = '2'
npm run collect:all
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
are `GEMINI_MODEL` / `NVIDIA_MODEL`.

`REPORT_MAX_REQUESTS` (1–400), `REPORT_CONCURRENCY` (1–12), `REPORT_DELAY_MS`,
`REPORT_REFRESH`, and `REPORT_ISSUE_NUMBER` use the same implementation in both
environments. Progress lives in `outputs/review_work`; rerun the same period to
resume. An incomplete review exits with code 75 and does not publish new PDFs.
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
# Reuse the checked-in August 2026 collection (does not crawl or call a model).
npm run report:local -- prepare --month 2026-08

# For a new collection, add --collect. All output stays in a separate local directory.
npm run report:local -- prepare --month 2026-08 --collect

# Use the run_dir printed by prepare. Codex writes the pending article reviews.
npm run report:local -- status --run-dir RUN_DIR
npm run report:local -- build --run-dir RUN_DIR --python python3
```

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

Validate that the PDF page 2 list matches `data/target_companies.json`:

```bash
python scripts/extract_pdf_companies.py --pdf "C:/Users/buy4u/Desktop/KOTRA/AX 과제/Invest_KOREA_기업 글로벌 시그널_2.pdf" --page 2 --expected data/target_companies.json --out-dir outputs
```

Run a full 77-company collection test with Node.js and no package install:

```bash
node --use-system-ca scripts/collect_company_signals.mjs --companies data/target_companies.json --source-config config/company_sources.json --out-dir outputs --sources official_feeds,official_pages,google_news --days 45 --max-per-source 3 --max-per-company 4 --fallback-mode missing --fallback-min-results 1 --rate-limit-seconds 0.5
```

Official RSS/Atom feeds and official Newsroom/Press/IR pages are read first. Google News is used only when a company has no official result in the run. GDELT is also implemented as `gdelt`, but its public endpoint can return rate-limit responses unless requests are spaced at roughly 5 seconds or more.

Build the company-to-technology mapping from the reference PDF:

```bash
python scripts/build_company_technology_map.py --pdf "C:/Users/buy4u/Downloads/전체 기업 정보_참고용_최종.pdf" --targets data/target_companies.json --keywords config/technology_keywords.json --out-json data/company_technology_map.json --out-csv data/company_technology_map.csv
```

### Standalone keyword diagnostics and legacy summaries

The following tools remain available for focused analysis and older datasets.
They are not steps in `collect:all` or the Actions monthly report pipeline.
Their default paths overwrite diagnostic/latest files, so use a separate output
directory when comparing keyword rules against a published report.

Filter the latest collected signals to only target-technology-related candidates:

```bash
node scripts/filter_relevant_signals.mjs --signals outputs/latest_company_signals.json --technology-map data/company_technology_map.json --keyword-config config/technology_keywords.json --out-dir outputs --threshold 1
```

The relevance filter uses broad Korean/English synonyms and excludes these companies from relevance analysis by request: `Prodrive`, `JSR`, `Applied Materials`, `Amkor Technology`, `Heraeus`, `Toray`, `3M`, `Air Liquide`, `Air Products`.

Classify five investment-signal candidates:

```bash
node scripts/classify_investment_signals.mjs --signals outputs/latest_company_signals.json --technology-classification outputs/latest_signal_relevance_classification.json --indicator-config config/investment_signal_indicators.json --out-dir outputs --threshold 4 --require-technology-relevance true
```

Generate bilingual AI summaries and semantic support decisions for report evidence:

```bash
OPENAI_API_KEY=... node scripts/summarize_signal_evidence.mjs --investment-signals outputs/latest_investment_signals.json --relevant-signals outputs/latest_relevant_signals.json --out-dir outputs
```

This legacy summarizer uses Luna first and Terra for selected retries, with its
own `outputs/ai_summary_cache.json`. Its `AI_SUMMARY_*` settings and OpenAI API
credentials do not configure the monthly article-review pipeline. In particular,
the repository's existing `OPENAI_API_KEY` secret contains an NVIDIA key and
cannot be used as an OpenAI credential for this legacy tool.

The legacy summarizer fails without complete cached decisions or valid API
results. The shared validator can also be run independently:

```bash
node scripts/validate_report_inputs.mjs
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

`latest_company_signals.json` and `latest_company_signals.csv` are overwritten on each run for easy dashboard/API consumption.

The relevance filter also writes:

- `latest_relevant_signals.json`
- `latest_relevant_signals.csv`
- `latest_signal_relevance_classification.json`
- `latest_relevance_summary.json`

Each relevant row includes `target_technology`, `target_technology_en`, `technology_group`, `matched_terms`, `relevance_score`, `relevance_decision`, and `relevance_reason`.

AI-evaluated report rows additionally include `ai_entity_supported`, `ai_target_technology_supported`, `ai_indicator_supported`, `ai_leading_indicator_supported`, `ai_event_stage`, `ai_signal_supported`, `ai_summary_quality`, bilingual summaries, and a decision reason. Older cached rows that lack these fields are invalid report inputs and must be regenerated.

## Vercel

The web app uses Next.js; the separate `api/report-dynamic.py` function uses
root `requirements.txt`. Monthly collection/review runs in Actions or locally.
Changing the pipeline does not require resuming a paused Vercel deployment.


### Signal review policy (September 2026 correction)

Local preparation now includes **every dated source article in the requested month**, even if the technology or indicator keyword filters rejected it. Each article is checked against all five indicators and the business-activity criteria. This increases review coverage; it does not approve a keyword match automatically.

`ai_event_stage=precursor` denotes a verified enabling activity under indicators 1, 3, 4 or 5 (supply-chain action, investment financing, specific R&D collaboration or strategic personnel activity). Its announcement may be complete while a final investment remains unconfirmed. Final committed/completed investment projects remain excluded, and production expansion (indicator 2) cannot use `precursor`. Entity and technology requirements remain in force. The investment API prompt version is bumped to invalidate old decisions; local policy fingerprints also change.

A local build writes `coverage.json` alongside its PDFs. Missing monthly sources and `needs_review` evidence are distinguished from reviewed negative results in the matrix counts. Google News fallback now checks usable monthly evidence **after** official detail/date enrichment. Live collection success still depends on the source sites.

### GitHub Actions로 월간 보고서 실행

`collect-company-signals`에서 제공자와 기간을 선택하면 위 CLI와 같은 통합 검토를
수행한다. 요청 한도에는 재시도가 포함되며, 한도에 도달하면 진행분을 저장하고
중단한다. 같은 기간으로 다시 실행하면 유효한 판정을 재사용한다.
