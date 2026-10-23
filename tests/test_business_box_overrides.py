"""config/business_box_overrides.json(사람이 비워 두는 사업현황 상자)의 형식과 동작을 지킨다.

손으로 고치는 파일이다. 기업 이름을 표시 이름("onsemi")으로 적거나 달을 "2026-9"처럼 적으면 JSON 으로는 멀쩡해도
아무 상자도 비워지지 않는다. 그 실수를 여기서 잡는다.
"""

import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import report_content as content  # noqa: E402

OVERRIDES = json.loads((ROOT / "config" / "business_box_overrides.json").read_text(encoding="utf-8"))
COMPANIES = {row["company"] for row in json.loads((ROOT / "data" / "target_companies.json").read_text(encoding="utf-8"))}


class BusinessBoxOverrideTests(unittest.TestCase):
    def test_months_and_company_names_are_ones_the_report_knows(self):
        for month, companies in OVERRIDES["empty_box_companies"].items():
            with self.subTest(month=month):
                self.assertRegex(month, re.compile(r"^20\d{2}-(0[1-9]|1[0-2])$"))
                self.assertIsInstance(companies, list)
                self.assertLessEqual(set(companies), COMPANIES, "data/target_companies.json 의 company 값으로 적는다")

    def test_a_listed_company_is_cleared_only_in_its_month(self):
        september = {"from_date": "2026-09-01", "to_date": "2026-09-30"}
        october = {"from_date": "2026-10-01", "to_date": "2026-10-31"}
        self.assertEqual(content.report_months({"from_date": "2026-08-20", "to_date": "2026-09-05"}), ["2026-08", "2026-09"])
        self.assertTrue(content.business_box_cleared("Corning", september))
        self.assertFalse(content.business_box_cleared("Corning", october))
        self.assertFalse(content.business_box_cleared("NXP", september))


if __name__ == "__main__":
    unittest.main()
