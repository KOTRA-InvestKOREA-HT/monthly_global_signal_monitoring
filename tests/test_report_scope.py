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
    # 실행 35167466191: 3M 은 사업동향이 없어 시그널 칸의 S3 문안이 사업현황에 한 번 더 실렸다.
    def test_a_row_shown_as_a_signal_is_not_repeated_in_the_business_box(self):
        signal = approved("3M", investment_signal_no=3)
        self.assertTrue(pdf.signal_supported(signal))
        self.assertIs(pdf.best_business_row("3M", [], [signal], []), signal)
        self.assertIsNone(pdf.best_business_row("3M", [], [signal], [], [signal]))
        other = approved("3M", investment_signal_no=5)
        self.assertIs(pdf.best_business_row("3M", [], [signal, other], [], [signal]), other)
        business = approved("3M", ai_event_stage="not_applicable")
        self.assertIs(pdf.best_business_row("3M", [business], [signal], [], [signal]), business)


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


if __name__ == "__main__":
    unittest.main()
