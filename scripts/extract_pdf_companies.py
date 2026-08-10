from __future__ import annotations

import argparse
import csv
import json
import re
from pathlib import Path
from typing import Any

import pdfplumber


def parse_company_table(text: str) -> list[dict[str, Any]]:
    text = "\n" + text
    start = re.search(r"\n1\s+[A-Za-z0-9]", text)
    if not start:
        raise ValueError("Could not find the first company row on the selected page.")

    table = text[start.start() + 1 :]
    end = re.search(r"\n[^\x00-\x7F]", table)
    if end:
        table = table[: end.start()]

    number_pattern = re.compile(r"(?<![\d.])([1-9]\d?|7[0-7])\s+")
    matches = list(number_pattern.finditer(table))
    parsed: dict[int, str] = {}

    for index, match in enumerate(matches):
        target_no = int(match.group(1))
        name_end = matches[index + 1].start() if index + 1 < len(matches) else len(table)
        company = " ".join(table[match.end() : name_end].split())
        if company and any(char.isalpha() for char in company):
            parsed.setdefault(target_no, company)

    companies = [{"target_no": no, "company": parsed[no]} for no in sorted(parsed)]
    expected_numbers = list(range(1, 78))
    actual_numbers = [item["target_no"] for item in companies]
    if actual_numbers != expected_numbers:
        raise ValueError(f"Expected target_no 1..77, got {actual_numbers}")

    return companies


def load_expected(path: Path) -> list[dict[str, Any]]:
    rows = json.loads(path.read_text(encoding="utf-8"))
    return [{"target_no": int(row["target_no"]), "company": row["company"]} for row in rows]


def compare_expected(
    extracted: list[dict[str, Any]], expected: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    expected_by_no = {row["target_no"]: row["company"] for row in expected}
    mismatches = []
    for row in extracted:
        expected_company = expected_by_no.get(row["target_no"])
        if expected_company != row["company"]:
            mismatches.append(
                {
                    "target_no": row["target_no"],
                    "pdf_company": row["company"],
                    "expected_company": expected_company,
                }
            )
    return mismatches


def write_outputs(rows: list[dict[str, Any]], out_dir: Path) -> dict[str, str]:
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "pdf_companies_extracted.json"
    csv_path = out_dir / "pdf_companies_extracted.csv"

    json_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["target_no", "company"])
        writer.writeheader()
        writer.writerows(rows)

    return {"json": str(json_path), "csv": str(csv_path)}


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract the 77 target companies from PDF page 2.")
    parser.add_argument("--pdf", required=True, help="Path to the Invest KOREA PDF.")
    parser.add_argument("--page", type=int, default=2, help="1-based page number to extract.")
    parser.add_argument("--expected", default="data/target_companies.json")
    parser.add_argument("--out-dir", default="outputs")
    args = parser.parse_args()

    pdf_path = Path(args.pdf)
    with pdfplumber.open(pdf_path) as pdf:
        if args.page < 1 or args.page > len(pdf.pages):
            raise ValueError(f"Page {args.page} is outside the PDF page range 1..{len(pdf.pages)}")
        text = pdf.pages[args.page - 1].extract_text(x_tolerance=1, y_tolerance=3) or ""

    extracted = parse_company_table(text)
    expected_path = Path(args.expected)
    expected = load_expected(expected_path) if expected_path.exists() else []
    mismatches = compare_expected(extracted, expected) if expected else []
    output_paths = write_outputs(extracted, Path(args.out_dir))

    summary = {
        "pdf": str(pdf_path),
        "page": args.page,
        "extracted_count": len(extracted),
        "expected_count": len(expected) if expected else None,
        "mismatch_count": len(mismatches),
        "mismatches": mismatches,
        "outputs": output_paths,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 1 if mismatches else 0


if __name__ == "__main__":
    raise SystemExit(main())
