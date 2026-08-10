# Company Signal Collector

Stage 1 only: extract the 77 target companies from the Invest KOREA PDF and collect public news, press-release, and IR-like signals into normalized JSON/CSV.

## Files

- `data/target_companies.json`: canonical 77-company target list from PDF page 2.
- `data/target_companies.csv`: spreadsheet-friendly version of the same list.
- `config/company_sources.json`: optional verified official RSS/Atom feeds by company.
- `.github/workflows/collect-company-signals.yml`: manual GitHub Actions workflow for on-demand collection.
- `app/`: Vercel dashboard and API routes for the `크롤링 수행` button.
- `scripts/extract_pdf_companies.py`: validates PDF page 2 against the canonical list.
- `scripts/collect_company_signals.mjs`: collects signals from official feeds, Google News RSS, and GDELT without third-party packages.
- `scripts/collect_company_signals.py`: Python equivalent; use it only when the local Python SSL stack supports outbound HTTPS.
- `outputs/`: generated JSON/CSV results.

See `docs/github_vercel_button_workflow.md` for the GitHub upload, Vercel deployment, and button-trigger workflow.

## Commands

Validate that the PDF page 2 list matches `data/target_companies.json`:

```bash
python scripts/extract_pdf_companies.py --pdf "C:/Users/buy4u/Desktop/KOTRA/AX 과제/Invest_KOREA_기업 글로벌 시그널_2.pdf" --page 2 --expected data/target_companies.json --out-dir outputs
```

Run a full 77-company collection test with Node.js and no package install:

```bash
node --use-system-ca scripts/collect_company_signals.mjs --companies data/target_companies.json --source-config config/company_sources.json --out-dir outputs --sources official_feeds,google_news --days 45 --max-per-source 3 --max-per-company 6 --rate-limit-seconds 1.0
```

GDELT is also implemented as `gdelt`, but its public endpoint can return rate-limit responses unless requests are spaced at roughly 5 seconds or more. Use it for slower scheduled enrichment, not for a fast smoke test.

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

`latest_company_signals.json` and `latest_company_signals.csv` are overwritten on each run for easy dashboard/API consumption.

## Vercel

This repository now contains a minimal Next.js app, so Vercel should detect it as a Next.js project. If Vercel previously detected the repository as Python, redeploy after committing the new `package.json`, `app/`, and removed root `requirements.txt`.
