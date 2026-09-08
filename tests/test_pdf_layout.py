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
