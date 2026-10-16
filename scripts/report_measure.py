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


def signal_pill_column(measure):
    """다섯 지표 라벨 알약 중 가장 넓은 것의 폭. "이번 달 해당 신호 없음"은 이 열 다음에서 시작한다.

    알약마다 바로 뒤에 찍던 때는 라벨 길이에 따라 문구 시작점이 줄마다 달랐다.
    """
    return round(max(measure.width(signal_row_label(no), "semibold", 7.6) for no in range(1, 6)) + 16, 2)
