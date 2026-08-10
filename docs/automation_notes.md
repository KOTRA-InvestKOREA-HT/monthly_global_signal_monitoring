# Automation Notes

This stage is designed to move into an on-demand run button without changing the collector.

## Recommended Execution Model

Use a manual trigger for collection. Keep Vercel for the dashboard/API layer.

Because collection only needs to run around the beginning of each month for the previous month's issue, a continuously scheduled crawler is unnecessary. A button can either:

- trigger a GitHub Actions `workflow_dispatch` run, then read the committed `outputs/latest_*` files after completion; or
- call a Vercel API route that runs the collector directly, if the run reliably completes within the Vercel Function duration limit.

The current full Google News RSS run took about 2 minutes locally, so direct Vercel execution may be acceptable for a lightweight on-demand MVP. If official feeds, GDELT enrichment, retries, or more companies are added, prefer GitHub Actions/manual workflow dispatch so the dashboard request does not stay open for the whole crawl.

## Manual GitHub Actions Shape

```yaml
name: collect-company-signals

on:
  workflow_dispatch:
    inputs:
      days:
        description: "Lookback window in days"
        required: false
        default: "45"

jobs:
  collect:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - run: >
          node --use-system-ca scripts/collect_company_signals.mjs
          --companies data/target_companies.json
          --source-config config/company_sources.json
          --out-dir outputs
          --sources official_feeds,google_news
          --days ${{ inputs.days || '45' }}
          --max-per-source 3
          --max-per-company 6
          --rate-limit-seconds 1.0
      - uses: stefanzweifel/git-auto-commit-action@v5
        with:
          commit_message: "Update company signal data"
          file_pattern: outputs/*.json outputs/*.csv
```

## Collection Policy

- Prefer RSS/Atom, official newsroom/IR feeds, search APIs, and search-engine feeds.
- Do not scrape search-result HTML.
- Keep per-request timeouts and a delay between requests.
- Add official feeds only after manually verifying that they are stable and allowed.
- Store raw run summaries so missing companies or source errors are visible.
