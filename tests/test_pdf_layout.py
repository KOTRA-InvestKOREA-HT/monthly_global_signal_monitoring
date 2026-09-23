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
    """매트릭스는 두 상태만 말한다: AI 확인 시그널이 있거나, 신호없음이거나."""

    def setUp(self):
        self.index = {"Acme": {3: [{"x": 1}]}, "Quiet": {}, "Unknown": {}}
        self.summary = {"review_coverage": [
            {"company": "Acme", "status": "reviewed"},
            {"company": "Quiet", "status": "reviewed"},
            {"company": "Unknown", "status": "incomplete_evidence"},
        ]}

    def test_the_two_states_are_distinguished(self):
        covered = pdf.covered_companies(self.summary, [])
        self.assertEqual(pdf.company_status("Acme", self.index, covered), "detected")
        self.assertEqual(pdf.company_status("Quiet", self.index, covered), "reviewed")
        # 검토를 끝내지 못한 기업도 표에서는 신호없음과 같은 칸이다. 검토 범위 페이지가 그 수를 따로 말한다.
        self.assertEqual(pdf.company_status("Unknown", self.index, covered), "reviewed")

    def test_a_company_with_a_signal_is_detected_even_if_coverage_is_incomplete(self):
        covered = pdf.covered_companies({"review_coverage": []}, [])
        self.assertEqual(pdf.company_status("Acme", self.index, covered), "detected")

    def test_coverage_no_longer_changes_a_row_state(self):
        rows = [{"company": "Quiet", "source_type": "official"},
                {"company": "Unknown", "source_type": "fallback"}]
        covered = pdf.covered_companies({}, rows)
        self.assertEqual(pdf.company_status("Quiet", self.index, covered), "reviewed")
        self.assertEqual(pdf.company_status("Unknown", self.index, covered), "reviewed")

    def test_the_footnote_counts_are_the_row_statuses_counted(self):
        # 각주와 표가 어긋나지 않는다는 것이 상태를 행에 붙인 이유다.
        import report_view_model as vm
        profiles = [{"company": c, "target_no": i} for i, c in enumerate(self.index, 1)]
        counts = vm.matrix_counts(profiles, self.index, self.summary, [])
        covered = pdf.covered_companies(self.summary, [])
        statuses = [pdf.company_status(p["company"], self.index, covered) for p in profiles]
        self.assertEqual(counts["detected"], statuses.count("detected"))
        self.assertEqual(counts["reviewed_off"], statuses.count("reviewed"))
        self.assertEqual(counts["detected"] + counts["reviewed_off"], counts["total"])


class PublishedSignalTests(unittest.TestCase):
    def test_rows_need_both_summaries_to_fill_a_cell(self):
        # 2026-08 run: rows without prose printed raw English/Japanese article text in the Korean PDF.
        base = {"company": "A", "investment_signal_no": 2, "ai_signal_supported": True,
                "ai_entity_supported": True, "ai_indicator_supported": True,
                "ai_target_technology_supported": True, "ai_leading_indicator_supported": True,
                "ai_summary_quality": "pass", "ai_event_stage": "planned", "ai_summary_reason": "x"}
        with_prose = dict(base, title="with", ai_summary_ko="표제 - 상세", ai_summary_en="Headline - detail")
        without = dict(base, title="without", ai_summary_ko="", ai_summary_en="")
        ko_only = dict(base, title="ko only", ai_summary_ko="표제 - 상세", ai_summary_en="")
        index = pdf.index_investment_signals([without, ko_only, with_prose])
        self.assertEqual([row["title"] for row in index["A"][2]], ["with"])
        self.assertIsNone(pdf.index_investment_signals([without, ko_only]).get("A"))

    def test_an_unapproved_near_miss_row_never_fills_a_cell(self):
        """대시보드용 근접 후보는 보고서에 실리지 않는다. 승인 조건은 하나도 양보하지 않는다."""
        approved = dict(APPROVED_ROW, title="approved")
        for gap in ({"ai_target_technology_supported": False}, {"ai_leading_indicator_supported": False},
                    {"ai_summary_quality": "needs_review"}, {"ai_event_stage": "committed"}):
            near_miss = dict(approved, ai_signal_supported=False, title="near miss", **gap)
            self.assertFalse(pdf.signal_publishable(near_miss), gap)
            index = pdf.index_investment_signals([near_miss, approved])
            self.assertEqual([row["title"] for row in index["A"][2]], ["approved"], gap)
            # 승인 표시만 바꾸고 조건을 그대로 두어도 실리지 않는다.
            self.assertFalse(pdf.signal_publishable(dict(approved, **gap)), gap)


APPROVED_ROW = {"company": "A", "investment_signal_no": 2, "ai_signal_supported": True, "ai_summary_quality": "pass",
                "ai_entity_supported": True, "ai_indicator_supported": True, "ai_leading_indicator_supported": True,
                "ai_target_technology_supported": True, "ai_event_stage": "planned", "ai_summary_reason": "x",
                "ai_summary_ko": "표제 - 상세", "ai_summary_en": "Headline - detail"}
# 같은 기업의 다른 지표에 실리는 두 번째 승인 행.
SECOND_ROW = dict(APPROVED_ROW, investment_signal_no=4, ai_event_stage="precursor")


class MatrixCellStateTests(unittest.TestCase):
    """칸은 켜짐과 꺼짐 두 가지뿐이다. 실릴 수 있는 행이 있으면 켜진다."""

    def setUp(self):
        self.index = {"Mixed": {2: [APPROVED_ROW], 4: [SECOND_ROW]}, "SecondOnly": {4: [SECOND_ROW]},
                      "Both": {4: [APPROVED_ROW, SECOND_ROW]}}

    def test_every_published_row_lights_the_same_cell(self):
        self.assertEqual(pdf.signal_cell_state(self.index, "Mixed", 2), "on")
        self.assertEqual(pdf.signal_cell_state(self.index, "Mixed", 4), "on")
        self.assertEqual(pdf.signal_cell_state(self.index, "Mixed", 1), "")
        self.assertEqual(pdf.signal_cell_state(self.index, "Both", 4), "on")
        self.assertEqual(pdf.company_status("Mixed", self.index, set()), "detected")
        self.assertEqual(pdf.company_status("SecondOnly", self.index, set()), "detected")



class SentenceBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.previous_language = pdf.LANG
        pdf.set_language("ko")

    def tearDown(self):
        pdf.set_language(self.previous_language)

    def test_initials_decimals_and_abbreviations_are_not_sentence_ends(self):
        self.assertEqual(pdf.split_sentences("Michael J. Fox Foundation joined. Sales rose 23.6% at Acme Inc. in Q2. Next"),
                         ["Michael J. Fox Foundation joined.", "Sales rose 23.6% at Acme Inc. in Q2.", "Next"])
        self.assertEqual(pdf.split_sentences("出資しました。連携を強化します。"), ["出資しました。", "連携を強化します。"])

    def test_korean_phrasing_keeps_initials_and_decimals(self):
        text = pdf.phraseify_summary_text("써모 피셔 사이언티픽이 마이클 J. 폭스 재단과 협력해 매출 23.6% 증가를 기록함.")
        self.assertIn("J. 폭스", text)
        self.assertIn("23.6%", text)
        self.assertNotIn("J,", text)


class KoreanShapingTests(unittest.TestCase):
    """출력 단계는 승인된 문안을 다시 쓰지 않는다. 조사·연결어미를 지우면 문장이 깨진다."""

    def tearDown(self):
        pdf.set_language("ko")

    def test_particles_and_connective_endings_survive(self):
        for text in (
            "공급망을 강화하는 기술 협력",
            "생산능력을 확대하고 신규 설비를 도입했음",
            "Merck와 공동으로 개발하는 면역항암제 병용 연구",
            "National Wealth Fund의 5,260만 파운드 출자",
            "라이다 생산 능력을 확대하고 있으며, 런레이트를 늘릴 예정임",
            "자회사를 매각하는 동시에 지분을 취득할 예정임",
        ):
            self.assertEqual(pdf.phraseify_summary_text(text), text)

    # "협력하"+"는"을 주어와 조사로 읽으면 상대방이 사라져 행동의 주인이 달라진다.
    def test_a_relative_clause_is_not_mistaken_for_a_subject(self):
        self.assertEqual(pdf.phraseify_summary_text("오션윈즈와 협력하는 해상풍력 프로젝트"),
                         "오션윈즈와 협력하는 해상풍력 프로젝트")
        self.assertEqual(pdf.phraseify_summary_text("구축되는 신규 라인의 가동 개시"),
                         "구축되는 신규 라인의 가동 개시")

    def test_the_company_subject_the_card_already_shows_is_still_dropped(self):
        row = {"company": "Applied Materials"}
        self.assertEqual(pdf.phraseify_summary_text("Applied Materials가 EPIC Center에서 연구 협력을 체결했음", row),
                         "EPIC Center에서 연구 협력을 체결했음")
        # 회사 주어가 아닌 일반 명사 주어는 남긴다. "투자 라운드가 완료되었음"에서 주어를 떼면
        # 무엇이 완료됐는지가 사라진다.
        self.assertEqual(pdf.phraseify_summary_text("양사는 공동개발에 착수했음"), "양사는 공동개발에 착수했음")

    # 개조식은 어미 정리까지다. 문장 사이 마침표를 쉼표로 바꿔 이어 붙이지 않는다.
    def test_endings_are_tidied_but_sentences_are_not_run_together(self):
        self.assertEqual(pdf.phraseify_summary_text("신규 설비를 도입했다"), "신규 설비를 도입")
        self.assertEqual(pdf.phraseify_summary_text("라운드가 완료되었음. 자금은 상용화를 지원할 예정임."),
                         "라운드가 완료되었음. 자금은 상용화를 지원할 예정임")

    def test_the_detail_body_is_shown_as_written(self):
        text = "Broadcom Inc.와 EPIC Center 파트너십을 체결하고 EssilorLuxottica와 장기 계약을 맺었음."
        self.assertEqual(pdf.summary_detail_text(text), text)


class BusinessProseTests(unittest.TestCase):
    """2026-08 Nabtesco card printed a model headline run into the body."""

    def test_a_leading_headline_is_removed(self):
        nabtesco = ("나브테스코 - 로봇용 감속기 포함 컴포넌트 솔루션 사업 매출 증가 기록 나브테스코는 "
                    "2026년 상반기 반기보고서를 통해 매출이 증가했다고 공시함.")
        self.assertTrue(pdf.business_prose(nabtesco).startswith("나브테스코는 2026년 상반기"))
        self.assertEqual(pdf.business_prose("오우스터, 유타주 교통 현대화 사업 수주 - 에코라이트와의 파트너십을 통해 계약을 수주함."),
                         "에코라이트와의 파트너십을 통해 계약을 수주함.")
        self.assertEqual(pdf.business_prose("Ouster Secures Utah Contract - Ouster announced that Econolite won a contract."),
                         "Ouster announced that Econolite won a contract.")

    def test_prose_ranges_and_inner_dashes_are_left_alone(self):
        for text in ("레니쇼는 신제품을 출시했음. 2025 - 2026년 로드맵을 공개함.", "매출 2025 - 2026년 증가 전망", "CD-SEM 장비를 발표함."):
            self.assertEqual(pdf.business_prose(text), text)


class BusinessBoxLabelTests(unittest.TestCase):
    def tearDown(self):
        pdf.set_language("ko")

    def test_every_company_uses_the_item_target_label(self):
        pdf.set_language("ko")
        for company in ("Thermo Fisher", "Jenoptik", "Ouster"):
            label, text = pdf.target_section_for_profile({"company": company, "target_technology": "라이다"})
            self.assertEqual(label, "투자유치 필요 품목·기술")
            self.assertTrue(text)
        pdf.set_language("en")
        self.assertEqual(pdf.target_section_for_profile({"company": "Ouster", "target_technology": "LiDAR"})[0],
                         "Target product / technology")

    def test_empty_business_text_follows_the_report_style(self):
        pdf.set_language("ko")
        self.assertTrue(pdf.t("business_empty").endswith("않음."))


class SummarySplitTests(unittest.TestCase):
    """2026-08 English edition: a long first clause became a headline cut off with "..."."""

    def tearDown(self):
        pdf.set_language("ko")

    def test_a_long_first_clause_is_not_cut_into_a_headline(self):
        pdf.set_language("en")
        text = ("Applied Materials completed the expansion of its manufacturing and R&D operations in Singapore with the "
                "new $500 million Tampines Campus, more than doubling its advanced cleanroom capacity to support the "
                "global build-out of AI infrastructure.")
        parts = pdf.summary_parts({"ai_summary_en": text})
        self.assertNotIn("...", parts["headline"] + parts["detail"])
        self.assertIn("Tampines Campus", parts["headline"] + parts["detail"])

    # 영문 문안은 이제 ` - ` 표제 없이 평서문으로 온다(docs/local_report_review.md "문안").
    # 한국어 표제를 명사구로 옮기던 형식이 콩글리시의 출처였다. 카드의 첫 줄은 여기서 떼어 낸다.
    def test_english_prose_without_a_headline_keeps_every_sentence(self):
        pdf.set_language("en")
        text = ("Boeing agreed to transfer Wisk Aero to Archer. The companies will share technology under the "
                "agreement, which Boeing expects to close in 2027.")
        parts = pdf.summary_parts({"ai_summary_en": text})
        self.assertEqual(parts["headline"], "Boeing agreed to transfer Wisk Aero to Archer.")
        self.assertIn("close in 2027", parts["detail"])
        self.assertNotIn("...", parts["headline"] + parts["detail"])

    def test_a_short_first_clause_still_becomes_the_headline(self):
        pdf.set_language("en")
        parts = pdf.summary_parts({"ai_summary_en": "Executive leadership changes announced - Evonik appointed Claus Rettig interim CEO."})
        self.assertEqual(parts["headline"], "Executive leadership changes announced")
        self.assertTrue(parts["detail"].startswith("Evonik appointed"))


class SourceLinkTests(unittest.TestCase):
    def tearDown(self):
        pdf.set_language("ko")

    def test_source_url_prefers_the_publisher_over_a_news_relay(self):
        relay = {"url": "https://news.google.com/rss/articles/x", "source_direct_url": "https://www.example.com/news/a"}
        self.assertEqual(pdf.source_url(relay), "https://www.example.com/news/a")
        self.assertEqual(pdf.source_url({"url": "https://news.google.com/rss/articles/x"}), "https://news.google.com/rss/articles/x")
        self.assertEqual(pdf.source_url({"url": "not a url"}), "")

    def test_display_name_corrects_the_label_but_keeps_the_key(self):
        pdf.set_language("ko")
        profiles = pdf.build_profiles([{"target_no": 1, "company": "Australian Strategic Metals",
                                        "display_name": "Australian Strategic Materials"}], {"companies": []})
        self.assertEqual(profiles[0]["company"], "Australian Strategic Metals")
        self.assertEqual(profiles[0]["display_name"], "Australian Strategic Materials")


class SummaryDetailProseTests(unittest.TestCase):
    """2026-08 report (run on 2026-09-14): detail sentences were compressed like headlines."""

    def tearDown(self):
        pdf.set_language("ko")

    def test_korean_detail_keeps_its_connectives_and_subject(self):
        pdf.set_language("ko")
        parts = pdf.summary_parts({"ai_summary_ko": "mRNA 암 백신 공동 개발 및 병용 연구 추진 - 모더나와 머크가 환자 맞춤형 "
                                                    "mRNA 기반 암 백신 인티스메란을 개발하고 면역항암제 키트루다와 병용하는 연구를 공동으로 진행함"})
        self.assertEqual(parts["headline"], "mRNA 암 백신 공동 개발 및 병용 연구 추진")
        self.assertIn("모더나와 머크가", parts["detail"])
        self.assertIn("개발하고", parts["detail"])
        self.assertIn("병용하는", parts["detail"])

    def test_a_leading_name_before_a_comma_is_not_a_headline(self):
        pdf.set_language("en")
        text = ("GUSS Automation, a wholly owned subsidiary of John Deere, plans to incorporate Ouster's Rev8 digital "
                "lidar sensors into the next generation of its autonomous orchard machine fleet.")
        parts = pdf.summary_parts({"ai_summary_en": text})
        self.assertEqual(parts["headline"], text)
        self.assertEqual(parts["detail"], "")
