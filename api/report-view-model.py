"""Vercel 웹 다운로드가 HTML 로 그릴 보고서 내용(view model)을 JSON 으로 돌려준다.

Node 함수에는 Python 이 없고, 이 계산은 reportlab 의 글자 폭 측정을 쓴다(scripts/report_view_model.py).
PDF 는 app/api/report 가 Actions 와 같은 HTML 로 인쇄한다.

요청 값 검사는 app/lib/report_request.mjs, 데이터 기간 검사는 app/lib/date_range.mjs dataRangeProblem 과
같은 규칙이다. 값이 틀리면 고쳐 쓰지 않고 400 으로 돌려보낸다.
"""

import contextlib
import datetime
import io
import json
import re
import sys
import traceback
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import report_view_model  # noqa: E402


MAX_ISSUE_DIGITS = 4
MAX_IGNORED_KEYS = 500
SIGNAL_KEY = re.compile(r"[0-9a-f]{8}", re.IGNORECASE)
SUMMARY_PATH = ROOT / "outputs" / "latest_collection_summary.json"


class RequestProblem(ValueError):
    """사용자에게 그대로 보일 400 응답."""


def is_calendar_date(value):
    text = (value or "").strip()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return False
    try:
        datetime.date.fromisoformat(text)
    except ValueError:
        # 2026-02-31 처럼 모양만 맞는 날.
        return False
    return True


def first_param(params, name):
    values = params.get(name)
    return (values[0] if values else "").strip()


def clean_issue(value):
    if not value:
        raise RequestProblem("보고서 호수(Issue 번호)를 입력해 주세요.")
    if not re.fullmatch(rf"\d{{1,{MAX_ISSUE_DIGITS}}}", value) or int(value) < 1:
        raise RequestProblem(f"보고서 호수는 1~{MAX_ISSUE_DIGITS}자리 양의 정수여야 합니다.")
    return str(int(value))


def clean_ignored(value):
    keys = [item.strip() for item in (value or "").split(",") if item.strip()]
    if len(keys) > MAX_IGNORED_KEYS:
        raise RequestProblem(f"무시 목록은 {MAX_IGNORED_KEYS}건까지 보낼 수 있습니다.")
    if any(not SIGNAL_KEY.fullmatch(key) for key in keys):
        raise RequestProblem("무시 목록 값이 올바르지 않습니다.")
    return ",".join(keys)


def clean_range(from_date, to_date):
    given = [value for value in (from_date, to_date) if value]
    if not given:
        return "", ""
    if len(given) == 1:
        raise RequestProblem("시작일과 종료일을 함께 지정해 주세요.")
    if not is_calendar_date(from_date):
        raise RequestProblem(f"시작일이 올바른 날짜가 아닙니다: {from_date}")
    if not is_calendar_date(to_date):
        raise RequestProblem(f"종료일이 올바른 날짜가 아닙니다: {to_date}")
    if from_date > to_date:
        raise RequestProblem(f"시작일이 종료일보다 늦습니다: {from_date} ~ {to_date}")
    return from_date, to_date


def data_period(summary_path=SUMMARY_PATH):
    """배포에 실린 수집 데이터의 기간. 모르면 (None, None)."""
    try:
        summary = json.loads(Path(summary_path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None, None
    return summary.get("from_date"), summary.get("to_date")


def check_data_range(from_date, to_date, data_from, data_to):
    # 배포에는 마지막 한 달 치만 실린다. 그 밖의 달은 오류 없이 "0개사" 보고서가 나왔다.
    if not from_date or not is_calendar_date(data_from) or not is_calendar_date(data_to):
        return
    if from_date >= data_from and to_date <= data_to:
        return
    raise RequestProblem(f"{from_date} ~ {to_date} 기간의 수집 데이터가 없습니다. "
                         f"지금 보고서로 받을 수 있는 기간은 {data_from} ~ {data_to}입니다.")


def request_args(params, period=None):
    """쿼리를 검사해 report_view_model.build 의 인자를 만든다. 틀리면 RequestProblem."""
    issue = clean_issue(first_param(params, "issue"))
    ignored = clean_ignored(first_param(params, "ignored"))
    from_date, to_date = clean_range(first_param(params, "from"), first_param(params, "to"))
    check_data_range(from_date, to_date, *(period or data_period()))
    return SimpleNamespace(
        targets=str(ROOT / "data" / "target_companies.json"),
        technology_map=str(ROOT / "data" / "company_technology_map.json"),
        signals=str(ROOT / "outputs" / "latest_company_signals.json"),
        summary=str(SUMMARY_PATH),
        relevant=str(ROOT / "outputs" / "latest_relevant_signals.json"),
        investment_signals=str(ROOT / "outputs" / "latest_investment_signals.json"),
        indicator_config=str(ROOT / "config" / "investment_signal_indicators.json"),
        font=str(ROOT / "assets" / "fonts" / "PretendardJP-Regular.ttf"),
        issue_number=issue,
        lang="en" if first_param(params, "lang").lower() == "en" else "ko",
        ignored_signals=ignored,
        from_date=from_date,
        to_date=to_date,
    )


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            args = request_args(parse_qs(urlparse(self.path).query))
        except RequestProblem as problem:
            self.send_json(400, {"error": str(problem)})
            return
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                model = report_view_model.build(args)
            self.send_json(200, model)
        except Exception:
            # 예외 문구에는 파일 경로가 들어 있다. 자세한 내용은 함수 로그에만 남긴다.
            traceback.print_exc(file=sys.stderr)
            self.send_json(500, {"error": "보고서 내용을 계산하지 못했습니다. Vercel 함수 로그를 확인해 주세요."})

    def send_json(self, status, value):
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
