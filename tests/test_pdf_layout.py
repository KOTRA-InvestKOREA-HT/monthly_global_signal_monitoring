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


class SourceLineTests(unittest.TestCase):
    """34564332764 영문판 9쪽 Renishaw.

    출처 경로가 길어 120자에서 잘리면서 "...laser enco..." 로 단어 중간이 끊기고
    발행일이 통째로 사라졌다. 재검증에 제일 필요한 것이 날짜인데 날짜부터 버렸다.
    """

    def setUp(self):
        pdf.LANG = "en"

    def tearDown(self):
        pdf.LANG = "ko"

    def row(self, source):
        return {"source": source, "published_at": "2026-08-20T00:00:00Z",
                "published_at_status": "confirmed", "source_kind": "news"}

    def test_a_long_source_path_keeps_its_date(self):
        long_source = ("Renishaw - Latest News / Newsroom / News RSS: Renishaw launches "
                       "next-generation RLE interferometric laser encoder systems")
        line = pdf.source_line(self.row(long_source))
        self.assertLessEqual(len(line), pdf.SOURCE_LINE_LIMIT)
        self.assertTrue(line.endswith("2026.08.20"), line)
        self.assertIn("...", line)
        # 잘린 자리가 낱말 경계인지 원문과 대조한다. 남은 앞부분이 원문의 접두사이고,
        # 원문에서 그 다음 글자가 공백이어야 낱말이 온전히 끝난 것이다.
        kept = line[len("Source  "):line.index("...")]
        self.assertTrue(long_source.startswith(kept), kept)
        self.assertTrue(long_source[len(kept)].isspace(), repr(long_source[len(kept) - 3:len(kept) + 3]))

    def test_a_short_source_is_left_alone(self):
        line = pdf.source_line(self.row("Albemarle - Newsroom / News"))
        self.assertEqual(line, "Source  Albemarle - Newsroom / News 2026.08.20")
        self.assertNotIn("...", line)

    def test_korean_without_spaces_is_not_emptied_by_the_word_rollback(self):
        # 공백이 거의 없는 문장까지 낱말 경계로 되돌리면 통째로 사라진다.
        text = "가" * 200
        self.assertEqual(len(pdf.short_text(text, 50)), 50)


class ItemPageBalanceTests(unittest.TestCase):
    """34564332764 영문판: 품목 카드 4장이 3+1 로 갈려 마지막 쪽의 70%가 비었다.

    build_html_report.mjs 의 itemBreaks 와 같은 규칙이어야 한다. 정적 PDF 는 HTML 로,
    시그널 제외·기간 변경 PDF 는 여기로 만들어지므로 둘이 갈라지면 디자인이 어긋난다.
    """

    def sizes(self, heights):
        return pdf._item_sheet_sizes(len(heights), pdf.item_breaks(heights))

    def test_a_lone_last_card_is_evened_out(self):
        room = pdf.ITEM_SECTION_FIRST_TOP - pdf.ITEM_SECTION_BOTTOM
        height = (room - pdf.ITEM_CARD_GAP * 2) / 3  # 한 장에 셋까지
        self.assertEqual(self.sizes([height] * 4), [2, 2])
        for count in (4, 5, 6):
            sizes = self.sizes([height] * count)
            self.assertLessEqual(max(sizes) - min(sizes), 1, f"{count} cards -> {sizes}")

    def test_page_count_never_grows_and_no_sheet_overflows(self):
        room = pdf.ITEM_SECTION_FIRST_TOP - pdf.ITEM_SECTION_BOTTOM
        height = (room - pdf.ITEM_CARD_GAP * 2) / 3
        for count in range(1, 9):
            heights = [height] * count
            balanced = pdf.item_breaks(heights)
            self.assertEqual(len(balanced), len(pdf.greedy_item_breaks(heights)))
            self.assertTrue(pdf._item_plan_fits(heights, balanced), f"{count} overflows")

    def test_an_oversized_card_keeps_its_own_sheet(self):
        room = pdf.ITEM_SECTION_FIRST_TOP - pdf.ITEM_SECTION_BOTTOM
        self.assertEqual(pdf.item_breaks([room + 200]), [])
        # 큰 카드 하나 뒤에 작은 것 셋. 큰 것을 옮기면 들어가지 않으므로 greedy 가 남는다.
        self.assertEqual(pdf.item_breaks([room - pdf.ITEM_CARD_GAP, 40, 40, 40]), [1])


class MatrixStatusTests(unittest.TestCase):
    """34546694524 2쪽: 각주는 포착·검토함·근거부족 셋을 숫자로 말하는데 표의 꺼진 칸은
    한 가지 모양이라, 77개사 중 어느 59개사를 다시 뒤져야 하는지 읽을 수 없었다."""

    def setUp(self):
        self.index = {"Acme": {3: [{"x": 1}]}, "Quiet": {}, "Unknown": {}}
        self.summary = {"review_coverage": [
            {"company": "Acme", "status": "reviewed"},
            {"company": "Quiet", "status": "reviewed"},
            {"company": "Unknown", "status": "incomplete_evidence"},
        ]}

    def test_the_three_states_are_distinguished(self):
        covered = pdf.covered_companies(self.summary, [])
        self.assertEqual(pdf.company_status("Acme", self.index, covered), "detected")
        self.assertEqual(pdf.company_status("Quiet", self.index, covered), "reviewed")
        # 검토를 끝내지 못한 기업은 "신호 없음"이 아니라 "모름"이다.
        self.assertEqual(pdf.company_status("Unknown", self.index, covered), "insufficient")

    def test_a_company_with_a_signal_is_detected_even_if_coverage_is_incomplete(self):
        covered = pdf.covered_companies({"review_coverage": []}, [])
        self.assertEqual(pdf.company_status("Acme", self.index, covered), "detected")

    def test_without_coverage_the_official_source_decides(self):
        rows = [{"company": "Quiet", "source_type": "official"},
                {"company": "Unknown", "source_type": "fallback"}]
        covered = pdf.covered_companies({}, rows)
        self.assertEqual(pdf.company_status("Quiet", self.index, covered), "reviewed")
        self.assertEqual(pdf.company_status("Unknown", self.index, covered), "insufficient")

    def test_the_footnote_counts_are_the_row_statuses_counted(self):
        # 각주와 표가 어긋나지 않는다는 것이 상태를 행에 붙인 이유다.
        import report_view_model as vm
        profiles = [{"company": c, "target_no": i} for i, c in enumerate(self.index, 1)]
        counts = vm.matrix_counts(profiles, self.index, self.summary, [])
        covered = pdf.covered_companies(self.summary, [])
        statuses = [pdf.company_status(p["company"], self.index, covered) for p in profiles]
        self.assertEqual(counts["detected"], statuses.count("detected"))
        self.assertEqual(counts["reviewed_off"], statuses.count("reviewed"))
        self.assertEqual(counts["insufficient"], statuses.count("insufficient"))
        self.assertEqual(sum(counts[k] for k in ("detected", "reviewed_off", "insufficient")), counts["total"])
