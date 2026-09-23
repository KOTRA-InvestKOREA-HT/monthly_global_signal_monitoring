import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import build_pdf_report as pdf
import report_view_model as view


def approved(company, **extra):
    return {"company": company, "ai_signal_supported": True, "ai_entity_supported": True,
            "ai_indicator_supported": True, "ai_leading_indicator_supported": True, "ai_target_technology_supported": True,
            "ai_summary_quality": "pass", "ai_event_stage": "precursor", "ai_summary_ko": "문안", "source_type": "official", **extra}


class BusinessBoxTests(unittest.TestCase):
    def test_a_shown_signal_fills_the_box_only_when_no_separate_summary_exists(self):
        signal = approved("3M", investment_signal_no=3, ai_summary_en="Confirmed financing.")
        self.assertTrue(pdf.signal_supported(signal))
        self.assertIs(pdf.best_business_row("3M", [], [signal], []), signal)
        self.assertIs(pdf.best_business_row("3M", [], [signal], [], [signal]), signal)
        other = approved("3M", investment_signal_no=5)
        self.assertIs(pdf.best_business_row("3M", [], [signal, other], [], [signal]), other)
        business = approved("3M", ai_event_stage="not_applicable")
        self.assertIs(pdf.best_business_row("3M", [business], [signal], [], [signal]), business)

    def test_the_last_resort_requires_approved_bilingual_prose_for_this_company(self):
        signal = approved("3M", investment_signal_no=3, ai_summary_en="Confirmed financing.")
        for changes in ({"ai_summary_en": ""}, {"ai_summary_ko": ""},
                        {"ai_signal_supported": False}, {"company": "Other"}):
            row = dict(signal, **changes)
            self.assertIsNone(pdf.best_business_row("3M", [], [], [], [row]))


class BusinessNearMissTests(unittest.TestCase):
    """승인된 사업동향이 없는 기업의 상자를 근접 행으로 채운다.

    2026-08 실행의 Skyworks·Evonik·Jenoptik 은 승인된 사업동향이 0건이라 세 기업의 사업현황이
    모두 "확인되지 않음"으로 나갔다. 근접 행은 승인 조건에서 품목 연계 근거 하나만 빠진 행이다.
    """

    @staticmethod
    def near(company="Evonik Industries", **extra):
        row = approved(company, ai_event_stage="not_applicable")
        row.update({"ai_signal_supported": False, "ai_target_technology_supported": False,
                    "ai_summary_en": "prose", "investment_signal_no": None})
        row.update(extra)
        return row

    def test_a_near_miss_business_row_fills_the_box(self):
        signal = approved("Evonik Industries", investment_signal_no=3)
        row = self.near()
        self.assertTrue(pdf.business_near_miss(row))
        self.assertFalse(pdf.signal_supported(row))
        self.assertIs(pdf.best_business_row("Evonik Industries", [row], [signal], [], [signal]), row)

    def test_an_approved_row_always_wins_over_a_near_miss_row(self):
        row = self.near()
        business = approved("Evonik Industries", ai_event_stage="not_applicable")
        self.assertIs(pdf.best_business_row("Evonik Industries", [business, row], [], []), business)

    def test_a_row_without_both_summaries_never_fills_the_box(self):
        # 문안이 없으면 business_text 가 근거 발췌로 떨어져 한국어판에 영문 본문이 나간다.
        for blank in ({"ai_summary_ko": ""}, {"ai_summary_en": ""}):
            row = self.near(**blank)
            self.assertFalse(pdf.business_near_miss(row), blank)
            self.assertIsNone(pdf.best_business_row("Evonik Industries", [row], [], []))

    def test_the_other_approval_conditions_are_still_required(self):
        for field in ("ai_entity_supported", "ai_indicator_supported", "ai_leading_indicator_supported"):
            self.assertFalse(pdf.business_near_miss(self.near(**{field: False})), field)
        self.assertFalse(pdf.business_near_miss(self.near(ai_summary_quality="needs_review")))
        self.assertFalse(pdf.business_near_miss(self.near(ai_event_stage="planned")))

    def test_an_investment_row_is_not_a_business_near_miss(self):
        self.assertFalse(pdf.business_near_miss(self.near(investment_signal_no=3)))

    def test_an_approved_row_is_not_a_near_miss(self):
        self.assertFalse(pdf.business_near_miss(approved("Evonik Industries", ai_event_stage="not_applicable")))
        self.assertFalse(pdf.business_near_miss(None))

    def test_a_near_miss_row_never_lights_a_matrix_cell(self):
        row = self.near(investment_signal_no=3)
        self.assertFalse(pdf.signal_supported(row))
        self.assertFalse(pdf.signal_publishable(row))
        self.assertEqual(pdf.index_investment_signals([row]), {})

    def test_the_box_says_the_item_link_is_unconfirmed(self):
        self.assertTrue(pdf.t("business_near_miss_note"))
        pdf.set_language("en")
        try:
            self.assertTrue(pdf.t("business_near_miss_note"))
        finally:
            pdf.set_language("ko")


class CutTextTests(unittest.TestCase):
    def test_a_summary_cut_by_a_character_limit_is_flagged(self):
        row = {"ai_summary_en": "Mkango completed the acquisition for EUR 8 million. " * 40}
        pdf.set_language("en")
        try:
            body = pdf.business_text([dict(row, ai_signal_supported=True)])
            self.assertTrue(body.endswith("..."))
            self.assertTrue(view.summary_cut(row, body))
            self.assertFalse(view.summary_cut(row, "Mkango completed the acquisition for EUR 8 million."))
            self.assertFalse(view.summary_cut(None, body))
        finally:
            pdf.set_language("ko")

    def test_trend_card_text_keeps_every_sentence(self):
        text = "첫 문장임. " + "금액은 800만 유로임. " * 20 + "마지막 일정은 9월임."
        self.assertTrue(pdf.item_trend_text({"ai_summary_ko": text}).endswith("마지막 일정은 9월임."))

    # 발행 단계는 승인 조건을 독립적으로 다시 센다. 승인 규칙이 바뀌면 여기도 같이 바뀌어야,
    # 검증을 통과한 행이 매트릭스에서 조용히 사라지지 않는다.
    def test_company_level_indicators_publish_without_a_target_technology_link(self):
        for no in (3, 5):
            row = approved("Veolia", investment_signal_no=no, ai_target_technology_supported=False)
            self.assertTrue(pdf.signal_supported(row), f"S{no}")
            # 품목을 요구하지 않는 후보의 사유에 남은 "타겟 기술 무관"은 탈락 사유가 아니다.
            denied = dict(row, ai_summary_reason="타겟 기술과의 직접적 연계성은 확인되지 않음")
            self.assertTrue(pdf.signal_supported(denied), f"S{no}")

    def test_the_other_indicators_and_the_business_row_still_need_that_link(self):
        for no in (1, 2, 4):
            row = approved("Corning", investment_signal_no=no, ai_target_technology_supported=False,
                           ai_event_stage="planned")
            self.assertFalse(pdf.signal_supported(row), f"S{no}")
        business = approved("Corning", ai_event_stage="not_applicable", ai_target_technology_supported=False)
        self.assertFalse(pdf.signal_supported(business))

    def test_a_company_level_row_still_needs_every_other_condition(self):
        row = approved("Jenoptik", investment_signal_no=5, ai_target_technology_supported=False)
        for field in ("ai_entity_supported", "ai_indicator_supported", "ai_leading_indicator_supported"):
            self.assertFalse(pdf.signal_supported(dict(row, **{field: False})), field)
        self.assertFalse(pdf.signal_supported(dict(row, ai_summary_quality="needs_review")))
        self.assertFalse(pdf.signal_supported(dict(row, ai_event_stage="committed")))

    def test_a_row_without_prose_never_fills_a_signal_cell(self):
        # 문안 없이 원문 발췌로 칸을 채우면 한국어판에 영문 본문이 그대로 나간다(2026-08 실행).
        row = dict(approved("A", investment_signal_no=3), ai_summary_en="text")
        self.assertTrue(pdf.signal_publishable(row))
        self.assertFalse(pdf.signal_publishable(dict(row, ai_summary_ko="")))
        self.assertFalse(pdf.signal_publishable(dict(row, ai_summary_en="")))


class CoverTitleTests(unittest.TestCase):
    """영문 보고서 제목은 Company Signals 다.

    예전 제목 "Target-Company Global Investment Signal Monitor" 는 국문 제목을 낱말마다 옮겨
    붙인 것이라 영어로 읽히지 않았다. 바닥글은 쪽마다 나오므로 여기서 고정해 둔다.
    """

    def title_texts(self, lang):
        previous = pdf.LANG
        pdf.set_language(lang)
        try:
            return pdf.cover_titles(), pdf.t("footer", issue="Issue 3"), pdf.cover_kicker()
        finally:
            pdf.set_language(previous)

    def test_the_english_report_is_called_investment_signals(self):
        titles, footer, _ = self.title_texts("en")
        self.assertEqual(titles, ["Investment Signals"])
        self.assertEqual(footer, "Investment Signals: Monthly Pre-Decision Indicators Across 77 Priority Companies")
        for gone in ("Target-Company", "Global Investment Signal Monitor", "Target Companies"):
            self.assertNotIn(gone, footer)
            self.assertNotIn(gone, " ".join(titles))

    def test_the_gold_title_line_is_chosen_per_language(self):
        # 영문 제목은 한 줄이라, 국문처럼 두 번째 줄을 칠하면 금색 줄이 없어진다.
        previous = pdf.LANG
        try:
            pdf.set_language("en")
            self.assertEqual(pdf.cover_title_accent(), 0)
            pdf.set_language("ko")
            self.assertEqual(pdf.cover_title_accent(), 1)
        finally:
            pdf.set_language(previous)

    def test_the_korean_title_is_unchanged(self):
        titles, footer, _ = self.title_texts("ko")
        self.assertEqual(titles, ["타겟기업", "글로벌 투자시그널", "모니터링"])
        self.assertEqual(footer, "Invest KOREA · 타겟기업 글로벌 투자시그널 모니터링 · Issue 3")

    def test_an_empty_title_line_is_not_drawn_and_never_falls_back_to_korean(self):
        # t() 는 빈 값을 국문으로 폴백한다. 제목 줄을 번호 키로 두면 영문 표지에 한글 줄이 섞인다.
        titles, _, _ = self.title_texts("en")
        self.assertTrue(all(title.strip() for title in titles))
        self.assertFalse(any(any("가" <= ch <= "힣" for ch in title) for title in titles))

    def test_the_english_cover_drops_the_kicker_that_repeated_its_title(self):
        """영문 표지의 kicker 는 제목과 같은 말이었다. 국문은 제목이 달라 그대로 둔다.

        t() 로 읽으면 빈 영문 값이 국문으로 폴백해 영문 표지에 국문 머리말이 실린다.
        cover_kicker() 가 그 폴백을 거치지 않는다는 것까지 같이 고정한다.
        """
        _, _, ko = self.title_texts("ko")
        _, _, en = self.title_texts("en")
        self.assertEqual(ko, "I N V E S T M E N T   S I G N A L S")
        self.assertEqual(en, "")
        # 폴백이 되살아나면 여기서 국문 머리말이 잡힌다.
        self.assertFalse(any("가" <= ch <= "힣" for ch in en))
        # 본문 면의 머리글은 표지와 다른 자리라 그대로 남는다.
        source = (Path(__file__).resolve().parents[1] / "scripts" / "build_pdf_report.py").read_text(encoding="utf-8")
        self.assertIn('report.header("C O M P A N Y   S I G N A L S"', source)

    def test_the_cover_kicker_is_not_copied_into_a_renderer(self):
        """표지 kicker 는 TEXTS 한 곳에서 온다. 렌더러가 사본을 들면 PDF 와 화면이 갈라진다.

        상세 페이지 kicker 는 같은 문자열이지만 표지와 다른 자리라 여기서 보지 않는다.
        무엇이 어느 자리에 찍히는지는 report_snapshot 이 그려진 쪽으로 고정한다.
        """
        for name in ("build_pdf_report.py", "report_view_model.py"):
            source = (Path(__file__).resolve().parents[1] / "scripts" / name).read_text(encoding="utf-8")
            self.assertNotIn("G L O B A L   I N V E S T M E N T", source, name)
        view = (Path(__file__).resolve().parents[1] / "scripts" / "report_view_model.py").read_text(encoding="utf-8")
        self.assertIn('"kicker": report.cover_kicker()', view)


class LayeringTests(unittest.TestCase):
    """무엇이 실리는가(report_content)와 어디에 그리는가(build_pdf_report)의 경계."""

    def test_the_content_layer_does_not_reach_for_the_page(self):
        source = (Path(__file__).resolve().parents[1] / "scripts" / "report_content.py").read_text(encoding="utf-8")
        # reportlab 을 불러오면 화면·진단 쪽에서 내용 계층만 쓰는 길이 막힌다.
        self.assertNotIn("import reportlab", source)
        self.assertNotIn("from reportlab", source)
        # 좌표와 색은 배치 계층의 것이다. 상수가 이쪽으로 새면 쪽 나눔 계산이 따라 넘어온다.
        for name in ("PAGE_W", "PAGE_H", "colors.HexColor", "ITEM_SECTION_TOP", "DETAIL_BOX_TOP"):
            self.assertNotIn(name, source, f"{name} belongs to the layout layer")

    def test_the_content_layer_imports_on_its_own(self):
        import importlib
        module = importlib.import_module("report_content")
        self.assertTrue(hasattr(module, "signal_supported"))
        self.assertFalse(hasattr(module, "draw_matrix"))

    def test_the_builder_still_answers_to_every_name_its_callers_use(self):
        """report_view_model.py 와 테스트는 build_pdf_report.<이름> 으로 들어온다."""
        for name in ("build_profiles", "signal_supported", "summary_parts", "source_line", "t",
                     "set_language", "item_breaks", "register_fonts", "DEFAULT_ISSUE_NUMBER",
                     "SIGNAL_DESCRIPTIONS_EN", "PAGE_W", "SIGNAL_BODY_SIZE"):
            self.assertTrue(hasattr(pdf, name), name)

    def test_the_language_is_one_value_seen_from_both_modules(self):
        """예전에는 pdf.LANG 이 모듈 전역이라 대입도 통했다. 나눈 뒤에도 그대로여야 한다."""
        import report_content
        previous = pdf.LANG
        try:
            pdf.set_language("en")
            self.assertEqual(pdf.LANG, "en")
            self.assertEqual(report_content.LANG, "en")
            self.assertEqual(pdf.cover_titles(), ["Investment Signals"])
            # 예전에는 모듈 전역이라 대입으로도 바뀌었다. 나눈 뒤에도 같은 값을 가리켜야 한다.
            pdf.LANG = "ko"
            self.assertEqual(report_content.LANG, "ko")
            self.assertEqual(pdf.cover_titles()[0], "타겟기업")
        finally:
            pdf.set_language(previous)


if __name__ == "__main__":
    unittest.main()
