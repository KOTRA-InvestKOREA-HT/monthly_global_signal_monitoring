"""Subset existing Noto fonts for the fixed download issue/footer text only."""
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]
TEXT = "0123456789Issue Invest KOREA · Target-Company Global Investment Signal Monitor 타겟기업 글로벌 투자시그널 모니터링"


def build():
    folder = ROOT / "assets" / "fonts"
    destination = ROOT / "assets" / "report-overlay"
    destination.mkdir(exist_ok=True)
    for role in ("SemiBold", "DemiLight"):
        with TTFont(folder / f"NotoSansKR-{role}.ttf", recalcTimestamp=False) as font:
            options = subset.Options()
            options.recalc_timestamp = False
            worker = subset.Subsetter(options=options)
            worker.populate(text=TEXT)
            worker.subset(font)
            output = destination / f"{role}.ttf"
            font.save(output)
            print(f"{output.name}: {output.stat().st_size} bytes")


if __name__ == "__main__":
    build()
