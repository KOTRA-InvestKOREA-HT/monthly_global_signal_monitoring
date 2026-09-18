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

    def test_a_row_without_prose_never_fills_a_signal_cell(self):
        # 문안 없이 원문 발췌로 칸을 채우면 한국어판에 영문 본문이 그대로 나간다(2026-08 실행).
        row = dict(approved("A", investment_signal_no=3), ai_summary_en="text")
        self.assertTrue(pdf.signal_publishable(row))
        self.assertFalse(pdf.signal_publishable(dict(row, ai_summary_ko="")))
        self.assertFalse(pdf.signal_publishable(dict(row, ai_summary_en="")))


if __name__ == "__main__":
    unittest.main()
