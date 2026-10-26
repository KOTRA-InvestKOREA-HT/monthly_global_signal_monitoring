"""보고서 글자 폭 측정.

PDF 는 report_html.mjs 가 그린 HTML 을 Chrome 이 인쇄한다. CSS 는 글자 폭을 재서 크기를 고르지
못하므로, 표지 제목 크기·부제 크기·지표 알약 열 폭·표제와 상세를 한 줄에 둘지 같은 판단은
뷰 모델(report_view_model.py)이 여기서 잰 값으로 정해 넘긴다.

Chrome 이 쓰는 것과 같은 Pretendard JP 정적 굵기 네 개(assets/fonts/*.ttf)의 글리프 폭을
reportlab 의 글꼴 표로 읽는다. 그리기는 하지 않는다. 예전 reportlab 렌더러(build_pdf_report.py)는
2026-10 에 지웠고, 이 파일은 그중 측정 부분만 남긴 것이다.
"""

from pathlib import Path

from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

import report_content
from report_content import clean_text, signal_row_label

# 쪽 폭(pt). report_html.mjs 의 PAGE_WIDTH_PT 와 같다.
PAGE_W = 540
# 표지 부제 줄을 재는 왼쪽 끝. reportlab 표지의 값을 그대로 두어 지금 나오는 크기를 바꾸지 않는다.
COVER_TEXT_X = 36

# 상세 페이지 시그널 문안의 글자 크기. report_html.mjs 의 .summary(8.8pt)와 같다.
SIGNAL_BODY_SIZE = 8.8
# 상세 페이지 시그널 문안 열의 폭. report_html.mjs 의 .summary max-width(378pt)와 같다.
SIGNAL_BODY_WIDTH = 378

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


def register_fonts(font_path):
    """네 굵기의 글꼴을 등록하고 굵기 이름 → 등록 이름을 돌려준다.

    font_path 는 Regular 파일이고, 나머지 굵기는 같은 폴더에서 찾는다. 하나라도 없으면 멈춘다.
    예전에는 어떤 예외든 네 굵기를 모두 Regular 로 조용히 등록해, 굵은 제목을 보통 굵기 폭으로
    재고 넘치는 크기를 골랐다.
    """
    folder = Path(font_path).parent
    fonts = {}
    for role in FONT_WEIGHTS:
        font_file = folder / FONT_FILES[role]
        if not font_file.exists():
            raise FileNotFoundError(f"Report font cut missing: {font_file}")
        font_name = f"PretendardJP-{role}"
        if font_name not in pdfmetrics.getRegisteredFontNames():
            font = TTFont(font_name, str(font_file))
            font.face.name = font_name.encode("ascii")
            pdfmetrics.registerFont(font)
        fonts[role] = font_name
    return fonts


class Measure:
    """등록한 글꼴로 글자 폭(pt)을 잰다."""

    def __init__(self, font_path):
        self.fonts = register_fonts(font_path)

    def width(self, text, weight, size):
        return pdfmetrics.stringWidth(str(text or ""), self.fonts[weight], size)


def cover_line_size(measure, lines):
    """표지 부제 두 줄이 각각 한 줄에 드는 공통 글자 크기.

    영문 첫 줄이 11pt 에서 폭을 넘어 접히자, 접힌 꼬리가 두 줄 사이와 같은 간격으로 찍혀
    세 줄짜리 목록처럼 읽혔다. 두 줄을 같은 크기로 함께 줄여 국문처럼 두 줄로 둔다.
    하한까지 줄여도 넘치면 그 크기에서 줄을 바꾼다.
    """
    width = PAGE_W - COVER_TEXT_X - 43
    size = 11 if report_content.LANG == "en" else 12
    while size > 9.5 and any(measure.width(clean_text(line), "demilight", size) > width for line in lines):
        size -= 0.5
    return size


# ---- 기업 상세 쪽 높이 어림 ----
# 사업현황 상자에 기사를 세 건까지 싣게 되면서(2026-10-26 사용자 결정) 상자가 쪽 아래 푸터 선을 넘지 않는지
# 뷰 모델이 미리 알아야 한다. Chrome 이 그린 뒤에야 알면 빌드가 멈춘다(build_html_report.mjs cutTexts).
# 아래 값은 report_html.mjs 의 .detail·.signal-box·.business-box CSS 를 옮긴 것이다. CSS 를 바꾸면 함께 바꾼다.
# 4호(2026-09) 한·영 22장을 Chrome 으로 잰 높이와 비교해 맞췄다(시그널 상자 오차 ±0.5pt 안, 상자는 줄 수가 같다).
# Pretendard JP 의 hhea 높이 (1950 + 494) / 2048. CSS line-height: normal 이 이 비율이다.
LINE_RATIO = 2444 / 2048
# .detail 의 top 과 푸터 선(report_html.mjs CONTENT_BOTTOM_PT = 780 - 38).
DETAIL_TOP = 114
CONTENT_BOTTOM = 742
# .signal-box: 테두리 위아래, 회사명 줄(위아래 13.35pt + 14pt 이름 + 1pt 선), 행마다 위 10.05pt·아래 10.95pt(마지막 행 10.05pt)와 16pt 머리.
SIGNAL_BOX_BORDER = 1.8
SIGNAL_HEAD = 2 * 13.35 + 14 * LINE_RATIO + 1
SIGNAL_ROW = 10.05 + 16
SIGNAL_ROW_BELOW, SIGNAL_LAST_ROW_BELOW = 10.95, 10.05
SIGNAL_SUMMARY_GAP, SIGNAL_SUMMARY_LINE, SIGNAL_SUMMARY_CLAMP = 3.6, 11.5, 6
SIGNAL_SOURCE_GAP, SIGNAL_SOURCE_SIZE = 2.4, 7.5
# .business-box: 위 여백, 테두리, 안쪽 여백(위 11.2pt·아래 22.2pt), 제목 줄(8.5pt), 최소 높이 88pt.
BUSINESS_BOX_TOP = 15.2
BUSINESS_BOX_CHROME = 1.8 + 11.2 + 22.2 + 8.5 * LINE_RATIO
BUSINESS_BOX_MIN = 88
# 상자 안쪽 폭: 쪽 540pt - .detail 좌우 30pt - 테두리 0.9pt×2 - 안쪽 여백 16.3pt×2.
BUSINESS_WIDTH = PAGE_W - 60 - 1.8 - 32.6
BUSINESS_TARGET_GAP, BUSINESS_TARGET_ROW_GAP, BUSINESS_TARGET_COLUMN_GAP = 6, 4.6, 9
BUSINESS_TARGET_PILL_SIZE, BUSINESS_TARGET_PILL_PAD, BUSINESS_TARGET_TEXT_SIZE = 7.6, 1.9, 9.5
BUSINESS_BODY_GAP, BUSINESS_BODY_SIZE, BUSINESS_BODY_LINE, BUSINESS_BODY_CLAMP = 6.4, 9, 11.7, 9
BUSINESS_SOURCE_SIZE = 8
# 한 건이면 본문 아래 7.1pt 에 출처 줄. 여러 건이면 지표 칸처럼 본문 바로 아래(2.4pt)에 출처를 붙이고
# 항목 사이를 8pt 띄운다. 번호 칸(12pt) 만큼 본문 폭이 준다. report_html.mjs 의 .business-item 과 같다.
BUSINESS_SOURCE_GAP = 7.1
BUSINESS_ITEM_SOURCE_GAP = 2.4
BUSINESS_ITEM_GAP = 8
BUSINESS_NUMBER_WIDTH = 12


def line_count(measure, runs, size, width):
    """runs([(글자, 굵기)])를 width 에 넣었을 때의 줄 수. 빈 글이면 0.

    word-break: keep-all 이라 Chrome 은 공백에서만 줄을 바꾼다. 같은 규칙으로 앞에서부터 채운다. 영문은 Chrome 이
    붙임표 뒤에서도 바꿀 수 있어 실제보다 한 줄 많게 셀 수는 있어도 적게 세지는 않는다. 한 낱말이 줄보다 길면
    (긴 주소 같은) 넘친 만큼 줄을 더한다.
    """
    space = measure.width(" ", "demilight", size)
    lines, used = 0, 0.0
    for text, weight in runs:
        for word in str(text or "").split():
            word_width = measure.width(word, weight, size)
            if lines and used + space + word_width <= width:
                used += space + word_width
                continue
            lines += 1
            used = word_width
            while used > width:
                lines += 1
                used -= width
    return lines


def signal_box_height(measure, signals):
    """다섯 지표 행이 든 시그널 상자의 높이(pt). signals 는 report_view_model.signal_entry 의 결과다."""
    height = SIGNAL_BOX_BORDER + SIGNAL_HEAD
    for index, signal in enumerate(signals):
        last = index == len(signals) - 1
        height += SIGNAL_ROW + (SIGNAL_LAST_ROW_BELOW if last else SIGNAL_ROW_BELOW)
        if not signal.get("active"):
            continue

        def lines(runs):
            return min(SIGNAL_SUMMARY_CLAMP, line_count(measure, runs, SIGNAL_BODY_SIZE, SIGNAL_BODY_WIDTH))

        if signal.get("plain"):
            summary = lines([(signal["plain"], "demilight")])
        elif not signal.get("detail"):
            summary = lines([(signal.get("headline"), "demilight")])
        elif signal.get("inline"):
            summary = lines([(signal["headline"], "semibold"), (f"— {signal['detail']}", "demilight")])
        else:
            summary = lines([(signal["headline"], "semibold")]) + lines([(signal["detail"], "demilight")])
        source = line_count(measure, [(signal.get("source"), "demilight")], SIGNAL_SOURCE_SIZE, SIGNAL_BODY_WIDTH)
        height += (SIGNAL_SUMMARY_GAP + summary * SIGNAL_SUMMARY_LINE
                   + SIGNAL_SOURCE_GAP + source * SIGNAL_SOURCE_SIZE * LINE_RATIO)
    return height


def business_box_height(measure, target_label, target_text, items):
    """사업현황 상자의 높이(pt, 위 여백 포함). items 는 상자 항목({no, body, source})이다. 번호가 있으면 여러 건이다."""
    height = BUSINESS_BOX_CHROME
    if target_text:
        pill = measure.width(target_label, "semibold", BUSINESS_TARGET_PILL_SIZE) + 14
        pill_height = BUSINESS_TARGET_PILL_SIZE * LINE_RATIO + 2 * BUSINESS_TARGET_PILL_PAD
        text_line = BUSINESS_TARGET_TEXT_SIZE * LINE_RATIO
        text_width = measure.width(target_text, "semibold", BUSINESS_TARGET_TEXT_SIZE)
        if pill + BUSINESS_TARGET_COLUMN_GAP + text_width <= BUSINESS_WIDTH:
            height += BUSINESS_TARGET_GAP + max(pill_height, text_line)
        else:
            text_lines = line_count(measure, [(target_text, "semibold")], BUSINESS_TARGET_TEXT_SIZE, BUSINESS_WIDTH)
            height += BUSINESS_TARGET_GAP + pill_height + BUSINESS_TARGET_ROW_GAP + text_lines * text_line
    numbered = any(item.get("no") for item in items)
    width = BUSINESS_WIDTH - (BUSINESS_NUMBER_WIDTH if numbered else 0)
    height += BUSINESS_BODY_GAP
    for index, item in enumerate(items):
        body = min(BUSINESS_BODY_CLAMP, line_count(measure, [(item.get("body"), "demilight")], BUSINESS_BODY_SIZE, width))
        source = line_count(measure, [(item.get("source"), "demilight")], BUSINESS_SOURCE_SIZE, width)
        height += body * BUSINESS_BODY_LINE + source * BUSINESS_SOURCE_SIZE * LINE_RATIO
        if source:
            height += BUSINESS_ITEM_SOURCE_GAP if numbered else BUSINESS_SOURCE_GAP
        if index:
            height += BUSINESS_ITEM_GAP
    return BUSINESS_BOX_TOP + max(BUSINESS_BOX_MIN, height)


def detail_bottom(measure, signals, target_label, target_text, items):
    """기업 상세 쪽에서 사업현황 상자 아래 끝의 어림 위치(pt, 쪽 위에서)."""
    return DETAIL_TOP + signal_box_height(measure, signals) + business_box_height(measure, target_label, target_text, items)


def signal_pill_column(measure):
    """다섯 지표 라벨 알약 중 가장 넓은 것의 폭. "이번 달 해당 신호 없음"은 이 열 다음에서 시작한다.

    알약마다 바로 뒤에 찍던 때는 라벨 길이에 따라 문구 시작점이 줄마다 달랐다.
    """
    return round(max(measure.width(signal_row_label(no), "semibold", 7.6) for no in range(1, 6)) + 16, 2)
