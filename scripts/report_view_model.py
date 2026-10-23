"""Emit the report's view model as JSON, so a renderer does not re-derive it.

What the report says - country names, industry groups, which cells of the
matrix are lit, how the footnote counts companies - is decided in
`report_content.py`. This imports those decisions rather than restating them,
adds the few choices that need text measurement (`report_measure.py`), and
writes the result for `report_html.mjs` to lay out.

Every page of the report is modelled: cover, matrix, per-company detail and
the item-linked business trend cards.
"""

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import report_content as report
import report_measure


# 상태 판정은 report_content.py 에 둔다. 화면과 PDF 가 같은 표를 그려야 하므로 규칙의
# 복사본을 만들지 않는다.
company_status = report.company_status


def matrix_counts(profiles, signal_index):
    """각주의 두 묶음. 행마다 붙인 상태를 세는 것이라 표와 숫자가 어긋날 수 없다."""
    statuses = [company_status(p["company"], signal_index) for p in profiles]
    return {
        "detected": statuses.count("detected"),
        "reviewed_off": statuses.count("reviewed"),
        "total": len(profiles),
    }


# The HTML cover's display title: the largest size it starts from, and the text
# column it must fit, 43pt in from both edges (the masthead's and the logos' edges).
COVER_TITLE_START = {"ko": 50, "en": 44}
COVER_TITLE_WIDTH = 540 - 2 * 43


def title_size(titles, measure):
    """The size the cover titles fit at.

    Shrinking to fit needs text measurement, which CSS cannot do on its own, so
    the decision is made here where the font metrics already live and travels
    with the rest of the view model.

    The HTML cover sets the title as a display headline (2026-10 redesign).
    Every title line must fit whole. The English title stays on one line at 44pt:
    stacked at 64pt ("Investment / Signals") it took over the cover (user
    feedback, 2026-10-12).
    """
    size = COVER_TITLE_START.get(report.LANG, COVER_TITLE_START["ko"])
    while size > 18 and any(measure.width(title, "semibold", size) > COVER_TITLE_WIDTH for title in titles):
        size -= 1
    return size


def summary_fits_one_line(parts, measure):
    """Whether the headline and its detail are short enough to share a line.

    They share a line when they fit, and the detail gets its own line when they
    do not. CSS cannot measure, so the decision is made here and travels with
    the text.
    """
    if not parts or not parts.get("detail"):
        return True
    size = report_measure.SIGNAL_BODY_SIZE
    return (measure.width(parts["headline"], "semibold", size)
            + measure.width(f" — {parts['detail']}", "demilight", size)) <= report_measure.SIGNAL_BODY_WIDTH


def summary_cut(row, *pieces):
    """보고서에 실을 요약이 글자 수 상한에서 잘렸는가.

    short_text 는 자른 곳에 "..."를 붙인다. 원래 요약에 없는 말줄임표가 생겼으면 뒷부분이 빠진 것이다.
    한·영 문안 길이가 달라 한쪽 언어에서만 금액·일정이 빠질 수 있으므로 빌드에서 드러낸다.
    """
    source = report.normalize_summary_text(report.summary_field(row, "ai_summary")) if row else ""
    if not source or source.rstrip().endswith(("...", "…")):
        return False
    return any(str(piece or "").rstrip().endswith(("...", "…")) for piece in pieces)


def signal_entry(no, rows, measure):
    """One of the five signal rows: its label, and the summary if it fired."""
    label = report.signal_row_label(no)
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
        "inline": summary_fits_one_line(parts, measure),
        "cut": summary_cut(row, (parts or {}).get("headline"), (parts or {}).get("detail"),
                           "" if parts else report.detail_text(row, 560)),
        "source": report.source_line(row),
        "source_url": report.source_url(row),
    }


def detail_entries(profiles, signal_index, relevant, investment, measure, summary=None):
    entries = []
    for profile in profiles:
        rows_by_signal = signal_index.get(profile["company"], {})
        if not any(rows_by_signal.values()):
            continue
        shown = [rows[0] for rows in rows_by_signal.values() if rows]
        business_row = report.best_business_row(profile["company"], relevant, investment, shown,
                                                exempt_company=bool(profile.get("exempt_from_relevance")))
        # 사람이 그 달 상자를 비워 둔 기업(config/business_box_overrides.json)은 "확인되지 않음" 문구를 싣는다.
        if summary is not None and report.business_box_cleared(profile["company"], summary):
            business_row = None
        target_label, target_text = report.target_section_for_profile(profile)
        # 위 지표 칸과 다른 문안이 없으면(None) 되풀이하지 않고 "확인되지 않음" 문구를 싣는다. 출처 줄은 없다.
        business_body = report.business_text([business_row] if business_row else [])
        business = {
            "heading": report.t("business_heading"),
            "target_label": target_label,
            "target_text": target_text,
            "body": business_body,
            "cut": summary_cut(business_row, business_body),
            "source": report.source_line(business_row) if business_row else "",
            "source_url": report.source_url(business_row) if business_row else "",
        }
        entries.append({
            "company": profile.get("display_name") or profile["company"],
            "country": profile.get("country", ""),
            "industry": profile.get("detailed_industry", ""),
            "signals": [signal_entry(no, rows_by_signal.get(no, []), measure) for no in range(1, 6)],
            "business": business,
        })
    return entries


# The trend card's body column, from the card's own geometry.
ITEM_BODY_WIDTH = 446


def item_entries(profiles, signal_index, relevant, summary):
    """The companies with no five-signal profile but a target-item trend."""
    entries = report.build_item_trend_entries(profiles, signal_index, relevant)
    if not entries:
        return None
    month = report.report_month_label(summary)
    return {
        "kicker": report.t("item_kicker"),
        "title": report.t("item_title"),
        "note": report.t("item_note", month=month),
        "target_label": report.t("item_target_label"),
        "trend_label": report.t("item_trend_label", month=month),
        "cards": [{
            "company": entry["profile"].get("display_name") or entry["profile"]["company"],
            "industry": entry["profile"].get("detailed_industry", ""),
            "country": entry["profile"].get("country", ""),
            "target_text": report.item_target_text(entry["profile"]),
            # 문장 수를 줄 수에 맞춰 자르지 않고 문안 전체를 싣는다. 카드 높이는 Chrome 이 잰 값으로 장을 나눈다.
            # 줄 수에 맞춰 자르던 때는 긴 영문의 뒷문장이 빠져, HyproMag 인수금액이 영문에만, Renishaw 전시
            # 일정이 한글에만 남았다(실행 35167466191).
            "body": report.item_trend_text(entry["row"]),
            "cut": False,
            "source": report.source_line(entry["row"]),
            "source_url": report.source_url(entry["row"]),
        } for entry in entries],
    }


def indicator_entries(indicators):
    entries = []
    for item in indicators:
        label, description = report.cover_indicator_texts(item)
        entries.append({"no": item["no"], "label": label, "description": description})
    return entries


def build(args):
    report.set_language(args.lang)
    # One font registration for the entire report.
    measure = report_measure.Measure(args.font)
    targets = report.load_json(args.targets, [])
    tech_map = report.load_json(args.technology_map, {"companies": []})
    summary = report.override_summary_period(report.load_json(args.summary, {}), args.from_date, args.to_date)
    report.set_report_period(summary)
    investment_signals = report.load_json(args.investment_signals, [])
    relevant = report.load_json(args.relevant, [])
    indicators = report.load_json(args.indicator_config, {}).get("indicators", [])

    relevant = report.filter_rows_by_report_period(relevant, summary)
    investment_signals = report.filter_rows_by_report_period(investment_signals, summary)
    investment_signals = report.filter_ignored_signals(
        investment_signals, report.parse_ignored_signal_keys(args.ignored_signals))

    profiles = report.build_profiles(targets, tech_map)
    signal_index = report.index_investment_signals(investment_signals)
    counts = matrix_counts(profiles, signal_index)
    # 호수는 호출한 쪽이 반드시 준다. 기본값 "2"로 채우던 때는 호수 없이 만든 보고서가 지난 호수로 나갔다.
    issue = re.sub(r"\D+", "", str(args.issue_number or ""))
    if not issue:
        raise ValueError("An issue number is required (--issue-number N).")
    titles = report.cover_titles()
    cover_lines = [report.t("cover_line_1"), report.t("cover_line_2")]
    cover_indicators = indicator_entries(indicators)

    return {
        "lang": report.LANG,
        "issue": {"label": f"Issue {issue}", "month": report.issue_month(summary)},
        "footer": report.t("footer", issue=f"Issue {issue}"),
        "cover": {
            "kicker": report.cover_kicker(),
            "titles": titles,
            "subtitle": report.cover_subtitle(),
            "accent": report.cover_title_accent(),
            "title_size": title_size(titles, measure),
            "lines": cover_lines,
            "line_size": report_measure.cover_line_size(measure, cover_lines),
            "indicator_heading": report.t("cover_indicator_heading"),
            "indicators": cover_indicators,
        },
        "matrix": {
            "kicker": report.t("matrix_kicker"),
            "title": report.t("matrix_title"),
            "description": report.t("matrix_desc", period=report.matrix_period_label(summary)),
            "company_heading": report.t("matrix_company"),
            "legend_on": report.t("matrix_legend_on"),
            "legend_off": report.t("matrix_legend_off"),
            "indicators": report.matrix_indicators(),
            "footnote": report.matrix_footnote(counts["detected"], counts["reviewed_off"], counts["total"]),
            "counts": counts,
            "rows": [{
                "target_no": profile["target_no"],
                "company": profile.get("display_name") or profile["company"],
                "status": company_status(profile["company"], signal_index),
                "signals": [report.signal_cell_state(signal_index, profile["company"], no) for no in range(1, 6)],
            } for profile in profiles],
        },
        "details": {
            "kicker": report.t("detail_kicker"),
            "title": report.t("detail_title"),
            "pages": detail_entries(profiles, signal_index, relevant, investment_signals, measure, summary),
            "pill_width": report_measure.signal_pill_column(measure),
        },
        "items": item_entries(profiles, signal_index, relevant, summary),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--targets", default="data/target_companies.json")
    parser.add_argument("--technology-map", default="data/company_technology_map.json")
    # 수집 원본(company_signals)은 보고서 내용에 쓰이지 않는다. 승인 판정이 없는 행이라 사업현황 상자를
    # 채울 수 없었다. 이 인자를 넘기는 호출부(app/api/report/route.js)가 깨지지 않게 받기만 한다.
    parser.add_argument("--signals", default="")
    parser.add_argument("--summary", required=True)
    parser.add_argument("--investment-signals", required=True)
    parser.add_argument("--relevant", default="outputs/latest_relevant_signals.json")
    parser.add_argument("--indicator-config", required=True)
    parser.add_argument("--font", default="assets/fonts/PretendardJP-Regular.ttf")
    parser.add_argument("--issue-number", required=True)
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
