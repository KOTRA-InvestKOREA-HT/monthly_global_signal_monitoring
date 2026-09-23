"""보고서에 무엇이 실리는지 정하는 계층.

수집 결과를 읽어 어느 기업의 어느 지표가 승인됐는지 고르고, 날짜를 읽고, 실릴 문안을 다듬는다.
좌표도 글꼴도 색도 다루지 않으므로 reportlab 없이 불러올 수 있다. 페이지 위에 놓는 일은
scripts/build_pdf_report.py 가 한다.

화면용 scripts/report_view_model.py 는 예전처럼 build_pdf_report 를 거쳐 이 함수들을 쓴다.
두 렌더러가 같은 표를 그리려면 그 판단이 한 곳에 있어야 하기 때문이다.

언어는 set_language 가 바꾸는 모듈 상태(LANG)다. 이름을 복사해 가면 언어를 바꾼 뒤에도 옛 값이
남으므로 __all__ 에서 빼 두고, build_pdf_report 는 읽고 쓸 때마다 이 모듈을 거치게 해 두었다.
"""

import json
import re
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

__all__ = [
    "APPROVAL_POLICY", "BUSINESS_STAGE", "COMPANY_LEVEL_INDICATORS", "CONFIRMED_DATE_SOURCES",
    "COUNTRY_BY_COMPANY", "COUNTRY_EN", "DEFAULT_ISSUE_NUMBER",
    "DETAILED_INDUSTRY_BY_GROUP", "DETAILED_INDUSTRY_EN", "EXEMPT_COMPANIES",
    "INDICATOR_DESCRIPTION_EN", "LEADING_STAGES", "MONTH_NAMES_EN", "MONTH_ONLY", "NOT_A_SENTENCE_END",
    "PERIODIC_DISCLOSURE_PATTERN", "PRECURSOR_INDICATORS", "PRESS_RELEASE_PATTERN", "PROJECT_ROOT",
    "SENTENCE_END", "SIGNAL_DESCRIPTIONS", "SIGNAL_DESCRIPTIONS_EN", "SOURCE_LINE_LIMIT", "TEXTS",
    "best_business_row", "build_item_trend_entries", "build_profiles", "business_near_miss",
    "business_prose", "business_text", "clean_text", "compact_date", "compact_summary_phrase", "company_sort_key",
    "company_status", "cover_kicker", "cover_title_accent", "cover_titles", "covered_companies", "date_day", "date_month", "date_state", "detail_text",
    "expand_business_summary", "filter_ignored_signals", "filter_rows_by_report_period", "fnv1a_utf8",
    "format_date", "format_row_date", "index_investment_signals", "is_periodic_disclosure",
    "is_press_release", "is_relevance_exempt", "issue_month", "item_target_text", "item_trend_text",
    "load_json", "matrix_period_label", "month_bounds", "normalize_company_key",
    "normalize_summary_text", "override_summary_period", "parse_date_only", "parse_datetime",
    "parse_ignored_signal_keys", "phrase_ending_text", "phraseify_summary_text", "report_month_label",
    "report_period", "row_in_report_period", "sentence_spans", "set_language", "short_text",
    "signal_cell_state", "signal_fingerprint", "signal_publishable", "signal_supported",
    "sort_signal_rows", "source_display_name", "source_line", "source_url", "split_sentences", "strip_summary_lead",
    "summary_detail_text", "summary_field", "summary_parts", "summary_plain_text", "t",
    "target_section_for_profile", "target_technology_required",
]

DEFAULT_ISSUE_NUMBER = "2"
PROJECT_ROOT = Path(__file__).resolve().parents[1]


def normalize_company_key(value):
    return re.sub(r"\s+", " ", str(value or "")).strip().casefold()


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

# 국문 라벨 폭에 맞춰 짜인 알약·한 줄 슬롯에 그대로 들어가야 하므로 영문은 같은 뜻을 더 짧게 적는다.
SIGNAL_DESCRIPTIONS_EN = {
    1: "Supply Chain Risk Management · sourcing, geopolitical risks",
    2: "Production Expansion Plans · capacity, site selection",
    3: "Capital Raising · bonds, equity, credit facilities",
    4: "Technology Partnerships · joint R&D, licensing",
    5: "Executive Changes & Visits · appointments, site inspections",
}

INDICATOR_DESCRIPTION_EN = {
    1: "Diversifying supply and responding to geopolitical risks",
    2: "Asia-Pacific expansion plans and feasibility studies",
    3: "Bonds, equity financing and credit facilities",
    4: "Joint R&D, licensing, proof-of-concept projects and equity stakes",
    # "실사"를 due diligence 로 옮기면 인수 전 재무·법률 검토로 읽힌다. 현장 방문의 뜻으로 적는다.
    5: "Leadership appointments, Korea visits and site inspections",
}

COUNTRY_EN = {
    "호주": "Australia",
    "미국": "USA",
    "네덜란드": "Netherlands",
    "노르웨이": "Norway",
    "덴마크": "Denmark",
    "독일": "Germany",
    "벨기에": "Belgium",
    "스웨덴": "Sweden",
    "스위스": "Switzerland",
    "스페인": "Spain",
    "영국": "UK",
    "오스트리아": "Austria",
    "프랑스": "France",
    "일본": "Japan",
    "대만": "Taiwan",
    "중국": "China",
}

DETAILED_INDUSTRY_EN = {
    "rare_earth_magnet_recycling": "Rare-earth magnet recycling",
    "3d_vision_sensor": "Machine vision & sensors",
    "euv_blank_mask": "EUV mask materials",
    "virus_validation_mcb_wcb": "Bioanalysis & safety testing",
    "bioprocess_culture_purification": "Bioprocess equipment",
    "gene_cell_therapy_delivery_gmp": "Cell & gene therapy",
    "autoinjector_pfs_fill_finish": "Drug delivery & fill-finish",
    "ag_al_paste": "Solar electrode materials",
    "lithium_cathode_materials": "Battery cathode materials",
    "nonferrous_scrap_recycling": "Non-ferrous metal recycling",
    "hexamethylenediamine_hmd": "Chemical feedstocks",
    "ion_exchange_membrane": "Advanced membranes",
    "autonomous_imu_rf_baseband": "Autonomous driving chips",
    "semiconductor_thermal_material": "Semiconductor packaging",
    "autonomous_camera_isp": "Sensors for autonomous driving",
    "aerospace_electric_propulsion": "Aircraft & clean propulsion",
    "robot_lidar": "Robotics LiDAR",
    "hybrid_bonding_w2w": "Advanced packaging",
    "euv_lithography": "Semiconductor lithography",
    "satellite_radar_rf_semiconductor": "Aerospace RF chips",
    "offshore_wind_turbine": "Offshore wind turbines",
    "linear_scale": "Precision position metrology",
    "robot_reducer": "Precision robotic drives",
    "pharma_excipient": "Pharmaceutical materials",
    "precipitated_silica_tire": "Eco-friendly silica",
    "silicon_anode_sic": "Battery anode materials",
    "pvdf": "Battery binder materials",
    "metal_target_ti_ta": "Semiconductor targets",
    "fine_metal_mask": "Display materials",
    "tgv_glass_substrate": "Glass core substrates",
}

MONTH_NAMES_EN = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]

TEXTS = {
    "ko": {
        "footer": "Invest KOREA · 타겟기업 글로벌 투자시그널 모니터링 · {issue}",
        # 표지 맨 위 한 줄. 예전에는 두 렌더러가 각자 같은 문자열을 박아 두어, 한쪽만 고치면
        # PDF 와 화면의 표지가 달라졌다. 자간은 글자 사이 공백으로 낸다.
        "cover_kicker": "C O M P A N Y   S I G N A L S",
        # 제목 줄 수는 언어마다 다르므로 목록으로 둔다. 번호 키(cover_title_1..3)로 두면 줄이
        # 남는 언어가 그 자리를 빈 문자열로 채워야 하는데, t() 는 빈 문자열을 "없음"으로 보고
        # 국문으로 폴백하므로 영문판 표지에 한글 줄이 섞여 나온다.
        "cover_titles": ["타겟기업", "글로벌 투자시그널", "모니터링"],
        # 금색으로 칠할 제목 줄의 순번. 국문은 가운데 줄, 영문은 한 줄뿐이라 그 줄이다.
        "cover_title_accent": 1,
        "cover_line_1": "산업부 선정 30대 투자유치 프로젝트 · 77개 타겟기업",
        "cover_line_2": "기업별 5대 시그널(전조현상) 포착 · 투자 검토·전조 활동 근거 기반",
        "cover_indicator_heading": "5대 투자동향 지표",
        "matrix_title": "이번 달 시그널 매트릭스",
        "matrix_desc": "77개 타겟기업의 {period} 글로벌 투자 시그널(전조현상). 활성화된 셀 = 당월 포착된 시그널 (최종 투자 확정·완료 제외, 조달·연구협업 등 전조 활동 포함).",
        "matrix_company": "기업",
        "matrix_legend_on": "AI 확인 시그널",
        "matrix_legend_off": "신호없음",
        "matrix_indicators": "① 공급망·지정학 리스크 대응 · ② 생산 확대·다변화 의지 · ③ 투자 재원 확보 · ④ 기술 생태계 밀착(R&D) · ⑤ 핵심 전략 인력의 이동",
        "matrix_footnote": "AI 확인 시그널 {on}개사 · 신호없음 {off}개사",
        "detail_title": "기업별 시그널 상세",
        "no_signal": "이번 달 해당 신호 없음",
        "business_heading": "글로벌 사업현황",
        "business_empty": "해당 기간 공식 출처에서 요약할 수 있는 글로벌 사업현황 신호가 확인되지 않음.",
        # 승인 조건에서 품목 연계 근거만 빠진 행을 실을 때 붙인다. 표시 없이 실으면 확인되지 않은
        # 품목 연계를 확인된 것처럼 말하게 된다.
        "business_near_miss_note": "품목 연계 미확인 · 주요 사업동향",
        "source_prefix": "출처",
        "source_fallback": "수집 출처",
        "source_empty": "출처  —",
        "source_press_release": "공식보도자료",
        "item_title": "품목별 글로벌 사업동향",
        "item_target_label": "투자유치 필요 품목·기술",
        "item_trend_label": "{month} 글로벌 사업동향",
        "item_note": "5대 시그널에는 미포착되었으나, {month}중 투자유치 필요 품목·기술과 직접 연계되는 글로벌 사업동향이 포착된 기업. 기술 관련성 확인 면제 기업은 품목 연계와 별개로 주요 사업동향을 싣고 카드에 표시함. 향후 시그널 발전 가능성을 모니터링함.",
        "item_exempt_note": "기술 관련성 확인 면제 · 주요 사업동향",
    },
    "en": {
        "footer": "Invest KOREA · Investment Signals · {issue}",
        # 영문 표지에는 kicker 를 두지 않는다. 제목이 한 줄("COMPANY SIGNALS")이라 바로 위에
        # 같은 말을 작게 한 번 더 적는 꼴이 된다. 한국어 표지는 제목이 달라 그대로 둔다.
        # 본문 면의 머리글은 이 값을 쓰지 않으므로(draw_detail_page 의 자체 문자열) 영향이 없다.
        "cover_kicker": "",
        # 영문 제목은 한 줄이다. 예전 제목 "Target-Company Global Investment Signal Monitor" 는
        # 한국어 제목을 낱말마다 옮겨 붙인 것이라 영어로 읽히지 않았다.
        "cover_titles": ["INVESTMENT SIGNALS"],
        "cover_title_accent": 0,
        "cover_line_1": "30 Korean government-selected investment projects · 77 target companies",
        "cover_line_2": "Tracking early signs of corporate investment",
        "cover_indicator_heading": "FIVE EARLY INVESTMENT SIGNALS",
        "matrix_title": "Investment Signals at a Glance",
        "matrix_desc": "Investment signals identified among 77 target companies during {period}. Highlighted cells mark early-stage plans or preparatory activities, not final investment commitments or completed investments.",
        "matrix_company": "Company",
        "matrix_legend_on": "Signal identified",
        "matrix_legend_off": "No signal",
        "matrix_indicators": "① Supply Chain Risk Management · ② Production Expansion Plans · ③ Capital Raising · ④ Technology Partnerships · ⑤ Executive Changes & Visits",
        "matrix_footnote": "{on} companies with signals · {off} with no signal",
        "detail_title": "Investment Signals by Company",
        "no_signal": "No signal this month",
        "business_heading": "BUSINESS DEVELOPMENTS",
        "business_empty": "No relevant business developments were identified in official sources during this period.",
        "business_near_miss_note": "Business update · link to target product unverified",
        "source_prefix": "Source",
        "source_fallback": "Source publication",
        "source_empty": "Source  —",
        "source_press_release": "Official press release",
        "item_title": "Business Developments by Product",
        "item_target_label": "Target product / technology",
        "item_trend_label": "Business developments in {month}",
        "item_note": "This section covers business developments in {month} at companies with no qualifying investment signals. Updates focus on the target products and technologies unless a card is marked otherwise. We monitor these developments for early signs of investment.",
        "item_exempt_note": "Business update · technology link not required",
    },
}

LANG = "ko"


def set_language(lang):
    global LANG
    LANG = "en" if str(lang or "").strip().lower() in ("en", "eng", "english") else "ko"
    return LANG


def t(key, **kwargs):
    text = TEXTS.get(LANG, TEXTS["ko"]).get(key) or TEXTS["ko"].get(key, "")
    return text.format(**kwargs) if kwargs else text


def summary_field(row, name):
    """언어별 AI 요약 필드를 고른다. 영문판에서 영문 요약이 없으면 국문으로 대체하지 않는다."""
    suffix = "en" if LANG == "en" else "ko"
    return row.get(f"{name}_{suffix}") or ""


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


def parse_date_only(value):
    if not value:
        return None
    try:
        return datetime.strptime(str(value)[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except Exception:
        return None


def format_date(value):
    dt = parse_datetime(value)
    if dt:
        return dt.strftime("%Y.%m.%d")
    return str(value or "-")[:10]


# 게시일 근거의 등급은 config/date_evidence_sources.json에서 수집·검토 경로(JS)와 공유한다.
# 같은 기사가 화면과 보고서에서 다르게 취급되지 않으려면 기준이 한 곳에 있어야 한다.
try:
    with open(PROJECT_ROOT / "config" / "date_evidence_sources.json", encoding="utf-8") as _handle:
        CONFIRMED_DATE_SOURCES = set(json.load(_handle)["confirmed"])
except OSError as error:
    # 빈 목록으로 넘어가면 모든 행이 추정으로 밀려 보고서가 조용히 비어버린다. 여기서 멈추는 편이 낫다.
    raise RuntimeError(f"config/date_evidence_sources.json is required to grade publication dates: {error}") from error

# 승인 규칙의 상수는 config/approval_policy.json 에서 판정·검증 경로(JS)와 공유한다.
# 예전에는 scripts/validate_report_inputs.mjs 와 이 파일이 같은 값을 각자 들고 있어서,
# 지표 3·5 의 품목 연결 해제처럼 규칙이 바뀔 때마다 양쪽을 함께 고쳐야 했다. 한쪽을
# 놓치면 검증을 통과한 행을 발행 단계가 말없이 떨어뜨린다.
try:
    with open(PROJECT_ROOT / "config" / "approval_policy.json", encoding="utf-8") as _handle:
        APPROVAL_POLICY = json.load(_handle)
except OSError as error:
    raise RuntimeError(f"config/approval_policy.json is required to decide approvals: {error}") from error

LEADING_STAGES = set(APPROVAL_POLICY["leading_stages"])
PRECURSOR_INDICATORS = {str(no) for no in APPROVAL_POLICY["precursor_indicators"]}
COMPANY_LEVEL_INDICATORS = {str(no) for no in APPROVAL_POLICY["company_level_indicators"]}
BUSINESS_STAGE = APPROVAL_POLICY["business_stage"]
# 사유 문장의 품목 무관 문구를 여기서 다시 읽지 않는다. 그 해석은 검토 단계의 몫이고,
# 발행 단계는 그 결과로 정해진 필드만 읽는다(scripts/validate_report_inputs.mjs 참고).

MONTH_ONLY = re.compile(r"^(20\d{2})-(0[1-9]|1[0-2])$")


def date_day(value):
    text = str(value or "").strip()
    if not text or MONTH_ONLY.match(text):
        return None
    dt = parse_datetime(text)
    if not dt:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).date()


def date_month(row):
    day = date_day(row.get("published_at"))
    if day:
        return f"{day.year:04d}-{day.month:02d}"
    for value in (row.get("published_month"), row.get("published_at")):
        text = str(value or "").strip()
        if MONTH_ONLY.match(text):
            return text
    return ""


# 확정: 기사 자신이 밝힌 게시일이나 기사 항목에 붙은 공식 목록 날짜.
# 추정: URL·본문·수정일처럼 게시일을 미루어 짐작한 근거. 충돌: 확정 근거끼리 어긋남. 미상: 근거 없음.
# 근거 추적 이전에 모은 자료는 published_at_source 필드가 없고 그때의 날짜는 피드 게시일뿐이었다.
def date_state(row):
    day = date_day(row.get("published_at"))
    month = date_month(row)
    if not day and not month:
        return {"status": "unknown", "precision": "none", "day": None, "month": ""}
    tracked = "published_at_source" in row
    source = str(row.get("published_at_source") or "")
    grade = "confirmed" if (not tracked or source in CONFIRMED_DATE_SOURCES) else "estimated"
    status = "conflicting" if row.get("date_conflict") is True else grade
    return {"status": status, "precision": "day" if day else "month", "day": day, "month": month}


def month_bounds(month):
    start = date(int(month[:4]), int(month[5:7]), 1)
    end = date(start.year + (1 if start.month == 12 else 0), 1 if start.month == 12 else start.month + 1, 1)
    return start, end - timedelta(days=1)


# 월간 보고서 본문에 쓸 수 있는 행인지 본다. 게시월까지 확정된 행만 통과한다.
# 추정·충돌·미상 행은 원본과 웹 화면에 남아 검토 후보가 되고, 날짜를 보강한 뒤에 본문에 들어온다.
def row_in_report_period(row, start, end):
    state = date_state(row)
    if state["status"] != "confirmed":
        return False
    if state["precision"] == "day":
        return start.date() <= state["day"] <= end.date()
    month_start, month_end = month_bounds(state["month"])
    return start.date() <= month_start and month_end <= end.date()


def format_row_date(row):
    state = date_state(row)
    if state["precision"] != "month":
        return format_date(row.get("published_at"))
    year, month = state["month"].split("-")
    if LANG == "en":
        return f"{MONTH_NAMES_EN[int(month) - 1]} {year} (day unknown)"
    return f"{year}.{int(month)}. 일자 미상"


def issue_month(summary):
    to_date = parse_date_only(summary.get("to_date"))
    if to_date:
        year = to_date.year + (1 if to_date.month == 12 else 0)
        month = 1 if to_date.month == 12 else to_date.month + 1
    else:
        dt = parse_datetime(summary.get("run_started_at")) or datetime.now(timezone.utc)
        dt = dt.astimezone(timezone(timedelta(hours=9)))
        year, month = dt.year, dt.month
    if LANG == "en":
        return f"{MONTH_NAMES_EN[month - 1]} {year}"
    return f"{year}.{month:02d}"


def report_period(summary):
    from_date = parse_date_only(summary.get("from_date"))
    to_date = parse_date_only(summary.get("to_date"))
    if from_date and to_date:
        return from_date, to_date

    dt = parse_datetime(summary.get("run_started_at")) or datetime.now(timezone.utc)
    local = dt.astimezone(timezone(timedelta(hours=9)))
    first_this_month = local.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    last_prev_month = first_this_month - timedelta(days=1)
    first_prev_month = last_prev_month.replace(day=1)
    return first_prev_month, last_prev_month


def compact_date(dt, include_year=True):
    if include_year:
        return f"{dt.year}.{dt.month}.{dt.day}"
    return f"{dt.month}.{dt.day}"


def matrix_period_label(summary):
    """매트릭스 설명문에 들어가는 보고 기간. 수집 기간에서 만들며 하드코딩하지 않는다.

    영문판은 숫자 날짜(2026.8.1~8.31)를 쓰지 않는다. 그 표기는 국문 서식을 그대로 옮긴 것이라
    영어 문장 안에서 읽히지 않는다. 한 달 안이면 "August 1-31, 2026", 달을 넘으면 달 이름을
    양쪽에, 해를 넘으면 연도를 양쪽에 적는다. 국문 표기는 그대로 둔다.
    """
    start, end = report_period(summary)
    if LANG == "en":
        first, last = MONTH_NAMES_EN[start.month - 1], MONTH_NAMES_EN[end.month - 1]
        if start.year != end.year:
            return f"{first} {start.day}, {start.year} – {last} {end.day}, {end.year}"
        if start.month != end.month:
            return f"{first} {start.day} – {last} {end.day}, {end.year}"
        return f"{first} {start.day}–{end.day}, {end.year}"
    end_text = compact_date(end, include_year=start.year != end.year)
    return f"{start.month}월({compact_date(start)}~{end_text})"


def report_month_label(summary):
    start, _ = report_period(summary)
    if LANG == "en":
        return MONTH_NAMES_EN[start.month - 1]
    return f"{start.month}월"


def filter_rows_by_report_period(rows, summary):
    if not summary.get("from_date") or not summary.get("to_date"):
        return rows
    start, end = report_period(summary)
    return [row for row in rows if row_in_report_period(row, start, end)]


def short_text(value, limit):
    text = " ".join(str(value or "").replace("&nbsp;", " ").split())
    if len(text) <= limit:
        return text
    head = text[: max(0, limit - 3)].rstrip()
    # 영문은 단어 중간에서 끊기면 뜻이 깨진다. short_text_to_width 가 이미 하는 일을
    # 글자 수로 자를 때도 한다. 다만 되돌린 만큼이 너무 크면(한 낱말이 통째로 길면)
    # 그대로 둔다. 공백이 없는 한국어 문장을 통째로 날리지 않기 위해서다.
    spaced = head.rsplit(" ", 1)[0].rstrip() if " " in head else head
    if len(spaced) >= len(head) * 0.6:
        head = spaced
    return head + "..."


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


def normalize_summary_text(value):
    text = clean_text(value)
    replacements = [
        ("중순수%", "한 자릿수 중반대"),
        ("저순수%", "한 자릿수 초반대"),
        ("고순수%", "한 자릿수 후반대"),
        ("중순수", "한 자릿수 중반대"),
        ("저순수", "한 자릿수 초반대"),
        ("고순수", "한 자릿수 후반대"),
        ("중반 두 자릿수", "두 자릿수 중반대"),
        ("초반 두 자릿수", "두 자릿수 초반대"),
        ("후반 두 자릿수", "두 자릿수 후반대"),
        ("중반대 두 자릿수", "두 자릿수 중반대"),
        ("초반대 두 자릿수", "두 자릿수 초반대"),
        ("후반대 두 자릿수", "두 자릿수 후반대"),
        ("उपलब्ध성", "가용성"),
    ]
    for source, target in replacements:
        text = text.replace(source, target)
    return text.strip()


# 관형형 어미 앞의 "하/되"는 조사가 아니다. 이 구분이 없으면 "오션윈즈와 협력하는 해상풍력
# 프로젝트"에서 "협력하"+"는"이 주어와 조사로 읽혀 상대방까지 지워진 채 "해상풍력 프로젝트"만
# 남는다. 행동의 주인이 달라지므로, 은·는 앞 글자가 하·되이면 주어로 보지 않는다.
SUBJECT_PARTICLE = r"(?:(?<![하되])(?:은|는)|이|가)"


def strip_summary_lead(value, row=None):
    """카드가 이미 회사명을 보여 주므로 문안 맨 앞의 그 회사 주어만 뗀다.

    예전에는 한글 낱말이면 무엇이든 주어로 보고 뗐다. 그래서 "투자 라운드가 완료되었음"이
    "완료되었음"이 되어 무엇이 완료됐는지가 사라졌다. 회사명과 로마자 이름만 뗀다.
    """
    text = normalize_summary_text(value)
    company = clean_text((row or {}).get("company"))
    if company:
        text = re.sub(rf"^{re.escape(company)}{SUBJECT_PARTICLE}\s+", "", text)
    text = re.sub(rf"^[A-Za-z0-9().&/-]+(?:\s+[A-Za-z0-9().&/-]+){{0,3}}{SUBJECT_PARTICLE}\s+", "", text)
    text = re.sub(r"^(이는|다만|또한)\s+", "", text)
    return text.strip()


def phrase_ending_text(value):
    text = clean_text(value)
    replacements = [
        (r"확인되지\s+(않았다|않는다)$", "확인되지 않음"),
        (r"제시되지\s+(않았다|않는다)$", "제시되지 않음"),
        (r"나타나지\s+(않았다|않는다)$", "나타나지 않음"),
        (r"부족하다$", "부족"),
        (r"필요하다$", "필요"),
        (r"계획이다$", "계획"),
        (r"예정이다$", "예정"),
        (r"목표로\s+하고\s+있다$", "목표"),
        (r"추진\s+중이다$", "추진"),
        (r"검토\s+중이다$", "검토"),
        (r"진행\s+중이다$", "진행"),
        (r"이어지고\s+있다$", "지속"),
        (r"진행하고\s+있다$", "진행"),
        (r"추진하고\s+있다$", "추진"),
        (r"검토하고\s+있다$", "검토"),
        (r"보여준다$", "시사"),
        (r"시사한다$", "시사"),
        (r"해석된다$", "해석"),
        (r"판단된다$", "판단"),
        (r"예상된다$", "예상"),
        (r"확인된다$", "확인"),
        (r"확인됐다$", "확인"),
        (r"나타났다$", "확인"),
        (r"언급됐다$", "언급"),
        (r"언급했다$", "언급"),
        (r"발표됐다$", "발표"),
        (r"발표했다$", "발표"),
        (r"공개했다$", "공개"),
        (r"밝혔다$", "공개"),
        (r"체결했다$", "체결"),
        (r"서명했다$", "서명"),
        (r"선임했다$", "선임"),
        (r"인수했다$", "인수"),
        (r"완료했다$", "완료"),
        (r"가동했다$", "가동"),
        (r"기록했다$", "기록"),
        (r"제공한다$", "제공"),
        (r"제공했다$", "제공"),
        (r"지원한다$", "지원"),
        (r"지원했다$", "지원"),
        (r"적용한다$", "적용"),
        (r"적용했다$", "적용"),
        (r"수용했다$", "수용"),
        (r"확대한다$", "확대"),
        (r"확대했다$", "확대"),
        (r"강화한다$", "강화"),
        (r"강화했다$", "강화"),
        (r"구축한다$", "구축"),
        (r"구축했다$", "구축"),
        (r"개발한다$", "개발"),
        (r"개발했다$", "개발"),
        (r"운영한다$", "운영"),
        (r"운영했다$", "운영"),
        (r"있다$", ""),
        (r"없다$", "없음"),
        (r"된다$", ""),
        (r"됐다$", ""),
        (r"한다$", ""),
        (r"했다$", ""),
        (r"이다$", ""),
    ]
    for source, target in replacements:
        text = re.sub(source, target, text)
    return text.strip()


def phraseify_summary_text(value, row=None):
    """표제용 정리. 개조식 종결과 카드가 이미 보여 주는 앞머리 주어까지만 손댄다.

    예전에는 조사와 연결어미까지 지웠다. "공급망을 강화하는 기술 협력"은 "공급망을 강화 기술 협력"이,
    "생산 능력을 확대하고 있으며"는 "확대 있으며"가, "National Wealth Fund의 출자"는 "National Wealth
    Fund 출자"가 됐고, 문장 사이 마침표를 쉼표로 바꿔 세 문장을 한 줄로 이어 붙이기까지 했다.
    개조식은 어미를 ~했음으로 정리하는 것이지 조사와 연결어미를 없애는 것이 아니다. 승인된 문안은
    모델이 쓴 대로 싣고, 출력 단계는 공백·줄바꿈·배치만 맡는다.
    """
    # 종결어미 정리는 한국어 규칙이라 영문에는 적용하지 않는다.
    if LANG != "ko":
        return clean_text(value)
    text = re.sub(r"[.!?。]+$", "", strip_summary_lead(value, row).strip())
    return re.sub(r"\s+", " ", phrase_ending_text(text)).strip()


def compact_summary_phrase(value, limit=90, row=None):
    return short_text(phraseify_summary_text(value, row), limit)


def summary_detail_text(value, limit=230):
    """표제 아래 상세 문장. 표제용 명사형 압축을 걸지 않는다.

    phraseify_summary_text 는 "개발하고"를 "개발"로, "활용해"를 "활용·"로 바꾸고 문장 앞 주어를 떼어
    짧은 표제를 만든다. 같은 규칙을 상세 문장에 걸면 2026-08 보고서(9월 14일 실행)의 Moderna 칸처럼
    "인티스메란을 개발 면역항암제 키트루다와 병용 연구를 공동으로 진행함"이 되고, 주어였던 머크도 사라진다.
    """
    return short_text(clean_text(value), limit)


def summary_parts(row):
    headline_limit = 110 if LANG == "en" else 58
    # 본문이 최대 6줄까지 늘어날 수 있으므로 글자 수 상한이 먼저 걸리지 않게 잡는다.
    # 실제로 몇 줄을 싣을지는 draw_summary_text가 폭으로 판단한다.
    detail_limit = 440 if LANG == "en" else 230
    headline = compact_summary_phrase(summary_field(row, "ai_summary_headline"), headline_limit, row)
    detail = summary_detail_text(summary_field(row, "ai_summary_detail"), detail_limit)
    if headline or detail:
        return {
            "headline": headline or compact_summary_phrase(summary_field(row, "ai_summary"), headline_limit, row),
            "detail": detail,
        }

    text = normalize_summary_text(summary_field(row, "ai_summary"))
    if not text:
        return None

    # 앞부분을 표제로 떼어 낼 때는 그 앞부분이 표제 상한 안에 들어갈 때만 나눈다. 넘치는 앞부분을 잘라
    # 표제로 쓰면 문장 한가운데가 "..."로 끊긴다. 2026-08 영문판의 "…in Singapore with the..."가
    # 그랬다. "표제 - 상세" 구분 없이 한 문장으로 온 영문 요약의 첫 쉼표 앞이 110자를 넘었다.
    def fits_headline(part):
        return len(phraseify_summary_text(part, row)) <= headline_limit

    dashed = re.split(r"\s[-–—]\s", text)
    if len(dashed) >= 2 and fits_headline(dashed[0]):
        return {
            "headline": compact_summary_phrase(dashed[0], headline_limit, row),
            "detail": summary_detail_text(" - ".join(dashed[1:]), detail_limit),
        }

    sentences = sentence_spans(text)
    if len(sentences) >= 2 and fits_headline(sentences[0]):
        return {
            "headline": compact_summary_phrase(sentences[0], headline_limit, row),
            "detail": summary_detail_text(" ".join(sentences[1:]), detail_limit),
        }

    # 쉼표에서는 나누지 않는다. 쉼표 앞은 대개 주어나 고유명사일 뿐이다. 2026-08 영문판에서
    # "GUSS Automation, a wholly owned subsidiary of John Deere, plans ..."는 "GUSS Automation"이,
    # "University of California, Berkeley"는 "University of California"가 표제로 떨어졌다.
    # 나눌 곳이 없으면 요약 전체를 한 문장으로 싣는다.
    return {"headline": summary_detail_text(text, detail_limit), "detail": ""}


def summary_plain_text(row):
    parts = summary_parts(row)
    if not parts:
        return ""
    if parts["detail"]:
        return f"{parts['headline']} — {parts['detail']}"
    return parts["headline"]


# 문장 끝. 마침표는 뒤에 공백이나 글 끝이 올 때만 끝으로 본다. 그래야 23.6% 같은 소수점이
# 갈라지지 않는다. 영문 이니셜과 흔한 약어 뒤 마침표도 끝이 아니다. 2026-08 보고서에서
# "Michael J. Fox" 가 "마이클 J, 폭스"로 인쇄됐다. 일본어 마침표는 뒤에 공백이 없어도 끝이다.
SENTENCE_END = re.compile(r"。+|[.!?]+(?=\s|$)")
NOT_A_SENTENCE_END = re.compile(r"(?:\b[A-Z]|\b(?:Inc|Co|Corp|Ltd|Dr|Mr|Ms|Mrs|St|No|vs|etc|Jr|Sr|U\.S|e\.g|i\.e))$")


def sentence_spans(text):
    text = str(text or "")
    sentences, start = [], 0
    for match in SENTENCE_END.finditer(text):
        if match.group() == "." and NOT_A_SENTENCE_END.search(text[start:match.start()]):
            continue
        sentences.append(text[start:match.end()].strip())
        start = match.end()
    sentences.append(text[start:].strip())
    return [sentence for sentence in sentences if sentence]


def split_sentences(text):
    return sentence_spans(text)


def signal_fingerprint(row):
    values = [
        row.get("target_no"),
        row.get("company"),
        row.get("investment_signal_no"),
    ]
    return "|".join(str(value) for value in values if value not in (None, ""))


def fnv1a_utf8(value):
    hash_value = 0x811C9DC5
    for byte in str(value).encode("utf-8"):
        hash_value ^= byte
        hash_value = (hash_value * 0x01000193) & 0xFFFFFFFF
    return f"{hash_value:08x}"


def parse_ignored_signal_keys(value):
    if not value:
        return set()
    return {item.strip() for item in str(value).split(",") if item.strip()}


def filter_ignored_signals(rows, ignored_keys):
    if not ignored_keys:
        return rows
    filtered = []
    for row in rows:
        fingerprint = signal_fingerprint(row)
        if fingerprint in ignored_keys or fnv1a_utf8(fingerprint) in ignored_keys:
            continue
        filtered.append(row)
    return filtered


def override_summary_period(summary, from_date=None, to_date=None):
    if not from_date and not to_date:
        return summary
    updated = dict(summary)
    if from_date:
        updated["from_date"] = str(from_date)[:10]
    if to_date:
        updated["to_date"] = str(to_date)[:10]
    return updated


def company_sort_key(row):
    return int(row.get("target_no") or 999)


def build_profiles(targets, tech_map):
    tech_rows = {row["company"]: row for row in tech_map.get("companies", [])}
    profiles = []
    for target in sorted(targets, key=company_sort_key):
        company = target["company"]
        tech = tech_rows.get(company, {})
        group = tech.get("technology_group", "")
        country = COUNTRY_BY_COMPANY.get(company, "")
        industry = DETAILED_INDUSTRY_BY_GROUP.get(group, tech.get("industry", ""))
        target_technology = tech.get("target_technology", "")
        if LANG == "en":
            country = COUNTRY_EN.get(country, country)
            industry = DETAILED_INDUSTRY_EN.get(group, industry)
            target_technology = tech.get("target_technology_en") or target_technology
        profiles.append(
            {
                **target,
                **tech,
                "target_no": target.get("target_no", tech.get("target_no")),
                "company": company,
                # 식별자는 그대로 두고 화면에만 쓰는 이름. 목록 원본의 오기(Metals)를 바로잡는다.
                "display_name": target.get("display_name") or company,
                "country": country,
                "detailed_industry": industry,
                "target_technology": target_technology,
                "exempt_from_relevance": bool(tech.get("excluded_from_relevance")) or company in EXEMPT_COMPANIES,
            }
        )
    return profiles


PRESS_RELEASE_PATTERN = re.compile(
    r"press[\s_-]*releases?|news[\s_-]*releases?|media[\s_-]*releases?|pressreleases?|newsreleases?"
    r"|보도\s*자료|press[\s_-]*room|pressemitteilung|communiqu[eé]s?[\s_-]*de[\s_-]*presse"
    r"|comunicad[oa]s?[\s_-]*de[\s_-]*prensa",
    re.IGNORECASE,
)


def is_press_release(row):
    """수집 단계의 source_kind가 없는 과거 데이터도 출처명·URL로 공식 보도자료를 판별한다."""
    if not row or row.get("source_type") != "official":
        return False
    if row.get("is_press_release") is True:
        return True
    if row.get("source_kind"):
        return row.get("source_kind") == "press_release"
    haystack = " ".join(
        str(row.get(field) or "") for field in ("source", "official_source_url", "url")
    )
    return bool(PRESS_RELEASE_PATTERN.search(haystack))


def is_relevance_exempt(row):
    """분류 단계에서 유치필요 품목(기술) 관련성 검사를 생략한 행인지.

    이런 행에 타겟 기술 근거를 요구하면 분류 단계의 면제가 발행 단계에서 되살아난다.
    """
    return row.get("excluded_from_relevance") is True or row.get("technology_gate_decision") == "relevance_exempt"


# 지표 3(투자 재원 확보)·5(핵심 전략 인력의 이동)은 회사채 발행·C-Level 이동처럼 기업 단위로
# 일어나는 사건이라 발표문이 품목을 적는 일이 드물다. 어느 지표가 여기 해당하는지는
# config/approval_policy.json 이 정하고, scripts/validate_report_inputs.mjs 의
# targetTechnologyRequired 가 같은 값을 읽는다.
def target_technology_required(row):
    """이 행이 승인되려면 타겟 기술 근거가 필요한지."""
    if is_relevance_exempt(row):
        return False
    signal_no = row.get("investment_signal_no")
    return signal_no is None or str(signal_no) not in COMPANY_LEVEL_INDICATORS


def signal_supported(row):
    """요약 단계에서 본문을 읽고 '이 시그널의 근거가 실제로 있다'고 판정했는지.

    validate_report_inputs.mjs 의 승인 규칙을 그대로 옮긴 것이다. 두 곳이 어긋나면 판정 단계가
    승인한 행을 발행 단계가 조용히 떨어뜨린다. 정확성 우선 원칙에 따라 판정 누락과 needs_review 는
    발행하지 않고, 기업 귀속·지표·선행성이 모두 참이어야 하며, target_technology_required 가 참인
    후보에는 타겟 기술 근거도 함께 요구한다. 승인되지 않은 근접 후보(ai_signal_supported=False)는 대시보드용이라
    여기서 걸러진다. 요약문의 분량·문체 문제는 근거 판정이 아니므로 여기서 보지 않는다.
    """
    if not row or row.get("ai_signal_supported") is not True:
        return False
    if row.get("ai_summary_quality") != "pass":
        return False
    technology_required = target_technology_required(row)
    required_fields = [
        "ai_entity_supported",
        "ai_indicator_supported",
        "ai_leading_indicator_supported",
    ]
    if technology_required:
        required_fields.append("ai_target_technology_supported")
    for field in required_fields:
        if row.get(field) is not True:
            return False
    stage = row.get("ai_event_stage")
    if row.get("investment_signal_no") is not None:
        allowed = stage in LEADING_STAGES or (
            stage == "precursor" and str(row.get("investment_signal_no")) in PRECURSOR_INDICATORS
        )
    else:
        allowed = stage == BUSINESS_STAGE
    # 예전에는 여기서 사유 문장에 품목 무관 문구가 있는지 정규식으로 다시 읽었다. 발행 단계가
    # 의미를 새로 판정한 것이고, 그래서 "한국 투자 자체는 언급되지 않음"처럼 부정 대상이 다른
    # 사유까지 걸려 근거가 확인된 후보가 조용히 사라졌다. 이제 그 모순은 검토 단계가 후보의 근거와
    # 함께 다시 물어 풀고(review_report.mjs 의 relevanceConflictSuspects), 풀리지 않은 후보는
    # 재검토 미완료로 남아 애초에 여기까지 오지 않는다. 발행은 판정된 필드만 읽는다.
    return allowed


# 분기·연간 공시는 그 기간에 있었던 일을 모아 다시 적는다. 한 기업의 같은 지표에 단독
# 발표 기사와 실적 공시가 함께 승인되면, 실적 공시 쪽 문안은 지난 분기 사건을 이번 달
# 시그널로 보이게 만들 수 있다. 34546694524 실행의 Applied Materials S4 가 그랬다:
# 8월 11일 UC 버클리 EPIC 센터 공동연구가 따로 승인돼 있는데도, 8월 13일 실적 발표문에
# 하이라이트로 실린 6월 16일 에실로룩소티카 계약이 대표 문안으로 나갔다.
PERIODIC_DISCLOSURE_PATTERN = re.compile(
    r"(quarter(ly)?|half[- ]year|full[- ]year|interim|annual|fiscal|"
    r"Q[1-4]\b|H[12]\b|FY\s?\d|earnings|results|annual report|"
    r"semiannual|決算|四半期|반기|분기|실적)",
    re.IGNORECASE,
)


def is_periodic_disclosure(row):
    """실적·연차 공시처럼 한 기간의 사건을 모아 싣는 문서인지."""
    if not row:
        return False
    return bool(PERIODIC_DISCLOSURE_PATTERN.search(str(row.get("title") or "")))


def signal_publishable(row):
    """시그널 칸에 올릴 수 있는 행.

    한·영 문안이 모두 있어야 싣는다. 문안 없이 원문 발췌로 칸을 채우면 한국어판에 영어·일본어
    본문이나 "PDF 3.29 MB" 같은 링크 문구가 그대로 나간다(2026-08 실행). 두 언어판의 매트릭스가
    같도록 한쪽 문안만 있는 행도 뺀다. 판정 단계가 이미 같은 기준으로 거르므로 여기는 이중 확인이다.
    """
    return (
        signal_supported(row)
        and bool(clean_text(row.get("ai_summary_ko")))
        and bool(clean_text(row.get("ai_summary_en")))
    )


def sort_signal_rows(rows, prefer_single_event=False):
    def key(row):
        supported = 0 if signal_publishable(row) else 1
        # 시그널 칸을 고를 때만 쓴다. 사업현황 상자는 실적 공시가 본래의 근거이므로
        # best_business_row 는 이 선호를 켜지 않는다.
        single_event = (1 if prefer_single_event and is_periodic_disclosure(row) else 0)
        press = 0 if is_press_release(row) else 1
        official = 0 if row.get("source_type") == "official" else 1
        technology_score = -(row.get("technology_relevance_score") or row.get("relevance_score") or 0)
        signal_score = -(row.get("investment_signal_score") or 0)
        # 일자 미상 기사는 그 달 1일로 놓고 정렬한다. 정렬 때문에 날짜가 채워지지는 않는다.
        state = date_state(row)
        day = state["day"] or (month_bounds(state["month"])[0] if state["month"] else None)
        timestamp = -datetime(day.year, day.month, day.day, tzinfo=timezone.utc).timestamp() if day else 0
        return (supported, single_event, press, official, technology_score, signal_score, timestamp)

    return sorted(rows, key=key)


def index_investment_signals(rows):
    index = defaultdict(lambda: defaultdict(list))
    for row in rows:
        # 매트릭스의 켜진 칸은 '당월 포착된 시그널'을 뜻한다. 근거가 확인되지 않은 행이 칸을 켜면
        # 문서가 스스로 정의한 뜻과 어긋난다.
        if not signal_publishable(row):
            continue
        company = row.get("company")
        try:
            no = int(row.get("investment_signal_no"))
        except Exception:
            continue
        index[company][no].append(row)
    for company in index:
        for no in index[company]:
            index[company][no] = sort_signal_rows(index[company][no], prefer_single_event=True)
    return index


def covered_companies(summary, signal_rows):
    """검토를 끝낸 기업. 커버리지가 있으면 그것을 쓰고, 없으면 공식 출처 유무로 본다."""
    coverage = summary.get("review_coverage")
    if isinstance(coverage, list):
        # no_monthly_sources 는 수집이 끝났는데 이번 달 자료가 없었다는 뜻이다. 검토 후 미포착과 같다.
        return {item.get("company") for item in coverage if item.get("status") in ("reviewed", "no_monthly_sources")}
    return {row.get("company") for row in signal_rows
            if row.get("company") and row.get("source_type") == "official"}


def signal_cell_state(signal_index, company, no):
    """매트릭스 한 칸. on=AI 확인 시그널, ""=신호없음.

    승인 조건을 하나라도 못 채운 근접 후보는 index_investment_signals 가 이미 빼므로 칸을
    켜지 않는다. 그 후보는 대시보드에만 남는다.
    """
    return "on" if signal_index.get(company, {}).get(no) else ""


def company_status(company, signal_index, covered):
    """매트릭스 한 행의 상태.

    detected     이번 달 AI 확인 시그널이 있다
    reviewed     시그널이 없다

    covered 는 더 이상 행 상태를 가르지 않는다. 각주는 이 상태를 숫자로 말하고,
    report_view_model.py 가 이 함수를 그대로 쓴다. 규칙을 한 곳에 둬야 두 렌더러가 같은 표를 그린다.
    """
    states = [signal_cell_state(signal_index, company, no) for no in range(1, 6)]
    return "detected" if "on" in states else "reviewed"


# 출처 줄은 "출처  <경로> <날짜>" 순서라, 통째로 120자에서 자르면 끝에 있는 날짜부터
# 사라진다. 34564332764 영문판 9쪽 Renishaw 가 그랬다: 뉴스룸 경로가 길어서 "...laser
# enco..." 로 단어 중간이 끊기고 발행일 2026.08.xx 가 통째로 없어졌다. 재검증하려면
# 날짜가 제일 필요한데 날짜부터 버린 것이다. 경로를 줄이고 날짜는 남긴다.
SOURCE_LINE_LIMIT = 120


# 수집 설정의 출처 이름은 "기업 - 페이지 제목 / 분류 / 하위 분류" 모양의 내부 경로다. 그대로 실으면
# "Media / Newsroom / Media", "Official RSS", "IR-filtered News", "Google News: Yahoo Finance" 처럼
# 수집 경로가 독자에게 보인다. 발행처와 게시 위치만 남기고 같은 말은 한 번만 적는다.
SOURCE_INTERNAL_WORDS = re.compile(r"\b(?:RSS|Filter|Subscription|Official)\b", re.IGNORECASE)


def source_display_name(source):
    # clean_text 는 본문용이라 "News Release" 같은 상투 문구를 지운다. 출처 이름에서는 그것이 이름이다.
    text = re.sub(r"\s+", " ", str(source or "")).strip()
    aggregated = re.match(r"^Google News:\s*(.+)$", text)
    if aggregated:
        return aggregated.group(1).strip()
    if " - " not in text:
        return text
    name, path = text.split(" - ", 1)
    segments, seen = [], {name.strip().lower()}
    for segment in path.split(" / "):
        segment = re.sub(r"\bIR-filtered\b", "Investor", segment, flags=re.IGNORECASE)
        segment = re.sub(r"\s{2,}", " ", SOURCE_INTERNAL_WORDS.sub("", segment)).strip(" :")
        segment = re.sub(r"^:\s*|\s+(?=:)", "", segment)
        if segment and segment.lower() not in seen:
            seen.add(segment.lower())
            segments.append(segment)
    return f"{name.strip()} - {' / '.join(segments)}" if segments else name.strip()


def source_line(row):
    source = source_display_name(row.get("source") or row.get("collector") or "") or t("source_fallback")
    if is_press_release(row):
        source = f"{t('source_press_release')} · {source}"
    prefix = f"{t('source_prefix')}  "
    date = format_row_date(row)
    tail = f" {date}" if date else ""
    room = SOURCE_LINE_LIMIT - len(prefix) - len(tail)
    return f"{prefix}{short_text(source, room)}{tail}" if room > 0 else short_text(f"{prefix}{source}{tail}", SOURCE_LINE_LIMIT)


def cover_kicker():
    """표지 머리말. 영문 표지에는 없다.

    t() 를 거치지 않는다. t() 는 빈 값을 국문으로 대체하므로, "이 언어에는 두지 않는다"를
    "아직 번역하지 않았다"로 읽어 국문 머리말을 영문 표지에 싣는다. cover_titles() 와 같은 이유다.
    본문 면의 머리글은 이 값이 아니라 draw_detail_page 의 자체 문자열이므로 영향받지 않는다.

    clean_text 로 다듬지 않는다. 이 머리말은 자간을 진짜 공백으로 내므로 공백을 접으면
    "C O M P A N Y   S I G N A L S" 가 낱말 사이 간격을 잃는다.
    """
    value = TEXTS.get(LANG, TEXTS["ko"]).get("cover_kicker", "")
    return value if value.strip() else ""


def cover_titles():
    """표지 제목 줄. 줄 수는 언어마다 다르다(국문 3줄, 영문 1줄).

    t() 를 거치지 않는다. 값이 문자열이 아니라 목록이고, t() 의 빈 값 폴백이 여기서는 오답이다.
    두 렌더러가 같은 표지를 그려야 하므로 이 목록을 만드는 자리는 여기 한 곳이다.
    """
    titles = TEXTS.get(LANG, TEXTS["ko"]).get("cover_titles") or TEXTS["ko"]["cover_titles"]
    return [title for title in titles if clean_text(title)]


def cover_title_accent():
    """금색으로 칠할 표지 제목 줄의 순번. 두 렌더러가 같은 줄을 칠하도록 여기서 정한다."""
    texts = TEXTS.get(LANG, TEXTS["ko"])
    return texts.get("cover_title_accent", TEXTS["ko"]["cover_title_accent"])


def source_url(row):
    """출처 줄이 가리킬 원문 주소. Google 중계 주소보다 발행사 원문을 먼저 쓴다.

    PDF 출처가 글자 라벨뿐이라 독자가 원문으로 갈 수 없었다(2026-08 검토, 링크 0개).
    """
    if not row:
        return ""
    candidates = [str(row.get(key) or "").strip() for key in ("source_direct_url", "content_source_url", "url")]
    web = [value for value in candidates if value.startswith(("http://", "https://"))]
    direct = [value for value in web if "news.google.com" not in value]
    return (direct or web or [""])[0]


def detail_text(row, limit=260):
    ai_summary = summary_plain_text(row)
    if ai_summary:
        return short_text(ai_summary, limit)

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


def expand_business_summary(row, text):
    return normalize_summary_text(text)


def business_prose(text):
    """사업동향은 문장으로 싣는다. 모델이 앞에 붙인 "표제 - 본문"의 표제를 뗀다.

    2026-08 Nabtesco 카드는 "나브테스코 - 로봇용 감속기 … 매출 증가 기록 나브테스코는 …"처럼
    표제와 본문이 붙어 인쇄됐다. 표제 뒤에서 같은 주어(표제 첫 구절 + 은/는/이/가)가 다시
    나오면 거기서 본문이 시작한다. 숫자 범위("2025 - 2026")나 문장 안의 대시는 건드리지 않는다.
    """
    match = re.match(r"^(?P<lead>[^.!?。]{1,80}?)\s[-–—]\s(?P<rest>.+)$", text or "")
    if not match:
        return text
    lead, rest = match.group("lead").strip(), match.group("rest").strip()
    if re.search(r"\d$", lead) and re.match(r"\d", rest):
        return text
    subject = lead.split(",")[0].strip()
    again = re.search(rf"{re.escape(subject)}(은|는|이|가)\s", rest) if subject else None
    if again and again.start() <= 120 and not re.search(r"[.!?。]", rest[:again.start()]):
        rest = rest[again.start():]
    return rest


def business_text(rows):
    if not rows:
        return t("business_empty")
    row = sort_signal_rows(rows)[0]
    ai_summary = business_prose(normalize_summary_text(summary_field(row, "ai_summary")))
    if ai_summary:
        return short_text(expand_business_summary(row, ai_summary), 950)
    return short_text(expand_business_summary(row, detail_text(row, 900)), 950)


def business_near_miss(row):
    """승인은 아니지만 사업현황 상자를 채울 수 있는 사업동향 행인지.

    승인 조건(signal_supported)에서 품목 연계 근거 하나만 빠진 행이다. 나머지는 그대로 요구한다.
    기업 귀속·지표 사건·선행성이 확인되고 문안 품질이 pass 여야 하며, 단계는 사업동향의 고정값이어야
    한다. 어떤 행을 근접으로 남길지는 local_report.mjs 의 nearMissCandidate 가 정하고, 여기서는
    그렇게 남은 행 가운데 상자에 실을 수 있는 것만 다시 고른다.

    한·영 문안이 모두 있어야 한다. 문안이 없으면 business_text 가 근거 발췌로 떨어지고, 그러면
    한국어판에 영문·일문 본문이나 "PDF 3.29 MB" 같은 문구가 그대로 나간다(2026-08 실행).
    상자를 채우는 것이 목적이지, 무엇이든 채우는 것이 목적이 아니다.
    """
    if not row or row.get("ai_signal_supported") is not False:
        return False
    # 투자 시그널 행은 여기로 오지 않는다. 사업동향 행만 상자의 후보다.
    if row.get("investment_signal_no") is not None:
        return False
    if row.get("ai_event_stage") != BUSINESS_STAGE:
        return False
    if row.get("ai_summary_quality") != "pass":
        return False
    for field in ("ai_entity_supported", "ai_indicator_supported", "ai_leading_indicator_supported"):
        if row.get(field) is not True:
            return False
    return bool(clean_text(row.get("ai_summary_ko"))) and bool(clean_text(row.get("ai_summary_en")))


def best_business_row(company, relevant_rows, investment_rows, all_signal_rows, shown_rows=()):
    """사업현황 상자에 쓸 행. 사업동향 행이 없을 때만 투자 시그널 행으로 대신한다.

    별도 사건을 우선하되, 다른 문안이 없으면 시그널 칸에 실린 승인 문안을 재사용한다.
    중복 회피 때문에 확인된 사업 활동이 있는데도 사업현황이 없다고 표시해서는 안 된다.

    승인된 후보가 하나도 없으면 근접 사업동향 행을 쓴다. 2026-08 실행의 Skyworks·Evonik·Jenoptik 은
    승인된 사업동향이 0건이라 세 기업의 상자가 모두 "확인되지 않음"으로 나갔다. 근접 행은 승인이
    아니므로 상자에 그렇게 표시된다(report_view_model 의 business.near_miss). 표시 없이 실으면
    확인되지 않은 품목 연계를 확인된 것처럼 말하는 보고서가 된다.
    """
    shown = {id(row) for row in shown_rows}
    candidates = [row for row in relevant_rows if row.get("company") == company and signal_supported(row)]
    if not candidates:
        candidates = [row for row in investment_rows
                      if row.get("company") == company and signal_supported(row) and id(row) not in shown]
    if not candidates:
        candidates = [
            row
            for row in all_signal_rows
            if row.get("company") == company
            and row.get("source_type") == "official"
            and signal_supported(row)
            and id(row) not in shown
        ]
    if not candidates:
        candidates = [row for row in relevant_rows
                      if row.get("company") == company and business_near_miss(row) and id(row) not in shown]
    if not candidates:
        candidates = [row for row in shown_rows
                      if row.get("company") == company and signal_publishable(row)]
    return sort_signal_rows(candidates)[0] if candidates else None


def target_section_for_profile(profile):
    if profile.get("exempt_from_relevance"):
        return "", ""
    target_text = str(profile.get("target_technology") or "").strip()
    if not target_text:
        return "", ""
    # 라벨은 품목별 사업동향 카드와 같은 "투자유치 필요 품목·기술" 하나로 쓴다. 기업 목록으로 "타겟기술"과
    # "타겟품목"을 나누던 방식은 한 보고서 안에서 같은 정보를 세 이름으로 불렀다.
    # 같은 품목명이 품목별 페이지에서는 대문자로, 상세 페이지에서는 소문자로 나오던 것을 맞춘다.
    # item_target_text는 첫 글자만 올리므로 LiDAR·GMP 같은 약어는 그대로 남는다.
    return t("item_target_label"), item_target_text(profile)


def build_item_trend_entries(profiles, signal_index, relevant_rows):
    """5대 시그널 미포착 + 타겟 품목·기술 연관 사업동향 포착 기업을 기업 단위로 모은다."""
    entries = []
    for profile in profiles:
        company = profile["company"]
        if any(signal_index.get(company, {}).values()):
            continue
        # 이 카드의 존재 이유가 '타겟 품목·기술과 직접 연계된 사업동향'이므로,
        # 그 연계가 확인되지 않은 행으로는 카드를 만들지 않는다.
        candidates = [row for row in relevant_rows if row.get("company") == company and signal_supported(row)]
        if not candidates:
            continue
        if not str(profile.get("target_technology") or "").strip():
            continue
        entries.append({"profile": profile, "row": sort_signal_rows(candidates)[0]})
    return entries


def item_trend_text(row):
    """품목동향 카드에 실을 문안 전체. HTML 보고서는 자르지 않고, reportlab 판은 item_trend_body 가 줄 수에 맞춘다."""
    return business_prose(normalize_summary_text(summary_field(row, "ai_summary"))) or normalize_summary_text(detail_text(row, 400))


def item_target_text(profile):
    text = str(profile.get("target_technology") or "").strip()
    # Sentence initial only: preserve internal acronyms such as GMP, RF and LiDAR.
    return text[:1].upper() + text[1:] if LANG == "en" else text
