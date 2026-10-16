import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import build_company_technology_map as technology_map
import extract_pdf_companies as pdf_companies

ROOT = Path(__file__).resolve().parents[1]


class TargetNumberTests(unittest.TestCase):
    def test_only_target_numbers_one_to_seventy_seven_are_read(self):
        numbers = [int(match.group(1)) for match in pdf_companies.TARGET_NO_PATTERN.finditer(
            "1 Cognex 9 Jenoptik 45 BASF 77 Toray 78 Extra 99 Other 100 Units 2.5 ratio")]
        self.assertEqual(numbers, [1, 9, 45, 77])


class TechnologyMapMergeTests(unittest.TestCase):
    def generated(self, **extra):
        return {"target_no": 27, "company": "Prodrive", "query_aliases": ["Prodrive Technologies"],
                "industry": "new industry", **extra}

    def test_hand_written_fields_survive_a_rebuild_and_generated_fields_win(self):
        identity = {"legal_name": "Prodrive Technologies", "official_domains": ["prodrive-technologies.com"]}
        previous = [{"target_no": 27, "company": "Prodrive", "target_identity": identity,
                     "query_aliases": ["old"], "industry": "old industry"}]
        merged = technology_map.preserve_manual_fields([self.generated()], previous)
        self.assertEqual(merged[0]["target_identity"], identity)
        self.assertEqual(merged[0]["industry"], "new industry")
        self.assertEqual(merged[0]["query_aliases"], ["Prodrive Technologies"])
        self.assertEqual(list(merged[0])[:3], ["target_no", "company", "target_identity"])

    def test_a_different_company_under_the_same_number_does_not_inherit_fields(self):
        previous = [{"target_no": 27, "company": "Other", "target_identity": {"legal_name": "Other"}}]
        merged = technology_map.preserve_manual_fields([self.generated()], previous)
        self.assertNotIn("target_identity", merged[0])

    def test_the_committed_map_keeps_its_hand_written_identity(self):
        # 지금 저장소의 파일을 다시 만들면 Prodrive 의 target_identity 가 남는다.
        with open(ROOT / "data" / "company_technology_map.json", encoding="utf-8") as handle:
            companies = json.load(handle)["companies"]
        regenerated = [{key: value for key, value in row.items() if key != "target_identity"} for row in companies]
        merged = technology_map.preserve_manual_fields(regenerated, companies)
        self.assertEqual(merged, companies)


if __name__ == "__main__":
    unittest.main()
