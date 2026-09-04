# Image assets

- `emoji_target_1f3af.png`: Noto Emoji target emoji asset used for stable PDF rendering.
  Source project: https://github.com/googlefonts/noto-emoji
- `invest_korea_logo_white.png`: Invest KOREA mark for the navy report cover — white
  wordmark with the full-colour emblem. Cropped from the topmost of the four variants in
  `docs/IK 로고.png`.
- `kotra_logo_white.png`: KOTRA mark for the navy report cover. Cropped from
  `docs/kotra 로고.png` and recoloured to white; the alpha channel is left untouched so the
  wordmark keeps its anti-aliased edges.

Both cover logos are drawn by `draw_logo()` in `scripts/build_pdf_report.py`. If either file
is missing the cover falls back to the previous text wordmarks.
