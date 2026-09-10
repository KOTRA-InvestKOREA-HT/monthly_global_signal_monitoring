"""Emit the report's view model as JSON, so a renderer does not re-derive it.

`build_pdf_report.py` mixes two jobs: working out what the report says, and
placing it on a canvas. The first job is the one that must not be duplicated -
country names, industry groups, which cells of the matrix are lit, how the
footnote counts companies. This imports those decisions rather than restating
them, and writes only the result.

The cover, matrix and per-company detail pages are modelled; the item-trend
pages still come from the reportlab path.
"""

import argparse
import io
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_pdf_report as report


def matrix_counts(profiles, signal_index, summary, signal_rows):
    """Reproduce the footnote's three buckets: detected, reviewed, insufficient."""
    signal_companies = [p for p in profiles if any(signal_index.get(p["company"], {}).values())]
    covered = {row.get("company") for row in signal_rows
               if row.get("company") and row.get("source_type") == "official"}
    if isinstance(summary.get("review_coverage"), list):
        covered = {item.get("company") for item in summary["review_coverage"]
                   if item.get("status") == "reviewed"}
    named = {item["company"] for item in signal_companies}
    reviewed_off = sum(1 for p in profiles if p["company"] not in named and p["company"] in covered)
    return {
        "detected": len(signal_companies),
        "reviewed_off": reviewed_off,
        "insufficient": len(profiles) - len(signal_companies) - reviewed_off,
        "total": len(profiles),
    }


def title_size(titles, font):
    """The size the three cover titles fit at, by the rule the reportlab cover uses.

    Shrinking to fit needs text measurement, which CSS cannot do on its own, so
    the decision is made here where the font metrics already live and travels
    with the rest of the view model.
    """
    fonts = report.register_fonts(font)
    measure = report.canvas.Canvas(io.BytesIO())
    width = report.PAGE_W - 86
    size = 30 if report.LANG == "en" else 36
    while size > 18 and any(measure.stringWidth(title, fonts["semibold"], size) > width for title in titles):
        size -= 1
    return size


# The signal body column, from the detail page's own geometry.
SIGNAL_BODY_WIDTH = 378


def summary_fits_one_line(parts, font):
    """Whether the headline and its detail are short enough to share a line.

    The drawn page keeps them on one line when they fit and gives the detail its
    own line when they do not, because reportlab cannot wrap a run that changes
    weight mid-sentence. CSS wraps such a run without being asked, but it cannot
    measure, so the decision is made here and travels with the text.
    """
    if not parts or not parts.get("detail"):
        return True
    fonts = report.register_fonts(font)
    measure = report.canvas.Canvas(io.BytesIO())
    size = report.SIGNAL_BODY_SIZE
    return (measure.stringWidth(parts["headline"], fonts["semibold"], size)
            + measure.stringWidth(f" — {parts['detail']}", fonts["demilight"], size)) <= SIGNAL_BODY_WIDTH


def signal_entry(no, rows, font):
    """One of the five signal rows: its label, and the summary if it fired."""
    label = report.SIGNAL_DESCRIPTIONS_EN[no] if report.LANG == "en" else report.SIGNAL_DESCRIPTIONS[no]
    if not rows:
        return {"no": no, "label": label, "active": False, "empty": report.t("no_signal")}
    row = rows[0]
    parts = report.summary_parts(row)
    return {
        "no": no,
        "label": label,
        "active": True,
        # A headline and its detail are one paragraph: bold, an em dash, then the
        # rest. Whether that fits on one line is the renderer's business.
        "headline": (parts or {}).get("headline", ""),
        "detail": (parts or {}).get("detail", ""),
        "plain": "" if parts else report.detail_text(row, 560),
        "inline": summary_fits_one_line(parts, font),
        "source": report.source_line(row),
    }


def detail_entries(profiles, signal_index, relevant, investment, signals, font):
    entries = []
    for profile in profiles:
        rows_by_signal = signal_index.get(profile["company"], {})
        if not any(rows_by_signal.values()):
            continue
        business_row = report.best_business_row(profile["company"], relevant, investment, signals)
        target_label, target_text = report.target_section_for_profile(profile)
        entries.append({
            "company": profile["company"],
            "country": profile.get("country", ""),
            "industry": profile.get("detailed_industry", ""),
            "signals": [signal_entry(no, rows_by_signal.get(no, []), font) for no in range(1, 6)],
            "business": {
                "heading": report.t("business_heading"),
                "target_label": target_label,
                "target_text": target_text,
                "body": report.business_text([business_row] if business_row else []),
                "source": report.source_line(business_row) if business_row else report.t("source_empty"),
            },
        })
    return entries


def indicator_entries(indicators):
    entries = []
    for item in indicators:
        if report.LANG == "en":
            label = item.get("label_en") or item["label_ko"]
            description = report.INDICATOR_DESCRIPTION_EN.get(item["no"], item.get("description_ko", ""))
        else:
            label, description = item["label_ko"], item["description_ko"]
        entries.append({"no": item["no"], "label": label, "description": description})
    return entries


def build(args):
    report.set_language(args.lang)
    targets = report.load_json(args.targets, [])
    tech_map = report.load_json(args.technology_map, {"companies": []})
    signals = report.load_json(args.signals, [])
    summary = report.override_summary_period(report.load_json(args.summary, {}), args.from_date, args.to_date)
    investment_signals = report.load_json(args.investment_signals, [])
    relevant = report.load_json(args.relevant, [])
    indicators = report.load_json(args.indicator_config, {}).get("indicators", [])

    signals = report.filter_rows_by_report_period(signals, summary)
    relevant = report.filter_rows_by_report_period(relevant, summary)
    investment_signals = report.filter_rows_by_report_period(investment_signals, summary)
    investment_signals = report.filter_ignored_signals(
        investment_signals, report.parse_ignored_signal_keys(args.ignored_signals))

    profiles = report.build_profiles(targets, tech_map)
    signal_index = report.index_investment_signals(investment_signals)
    counts = matrix_counts(profiles, signal_index, summary, signals)
    issue = str(args.issue_number or report.DEFAULT_ISSUE_NUMBER)
    titles = [report.t("cover_title_1"), report.t("cover_title_2"), report.t("cover_title_3")]

    return {
        "lang": report.LANG,
        "issue": {"label": f"Issue {issue}", "month": report.issue_month(summary)},
        "footer": report.t("footer", issue=f"Issue {issue}"),
        "cover": {
            "kicker": "G L O B A L   I N V E S T M E N T   S I G N A L   M O N I T O R",
            "titles": titles,
            "title_size": title_size(titles, args.font),
            "lines": [report.t("cover_line_1"), report.t("cover_line_2")],
            "indicator_heading": report.t("cover_indicator_heading"),
            "indicators": indicator_entries(indicators),
        },
        "matrix": {
            "kicker": "S I G N A L   M A T R I X",
            "title": report.t("matrix_title"),
            "description": report.t("matrix_desc", period=report.matrix_period_label(summary)),
            "company_heading": report.t("matrix_company"),
            "legend_on": report.t("matrix_legend_on"),
            "legend_off": report.t("matrix_legend_off"),
            "indicators": report.t("matrix_indicators"),
            "footnote": report.t("matrix_footnote", on=counts["detected"],
                                 off=counts["reviewed_off"] + counts["insufficient"],
                                 total=counts["total"], reviewed_off=counts["reviewed_off"],
                                 insufficient=counts["insufficient"]),
            "counts": counts,
            "rows": [{
                "target_no": profile["target_no"],
                "company": profile["company"],
                "signals": [bool(signal_index.get(profile["company"], {}).get(no)) for no in range(1, 6)],
            } for profile in profiles],
        },
        "details": {
            "kicker": "C O M P A N Y   S I G N A L S",
            "title": report.t("detail_title"),
            "pages": detail_entries(profiles, signal_index, relevant, investment_signals, signals, args.font),
        },
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--targets", default="data/target_companies.json")
    parser.add_argument("--technology-map", default="data/company_technology_map.json")
    parser.add_argument("--signals", required=True)
    parser.add_argument("--summary", required=True)
    parser.add_argument("--investment-signals", required=True)
    parser.add_argument("--relevant", default="outputs/latest_relevant_signals.json")
    parser.add_argument("--indicator-config", required=True)
    parser.add_argument("--font", default="assets/fonts/NOTOSANSKR-VF.TTF")
    parser.add_argument("--issue-number", default=report.DEFAULT_ISSUE_NUMBER)
    parser.add_argument("--lang", default="ko", choices=["ko", "en"])
    parser.add_argument("--ignored-signals", default="")
    parser.add_argument("--from-date", default="")
    parser.add_argument("--to-date", default="")
    parser.add_argument("--out", default="")
    args = parser.parse_args()
    payload = json.dumps(build(args), ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(payload, encoding="utf-8")
    else:
        sys.stdout.write(payload)


if __name__ == "__main__":
    main()
