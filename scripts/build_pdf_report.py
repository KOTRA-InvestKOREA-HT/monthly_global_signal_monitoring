"""월간 보고서 PDF 를 그린다.

무엇이 실리는지는 scripts/report_content.py 가 정한다. 이 파일은 그 결과를 페이지 위에 놓는
일만 한다: 색과 글꼴, 좌표와 여백, 줄바꿈과 잘림, 표와 카드, 쪽 나눔.

내용 계층을 그대로 다시 내보내므로 build_pdf_report.<이름> 은 예전과 같이 쓸 수 있다.
scripts/report_view_model.py 와 테스트가 그 이름들로 들어온다.
"""

import argparse
import json
import re
import sys
import tempfile
import types
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont as ReportLabTTFont
from reportlab.pdfgen import canvas

import report_content
from report_content import *  # noqa: F401,F403  내용 계층을 그대로 다시 내보낸다.


# LANG 은 set_language 가 바꾸는 값이다. 여느 이름처럼 가져다 두면 사본이 생겨, 언어를 바꾼
# 뒤에도 이쪽에는 옛 값이 남는다. 읽기도 쓰기도 내용 계층을 거치게 해서 두 모듈이 언제나 같은
# 언어를 본다. report_view_model 은 build_pdf_report.LANG 을 읽고 테스트는 거기에 대입한다.
class _LanguageAwareModule(types.ModuleType):
    @property
    def LANG(self):
        return report_content.LANG

    @LANG.setter
    def LANG(self, value):
        report_content.LANG = value


sys.modules[__name__].__class__ = _LanguageAwareModule


PAGE_W = 7.5 * 72
PAGE_H = 10.8333333333 * 72

NAVY = colors.HexColor("#122844")
GOLD = colors.HexColor("#DCA72F")
LIGHT = colors.HexColor("#EEF3F7")
TABLE_LINE = colors.HexColor("#D8DDE4")
BOX_LINE = colors.HexColor("#E4EAF0")
TEAL_BG = colors.HexColor("#EAF7F4")
TEAL_LINE = colors.HexColor("#9EDCD3")
TEXT = colors.HexColor("#10243E")
# 흰 배경에서 #8591A3 은 대비 3.19:1 로 WCAG AA(4.5:1) 미달이라 7.1pt 출처가 읽히지
# 않았다. 4.59:1 로 올린다. report_html.mjs 의 COLORS.muted 와 같은 값을 쓴다.
MUTED = colors.HexColor("#6B7688")
GREY_TEXT = colors.HexColor("#8591A3")
WHITE = colors.white
KOTRA_LOGO_PATH = PROJECT_ROOT / "assets" / "images" / "kotra_logo_white.png"
INVEST_KOREA_LOGO_PATH = PROJECT_ROOT / "assets" / "images" / "invest_korea_logo_white.png"
# Role names are kept from the earlier Noto Sans KR cuts; "demilight" is the body text weight.
# Pretendard JP rather than plain Pretendard: source lines quote Japanese kana and kanji.
FONT_WEIGHTS = {
    "demilight": 400,
    "medium": 500,
    "semibold": 600,
    "extrabold": 800,
}
FONT_FILES = {
    "demilight": "PretendardJP-Regular.ttf",
    "medium": "PretendardJP-Medium.ttf",
    "semibold": "PretendardJP-SemiBold.ttf",
    "extrabold": "PretendardJP-ExtraBold.ttf",
}


def wrap_text(canvas_obj, text, max_width, font_name, font_size):
    text = clean_text(text)
    if not text:
        return [""]
    lines = []
    current = ""
    for token in text.split(" "):
        candidate = token if not current else f"{current} {token}"
        if canvas_obj.stringWidth(candidate, font_name, font_size) <= max_width:
            current = candidate
            continue
        if current:
            lines.append(current)
            current = token
            continue
        chunk = ""
        for char in token:
            candidate_chunk = f"{chunk}{char}"
            if canvas_obj.stringWidth(candidate_chunk, font_name, font_size) <= max_width:
                chunk = candidate_chunk
            else:
                if chunk:
                    lines.append(chunk)
                chunk = char
        current = chunk
    if current:
        lines.append(current)
    return lines


# 고정폭 슬롯에서 잘려나간 문구. slot 이름을 준 호출만 모은다.
# 줄바꿈 꼬리를 다듬는 호출은 정상 동작이라 대상이 아니다.
CLIPPED = []


def clipping_report():
    """잘린 문구를 stderr로 알린다. 슬롯 폭은 서로 연동돼 있어 문구 하나만
    고쳐도 옆 슬롯이 좁아지므로, 조용히 넘어가면 잘린 PDF가 그대로 배포된다."""
    if not CLIPPED:
        return
    print(f"WARNING: {len(CLIPPED)} text run(s) were clipped to fit", file=sys.stderr)
    for item in CLIPPED:
        print(
            f"  {item['slot']} ({item['font_size']}pt, {item['max_width']:.1f}pt slot): {item['text']!r}",
            file=sys.stderr,
        )


def short_text_to_width(canvas_obj, text, max_width, font_name, font_size, slot=None):
    text = " ".join(str(text or "").replace("&nbsp;", " ").split())
    if not text:
        return ""
    if canvas_obj.stringWidth(text, font_name, font_size) <= max_width:
        return text
    if slot:
        CLIPPED.append({"slot": slot, "font_size": font_size, "max_width": max_width, "text": text})
    suffix = "..."
    if canvas_obj.stringWidth(suffix, font_name, font_size) > max_width:
        return ""
    lo, hi = 0, len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        candidate = text[:mid].rstrip() + suffix
        if canvas_obj.stringWidth(candidate, font_name, font_size) <= max_width:
            lo = mid
        else:
            hi = mid - 1
    head = text[:lo].rstrip()
    # 영문은 단어 중간에서 끊기면 뜻이 깨지므로 마지막 공백까지 되돌린다.
    # 한 단어를 통째로 버릴 만큼 많이 잘려나가면 그대로 둔다(한글처럼 공백이 드문 문장 보호).
    if " " in head and not text[lo : lo + 1].isspace():
        word_head = head.rsplit(" ", 1)[0].rstrip(" ,;:·-")
        if word_head and len(word_head) >= len(head) * 0.6:
            head = word_head
    return head + suffix if head else suffix


def fit_sentences(canvas_obj, text, max_width, font_name, font_size, max_lines):
    """주어진 줄 수 안에 들어가는 만큼만 문장 단위로 담아 문장 중간에서 잘리지 않게 한다."""
    text = clean_text(text)
    if not text:
        return ""
    sentences = split_sentences(text)
    if not sentences:
        return ""

    picked = ""
    for sentence in sentences:
        candidate = sentence if not picked else f"{picked} {sentence}"
        if len(wrap_text(canvas_obj, candidate, max_width, font_name, font_size)) > max_lines:
            break
        picked = candidate
    if picked:
        return picked

    # 첫 문장 하나도 줄 수를 넘으면 마지막 줄만 폭에 맞춰 줄인다.
    lines = wrap_text(canvas_obj, sentences[0], max_width, font_name, font_size)
    head = " ".join(lines[: max_lines - 1])
    tail = short_text_to_width(canvas_obj, f"{lines[max_lines - 1]}...", max_width, font_name, font_size)
    return f"{head} {tail}".strip()


def draw_justified_line(canvas_obj, x, y, line, max_width, font_name, font_size):
    words = line.split(" ")
    if len(words) <= 1:
        canvas_obj.drawString(x, y, line)
        return
    word_width = sum(canvas_obj.stringWidth(word, font_name, font_size) for word in words)
    gap_count = len(words) - 1
    gap_width = max((max_width - word_width) / gap_count, canvas_obj.stringWidth(" ", font_name, font_size))
    cursor = x
    for index, word in enumerate(words):
        canvas_obj.drawString(cursor, y, word)
        cursor += canvas_obj.stringWidth(word, font_name, font_size)
        if index < gap_count:
            cursor += gap_width


def instantiate_variable_font(font_path, weight, out_dir):
    from fontTools.ttLib import TTFont as FontToolsTTFont
    from fontTools.varLib import instancer

    font = FontToolsTTFont(str(font_path))
    instanced = instancer.instantiateVariableFont(font, {"wght": weight}, inplace=False)
    out_file = out_dir / f"PretendardJP-{weight}.ttf"
    instanced.save(str(out_file))
    return out_file


def register_fonts(font_path):
    source = Path(font_path)
    temp_work = tempfile.TemporaryDirectory(prefix="pretendard-jp-")
    temp_dir = Path(temp_work.name)
    fonts = {}
    try:
        for role, weight in FONT_WEIGHTS.items():
            static_file = source.parent / FONT_FILES[role]
            font_file = static_file if static_file.exists() else instantiate_variable_font(source, weight, temp_dir)
            font_name = f"PretendardJP-{role}"
            report_font = ReportLabTTFont(font_name, str(font_file))
            report_font.face.name = font_name.encode("ascii")
            pdfmetrics.registerFont(report_font)
            fonts[role] = font_name
    except Exception:
        fonts = {}
        for role in FONT_WEIGHTS:
            font_name = f"PretendardJP-{role}"
            report_font = ReportLabTTFont(font_name, str(source))
            report_font.face.name = font_name.encode("ascii")
            pdfmetrics.registerFont(report_font)
            fonts[role] = font_name
    finally:
        temp_work.cleanup()
    return fonts


class SlideReport:
    def __init__(self, out_path, fonts, issue_number):
        self.out_path = out_path
        self.fonts = fonts
        self.font = fonts["demilight"]
        self.bold_font = fonts["semibold"]
        self.issue_no = f"Issue {issue_number}"
        self.canvas = canvas.Canvas(str(out_path), pagesize=(PAGE_W, PAGE_H))
        self.page_no = 0

    def font_for(self, weight="demilight", bold=False):
        if bold:
            return self.fonts["semibold"]
        return self.fonts.get(weight, self.font)

    def set_font(self, size, color=TEXT, weight="demilight", bold=False):
        self.canvas.setFont(self.font_for(weight, bold), size)
        self.canvas.setFillColor(color)

    def text(self, x, y, value, size=10, color=TEXT, bold=False, align="left", weight="demilight"):
        self.set_font(size, color, weight=weight, bold=bold)
        value = str(value or "")
        if align == "right":
            self.canvas.drawRightString(x, y, value)
        elif align == "center":
            self.canvas.drawCentredString(x, y, value)
        else:
            self.canvas.drawString(x, y, value)

    def spaced_text(self, x, y, value, size=10, color=TEXT, weight="demilight", char_space=0.6):
        font_name = self.font_for(weight)
        self.set_font(size, color, weight=weight)
        cursor_x = x
        for char in str(value or ""):
            self.canvas.drawString(cursor_x, y, char)
            cursor_x += self.canvas.stringWidth(char, font_name, size) + char_space

    def wrapped(self, text, x, y, max_width, size=10, color=TEXT, max_lines=0, line_gap=3, bold=False, weight="demilight", align="left"):
        font_name = self.font_for(weight, bold)
        lines = wrap_text(self.canvas, text, max_width, font_name, size)
        if max_lines and len(lines) > max_lines:
            lines = lines[:max_lines]
            # 글자 수가 아니라 실제 폭으로 잘라야 영문에서도 마지막 줄이 폭을 넘지 않는다.
            last = lines[-1]
            if self.canvas.stringWidth(f"{last}...", font_name, size) <= max_width:
                lines[-1] = f"{last}..."
            else:
                lines[-1] = short_text_to_width(self.canvas, last, max_width, font_name, size)
        self.set_font(size, color, weight=weight, bold=bold)
        line_height = size + line_gap
        for line in lines:
            if align == "center":
                self.canvas.drawCentredString(x + max_width / 2, y, line)
            elif align == "justify" and line != lines[-1]:
                draw_justified_line(self.canvas, x, y, line, max_width, font_name, size)
            else:
                self.canvas.drawString(x, y, line)
            y -= line_height
        return y

    def new_page(self):
        if self.page_no:
            self.canvas.showPage()
        self.page_no += 1

    def footer(self):
        c = self.canvas
        c.setFillColor(colors.HexColor("#EFF4F8"))
        c.rect(0, 0, PAGE_W, 38, fill=1, stroke=0)
        c.setStrokeColor(TABLE_LINE)
        c.setLineWidth(0.7)
        c.line(0, 38, PAGE_W, 38)
        self.text(42, 16, t("footer", issue=self.issue_no), 8, MUTED)
        self.text(PAGE_W - 42, 16, f"{self.page_no:02d}", 8, TEXT, align="right", weight="semibold")

    def header(self, kicker, title, page_fraction=""):
        c = self.canvas
        c.setFillColor(NAVY)
        c.rect(0, PAGE_H - 92, PAGE_W, 92, fill=1, stroke=0)
        c.setFillColor(GOLD)
        c.rect(0, PAGE_H - 100, PAGE_W, 8, fill=1, stroke=0)
        suffix = f" · {page_fraction}" if page_fraction else ""
        self.text(43, PAGE_H - 39, f"{kicker}{suffix}", 9, GOLD, weight="medium")
        self.text(43, PAGE_H - 66, title, 22, WHITE, weight="semibold")

    def finish(self):
        self.canvas.save()


# 로고 PNG를 지정한 높이로 원본 비율대로 그리고 실제 폭을 돌려준다.
# 파일이 없으면 0을 돌려주므로 호출부가 기존 텍스트 표기로 되돌아갈 수 있다.
def draw_logo(c, path, x, y, height, align="left"):
    if not path.exists():
        return 0
    image = ImageReader(str(path))
    native_width, native_height = image.getSize()
    width = native_width * height / native_height
    c.drawImage(image, x - width if align == "right" else x, y, width=width, height=height, mask="auto")
    return width


def draw_cover(report, summary, indicators):
    report.new_page()
    c = report.canvas
    c.setFillColor(GOLD)
    c.rect(0, PAGE_H - 8, PAGE_W, 8, fill=1, stroke=0)
    c.setFillColor(NAVY)
    c.rect(0, 0, PAGE_W, PAGE_H - 8, fill=1, stroke=0)

    report.text(PAGE_W - 42, PAGE_H - 58, report.issue_no, 18, WHITE, align="right", weight="semibold")
    report.text(PAGE_W - 42, PAGE_H - 78, issue_month(summary), 10, colors.HexColor("#C8D2DF"), align="right", weight="medium")

    text_width = PAGE_W - 86
    y = PAGE_H - 208
    kicker = cover_kicker()
    if kicker:
        report.text(43, y, kicker, 12, GOLD, weight="medium")
    # 제목은 잘라내면 뜻이 사라지므로, 여백을 넘지 않을 때까지 크기를 줄여서 통째로 싣는다.
    title_size = 30 if report_content.LANG == "en" else 36
    titles = cover_titles()
    while title_size > 18 and any(
        c.stringWidth(title, report.fonts["semibold"], title_size) > text_width for title in titles
    ):
        title_size -= 1
    for index, title in enumerate(titles):
        # kicker 가 없는 표지는 그 자리를 빈 띠로 남기지 않는다. 제목이 첫 줄이 되므로 kicker
        # 베이스라인만큼만 내려 제목 윗변이 kicker 윗변 자리에 오게 한다.
        y -= (56 if kicker else 26) if index == 0 else 45
        report.text(43, y, title, title_size, GOLD if index == cover_title_accent() else WHITE, weight="semibold")

    y -= 42
    report.text(43, y, short_text_to_width(c, t("cover_line_1"), text_width, report.fonts["demilight"], 12, "cover_line_1"), 12, WHITE)
    y -= 20
    report.text(43, y, short_text_to_width(c, t("cover_line_2"), text_width, report.fonts["demilight"], 12, "cover_line_2"), 12, WHITE)

    y -= 45
    report.text(43, y, t("cover_indicator_heading"), 9, colors.HexColor("#C8D2DF"))
    y -= 29
    for item in indicators:
        c.setStrokeColor(GOLD)
        c.setLineWidth(1.2)
        c.circle(46, y + 4, 10, stroke=1, fill=0)
        report.text(46, y, str(item["no"]), 9, GOLD, align="center", weight="semibold")
        if report_content.LANG == "en":
            label = SIGNAL_DESCRIPTIONS_EN[item["no"]].split(" · ", 1)[0]
            description = INDICATOR_DESCRIPTION_EN.get(item["no"], item.get("description_ko", ""))
        else:
            label = item["label_ko"]
            description = item["description_ko"]
        # 라벨을 먼저 폭 안에 맞추고, 설명은 남은 자리만큼만 쓴다.
        # 예전에는 남은 폭에 하한 60pt를 걸어서, 라벨이 길면 설명이 라벨 위로 겹쳐 찍혔다.
        label = short_text_to_width(c, label, PAGE_W - 43 - 67, report.fonts["semibold"], 12, f"cover_indicator_label[{item['no']}]")
        report.text(67, y - 1, label, 12, WHITE, weight="semibold")
        label_w = c.stringWidth(label, report.fonts["semibold"], 12)
        description_width = PAGE_W - 43 - (67 + label_w + 16)
        if description_width >= 50:
            description = short_text_to_width(c, description, description_width, report.fonts["demilight"], 8, f"cover_indicator_desc[{item['no']}]")
            report.text(PAGE_W - 43, y - 1, description, 8, colors.HexColor("#C8D2DF"), align="right")
        y -= 32

    c.setStrokeColor(colors.HexColor("#D6DEE9"))
    c.setLineWidth(0.7)
    c.line(43, 62, PAGE_W - 43, 62)
    if not draw_logo(c, KOTRA_LOGO_PATH, 43, 20, 34):
        report.text(43, 42, "kotra", 20, WHITE, weight="semibold")
        report.text(43, 29, "Korea Trade-Investment", 6.5, colors.HexColor("#C8D2DF"))
        report.text(43, 20, "Promotion Agency", 6.5, colors.HexColor("#C8D2DF"))
    if not draw_logo(c, INVEST_KOREA_LOGO_PATH, PAGE_W - 43, 21, 32, align="right"):
        report.text(PAGE_W - 43, 31, "Invest KOREA", 11, WHITE, align="right", weight="semibold")


def draw_matrix_table(report, profiles, signal_index, covered, x, y_top, right=False):
    c = report.canvas
    table_w = 242
    header_h = 16
    row_h = 12.8
    index_x = x + 13
    name_x = x + 30
    signal_xs = [x + 152, x + 170, x + 188, x + 206, x + 224]

    c.setFillColor(NAVY)
    c.rect(x, y_top - header_h, table_w, header_h, fill=1, stroke=0)
    report.text(x + 7, y_top - 11, t("matrix_company"), 8, WHITE, weight="semibold")
    for idx, signal_no in enumerate(["①", "②", "③", "④", "⑤"]):
        report.text(signal_xs[idx] + 4, y_top - 10.5, signal_no, 7, WHITE, align="center", weight="semibold")

    y = y_top - header_h
    for profile in profiles:
        y -= row_h
        c.setStrokeColor(TABLE_LINE)
        c.setLineWidth(0.45)
        c.line(x, y, x + table_w, y)
        report.text(index_x, y + 3.7, str(profile["target_no"]), 6, colors.HexColor("#737C86"), align="center")
        report.text(name_x, y + 3.7, profile.get("display_name") or profile["company"], 6, TEXT)
        for idx in range(5):
            # 칸은 두 가지뿐이다. 금색으로 채우면 AI 확인 시그널, 회색이면 신호없음.
            if signal_cell_state(signal_index, profile["company"], idx + 1) == "on":
                c.setFillColor(GOLD)
            else:
                c.setFillColor(LIGHT)
            c.roundRect(signal_xs[idx], y + 3.0, 8.2, 8.2, 2, fill=1, stroke=0)


def draw_matrix(report, profiles, signal_index, summary, signal_rows):
    report.new_page()
    report.header("S I G N A L   M A T R I X", t("matrix_title"))
    signal_companies = [p for p in profiles if any(signal_index.get(p["company"], {}).values())]
    signal_company_names = {item["company"] for item in signal_companies}

    desc = t("matrix_desc", period=matrix_period_label(summary))
    report.wrapped(desc, 28, PAGE_H - 128, PAGE_W - 56, 8, colors.HexColor("#555F6E"), max_lines=2, line_gap=4, align="justify")

    covered = covered_companies(summary, signal_rows)
    draw_matrix_table(report, profiles[:39], signal_index, covered, 25, PAGE_H - 145)
    draw_matrix_table(report, profiles[39:], signal_index, covered, 281, PAGE_H - 145, right=True)

    y = 88
    c = report.canvas
    legend_color = colors.HexColor("#596579")
    legend_x = 32
    for mark, label in (("on", t("matrix_legend_on")), ("off", t("matrix_legend_off"))):
        c.setFillColor(GOLD if mark == "on" else LIGHT)
        c.roundRect(legend_x, y + 9, 8, 8, 2, fill=1, stroke=0)
        report.text(legend_x + 13, y + 9, label, 8, legend_color)
        legend_x += 13 + c.stringWidth(label, report.fonts["demilight"], 8) + 18
    report.text(
        32,
        y - 6,
        short_text_to_width(c, t("matrix_indicators"), PAGE_W - 64, report.fonts["demilight"], 7, "matrix_indicators"),
        7,
        MUTED,
    )
    # 각주는 행 상태를 센 것이다. 따로 계산하면 표와 숫자가 어긋난다.
    statuses = [company_status(profile["company"], signal_index, covered) for profile in profiles]
    footnote = t(
        "matrix_footnote",
        on=statuses.count("detected"),
        off=statuses.count("reviewed"),
        total=len(profiles),
    )
    report.text(
        32,
        y - 24,
        short_text_to_width(c, footnote, PAGE_W - 64, report.fonts["extrabold"], 8, "matrix_footnote"),
        8,
        colors.HexColor("#4B5870"),
        weight="extrabold",
    )
    report.footer()


def summary_text_layout(report, row, width, size, max_lines):
    """Measure the same styled lines used for painting and source/box placement."""
    parts = summary_parts(row)
    if not parts:
        sections = [(detail_text(row, 560), "demilight", TEXT)]
    else:
        sections = [(parts["headline"], "semibold", TEXT)]
        if parts["detail"]:
            inline = sections + [(" — " + parts["detail"], "demilight", colors.black)]
            if sum(report.canvas.stringWidth(text, report.fonts[weight], size)
                   for text, weight, _ in inline) <= width:
                return [inline]
            sections.append(("— " + parts["detail"], "demilight", colors.black))
    lines = []
    for text, weight, color in sections:
        for line in wrap_text(report.canvas, text, width, report.fonts[weight], size):
            lines.append([(line, weight, color)])
    if max_lines and len(lines) > max_lines:
        lines = lines[:max_lines]
        text, weight, color = lines[-1][0]
        text = short_text_to_width(report.canvas, text + "...", width, report.fonts[weight], size)
        lines[-1] = [(text, weight, color)]
    return lines


def summary_line_count(report, row, width, size, max_lines):
    return max(1, len(summary_text_layout(report, row, width, size, max_lines)))


def draw_summary_text(report, row, x, y, width, size=9.2, max_lines=2, line_gap=3):
    lines = summary_text_layout(report, row, width, size, max_lines)
    for line in lines:
        cursor = x
        for text, weight, color in line:
            report.text(cursor, y, text, size, color, weight=weight)
            cursor += report.canvas.stringWidth(text, report.fonts[weight], size)
        y -= size + line_gap
    return max(1, len(lines))


def draw_badge(report, x, y, value, active):
    c = report.canvas
    c.setFillColor(NAVY if active else colors.HexColor("#D8DADF"))
    c.roundRect(x, y - 9, 16, 16, 3, fill=1, stroke=0)
    report.text(x + 8, y - 4.5, str(value), 9, WHITE, align="center", weight="semibold")


def draw_industry_pill(report, x, y, max_width, text, color):
    """산업 라벨 알약. 글자를 먼저 폭에 맞춘 뒤 알약을 그 글자에 맞춰 그린다.

    예전에는 알약 폭만 132pt로 자르고 글자는 원문 그대로 찍어서, 영문 산업명처럼
    긴 라벨이 알약 밖으로 튀어나오고 뒤따르는 국가명과 겹쳤다.
    """
    text = short_text_to_width(report.canvas, text, max_width - 18, report.fonts["semibold"], 9, "industry_pill")
    if not text:
        return 0
    pill_width = report.canvas.stringWidth(text, report.fonts["semibold"], 9) + 18
    report.canvas.setFillColor(LIGHT)
    report.canvas.roundRect(x, y - 7, pill_width, 18, 3, fill=1, stroke=0)
    report.text(x + 9, y - 2, text, 9, color, weight="semibold")
    return pill_width


DETAIL_BOX_TOP = PAGE_H - 114
DETAIL_BOX_GAP = 16
DETAIL_BOTTOM_MARGIN = 56
DETAIL_FIRST_SIGNAL_BASELINE_OFFSET = 64
DETAIL_SIGNAL_BOTTOM_PAD = 24
SIGNAL_LABEL_TOP_OFFSET = 7
SIGNAL_LABEL_TO_BODY = 23
SIGNAL_BODY_SIZE = 8.8
SIGNAL_BODY_GAP = 1.6
SIGNAL_SOURCE_SIZE = 7.1
SIGNAL_SOURCE_GAP = 1.0
SIGNAL_SOURCE_BOTTOM_OFFSET = 2.5
SIGNAL_EMPTY_CONTENT_BOTTOM_OFFSET = 14
SIGNAL_CONTENT_TO_SEPARATOR = 10
SIGNAL_SEPARATOR_TO_NEXT_LABEL_TOP = 6
BUSINESS_MIN_BOX_H = 88
BUSINESS_MAX_BOX_H = 136
BUSINESS_HEADER_TOP_PAD = 25
BUSINESS_BODY_TOP_PAD = 44
BUSINESS_SOURCE_GAP = 8
BUSINESS_SOURCE_BOTTOM_PAD = 15
BUSINESS_BODY_SIZE = 9.0
BUSINESS_BODY_LINE_GAP = 1.35
BUSINESS_BODY_MAX_LINES = 5
# 상세 페이지가 쓸 수 있는 (시그널 본문 줄 수, 사업현황 본문 줄 수) 조합.
# 작은 것부터 시도해 페이지에 들어가는 마지막 조합을 쓴다. 첫 항목은 기존 값이라 최소 보장선이 된다.
DETAIL_GROWTH_STEPS = (
    (2, 5),
    (3, 5),
    (3, 6),
    (4, 6),
    (4, 7),
    (5, 7),
    (5, 8),
    (6, 8),
    (6, 9),
)


def signal_body_line_count(report, row, width, max_lines):
    body_width = width - 64
    return summary_line_count(report, row, body_width, SIGNAL_BODY_SIZE, max_lines)


def signal_content_bottom_offset(report, rows, width, max_lines):
    if not rows:
        return SIGNAL_EMPTY_CONTENT_BOTTOM_OFFSET
    line_count = signal_body_line_count(report, rows[0], width, max_lines)
    return (
        SIGNAL_LABEL_TO_BODY
        + (line_count * (SIGNAL_BODY_SIZE + SIGNAL_BODY_GAP))
        + SIGNAL_SOURCE_GAP
        + SIGNAL_SOURCE_BOTTOM_OFFSET
    )


def signal_box_layout(report, rows_by_signal, width, max_lines):
    y_offset = DETAIL_FIRST_SIGNAL_BASELINE_OFFSET
    positions = {}
    for no in range(1, 6):
        positions[no] = DETAIL_BOX_TOP - y_offset
        content_offset = signal_content_bottom_offset(report, rows_by_signal.get(no, []), width, max_lines)
        if no < 5:
            y_offset += (
                content_offset
                + SIGNAL_CONTENT_TO_SEPARATOR
                + SIGNAL_SEPARATOR_TO_NEXT_LABEL_TOP
                + SIGNAL_LABEL_TOP_OFFSET
            )
        else:
            y_offset += content_offset + DETAIL_SIGNAL_BOTTOM_PAD
    return positions, y_offset


def fitted_business_body(report, text, width, max_lines=BUSINESS_BODY_MAX_LINES):
    font_name = report.fonts["demilight"]
    size = BUSINESS_BODY_SIZE
    line_gap = BUSINESS_BODY_LINE_GAP
    # 박스에 안 들어가는 요약은 문장 단위로 끊어 마지막 문장이 완결되게 한다.
    text = fit_sentences(report.canvas, text, width, font_name, size, max_lines)
    lines = wrap_text(report.canvas, text, width, font_name, size)
    visible = lines[:max_lines]
    if len(lines) > max_lines and visible:
        visible[-1] = short_text_to_width(report.canvas, f"{visible[-1]}...", width, font_name, size)
    return {"lines": visible, "size": size, "line_gap": line_gap, "truncated": len(lines) > max_lines}


def business_box_metrics(report, text, width, max_lines=BUSINESS_BODY_MAX_LINES, extra_top=0):
    body_width = width - 32
    body = fitted_business_body(report, text, body_width, max_lines=max_lines)
    line_count = max(1, len(body["lines"]))
    line_height = body["size"] + body["line_gap"]
    height = (
        BUSINESS_BODY_TOP_PAD
        + extra_top
        + (line_count * line_height)
        + BUSINESS_SOURCE_GAP
        + 8
        + BUSINESS_SOURCE_BOTTOM_PAD
    )
    # 줄 수를 늘려 잡은 만큼, 그리고 타겟품목이 아랫줄로 내려간 만큼 박스 높이 상한도 같이 올린다.
    ceiling = BUSINESS_MAX_BOX_H + extra_top + max(0, max_lines - BUSINESS_BODY_MAX_LINES) * line_height
    body["height"] = max(BUSINESS_MIN_BOX_H + extra_top, min(ceiling, height))
    return body


TARGET_WRAP_HEIGHT = 15


def business_target_layout(report, profile, x, width):
    """청록 박스 머리줄 배치를 미리 계산한다.

    타겟품목 텍스트가 라벨 옆 한 줄에 다 들어가면 예전처럼 옆에 붙이고(국문은 항상 여기),
    안 들어가면 잘라내는 대신 박스를 한 줄 키워 아랫줄에 통째로 싣는다.
    """
    label, text = target_section_for_profile(profile)
    if not text:
        return {"text": "", "wrapped": False, "extra_top": 0}
    c = report.canvas
    heading = t("business_heading")
    heading_w = c.stringWidth(heading, report.fonts["semibold"], 8.5) + 0.85 * len(heading)
    label_x = x + 16 + heading_w + 18
    label_w = c.stringWidth(label, report.fonts["semibold"], 7.6) + 16
    value_x = label_x + label_w + 9
    value_width = (x + width - 16) - value_x
    fits = c.stringWidth(text, report.fonts["semibold"], 9.5) <= value_width
    return {
        "label": label,
        "text": text,
        "label_x": label_x,
        "label_w": label_w,
        "value_x": value_x,
        "value_width": value_width,
        "wrapped": not fits,
        "extra_top": 0 if fits else TARGET_WRAP_HEIGHT,
    }


def draw_signal_row(report, no, rows, x, y, width, max_lines=2, draw_separator=True):
    active = bool(rows)
    c = report.canvas
    draw_badge(report, x, y, no, active)
    label_x = x + 31
    label = SIGNAL_DESCRIPTIONS_EN[no] if report_content.LANG == "en" else SIGNAL_DESCRIPTIONS[no]
    # 알약은 폭 상한이 있으므로 글자를 먼저 그 안에 맞춘다. 예전에는 알약만 잘리고 글자는 그대로 나가서 밖으로 튀어나왔다.
    label = short_text_to_width(report.canvas, label, width - 190 - 16, report.fonts["semibold"], 7.6, f"signal_label[{no}]")
    label_w = report.canvas.stringWidth(label, report.fonts["semibold"], 7.6) + 14
    c.setFillColor(LIGHT)
    c.roundRect(label_x, y - 9, label_w, 16, 3, fill=1, stroke=0)
    report.text(label_x + 8, y - 4, label, 7.6, colors.HexColor("#56687B"), weight="semibold")

    if not active:
        empty_x = label_x + label_w + 18
        empty_text = short_text_to_width(
            report.canvas, t("no_signal"), x + width - 22 - empty_x, report.fonts["demilight"], 10, f"no_signal[{no}]"
        )
        report.text(empty_x, y - 4, empty_text, 10, colors.HexColor("#B5B9BF"))
        report.text(x + width - 12, y - 4, "—", 10, colors.HexColor("#B5B9BF"), align="right")
        if draw_separator:
            c.setStrokeColor(BOX_LINE)
            separator_y = y - SIGNAL_EMPTY_CONTENT_BOTTOM_OFFSET - SIGNAL_CONTENT_TO_SEPARATOR
            c.line(x, separator_y, x + width, separator_y)
        return None

    row = rows[0]
    body_y = y - SIGNAL_LABEL_TO_BODY
    line_count = draw_summary_text(
        report,
        row,
        label_x,
        body_y,
        width - 64,
        SIGNAL_BODY_SIZE,
        max_lines=max_lines,
        line_gap=SIGNAL_BODY_GAP,
    )
    source_y = body_y - ((SIGNAL_BODY_SIZE + SIGNAL_BODY_GAP) * line_count) - SIGNAL_SOURCE_GAP
    source_text = short_text_to_width(report.canvas, source_line(row), width - 64, report.fonts["demilight"], SIGNAL_SOURCE_SIZE, "signal_source")
    report.text(label_x, source_y, source_text, SIGNAL_SOURCE_SIZE, MUTED)
    if draw_separator:
        separator_y = source_y - SIGNAL_SOURCE_BOTTOM_OFFSET - SIGNAL_CONTENT_TO_SEPARATOR
        c.setStrokeColor(BOX_LINE)
        c.line(x, separator_y, x + width, separator_y)
    return None


def draw_detail_page(report, profile, signal_index, relevant_rows, investment_rows, all_signal_rows, idx, total):
    report.new_page()
    report.header("C O M P A N Y   S I G N A L S", t("detail_title"), f"{idx}/{total}")
    company = profile["company"]
    rows_by_signal = signal_index.get(company, {})
    x = 30
    width = PAGE_W - 60
    signal_width = width - 38
    business_row = best_business_row(company, relevant_rows, investment_rows, all_signal_rows,
                                     [rows[0] for rows in rows_by_signal.values() if rows])
    business_body = business_text([business_row] if business_row else [])
    target_layout = business_target_layout(report, profile, x, width)

    # 페이지 아래가 비어 있는데 2줄에서 끊을 이유가 없다. 들어가는 가장 큰 조합을 고른다.
    max_lines, signal_positions, top_h, business_layout = None, None, None, None
    for signal_lines, business_lines in DETAIL_GROWTH_STEPS:
        positions, candidate_top_h = signal_box_layout(report, rows_by_signal, signal_width, signal_lines)
        layout = business_box_metrics(
            report, business_body, width, max_lines=business_lines, extra_top=target_layout["extra_top"]
        )
        used = candidate_top_h + DETAIL_BOX_GAP + layout["height"]
        if max_lines is not None and DETAIL_BOX_TOP - used < DETAIL_BOTTOM_MARGIN:
            break
        max_lines, signal_positions, top_h, business_layout = signal_lines, positions, candidate_top_h, layout

    bottom_h = business_layout["height"]
    top_y = DETAIL_BOX_TOP - top_h
    bottom_y = top_y - DETAIL_BOX_GAP - bottom_h
    c = report.canvas

    c.setStrokeColor(BOX_LINE)
    c.setLineWidth(0.9)
    c.setFillColor(WHITE)
    c.roundRect(x, top_y, width, top_h, 10, fill=1, stroke=1)

    header_y = DETAIL_BOX_TOP - 29
    display_name = profile.get("display_name") or company
    report.text(x + 17, header_y, display_name, 14, TEXT, weight="semibold")
    name_w = report.canvas.stringWidth(display_name, report.bold_font, 14)
    industry_x = min(x + 17 + name_w + 14, x + 250)
    country_text = profile.get("country", "")
    country_w = report.canvas.stringWidth(country_text, report.fonts["semibold"], 9) if country_text else 0
    industry_limit = min(190, (x + width - 17) - country_w - 12 - industry_x)
    industry_w = draw_industry_pill(
        report, industry_x, header_y, industry_limit, profile.get("detailed_industry", ""), colors.HexColor("#56687B")
    )
    report.text(industry_x + industry_w + 10, header_y - 2, country_text, 9, colors.HexColor("#B1B6BE"), weight="semibold")

    c.setStrokeColor(colors.black)
    c.setLineWidth(1)
    c.line(x + 17, header_y - 18, x + width - 17, header_y - 18)

    for no in range(1, 6):
        draw_signal_row(
            report,
            no,
            rows_by_signal.get(no, []),
            x + 19,
            signal_positions[no],
            signal_width,
            max_lines=max_lines,
            draw_separator=no < 5,
        )

    c.setStrokeColor(TEAL_LINE)
    c.setFillColor(TEAL_BG)
    c.roundRect(x, bottom_y, width, bottom_h, 10, fill=1, stroke=1)
    top = bottom_y + bottom_h
    header_y = top - 25
    heading = t("business_heading")
    report.spaced_text(x + 16, header_y, heading, 8.5, colors.HexColor("#087A70"), weight="semibold", char_space=0.85)
    if target_layout["text"]:
        # 품목별 사업동향 카드와 같은 회색 라벨. 이모지와 청록 배경 위 청록 글씨는 보고서 톤과 대비 모두 어긋났다.
        c.setFillColor(WHITE)
        c.roundRect(target_layout["label_x"], top - 30, target_layout["label_w"], 16, 3, fill=1, stroke=0)
        report.text(
            target_layout["label_x"] + 8, header_y, target_layout["label"], 7.6, colors.HexColor("#56687B"), weight="semibold"
        )
        if target_layout["wrapped"]:
            # 라벨 옆에 안 들어가는 타겟품목은 잘라내지 않고 박스 폭 전체를 쓰는 아랫줄에 싣는다.
            wrapped_text = short_text_to_width(c, target_layout["text"], width - 32, report.fonts["semibold"], 9.5, "detail_target_tech")
            report.text(
                x + 16, header_y - TARGET_WRAP_HEIGHT, wrapped_text, 9.5, TEXT, weight="semibold"
            )
        else:
            report.text(
                target_layout["value_x"], header_y, target_layout["text"], 9.5, TEXT, weight="semibold"
            )

    body_y = top - BUSINESS_BODY_TOP_PAD - target_layout["extra_top"]
    report.set_font(business_layout["size"], TEXT, weight="demilight")
    line_height = business_layout["size"] + business_layout["line_gap"]
    for line in business_layout["lines"]:
        report.canvas.drawString(x + 16, body_y, line)
        body_y -= line_height
    source_y = max(bottom_y + BUSINESS_SOURCE_BOTTOM_PAD, body_y - BUSINESS_SOURCE_GAP)
    # 근접 행으로 채운 상자는 그 사실을 밝힌다. 표시를 출처 줄과 같은 기준선에 오른쪽으로 붙이는 것은
    # 머리글의 품목 라벨 배치(target_layout)를 건드리지 않고 넣을 수 있는 자리가 여기뿐이기 때문이다.
    # HTML 렌더러는 머리글에 알약으로 넣는다. 두 렌더러가 같은 사실을 싣는 것이 기준이고 위치는 각자의 배치를 따른다.
    note = t("business_near_miss_note") if business_near_miss(business_row) else ""
    source_width = width - 32 - (report.canvas.stringWidth(note, report.fonts["demilight"], 8) + 10 if note else 0)
    if business_row:
        source_text = short_text_to_width(report.canvas, source_line(business_row), source_width, report.fonts["demilight"], 8, "business_source")
        report.text(x + 16, source_y, source_text, 8, MUTED)
    else:
        report.text(x + 16, source_y, t("source_empty"), 8, MUTED)
    if note:
        report.text(x + width - 16, source_y, note, 8, MUTED, align="right")
    report.footer()


ITEM_SECTION_TOP = PAGE_H - 114
ITEM_SECTION_FIRST_TOP = PAGE_H - 158
ITEM_SECTION_BOTTOM = 56
ITEM_CARD_GAP = 14
ITEM_CARD_TITLE_TOP = 29
ITEM_CARD_TITLE_TO_RULE = 18
ITEM_RULE_TO_TARGET = 21
ITEM_TARGET_TO_TREND = 24
ITEM_TREND_LABEL_TO_BODY = 19
ITEM_BODY_SIZE = 8.8
ITEM_BODY_GAP = 2.0
ITEM_BODY_MAX_LINES = 6
ITEM_BODY_TO_SOURCE = 11
ITEM_SOURCE_SIZE = 7.1
ITEM_CARD_BOTTOM_PAD = 16
ITEM_LABEL_SIZE = 7.6
ITEM_LABEL_COLOR = colors.HexColor("#56687B")


def item_trend_body(report, row, width, size, max_lines):
    """카드 본문은 명사구 캡션이 아니라 완결된 서술 문장으로 채운다.

    요약문을 문장 단위로 끊어 max_lines 안에 들어가는 데까지만 담기 때문에,
    문장 중간에서 '...'로 잘리지 않고 '무엇을 했다 / 하고 있다'로 끝난다.
    """
    font_name = report.fonts["demilight"]
    text = item_trend_text(row)
    body = fit_sentences(report.canvas, text, width, font_name, size, max_lines)
    if not body:
        return "", 1
    return body, max(1, min(max_lines, len(wrap_text(report.canvas, body, width, font_name, size))))


def item_card_layout(report, entry, width):
    body_width = width - 34
    _, line_count = item_trend_body(report, entry["row"], body_width, ITEM_BODY_SIZE, ITEM_BODY_MAX_LINES)
    rule_offset = ITEM_CARD_TITLE_TOP + ITEM_CARD_TITLE_TO_RULE
    target_offset = rule_offset + ITEM_RULE_TO_TARGET
    trend_offset = target_offset + ITEM_TARGET_TO_TREND
    body_offset = trend_offset + ITEM_TREND_LABEL_TO_BODY
    source_offset = body_offset + ((line_count - 1) * (ITEM_BODY_SIZE + ITEM_BODY_GAP)) + ITEM_BODY_TO_SOURCE
    return {
        "body_width": body_width,
        "rule_offset": rule_offset,
        "target_offset": target_offset,
        "trend_offset": trend_offset,
        "body_offset": body_offset,
        "source_offset": source_offset,
        "height": source_offset + ITEM_CARD_BOTTOM_PAD,
    }


def draw_label_pill(report, x, y, label):
    c = report.canvas
    pill_width = c.stringWidth(label, report.fonts["semibold"], ITEM_LABEL_SIZE) + 14
    c.setFillColor(LIGHT)
    c.roundRect(x, y - 5, pill_width, 15, 3, fill=1, stroke=0)
    report.text(x + 7, y, label, ITEM_LABEL_SIZE, ITEM_LABEL_COLOR, weight="semibold")
    return pill_width


def draw_item_card(report, entry, layout, x, top, width, month_label):
    c = report.canvas
    profile = entry["profile"]
    row = entry["row"]
    company = profile["company"]

    c.setStrokeColor(BOX_LINE)
    c.setLineWidth(0.9)
    c.setFillColor(WHITE)
    c.roundRect(x, top - layout["height"], width, layout["height"], 10, fill=1, stroke=1)

    header_y = top - ITEM_CARD_TITLE_TOP
    display_name = profile.get("display_name") or company
    report.text(x + 17, header_y, display_name, 13, TEXT, weight="semibold")
    name_w = c.stringWidth(display_name, report.bold_font, 13)
    industry_text = profile.get("detailed_industry", "")
    country_text = profile.get("country", "")
    country_w = c.stringWidth(country_text, report.fonts["semibold"], 9) if country_text else 0
    if industry_text:
        industry_x = min(x + 17 + name_w + 14, x + 250)
        industry_limit = min(190, (x + width - 17) - country_w - 12 - industry_x)
        draw_industry_pill(report, industry_x, header_y, industry_limit, industry_text, ITEM_LABEL_COLOR)
    report.text(x + width - 17, header_y - 2, country_text, 9, GREY_TEXT, align="right", weight="semibold")

    rule_y = top - layout["rule_offset"]
    c.setStrokeColor(colors.black)
    c.setLineWidth(1)
    c.line(x + 17, rule_y, x + width - 17, rule_y)

    target_y = top - layout["target_offset"]
    target_pill_w = draw_label_pill(report, x + 17, target_y, t("item_target_label"))
    target_x = x + 17 + target_pill_w + 10
    target_text = short_text_to_width(
        c, item_target_text(profile), x + width - 17 - target_x, report.fonts["semibold"], 9.5,
        "item_target_tech",
    )
    report.text(target_x, target_y, target_text, 9.5, TEXT, weight="semibold")

    draw_label_pill(report, x + 17, top - layout["trend_offset"], t("item_trend_label", month=month_label))

    body, _ = item_trend_body(report, row, layout["body_width"], ITEM_BODY_SIZE, ITEM_BODY_MAX_LINES)
    report.wrapped(
        body,
        x + 17,
        top - layout["body_offset"],
        layout["body_width"],
        ITEM_BODY_SIZE,
        colors.black,
        max_lines=ITEM_BODY_MAX_LINES,
        line_gap=ITEM_BODY_GAP,
        weight="demilight",
    )
    source_text = short_text_to_width(c, source_line(row), layout["body_width"], report.fonts["demilight"], ITEM_SOURCE_SIZE, "item_source")
    report.text(x + 17, top - layout["source_offset"], source_text, ITEM_SOURCE_SIZE, MUTED)


def greedy_item_breaks(heights):
    """띠 아래를 넘기는 카드는 다음 장에서 시작한다. 띠보다 큰 카드 하나는 그대로 둔다."""
    breaks = []
    cursor = ITEM_SECTION_FIRST_TOP
    on_sheet = 0
    for index, height in enumerate(heights):
        if on_sheet and cursor - height < ITEM_SECTION_BOTTOM:
            breaks.append(index)
            cursor = ITEM_SECTION_TOP
            on_sheet = 0
        cursor -= height + ITEM_CARD_GAP
        on_sheet += 1
    return breaks


def _item_sheet_fits(heights, start, end, first):
    cursor = ITEM_SECTION_FIRST_TOP if first else ITEM_SECTION_TOP
    for index in range(start, end):
        if index > start and cursor - heights[index] < ITEM_SECTION_BOTTOM:
            return False
        cursor -= heights[index] + ITEM_CARD_GAP
    return True


def _item_plan_fits(heights, breaks):
    edges = [0, *breaks, len(heights)]
    return all(_item_sheet_fits(heights, edges[i], edges[i + 1], i == 0) for i in range(len(edges) - 1))


def _item_sheet_sizes(count, breaks):
    edges = [0, *breaks, count]
    return [edges[i + 1] - edges[i] for i in range(len(edges) - 1)]


def _even_item_breaks(count, sheets):
    """장수를 고정한 채 카드 수를 고르게 나눈 지점. 첫 장은 안내문 때문에 띠가 좁으므로
    남는 카드는 뒤쪽 장에 준다."""
    base, extra = divmod(count, sheets)
    breaks = []
    cursor = 0
    for sheet in range(sheets - 1):
        cursor += base + (1 if sheet >= sheets - extra else 0)
        breaks.append(cursor)
    return breaks


def item_breaks(heights):
    """build_html_report.mjs 의 itemBreaks 와 같은 규칙이다. 두 렌더러가 같은 자리에서
    갈라져야 정적 PDF 와 즉석 생성 PDF 의 레이아웃이 어긋나지 않는다.

    greedy 는 앞 장을 가득 채우므로 마지막 장에 카드가 하나만 남을 수 있다. 34564332764
    영문판이 품목 카드 4장을 3+1 로 갈라 마지막 쪽의 70%가 비었다. 장수는 greedy 가 정한
    대로 두고(쪽수를 늘리지 않는다) 그 안에서 고르게 나눈다. 고른 분할이 띠에 안 들어가면
    greedy 를 쓴다. greedy 가 이미 고르면 앞 장을 채우는 편이 나으므로 건드리지 않는다.
    """
    greedy = greedy_item_breaks(heights)
    if not greedy:
        return greedy
    even = _even_item_breaks(len(heights), len(greedy) + 1)
    spread = lambda breaks: max(sizes := _item_sheet_sizes(len(heights), breaks)) - min(sizes)
    if spread(even) >= spread(greedy):
        return greedy
    return even if _item_plan_fits(heights, even) else greedy


def paginate_item_cards(report, entries, width):
    layouts = [item_card_layout(report, entry, width) for entry in entries]
    breaks = item_breaks([layout["height"] for layout in layouts])
    pages = []
    current = []
    cursor = ITEM_SECTION_FIRST_TOP
    for index, (entry, layout) in enumerate(zip(entries, layouts)):
        if index in breaks:
            pages.append(current)
            current = []
            cursor = ITEM_SECTION_TOP
        current.append({"entry": entry, "layout": layout, "top": cursor})
        cursor -= layout["height"] + ITEM_CARD_GAP
    if current:
        pages.append(current)
    return pages


def draw_item_trends(report, profiles, signal_index, relevant_rows, summary):
    entries = build_item_trend_entries(profiles, signal_index, relevant_rows)
    if not entries:
        return {"item_count": 0, "company_count": 0, "pages": 0}

    x = 30
    width = PAGE_W - 60
    month_label = report_month_label(summary)
    pages = paginate_item_cards(report, entries, width)
    note = t("item_note", month=month_label)
    for index, page in enumerate(pages, start=1):
        report.new_page()
        report.header("P R O D U C T   D E V E L O P M E N T S", t("item_title"), f"{index}/{len(pages)}")
        if index == 1:
            report.wrapped(note, 28, PAGE_H - 128, PAGE_W - 56, 8, colors.HexColor("#555F6E"), max_lines=2, line_gap=4, align="justify")
        for placed in page:
            draw_item_card(report, placed["entry"], placed["layout"], x, placed["top"], width, month_label)
        report.footer()

    return {
        "item_count": len({entry["profile"].get("technology_group") for entry in entries}),
        "company_count": len(entries),
        "pages": len(pages),
    }


def build_report(args):
    set_language(args.lang)
    targets = load_json(args.targets, [])
    tech_map = load_json(args.technology_map, {"companies": []})
    signals = load_json(args.signals, [])
    summary = override_summary_period(load_json(args.summary, {}), args.from_date, args.to_date)
    relevant = load_json(args.relevant, [])
    investment_signals = load_json(args.investment_signals, [])
    investment_summary = load_json(args.investment_summary, {})
    indicators = load_json(args.indicator_config, {}).get("indicators", [])

    signals = filter_rows_by_report_period(signals, summary)
    relevant = filter_rows_by_report_period(relevant, summary)
    investment_signals = filter_rows_by_report_period(investment_signals, summary)
    investment_signals = filter_ignored_signals(investment_signals, parse_ignored_signal_keys(args.ignored_signals))

    profiles = build_profiles(targets, tech_map)
    signal_index = index_investment_signals(investment_signals)
    detail_profiles = [profile for profile in profiles if any(signal_index.get(profile["company"], {}).values())]

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fonts = register_fonts(args.font)
    issue_number = re.sub(r"\D+", "", str(args.issue_number or DEFAULT_ISSUE_NUMBER)) or DEFAULT_ISSUE_NUMBER
    report = SlideReport(out_path, fonts, issue_number)

    draw_cover(report, summary, indicators)
    draw_matrix(report, profiles, signal_index, summary, signals)
    total_details = len(detail_profiles)
    for idx, profile in enumerate(detail_profiles, start=1):
        draw_detail_page(report, profile, signal_index, relevant, investment_signals, signals, idx, total_details)
    item_trends = draw_item_trends(report, profiles, signal_index, relevant, summary)

    report.finish()
    clipping_report()
    print(
        json.dumps(
            {
                "output": str(out_path),
                "lang": report_content.LANG,
                "clipped_text_count": len(CLIPPED),
                "pages": report.page_no,
                "company_count": len(profiles),
                "detail_company_count": total_details,
                "item_trend_item_count": item_trends["item_count"],
                "item_trend_company_count": item_trends["company_count"],
                "item_trend_pages": item_trends["pages"],
                "investment_signal_count": investment_summary.get("investment_signal_count", len(investment_signals)),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--targets", default="data/target_companies.json")
    parser.add_argument("--technology-map", default="data/company_technology_map.json")
    parser.add_argument("--signals", required=True)
    parser.add_argument("--summary", required=True)
    parser.add_argument("--relevant", required=True)
    parser.add_argument("--relevance-summary", required=False)
    parser.add_argument("--investment-signals", required=True)
    parser.add_argument("--investment-summary", required=True)
    parser.add_argument("--indicator-config", required=True)
    parser.add_argument("--font", required=True)
    parser.add_argument("--issue-number", default=DEFAULT_ISSUE_NUMBER)
    parser.add_argument("--lang", default="ko", choices=["ko", "en"])
    parser.add_argument("--ignored-signals", default="")
    parser.add_argument("--from-date", default="")
    parser.add_argument("--to-date", default="")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    build_report(args)


if __name__ == "__main__":
    main()
