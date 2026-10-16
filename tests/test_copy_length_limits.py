import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import report_content as content  # noqa: E402


# 감사(2026-10-15) 2-6: 시그널 칸 문안 길이 한도가 문안 단계(JS)와 렌더러(Python)에 따로 적혀 있었다. 공용 JSON
# (config/copy_length_limits.json)이 기준이다. 렌더러가 그 한도에서 자르는지 행동으로 확인해, 둘이 어긋나면 여기서 걸린다.
LIMITS = json.loads((ROOT / "config" / "copy_length_limits.json").read_text(encoding="utf-8"))["signal_card"]


class CopyLengthLimitTests(unittest.TestCase):
    def tearDown(self):
        content.set_language("ko")

    def test_the_renderer_cuts_signal_card_copy_at_the_shared_limits(self):
        for lang in ("en", "ko"):
            content.set_language(lang)
            for part, field in (("headline", "ai_summary_headline"), ("detail", "ai_summary_detail")):
                limit = LIMITS[lang][part]
                with self.subTest(lang=lang, part=part):
                    fits = content.summary_parts({f"{field}_{lang}": "A" * limit})
                    self.assertEqual(fits[part], "A" * limit)
                    over = content.summary_parts({f"{field}_{lang}": "A" * (limit + 1)})
                    self.assertTrue(over[part].endswith("..."))
                    self.assertLessEqual(len(over[part]), limit)


if __name__ == "__main__":
    unittest.main()
