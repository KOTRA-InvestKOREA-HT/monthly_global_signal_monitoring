"""사업현황 상자에 기사를 세 건까지 싣는 규칙(2026-10-26 사용자 결정)을 지킨다.

"사업동향 박스 기사 여러개인거 있잖아 … 한 3개까지 넣어보면 안되냐 1. 2. 3. 이렇게 나눠서"
- 고르기: 2026-10-25 의 세 순위(report_content.best_business_row)를 차례로 채워 세 건까지. 고른 기사끼리 같은 기사·같은 사건이면 뺀다.
  두 번째부터는 국·영문 문안이 다 있어야 한다. 사람이 비운 상자는 그대로 비운다.
- 순서: 게시일이 늦은 기사부터. 날짜가 같으면 고른 순서.
- 찍기: 한 건이면 예전 상자 그대로(번호 없음). 두세 건이면 "1." "2." "3."과 항목마다 출처 줄.
- 자리: 한·영 두 판 모두 쪽에 들어가는 건수만. 들어가지 않으면 우선순위가 낮은 기사부터 통째로 뺀다.
"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import report_content as content  # noqa: E402

try:
    import report_measure  # noqa: E402
    import report_view_model as view  # noqa: E402
except ModuleNotFoundError:  # reportlab 이 없는 로컬 환경. CI 에는 있다.
    report_measure = view = None

FONT = ROOT / "assets" / "fonts" / "PretendardJP-Regular.ttf"
SEPTEMBER = {"from_date": "2026-09-01", "to_date": "2026-09-30"}


def approved(company, **extra):
    return {"company": company, "ai_signal_supported": True, "ai_entity_supported": True,
            "ai_indicator_supported": True, "ai_leading_indicator_supported": True, "ai_target_technology_supported": True,
            "ai_summary_quality": "pass", "ai_event_stage": "not_applicable", "source_type": "official",
            "source": "Media", **extra}


def article(company, key, day, en, ko=None, **extra):
    row = approved(company, url=f"https://news.example/{key}", title=f"{company} article about {key} developments",
                   published_at=f"2026-09-{day:02d}", ai_summary_en=en, ai_summary_ko=ko or f"{key} 국문 문안.")
    row.update(extra)
    return row


# 서로 다른 사건. 낱말이 거의 겹치지 않는다.
DISTINCT = {
    "radar": "The company launched a new automotive radar chip for driver assistance.",
    "plant": "A second wafer fabrication plant opened near Dresden with local hiring.",
    "lidar": "Customers ordered more lidar sensors for warehouse robots this quarter.",
    "award": "An industry group gave the battery separator line its yearly quality award.",
}


class BusinessRowSelectionTests(unittest.TestCase):
    def setUp(self):
        self.signal = approved("Acme", investment_signal_no=3, ai_event_stage="precursor", url="https://acme.example/signal",
                               title="Acme signs equity financing program", published_at="2026-09-03",
                               ai_summary_en="Acme signed an equity financing program with Bank Nine.",
                               ai_summary_ko="Acme 가 Bank Nine 과 지분 금융 계약을 맺음.")

    def rows(self, *days):
        return [article("Acme", key, day, DISTINCT[key]) for key, day in zip(DISTINCT, days)]

    def test_three_distinct_articles_at_most_in_tier_and_sort_order(self):
        radar, plant, lidar, award = self.rows(5, 20, 12, 1)
        chosen = content.business_rows("Acme", [radar, plant, lidar, award], [self.signal], [self.signal])
        # 같은 순위 안에서는 sort_signal_rows 순서(여기서는 공식 출처끼리라 늦은 기사 먼저). 네 번째는 싣지 않는다.
        self.assertEqual(chosen, [plant, lidar, radar])
        self.assertIs(content.best_business_row("Acme", [radar, plant, lidar, award], [self.signal], [self.signal]), plant)
        self.assertEqual(len(content.business_rows("Acme", [radar, plant, lidar, award], [], [], limit=2)), 2)

    def test_the_second_tier_fills_what_the_first_leaves(self):
        radar, plant = self.rows(5, 20)[:2]
        # 위 지표 칸과 같은 기사지만 더 자세한 행(2순위)
        retold = article("Acme", "signal-detail", 4, "Bank Nine will fund a coating line in Ohio for optical glass.",
                         url="https://acme.example/signal")
        chosen = content.business_rows("Acme", [retold, radar, plant], [self.signal], [self.signal])
        self.assertEqual(chosen, [plant, radar, retold])
        # 3순위(지표 기사에서 따로 쓴 상자 문안)는 1·2순위로 세 건이 차면 들어오지 않는다.
        boxed = dict(self.signal, ai_box_summary_en="The financing pays for a pilot line in Busan.",
                     ai_box_summary_ko="자금은 부산 시험 라인에 쓰임.")
        lidar = self.rows(5, 20, 12)[2]
        self.assertEqual(content.business_rows("Acme", [radar, plant, lidar], [boxed], [boxed]), [plant, lidar, radar])
        third = content.business_rows("Acme", [radar], [boxed], [boxed])
        self.assertEqual([row["ai_summary_en"] for row in third], [radar["ai_summary_en"], boxed["ai_box_summary_en"]])

    def test_the_same_article_or_event_is_chosen_once(self):
        radar, plant, lidar = self.rows(5, 20, 12)[:3]
        # 같은 기사가 사업동향 행과 투자 시그널 행으로 두 번 들어온다(4호 Norsk Hydro).
        plant_signal = dict(plant, investment_signal_no=2, ai_event_stage="precursor")
        # 다른 매체가 같은 사건을 쓴 기사(4호 Applied Materials 의 A*STAR 공동연구실 확장, CRN Asia·Tech Wire Asia).
        crn = article("Applied Materials", "crn", 28, "Applied Materials is expanding its advanced packaging joint laboratory "
                      "with Singapore's Agency for Science, Technology and Research (A*STAR), building on five years of "
                      "collaborative R&D projects.")
        wire = article("Applied Materials", "wire", 25, "Applied Materials will expand its advanced packaging joint laboratory "
                       "with A*STAR under Phase 4 of the partnership in Singapore. The expansion will significantly increase "
                       "infrastructure, equipment, and headcount to support deeper research into advanced packaging for "
                       "artificial intelligence and advanced computing.")
        self.assertFalse(content.same_event_as_signal(wire, [crn], "Applied Materials"), "위 칸 잣대만으로는 못 거른다")
        self.assertTrue(content.same_event_as_item(wire, [crn], "Applied Materials"))
        self.assertEqual(content.business_rows("Acme", [plant, radar], [plant_signal], [self.signal]), [plant, radar])
        other = article("Applied Materials", "hbm", 1, "Applied Materials offers a hybrid bonding portfolio including the "
                        "Kinex cluster system for next-generation memory stacks.")
        self.assertEqual(content.business_rows("Applied Materials", [crn, wire, other], [], [], exempt_company=True),
                         [crn, other])
        # 금액 표기가 달라도("$12 billion"·"$12bn") 같은 사건이다(4호 Amkor 의 Peoria 투자 확대).
        abc = article("Amkor", "abc", 10, "Amkor is increasing its investment in its Peoria advanced packaging and test "
                      "facility from $7 billion to $12 billion to support the second phase of construction.")
        clean = article("Amkor", "clean", 10, "Amkor is expanding its planned investment in a new advanced semiconductor "
                        "packaging and test campus in Arizona to approximately $12bn as customer commitments drive a second phase.")
        self.assertTrue(content.same_event_as_item(clean, [abc], "Amkor"))
        # 제품 이름 하나만 같은 다른 사건은 둘 다 싣는다(4호 Ouster 의 Rev8 고객 확대와 INTERGEO 전시).
        momentum = article("Ouster", "momentum", 14, "Ouster announced strong customer momentum for its Rev8 OS1 Max native "
                           "color digital lidar, as payload integrators and drone OEMs across the aerial mapping market "
                           "select the sensor for utility corridor inspection, infrastructure management, and defense applications.")
        show = article("Ouster", "intergeo", 9, "Ouster and Flyability will showcase their long-standing technology "
                       "collaboration at INTERGEO 2026 in Munich, Germany, from September 15 to 17. Building on five years "
                       "of joint innovation, Flyability is evaluating Ouster's new REV8 digital lidar to unlock native color "
                       "3D mapping in hazardous and GPS-denied industrial environments.")
        self.assertFalse(content.same_event_as_item(show, [momentum], "Ouster"))

    def test_later_articles_need_copy_in_both_languages(self):
        radar, plant, lidar = self.rows(5, 20, 12)[:3]
        no_english = dict(plant, ai_summary_en="")
        no_korean = dict(lidar, ai_summary_ko="")
        self.assertEqual(content.business_rows("Acme", [no_english, no_korean, radar], [], [], exempt_company=True), [radar])
        # 첫 항목은 예전 한 건짜리 상자와 똑같이 고른다.
        self.assertIs(content.business_rows("Acme", [no_english], [], [], exempt_company=True)[0], no_english)

    def test_the_box_lists_the_newest_article_first(self):
        radar, plant, lidar = self.rows(5, 20, 12)[:3]
        tie = article("Acme", "tie", 12, "Tie.")
        month_only = article("Acme", "month", 1, "Month only.", published_at="2026-09")
        ordered = content.business_display_order([radar, lidar, plant, month_only, tie])
        # 같은 날(12일)은 고른 순서, 달만 확정된 기사는 그 달 1일로 놓여 맨 뒤.
        self.assertEqual(ordered, [plant, lidar, tie, radar, month_only])


class RepeatedSentenceTests(unittest.TestCase):
    """위 칸(또는 먼저 고른 상자 항목)을 되풀이하는 문장이 하나라도 있는 상자 문안은 싣지 않는다(2026-10-26 사용자 결정).

    처음에는 그 문장만 빼고 나머지를 실었으나, 앞 문장이 빠진 상자가 맥락 없이 시작해 어색했다. 문장을 자르지 않는다.
    """

    # 4호 p23 Safran: 문안 전체는 위 칸과 0.51 이라 2순위를 통과했지만 첫 문장은 0.82 겹친다.
    SAFRAN_SIGNAL = ("Safran Electrical & Power is preparing to ramp up production of its EngineUS 100 electric motor family "
                     "by moving to highly automated factories in Lyon.")
    SAFRAN_EN = ("Safran Electrical & Power is preparing to ramp up production of its EngineUS 100 electric motor family "
                 "through a transition to highly automated factories. The EngineUS motor received certification in 2025 to "
                 "address the emerging market for light and small regional electric and hybrid-electric aircraft.")
    SAFRAN_KO = ("Safran Electrical & Power는고도 자동화 공장을 통해 EngineUS 100 전기 모터 제품군 생산을 확대할 예정임. "
                 "EngineUS는 소형 및 지역 항공기 부문의 전기 및 하이브리드 전기 항공기 신흥 시장을 겨냥해 2025년에 인증을 받았음.")

    def safran(self, **extra):
        signal = approved("Safran", investment_signal_no=2, ai_event_stage="planned", url="https://aviationweek.example/a",
                          title="Safran Gears Up For Automated EngineUS Electric Motor Production", published_at="2026-09-03",
                          ai_summary_en=self.SAFRAN_SIGNAL, ai_summary_ko="Safran 은 리옹 자동화 공장으로 EngineUS 100 양산을 늘림.")
        # 같은 기사로 판정한 사업동향 행(2순위).
        box = approved("Safran", url="https://aviationweek.example/a", title=signal["title"], published_at="2026-09-03",
                       **{"ai_summary_en": self.SAFRAN_EN, "ai_summary_ko": self.SAFRAN_KO, **extra})
        return signal, box

    def test_safran_box_that_repeats_its_first_sentence_is_dropped(self):
        signal, box = self.safran()
        self.assertTrue(content.repeats_said(box, [signal]))
        self.assertIsNone(content.best_business_row("Safran", [box], [signal], [signal]))
        self.assertEqual(box["ai_summary_en"], self.SAFRAN_EN, "원래 행은 그대로 둔다")

    def test_merck_box_that_repeats_the_investment_sentence_is_dropped(self):
        # 4호 p20 Merck: 첫 문장(벵갈루루 1,300만 유로 투자)이 지표 1 칸을 되풀이했다(0.72, 전체 0.47). 남은 둘째 문장만 실으면
        # "해당 Jigani 사업장은…"으로 맥락 없이 시작한다.
        signal = approved("Merck", investment_signal_no=1, ai_event_stage="precursor", url="https://bioprocess.example/a",
                          title="Merck KGaA expands life science manufacturing hub in Bengaluru", published_at="2026-09-18",
                          ai_summary_en="Merck KGaA will invest €13 million (about US$15 million) to expand its manufacturing "
                                        "facility in Bengaluru, India, to strengthen production and supply operations in the "
                                        "Asia-Pacific region and expand biology and chemistry capabilities.")
        box = approved("Merck", url=signal["url"], title=signal["title"], published_at="2026-09-18",
                       ai_summary_en="Merck KGaA announced an expansion of its manufacturing facility in Bengaluru, India, "
                                     "investing €13 million (about US$15 million) in its Jigani site to expand biology and "
                                     "chemistry capabilities. The Jigani site will manufacture biological buffers and raw "
                                     "materials for diagnostic applications used in DNA research, cell culture, diagnostics, "
                                     "and drug manufacturing.",
                       ai_summary_ko="Merck KGaA는 인도 Bengaluru 제조 시설에 1,300만 유로(약 1,500만 달러)를 투자하여 생물학 및 "
                                     "화학 역량을 확장할 예정임. 해당 Jigani 사업장은 DNA 연구, 세포 배양, 진단 및 의약품 제조에 "
                                     "사용되는 진단용 응용 프로그램의 생물학적 완충제와 원료를 제조할 예정임.")
        self.assertIsNone(content.best_business_row("Merck", [box], [signal], [signal]))

    def test_the_same_article_with_only_new_content_is_kept(self):
        # 4호 Cytiva: 위 칸(WhiteLab Genomics 협력)과 같은 기사지만 상자 문안(ÄKTA readyflux 공개)은 되풀이하지 않는다.
        signal = approved("Cytiva", investment_signal_no=4, ai_event_stage="precursor", url="https://mchem.example/a",
                          title="The path toward autonomous biopharma manufacturing", published_at="2026-09-21",
                          ai_summary_en="Cytiva partnered with WhiteLab Genomics to use AI to accelerate cell line development "
                                        "for AAV gene therapies and shorten timelines to clinical entry.")
        box = approved("Cytiva", url=signal["url"], title=signal["title"], published_at="2026-09-21",
                       ai_summary_en="Cytiva unveiled its new ÄKTA readyflux system for small-batch drug production. The "
                                     "single-use platform is designed to simplify technology transfer, improve consistency and "
                                     "cut downtime.",
                       ai_summary_ko="Cytiva는 소량 의약품 생산을 위한 새로운 ÄKTA readyflux 시스템을 공개했음.")
        self.assertFalse(content.repeats_said(box, [signal]))
        self.assertIs(content.best_business_row("Cytiva", [box], [signal], [signal]), box)

    def test_a_row_with_nothing_repeated_is_returned_untouched(self):
        signal, _ = self.safran()
        other = article("Safran", "propulsion", 15, "EDGE and Safran will build sovereign missile propulsion systems in Brazil.")
        self.assertFalse(content.repeats_said(other, [signal]))
        self.assertIs(content.best_business_row("Safran", [other], [signal], [signal]), other)

    def test_a_later_item_that_repeats_an_earlier_item_is_dropped(self):
        # 다른 기사이고 다른 사건이어도, 먼저 고른 항목을 되풀이하는 문장이 있으면 싣지 않는다.
        first = article("Acme", "plant", 20, "A second wafer fabrication plant opened with local hiring. The plant makes "
                        "silicon carbide power wafers for electric vehicle inverters and will ship samples to carmakers soon.",
                        ko="두 번째 웨이퍼 공장이 문을 열고 지역 인력을 채용함. 공장은 전기차 인버터용 탄화규소 웨이퍼를 만듦.")
        later = article("Acme", "award", 5, "A second wafer fabrication plant opened with local hiring. An industry group "
                        "gave the battery separator line its yearly quality award for low defect rates, safe handling of "
                        "solvents and steady output across three shifts.",
                        ko="두 번째 웨이퍼 공장이 문을 열었음. 업계 단체가 분리막 라인에 올해의 품질상을 줌.")
        self.assertFalse(content.same_event_as_item(later, [first], "Acme"))
        self.assertEqual(content.business_rows("Acme", [first, later], [], [], exempt_company=True), [first])

    def test_a_different_article_about_the_same_event_with_a_repeated_sentence_is_dropped(self):
        # 4호 Nexeon: BusinessCloud 기사는 위 칸(Charged EVs·Solar Power Portal)과 같은 투자 유치 기사이고, NWF 문장이 위 칸을
        # 되풀이한다(0.75). 문장을 빼고 싣던 동안에는 회사 소개 한 문장만 남아 세 번째 항목으로 실렸다.
        charged = approved("Nexeon", investment_signal_no=3, ai_event_stage="precursor", url="https://chargedevs.example/a",
                           title="Nexeon raises £100 million to expand its UK silicon anode operations", published_at="2026-09-09",
                           ai_summary_en="Nexeon closed a £100-million ($133-million) investment round, including a £52.6-million "
                                         "($70-million) commitment from the UK’s National Wealth Fund and participation from new "
                                         "investors The Korea Development Bank and Honda Xcelerator Ventures, to fund a UK-based "
                                         "pilot manufacturing facility, R&D work, and an expansion of its advanced manufacturing "
                                         "technology unit.")
        solar = approved("Nexeon", investment_signal_no=2, ai_event_stage="planned", url="https://solarpowerportal.example/b",
                         title="National Wealth Fund backs Nexeon’s sodium battery tech with £53 million", published_at="2026-09-02",
                         ai_summary_en="Nexeon will use the investment funds for a pilot manufacturing facility in the UK and "
                                       "ongoing research and development efforts.")
        business_cloud = article("Nexeon", "businesscloud", 2,
                                 "Nexeon, headquartered in Abingdon near Oxford, is developing silicon anode materials to enable "
                                 "higher energy density lithium-ion batteries, helping reduce charging times and extend electric "
                                 "vehicle range. The National Wealth Fund's financing will support the company's development of a "
                                 "UK-based pilot manufacturing facility, research and development activities, and the expansion of "
                                 "its advanced manufacturing technology unit.",
                                 ko="옥스퍼드 인근 Abingdon에 본사를 둔 Nexeon은 전기차의 충전 시간을 줄이고 주행 거리를 늘리는 "
                                    "고에너지 밀도 리튬이온 배터리 생산을 가능하게 하는 실리콘 음극재 소재를 개발하고 있음. National "
                                    "Wealth Fund의 자금 지원은 영국 내 파일럿 제조 시설 구축, 연구개발 활동 및 첨단 제조 기술 부문 "
                                    "확장을 지원할 예정임.",
                                 title="Nexeon raises £100m as National Wealth Fund invests - BusinessCloud")
        shown = [charged, solar]
        self.assertTrue(content.same_event_as_signal(business_cloud, shown, "Nexeon"))
        self.assertTrue(content.repeats_said(business_cloud, shown))
        gunsan = article("Nexeon", "oxfordmail", 2, "Nexeon's facility in Gunsan, South Korea, has been awarded ISO 9001:2015 "
                         "certification.", ko="Nexeon 의 군산 공장이 ISO 9001:2015 인증을 받음.")
        self.assertEqual(content.business_rows("Nexeon", [gunsan, business_cloud], [], shown), [gunsan])
        self.assertIsNone(content.best_business_row("Nexeon", [business_cloud], [], shown))

    def test_a_repeating_row_is_dropped_even_after_another_item(self):
        signal, box = self.safran()
        other = article("Safran", "propulsion", 15, "EDGE and Safran will build sovereign missile propulsion systems in Brazil.",
                        ko="EDGE 와 Safran 이 브라질에서 미사일 추진 체계를 만듦.")
        self.assertEqual(content.business_rows("Safran", [other, box], [signal], [signal]), [other])


@unittest.skipIf(view is None, "reportlab is not installed")
class BusinessBoxViewModelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.measure = report_measure.Measure(str(FONT))

    def tearDown(self):
        content.set_language("ko")

    def profile(self, company, lang="ko"):
        return {"company": company, "display_name": company, "country": "미국", "detailed_industry": "반도체",
                "target_technology": "Glass" if lang == "en" else "유리", "exempt_from_relevance": False}

    def entries(self, company, signals, relevant, summary=None, lang="ko"):
        content.set_language(lang)
        index = {company: {no: [row] for no, row in signals.items()}}
        profiles_by_lang = {code: {company: self.profile(company, code)} for code in ("ko", "en")}
        return view.detail_entries([self.profile(company, lang)], index, relevant, [], self.measure,
                                   summary, profiles_by_lang)

    def signal(self, company, no=3, en="Signed an equity program with Bank Nine.", ko="Bank Nine 과 지분 금융 계약."):
        return approved(company, investment_signal_no=no, ai_event_stage="precursor", url=f"https://acme.example/s{no}",
                        title=f"{company} indicator {no} announcement title", published_at="2026-09-03",
                        ai_summary_en=en, ai_summary_ko=ko)

    def test_one_article_is_printed_as_before_and_several_are_numbered_newest_first(self):
        radar = article("Acme", "radar", 5, DISTINCT["radar"])
        plant = article("Acme", "plant", 20, DISTINCT["plant"])
        lidar = article("Acme", "lidar", 12, DISTINCT["lidar"])
        for lang in ("ko", "en"):
            with self.subTest(lang=lang):
                single = self.entries("Acme", {3: self.signal("Acme")}, [radar], lang=lang)[0]["business"]
                self.assertFalse(single["numbered"])
                self.assertEqual(single["items"], [{"no": "", "body": content.business_text([radar]), "cut": False,
                                                    "source": content.source_line(radar), "source_url": radar["url"]}])
                several = self.entries("Acme", {3: self.signal("Acme")}, [radar, plant, lidar], lang=lang)[0]["business"]
                self.assertTrue(several["numbered"])
                self.assertEqual([item["no"] for item in several["items"]], ["1.", "2.", "3."])
                self.assertEqual([item["source_url"] for item in several["items"]], [plant["url"], lidar["url"], radar["url"]])
                self.assertEqual([item["source"] for item in several["items"]],
                                 [content.source_line(row) for row in (plant, lidar, radar)])

    def test_a_cleared_box_stays_empty(self):
        rows = [article("Corning", key, day, DISTINCT[key]) for key, day in zip(DISTINCT, (5, 20, 12))]
        business = self.entries("Corning", {3: self.signal("Corning")}, rows, summary=SEPTEMBER)[0]["business"]
        self.assertFalse(business["numbered"])
        self.assertEqual(business["items"], [{"no": "", "body": content.t("business_empty"), "cut": False,
                                              "source": "", "source_url": ""}])

    def test_articles_that_do_not_fit_are_dropped_whole_from_the_lowest_priority(self):
        filler_en = "The company described a long and detailed programme of new capacity and partnerships. " * 5
        filler_ko = "회사는 새 생산능력과 협력 계획을 길고 자세하게 설명했음. " * 9
        signals = {no: self.signal("Acme", no, en=f"Indicator {no} event. {filler_en}", ko=f"지표 {no} 사건. {filler_ko}")
                   for no in range(1, 6)}
        # 기사마다 제 낱말만 되풀이해 길게 만든다. 같은 채움 글을 붙이면 서로 같은 사건으로 걸러진다.
        rows = [article("Acme", key, day, f"{DISTINCT[key]} " * 5, ko=f"{DISTINCT[key]} " * 5)
                for key, day in zip(DISTINCT, (5, 20, 12))]
        chosen = content.business_rows("Acme", rows, [], list(signals.values()))
        self.assertEqual(len(chosen), 3)
        counts = {}
        for lang in ("ko", "en"):
            entry = self.entries("Acme", signals, rows, lang=lang)[0]
            items = entry["business"]["items"]
            counts[lang] = len(items)
            self.assertFalse(any(item["cut"] for item in items), "문안을 자르지 않고 항목을 뺀다")
            if len(items) > 1:
                bottom = report_measure.detail_bottom(self.measure, entry["signals"], entry["business"]["target_label"],
                                                      entry["business"]["target_text"], items)
                self.assertLessEqual(bottom + view.BUSINESS_FIT_MARGIN, report_measure.CONTENT_BOTTOM)
        self.assertLess(counts["ko"], 3)
        self.assertEqual(counts["ko"], counts["en"], "한·영 두 판의 건수가 같다")
        # 빠진 것은 우선순위가 가장 낮은 기사(고른 순서의 끝)다.
        kept = {item["source_url"] for item in self.entries("Acme", signals, rows)[0]["business"]["items"]}
        self.assertEqual(kept, {row["url"] for row in chosen[:counts["ko"]]})

    def test_the_height_estimate_grows_with_each_numbered_article(self):
        # 출처 없는 "확인되지 않음" 한 줄 상자는 최소 높이 88pt 에 위 여백 15.2pt 다(4호 Corning·Bayer 카드를 Chrome 이 잰 값).
        empty = {"no": "", "body": "해당 기간 관련 글로벌 사업현황이 확인되지 않음.", "source": ""}
        self.assertAlmostEqual(report_measure.business_box_height(self.measure, "투자유치 필요 품목·기술", "유리", [empty]),
                               15.2 + 88, places=1)
        item = {"no": "", "body": "짧은 문안.", "source": "출처  Media 2026.09.05"}
        one = report_measure.business_box_height(self.measure, "투자유치 필요 품목·기술", "유리", [item])
        numbered = [dict(item, no=f"{no}.") for no in (1, 2, 3)]
        two = report_measure.business_box_height(self.measure, "투자유치 필요 품목·기술", "유리", numbered[:2])
        three = report_measure.business_box_height(self.measure, "투자유치 필요 품목·기술", "유리", numbered)
        self.assertGreater(two, one)
        self.assertAlmostEqual(three - two, report_measure.BUSINESS_BODY_LINE + report_measure.BUSINESS_ITEM_SOURCE_GAP
                               + report_measure.BUSINESS_SOURCE_SIZE * report_measure.LINE_RATIO
                               + report_measure.BUSINESS_ITEM_GAP, places=3)


if __name__ == "__main__":
    unittest.main()
