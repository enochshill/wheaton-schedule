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

- `findConflicts(blocks)` — drives the warning banner. Returns **deduped entries** (`{days: [...], classes: [...]}`), not pairs: connected components by per-day overlap, then collapsed across days by class-set so a TR pair conflicting on Tue *and* Thu reports as one entry. Avoids the C(n,2) pair-explosion when 3+ classes overlap.
- `blocksWithLayout(blocks)` — sweeps each day chronologically, assigns column indices to overlapping blocks for side-by-side layout, but only flags blocks with `.conflict` when the quad-overlap is real (so A vs B classes render side-by-side without the red treatment).

In finals view, all blocks use `quad: "FULL"` so any time-overlap counts as a real exam conflict. Banner is a `<details>` element so it can be collapsed and won't push the calendar off-screen.

### Filters and the multi-filter pattern

Most filters are multi-select via a shared `renderMultiFilter(wrap, options, selectedSet, singularLabel)` helper. Each builds a `<details>` dropdown with checkboxes; the `selectedSet` is a `Set` on `state` that the checkboxes mutate directly. Currently multi: `filterDepts`, `filterTags`, `filterSlots`, `filterCreditBuckets`. Quad is still single-select.

Two filters use **bucketing** instead of raw values, so a long tail of rare values doesn't bloat the dropdown:

- `TIME_SLOTS` — the 9 standard period start times (MWF 8:00/9:20/11:35/12:55/2:15, TR 7:30/8:30/11:15/1:15) plus an "Evening" bucket (≥17:00) and an `OTHER_SLOT_ID` catch-all. A class matches a slot if any of its meetings does.
- `CREDIT_BUCKETS` — 0/1/2/3/4 plus "Variable" (anything with `TO`/`OR`) plus `OTHER_CREDIT_ID` (0.5, 5, 8, 9). Variable-credit classes do **not** match the "4 credits" bucket even when their range includes 4 — variable is treated as materially different.

### Calendar layout

The calendar grid is CSS Grid with percent-based block positioning (`pctTop()`, height percentages). The number of day columns is set via inline `gridTemplateColumns` in `renderCalendar()` (overridden by the `.finals` class on small screens via media queries). Range is fixed: `CAL_START_MIN` (8 AM) to `CAL_END_MIN` (10 PM).

### Responsive layout

Two breakpoints in `styles.css`:

- **≤720 px**: sidebar stacks above the calendar (capped at 50vh, internal scroll), topbar wraps and hides the disclaimer, filter row wraps two-per-row.
- **≤480 px**: day-head dates hide (just "Mon"), block titles hide (code + time only), tighter padding.

The finals day labels use a `Mon · Dec 14` format that's split into `.cdh-primary` / `.cdh-secondary` spans so the date can be hidden separately on phones.

## Deployment

Live at <https://enochshill.github.io/wheaton-schedule/>, served as a static site by GitHub Pages from the `main` branch root. Pushing to `main` auto-rebuilds within ~1 minute. Tags like `v1.0` mark releases.

`index.html` imports `app.js` via a dynamic `import()` with a `Date.now()` query string so browsers don't cache stale JS across deploys. `app.js` itself fetches `classes.json` with the same trick.

### WSL git gotcha

Native Linux `git` on this `/mnt/c/...` path fails (`chmod on .git/config.lock failed`) because the 9p mount maps everything to `uid=0`. Use the Windows-side binary instead — every git invocation in this repo should go through `"/mnt/c/Program Files/Git/cmd/git.exe"`. It also bundles Git Credential Manager so HTTPS pushes pop a Windows browser prompt rather than failing on missing creds.
