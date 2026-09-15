"""Vercel 웹 다운로드가 HTML 로 그릴 보고서 내용(view model)을 JSON 으로 돌려준다.

Node 함수에는 Python 이 없고, 이 계산은 reportlab 의 글자 폭 측정을 쓴다(scripts/report_view_model.py).
PDF 는 app/api/report 가 Actions 와 같은 HTML 로 인쇄한다.
"""

import contextlib
import io
import json
import re
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import report_view_model  # noqa: E402


def clean_issue(value):
    return re.sub(r"\D+", "", value or "2") or "2"


def clean_date(value):
    text = (value or "").strip()
    return text if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text) else ""


def first_param(params, name, default=""):
    values = params.get(name)
    return values[0] if values else default


def clean_lang(value):
    return "en" if (value or "").strip().lower() == "en" else "ko"


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            params = parse_qs(urlparse(self.path).query)
            args = SimpleNamespace(
                targets=str(ROOT / "data" / "target_companies.json"),
                technology_map=str(ROOT / "data" / "company_technology_map.json"),
                signals=str(ROOT / "outputs" / "latest_company_signals.json"),
                summary=str(ROOT / "outputs" / "latest_collection_summary.json"),
                relevant=str(ROOT / "outputs" / "latest_relevant_signals.json"),
                investment_signals=str(ROOT / "outputs" / "latest_investment_signals.json"),
                indicator_config=str(ROOT / "config" / "investment_signal_indicators.json"),
                font=str(ROOT / "assets" / "fonts" / "NOTOSANSKR-VF.TTF"),
                issue_number=clean_issue(first_param(params, "issue", "2")),
                lang=clean_lang(first_param(params, "lang", "ko")),
                ignored_signals=first_param(params, "ignored", ""),
                from_date=clean_date(first_param(params, "from", "")),
                to_date=clean_date(first_param(params, "to", "")),
            )
            with contextlib.redirect_stdout(io.StringIO()):
                model = report_view_model.build(args)
            self.send_json(200, model)
        except Exception as error:
            self.send_json(500, {"error": str(error)})

    def send_json(self, status, value):
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
