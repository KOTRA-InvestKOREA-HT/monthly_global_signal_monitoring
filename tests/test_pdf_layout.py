import io
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import build_pdf_report as pdf


class SummaryLayoutTests(unittest.TestCase):
    def setUp(self):
        self.previous_language = pdf.LANG
        pdf.set_language("en")
        fonts = {weight: "Helvetica-Bold" if weight in ("semibold", "extrabold") else "Helvetica"
                 for weight in pdf.FONT_WEIGHTS}
        self.report = pdf.SlideReport(io.BytesIO(), fonts, "3")

    def tearDown(self):
        pdf.set_language(self.previous_language)

    def check_layout(self, text, max_lines, width=220):
        row = {"ai_summary_en": text}
        layout = pdf.summary_text_layout(self.report, row, width, 8.8, max_lines)
        painted = []
        self.report.text = lambda x, y, value, *args, **kwargs: painted.append((x, y, value))
        drawn = pdf.draw_summary_text(self.report, row, 0, 500, width, 8.8, max_lines=max_lines)
        self.assertEqual(drawn, len(layout))
        self.assertEqual(drawn, pdf.summary_line_count(self.report, row, width, 8.8, max_lines))
        self.assertEqual(drawn, len({y for _, y, _ in painted}))
        self.assertLessEqual(drawn, max_lines)
        for line in layout:
            measured = sum(self.report.canvas.stringWidth(value, self.report.fonts[weight], 8.8)
                           for value, weight, _ in line)
            self.assertLessEqual(measured, width + 0.01)
        return " ".join(value for line in layout for value, _, _ in line), drawn

    def test_single_sentence_wraps_without_losing_the_end(self):
        text = ("Entered into a partnership with Medigen Vaccine Biologics to leverage NGS technologies "
                "for characterization and validation of virus seed banks in next-generation vaccine programs.")
        rendered, count = self.check_layout(text, 6)
        self.assertGreater(count, 1)
        self.assertIn("vaccine programs", rendered)
        self.assertNotIn("...", rendered)

    def test_wrapped_headline_and_detail_share_measured_line_count(self):
        self.check_layout("Research collaboration with university scientists on advanced semiconductor materials "
                          "- The partners will develop new processes for next-generation chip packaging.", 5)

    def test_one_line_budget_never_overflows(self):
        rendered, count = self.check_layout("A very long research collaboration headline requiring several lines "
                                            "- Further supporting details for the collaboration.", 1, 120)
        self.assertEqual(count, 1)
        self.assertTrue(rendered.endswith("..."))

    def test_short_headline_and_detail_keep_inline_styling(self):
        _, count = self.check_layout("New project - Research begins.", 4)
        self.assertEqual(count, 1)

    def test_item_initial_case_preserves_acronyms_and_other_languages(self):
        self.assertEqual(pdf.item_target_text({"target_technology": "silicon anode material technology"}),
                         "Silicon anode material technology")
        self.assertEqual(pdf.item_target_text({"target_technology": "robot LiDAR and GMP"}), "Robot LiDAR and GMP")
        self.assertEqual(pdf.item_target_text({"target_technology": "RF semiconductor"}), "RF semiconductor")
        self.assertEqual(pdf.item_target_text({}), "")
        pdf.set_language("ko")
        self.assertEqual(pdf.item_target_text({"target_technology": "로봇용 라이다"}), "로봇용 라이다")


if __name__ == "__main__":
    unittest.main()


class RepresentativeSignalRowTests(unittest.TestCase):
    """34546694524: Applied Materials S4.

    8월 11일 UC 버클리 EPIC 센터 공동연구가 따로 승인돼 있는데도, 8월 13일 실적
    발표문에 하이라이트로 실린 6월 16일 에실로룩소티카 계약이 대표 문안으로 나갔다.
    분기 공시는 지난 분기 사건을 다시 싣는다. 단독 발표가 있으면 그쪽이 대표다.
    """

    def row(self, title, day):
        return {
            "company": "Applied Materials", "investment_signal_no": 4, "title": title,
            "source_type": "official", "source_kind": "press_release", "is_press_release": True,
            "published_at": f"2026-08-{day}T00:00:00Z", "published_at_status": "confirmed",
            "ai_signal_supported": True, "ai_entity_supported": True,
            "ai_target_technology_supported": True, "ai_indicator_supported": True,
            "ai_leading_indicator_supported": True, "ai_event_stage": "precursor",
            "ai_summary_quality": "pass", "ai_summary_ko": "요약", "ai_summary_en": "Summary",
        }

    def test_periodic_disclosure_detection(self):
        for title in ["Applied Materials Announces Third Quarter 2026 Results",
                      "Q3 FY26 Earnings Release", "FY2026 Semiannual Report",
                      "2024 Annual Report (PDF)", "2026年12月期 第2四半期 決算短信"]:
            self.assertTrue(pdf.is_periodic_disclosure({"title": title}), title)
        for title in ["UC Berkeley to Join Applied Materials' EPIC Center to Speed Chip Innovation",
                      "National Wealth Fund backs Nexeon in £100m investment round",
                      "GUSS Automation incorporates Ouster Rev8 digital lidar sensors"]:
            self.assertFalse(pdf.is_periodic_disclosure({"title": title}), title)

    def test_standalone_announcement_represents_the_signal_cell(self):
        earnings = self.row("Applied Materials Announces Third Quarter 2026 Results", "13")
        standalone = self.row("UC Berkeley to Join Applied Materials' EPIC Center", "11")
        # 실적 공시가 더 최근이어도 단독 발표가 그 칸을 대표한다.
        index = pdf.index_investment_signals([earnings, standalone])
        self.assertEqual(index["Applied Materials"][4][0]["title"], standalone["title"])
        # 단독 발표가 없으면 실적 공시가 그대로 대표로 남는다. 칸을 비우지는 않는다.
        only = pdf.index_investment_signals([earnings])
        self.assertEqual(only["Applied Materials"][4][0]["title"], earnings["title"])

    def test_business_box_still_prefers_its_earnings_source(self):
        # 사업현황 상자는 실적 공시가 본래의 근거다. Albemarle·Nabtesco 가 그렇게 실린다.
        earnings = self.row("Albemarle Reports Second Quarter 2026 Results", "05")
        earnings["company"] = "Albemarle"
        best = pdf.best_business_row("Albemarle", [earnings], [], [])
        self.assertEqual(best["title"], earnings["title"])
