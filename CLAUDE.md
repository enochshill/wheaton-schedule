# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running

Static site, no build step. Serve from the project root:

```bash
python3 -m http.server 8000        # then open http://localhost:8000
```

Re-generate the catalog after replacing `tools/source.pdf`:

```bash
pip install pypdf
python3 tools/pdf_to_json.py        # writes classes.json at repo root
```

There are no tests, lint config, or framework — `app.js` is loaded as an ES module directly by the browser.

## Architecture

A pygame-free, framework-free static site for assembling a Wheaton College class schedule. Three layers:

1. **PDF → JSON** (`tools/pdf_to_json.py`). One-off heuristic parser. Walks every page of the registration packet PDF with `pypdf`, finds rows starting with a 5-digit CRN, and splits each into structured fields using regex (`ROW_PREFIX_RE`, `TIME_RE`). Handles the messy bits: cross-listed (XL) prefixes, variable credit ranges (`2 TO 4`), TBA / hybrid rows with no time block, and trailing attribute tags mixed in with cap and fee numbers. Rows that don't parse are counted and the first 10 are dumped to stderr — when the packet format changes, the parser will need updating.

2. **Catalog** (`classes.json`). The serialized output. Each class has `id` (synthesized from subj-num-sec-crn), `code`, `department`, `quad` (`"1"`/`"A"`/`"B"`), `meetings: [{days, start, end}]`, `attributes`, `credits`. The app fetches this with cache-busting (`?v=${Date.now()}`) so old shapes don't stick around in the browser.

3. **App** (`app.js`, single ES module, ~600 lines). One `state` object; every mutation calls `renderAll()` which re-renders four UI regions. State is hydrated from `localStorage[STORAGE_KEY]` on load and written back on every change.

### Two views

The app toggles between **weekly** and **finals** view via `state.view`. Most render functions branch on this:

- **Weekly**: 5 day cols (Mon–Fri), shows actual class meetings.
- **Finals**: 4 day cols (Mon–Thu Dec 14–17), shows where each selected class's final exam falls. Driven by `PERIOD_CODES` + `EXAM_SLOTS` tables. `classExamInfo(c)` returns one of: `scheduled` (placed on calendar via period code), `late` (once-weekly ≥4 PM, placed at original day/time), `a-quad` (note: last regular class session), `arrange` (off-grid, instructor arranges), `tba` (no meetings).

The finals exam grid is non-obvious — codes 6/7/E share Thu 1:30–3:30, A/B share Tue 8:00–10:00, and Mon Dec 14 has no scheduled period-code exams (only late-afternoon/night once-weekly classes). When making changes, double-check `EXAM_SLOTS` against the last page of `tools/source.pdf`.

### Quad-aware conflict detection

The semester is split into A quad (first half), B quad (second half), and full-semester. `quadsOverlap(a, b)` encodes that A vs B never conflict (different halves of the semester) but FULL overlaps with both. Two passes run on every render:

- `findConflicts(blocks)` — drives the warning banner. O(n²) but n is small.
- `blocksWithLayout(blocks)` — sweeps each day chronologically, assigns column indices to overlapping blocks for side-by-side layout, but only flags blocks with `.conflict` when the quad-overlap is real (so A vs B classes render side-by-side without the red treatment).

In finals view, all blocks use `quad: "FULL"` so any time-overlap counts as a real exam conflict.

### Calendar layout

The calendar grid is CSS Grid with percent-based block positioning (`pctTop()`, height percentages). The number of day columns is set via inline `gridTemplateColumns` in `renderCalendar()`. Range is fixed: `CAL_START_MIN` (8 AM) to `CAL_END_MIN` (10 PM).
