import io
import re
import sys
import unittest
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

import pdfplumber

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import extract_pdf_text as extractor


LEFT = ("Vestas issued a bond maturing in 2033 and used",
        "the proceeds to repay the existing bond which",
        "matured in the second quarter, leaving the net",
        "interest bearing debt ratio unchanged over the",
        "period and within the targeted range.")
RIGHT = ("The expansion of the Gifu Plant has already",
         "been completed based on the assumption that",
         "the production rate would increase, so there",
         "is sufficient space to expand capacity in line",
         "with the launch scheduled for 2027.")


def flat(text):
    return re.sub(r"\s+", " ", text).strip()


def read(build):
    """Render a page with `build`, then read it back the way the collector does."""
    buffer = io.BytesIO()
    page = canvas.Canvas(buffer, pagesize=A4)
    page.setFont("Helvetica", 10)
    build(page)
    page.save()
    buffer.seek(0)
    with pdfplumber.open(buffer) as pdf:
        return pdf.pages[0], extractor.page_text(pdf.pages[0])


def two_columns(page, top=700, left_x=50, right_x=320):
    for index, (left, right) in enumerate(zip(LEFT, RIGHT)):
        page.drawString(left_x, top - index * 14, left)
        page.drawString(right_x, top - index * 14, right)


class ColumnOrderTests(unittest.TestCase):
    def test_each_column_is_read_before_the_next_one_starts(self):
        _, text = read(two_columns)
        self.assertIn(flat(" ".join(LEFT)), flat(text))
        self.assertIn(flat(" ".join(RIGHT)), flat(text))

    def test_a_heading_spanning_both_columns_does_not_hide_the_gutter(self):
        def build(page):
            page.drawString(50, 740, "Interim report for the second quarter of the current financial year")
            two_columns(page)

        _, text = read(build)
        self.assertIn(flat(" ".join(LEFT)), flat(text))
        self.assertIn(flat(" ".join(RIGHT)), flat(text))
        self.assertIn("Interim report for the second quarter", flat(text))

    def test_a_narrow_gutter_still_separates_dense_table_columns(self):
        # A results-briefing Q&A sets its columns closer together than the width
        # of the spaces inside its own justified answers.
        _, text = read(lambda page: two_columns(page, right_x=290))
        self.assertIn(flat(" ".join(RIGHT)), flat(text))

    def test_single_column_prose_is_never_split(self):
        def build(page):
            for index, line in enumerate(LEFT + RIGHT):
                # Wide, uneven word spacing, as justified text produces.
                x = 50
                for word in line.split():
                    page.drawString(x, 700 - index * 14, word)
                    x += page.stringWidth(word, "Helvetica", 10) + 9

        _, text = read(build)
        self.assertIn(flat(" ".join(LEFT + RIGHT)), flat(text))

    def test_reordering_neither_loses_nor_repeats_a_word(self):
        for name, build in (("columns", two_columns),
                            ("heading", lambda page: (page.drawString(50, 740, "A" * 60), two_columns(page)))):
            with self.subTest(page=name):
                page, text = read(build)
                words = [word["text"] for word in page.extract_words(use_text_flow=False, keep_blank_chars=False)]
                self.assertEqual(sorted(words), sorted(text.split()))


if __name__ == "__main__":
    unittest.main()
