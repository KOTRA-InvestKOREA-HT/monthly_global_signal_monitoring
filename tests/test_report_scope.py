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


class ScopeTests(unittest.TestCase):
    def setUp(self):
        self.previous = pdf.LANG
        pdf.set_language("ko")

    def tearDown(self):
        pdf.set_language(self.previous)

    def test_reasons_count_only_insufficient_companies_and_units_stay_separate(self):
        profiles = [{"company": name} for name in ("A", "B", "C")]
        summary = {
            "from_date": "2026-08-01", "to_date": "2026-08-31",
            "review_coverage": [
                {"company": "A", "status": "incomplete_evidence", "reasons": ["collection_incomplete", "review_failed"]},
                {"company": "B", "status": "incomplete_evidence", "reasons": ["collection_incomplete"]},
                # 신호가 있는 기업의 사유는 근거 부족 집계에 넣지 않는다.
                {"company": "C", "status": "incomplete_evidence", "reasons": ["needs_review"]},
            ],
            "review_failed_articles": [{"company": "A", "title": "Failed article", "url": "https://example.com/a"}],
            "review_scope": {"articles": 10, "reviewed_articles": 9, "review_failed_articles": 1, "adjudicated_articles": 2,
                             "wording_fixed_articles": 3, "date_pending_investment_rows": 1, "date_pending_business_rows": 2,
                             "collection_completed_companies": 1, "collection_incomplete_companies": 2},
        }
        signal_index = {"C": {2: [approved("C", investment_signal_no=2)]}}
        counts = view.matrix_counts(profiles, signal_index, summary, [])
        scope = view.scope_entries(profiles, signal_index, summary, counts)
        self.assertEqual([(r["label"], r["count"]) for r in scope["reasons"]],
                         [("수집 작업 미완료", 2), ("기사 판정 실패", 1)])
        self.assertIn("해당 월 기사 10건 중 판정 완료 9건 · 판정 실패 1건", scope["lines"])
        self.assertTrue(any("2건은" in line and "3건은" in line for line in scope["lines"]))
        self.assertEqual(scope["failed"][0]["title"], "Failed article")
        self.assertIsNone(view.scope_entries(profiles, signal_index, {}, counts))


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

    def test_a_pending_recheck_is_labelled_on_the_review_badge(self):
        row = {"ai_signal_supported": False, "ai_review_tier": "human_review", "ai_review_gaps": ["semantic_recheck"],
               "ai_entity_supported": True, "ai_indicator_supported": True, "ai_summary_ko": "문안", "ai_summary_en": "text"}
        self.assertIn("재검토 미완료", pdf.review_label(row))


if __name__ == "__main__":
    unittest.main()
