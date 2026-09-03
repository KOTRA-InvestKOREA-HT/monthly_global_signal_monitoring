import contextlib
import io
import json
import re
import sys
import tempfile
import uuid
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.build_pdf_report import build_report


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
            issue = clean_issue(first_param(params, "issue", "2"))
            ignored = first_param(params, "ignored", "")
            from_date = clean_date(first_param(params, "from", ""))
            to_date = clean_date(first_param(params, "to", ""))
            lang = clean_lang(first_param(params, "lang", "ko"))
            out_path = Path(tempfile.gettempdir()) / f"global-signal-report-{uuid.uuid4().hex}.pdf"

            args = SimpleNamespace(
                targets=str(ROOT / "data" / "target_companies.json"),
                technology_map=str(ROOT / "data" / "company_technology_map.json"),
                signals=str(ROOT / "outputs" / "latest_company_signals.json"),
                summary=str(ROOT / "outputs" / "latest_collection_summary.json"),
                relevant=str(ROOT / "outputs" / "latest_relevant_signals.json"),
                relevance_summary=str(ROOT / "outputs" / "latest_relevance_summary.json"),
                investment_signals=str(ROOT / "outputs" / "latest_investment_signals.json"),
                investment_summary=str(ROOT / "outputs" / "latest_investment_signal_summary.json"),
                indicator_config=str(ROOT / "config" / "investment_signal_indicators.json"),
                font=str(ROOT / "assets" / "fonts" / "NOTOSANSKR-VF.TTF"),
                issue_number=issue,
                lang=lang,
                ignored_signals=ignored,
                from_date=from_date,
                to_date=to_date,
                out=str(out_path),
            )

            with contextlib.redirect_stdout(io.StringIO()):
                build_report(args)

            payload = out_path.read_bytes()
            out_path.unlink(missing_ok=True)
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header(
                "Content-Disposition",
                f'attachment; filename="global-signal-monitor-issue-{issue}{"-en" if lang == "en" else ""}.pdf"',
            )
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception as error:
            body = json.dumps({"error": str(error)}, ensure_ascii=False).encode("utf-8")
            self.send_response(500)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
