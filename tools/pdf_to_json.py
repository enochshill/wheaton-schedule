"""Convert a Wheaton Registration Packet PDF -> per-semester classes.json.

Run from repo root:
    python3 tools/pdf_to_json.py --semester fall-2026
    python3 tools/pdf_to_json.py --semester spring-2026 --input some/other/path.pdf

Defaults: --input  tools/sources/{semester}.pdf
          --output semesters/{semester}/classes.json

Logs unparsed lines to stderr.
"""

import argparse
import json
import re
import sys
from pathlib import Path

import pypdf

ROOT = Path(__file__).resolve().parent.parent

TIME_RE = re.compile(
    r"(\d{1,2}:\d{2})\s*(AM|PM)\s*-\s*(\d{1,2}:\d{2})\s*(AM|PM)"
)
ROW_PREFIX_RE = re.compile(
    r"^(?P<crn>\d{5})\s+"
    r"(?P<subj>[A-Z]{2,4}|[A-Z]\s+[A-Z]{2,3})\s+"
    r"(?P<num>\S+)\s+"
    r"(?P<sec>\S+)\s+"
    r"(?P<quad>[A-Z0-9]+)\s+"
    r"(?P<rest>.+)$"
)
# Header line at the top of each PDF page, e.g. "Fall 2026 Course Schedule".
TERM_HEADER_RE = re.compile(r"^(?:Fall|Spring|Summer|Winter|J-Term)\s+\d{4}\s+Course Schedule")
DAY_LETTERS = {"M", "T", "W", "R", "F", "S", "U"}
ATTR_TOKEN_RE = re.compile(r"^[A-Z]{2,5}$")


def to_24h(t: str) -> str:
    """'8:30 AM' -> '08:30', '1:05 PM' -> '13:05'."""
    hhmm, ampm = t.rsplit(" ", 1)
    h, m = (int(x) for x in hhmm.split(":"))
    if ampm == "PM" and h != 12:
        h += 12
    if ampm == "AM" and h == 12:
        h = 0
    return f"{h:02d}:{m:02d}"


def split_days(s: str) -> list[str]:
    """'T R' -> ['T','R']; 'M W F' -> ['M','W','F']; 'MWF' -> ['M','W','F']."""
    out = []
    for ch in s:
        if ch in DAY_LETTERS:
            out.append(ch)
    return out


def strip_trailing(after: str) -> tuple[str, str]:
    """Split `after` (text after time/TBA) into (days_part, trailing).

    Trailing is max/cap/fees/attributes; days_part contains only day letters/spaces.
    """
    # Day letters appear first (possibly space-separated). Stop at the first
    # token that's a digit or a longer word.
    tokens = after.split()
    day_tokens = []
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        # A day token is 1-5 chars, all in DAY_LETTERS
        if all(c in DAY_LETTERS for c in tok) and 1 <= len(tok) <= 5:
            day_tokens.append(tok)
            i += 1
        else:
            break
    return " ".join(day_tokens), " ".join(tokens[i:])


# Tokens that show up in trailing but aren't real "tags" the user cares about.
TRAILING_NOISE = {"FLAT", "CRED", "TO", "OR", "TBA"}


def parse_attributes(trailing: str) -> list[str]:
    """Pull attribute tags out of the post-days portion of a row.

    Trailing examples: '20', '60 35 FLAT SP', '21 PI, SIP', '28 AAQR'.
    Returns just the upper-case attribute codes (2-5 chars) — drops max/cap
    numbers, fee patterns ("N FLAT", "N CRED"), and connector words.
    """
    # Strip "<digits> FLAT" or "<digits> CRED" — fee patterns, not tags.
    s = re.sub(r"\d+\s*(?:FLAT|CRED)\b", "", trailing)
    tokens = re.findall(r"[A-Z]{2,5}", s)
    return [t for t in tokens if t not in TRAILING_NOISE]


def parse_credits_from_end(text: str) -> tuple[str, str]:
    """Pull credits off the end of `text`. Returns (title_part, credits_str).

    Handles '2 TO 4', '0', '4'. Title may end with numbers, but credits are
    always the LAST number(-range) before time/TBA.
    """
    text = text.rstrip()
    # Match credit range first ("2 TO 4", "2 OR 4")
    m = re.search(r"(\d+(?:\.\d+)?\s*(?:TO|OR)\s*\d+(?:\.\d+)?)\s*$", text)
    if m:
        return text[: m.start()].rstrip(), re.sub(r"\s+", " ", m.group(1))
    m = re.search(r"(\d+(?:\.\d+)?)\s*$", text)
    if m:
        return text[: m.start()].rstrip(), m.group(1)
    return text, ""


def parse_row(line: str) -> dict | None:
    line = line.strip()
    pm = ROW_PREFIX_RE.match(line)
    if not pm:
        return None
    crn = pm.group("crn")
    subj = re.sub(r"\s+", "", pm.group("subj"))  # 'B EC' -> 'BEC'
    num = pm.group("num")
    sec = pm.group("sec")
    quad = pm.group("quad")
    rest = pm.group("rest")

    # Find time block (or TBA).
    tm = TIME_RE.search(rest)
    if tm:
        before = rest[: tm.start()].rstrip()
        after = rest[tm.end():].lstrip()
        time_start = to_24h(f"{tm.group(1)} {tm.group(2)}")
        time_end = to_24h(f"{tm.group(3)} {tm.group(4)}")
        days_part, trailing_after = strip_trailing(after)
        days = split_days(days_part)
        attributes = parse_attributes(trailing_after)
    else:
        # No time block. Either explicit 'TBA' or a hybrid row with just
        # day letters (e.g. '1HY ... 4 MTWRF 24'). Find whichever marker
        # appears first.
        tba_m = re.search(r"\bTBA\b", rest)
        # Days-only marker: a run of [MTWRFSU] of length 2-7 surrounded by spaces,
        # appearing AFTER the credits number. Heuristic: find a token that's
        # all day letters and at least 2 chars long.
        # Days-only marker must be preceded by a credits number (otherwise
        # words like "FT" in "Cont - FT 0 TBA" get misread as Friday-Tuesday).
        days_m = re.search(r"(?<=\d\s)([MTWRFSU](?:[ MTWRFSU]*[MTWRFSU])?)(?=\s+\d|\s*$)", rest)
        marker = None
        if tba_m and days_m:
            marker = tba_m if tba_m.start() < days_m.start() else days_m
        else:
            marker = tba_m or days_m
        if not marker:
            # Fallback: no time/TBA/days. Treat whole line as title+credits+trailing.
            # Credits parser will peel off the last number; the title gets the rest.
            # Trailing cap/fees/attrs end up appended to the title — acceptable
            # since these are unscheduled rows (ensembles, etc.) and rare.
            before = rest
            time_start = time_end = None
            days = []
            attributes = []
        else:
            before = rest[: marker.start()].rstrip()
            time_start = time_end = None
            days = []
            attributes = parse_attributes(rest[marker.end():])

    # `before` is now: [optional XL code] Title Credits
    title_part, credits = parse_credits_from_end(before)

    # XL: an optional 2-4 char ALL-CAPS code at the start of title_part.
    # Heuristic: if first word is 2-4 uppercase letters AND there are more
    # words after it, treat it as XL. Words like "GB", "GC", "VT", "EL"...
    # But many titles also start with capitalized words ("Intro", "Senior").
    # Real XL codes are ALL CAPS without lowercase. So check that.
    xl = ""
    title_tokens = title_part.split()
    if len(title_tokens) >= 2:
        first = title_tokens[0]
        if 2 <= len(first) <= 4 and first.isupper() and first.isalpha():
            xl = first
            title_tokens = title_tokens[1:]
    title = " ".join(title_tokens)

    meetings = []
    if time_start and days:
        meetings.append({"days": days, "start": time_start, "end": time_end})

    notes = ""
    if not meetings:
        notes = "TBA"

    cls_id = f"{subj}-{num}-{sec}-{crn}"
    return {
        "id": cls_id,
        "crn": crn,
        "code": f"{subj} {num}",
        "department": subj,
        "attributes": attributes,
        "section": sec,
        "quad": quad,
        "xl": xl,
        "title": title,
        "credits": credits,
        "meetings": meetings,
        "notes": notes,
    }


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Convert a Wheaton registration PDF to classes.json.")
    p.add_argument("--semester", required=True,
                   help="Semester id, e.g. fall-2026 or spring-2026.")
    p.add_argument("--input", type=Path, default=None,
                   help="Source PDF path. Default: tools/sources/{semester}.pdf.")
    p.add_argument("--output", type=Path, default=None,
                   help="Output JSON path. Default: semesters/{semester}/classes.json.")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    pdf_path = args.input or (ROOT / "tools" / "sources" / f"{args.semester}.pdf")
    out_path = args.output or (ROOT / "semesters" / args.semester / "classes.json")

    if not pdf_path.exists():
        print(f"missing {pdf_path}", file=sys.stderr)
        sys.exit(1)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    reader = pypdf.PdfReader(str(pdf_path))
    classes = []
    skipped = 0
    skipped_samples = []
    for page in reader.pages:
        text = page.extract_text() or ""
        for raw in text.splitlines():
            line = raw.strip()
            if not line:
                continue
            # Skip header/footer/table-header lines.
            if TERM_HEADER_RE.match(line):
                continue
            if line.startswith("For most accurate data"):
                continue
            if line.startswith("CRN Subj Num"):
                continue
            if line.startswith("Subject:"):
                continue
            if line.startswith("Page "):
                continue
            # Lines that are continuation/footnote text (no leading 5-digit CRN)
            if not re.match(r"^\d{5}\s", line):
                continue
            row = parse_row(line)
            if row is None:
                skipped += 1
                if len(skipped_samples) < 10:
                    skipped_samples.append(line)
                continue
            classes.append(row)

    out_path.write_text(json.dumps(classes, indent=2))
    print(f"wrote {len(classes)} classes to {out_path}")
    print(f"skipped {skipped} CRN-prefixed rows that didn't parse")
    if skipped_samples:
        print("first 10 unparsed:", file=sys.stderr)
        for s in skipped_samples:
            print(f"  {s}", file=sys.stderr)


if __name__ == "__main__":
    main()
