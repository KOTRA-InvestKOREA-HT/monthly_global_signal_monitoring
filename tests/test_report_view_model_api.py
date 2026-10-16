"""Vercel 보고서 함수(api/report-view-model.py)의 요청 검사.

호수가 비면 "2"로 채우고, 2026-02-31 같은 날을 받으면 조용히 전월로 대체하고, 배포에 없는 달을
고르면 "0개사" 보고서를 돌려주던 함수다. 지금은 값이 틀리면 400 으로 돌려보낸다.
"""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("report_view_model_api", ROOT / "api" / "report-view-model.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)

SEPTEMBER = ("2026-09-01", "2026-09-30")


def params(**values):
    return {name: [value] for name, value in values.items()}


class RequestArgsTests(unittest.TestCase):
    def test_a_missing_issue_is_refused_instead_of_printing_issue_2(self):
        for issue in ("", "  ", "abc", "0", "12345"):
            with self.subTest(issue=issue), self.assertRaises(api.RequestProblem):
                api.request_args(params(issue=issue), SEPTEMBER)
        self.assertEqual(api.request_args(params(issue="4"), SEPTEMBER).issue_number, "4")

    def test_dates_must_exist_and_form_a_range(self):
        for start, end in (("2026-02-31", "2026-03-01"), ("2026-09-01", ""), ("", "2026-09-30"),
                           ("2026-09-30", "2026-09-01"), ("2026-9-1", "2026-09-30")):
            with self.subTest(start=start, end=end), self.assertRaises(api.RequestProblem):
                api.request_args(params(issue="4", **{"from": start, "to": end}), SEPTEMBER)
        args = api.request_args(params(issue="4", **{"from": "2026-09-01", "to": "2026-09-30"}), SEPTEMBER)
        self.assertEqual((args.from_date, args.to_date), SEPTEMBER)
        # 기간을 주지 않으면 데이터 기간 그대로다.
        args = api.request_args(params(issue="4"), SEPTEMBER)
        self.assertEqual((args.from_date, args.to_date), ("", ""))

    def test_a_month_outside_the_shipped_data_is_refused(self):
        with self.assertRaisesRegex(api.RequestProblem, "2026-09-01 ~ 2026-09-30"):
            api.request_args(params(issue="5", **{"from": "2026-10-01", "to": "2026-10-31"}), SEPTEMBER)
        with self.assertRaises(api.RequestProblem):
            api.request_args(params(issue="4", **{"from": "2026-08-25", "to": "2026-09-30"}), SEPTEMBER)
        # 데이터 기간을 모르면 막지 않는다.
        api.request_args(params(issue="5", **{"from": "2026-10-01", "to": "2026-10-31"}), (None, None))

    def test_the_ignore_list_is_bounded_and_well_formed(self):
        self.assertEqual(api.request_args(params(issue="4", ignored="0a1b2c3d, ffffffff"), SEPTEMBER).ignored_signals,
                         "0a1b2c3d,ffffffff")
        for ignored in ("not-a-key", "0a1b2c3d,<script>", ",".join(["0a1b2c3d"] * (api.MAX_IGNORED_KEYS + 1))):
            with self.subTest(ignored=ignored[:20]), self.assertRaises(api.RequestProblem):
                api.request_args(params(issue="4", ignored=ignored), SEPTEMBER)

    def test_the_data_period_comes_from_the_shipped_summary(self):
        with tempfile.TemporaryDirectory() as folder:
            summary = Path(folder) / "summary.json"
            summary.write_text(json.dumps({"from_date": "2026-09-01", "to_date": "2026-09-30"}), encoding="utf-8")
            self.assertEqual(api.data_period(summary), SEPTEMBER)
            self.assertEqual(api.data_period(Path(folder) / "missing.json"), (None, None))


if __name__ == "__main__":
    unittest.main()
