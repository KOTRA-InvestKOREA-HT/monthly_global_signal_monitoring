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
        # 같은 사건이라도 타겟 품목과 이어져 있고 더 자세하면(120억 달러, AI 칩용 클린룸) 다음 순위로 싣는다(2026-10-25).
        self.assertIs(content.best_business_row("Amkor Technology", [repeat], [], [signal]), repeat)
        unlinked = {**repeat, "ai_target_technology_supported": False}
        self.assertIsNone(content.best_business_row("Amkor Technology", [unlinked], [], [signal]))


if __name__ == "__main__":
    unittest.main()
