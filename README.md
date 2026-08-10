# Company Signal Collector

Stage 1 only: extract the 77 target companies from the Invest KOREA PDF and collect public news, press-release, and IR-like signals into normalized JSON/CSV.

## Files

- `data/target_companies.json`: canonical 77-company target list from PDF page 2.
- `data/target_companies.csv`: spreadsheet-friendly version of the same list.
- `data/company_technology_map.json`: 77-company target technology mapping from the reference PDF.
- `data/company_technology_map.csv`: spreadsheet-friendly version of the technology mapping.
- `config/company_sources.json`: official Newsroom/Press/IR source catalog by company.
- `config/technology_keywords.json`: broad Korean/English synonym keyword catalog for relevance filtering.
- `.github/workflows/collect-company-signals.yml`: manual GitHub Actions workflow for on-demand collection.
- `app/`: Vercel dashboard and API routes for the `크롤링 수행` button.
- `scripts/extract_pdf_companies.py`: validates PDF page 2 against the canonical list.
- `scripts/build_company_technology_map.py`: extracts and normalizes company-to-technology mapping from the reference PDF.
- `scripts/collect_company_signals.mjs`: collects signals from official feeds, Google News RSS, and GDELT without third-party packages.
- `scripts/filter_relevant_signals.mjs`: filters collected signals to target-technology-related items.
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
node --use-system-ca scripts/collect_company_signals.mjs --companies data/target_companies.json --source-config config/company_sources.json --out-dir outputs --sources official_feeds,official_pages,google_news --days 45 --max-per-source 3 --max-per-company 4 --fallback-mode missing --fallback-min-results 1 --rate-limit-seconds 0.5
```

Official RSS/Atom feeds and official Newsroom/Press/IR pages are read first. Google News is used only when a company has no official result in the run. GDELT is also implemented as `gdelt`, but its public endpoint can return rate-limit responses unless requests are spaced at roughly 5 seconds or more.

Build the company-to-technology mapping from the reference PDF:

```bash
python scripts/build_company_technology_map.py --pdf "C:/Users/buy4u/Downloads/전체 기업 정보_참고용_최종.pdf" --targets data/target_companies.json --keywords config/technology_keywords.json --out-json data/company_technology_map.json --out-csv data/company_technology_map.csv
```

Filter the latest collected signals to only target-technology-related candidates:

```bash
node scripts/filter_relevant_signals.mjs --signals outputs/latest_company_signals.json --technology-map data/company_technology_map.json --keyword-config config/technology_keywords.json --out-dir outputs --threshold 1
```

The relevance filter uses broad Korean/English synonyms and excludes these companies from relevance analysis by request: `Prodrive`, `JSR`, `Applied Materials`, `Amkor Technology`, `Heraeus`, `Toray`, `3M`, `Air Liquide`, `Air Products`.

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

## Vercel

This repository now contains a minimal Next.js app, so Vercel should detect it as a Next.js project. If Vercel previously detected the repository as Python, redeploy after committing the new `package.json`, `app/`, and removed root `requirements.txt`.
