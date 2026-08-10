from __future__ import annotations

import argparse
import csv
import email.utils
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


FIELDNAMES = [
    "target_no",
    "company",
    "title",
    "url",
    "source",
    "published_at",
    "collected_at",
    "collector",
    "query",
]

SIGNAL_TERMS = [
    '"press release"',
    '"investor relations"',
    "earnings",
    "announcement",
    "investment",
    "expansion",
    "acquisition",
    "partnership",
    "Korea",
]

USER_AGENT = "company-signal-monitor/0.1 (+https://github.com/your-org/company-signal-monitor)"


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_datetime(value: str | None) -> str | None:
    if not value:
        return None
    value = value.strip()
    for parser in (
        lambda raw: email.utils.parsedate_to_datetime(raw),
        lambda raw: datetime.strptime(raw, "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC),
        lambda raw: datetime.fromisoformat(raw.replace("Z", "+00:00")),
    ):
        try:
            dt = parser(value)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=UTC)
            return dt.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        except Exception:
            continue
    return value


def filter_recent(rows: list[dict[str, Any]], days: int, collected_at: str) -> list[dict[str, Any]]:
    cutoff = datetime.fromisoformat(collected_at.replace("Z", "+00:00")).timestamp() - days * 86400
    filtered = []
    for row in rows:
        published_at = row.get("published_at")
        if not published_at:
            filtered.append(row)
            continue
        try:
            published = datetime.fromisoformat(published_at.replace("Z", "+00:00")).timestamp()
        except ValueError:
            filtered.append(row)
            continue
        if published >= cutoff:
            filtered.append(row)
    return filtered


def fetch_text(url: str, timeout: int) -> str:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/rss+xml, application/atom+xml, application/json, text/xml;q=0.9, */*;q=0.8",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        return response.read().decode(charset, errors="replace")


def fetch_json(url: str, timeout: int) -> dict[str, Any]:
    return json.loads(fetch_text(url, timeout))


def clean_title(title: str | None) -> str:
    return " ".join((title or "").split())


def item_text(element: ET.Element, tag: str) -> str | None:
    found = element.find(tag)
    return found.text if found is not None else None


def atom_child(element: ET.Element, local_name: str) -> ET.Element | None:
    for child in list(element):
        if child.tag.endswith("}" + local_name) or child.tag == local_name:
            return child
    return None


def parse_rss_or_atom(
    xml_text: str,
    company: dict[str, Any],
    collected_at: str,
    collector: str,
    query: str,
    default_source: str,
) -> list[dict[str, Any]]:
    root = ET.fromstring(xml_text)
    rows: list[dict[str, Any]] = []

    for item in root.findall(".//item"):
        source_element = item.find("source")
        source = default_source
        if source_element is not None and source_element.text:
            source = f"{default_source}: {clean_title(source_element.text)}"
        rows.append(
            {
                "target_no": company["target_no"],
                "company": company["company"],
                "title": clean_title(item_text(item, "title")),
                "url": item_text(item, "link") or "",
                "source": source,
                "published_at": parse_datetime(item_text(item, "pubDate")),
                "collected_at": collected_at,
                "collector": collector,
                "query": query,
            }
        )

    for entry in root.findall(".//{*}entry"):
        link = ""
        for child in list(entry):
            if child.tag.endswith("}link") or child.tag == "link":
                link = child.attrib.get("href", "")
                if link:
                    break
        title_element = atom_child(entry, "title")
        published = atom_child(entry, "published")
        if published is None:
            published = atom_child(entry, "updated")
        rows.append(
            {
                "target_no": company["target_no"],
                "company": company["company"],
                "title": clean_title(title_element.text if title_element is not None else ""),
                "url": link,
                "source": default_source,
                "published_at": parse_datetime(published.text if published is not None else None),
                "collected_at": collected_at,
                "collector": collector,
                "query": query,
            }
        )

    return [row for row in rows if row["title"] and row["url"]]


def relevant_aliases(company: dict[str, Any]) -> list[str]:
    names = [company["company"]]
    for alias in company.get("query_aliases", []):
        if len(alias) >= 5 and alias.lower() not in {"hydro", "maxon", "evonik"}:
            names.append(alias)
    unique: list[str] = []
    seen = set()
    for name in names:
        key = name.lower()
        if key not in seen:
            seen.add(key)
            unique.append(name)
    return unique[:3]


def build_query(company: dict[str, Any], days: int) -> str:
    names = relevant_aliases(company)
    name_clause = " OR ".join(f'"{name}"' for name in names)
    if len(names) > 1:
        name_clause = f"({name_clause})"
    terms = " OR ".join(SIGNAL_TERMS)
    return f"{name_clause} ({terms}) when:{days}d"


def build_gdelt_query(company: dict[str, Any]) -> str:
    names = relevant_aliases(company)
    name_clause = " OR ".join(f'"{name}"' for name in names)
    if len(names) > 1:
        name_clause = f"({name_clause})"
    terms = " OR ".join(term for term in SIGNAL_TERMS if term != "Korea")
    return f"{name_clause} ({terms})"


def collect_google_news(
    company: dict[str, Any],
    days: int,
    max_per_source: int,
    timeout: int,
    collected_at: str,
) -> list[dict[str, Any]]:
    query = build_query(company, days)
    params = {
        "q": query,
        "hl": "en-US",
        "gl": "US",
        "ceid": "US:en",
    }
    url = "https://news.google.com/rss/search?" + urllib.parse.urlencode(params)
    rows = parse_rss_or_atom(
        fetch_text(url, timeout),
        company,
        collected_at,
        "google_news_rss",
        query,
        "Google News",
    )
    return filter_recent(rows, days, collected_at)[:max_per_source]


def collect_gdelt(
    company: dict[str, Any],
    days: int,
    max_per_source: int,
    timeout: int,
    collected_at: str,
) -> list[dict[str, Any]]:
    query = build_gdelt_query(company)
    params = {
        "query": query,
        "mode": "ArtList",
        "format": "json",
        "maxrecords": str(max_per_source),
        "sort": "HybridRel",
        "timespan": f"{days}d",
    }
    url = "https://api.gdeltproject.org/api/v2/doc/doc?" + urllib.parse.urlencode(params)
    payload = fetch_json(url, timeout)
    rows = []
    for article in payload.get("articles", []):
        rows.append(
            {
                "target_no": company["target_no"],
                "company": company["company"],
                "title": clean_title(article.get("title")),
                "url": article.get("url") or "",
                "source": f"GDELT: {article.get('domain') or article.get('sourceCountry') or 'unknown'}",
                "published_at": parse_datetime(article.get("seendate")),
                "collected_at": collected_at,
                "collector": "gdelt_doc_api",
                "query": query,
            }
        )
    return filter_recent([row for row in rows if row["title"] and row["url"]], days, collected_at)[
        :max_per_source
    ]


def collect_official_feeds(
    company: dict[str, Any],
    source_config: dict[str, Any],
    max_per_source: int,
    timeout: int,
    collected_at: str,
) -> list[dict[str, Any]]:
    feeds = source_config.get("official_feeds", {}).get(company["company"], [])
    rows: list[dict[str, Any]] = []
    for feed in feeds:
        if isinstance(feed, str):
            feed_url = feed
            source_name = f"Official feed: {company['company']}"
        else:
            feed_url = feed.get("url", "")
            source_name = feed.get("source", f"Official feed: {company['company']}")
        if not feed_url:
            continue
        rows.extend(
            parse_rss_or_atom(
                fetch_text(feed_url, timeout),
                company,
                collected_at,
                "official_feed",
                feed_url,
                source_name,
            )[:max_per_source]
        )
    return rows


def dedupe_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deduped = []
    seen = set()
    for row in rows:
        url_key = re.sub(r"[?#].*$", "", row["url"]).lower()
        key = (row["company"].lower(), url_key or row["title"].lower())
        if key in seen:
            continue
        seen.add(key)
        deduped.append(row)
    return deduped


def load_companies(path: Path) -> list[dict[str, Any]]:
    companies = json.loads(path.read_text(encoding="utf-8"))
    numbers = [int(row["target_no"]) for row in companies]
    if numbers != list(range(1, 78)):
        raise ValueError(f"Expected target_no 1..77 in {path}, got {numbers}")
    return companies


def write_results(rows: list[dict[str, Any]], summary: dict[str, Any], out_dir: Path) -> dict[str, str]:
    out_dir.mkdir(parents=True, exist_ok=True)
    timestamp = summary["run_started_at"].replace(":", "").replace("-", "")
    timestamp = timestamp.replace("Z", "Z")
    json_path = out_dir / f"company_signals_{timestamp}.json"
    csv_path = out_dir / f"company_signals_{timestamp}.csv"
    summary_path = out_dir / f"collection_summary_{timestamp}.json"

    json_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(rows)

    (out_dir / "latest_company_signals.json").write_text(
        json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    with (out_dir / "latest_company_signals.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(rows)
    (out_dir / "latest_collection_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    return {
        "json": str(json_path),
        "csv": str(csv_path),
        "summary": str(summary_path),
        "latest_json": str(out_dir / "latest_company_signals.json"),
        "latest_csv": str(out_dir / "latest_company_signals.csv"),
        "latest_summary": str(out_dir / "latest_collection_summary.json"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Collect company news, press, and IR signals.")
    parser.add_argument("--companies", default="data/target_companies.json")
    parser.add_argument("--source-config", default="config/company_sources.json")
    parser.add_argument("--out-dir", default="outputs")
    parser.add_argument("--sources", default="official_feeds,google_news")
    parser.add_argument("--days", type=int, default=45)
    parser.add_argument("--max-per-source", type=int, default=3)
    parser.add_argument("--max-per-company", type=int, default=6)
    parser.add_argument("--rate-limit-seconds", type=float, default=1.0)
    parser.add_argument("--timeout-seconds", type=int, default=20)
    args = parser.parse_args()

    companies = load_companies(Path(args.companies))
    source_config_path = Path(args.source_config)
    source_config = (
        json.loads(source_config_path.read_text(encoding="utf-8")) if source_config_path.exists() else {}
    )
    selected_sources = [source.strip() for source in args.sources.split(",") if source.strip()]
    collected_at = utc_now()
    rows: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []

    for company in companies:
        company_rows: list[dict[str, Any]] = []
        for source in selected_sources:
            try:
                if source == "official_feeds":
                    source_rows = collect_official_feeds(
                        company, source_config, args.max_per_source, args.timeout_seconds, collected_at
                    )
                elif source == "google_news":
                    source_rows = collect_google_news(
                        company, args.days, args.max_per_source, args.timeout_seconds, collected_at
                    )
                elif source == "gdelt":
                    source_rows = collect_gdelt(
                        company, args.days, args.max_per_source, args.timeout_seconds, collected_at
                    )
                else:
                    raise ValueError(f"Unknown source: {source}")
                company_rows.extend(source_rows)
            except (urllib.error.URLError, TimeoutError, ET.ParseError, json.JSONDecodeError, ValueError) as exc:
                errors.append(
                    {
                        "target_no": company["target_no"],
                        "company": company["company"],
                        "source": source,
                        "error": str(exc),
                    }
                )
            if source in {"google_news", "gdelt", "official_feeds"}:
                time.sleep(args.rate_limit_seconds)
        rows.extend(dedupe_rows(company_rows)[: args.max_per_company])

    rows = dedupe_rows(rows)
    counts_by_company = {company["company"]: 0 for company in companies}
    for row in rows:
        counts_by_company[row["company"]] += 1

    summary = {
        "run_started_at": collected_at,
        "company_count": len(companies),
        "sources": selected_sources,
        "days": args.days,
        "max_per_source": args.max_per_source,
        "max_per_company": args.max_per_company,
        "result_count": len(rows),
        "companies_with_results": sum(1 for count in counts_by_company.values() if count > 0),
        "companies_without_results": [
            company for company, count in counts_by_company.items() if count == 0
        ],
        "counts_by_company": counts_by_company,
        "error_count": len(errors),
        "errors": errors,
    }
    paths = write_results(rows, summary, Path(args.out_dir))
    summary["outputs"] = paths
    Path(paths["summary"]).write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    Path(paths["latest_summary"]).write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if rows else 1


if __name__ == "__main__":
    raise SystemExit(main())
