# GitHub Actions + Vercel Button Workflow

## Monthly report path

```text
"크롤링 수행" button → POST /api/trigger-crawl → collect-company-signals (stage 1, auto_publish=true)
                                            ↓
                                  scripts/review_report.mjs
                                            ↑
                               npm run report:review

collect/resume → judge all monthly article candidates → verify → save judgement
                                            ↓  (only when the judgement finished and auto_publish is on)
publish-report workflow (stage 2)  ← also "발행만 실행" button (stage=publish) or a manual run
                                            ↓
                                  scripts/publish_report.mjs  ← npm run report:publish

take over the finished judgement → write Korean/English copy → Korean/English PDFs
→ latest JSON/PDF files
```

One press of the dashboard button runs both stages in series. It dispatches stage 1 with
`auto_publish=true`; when the judgement finishes, the workflow's last step dispatches
`publish-report` for the same resolved dates and issue number (`gh workflow run` with the
job's `GITHUB_TOKEN`, which needs `actions: write`; `workflow_dispatch` is the event a
`GITHUB_TOKEN` may start). Both workflows share one concurrency group, so stage 2 starts
after stage 1 has saved its progress cache. If stage 1 stops on its quota, no publish
starts; pressing the button again for the same month resumes the judgement.

A manual run of `collect-company-signals` leaves `auto_publish` off by default and only
judges. Run `publish-report` yourself, or press "발행만 실행" on the dashboard, when you
want the PDFs. Stage 1 judges and saves progress in the Actions cache; stage 2 restores
that cache, writes the report copy and commits the PDFs. Splitting them keeps the judge
call free of the wording rules. The copy writer uses `GEMINI_FOR_SUMMARY` when set; if that
key belongs to a different Google project from `GEMINI_API_KEY`, both stages fit in the
free tier on the same day. Otherwise an automatic publish may pause on quota and should be
resumed the next day with "발행만 실행". The automated CLI and Actions
use the same collection options, candidate builder, review validation, cache, and bilingual
PDF builder. Keyword matching does not remove articles from the monthly review queue.
Provider/model selection remains configuration; set the same values when comparing local
and Actions results.

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
- `issue_number`: the number on both PDFs. No default. Recorded with the judgement;
  `publish-report` uses it unless its own `issue_number` input is set, and fails without one.
  With `auto_publish` on, the run stops before judging when it is missing.
- `max_requests`: 1–600 including retries; `concurrency`: 1–12.
- `delay_ms`: blank uses the provider default; `refresh`: false resumes usable work.

For Gemini, configure repository secret `GEMINI_API_KEY` and the existing
`GEMINI_FREE_TIER_CONFIRMED` repository variable. The latter must be `true` only
once the corresponding project has been checked. For NVIDIA, the existing
repository secret named `OPENAI_API_KEY` contains the NVIDIA build key.

CLI runs use the same environment-variable names as the workflow's review step.
The direct script retains its NVIDIA default, so explicitly set
`REPORT_PROVIDER=gemini` to match the Actions form default. Local model overrides
are `GEMINI_MODEL` and `NVIDIA_MODEL`; in Actions they come from repository variables of the
same name, as do the verifier (`GEMINI_VERIFIER_*`), writer (`GEMINI_WRITER_*`) and copy
reviewer (`GEMINI_REVIEWER_*`) settings. They are not form inputs.
See [README commands](../README.md#automated-monthly-report-cli-and-github-actions)
for the PowerShell example and prerequisites.

## Resume, validation, and publication

Review progress is stored in `outputs/review_work`. Actions restores and saves
this directory using a cache keyed by reporting period, and uploads progress as
an artifact even if review stops. Valid decisions are reused only when their
article evidence and policy/provider identity match.

If stage 1 (`review_report.mjs`) reaches its request budget or stops on a provider
error, it exits with code 75 and the run is marked paused; nothing is published. When
every article has been tried and the only ones left failed evidence validation on each
retry, the judgement finishes without them: their companies are marked as incomplete
evidence and the articles are listed in `review_failed_articles` of the collection
summary. Stage 1 never builds PDFs or commits; it only saves the judgement in the cache.

Stage 2 (`publish_report.mjs`) restores that judgement, writes the copy, validates the
decisions and builds both PDFs (HTML printed by Chrome, `scripts/build_html_report.mjs`).
Only when both PDFs are built does it copy the final results to:

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

The `publish-report` workflow validates the resulting input files again, uploads the
PDFs as an artifact, moves onto the latest `main` and commits the latest JSON and both
PDFs. Local CLI runs update these local files but do not commit them. Only
`publish-report` needs Contents write permission.

## Existing Vercel integration

The Next.js button routes use:

```text
GITHUB_TOKEN
GITHUB_OWNER
GITHUB_REPO
GITHUB_WORKFLOW_FILE=collect-company-signals.yml
GITHUB_PUBLISH_WORKFLOW_FILE=publish-report.yml
GITHUB_REF=main
```

The server-side token needs access to dispatch Actions and read repository data.
"크롤링 수행" sends `from_date`, `to_date`, `issue_number` and `auto_publish=true`
to `collect-company-signals`. "발행만 실행" sends only `from_date`, `to_date` and
`issue_number` to `publish-report` (it defines no `auto_publish`; GitHub would answer 422).
The route refuses "크롤링 수행" with 409 while any run is queued or running (both workflows
share one concurrency group, and GitHub keeps only one pending run per group, so a new
judgement would cancel a waiting publish), refuses "발행만 실행" with 409 unless the latest
judgement run succeeded and no publish is running, and refuses either button without an
issue number. The dashboard also disables "크롤링 수행" while a run is active. The dashboard
fills the issue number from the last published issue (`outputs/latest_ai_summary_summary.json`):
the same issue for that month, one more for the next month, blank otherwise.

`GET /api/crawl-status` reads the latest run of both workflows and reports the newer one:
판정 중 / 판정 일시정지 / 판정 실패 / 판정 완료 / 발행 중 / 발행 일시정지 / 발행 실패 / 완료.
Exit code 75 (quota or provider pause) and a real error both end a run as `failure`, so
each workflow fails a pause through a step named `Paused - run again to resume`
(`PAUSED_STEP` in `app/lib/report_pipeline.mjs`); the route reads the run's jobs to tell
the two apart.

`GET /api/crawl-status` needs `GITHUB_TOKEN` as well as the owner and repository; without it
the status reads "설정 필요" instead of calling GitHub. `GET /api/trigger-crawl` opened in a
browser is a diagnostic: it shows only whether each setting exists and the GitHub status codes.

`GET /api/signals` reads the latest JSON from GitHub when configured, with local
files as the unconfigured fallback. The PDF download reads the `outputs/latest_*`
files shipped with the deployment, which hold one month: the dashboard limits the
download to that period and `/api/report` answers 400 for any other month, a missing
issue number, a half or reversed range, or a malformed ignore list.

The web app uses Next.js. `GET /api/report` renders the same HTML report as
Actions and prints it with `puppeteer-core` and `@sparticuz/chromium-min`, including
downloads with ignored signals. The browser pack is downloaded
at cold start rather than bundled, which keeps the route near its earlier size. The separate Python function
`api/report-view-model.py` computes the report content it renders.
Keep root `requirements.txt` for that function; `requirements-python.txt` includes it and
adds the PDF extraction tools used locally and in Actions. Both are pinned exactly.
