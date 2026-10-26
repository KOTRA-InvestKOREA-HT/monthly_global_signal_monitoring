"""config/report_text.json(보고서 고정문구)의 형식을 지킨다.

이 파일은 코드를 모르는 사람도 손으로 고치도록 꺼내 둔 것이다. 항목을 지우거나 자리표시자의 중괄호를
깨뜨려도 JSON 으로는 멀쩡해서, 보고서를 만들 때에야 KeyError 로 죽거나 빈 칸이 찍힌다. 그 실수를 여기서 먼저 잡는다.
문구가 무엇이어야 하는지는 묻지 않는다(그것은 docs/report_wording_guide_en.md 와 report_snapshot 의 몫이다).
"""

import json
import re
import string
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import report_content as content  # noqa: E402

REPORT_TEXT = json.loads((ROOT / "config" / "report_text.json").read_text(encoding="utf-8"))
TECH_MAP = json.loads((ROOT / "data" / "company_technology_map.json").read_text(encoding="utf-8"))
# t() 와 matrix_footnote() 가 채워 넣는 값의 이름. no 는 사업현황 상자 항목 번호(business_item_number)다.
PLACEHOLDERS = {"issue", "month", "period", "on", "off", "total", "companies", "no"}
HANGUL = re.compile(r"[가-힣]")


def items(section):
    return REPORT_TEXT[section]["items"]


def strings_of(value):
    return value if isinstance(value, list) else [value]


class ReportTextFileTests(unittest.TestCase):
    def tearDown(self):
        content.set_language("ko")

    def test_every_text_entry_has_only_known_fields(self):
        for key, entry in items("texts").items():
            with self.subTest(key=key):
                self.assertTrue({"ko", "en"} & set(entry), "ko 나 en 중 하나는 있어야 한다")
                self.assertLessEqual(set(entry), {"ko", "en", "note"})

    def test_placeholders_are_ones_the_report_fills(self):
        for key, entry in items("texts").items():
            for lang in ("ko", "en"):
                for text in strings_of(entry.get(lang, "")):
                    if not isinstance(text, str):
                        continue
                    with self.subTest(key=key, lang=lang):
                        # 중괄호 하나를 지우면 parse 가 ValueError 를 낸다.
                        names = {name for _, name, _, _ in string.Formatter().parse(text) if name is not None}
                        self.assertLessEqual(names, PLACEHOLDERS, f"알 수 없는 자리표시자 {names - PLACEHOLDERS}")
                        text.format(**{name: "x" for name in PLACEHOLDERS})

    def test_the_cover_title_fields_keep_their_shape(self):
        titles = items("texts")["cover_titles"]
        accent = items("texts")["cover_title_accent"]
        for lang in ("ko", "en"):
            with self.subTest(lang=lang):
                self.assertIsInstance(titles[lang], list)
                self.assertTrue(all(isinstance(line, str) and line.strip() for line in titles[lang]))
                self.assertIsInstance(accent[lang], int)
                self.assertTrue(0 <= accent[lang] < len(titles[lang]), "금색 줄 순번이 제목 줄 수를 넘는다")

    def test_all_five_indicators_have_names_and_descriptions(self):
        self.assertEqual(sorted(items("indicators")), ["1", "2", "3", "4", "5"])
        for no, entry in items("indicators").items():
            for field in ("ko_name", "ko_description", "en_name", "en_description"):
                with self.subTest(no=no, field=field):
                    self.assertIsInstance(entry.get(field), str)
                    self.assertTrue(entry[field].strip())

    def test_every_technology_group_in_the_data_has_its_wording(self):
        groups = {row["technology_group"] for row in TECH_MAP["companies"] if row.get("technology_group")}
        self.assertLessEqual(groups, set(items("industries")), "기술 그룹 문구가 빠졌다")
        for group, entry in items("industries").items():
            for field in ("ko", "en", "en_target_technology"):
                with self.subTest(group=group, field=field):
                    self.assertTrue(str(entry.get(field) or "").strip())

    def test_every_company_country_has_an_english_name(self):
        self.assertLessEqual(set(content.COUNTRY_BY_COMPANY.values()), set(items("countries_en")))

    def test_english_wording_has_no_korean_left_in_it(self):
        english = [text for entry in items("texts").values() for text in strings_of(entry.get("en", ""))]
        english += [entry[field] for entry in items("indicators").values() for field in ("en_name", "en_description")]
        english += [entry[field] for entry in items("industries").values() for field in ("en", "en_target_technology")]
        english += [entry["en"] for entry in items("exempt_company_industries").values()]
        english += list(items("countries_en").values())
        for text in english:
            if isinstance(text, str):
                self.assertIsNone(HANGUL.search(text), text)

    def test_notes_never_reach_the_report(self):
        for lang in ("ko", "en"):
            content.set_language(lang)
            self.assertNotIn("note", content.TEXTS[lang])
            self.assertEqual(content.t("note"), "")

    def test_the_report_reads_its_wording_from_this_file(self):
        content.set_language("en")
        self.assertEqual(content.t("detail_title"), items("texts")["detail_title"]["en"])
        self.assertEqual(content.signal_row_label(1), items("indicators")["1"]["en_name"])
        content.set_language("ko")
        self.assertEqual(content.t("detail_title"), items("texts")["detail_title"]["ko"])
        self.assertEqual(content.cover_indicator_texts({"no": 3, "label_ko": "", "description_ko": ""}),
                         (items("indicators")["3"]["ko_name"], items("indicators")["3"]["ko_description"]))


if __name__ == "__main__":
    unittest.main()
