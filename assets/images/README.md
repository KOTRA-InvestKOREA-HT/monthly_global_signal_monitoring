# Image assets

- `invest_korea_logo_white.png`: Invest KOREA mark for the navy report cover — white
  wordmark with the full-colour emblem. Cropped from the topmost of the four variants in
  `docs/IK 로고.png`.
- `kotra_logo_white.png`: KOTRA mark for the navy report cover. Cropped from
  `docs/kotra 로고.png` and recoloured to white; the alpha channel is left untouched so the
  wordmark keeps its anti-aliased edges.

Both cover logos are placed by `coverPage()` in `scripts/report_html.mjs`. When the page is
rendered without an asset base, the cover falls back to text wordmarks.
