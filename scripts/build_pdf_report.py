import argparse
import json
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas


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
MUTED = colors.HexColor("#8591A3")
GREY_TEXT = colors.HexColor("#B1B6BE")
WHITE = colors.white

ISSUE_NO = "Issue 2"
EXEMPT_COMPANIES = {
    "Prodrive",
    "JSR",
    "Applied Materials",
    "Amkor Technology",
    "Heraeus",
    "Toray",
    "3M",
    "Air Liquide",
    "Air Products",
}

COUNTRY_BY_COMPANY = {
    "Australian Strategic Metals": "호주",
    "Cognex": "미국",
    "Corning": "미국",
    "Charles River": "미국",
    "Cytiva": "미국",
    "Moderna": "미국",
    "West Pharmaceutical": "미국",
    "Dupont": "미국",
    "Albemarle": "미국",
    "TIMET": "미국",
    "Air Products": "미국",
    "Chemours": "미국",
    "BorgWarner": "미국",
    "DOW": "미국",
    "Thermo Fisher": "미국",
    "Amkor Technology": "미국",
    "Onsemi": "미국",
    "Qualcomm": "미국",
    "Skyworks": "미국",
    "Eli Lilly and Company": "미국",
    "GE Healthcare": "미국",
    "Boeing": "미국",
    "3M": "미국",
    "Ouster": "미국",
    "Applied Materials": "미국",
    "Magnix": "미국",
    "Prodrive": "네덜란드",
    "ASML": "네덜란드",
    "Besi": "네덜란드",
    "NXP": "네덜란드",
    "Norsk Hydro": "노르웨이",
    "Vestas": "덴마크",
    "Heidenhain": "독일",
    "Infineon": "독일",
    "Schmalz": "독일",
    "Bayer": "독일",
    "Merck": "독일",
    "Schott Pharma": "독일",
    "BASF": "독일",
    "Evonik Industries": "독일",
    "Heraeus": "독일",
    "Jenoptik": "독일",
    "EMM(Umicore)": "벨기에",
    "Umicore": "벨기에",
    "Solvay": "벨기에",
    "Syensqo": "벨기에",
    "Hexagon AB": "스웨덴",
    "ABB": "스위스",
    "Maxon": "스위스",
    "Siemens-Gamesa": "스페인",
    "Renishaw": "영국",
    "Nexeon": "영국",
    "Rio Tinto": "영국",
    "HyproMag": "영국",
    "EVG": "오스트리아",
    "Plansee": "오스트리아",
    "Texcell": "프랑스",
    "Veolia": "프랑스",
    "Airbus": "프랑스",
    "Safran": "프랑스",
    "Air Liquide": "프랑스",
    "Arkema": "프랑스",
    "DNP": "일본",
    "Hitachi Metals": "일본",
    "Toppan Holdings": "일본",
    "Nabtesco": "일본",
    "Asahi Glass": "일본",
    "JSR": "일본",
    "Shin-Etsu Chemicals": "일본",
    "Tokyo Electron": "일본",
    "Tosoh": "일본",
    "Mitsubishi Chemical": "일본",
    "Sumitomo Chemical": "일본",
    "Asahi Kasei": "일본",
    "Toray": "일본",
    "Cheng Uei Precision": "대만",
    "Shanghai Electric Wind Power": "중국",
}

DETAILED_INDUSTRY_BY_GROUP = {
    "rare_earth_magnet_recycling": "희토류 자석 재활용",
    "3d_vision_sensor": "머신비전·센서",
    "euv_blank_mask": "반도체 마스크 소재",
    "virus_validation_mcb_wcb": "바이오 분석·안전성 시험",
    "bioprocess_culture_purification": "바이오공정 장비·소재",
    "gene_cell_therapy_delivery_gmp": "세포·유전자 치료제",
    "autoinjector_pfs_fill_finish": "의약품 전달·충전",
    "ag_al_paste": "태양전지 전극소재",
    "lithium_cathode_materials": "이차전지 핵심소재",
    "nonferrous_scrap_recycling": "비철금속 재활용",
    "hexamethylenediamine_hmd": "화학 플랫폼 원료",
    "ion_exchange_membrane": "첨단막 소재",
    "autonomous_imu_rf_baseband": "자율주행 반도체",
    "semiconductor_thermal_material": "반도체 패키징",
    "autonomous_camera_isp": "자율주행 센싱",
    "aerospace_electric_propulsion": "항공기·친환경 추진체계",
    "robot_lidar": "로봇용 라이다",
    "hybrid_bonding_w2w": "첨단 패키징 장비",
    "euv_lithography": "반도체 노광장비",
    "satellite_radar_rf_semiconductor": "우주항공 RF 반도체",
    "offshore_wind_turbine": "해상풍력 터빈",
    "linear_scale": "정밀 위치계측",
    "robot_reducer": "로봇 정밀구동",
    "pharma_excipient": "의약품 소재",
    "precipitated_silica_tire": "친환경 실리카",
    "silicon_anode_sic": "이차전지 음극재",
    "pvdf": "이차전지 바인더 소재",
    "metal_target_ti_ta": "반도체 금속타겟",
    "fine_metal_mask": "디스플레이 소재",
    "tgv_glass_substrate": "반도체 유리기판",
}

SIGNAL_DESCRIPTIONS = {
    1: "공급망·지정학 리스크 대응 · 공급망 재편·지정학 리스크 발생 및 대응 등",
    2: "생산 확대 및 다변화 의지 · 증설·거점 다변화 검토·타당성 조사 등",
    3: "투자 재원 확보 · 회사채·증자·신용공여 등 대규모 자금 조달",
    4: "기술 생태계 밀착 (R&D) · 공동연구·라이선싱·PoC·지분투자 타진 등",
    5: "핵심 전략 인력의 이동 · C-Level 이동·극비 방한·실사 조율 등",
}


def load_json(path, fallback):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return fallback


def parse_datetime(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None


def format_date(value):
    dt = parse_datetime(value)
    if dt:
        return dt.strftime("%Y.%m.%d")
    return str(value or "-")[:10]


def issue_month(summary):
    dt = parse_datetime(summary.get("run_started_at")) or datetime.now(timezone.utc)
    return dt.astimezone(timezone(timedelta(hours=9))).strftime("%Y.%m")


def previous_month_period(summary):
    dt = parse_datetime(summary.get("run_started_at")) or datetime.now(timezone.utc)
    local = dt.astimezone(timezone(timedelta(hours=9)))
    first_this_month = local.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    last_prev_month = first_this_month - timedelta(days=1)
    first_prev_month = last_prev_month.replace(day=1)
    return (
        first_prev_month.strftime("%Y.%m.%d").replace(".0", "."),
        last_prev_month.strftime("%Y.%m.%d").replace(".0", "."),
    )


def short_text(value, limit):
    text = " ".join(str(value or "").replace("&nbsp;", " ").split())
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 3)].rstrip() + "..."


def clean_text(value):
    text = str(value or "").replace("&nbsp;", " ")
    text = re.sub(r"\s+", " ", text).strip()
    boilerplate = [
        "Skip to main navigation",
        "Investor Relations",
        "News Release",
        "PDF Version",
        "View printer-friendly version",
    ]
    for phrase in boilerplate:
        text = text.replace(phrase, " ")
    return re.sub(r"\s+", " ", text).strip()


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


def register_fonts(font_path):
    pdfmetrics.registerFont(TTFont("NotoSansKR", font_path))
    pdfmetrics.registerFont(TTFont("NotoSansKR-Bold", font_path))
    return "NotoSansKR", "NotoSansKR-Bold"


class SlideReport:
    def __init__(self, out_path, font_name, bold_font_name):
        self.out_path = out_path
        self.font = font_name
        self.bold_font = bold_font_name
        self.canvas = canvas.Canvas(str(out_path), pagesize=(PAGE_W, PAGE_H))
        self.page_no = 0

    def set_font(self, size, color=TEXT, bold=False):
        self.canvas.setFont(self.bold_font if bold else self.font, size)
        self.canvas.setFillColor(color)

    def text(self, x, y, value, size=10, color=TEXT, bold=False, align="left"):
        self.set_font(size, color, bold=bold)
        value = str(value or "")
        if align == "right":
            self.canvas.drawRightString(x, y, value)
        elif align == "center":
            self.canvas.drawCentredString(x, y, value)
        else:
            self.canvas.drawString(x, y, value)

    def wrapped(self, text, x, y, max_width, size=10, color=TEXT, max_lines=0, line_gap=3, bold=False):
        lines = wrap_text(self.canvas, text, max_width, self.font, size)
        if max_lines and len(lines) > max_lines:
            lines = lines[:max_lines]
            lines[-1] = short_text(lines[-1], max(8, len(lines[-1]) - 3))
        self.set_font(size, color, bold=bold)
        line_height = size + line_gap
        for line in lines:
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
        self.text(42, 16, f"Invest KOREA · 타겟기업 글로벌 투자시그널 모니터링 · {ISSUE_NO}", 8, MUTED)
        self.text(PAGE_W - 42, 16, f"{self.page_no:02d}", 8, TEXT, bold=True, align="right")

    def header(self, kicker, title, page_fraction=""):
        c = self.canvas
        c.setFillColor(NAVY)
        c.rect(0, PAGE_H - 92, PAGE_W, 92, fill=1, stroke=0)
        c.setFillColor(GOLD)
        c.rect(0, PAGE_H - 100, PAGE_W, 8, fill=1, stroke=0)
        suffix = f" · {page_fraction}" if page_fraction else ""
        self.text(43, PAGE_H - 39, f"{kicker}{suffix}", 9, GOLD)
        self.text(43, PAGE_H - 66, title, 22, WHITE, bold=True)

    def finish(self):
        self.canvas.save()


def draw_cover(report, summary, indicators):
    report.new_page()
    c = report.canvas
    c.setFillColor(GOLD)
    c.rect(0, PAGE_H - 8, PAGE_W, 8, fill=1, stroke=0)
    c.setFillColor(NAVY)
    c.rect(0, 0, PAGE_W, PAGE_H - 8, fill=1, stroke=0)

    report.text(PAGE_W - 42, PAGE_H - 58, ISSUE_NO, 18, WHITE, bold=True, align="right")
    report.text(PAGE_W - 42, PAGE_H - 78, issue_month(summary), 10, colors.HexColor("#C8D2DF"), align="right")

    y = PAGE_H - 208
    report.text(43, y, "G L O B A L   I N V E S T M E N T   S I G N A L   M O N I T O R", 12, GOLD)
    y -= 56
    report.text(43, y, "타겟기업", 36, WHITE, bold=True)
    y -= 45
    report.text(43, y, "글로벌 투자시그널", 36, GOLD, bold=True)
    y -= 45
    report.text(43, y, "모니터링", 36, WHITE, bold=True)

    y -= 42
    report.text(43, y, "산업부 선정 30대 투자유치 프로젝트 · 77개 타겟기업", 12, WHITE)
    y -= 20
    report.text(43, y, "기업별 5대 시그널(전조현상) 포착 · 투자 확정 전 선행 징후 기반", 12, WHITE)

    y -= 45
    report.text(43, y, "5대 투자동향 지표", 9, colors.HexColor("#C8D2DF"))
    y -= 29
    for item in indicators:
        c.setStrokeColor(GOLD)
        c.setLineWidth(1.2)
        c.circle(46, y + 4, 10, stroke=1, fill=0)
        report.text(46, y, str(item["no"]), 9, GOLD, bold=True, align="center")
        report.text(67, y - 1, item["label_ko"], 12, WHITE, bold=True)
        report.text(PAGE_W - 43, y - 1, item["description_ko"], 8, colors.HexColor("#C8D2DF"), align="right")
        y -= 32

    c.setStrokeColor(colors.HexColor("#D6DEE9"))
    c.setLineWidth(0.7)
    c.line(43, 62, PAGE_W - 43, 62)
    report.text(43, 42, "kotra", 20, WHITE, bold=True)
    report.text(43, 29, "Korea Trade-Investment", 6.5, colors.HexColor("#C8D2DF"))
    report.text(43, 20, "Promotion Agency", 6.5, colors.HexColor("#C8D2DF"))
    report.text(PAGE_W - 43, 31, "Invest KOREA", 11, WHITE, bold=True, align="right")


def company_sort_key(row):
    return int(row.get("target_no") or 999)


def build_profiles(targets, tech_map):
    tech_rows = {row["company"]: row for row in tech_map.get("companies", [])}
    profiles = []
    for target in sorted(targets, key=company_sort_key):
        company = target["company"]
        tech = tech_rows.get(company, {})
        group = tech.get("technology_group", "")
        profiles.append(
            {
                **target,
                **tech,
                "target_no": target.get("target_no", tech.get("target_no")),
                "company": company,
                "country": COUNTRY_BY_COMPANY.get(company, ""),
                "detailed_industry": DETAILED_INDUSTRY_BY_GROUP.get(group, tech.get("industry", "")),
                "exempt_from_relevance": bool(tech.get("excluded_from_relevance")) or company in EXEMPT_COMPANIES,
            }
        )
    return profiles


def sort_signal_rows(rows):
    def key(row):
        official = 0 if row.get("source_type") == "official" else 1
        technology_score = -(row.get("technology_relevance_score") or row.get("relevance_score") or 0)
        signal_score = -(row.get("investment_signal_score") or 0)
        dt = parse_datetime(row.get("published_at"))
        timestamp = -dt.timestamp() if dt else 0
        return (official, technology_score, signal_score, timestamp)

    return sorted(rows, key=key)


def index_investment_signals(rows):
    index = defaultdict(lambda: defaultdict(list))
    for row in rows:
        company = row.get("company")
        try:
            no = int(row.get("investment_signal_no"))
        except Exception:
            continue
        index[company][no].append(row)
    for company in index:
        for no in index[company]:
            index[company][no] = sort_signal_rows(index[company][no])
    return index


def draw_matrix_table(report, profiles, signal_index, x, y_top, right=False):
    c = report.canvas
    table_w = 242
    header_h = 16
    row_h = 12.8
    index_x = x + 13
    name_x = x + 30
    signal_xs = [x + 152, x + 170, x + 188, x + 206, x + 224]

    c.setFillColor(NAVY)
    c.rect(x, y_top - header_h, table_w, header_h, fill=1, stroke=0)
    report.text(x + 7, y_top - 11, "기업", 8, WHITE, bold=True)
    for idx, signal_no in enumerate(["①", "②", "③", "④", "⑤"]):
        report.text(signal_xs[idx] + 4, y_top - 10.5, signal_no, 7, WHITE, align="center")

    y = y_top - header_h
    for profile in profiles:
        y -= row_h
        c.setStrokeColor(TABLE_LINE)
        c.setLineWidth(0.45)
        c.line(x, y, x + table_w, y)
        report.text(index_x, y + 3.7, str(profile["target_no"]), 6, colors.HexColor("#737C86"), align="center")
        report.text(name_x, y + 3.7, profile["company"], 6, TEXT)
        for idx in range(5):
            active = bool(signal_index.get(profile["company"], {}).get(idx + 1))
            c.setFillColor(GOLD if active else LIGHT)
            c.roundRect(signal_xs[idx], y + 3.0, 8.2, 8.2, 2, fill=1, stroke=0)


def draw_matrix(report, profiles, signal_index, summary):
    report.new_page()
    report.header("S I G N A L   M A T R I X", "이번 달 시그널 매트릭스")
    period_start, period_end = previous_month_period(summary)
    signal_companies = [p for p in profiles if any(signal_index.get(p["company"], {}).values())]

    desc = (
        f"77개 타겟기업의 {period_start}~{period_end} 글로벌 투자 시그널(전조현상). "
        "활성화된 셀 = 당월 포착된 시그널 (투자 확정 · 발표 완료 등 후행 데이터 제외)."
    )
    report.wrapped(desc, 32, PAGE_H - 128, PAGE_W - 64, 8, colors.HexColor("#555F6E"), max_lines=2, line_gap=4)

    draw_matrix_table(report, profiles[:39], signal_index, 25, PAGE_H - 145)
    draw_matrix_table(report, profiles[39:], signal_index, 281, PAGE_H - 145, right=True)

    y = 88
    c = report.canvas
    c.setFillColor(GOLD)
    c.roundRect(32, y + 9, 8, 8, 2, fill=1, stroke=0)
    report.text(45, y + 9, "시그널 포착", 8, colors.HexColor("#596579"))
    c.setFillColor(LIGHT)
    c.roundRect(98, y + 9, 8, 8, 2, fill=1, stroke=0)
    report.text(111, y + 9, "무신호", 8, colors.HexColor("#596579"))
    report.text(
        32,
        y - 6,
        "① 공급망·지정학 리스크 대응 · ② 생산 확대·다변화 의지 · ③ 투자 재원 확보 · ④ 기술 생태계 밀착(R&D) · ⑤ 핵심 전략 인력의 이동",
        7,
        MUTED,
    )
    no_signal = len(profiles) - len(signal_companies)
    report.text(32, y - 24, f"당월 시그널 포착 {len(signal_companies)}개사 · 시그널 미포착 {no_signal}개사 | 상세는 다음 장", 8, colors.HexColor("#4B5870"), bold=True)
    report.footer()


def source_line(row):
    source = row.get("source") or row.get("collector") or "수집 출처"
    return short_text(f"출처  {source} {format_date(row.get('published_at'))}", 120)


def detail_text(row, limit=260):
    evidence = ""
    snippets = row.get("evidence_snippets") or row.get("technology_evidence_snippets") or []
    if snippets:
        evidence = snippets[0]
    else:
        evidence = row.get("content_excerpt") or row.get("content_text") or ""
    title = clean_text(row.get("title"))
    evidence = clean_text(evidence)
    if evidence and title and title.lower() not in evidence.lower():
        return short_text(f"{title} - {evidence}", limit)
    return short_text(evidence or title, limit)


def business_text(rows):
    if not rows:
        return "해당 기간에 공식 출처 기반으로 요약할 수 있는 글로벌 사업현황 신호가 확인되지 않았습니다."
    row = sort_signal_rows(rows)[0]
    return detail_text(row, 320)


def best_business_row(company, relevant_rows, investment_rows, all_signal_rows):
    candidates = [row for row in relevant_rows if row.get("company") == company]
    if not candidates:
        candidates = [row for row in investment_rows if row.get("company") == company]
    if not candidates:
        candidates = [row for row in all_signal_rows if row.get("company") == company and row.get("source_type") == "official"]
    return sort_signal_rows(candidates)[0] if candidates else None


def draw_badge(report, x, y, value, active):
    c = report.canvas
    c.setFillColor(NAVY if active else colors.HexColor("#D8DADF"))
    c.roundRect(x, y - 9, 16, 16, 3, fill=1, stroke=0)
    report.text(x + 8, y - 4.5, str(value), 9, WHITE, bold=True, align="center")


def draw_signal_row(report, no, rows, x, y, width, compact=False):
    active = bool(rows)
    c = report.canvas
    draw_badge(report, x, y, no, active)
    label_x = x + 31
    label = SIGNAL_DESCRIPTIONS[no]
    label_w = min(width - 190, report.canvas.stringWidth(label, report.font, 7.6) + 14)
    c.setFillColor(LIGHT)
    c.roundRect(label_x, y - 9, label_w, 16, 3, fill=1, stroke=0)
    report.text(label_x + 8, y - 4, label, 7.6, colors.HexColor("#56687B"), bold=True)

    if not active:
        report.text(x + width - 190, y - 4, "이번 달 해당 신호 없음", 10, colors.HexColor("#B5B9BF"))
        report.text(x + width - 12, y - 4, "-", 10, colors.HexColor("#B5B9BF"), align="right")
        c.setStrokeColor(BOX_LINE)
        c.line(x, y - 20, x + width, y - 20)
        return y - 32

    row = rows[0]
    body_y = y - 30
    max_lines = 2 if compact else 3
    report.wrapped(detail_text(row, 300), label_x, body_y, width - 64, 9.2, TEXT, max_lines=max_lines, line_gap=3)
    source_y = body_y - ((9.2 + 3) * max_lines) - 2
    report.text(label_x, source_y, source_line(row), 7.4, MUTED)
    c.setStrokeColor(BOX_LINE)
    c.line(x, source_y - 13, x + width, source_y - 13)
    return source_y - 25


def draw_detail_page(report, profile, signal_index, relevant_rows, investment_rows, all_signal_rows, idx, total):
    report.new_page()
    report.header("C O M P A N Y   S I G N A L S", "기업별 시그널 상세", f"{idx}/{total}")
    company = profile["company"]
    rows_by_signal = signal_index.get(company, {})
    active_count = sum(1 for no in range(1, 6) if rows_by_signal.get(no))
    compact = active_count >= 2
    top_y = 232 if compact else 374
    top_h = 436 if compact else 292
    bottom_y = 68 if compact else 232
    bottom_h = 126
    x = 30
    width = PAGE_W - 60
    c = report.canvas

    c.setStrokeColor(BOX_LINE)
    c.setLineWidth(0.9)
    c.setFillColor(WHITE)
    c.roundRect(x, top_y, width, top_h, 10, fill=1, stroke=1)

    header_y = top_y + top_h - 29
    report.text(x + 17, header_y, company, 14, TEXT, bold=True)
    name_w = report.canvas.stringWidth(company, report.bold_font, 14)
    industry_x = min(x + 17 + name_w + 14, x + 250)
    c.setFillColor(LIGHT)
    c.roundRect(industry_x, header_y - 7, min(132, report.canvas.stringWidth(profile.get("detailed_industry", ""), report.font, 9) + 18), 18, 3, fill=1, stroke=0)
    report.text(industry_x + 9, header_y - 2, profile.get("detailed_industry", ""), 9, colors.HexColor("#56687B"), bold=True)
    report.text(industry_x + 150, header_y - 2, profile.get("country", ""), 9, colors.HexColor("#B1B6BE"))

    c.setStrokeColor(colors.black)
    c.setLineWidth(1)
    c.line(x + 17, header_y - 18, x + width - 17, header_y - 18)

    y = header_y - 40
    for no in range(1, 6):
        y = draw_signal_row(report, no, rows_by_signal.get(no, []), x + 19, y, width - 38, compact=compact)

    business_row = best_business_row(company, relevant_rows, investment_rows, all_signal_rows)
    c.setStrokeColor(TEAL_LINE)
    c.setFillColor(TEAL_BG)
    c.roundRect(x, bottom_y, width, bottom_h, 10, fill=1, stroke=1)
    top = bottom_y + bottom_h
    report.text(x + 16, top - 27, "글로벌 사업현황", 8, colors.HexColor("#087A70"), bold=True)
    c.setFillColor(colors.HexColor("#DDF0EE"))
    c.roundRect(x + 105, top - 34, 58, 18, 3, fill=1, stroke=0)
    report.text(x + 134, top - 29, "타겟기술", 8, colors.HexColor("#087A70"), bold=True, align="center")
    target_text = "" if profile.get("exempt_from_relevance") else profile.get("target_technology", "")
    if target_text:
        report.text(x + 174, top - 28, short_text(target_text, 36), 9, colors.HexColor("#087A70"), bold=True)

    body = business_text([business_row] if business_row else [])
    report.wrapped(body, x + 16, top - 55, width - 32, 9.3, TEXT, max_lines=4, line_gap=3)
    if business_row:
        report.text(x + 16, bottom_y + 17, source_line(business_row), 8, MUTED)
    else:
        report.text(x + 16, bottom_y + 17, "출처  -", 8, MUTED)
    report.footer()


def build_report(args):
    targets = load_json(args.targets, [])
    tech_map = load_json(args.technology_map, {"companies": []})
    signals = load_json(args.signals, [])
    summary = load_json(args.summary, {})
    relevant = load_json(args.relevant, [])
    investment_signals = load_json(args.investment_signals, [])
    investment_summary = load_json(args.investment_summary, {})
    indicators = load_json(args.indicator_config, {}).get("indicators", [])

    profiles = build_profiles(targets, tech_map)
    signal_index = index_investment_signals(investment_signals)
    detail_profiles = [profile for profile in profiles if any(signal_index.get(profile["company"], {}).values())]

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    font_name, bold_font_name = register_fonts(args.font)
    report = SlideReport(out_path, font_name, bold_font_name)

    draw_cover(report, summary, indicators)
    draw_matrix(report, profiles, signal_index, summary)
    total_details = len(detail_profiles)
    for idx, profile in enumerate(detail_profiles, start=1):
        draw_detail_page(report, profile, signal_index, relevant, investment_signals, signals, idx, total_details)

    report.finish()
    print(
        json.dumps(
            {
                "output": str(out_path),
                "pages": report.page_no,
                "company_count": len(profiles),
                "detail_company_count": total_details,
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
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    build_report(args)


if __name__ == "__main__":
    main()
