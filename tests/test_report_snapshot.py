"""보고서 출력을 있는 그대로 고정한다.

PDF 는 report_view_model.py 가 만든 뷰 모델을 report_html.mjs 가 HTML 로 그리고 Chrome 이 인쇄한다.
그 안을 옮기거나 나눌 때 보고서가 조용히 달라지지 않았는지 확인할 방법이 필요하다.
이 테스트는 규칙이 옳은지 묻지 않는다. 오늘 나오는 결과와 같은지만 묻는다.

고정된 픽스처(tests/fixtures/report_snapshot)로 한·영 뷰 모델을 만들어 남겨 둔 JSON 과 대조한다.
대상 기업·기술맵·지표 설정도 픽스처에 복사해 두었다. data/ 의 실제 파일이 바뀌어도 이 테스트는 흔들리지 않는다.
그 JSON 을 HTML 로 그린 쪽별 글자는 tests/report_snapshot.test.mjs 가 고정한다.
실제로 규칙을 바꿨다면 아래로 기대값을 다시 만들고 그 차이를 커밋에 남긴다.

    python tests/test_report_snapshot.py --update
    UPDATE_REPORT_SNAPSHOT=1 node --test tests/report_snapshot.test.mjs
"""

import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import report_content  # noqa: E402
import report_view_model  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "report_snapshot"
FONT = ROOT / "assets" / "fonts" / "PretendardJP-Regular.ttf"
LANGS = ("ko", "en")


def fixture(name):
    return str(FIXTURES / name)


def args(lang):
    """report_view_model.build 가 받는 argparse 네임스페이스와 같은 모양."""
    return SimpleNamespace(
        targets=fixture("target_companies.json"),
        technology_map=fixture("company_technology_map.json"),
        summary=fixture("collection_summary.json"),
        relevant=fixture("relevant_signals.json"),
        investment_signals=fixture("investment_signals.json"),
        indicator_config=fixture("investment_signal_indicators.json"),
        font=str(FONT),
        issue_number="3",
        lang=lang,
        ignored_signals="",
        from_date="",
        to_date="",
    )


def build_all():
    try:
        # CLI 가 JSON 으로 내보내는 것과 같은 값이 되도록 한 번 직렬화한다.
        return {lang: json.loads(json.dumps(report_view_model.build(args(lang)), ensure_ascii=False)) for lang in LANGS}
    finally:
        report_content.set_language("ko")


def expected_path(lang):
    return FIXTURES / f"expected_view_model_{lang}.json"


class ReportSnapshotTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.models = build_all()

    def test_the_view_model_is_unchanged(self):
        for lang in LANGS:
            with self.subTest(lang=lang):
                expected = json.loads(expected_path(lang).read_text(encoding="utf-8"))
                self.assertEqual(self.models[lang], expected)

    def test_the_fixture_still_covers_what_the_report_has_to_decide(self):
        """기대값만 다시 찍어 통과시키는 일을 막는다. 덮여야 할 경우가 픽스처에 남아 있는지 본다."""
        ko = self.models["ko"]
        rows = ko["matrix"]["rows"]
        self.assertGreaterEqual(sum("on" in row["signals"] for row in rows), 5, "승인된 시그널이 여러 기업에 있어야 한다")
        self.assertIn("reviewed", {row["status"] for row in rows}, "시그널 없는 기업도 있어야 한다")
        pages = ko["details"]["pages"]
        empty = report_content.TEXTS["ko"]["business_empty"]
        self.assertTrue([page for page in pages if page["business"]["body"] != empty],
                        "사업현황 상자가 채워진 기업이 있어야 한다")
        self.assertTrue(ko["items"] and ko["items"]["cards"], "품목별 사업동향 카드가 있어야 한다")
        self.assertTrue([signal for page in pages for signal in page["signals"] if not signal["active"]],
                        "시그널 없는 지표 칸도 있어야 한다")
        # 품목 연결 없이 승인되는 기업 단위 지표(3·5)가 실제로 실리는지.
        investment = json.loads((FIXTURES / "investment_signals.json").read_text(encoding="utf-8"))
        company_level = [row for row in investment if row.get("ai_target_technology_supported") is False
                         and report_content.signal_publishable(row)]
        self.assertTrue(company_level, "품목 미연계 기업 단위 시그널이 픽스처에 있어야 한다")
        # 한국어 문안은 개조식, 영문은 평서문이라 두 스냅샷이 실제로 달라야 한다.
        self.assertNotEqual([page["signals"] for page in pages],
                            [page["signals"] for page in self.models["en"]["details"]["pages"]])


def update():
    for lang, model in build_all().items():
        expected_path(lang).write_text(json.dumps(model, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"updated {len(LANGS)} view-model snapshots")


if __name__ == "__main__":
    if "--update" in sys.argv:
        update()
    else:
        unittest.main()
