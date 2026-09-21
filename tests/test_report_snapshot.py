"""보고서 출력을 있는 그대로 고정한다.

build_pdf_report.py 는 내용 선정·승인·문안 가공·PDF 배치가 한 파일에 있고, 화면(report_view_model)도
같은 함수를 부른다. 그 안을 옮기거나 나눌 때 보고서가 조용히 달라지지 않았는지 확인할 방법이 필요하다.
이 테스트는 규칙이 옳은지 묻지 않는다. 오늘 나오는 결과와 같은지만 묻는다.

고정된 픽스처(tests/fixtures/report_snapshot)로 한·영 PDF 를 실제로 그리고,
- 내용 계층의 판단(매트릭스 칸, 기업 상태, 사업현황 선택, 문안, 출처, 품목동향 카드)을 JSON 으로,
- 그려진 PDF 의 페이지별 텍스트를 텍스트 파일로
남겨 둔 것과 대조한다. 실제로 규칙을 바꿨다면 아래로 기대값을 다시 만들고 그 차이를 커밋에 남긴다.

    python tests/test_report_snapshot.py --update
"""

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import build_pdf_report as pdf  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "report_snapshot"
FONT = ROOT / "assets" / "fonts" / "PretendardJP-Regular.ttf"


def fixture(name):
    return str(FIXTURES / name)


class Args:
    """build_report 가 받는 argparse 네임스페이스와 같은 모양."""

    targets = str(ROOT / "data" / "target_companies.json")
    technology_map = str(ROOT / "data" / "company_technology_map.json")
    signals = fixture("company_signals.json")
    summary = fixture("collection_summary.json")
    relevant = fixture("relevant_signals.json")
    relevance_summary = None
    investment_signals = fixture("investment_signals.json")
    investment_summary = fixture("investment_signal_summary.json")
    indicator_config = str(ROOT / "config" / "investment_signal_indicators.json")
    font = str(FONT)
    issue_number = "3"
    ignored_signals = ""
    from_date = ""
    to_date = ""

    def __init__(self, lang, out):
        self.lang = lang
        self.out = str(out)


def content_snapshot(lang):
    """내용 계층이 내린 판단. PDF 좌표가 아니라 '무엇이 실리는가'를 적는다."""
    pdf.set_language(lang)
    targets = pdf.load_json(Args.targets, [])
    tech_map = pdf.load_json(Args.technology_map, {"companies": []})
    summary = pdf.load_json(Args.summary, {})
    signals = pdf.filter_rows_by_report_period(pdf.load_json(Args.signals, []), summary)
    relevant = pdf.filter_rows_by_report_period(pdf.load_json(Args.relevant, []), summary)
    investment = pdf.filter_rows_by_report_period(pdf.load_json(Args.investment_signals, []), summary)

    profiles = pdf.build_profiles(targets, tech_map)
    signal_index = pdf.index_investment_signals(investment)
    covered = pdf.covered_companies(summary, signals)

    cells, statuses, business, signal_text = {}, {}, {}, {}
    for profile in profiles:
        company = profile["company"]
        row = [pdf.signal_cell_state(signal_index, company, no) for no in range(1, 6)]
        status = pdf.company_status(company, signal_index, covered)
        statuses[company] = status
        if any(row):
            cells[company] = row
        shown = [r for no in range(1, 6) for r in (signal_index.get(company, {}).get(no) or [])]
        for item in shown:
            key = f"{company}/S{item['investment_signal_no']}"
            signal_text[key] = {
                "parts": list(pdf.summary_parts(item)),
                "source": pdf.source_line(item),
                "url": pdf.source_url(item),
                "date": pdf.format_row_date(item),
                "technology_linked": item.get("ai_target_technology_supported"),
            }
        best = pdf.best_business_row(company, relevant, investment, signals, shown)
        if best:
            business[company] = {"url": pdf.source_url(best), "text": pdf.business_text([best])}

    entries = pdf.build_item_trend_entries(profiles, signal_index, relevant)
    items = [
        {
            "company": entry["profile"]["company"],
            "target": pdf.item_target_text(entry["profile"]),
            "text": pdf.item_trend_text(entry["row"]),
            "source": pdf.source_line(entry["row"]),
        }
        for entry in entries
    ]
    return {
        "matrix_cells": cells,
        "company_status": statuses,
        "signal_cards": signal_text,
        "business_boxes": business,
        "item_trend_cards": items,
        # report_period 는 datetime 쌍을 돌려준다. 스냅샷에는 날짜만 적는다.
        "period": [None if value is None else value.isoformat() for value in pdf.report_period(summary)],
        "matrix_period_label": pdf.matrix_period_label(summary),
        "month_label": pdf.report_month_label(summary),
    }


def page_texts(path):
    import pdfplumber

    with pdfplumber.open(path) as document:
        return [(page.extract_text() or "") for page in document.pages]


def render(lang, directory):
    out = Path(directory) / f"{lang}.pdf"
    # build_report 는 실행 요약을 stdout 에 찍는다. 테스트 출력에 섞이지 않게 삼킨다.
    with contextlib.redirect_stdout(io.StringIO()):
        pdf.build_report(Args(lang, out))
    return out


def build_all(directory):
    snapshot = {}
    pages = {}
    for lang in ("ko", "en"):
        pages[lang] = page_texts(render(lang, directory))
        snapshot[lang] = content_snapshot(lang)
    pdf.set_language("ko")
    return snapshot, pages


def expected_content_path():
    return FIXTURES / "expected_content.json"


def expected_pages_path(lang):
    return FIXTURES / f"expected_pages_{lang}.txt"


PAGE_SEPARATOR = "\n\n===== PAGE {} =====\n"


def join_pages(texts):
    return "".join(PAGE_SEPARATOR.format(index + 1) + text for index, text in enumerate(texts)).lstrip("\n")


class ReportSnapshotTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._directory = tempfile.TemporaryDirectory()
        cls.snapshot, cls.pages = build_all(cls._directory.name)

    @classmethod
    def tearDownClass(cls):
        cls._directory.cleanup()

    def test_the_content_decisions_are_unchanged(self):
        expected = json.loads(expected_content_path().read_text(encoding="utf-8"))
        for lang in ("ko", "en"):
            with self.subTest(lang=lang):
                self.assertEqual(self.snapshot[lang], expected[lang])

    def test_the_drawn_pages_are_unchanged(self):
        for lang in ("ko", "en"):
            with self.subTest(lang=lang):
                self.assertEqual(join_pages(self.pages[lang]),
                                 expected_pages_path(lang).read_text(encoding="utf-8"))

    def test_the_fixture_still_covers_what_the_report_has_to_decide(self):
        """기대값만 다시 찍어 통과시키는 일을 막는다. 덮여야 할 경우가 픽스처에 남아 있는지 본다."""
        content = self.snapshot["ko"]
        self.assertGreaterEqual(len(content["matrix_cells"]), 5, "승인된 시그널이 여러 기업에 있어야 한다")
        self.assertTrue(content["business_boxes"], "사업현황 상자가 선택된 기업이 있어야 한다")
        self.assertTrue(content["item_trend_cards"], "품목별 사업동향 카드가 있어야 한다")
        self.assertIn("reviewed", content["company_status"].values(), "시그널 없는 기업도 있어야 한다")
        # 품목 연결 없이 승인되는 기업 단위 지표(3·5)가 실제로 그려지는지.
        company_level = [key for key, card in content["signal_cards"].items()
                         if card["technology_linked"] is False]
        self.assertTrue(company_level, "품목 미연계 기업 단위 시그널이 픽스처에 있어야 한다")
        # 한국어 문안은 개조식, 영문은 평서문이라 두 스냅샷이 실제로 달라야 한다.
        self.assertNotEqual(self.snapshot["ko"]["signal_cards"], self.snapshot["en"]["signal_cards"])


def update():
    with tempfile.TemporaryDirectory() as directory:
        snapshot, pages = build_all(directory)
    expected_content_path().write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for lang, texts in pages.items():
        expected_pages_path(lang).write_text(join_pages(texts), encoding="utf-8")
    print(f"updated {expected_content_path().name} and {len(pages)} page snapshots")


if __name__ == "__main__":
    if "--update" in sys.argv:
        update()
    else:
        unittest.main()
