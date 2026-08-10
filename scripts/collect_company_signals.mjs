import fs from "node:fs/promises";
import path from "node:path";

const FIELDNAMES = [
  "target_no",
  "company",
  "title",
  "url",
  "source",
  "published_at",
  "collected_at",
  "collector",
  "query",
];

const SIGNAL_TERMS = [
  "\"press release\"",
  "\"investor relations\"",
  "earnings",
  "announcement",
  "investment",
  "expansion",
  "acquisition",
  "partnership",
  "Korea",
];

const USER_AGENT = "company-signal-monitor/0.1 (+https://github.com/your-org/company-signal-monitor)";

function parseArgs(argv) {
  const args = {
    companies: "data/target_companies.json",
    sourceConfig: "config/company_sources.json",
    outDir: "outputs",
    sources: "official_feeds,google_news",
    days: 45,
    maxPerSource: 3,
    maxPerCompany: 6,
    rateLimitSeconds: 1.0,
    timeoutSeconds: 20,
    companyLimit: 0,
  };
  const keyMap = {
    "--companies": "companies",
    "--source-config": "sourceConfig",
    "--out-dir": "outDir",
    "--sources": "sources",
    "--days": "days",
    "--max-per-source": "maxPerSource",
    "--max-per-company": "maxPerCompany",
    "--rate-limit-seconds": "rateLimitSeconds",
    "--timeout-seconds": "timeoutSeconds",
    "--company-limit": "companyLimit",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!keyMap[key]) continue;
    const mapped = keyMap[key];
    const value = argv[index + 1];
    index += 1;
    if (["days", "maxPerSource", "maxPerCompany", "timeoutSeconds", "companyLimit"].includes(mapped)) {
      args[mapped] = Number.parseInt(value, 10);
    } else if (mapped === "rateLimitSeconds") {
      args[mapped] = Number.parseFloat(value);
    } else {
      args[mapped] = value;
    }
  }
  return args;
}

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeXml(value = "") {
  return value
    .replace(/^<!\[CDATA\[/, "")
    .replace(/\]\]>$/, "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function cleanText(value = "") {
  return decodeXml(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function blocks(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"))].map(
    (match) => match[1],
  );
}

function tagText(block, tag) {
  const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? cleanText(match[1]) : "";
}

function parseDate(value) {
  if (!value) return null;
  const gdelt = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (gdelt) {
    return `${gdelt[1]}-${gdelt[2]}-${gdelt[3]}T${gdelt[4]}:${gdelt[5]}:${gdelt[6]}Z`;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function filterRecent(rows, days, collectedAt) {
  const cutoff = Date.parse(collectedAt) - days * 24 * 60 * 60 * 1000;
  return rows.filter((row) => {
    if (!row.published_at) return true;
    const published = Date.parse(row.published_at);
    return Number.isNaN(published) || published >= cutoff;
  });
}

async function fetchText(url, timeoutSeconds) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/rss+xml, application/atom+xml, application/json, text/xml;q=0.9, */*;q=0.8",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, timeoutSeconds) {
  return JSON.parse(await fetchText(url, timeoutSeconds));
}

function relevantAliases(company) {
  const names = [company.company];
  for (const alias of company.query_aliases || []) {
    const key = alias.toLowerCase();
    if (alias.length >= 5 && !["hydro", "maxon", "evonik"].includes(key)) {
      names.push(alias);
    }
  }
  return [...new Map(names.map((name) => [name.toLowerCase(), name])).values()].slice(0, 3);
}

function buildQuery(company, days) {
  const names = relevantAliases(company);
  let nameClause = names.map((name) => `"${name}"`).join(" OR ");
  if (names.length > 1) nameClause = `(${nameClause})`;
  return `${nameClause} (${SIGNAL_TERMS.join(" OR ")}) when:${days}d`;
}

function buildGdeltQuery(company) {
  const names = relevantAliases(company);
  let nameClause = names.map((name) => `"${name}"`).join(" OR ");
  if (names.length > 1) nameClause = `(${nameClause})`;
  const terms = SIGNAL_TERMS.filter((term) => term !== "Korea").join(" OR ");
  return `${nameClause} (${terms})`;
}

function parseRssOrAtom(xml, company, collectedAt, collector, query, defaultSource) {
  const rows = [];
  for (const item of blocks(xml, "item")) {
    const sourceText = tagText(item, "source");
    rows.push({
      target_no: company.target_no,
      company: company.company,
      title: tagText(item, "title"),
      url: tagText(item, "link"),
      source: sourceText ? `${defaultSource}: ${sourceText}` : defaultSource,
      published_at: parseDate(tagText(item, "pubDate")),
      collected_at: collectedAt,
      collector,
      query,
    });
  }
  for (const entry of blocks(xml, "entry")) {
    const linkMatch = entry.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i);
    rows.push({
      target_no: company.target_no,
      company: company.company,
      title: tagText(entry, "title"),
      url: linkMatch ? decodeXml(linkMatch[1]) : tagText(entry, "link"),
      source: defaultSource,
      published_at: parseDate(tagText(entry, "published") || tagText(entry, "updated")),
      collected_at: collectedAt,
      collector,
      query,
    });
  }
  return rows.filter((row) => row.title && row.url);
}

async function collectOfficialFeeds(company, sourceConfig, maxPerSource, timeoutSeconds, collectedAt) {
  const feeds = sourceConfig.official_feeds?.[company.company] || [];
  const rows = [];
  let requestCount = 0;
  for (const feed of feeds) {
    const feedUrl = typeof feed === "string" ? feed : feed.url;
    const sourceName =
      typeof feed === "string" ? `Official feed: ${company.company}` : feed.source || `Official feed: ${company.company}`;
    if (!feedUrl) continue;
    const xml = await fetchText(feedUrl, timeoutSeconds);
    requestCount += 1;
    rows.push(
      ...parseRssOrAtom(xml, company, collectedAt, "official_feed", feedUrl, sourceName).slice(0, maxPerSource),
    );
  }
  return { rows, requestCount };
}

async function collectGoogleNews(company, days, maxPerSource, timeoutSeconds, collectedAt) {
  const query = buildQuery(company, days);
  const params = new URLSearchParams({
    q: query,
    hl: "en-US",
    gl: "US",
    ceid: "US:en",
  });
  const xml = await fetchText(`https://news.google.com/rss/search?${params.toString()}`, timeoutSeconds);
  return {
    rows: filterRecent(
      parseRssOrAtom(xml, company, collectedAt, "google_news_rss", query, "Google News"),
      days,
      collectedAt,
    ).slice(0, maxPerSource),
    requestCount: 1,
  };
}

async function collectGdelt(company, days, maxPerSource, timeoutSeconds, collectedAt) {
  const query = buildGdeltQuery(company);
  const params = new URLSearchParams({
    query,
    mode: "ArtList",
    format: "json",
    maxrecords: String(maxPerSource),
    sort: "HybridRel",
    timespan: `${days}d`,
  });
  const payload = await fetchJson(`https://api.gdeltproject.org/api/v2/doc/doc?${params.toString()}`, timeoutSeconds);
  const rows = (payload.articles || [])
    .map((article) => ({
      target_no: company.target_no,
      company: company.company,
      title: cleanText(article.title || ""),
      url: article.url || "",
      source: `GDELT: ${article.domain || article.sourceCountry || "unknown"}`,
      published_at: parseDate(article.seendate),
      collected_at: collectedAt,
      collector: "gdelt_doc_api",
      query,
    }))
    .filter((row) => row.title && row.url);
  return { rows: filterRecent(rows, days, collectedAt).slice(0, maxPerSource), requestCount: 1 };
}

function dedupeRows(rows) {
  const seen = new Set();
  const deduped = [];
  for (const row of rows) {
    const urlKey = row.url.replace(/[?#].*$/, "").toLowerCase();
    const key = `${row.company.toLowerCase()}|${urlKey || row.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

function toCsv(rows) {
  const escapeCell = (value) => {
    const raw = value === null || value === undefined ? "" : String(value);
    return /[",\n\r]/.test(raw) ? `"${raw.replace(/"/g, "\"\"")}"` : raw;
  };
  return [FIELDNAMES.join(","), ...rows.map((row) => FIELDNAMES.map((field) => escapeCell(row[field])).join(","))].join(
    "\n",
  ) + "\n";
}

async function writeResults(rows, summary, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  const timestamp = summary.run_started_at.replace(/[-:]/g, "");
  const paths = {
    json: path.join(outDir, `company_signals_${timestamp}.json`),
    csv: path.join(outDir, `company_signals_${timestamp}.csv`),
    summary: path.join(outDir, `collection_summary_${timestamp}.json`),
    latest_json: path.join(outDir, "latest_company_signals.json"),
    latest_csv: path.join(outDir, "latest_company_signals.csv"),
    latest_summary: path.join(outDir, "latest_collection_summary.json"),
  };
  summary.outputs = paths;
  await fs.writeFile(paths.json, JSON.stringify(rows, null, 2) + "\n", "utf8");
  await fs.writeFile(paths.csv, "\ufeff" + toCsv(rows), "utf8");
  await fs.writeFile(paths.summary, JSON.stringify(summary, null, 2) + "\n", "utf8");
  await fs.writeFile(paths.latest_json, JSON.stringify(rows, null, 2) + "\n", "utf8");
  await fs.writeFile(paths.latest_csv, "\ufeff" + toCsv(rows), "utf8");
  await fs.writeFile(paths.latest_summary, JSON.stringify(summary, null, 2) + "\n", "utf8");
}

async function loadJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (fallback !== null && error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let companies = await loadJson(args.companies);
  const numbers = companies.map((company) => Number(company.target_no));
  if (numbers.length !== 77 || numbers.some((number, index) => number !== index + 1)) {
    throw new Error(`Expected target_no 1..77 in ${args.companies}`);
  }
  if (args.companyLimit > 0) {
    companies = companies.slice(0, args.companyLimit);
  }

  const sourceConfig = await loadJson(args.sourceConfig, {});
  const selectedSources = args.sources.split(",").map((source) => source.trim()).filter(Boolean);
  const collectedAt = utcNow();
  const rows = [];
  const errors = [];
  let requestCount = 0;

  for (const company of companies) {
    const companyRows = [];
    for (const source of selectedSources) {
      let result = { rows: [], requestCount: 0 };
      try {
        if (source === "official_feeds") {
          result = await collectOfficialFeeds(company, sourceConfig, args.maxPerSource, args.timeoutSeconds, collectedAt);
        } else if (source === "google_news") {
          result = await collectGoogleNews(company, args.days, args.maxPerSource, args.timeoutSeconds, collectedAt);
        } else if (source === "gdelt") {
          result = await collectGdelt(company, args.days, args.maxPerSource, args.timeoutSeconds, collectedAt);
        } else {
          throw new Error(`Unknown source: ${source}`);
        }
        companyRows.push(...result.rows);
        requestCount += result.requestCount;
      } catch (error) {
        errors.push({
          target_no: company.target_no,
          company: company.company,
          source,
          error: error.message,
        });
      }
      if (result.requestCount > 0) {
        await sleep(args.rateLimitSeconds * 1000);
      }
    }
    rows.push(...dedupeRows(companyRows).slice(0, args.maxPerCompany));
  }

  const finalRows = dedupeRows(rows);
  const countsByCompany = Object.fromEntries(companies.map((company) => [company.company, 0]));
  for (const row of finalRows) {
    countsByCompany[row.company] += 1;
  }

  const summary = {
    run_started_at: collectedAt,
    company_count: companies.length,
    canonical_company_count: 77,
    sources: selectedSources,
    days: args.days,
    max_per_source: args.maxPerSource,
    max_per_company: args.maxPerCompany,
    request_count: requestCount,
    result_count: finalRows.length,
    companies_with_results: Object.values(countsByCompany).filter((count) => count > 0).length,
    companies_without_results: Object.entries(countsByCompany)
      .filter(([, count]) => count === 0)
      .map(([company]) => company),
    counts_by_company: countsByCompany,
    error_count: errors.length,
    errors,
  };

  await writeResults(finalRows, summary, args.outDir);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
