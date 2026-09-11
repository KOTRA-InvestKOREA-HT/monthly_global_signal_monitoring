# PDF download overlay fonts

These are subsets of `assets/fonts/NotoSansKR-SemiBold.ttf` and
`assets/fonts/NotoSansKR-DemiLight.ttf`, made for the download route's fixed
Korean/English footer and issue number. All digits are included. The complete
fonts remain available for article text in HTML and Python PDF rendering.

Regenerate after changing the footer or source fonts:

```sh
python scripts/build_report_overlay_fonts.py
```

The selected Python environment needs `fonttools` from `requirements-python.txt`.
Update `TEXT` in that script if the footer gains new characters. Keep these assets
in a separate directory: the Next.js file tracer may include neighboring fonts
when a route constructs a font path dynamically.
