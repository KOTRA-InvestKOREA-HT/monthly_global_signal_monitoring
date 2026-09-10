"""Read a PDF from stdin and write its text to stdout in column reading order.

pdfplumber's ``extract_text`` walks a page line by line across its full width.
On a multi-column page that interleaves the columns: one printed sentence comes
back as fragments separated by text from the neighbouring column. The reviewer
requires evidence quotes to be exact passages of the article body, so a model
that reads such a page correctly still produces a quote that matches nothing,
and the whole run fails validation.

This splits each page into regions with a recursive XY cut before reading any
text, so a column is read top to bottom before the next column starts.
"""

import io
import sys

import pdfplumber

MAX_PAGES = 30
MAX_DEPTH = 10
# A vertical cut is only credible over a block of lines. Two words side by side
# on one line are a label and its value, not two columns.
MIN_LINES_FOR_CUT = 4
# Justified prose can space words as widely as a report's table columns sit
# apart, so gutter width alone cannot tell a column break from a chance river of
# white space. What separates them is that a column has an edge: the lines to its
# right start at the same x. Require that alignment rather than a wide gap.
MIN_GUTTER_PT = 8.0
EDGE_TOLERANCE_PT = 2.0
# A heading that spans the columns crosses their edge; a paragraph indent that
# only looks like one is crossed by nearly every line. Tell them apart by how
# many lines cross.
MAX_CROSSING_RATIO = 0.4
# Words on one line rarely differ in `top` by more than a fraction of their height.
LINE_TOLERANCE_RATIO = 0.6
# Split horizontally only at a gap that stands out from this region's own leading,
# so a page separates into header and body rather than into individual lines.
ROW_GAP_MULTIPLE = 2.0
MIN_ROW_GAP_PT = 4.0


def median(values):
    ordered = sorted(values)
    count = len(ordered)
    if not count:
        return 0.0
    middle = count // 2
    return ordered[middle] if count % 2 else (ordered[middle - 1] + ordered[middle]) / 2


def group_lines(words):
    """Group words into visual lines, each sorted left to right."""
    if not words:
        return []
    heights = [w["bottom"] - w["top"] for w in words]
    tolerance = max(median(heights) * LINE_TOLERANCE_RATIO, 1.0)
    ordered = sorted(words, key=lambda w: (w["top"], w["x0"]))
    lines, current = [], [ordered[0]]
    for word in ordered[1:]:
        # Measure from the line's first word: comparing against the previous one
        # lets a line drift down through a column of slightly falling baselines.
        if word["top"] - current[0]["top"] <= tolerance:
            current.append(word)
        else:
            lines.append(current)
            current = [word]
    lines.append(current)
    return [sorted(line, key=lambda w: w["x0"]) for line in lines]


def widest_gutter(words, lines):
    """Return the x of the widest column gutter, or None if the words share one column."""
    spans = sorted((w["x0"], w["x1"]) for w in words)
    reach, gutters = spans[0][1], []
    for x0, x1 in spans[1:]:
        if x0 - reach >= MIN_GUTTER_PT:
            gutters.append((x0 - reach, reach, x0))
        reach = max(reach, x1)
    for _, left, right in sorted(gutters, reverse=True):
        # `right` is where the leftmost word past the gutter starts. A column
        # begins there on line after line; a river of word spacing does not.
        edge = sum(any(abs(w["x0"] - right) <= EDGE_TOLERANCE_PT for w in line) for line in lines)
        if edge >= MIN_LINES_FOR_CUT:
            return (left + right) / 2
    return None


def vertical_cut(words):
    lines = group_lines(words)
    if len(lines) < MIN_LINES_FOR_CUT:
        return None
    gutter = widest_gutter(words, lines)
    if gutter is None:
        return None
    # Partition on one side of the test so that no word can fall out of both.
    left = [w for w in words if w["x1"] <= gutter]
    right = [w for w in words if w["x1"] > gutter]
    # Both sides must be blocks in their own right. A marginal note or a page
    # number beside body text is not a column and reads better in place.
    if len(group_lines(left)) < MIN_LINES_FOR_CUT or len(group_lines(right)) < MIN_LINES_FOR_CUT:
        return None
    return left, right


def crosses(line, edge):
    """True when a word on this line occupies the whitespace before a column edge.

    The edge is rounded to a whole point, so leave the column's own words a
    tolerance: without it every line of the column reads as crossing its own edge.
    """
    return any(w["x1"] > edge - MIN_GUTTER_PT and w["x0"] < edge - EDGE_TOLERANCE_PT for w in line)


def crossed_column_edge(words, lines):
    """Find a column edge that a few full-width lines run across.

    A running header or a spanning heading reaches over the gutter, which hides
    it from ``widest_gutter`` and leaves the columns below it interleaved. The
    column still announces itself by the x its lines start at.
    """
    margin = min(w["x0"] for w in words)
    starts = {}
    for line in lines:
        for key in {round(w["x0"]) for w in line}:
            starts[key] = starts.get(key, 0) + 1
    candidates = sorted(((count, edge) for edge, count in starts.items()
                         if count >= MIN_LINES_FOR_CUT and edge - MIN_GUTTER_PT > margin), reverse=True)
    for _, edge in candidates:
        crossing = sum(crosses(line, edge) for line in lines)
        # Some lines must cross it, or this is an ordinary gutter that
        # `widest_gutter` already had its chance at; most must not, or the edge
        # is a paragraph indent rather than a column.
        if crossing and crossing <= len(lines) * MAX_CROSSING_RATIO:
            return edge
    return None


def straddle_cut(words):
    """Split a region into bands at the lines that run across its columns."""
    lines = group_lines(words)
    if len(lines) < MIN_LINES_FOR_CUT:
        return None
    edge = crossed_column_edge(words, lines)
    if edge is None:
        return None
    bands, band = [], []
    for line in lines:
        if crosses(line, edge):
            if band:
                bands.append(band)
            bands.append([line])
            band = []
        else:
            band.append(line)
    if band:
        bands.append(band)
    if len(bands) < 2:
        return None
    return [[w for line in band for w in line] for band in bands]


def horizontal_cut(words):
    lines = group_lines(words)
    if len(lines) < 2:
        return None
    bounds = [(min(w["top"] for w in line), max(w["bottom"] for w in line)) for line in lines]
    gaps = [bounds[i + 1][0] - bounds[i][1] for i in range(len(bounds) - 1)]
    heights = [bottom - top for top, bottom in bounds]
    threshold = max(median(gaps) * ROW_GAP_MULTIPLE, median(heights) * LINE_TOLERANCE_RATIO, MIN_ROW_GAP_PT)
    widest = max(gaps)
    if widest < threshold:
        return None
    index = gaps.index(widest)
    return ([w for line in lines[: index + 1] for w in line],
            [w for line in lines[index + 1:] for w in line])


def read_region(words, depth=0):
    """Order a region's words by cutting it into columns, then into bands."""
    if len(words) <= 1 or depth >= MAX_DEPTH:
        return group_lines(words)
    cut = vertical_cut(words) or straddle_cut(words) or horizontal_cut(words)
    if cut is None:
        return group_lines(words)
    return [line for part in cut for line in read_region(part, depth + 1)]


def page_text(page):
    words = page.extract_words(use_text_flow=False, keep_blank_chars=False)
    if not words:
        return page.extract_text() or ""
    lines = read_region(words)
    return "\n".join(" ".join(word["text"] for word in line) for line in lines)


def main():
    with pdfplumber.open(io.BytesIO(sys.stdin.buffer.read())) as pdf:
        text = "\n".join(page_text(page) for page in pdf.pages[:MAX_PAGES])
    sys.stdout.write(text)


if __name__ == "__main__":
    main()
