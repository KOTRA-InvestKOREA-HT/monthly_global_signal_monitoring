"""사업현황 상자가 위 지표 칸과 같은 사건을 다른 기사로 되풀이하지 않게 한다(2026-10-23 사용자 결정).

문안은 4호(2026-09) 실제 문안이거나, 같은 달 외부 기사를 옮긴 것이다.
"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import report_content as content  # noqa: E402

AMKOR_SIGNAL = {"company": "Amkor Technology", "ai_summary_en": (
    "Amkor Technology announced phase 2 of its Arizona advanced packaging and test campus, which is expected to add "
    "60,000 square meters of cleanroom space to bring the total to approximately 93,000 square meters and increase "
    "the project's planned investment to approximately $12 billion.")}
OUSTER_SIGNAL = {"company": "Ouster", "ai_summary_en": (
    "Ouster formed a strategic partnership with GeoCue to integrate its Rev8 OS1 Max digital lidar into GeoCue's "
    "TrueView product line, following joint flight testing and firmware tuning in Huntsville, Alabama.")}
ALBEMARLE_SIGNAL = {"company": "Albemarle", "ai_summary_en":
                    "Albemarle appointed Ragnar Udd as President and Chief Executive Officer, effective February 1, 2027."}


def same(text, signal):
    return content.same_event_as_signal({"ai_summary_en": text, "company": signal["company"]}, [signal], signal["company"])


class SameEventTests(unittest.TestCase):
    def test_the_same_event_from_another_outlet_is_a_repeat(self):
        # 같은 보도자료를 줄여 쓴 문안(4호 Amkor 상자, 61%)
        self.assertTrue(same("Amkor Technology, a provider of outsourced semiconductor packaging and test services, "
                             "announced phase 2 of its Arizona advanced packaging and test campus.", AMKOR_SIGNAL))
        # 같은 투자를 다른 매체가 금액으로 쓴 문안
        self.assertTrue(same("Amkor nearly doubled its planned investment in its Peoria, Arizona advanced packaging "
                             "facility to $12 billion, adding cleanroom space for AI chips.", AMKOR_SIGNAL))
        # 숫자 없이 바꿔 쓴 문안
        self.assertTrue(same("Amkor is expanding its Arizona advanced packaging and test campus with a second phase "
                             "that adds cleanroom space.", AMKOR_SIGNAL))
        # 같은 선임을 SEC 공시로 쓴 문안(4호 Albemarle, 46%)
        self.assertTrue(same("Albemarle announced that Ragnar Udd will become President and Chief Executive Officer, "
                             "effective February 1, 2027, and that Kent Masters will transition to Executive Chairman "
                             "upon Udd taking office.", ALBEMARLE_SIGNAL))

    def test_a_different_event_is_kept(self):
        # 같은 달 다른 사건: 광주 증설 검토(Herald 영문판 9/20)
        self.assertFalse(same("Amkor Technology is reviewing an expanded investment in its plant in Gwangju, South "
                              "Jeolla Province, Korea, as demand for advanced packaging grows.", AMKOR_SIGNAL))
        # 제품 이름만 같은 다른 사건(4호 Ouster, 26%)
        self.assertFalse(same("Ouster is seeing strong customer adoption of its Rev8 OS1 Max native-color digital "
                              "lidar, with payload integrators and drone manufacturers in the aerial mapping market "
                              "selecting the sensor for utility corridor inspection.", OUSTER_SIGNAL))
        # 연도와 날짜는 같은 수량으로 보지 않는다.
        self.assertFalse(same("Albemarle submitted the environmental assessment permit on February 1, 2027 for a "
                              "commercial direct lithium extraction project.", ALBEMARLE_SIGNAL))

    def test_the_box_moves_on_to_the_next_development(self):
        signal = {**AMKOR_SIGNAL, "url": "https://ir.amkor.com/phase-2", "title": "Amkor announces phase 2"}
        approved = {"company": "Amkor Technology", "ai_signal_supported": True, "ai_entity_supported": True,
                    "ai_indicator_supported": True, "ai_leading_indicator_supported": True,
                    "ai_target_technology_supported": True, "ai_summary_quality": "pass", "ai_event_stage": "not_applicable",
                    "ai_summary_ko": "문안", "source_type": "official"}
        repeat = {**approved, "url": "https://ktar.example/amkor", "title": "Amkor nearly doubles Arizona investment",
                  "ai_summary_en": "Amkor nearly doubled its planned investment in its Peoria, Arizona advanced "
                                   "packaging facility to $12 billion, adding cleanroom space for AI chips."}
        other = {**approved, "url": "https://herald.example/amkor", "title": "Amkor eyes Gwangju expansion",
                 "ai_summary_en": "Amkor Technology is reviewing an expanded investment in its plant in Gwangju, "
                                  "South Jeolla Province, Korea, as demand for advanced packaging grows."}
        self.assertIs(content.best_business_row("Amkor Technology", [repeat, other], [], [signal]), other)
        # 다른 매체가 쓴 같은 사건은 더 자세해도(120억 달러, AI 칩용 클린룸) 싣지 않는다(2026-11-04). 2026-10-25 에는
        # 2순위로 실었다. 같은 기사의 다른 내용만 2순위로 남는다(test_business_box_items 의 Cytiva·Norsk Hydro).
        self.assertIsNone(content.best_business_row("Amkor Technology", [repeat], [], [signal]))
        unlinked = {**repeat, "ai_target_technology_supported": False}
        self.assertIsNone(content.best_business_row("Amkor Technology", [unlinked], [], [signal]))


# 5호(2026-10) 실제 문안. 위 칸은 다른 매체 기사이고, 상자 후보는 같은 사건을 쓴 공식 보도자료다.
AMKOR_KOREA_SIGNAL = {"company": "Amkor Technology", "ai_summary_en": (
    "Nvidia and Amkor agreed to expand their partnership to boost advanced packaging capacity in South Korea, targeting "
    "a more than 300% increase in interposer wafer capacity by the end of 2028.")}
AMKOR_KOREA_RELEASE = (
    "Amkor Technology announced a $1.3 billion agreement with NVIDIA on October 21, 2026, to expand capacity in South "
    "Korea for semiconductor packaging and test services, building on their Arizona collaboration. With this commitment, "
    "multi-year agreements in Arizona and South Korea total $3 billion to support growing demand for next-generation AI "
    "and accelerated computing platforms.")
AIR_LIQUIDE_BOND_SIGNAL = {"company": "Air Liquide", "ai_summary_en": (
    "On October 6, 2026, Air Liquide issued a 2 billion euros multi-tranche bond in France with 2-year, 5-year, and "
    "10-year maturities at a weighted average interest rate below 4.00% per annum. Net proceeds will fund general "
    "corporate purposes and debt refinancing. The issue received A ratings from Standard & Poor's and Scope Ratings, "
    "and an A2 rating from Moody's.")}
VESTAS_NERETEK_SIGNAL = {"company": "Vestas", "ai_summary_en": (
    "Vestas signed a memorandum of understanding with Neretek to explore deploying their foundation and turbine "
    "technologies on deeper-water offshore wind projects, including assessing Neretek's BC90 foundation concept with "
    "Vestas's turbines for the Other Deep Water Offshore Wind segment.")}


class SameEventFromTheLongerSideTests(unittest.TestCase):
    """겹침을 두 방향으로 재고, 같은 금액이면 고유명사 없이도 같은 사건으로 본다(2026-11-04, 5호 상자 되풀이)."""

    def test_an_official_release_retelling_a_shorter_card_is_the_same_event(self):
        # 5호 Amkor: 상자 문안 쪽으로는 26%지만 위 칸 쪽으로는 39%이고 NVIDIA·South·Korea 를 함께 쓴다.
        self.assertTrue(same(AMKOR_KOREA_RELEASE, AMKOR_KOREA_SIGNAL))

    def test_the_same_amount_with_most_words_shared_is_the_same_event(self):
        # 5호 Air Liquide: 3분기 실적 보도자료가 10월 6일 채권 발행을 다시 썼다(46%, "€2 billion" = "2 billion euros").
        self.assertTrue(same("Air Liquide issued a €2 billion multi-tranche bond on the Euro market to support its capital "
                             "allocation and drive the development of activities in future growth markets.",
                             AIR_LIQUIDE_BOND_SIGNAL))

    def test_a_different_project_in_the_same_field_is_kept(self):
        # 5호 Vestas: 대만 첫 V236 허브 조립은 Neretek MOU 와 32% 겹치고 offshore·wind 만 같다.
        self.assertFalse(same("On October 13, 2026, Vestas completed the assembly of Taiwan's first V236-15.0 MW offshore "
                              "wind turbine hub, supporting progress on CIP's 495 MW Fengmiao 1 Offshore Wind Farm.",
                              VESTAS_NERETEK_SIGNAL))
        # 같은 금액 단위라도 다른 사건은 남긴다(Amkor 의 광주 증설 검토).
        self.assertFalse(same("Amkor Technology is reviewing an expanded investment in its plant in Gwangju, South "
                              "Jeolla Province, Korea, as demand for advanced packaging grows.", AMKOR_SIGNAL))


if __name__ == "__main__":
    unittest.main()
