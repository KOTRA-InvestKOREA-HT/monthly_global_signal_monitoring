# GitHub Actions + Vercel Button Workflow

## Monthly report path

```text
Vercel button → POST /api/trigger-crawl → collect-company-signals workflow
                                            ↓
                                  scripts/review_report.mjs
                                            ↑
                     npm run collect:all / npm run report:review

collect/resume → review all monthly article candidates → validate
→ Korean/English PDFs → latest JSON/PDF files
```

The automated CLI and Actions use the same collection options, candidate builder,
review validation, cache, and bilingual PDF builder. Keyword matching does not
remove articles from the monthly review queue. Provider/model selection remains
configuration; set the same values when comparing local and Actions results.

`prepare-report-brief` and `build-report-from-brief` were removed because their
brief/merge scripts no longer exist. For review without a model API, use
`npm run report:local` with [the local review instructions](local_report_review.md).
`link-policy-trial` remains an independent collection diagnostic; it does not
call a model API or publish reports.

## Actions inputs and credentials

Run `.github/workflows/collect-company-signals.yml` with:

- `from_date` and `to_date`: both supplied, or both blank for the previous completed
  calendar month in `Asia/Seoul`. `scripts/report_period.mjs` validates the dates
  before the period is used in a cache key.
- `provider`: `gemini` (the form default) or `nvidia`.
- `issue_number`: the number on both PDFs.
- `max_requests`: 1–400 including retries; `concurrency`: 1–12.
- `delay_ms`: blank uses the provider default; `refresh`: false resumes usable work.
- `days`: retained for compatibility with the existing dashboard dispatch. The
  monthly pipeline uses the explicit/resolved date range, not this legacy input.

For Gemini, configure repository secret `GEMINI_API_KEY` and the existing
`GEMINI_FREE_TIER_CONFIRMED` repository variable. The latter must be `true` only
once the corresponding project has been checked. For NVIDIA, the existing
repository secret named `OPENAI_API_KEY` contains the NVIDIA build key.

CLI runs use the same environment-variable names as the workflow's review step.
The direct script retains its NVIDIA default, so explicitly set
`REPORT_PROVIDER=gemini` to match the Actions form default. Local model overrides
are `GEMINI_MODEL` and `NVIDIA_MODEL`; they are not new Actions form inputs.
See [README commands](../README.md#automated-monthly-report-cli-and-github-actions)
for the PowerShell example and prerequisites.

## Resume, validation, and publication

Review progress is stored in `outputs/review_work`. Actions restores and saves
this directory using a cache keyed by reporting period, and uploads progress as
an artifact even if review stops. Valid decisions are reused only when their
article evidence and policy/provider identity match.

If the run reaches its request budget or has unresolved review errors, the shared
script exits with code 75 and leaves the published PDFs in place. A successful
run validates decisions and builds both PDFs before copying final results to:

```text
outputs/latest_company_signals.json
outputs/latest_collection_summary.json
outputs/latest_relevant_signals.json
outputs/latest_relevance_summary.json
outputs/latest_investment_signals.json
outputs/latest_investment_signal_summary.json
outputs/latest_ai_summary_summary.json
public/reports/latest_report.pdf
public/reports/latest_report_en.pdf
```

Actions validates the resulting input files again, uploads the PDFs, and commits
the latest JSON and both PDFs. Local CLI runs update these local files but do not
commit them. The workflow needs repository Contents write permission for that
final commit. Article collection also maintains diagnostic CSVs in its work area;
the workflow does not publish updated top-level CSVs as report artifacts.

## Existing Vercel integration

The Next.js button routes use:

```text
GITHUB_TOKEN
GITHUB_OWNER
GITHUB_REPO
GITHUB_WORKFLOW_FILE=collect-company-signals.yml
GITHUB_REF=main
```

The server-side token needs access to dispatch Actions and read repository data.
The API sends `days`, `from_date`, `to_date`, and `issue_number` to the existing
workflow. This input contract is retained by the cleanup.

`GET /api/signals` reads the latest JSON from GitHub when configured, with local
files as the unconfigured fallback. PDF delivery still uses files from the web
app's deployment; shared versioning between dashboard data and PDFs is a separate
remaining task.

The web app uses Next.js and the separate Python function `api/report-dynamic.py`.
Keep root `requirements.txt` for that function; `requirements-python.txt` supplies
the additional collection/report tools used locally and in Actions.

Vercel deployment is currently paused because of storage usage. This workflow
cleanup does not resume deployment, delete existing deployments, or change the
account's current storage usage.
