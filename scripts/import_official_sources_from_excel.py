import argparse
import csv
import json
from pathlib import Path

import pandas as pd


SOURCE_TYPE_KIND_MAP = [
    ("press", "press_release"),
    ("newsroom", "newsroom"),
    ("news", "newsroom"),
    ("investor presentations", "presentation"),
    ("presentation", "presentation"),
    ("financial reports", "financial_report"),
    ("report", "financial_report"),
    ("regulatory filings", "filing"),
    ("exchange announcements", "filing"),
    ("filings", "filing"),
    ("investor relations", "ir"),
]


def normalize_cell(value):
    if pd.isna(value):
        return ""
    return str(value).strip()


def source_kind(source_type):
    lowered = source_type.lower()
    for needle, kind in SOURCE_TYPE_KIND_MAP:
        if needle in lowered:
            return kind
    return "official_page"


def source_rank(row):
    priority = row["crawl_priority"].lower()
    kind = row["kind"]
    if priority == "primary":
        base = 0
    elif priority == "secondary":
        base = 20
    else:
        base = 40

    kind_rank = {
        "press_release": 0,
        "newsroom": 2,
        "ir": 4,
        "filing": 6,
        "presentation": 8,
        "financial_report": 10,
        "official_page": 20,
    }.get(kind, 20)
    return base + kind_rank


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--excel", required=True)
    parser.add_argument("--targets", default="data/target_companies.json")
    parser.add_argument("--out-catalog-json", default="data/official_source_catalog.json")
    parser.add_argument("--out-catalog-csv", default="data/official_source_catalog.csv")
    parser.add_argument("--out-source-config", default="config/company_sources.json")
    args = parser.parse_args()

    targets = json.loads(Path(args.targets).read_text(encoding="utf-8"))
    target_names = {item["company"] for item in targets}

    frame = pd.read_excel(args.excel)
    rows = []
    for _, raw in frame.iterrows():
        company = normalize_cell(raw.get("Company_as_in_PDF"))
        url = normalize_cell(raw.get("URL"))
        availability = normalize_cell(raw.get("Availability"))
        if company not in target_names or not url or availability.lower() != "available":
            continue

        source_type = normalize_cell(raw.get("Source_type"))
        page_title = normalize_cell(raw.get("Page_title"))
        entity_name = normalize_cell(raw.get("Official_entity_name"))
        catalog_row = {
            "target_no": int(raw.get("No")),
            "company": company,
            "official_entity_name": entity_name,
            "source_type": source_type,
            "page_title": page_title,
            "url": url,
            "domain": normalize_cell(raw.get("Domain")),
            "availability": availability,
            "scope_or_relation": normalize_cell(raw.get("Scope_or_relation")),
            "crawl_priority": normalize_cell(raw.get("Crawl_priority")) or "Primary",
            "notes": normalize_cell(raw.get("Notes")),
            "verified_on": normalize_cell(raw.get("Verified_on")),
            "kind": source_kind(source_type),
        }
        catalog_row["rank"] = source_rank(catalog_row)
        rows.append(catalog_row)

    rows.sort(key=lambda item: (item["target_no"], item["rank"], item["source_type"], item["url"]))

    missing = sorted(target_names - {row["company"] for row in rows})
    if missing:
        raise SystemExit(f"Missing official source rows for target companies: {missing}")

    official_pages = {}
    for row in rows:
        label_parts = [row["page_title"] or row["source_type"], row["source_type"]]
        source = f"{row['company']} - {' / '.join(part for part in label_parts if part)}"
        official_pages.setdefault(row["company"], []).append(
            {
                "source": source,
                "kind": row["kind"],
                "url": row["url"],
                "crawl_priority": row["crawl_priority"],
                "page_title": row["page_title"],
                "source_type_label": row["source_type"],
                "domain": row["domain"],
            },
        )

    config = {
        "description": (
            "Official company source catalog generated from "
            "77_target_companies_official_press_IR_filings_newsroom_urls.csv.xlsx. "
            "The collector reads these official pages first and uses fallback search only when official results are missing."
        ),
        "official_feeds": {},
        "official_pages": official_pages,
    }

    Path(args.out_catalog_json).write_text(
        json.dumps(
            {
                "description": "Normalized official source catalog derived from the user-provided Excel file.",
                "source_excel": str(Path(args.excel)),
                "company_count": len(official_pages),
                "source_count": len(rows),
                "rows": rows,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    with Path(args.out_catalog_csv).open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

    Path(args.out_source_config).write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(
        json.dumps(
            {
                "company_count": len(official_pages),
                "source_count": len(rows),
                "out_catalog_json": args.out_catalog_json,
                "out_catalog_csv": args.out_catalog_csv,
                "out_source_config": args.out_source_config,
            },
            ensure_ascii=False,
            indent=2,
        ),
    )


if __name__ == "__main__":
    main()
