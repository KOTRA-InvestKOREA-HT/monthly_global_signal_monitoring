import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import report_content as pdf
import report_view_model as view


def approved(company, **extra):
    return {"company": company, "ai_signal_supported": True, "ai_entity_supported": True,
            "ai_indicator_supported": True, "ai_leading_indicator_supported": True, "ai_target_technology_supported": True,
            "ai_summary_quality": "pass", "ai_event_stage": "precursor", "ai_summary_ko": "문안", "source_type": "official", **extra}


class BusinessBoxTests(unittest.TestCase):
    """사업현황 상자는 위 지표 칸을 되풀이하지 않는 것을 순서대로 고르고, 비우거나 빼지 않는다.

    4호에서 기업 카드 12장 중 8장의 상자가 위 지표 칸 문안을 되풀이했다(2026-10-22 사용자 지적).
    """

    @staticmethod
    def near(company, **extra):
        row = approved(company, ai_event_stage="not_applicable", ai_signal_supported=False,
                       ai_target_technology_supported=False, ai_summary_en="Other business.")
        row.update(extra)
        return row

    def test_a_separate_target_linked_article_comes_first(self):
        signal = approved("Norsk Hydro", investment_signal_no=4, ai_summary_en="CHANEL deal.", url="https://hydro.com/a")
        same = approved("Norsk Hydro", ai_event_stage="not_applicable", ai_summary_en="CHANEL deal, again.",
                        url="https://hydro.com/a/")
        other = approved("Norsk Hydro", ai_event_stage="not_applicable", ai_summary_en="Siemens project.",
                         url="https://hydro.com/b")
        near = self.near("Norsk Hydro", url="https://hydro.com/c")
        self.assertIs(pdf.best_business_row("Norsk Hydro", [same, near, other], [signal], [signal]), other)

    def test_another_development_beats_the_same_article(self):
        signal = approved("Onsemi", investment_signal_no=4, ai_summary_en="Valens deal.", url="https://onsemi.com/a",
                          title="Valens Semiconductor and onsemi Partner on 3MP Camera")
        same = approved("Onsemi", ai_event_stage="not_applicable", ai_summary_en="Valens partnership.",
                        url="https://news.example/relay", title="Valens Semiconductor and onsemi partner on 3MP camera")
        near = self.near("Onsemi", url="https://onsemi.com/b")
        self.assertIs(pdf.best_business_row("Onsemi", [same, near], [signal], [signal]), near)
        # 다른 기사의 회사 단위 시그널 행도 다른 동향이다.
        financing = approved("Onsemi", investment_signal_no=3, ai_summary_en="Notes.", url="https://onsemi.com/c",
                             ai_target_technology_supported=False)
        self.assertIs(pdf.best_business_row("Onsemi", [same], [signal, financing], [signal]), financing)

    def test_the_same_article_with_its_own_prose_beats_a_repeat(self):
        signal = approved("Amkor Technology", investment_signal_no=2, ai_summary_en="Phase 2.", ai_summary_ko="2단계", ai_event_stage="planned",
                          url="https://amkor.com/a")
        same = approved("Amkor Technology", ai_event_stage="not_applicable", ai_summary_en="Arizona campus grows.",
                        ai_summary_ko="애리조나 캠퍼스 확장", url="https://amkor.com/a")
        self.assertIs(pdf.best_business_row("Amkor Technology", [same], [signal], [signal], exempt_company=True), same)
        # 문안까지 같으면 되풀이일 뿐이다.
        twin = dict(same, ai_summary_en="Phase 2.", ai_summary_ko="2단계")
        self.assertIs(pdf.best_business_row("Amkor Technology", [twin], [signal], [signal], exempt_company=True), signal)

    def test_box_copy_from_the_signal_article_beats_a_repeat(self):
        # box_writer.mjs 가 지표 기사 본문에서 위 문안에 없는 내용으로 따로 쓴 상자 문안.
        signal = approved("NXP", investment_signal_no=3, ai_summary_en="EIB loan.", url="https://nxp.com/a",
                          ai_box_summary_en="The loan funds the Kuala Lumpur test site.",
                          ai_box_summary_ko="대출금은 쿠알라룸푸르 테스트 공장에 쓰임.")
        row = pdf.best_business_row("NXP", [], [signal], [signal])
        self.assertEqual(row["ai_summary_en"], "The loan funds the Kuala Lumpur test site.")
        self.assertEqual(row["url"], signal["url"])
        self.assertEqual(signal["ai_summary_en"], "EIB loan.", "지표 칸 행은 그대로 둔다")
        # 다른 기사가 있으면 그것이 먼저다.
        near = self.near("NXP", url="https://nxp.com/b")
        self.assertIs(pdf.best_business_row("NXP", [near], [signal], [signal]), near)

    def test_the_box_is_never_left_empty_while_a_signal_is_shown(self):
        signal = approved("Corning", investment_signal_no=3, ai_summary_en="Equity program.", url="https://corning.com/a")
        self.assertIs(pdf.best_business_row("Corning", [], [signal], [signal]), signal)

    def test_rows_need_bilingual_prose_and_this_company(self):
        signal = approved("3M", investment_signal_no=3, url="https://3m.com/a", ai_summary_en="Financing.")
        for changes in ({"ai_summary_en": ""}, {"ai_summary_ko": ""}, {"ai_signal_supported": False}, {"company": "Other"}):
            self.assertIsNone(pdf.best_business_row("3M", [], [], [dict(signal, **changes)], exempt_company=True))
        for blank in ({"ai_summary_ko": ""}, {"ai_summary_en": ""}):
            self.assertFalse(pdf.business_near_miss(self.near("3M", **blank)), blank)

    def test_near_miss_rows_keep_the_other_approval_conditions(self):
        for field in ("ai_entity_supported", "ai_indicator_supported", "ai_leading_indicator_supported"):
            self.assertFalse(pdf.business_near_miss(self.near("Evonik Industries", **{field: False})), field)
        self.assertFalse(pdf.business_near_miss(self.near("Evonik Industries", ai_summary_quality="needs_review")))
        self.assertFalse(pdf.business_near_miss(self.near("Evonik Industries", investment_signal_no=3)))
        self.assertFalse(pdf.business_near_miss(approved("Evonik Industries", ai_event_stage="not_applicable")))
        self.assertFalse(pdf.business_near_miss(None))

    def test_a_near_miss_row_never_lights_a_matrix_cell(self):
        row = self.near("Evonik Industries", investment_signal_no=3)
        self.assertFalse(pdf.signal_supported(row))
        self.assertFalse(pdf.signal_publishable(row))
        self.assertEqual(pdf.index_investment_signals([row]), {})



class PublisherLocalDateTests(unittest.TestCase):
    """게시일은 게시처 현지 날짜로 읽는다. 보고 기간 필터와 출처 줄이 같은 날을 말해야 한다."""

    def row(self, published_at):
        return {"published_at": published_at, "published_at_source": "meta", "source": "Newsroom"}

    def test_an_offset_does_not_move_the_day_into_another_month(self):
        from datetime import date, datetime, timezone
        start = datetime(2026, 9, 1, tzinfo=timezone.utc)
        end = datetime(2026, 9, 30, tzinfo=timezone.utc)
        for value, day in (("2026-09-01T00:30:00+09:00", date(2026, 9, 1)),
                           ("2026-08-31T23:30:00-05:00", date(2026, 8, 31)),
                           ("2026-09-01T00:10:00Z", date(2026, 9, 1)),
                           ("2026-09-01T00:10:00", date(2026, 9, 1)),
                           ("2026-09-01", date(2026, 9, 1))):
            self.assertEqual(pdf.date_day(value), day, value)
            row = self.row(value)
            self.assertEqual(pdf.row_in_report_period(row, start, end), day.month == 9, value)
            pdf.set_language("ko")
            self.assertEqual(pdf.format_row_date(row), day.strftime("%Y.%m.%d"), value)


class PeriodLabelTests(unittest.TestCase):
    """보고 기간 문구는 기간이 걸친 달을 모두 적는다. 예전 국문은 시작 달만 적었다."""

    def tearDown(self):
        pdf.set_language("ko")

    def labels(self, lang, from_date, to_date):
        pdf.set_language(lang)
        summary = {"from_date": from_date, "to_date": to_date}
        return pdf.matrix_period_label(summary), pdf.report_month_label(summary)

    def test_one_calendar_month(self):
        self.assertEqual(self.labels("ko", "2026-08-01", "2026-08-31"), ("8월(2026.8.1~8.31)", "8월"))
        self.assertEqual(self.labels("en", "2026-08-01", "2026-08-31"), ("in August 2026", "August"))

    def test_a_range_across_months_names_both(self):
        self.assertEqual(self.labels("ko", "2026-08-15", "2026-09-14"), ("8~9월(2026.8.15~9.14)", "8~9월"))
        self.assertEqual(self.labels("en", "2026-08-15", "2026-09-14"),
                         ("from August 15 to September 14, 2026", "August–September"))
        self.assertEqual(self.labels("ko", "2025-12-15", "2026-01-14"), ("12~1월(2025.12.15~2026.1.14)", "12~1월"))

    def test_an_impossible_date_falls_back_to_the_previous_month_of_the_run(self):
        pdf.set_language("ko")
        start, end = pdf.report_period({"from_date": "2026-02-31", "to_date": "2026-03-10",
                                        "run_started_at": "2026-03-31T15:30:00Z"})
        self.assertEqual((start.date().isoformat(), end.date().isoformat()), ("2026-03-01", "2026-03-31"))


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
        self.assertEqual(footer, "Invest KOREA · Global Investment Signal Monitor · Issue 3")
        for gone in ("Target-Company",):
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

    def test_both_covers_carry_the_report_name_above_the_title(self):
        """국·영문 표지 모두 제목 위에 금색으로 같은 보고서 이름을 싣는다.

        영문 표지는 한때 머리말이 제목과 같은 말("INVESTMENT SIGNALS")이라 비워 두었다. 지금은 다른 말이다.
        cover_kicker() 는 t() 를 거치지 않으므로 영문 값이 비어도 국문으로 폴백하지 않는다.
        """
        _, _, ko = self.title_texts("ko")
        _, _, en = self.title_texts("en")
        self.assertEqual(ko, "G L O B A L   I N V E S T M E N T   S I G N A L   M O N I T O R")
        self.assertEqual(en, ko)
        self.assertFalse(any("가" <= ch <= "힣" for ch in en))
        # 본문 면의 머리글은 표지와 다른 자리라 그대로 남는다.
        for lang in ("ko", "en"):
            previous = pdf.LANG
            pdf.set_language(lang)
            try:
                self.assertEqual(pdf.t("detail_kicker"), "C O M P A N Y   S I G N A L S")
            finally:
                pdf.set_language(previous)

    def test_no_fixed_heading_is_copied_into_a_renderer(self):
        """표지·면 머리글은 TEXTS 한 곳에서 온다. 렌더러가 사본을 들면 문구를 고칠 때 한쪽이 남는다.

        무엇이 어느 자리에 찍히는지는 report_snapshot 이 그려진 쪽으로 고정한다.
        """
        scripts = Path(__file__).resolve().parents[1] / "scripts"
        for name in ("report_view_model.py", "report_html.mjs"):
            source = (scripts / name).read_text(encoding="utf-8")
            for heading in ("G L O B A L   I N V E S T M E N T", "S I G N A L   M A T R I X",
                            "C O M P A N Y   S I G N A L S", "K E Y   D E V E L O P M E N T S"):
                self.assertNotIn(heading, source, name)
        view = (scripts / "report_view_model.py").read_text(encoding="utf-8")
        self.assertIn('"kicker": report.cover_kicker()', view)


class LayeringTests(unittest.TestCase):
    """무엇이 실리는가(report_content)와 글자 폭을 재는 일(report_measure)의 경계."""

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
        self.assertFalse(hasattr(module, "register_fonts"))

    def test_the_reportlab_renderer_is_gone(self):
        """PDF 는 report_html.mjs 를 Chrome 이 인쇄한다. reportlab 으로 따로 그리던 렌더러는 지웠다.

        그 렌더러를 기준으로 한 스냅샷·잘림 경고는 실제 PDF 의 회귀를 하나도 막지 못했다.
        reportlab 은 report_measure 가 글리프 폭을 읽는 데만 쓴다.
        """
        scripts = Path(__file__).resolve().parents[1] / "scripts"
        self.assertFalse((scripts / "build_pdf_report.py").exists())
        measure = (scripts / "report_measure.py").read_text(encoding="utf-8")
        self.assertNotIn("reportlab.pdfgen", measure)
        self.assertNotIn("canvas", measure)

    def test_a_missing_font_cut_stops_the_measurement(self):
        """굵기 하나가 없으면 멈춘다. 예전에는 네 굵기를 모두 Regular 로 조용히 재, 굵은 제목 크기를 잘못 골랐다."""
        import tempfile
        try:
            import report_measure
        except ImportError as error:  # reportlab 이 없는 해석기
            self.skipTest(str(error))
        with tempfile.TemporaryDirectory() as folder:
            regular = Path(folder) / "PretendardJP-Regular.ttf"
            regular.write_bytes((Path(__file__).resolve().parents[1] / "assets" / "fonts" / regular.name).read_bytes())
            with self.assertRaisesRegex(FileNotFoundError, "PretendardJP-Medium.ttf"):
                report_measure.register_fonts(regular)

    def test_the_matrix_legend_names_are_the_card_labels(self):
        for lang in ("ko", "en"):
            pdf.set_language(lang)
            try:
                names = pdf.matrix_indicators().split(" · ")
                self.assertEqual(names, [f"{'①②③④⑤'[no - 1]} {pdf.signal_row_label(no)}" for no in range(1, 6)])
            finally:
                pdf.set_language("ko")

    def test_the_view_model_reads_the_language_it_set(self):
        """뷰 모델은 report_content.LANG 을 읽는다. 이름을 복사해 갔다면 언어를 바꿔도 옛 값이 남는다."""
        previous = pdf.LANG
        try:
            pdf.set_language("en")
            self.assertEqual(view.report.LANG, "en")
            self.assertEqual(view.report.cover_titles(), ["Investment Signals"])
            pdf.set_language("ko")
            self.assertEqual(view.report.cover_titles()[0], "타겟기업")
        finally:
            pdf.set_language(previous)


if __name__ == "__main__":
    unittest.main()
