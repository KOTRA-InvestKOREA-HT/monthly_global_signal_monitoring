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
  "source_type",
  "source_priority",
  "official_source_url",
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

const USER_AGENT =
  "Mozilla/5.0 (compatible; CompanySignalMonitor/0.1; +https://github.com/buy4u49-ship-it/monthly_global_signal_monitoring)";

function parseArgs(argv) {
  const args = {
    companies: "data/target_companies.json",
    sourceConfig: "config/company_sources.json",
    outDir: "outputs",
    sources: "official_feeds,official_pages,google_news",
    days: 45,
    maxPerSource: 3,
    maxPerCompany: 6,
    fallbackMinResults: 1,
    fallbackMode: "missing",
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
    "--fallback-min-results": "fallbackMinResults",
    "--fallback-mode": "fallbackMode",
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
    if (["days", "maxPerSource", "maxPerCompany", "fallbackMinResults", "timeoutSeconds", "companyLimit"].includes(mapped)) {
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

function stripTracking(url) {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_)/i.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
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

function extractDateFromText(value = "") {
  const text = cleanText(value);
  const numeric = text.match(/\b(20\d{2})[./-](0?[1-9]|1[0-2])[./-](0?[1-9]|[12]\d|3[01])\b/);
  if (numeric) {
    return parseDate(`${numeric[1]}-${numeric[2].padStart(2, "0")}-${numeric[3].padStart(2, "0")}`);
  }
  const monthName = text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+([0-3]?\d),?\s+(20\d{2})\b/i,
  );
  if (monthName) {
    return parseDate(`${monthName[1]} ${monthName[2]}, ${monthName[3]}`);
  }
  const dayMonth = text.match(
    /\b([0-3]?\d)\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})\b/i,
  );
  if (dayMonth) {
    return parseDate(`${dayMonth[2]} ${dayMonth[1]}, ${dayMonth[3]}`);
  }
  return null;
}

function filterRecent(rows, days, collectedAt) {
  const cutoff = Date.parse(collectedAt) - days * 24 * 60 * 60 * 1000;
  const futureLimit = Date.parse(collectedAt) + 24 * 60 * 60 * 1000;
  return rows.filter((row) => {
    if (!row.published_at) return true;
    const published = Date.parse(row.published_at);
    return Number.isNaN(published) || (published >= cutoff && published <= futureLimit);
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
        Accept:
          "text/html, application/xhtml+xml, application/rss+xml, application/atom+xml, application/json, text/xml;q=0.9, */*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,ko;q=0.7",
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
  const isOfficialCollector = collector.startsWith("official_");
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
      source_type: isOfficialCollector ? "official" : "fallback",
      source_priority: isOfficialCollector ? 10 : 90,
      official_source_url: isOfficialCollector ? query : "",
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
      source_type: isOfficialCollector ? "official" : "fallback",
      source_priority: isOfficialCollector ? 10 : 90,
      official_source_url: isOfficialCollector ? query : "",
    });
  }
  return rows.filter((row) => row.title && row.url);
}

function parseAnchors(html, baseUrl) {
  const anchors = [];
  const anchorRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorRegex)) {
    const attrs = match[1] || "";
    const hrefMatch = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    const href = decodeXml(hrefMatch[1]).trim();
    if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) continue;
    try {
      anchors.push({
        url: stripTracking(new URL(href, baseUrl).toString()),
        title: cleanText(match[2]),
        context: cleanText(
          html.slice(Math.max(0, match.index - 260), Math.min(html.length, match.index + match[0].length + 260)),
        ),
      });
    } catch {
      continue;
    }
  }
  return anchors;
}

function isGenericOfficialTitle(title) {
  return /^(read more|see more\b.*|learn more|more|news release|press release|share price info|view details)$/i.test(title);
}

function titleFromUrl(url) {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const last = segments.reverse().find((segment) => !/^(default|index|news|press|releases?|details?|en|global|ir)$/i.test(segment));
    if (!last) return "";
    const cleaned = decodeURIComponent(last)
      .replace(/\.(html?|aspx|php)$/i, "")
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return cleaned.length >= 16 ? cleaned : "";
  } catch {
    return "";
  }
}

function officialTitle(anchor) {
  if (!isGenericOfficialTitle(anchor.title)) return anchor.title;
  return titleFromUrl(anchor.url);
}

function discoverFeedLinks(html, baseUrl) {
  const urls = [];
  const linkRegex = /<link\b([^>]*)>/gi;
  for (const match of html.matchAll(linkRegex)) {
    const attrs = match[1] || "";
    if (!/(application\/rss\+xml|application\/atom\+xml|rss|atom|feed)/i.test(attrs)) continue;
    const hrefMatch = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    const href = decodeXml(hrefMatch[1]);
    if (/xmlrpc\.php|rsd/i.test(href)) continue;
    try {
      urls.push(stripTracking(new URL(href, baseUrl).toString()));
    } catch {
      continue;
    }
  }
  for (const anchor of parseAnchors(html, baseUrl)) {
    if (/(rss|atom|feed)/i.test(`${anchor.title} ${anchor.url}`)) {
      urls.push(anchor.url);
    }
  }
  return [...new Set(urls)].slice(0, 3);
}

function isRelevantOfficialLink(anchor, pageUrl) {
  const title = officialTitle(anchor);
  const direct = `${title} ${anchor.url}`.toLowerCase();
  const detectedDate = extractDateFromText(`${anchor.title} ${anchor.context} ${anchor.url}`);
  if (title.length < 8) return false;
  if (!detectedDate) return false;
  if (/\.(jpg|jpeg|png|gif|svg|webp|mp4|zip)$/i.test(anchor.url)) return false;
  if (/privacy|cookie|terms|subscribe|contact|career|linkedin|facebook|twitter|youtube|instagram/i.test(direct)) {
    return false;
  }
  if (
    /^(investor relations home|corporate governance|corporate directory|corporate citizenship|management|contact us|about us|products?|solutions?|careers?)$/i.test(
      title,
    )
  ) {
    return false;
  }
  const keywords =
    /press|release|news|financial|results|earnings|quarter|annual|report|presentation|announcement|acquisition|expansion|partnership|investment|korea|plant|facility|manufactur/i;
  if (keywords.test(direct)) return true;
  try {
    const sourceHost = new URL(pageUrl).hostname.replace(/^www\./, "");
    const targetHost = new URL(anchor.url).hostname.replace(/^www\./, "");
    return (
      sourceHost === targetHost &&
      /\/(news|press|release|media|investor|ir|financial|results|announcements?)\b/i.test(new URL(anchor.url).pathname)
    );
  } catch {
    return false;
  }
}

function normalizeOfficialPageEntries(entries) {
  return entries
    .map((entry) => {
      if (typeof entry === "string") {
        return { url: entry, source: "Official page", kind: "official_page" };
      }
      return {
        url: entry.url,
        source: entry.source || "Official page",
        kind: entry.kind || "official_page",
      };
    })
    .filter((entry) => entry.url);
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

async function collectOfficialPages(company, sourceConfig, days, maxPerSource, timeoutSeconds, collectedAt) {
  const pages = normalizeOfficialPageEntries(sourceConfig.official_pages?.[company.company] || []);
  const rows = [];
  const errors = [];
  let requestCount = 0;
  for (const page of pages) {
    try {
      const html = await fetchText(page.url, timeoutSeconds);
      requestCount += 1;
      for (const feedUrl of discoverFeedLinks(html, page.url)) {
        try {
          const feedXml = await fetchText(feedUrl, timeoutSeconds);
          requestCount += 1;
          rows.push(
            ...filterRecent(
              parseRssOrAtom(feedXml, company, collectedAt, "official_feed_discovered", feedUrl, `${page.source} RSS`),
              days,
              collectedAt,
            ).slice(0, maxPerSource),
          );
        } catch (error) {
          errors.push({ source_url: feedUrl, source_name: `${page.source} RSS`, error: error.message });
        }
      }
      const anchors = parseAnchors(html, page.url).filter((anchor) => isRelevantOfficialLink(anchor, page.url));
      const sourceRows = dedupeRows(
        anchors.map((anchor) => ({
          target_no: company.target_no,
          company: company.company,
          title: officialTitle(anchor),
          url: anchor.url,
          source: page.source,
          published_at: extractDateFromText(`${anchor.title} ${anchor.context} ${anchor.url}`),
          collected_at: collectedAt,
          collector: "official_page",
          query: page.url,
          source_type: "official",
          source_priority: page.kind === "ir" ? 15 : 20,
          official_source_url: page.url,
        })),
      );
      rows.push(...filterRecent(sourceRows, days, collectedAt).slice(0, maxPerSource));
    } catch (error) {
      errors.push({ source_url: page.url, source_name: page.source, error: error.message });
    }
  }
  return { rows, requestCount, errors };
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
    )
      .map((row) => ({
        ...row,
        source_type: "fallback",
        source_priority: 90,
        official_source_url: "",
      }))
      .slice(0, maxPerSource),
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
      source_type: "fallback",
      source_priority: 95,
      official_source_url: "",
    }))
    .filter((row) => row.title && row.url);
  return { rows: filterRecent(rows, days, collectedAt).slice(0, maxPerSource), requestCount: 1 };
}

function dedupeRows(rows) {
  const seen = new Set();
  const seenTitles = new Set();
  const deduped = [];
  for (const row of rows) {
    const urlKey = row.url.replace(/[?#].*$/, "").toLowerCase();
    const key = `${row.company.toLowerCase()}|${urlKey || row.title.toLowerCase()}`;
    const titleKey = `${row.company.toLowerCase()}|${row.title.toLowerCase().replace(/\s+/g, " ").trim()}`;
    if (seen.has(key)) continue;
    if (row.title.length > 15 && seenTitles.has(titleKey)) continue;
    seen.add(key);
    seenTitles.add(titleKey);
    deduped.push(row);
  }
  return deduped;
}

function sortRows(rows) {
  return [...rows].sort((a, b) => {
    const priority = Number(a.source_priority || 99) - Number(b.source_priority || 99);
    if (priority !== 0) return priority;
    const bDate = Date.parse(b.published_at || "") || 0;
    const aDate = Date.parse(a.published_at || "") || 0;
    return bDate - aDate;
  });
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
        } else if (source === "official_pages") {
          result = await collectOfficialPages(company, sourceConfig, args.days, args.maxPerSource, args.timeoutSeconds, collectedAt);
        } else if (source === "google_news") {
          if (args.fallbackMode === "missing" && dedupeRows(companyRows).length >= args.fallbackMinResults) {
            continue;
          }
          result = await collectGoogleNews(company, args.days, args.maxPerSource, args.timeoutSeconds, collectedAt);
        } else if (source === "gdelt") {
          result = await collectGdelt(company, args.days, args.maxPerSource, args.timeoutSeconds, collectedAt);
        } else {
          throw new Error(`Unknown source: ${source}`);
        }
        companyRows.push(...result.rows);
        requestCount += result.requestCount;
        for (const sourceError of result.errors || []) {
          errors.push({
            target_no: company.target_no,
            company: company.company,
            source,
            ...sourceError,
          });
        }
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
    rows.push(...sortRows(dedupeRows(companyRows)).slice(0, args.maxPerCompany));
  }

  const finalRows = sortRows(dedupeRows(rows));
  const countsByCompany = Object.fromEntries(companies.map((company) => [company.company, 0]));
  const officialCountsByCompany = Object.fromEntries(companies.map((company) => [company.company, 0]));
  for (const row of finalRows) {
    countsByCompany[row.company] += 1;
    if (row.source_type === "official") {
      officialCountsByCompany[row.company] += 1;
    }
  }

  const summary = {
    run_started_at: collectedAt,
    company_count: companies.length,
    canonical_company_count: 77,
    sources: selectedSources,
    days: args.days,
    max_per_source: args.maxPerSource,
    max_per_company: args.maxPerCompany,
    fallback_mode: args.fallbackMode,
    fallback_min_results: args.fallbackMinResults,
    request_count: requestCount,
    result_count: finalRows.length,
    official_result_count: finalRows.filter((row) => row.source_type === "official").length,
    fallback_result_count: finalRows.filter((row) => row.source_type !== "official").length,
    companies_with_results: Object.values(countsByCompany).filter((count) => count > 0).length,
    companies_with_official_results: Object.values(officialCountsByCompany).filter((count) => count > 0).length,
    companies_without_results: Object.entries(countsByCompany)
      .filter(([, count]) => count === 0)
      .map(([company]) => company),
    counts_by_company: countsByCompany,
    official_counts_by_company: officialCountsByCompany,
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
