# GitHub Actions + Vercel Button Workflow

## Current Local Folder

Current working folder:

```text
C:\Users\buy4u\OneDrive\문서\ChatGPT\AX 과제
```

This folder should become the GitHub repository root.

## Target Architecture

```text
Vercel dashboard button
  -> Vercel API route
  -> GitHub Actions workflow_dispatch
  -> scripts/collect_company_signals.mjs
  -> outputs/latest_company_signals.json
  -> outputs/latest_company_signals.csv
  -> Vercel dashboard reads latest output
```

The crawler does not run continuously. It runs only when the user clicks the button.

## What To Upload To GitHub

Upload the whole project folder to GitHub, including:

```text
.github/workflows/collect-company-signals.yml
config/company_sources.json
data/target_companies.json
data/target_companies.csv
docs/automation_notes.md
docs/github_vercel_button_workflow.md
outputs/latest_collection_summary.json
outputs/latest_company_signals.csv
outputs/latest_company_signals.json
package.json
README.md
next.config.mjs
app/layout.jsx
app/page.jsx
app/globals.css
app/api/signals/route.js
app/api/trigger-crawl/route.js
requirements-python.txt
scripts/collect_company_signals.mjs
scripts/collect_company_signals.py
scripts/extract_pdf_companies.py
```

Do not upload the source PDF unless you explicitly want it in the repository. The verified 77-company list is already stored in `data/target_companies.json` and `data/target_companies.csv`.

Recommended: upload the generated `outputs/latest_*` files so Vercel has data to show before the first button-triggered run completes.

## What To Deploy To Vercel

Deploy the web dashboard application from the same GitHub repository.

Vercel should host the Next.js files in this repository:

```text
Dashboard UI
API route that triggers GitHub Actions
API route or static fetch logic that reads outputs/latest_company_signals.json
```

Vercel should not be responsible for crawling 77 companies directly in this model. It only starts the GitHub Actions run and displays the latest collected files.

## GitHub Setup Steps

1. Create a new GitHub repository.

2. Upload this folder as the repository root.

3. Confirm this workflow exists in GitHub:

```text
.github/workflows/collect-company-signals.yml
```

4. Open GitHub repository settings:

```text
Settings -> Actions -> General -> Workflow permissions
```

5. Set workflow permissions to:

```text
Read and write permissions
```

This allows the workflow to commit updated `outputs/*.json` and `outputs/*.csv` files back to the repository.

6. Test the workflow manually:

```text
Actions -> collect-company-signals -> Run workflow
```

Use `days = 45` for the first test.

7. After the workflow finishes, confirm these files were updated:

```text
outputs/latest_collection_summary.json
outputs/latest_company_signals.csv
outputs/latest_company_signals.json
```

## GitHub Token For Vercel Button

To let a Vercel button trigger GitHub Actions, create a GitHub fine-grained personal access token or GitHub App token.

Minimum required access:

```text
Repository: target repository only
Actions: Read and write
Contents: Read
Metadata: Read
```

Store the token only in Vercel environment variables. Do not expose it to browser JavaScript.

## Vercel Environment Variables

Add these in Vercel:

```text
GITHUB_TOKEN=your_github_token
GITHUB_OWNER=your_github_username_or_org
GITHUB_REPO=your_repository_name
GITHUB_WORKFLOW_FILE=collect-company-signals.yml
GITHUB_REF=main
```

Optional:

```text
DEFAULT_CRAWL_DAYS=45
```

## Vercel API Route Shape

The future dashboard button should call a server-side API route like:

```text
POST /api/trigger-crawl
```

That API route should call GitHub:

```text
POST https://api.github.com/repos/{owner}/{repo}/actions/workflows/{workflow_file}/dispatches
```

Request body:

```json
{
  "ref": "main",
  "inputs": {
    "days": "45"
  }
}
```

Expected GitHub response:

```text
204 No Content
```

The button should show a "crawl started" state after receiving 204. The actual crawl result appears after GitHub Actions finishes and commits the updated output files.

## Dashboard Data Loading

The dashboard can read the latest data from:

```text
outputs/latest_company_signals.json
outputs/latest_collection_summary.json
```

The current dashboard uses the Vercel API route `GET /api/signals` to read the latest output files from GitHub at runtime. This avoids needing a Vercel redeploy after every crawl.

If you later change to fully static data loading, use one of these:

1. Trigger a Vercel redeploy after GitHub Actions commits new output files.
2. Fetch the raw GitHub file at runtime from a Vercel API route.
3. Store crawl results in a database later.

For this MVP, option 2 is already implemented.

## Recommended Work Order

1. Upload this folder to GitHub.
2. Enable GitHub Actions write permission.
3. Run `collect-company-signals` manually in GitHub Actions.
4. Confirm `outputs/latest_*` files update.
5. Create the Vercel project from the GitHub repository.
6. Add the GitHub token and repository environment variables in Vercel.
7. Deploy the Next.js dashboard.
8. Click the `크롤링 수행` button in Vercel.
9. Confirm a new GitHub Actions run starts.
10. After the run finishes, click `새로고침` in the dashboard.
11. Later, refine blocked or low-yield official pages in `config/company_sources.json`.

## AI Summary Setup

To show Korean 2-3 line evidence summaries in the dashboard and downloaded PDF, add a fresh OpenAI API key as the GitHub repository secret `OPENAI_API_KEY`.

Optional repository variables:

- `AI_SUMMARY_LUNA_MODEL`: first-pass summary model. Default: `gpt-5`.
- `AI_SUMMARY_TERRA_MODEL`: retry model for low-quality summaries. Default: `gpt-5.6`.

Do not place API keys in source files, workflow files, screenshots, or commit messages. If a key was pasted into a chat or screenshot, revoke it and create a new key before using it in GitHub Secrets.

## Vercel Python Entrypoint Error

If Vercel shows this error:

```text
No python entrypoint found
```

it means Vercel detected the repository as a Python project. Commit and push the Next.js files in `app/`, the updated `package.json`, and the removal of root `requirements.txt`. Then redeploy. The Python-only dependency list is now named `requirements-python.txt` so Vercel does not treat it as the web app runtime.

## Current Caveats

- The current collector uses Google News RSS by default and avoids search-result HTML scraping.
- GDELT support exists, but its public API can rate-limit aggressively, so it is not enabled in the default button workflow.
- Five companies had no recent Google News RSS results in the last full local run: `TIMET`, `Magnix`, `Heidenhain`, `EMM(Umicore)`, and `Shanghai Electric Wind Power`.
- Official newsroom, press, and IR pages are now listed in `config/company_sources.json`; blocked or low-yield pages should be refined gradually.
