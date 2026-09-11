# Automation Notes

## Supported execution paths

- Automated monthly report: `npm run collect:all`, `npm run report:review`, and
  `.github/workflows/collect-company-signals.yml` all run `scripts/review_report.mjs`.
- Local review without model API calls: `npm run report:local`; follow
  [local_report_review.md](local_report_review.md).
- Collection diagnostics: `.github/workflows/link-policy-trial.yml` collects and
  audits links in a separate work directory without model calls or publication.

The old brief preparation/merge workflows were removed on 2026-09-11 because the
scripts they invoked were absent. Do not recreate the old filter → row-summary
chain as the automated report path: it drops keyword misses before article review.
The standalone keyword classifiers and old summarizer remain diagnostic tools.

## Shared monthly contract

`REPORT_FROM_DATE` and `REPORT_TO_DATE` are resolved by `scripts/report_period.mjs`.
Both blank means the previous completed month in `Asia/Seoul`; partial, impossible,
or reversed dates fail. The Actions cache step and the report script share this
resolver. `days` remains an accepted legacy Actions input for the existing button.

Collection runs first or resumes valid cached results. The shared candidate builder
checks monthly article evidence against all five investment indicators and business
activity criteria. Approved decisions must pass validation before the shared builder
produces both Korean and English PDFs. Incomplete review does not publish new PDFs.

Use the same provider/model and period when comparing CLI and Actions runs. CLI
retains its NVIDIA default; the Actions form defaults to Gemini. Credentials,
request budgets, and concurrency are configuration, not separate pipelines.

The monthly report needs no continuously running crawler. Actions handles collection
and review; Vercel handles the existing dashboard, dispatch, and PDF endpoints.
See [github_vercel_button_workflow.md](github_vercel_button_workflow.md) for the
current inputs, cache behavior, and published files. That file and the workflow
are the maintained instructions; there is no second workflow template here.
