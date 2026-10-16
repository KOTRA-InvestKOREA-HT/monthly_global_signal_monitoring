# Automation Notes

## Supported execution paths

- Automated monthly report, stage 1 (collect, judge, verify): `npm run report:review` and
  `.github/workflows/collect-company-signals.yml` both run `scripts/review_report.mjs`.
- Automated monthly report, stage 2 (write the copy, build and publish both PDFs):
  `npm run report:publish` and `.github/workflows/publish-report.yml` both run
  `scripts/publish_report.mjs` for the same period. The dashboard button runs stage 1
  with `auto_publish=true`, which starts stage 2 when the judgement finishes.
- Local review without model API calls: `npm run report:local`; follow
  [local_report_review.md](local_report_review.md).
- Collection diagnostics: `.github/workflows/link-policy-trial.yml` collects and
  audits links in a separate work directory without model calls or publication.
- Tests: `.github/workflows/test.yml` runs `node --test` and the Python unittest suite.

The old brief preparation/merge workflows were removed on 2026-09-11 because the
scripts they invoked were absent. Do not recreate the old filter → row-summary
chain as the automated report path: it drops keyword misses before article review.

## Shared monthly contract

`REPORT_FROM_DATE` and `REPORT_TO_DATE` are resolved by `scripts/report_period.mjs`.
Both blank means the previous completed month in `Asia/Seoul`; partial, impossible,
or reversed dates fail. The Actions cache step and the report scripts share this
resolver. `REPORT_ISSUE_NUMBER` has no default.

Collection runs first or resumes valid cached results. The shared candidate builder
checks monthly article evidence against all five investment indicators and business
activity criteria. Stage 1 saves the judgement only. Stage 2 writes the copy, and
approved decisions must pass validation before both Korean and English PDFs are
built. Incomplete review does not publish new PDFs.

Use the same provider/model and period when comparing CLI and Actions runs. CLI
retains its NVIDIA default; the Actions form defaults to Gemini. Credentials,
request budgets, and concurrency are configuration, not separate pipelines.

The monthly report needs no continuously running crawler. Actions handles collection,
review and publication; Vercel handles the dashboard, dispatch, and PDF download.
See [github_vercel_button_workflow.md](github_vercel_button_workflow.md) for the
current inputs, cache behavior, and published files. That file and the workflows
are the maintained instructions; there is no second workflow template here.
