import argparse
import json
import math
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas


PAGE_W, PAGE_H = A4
NAVY = colors.HexColor("#10243E")
GOLD = colors.HexColor("#D7A33A")
LIGHT = colors.HexColor("#F4F7FB")
MID = colors.HexColor("#D6DEE9")
TEXT = colors.HexColor("#162033")
MUTED = colors.HexColor("#596579")


def load_json(path, fallback):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return fallback


def format_date(value):
    if not value:
        return "-"
    try:
        normalized = value.replace("Z", "+00:00")
        dt = datetime.fromisoformat(normalized).astimezone(timezone.utc)
        return dt.strftime("%Y.%m.%d")
    except Exception:
        return str(value)[:10]


def format_short_date(value):
    formatted = format_date(value)
    return formatted[2:] if formatted.startswith("20") else formatted


def short_text(value, limit):
    text = " ".join(str(value or "").split())
    return text if len(text) <= limit else text[: limit - 3].rstrip() + "..."


def register_font(font_path):
    pdfmetrics.registerFont(TTFont("NotoSansKR", font_path))
    return "NotoSansKR"


def width(canvas_obj, text, font_name, font_size):
    return canvas_obj.stringWidth(str(text), font_name, font_size)


def wrap_text(canvas_obj, text, max_width, font_name, font_size):
    text = " ".join(str(text or "").split())
    if not text:
        return [""]

    lines = []
    current = ""
    for token in text.split(" "):
        candidate = token if not current else f"{current} {token}"
        if width(canvas_obj, candidate, font_name, font_size) <= max_width:
            current = candidate
            continue

        if current:
            lines.append(current)
            current = token
        else:
            chunk = ""
            for char in token:
                candidate_chunk = f"{chunk}{char}"
                if width(canvas_obj, candidate_chunk, font_name, font_size) <= max_width:
                    chunk = candidate_chunk
                else:
                    if chunk:
                        lines.append(chunk)
                    chunk = char
            current = chunk

    if current:
        lines.append(current)
    return lines


class PdfReport:
    def __init__(self, out_path, font_name):
        self.out_path = out_path
        self.font = font_name
        self.canvas = canvas.Canvas(str(out_path), pagesize=A4)
        self.page_no = 0

    def set_font(self, size, color=TEXT):
        self.canvas.setFont(self.font, size)
        self.canvas.setFillColor(color)

    def draw_footer(self):
        self.canvas.setStrokeColor(MID)
        self.canvas.setLineWidth(0.4)
        self.canvas.line(42, 34, PAGE_W - 42, 34)
        self.set_font(8, MUTED)
        self.canvas.drawString(42, 20, "KOTRA Global Investment Signal Monitor")
        self.canvas.drawRightString(PAGE_W - 42, 20, str(self.page_no))

    def new_page(self, title=None):
        if self.page_no:
            if self.page_no > 1:
                self.draw_footer()
            self.canvas.showPage()
        self.page_no += 1
        if title:
            self.set_font(17, TEXT)
            self.canvas.drawString(42, PAGE_H - 52, title)
            self.canvas.setStrokeColor(GOLD)
            self.canvas.setLineWidth(2)
            self.canvas.line(42, PAGE_H - 63, 112, PAGE_H - 63)
            return PAGE_H - 86
        return PAGE_H - 42

    def finish(self):
        if self.page_no > 1:
            self.draw_footer()
        self.canvas.save()

    def draw_wrapped(self, text, x, y, max_width, size=9, line_gap=4, color=TEXT, max_lines=0):
        self.set_font(size, color)
        lines = wrap_text(self.canvas, text, max_width, self.font, size)
        if max_lines and len(lines) > max_lines:
            lines = lines[:max_lines]
            lines[-1] = short_text(lines[-1], max(8, len(lines[-1]) - 3))
        line_height = size + line_gap
        for line in lines:
            self.canvas.drawString(x, y, line)
            y -= line_height
        return y

    def draw_metric(self, x, y, label, value, width_box=116):
        self.canvas.setFillColor(LIGHT)
        self.canvas.roundRect(x, y - 56, width_box, 52, 6, fill=1, stroke=0)
        self.set_font(8, MUTED)
        self.canvas.drawString(x + 10, y - 20, label)
        self.set_font(17, TEXT)
        self.canvas.drawString(x + 10, y - 43, str(value))

    def draw_table(self, rows, columns, x, y, widths, row_min_height=24, title=None):
        if title:
            self.set_font(12, TEXT)
            self.canvas.drawString(x, y, title)
            y -= 18

        header_h = 23
        if y - header_h < 60:
            y = self.new_page(title)
        self.canvas.setFillColor(NAVY)
        self.canvas.rect(x, y - header_h, sum(widths), header_h, fill=1, stroke=0)
        self.set_font(8, colors.white)
        cursor = x
        for col, col_width in zip(columns, widths):
            self.canvas.drawString(cursor + 5, y - 15, col["label"])
            cursor += col_width
        y -= header_h

        for row in rows:
            cell_lines = []
            row_height = row_min_height
            for col, col_width in zip(columns, widths):
                value = col.get("format", lambda item: item.get(col["key"], ""))(row)
                lines = wrap_text(self.canvas, value, col_width - 10, self.font, col.get("size", 7.5))
                max_lines = col.get("max_lines", 3)
                if len(lines) > max_lines:
                    lines = lines[:max_lines]
                    lines[-1] = short_text(lines[-1], max(8, len(lines[-1]) - 3))
                cell_lines.append(lines)
                row_height = max(row_height, 8 + len(lines) * (col.get("size", 7.5) + 3))

            if y - row_height < 54:
                y = self.new_page(title)
                self.canvas.setFillColor(NAVY)
                self.canvas.rect(x, y - header_h, sum(widths), header_h, fill=1, stroke=0)
                self.set_font(8, colors.white)
                cursor = x
                for col, col_width in zip(columns, widths):
                    self.canvas.drawString(cursor + 5, y - 15, col["label"])
                    cursor += col_width
                y -= header_h

            self.canvas.setFillColor(colors.white)
            self.canvas.rect(x, y - row_height, sum(widths), row_height, fill=1, stroke=0)
            self.canvas.setStrokeColor(MID)
            self.canvas.line(x, y - row_height, x + sum(widths), y - row_height)
            cursor = x
            for col, col_width, lines in zip(columns, widths, cell_lines):
                self.set_font(col.get("size", 7.5), col.get("color", TEXT))
                line_y = y - 12
                for line in lines:
                    self.canvas.drawString(cursor + 5, line_y, line)
                    line_y -= col.get("size", 7.5) + 3
                cursor += col_width
            y -= row_height
        return y - 16


def draw_cover(report, summary, investment_summary, indicators):
    c = report.canvas
    report.page_no += 1
    c.setFillColor(GOLD)
    c.rect(0, PAGE_H - 10, PAGE_W, 10, fill=1, stroke=0)
    c.setFillColor(NAVY)
    c.rect(0, 0, PAGE_W, PAGE_H - 10, fill=1, stroke=0)

    report.set_font(22, colors.white)
    c.drawRightString(PAGE_W - 48, PAGE_H - 64, "Issue 2")
    report.set_font(11, MID)
    c.drawRightString(PAGE_W - 48, PAGE_H - 86, datetime.now().strftime("%Y.%m"))

    y = PAGE_H - 250
    report.set_font(13, GOLD)
    c.drawString(48, y, "G L O B A L   I N V E S T M E N T   S I G N A L   M O N I T O R")
    y -= 56
    report.set_font(37, colors.white)
    c.drawString(48, y, "타겟기업")
    y -= 52
    report.set_font(37, GOLD)
    c.drawString(48, y, "글로벌 투자시그널")
    y -= 52
    report.set_font(37, colors.white)
    c.drawString(48, y, "모니터링")

    y -= 44
    report.set_font(13, colors.white)
    c.drawString(48, y, "산업부 선정 30대 투자유치 프로젝트 · 77개 타겟기업")
    y -= 22
    c.drawString(48, y, "기업별 5대 시그널(전조현상) 포착 · 투자 확정 전 선행 징후 기반")

    y -= 44
    report.set_font(11, MID)
    c.drawString(48, y, "5대 투자동향 지표")
    y -= 32
    for item in indicators:
        c.setStrokeColor(GOLD)
        c.setLineWidth(1.2)
        c.circle(52, y + 3, 11, stroke=1, fill=0)
        report.set_font(10, GOLD)
        c.drawCentredString(52, y - 1, str(item["no"]))
        report.set_font(13, colors.white)
        c.drawString(76, y - 2, item["label_ko"])
        report.set_font(8.5, MID)
        c.drawRightString(PAGE_W - 48, y - 2, item["description_ko"])
        y -= 34

    c.setStrokeColor(MID)
    c.setLineWidth(0.5)
    c.line(38, 67, PAGE_W - 38, 67)
    report.set_font(19, colors.white)
    c.drawString(38, 45, "kotra")
    report.set_font(8, MID)
    c.drawString(38, 29, "Korea Trade-Investment")
    c.drawString(38, 18, "Promotion Agency")
    report.set_font(12, colors.white)
    c.drawRightString(PAGE_W - 38, 36, "Invest KOREA")


def build_report(args):
    signals = load_json(args.signals, [])
    summary = load_json(args.summary, {})
    relevant = load_json(args.relevant, [])
    relevance_summary = load_json(args.relevance_summary, {})
    investment_signals = load_json(args.investment_signals, [])
    investment_summary = load_json(args.investment_summary, {})
    indicators = load_json(args.indicator_config, {}).get("indicators", [])

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    font_name = register_font(args.font)
    report = PdfReport(out_path, font_name)

    draw_cover(report, summary, investment_summary, indicators)

    y = report.new_page("Executive Summary")
    metrics = [
        ("대상 기업", summary.get("company_count", 77)),
        ("전체 수집", summary.get("result_count", len(signals))),
        ("공식 출처", summary.get("official_result_count", 0)),
        ("기술 후보", relevance_summary.get("relevant_signal_count", len(relevant))),
        ("투자 시그널", investment_summary.get("investment_signal_count", len(investment_signals))),
        ("최근 실행", format_date(summary.get("run_started_at"))),
    ]
    for idx, (label, value) in enumerate(metrics):
        report.draw_metric(42 + (idx % 3) * 166, y, label, value, 150)
        if idx == 2:
            y -= 70
    y -= 78

    indicator_rows = []
    counts = investment_summary.get("counts_by_indicator", {})
    for item in indicators:
        count_data = counts.get(item["id"], {})
        indicator_rows.append(
            {
                "no": str(item["no"]),
                "label": item["label_ko"],
                "description": item["description_ko"],
                "count": str(count_data.get("count", 0)),
                "companies": ", ".join(count_data.get("companies", [])[:10]),
            }
        )

    y = report.draw_table(
        indicator_rows,
        [
            {"key": "no", "label": "No", "max_lines": 1},
            {"key": "label", "label": "지표", "max_lines": 2},
            {"key": "description", "label": "판단 기준", "max_lines": 2},
            {"key": "count", "label": "건수", "max_lines": 1},
            {"key": "companies", "label": "주요 기업", "max_lines": 2},
        ],
        42,
        y,
        [28, 128, 176, 42, 152],
        title="5대 투자동향 지표별 포착 결과",
    )

    top_companies = Counter(row.get("company") for row in investment_signals).most_common(12)
    company_rows = [{"company": company, "count": str(count)} for company, count in top_companies if company]
    report.draw_table(
        company_rows,
        [{"key": "company", "label": "기업"}, {"key": "count", "label": "시그널 건수"}],
        42,
        y,
        [360, 80],
        title="투자 시그널 상위 기업",
    )

    report.draw_table(
        investment_signals,
        [
            {"key": "investment_signal_label", "label": "투자 시그널", "max_lines": 2, "size": 7.2},
            {"key": "company", "label": "기업", "max_lines": 2, "size": 7.2},
            {"key": "target_technology", "label": "유치필요 품목", "max_lines": 2, "size": 7.0},
            {"key": "title", "label": "제목", "max_lines": 3, "size": 7.2},
            {"key": "evidence", "label": "본문 근거", "max_lines": 3, "size": 7.0, "format": lambda row: (row.get("evidence_snippets") or [""])[0]},
            {"key": "published_at", "label": "게시일", "max_lines": 1, "size": 7.2, "format": lambda row: format_short_date(row.get("published_at"))},
        ],
        34,
        report.new_page("5대 투자동향 시그널 상세"),
        [82, 60, 100, 126, 126, 38],
        row_min_height=36,
    )

    report.draw_table(
        relevant,
        [
            {"key": "company", "label": "기업", "max_lines": 2, "size": 7.2},
            {"key": "target_technology", "label": "유치필요 품목", "max_lines": 2, "size": 7.2},
            {"key": "title", "label": "제목", "max_lines": 3, "size": 7.2},
            {"key": "matched_terms", "label": "매칭 키워드", "max_lines": 2, "size": 7.0, "format": lambda row: ", ".join(row.get("matched_terms", [])[:8])},
            {"key": "published_at", "label": "게시일", "max_lines": 1, "size": 7.2, "format": lambda row: format_date(row.get("published_at"))},
        ],
        34,
        report.new_page("기술 관련 후보 상세"),
        [74, 116, 176, 118, 48],
        row_min_height=34,
    )

    report.draw_table(
        signals,
        [
            {"key": "company", "label": "기업", "max_lines": 2, "size": 7.0},
            {"key": "title", "label": "제목", "max_lines": 3, "size": 7.0},
            {"key": "source", "label": "출처", "max_lines": 2, "size": 7.0},
            {"key": "source_type", "label": "유형", "max_lines": 1, "size": 7.0},
            {"key": "published_at", "label": "게시일", "max_lines": 1, "size": 7.0, "format": lambda row: format_date(row.get("published_at"))},
        ],
        34,
        report.new_page("전체 수집 결과 부록"),
        [78, 224, 148, 40, 42],
        row_min_height=30,
    )

    report.finish()
    print(json.dumps({"output": str(out_path), "pages_estimated": report.page_no}, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--signals", required=True)
    parser.add_argument("--summary", required=True)
    parser.add_argument("--relevant", required=True)
    parser.add_argument("--relevance-summary", required=True)
    parser.add_argument("--investment-signals", required=True)
    parser.add_argument("--investment-summary", required=True)
    parser.add_argument("--indicator-config", required=True)
    parser.add_argument("--font", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    build_report(args)


if __name__ == "__main__":
    main()
