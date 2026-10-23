# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running

Static site, no build step. Serve from the project root:

```bash
python3 -m http.server 8000        # then open http://localhost:8000
```

Re-generate a semester's catalog from Banner (primary source — run in your own PowerShell 7.5+ terminal from the repo root; never paste the API key into chat):

```powershell
pwsh tools/banner_to_json.ps1 -Semester spring-2027 -Refresh   # live pull + convert (~10 min)
pwsh tools/banner_to_json.ps1 -Semester spring-2027 -Offline   # re-convert from cache only
# key: $env:ETHOS_API_KEY or %USERPROFILE%\.ethos-key (same key as the loadsheets repo)
# cache: tools/banner-cache/{semester}/ (gitignored)   output: semesters/{semester}/classes.json
```

Fallback — re-generate from the registration packet PDF:

```bash
# Ubuntu 24.04: system pip is PEP-668 protected, so use a venv.
python3 -m venv .venv && .venv/bin/pip install pypdf
.venv/bin/python tools/pdf_to_json.py --semester fall-2026
# defaults: --input  tools/sources/{semester}.pdf
#          --output semesters/{semester}/classes.json
```

There are no tests, lint config, or framework — `app.js` and `ics.js` are loaded as ES modules directly by the browser.

## Architecture

A pygame-free, framework-free static site for assembling a Wheaton College class schedule. Four layers:

1. **Banner → JSON** (`tools/banner_to_json.ps1`, primary). Pulls one term from the Ellucian Ethos API (`integrate.elluciancloud.com`; POST the key to `/auth` for a ~5-min bearer token) and converts to the same `classes.json` schema the PDF parser emits, so the app is source-agnostic. The site can't call Ethos itself — it's public on GitHub Pages and the key would leak — so this is an offline, user-run step. Non-obvious bits:
   - **Term lookup**: `academic-periods` by code (`YYYY01` spring, `YYYY08` fall; pass `-TermCode` otherwise). Sections are filtered by `reportingAcademicPeriod` (the parent term) — quad sections hang off sub-term periods, so `academicPeriod` would miss them.
   - **Meeting times** come from `instructional-events`, one query per section (the resource 400s on any period filter). Banner's trailing `Z` is decorative — `09:20Z` is 9:20 AM wall-clock; never TZ-convert. Read JSON with `-DateKind String` so PowerShell doesn't auto-shift the datetimes.
   - **Filter**: keep `status.category` open/pending and `catalogDisplay` ≠ hidden (drops cancelled sections, dissertation hours, CSA/ICP placeholders). Matches the packet's coverage closely (Fall 2026: 1,030 of 1,077 packet CRNs, plus post-print additions).
   - **Quad** is derived from section dates vs the modal full-term range (A = starts with the term and ends early; B = mirror; else `"1"`). Banner's full-term `endOn` is the last day of *finals*, not of classes.
   - **Credits**: `min TO max`, or `min OR max` when Banner sets `increment`; section credits fall back to the course's.
   - **Subjects** are de-spaced (`B EC` → `BEC`) to match packet ids.
   - **Attributes** map Banner `courseCategories` GUIDs → packet tags via `tools/banner-attributes.json`. Many-to-one by design: the packet collapses OT/NT/CT/FYS/CAP/… into `SHAR` and WRT/ORAL/LANG/… into `COMP`. Umbrella categories (`THEM` Thematic Core, `DVRS`, `GNED`, …) are intentionally unmapped. The script prints any unmapped category with its code/title — add genuinely new gen-ed tags to the map.
   - For a semester with no `config.json`, writes a **draft** (dates from Banner, mid-term break as holidays, `periodCodes` copied, empty `examSlots`, a `_draft` note) and registers it in `semesters/index.json`.

   **PDF → JSON** (`tools/pdf_to_json.py`, fallback). Heuristic parser. Walks every page of the registration packet PDF with `pypdf`, finds rows starting with a 5-digit CRN, and splits each into structured fields using regex (`ROW_PREFIX_RE`, `TIME_RE`). Handles cross-listed (XL) prefixes, variable credit ranges (`2 TO 4`), TBA / hybrid rows with no time block, and trailing attribute tags mixed in with cap and fee numbers. The page-header skip uses `TERM_HEADER_RE` (matches `(Fall|Spring|Summer|Winter|J-Term)\s+\d{4}\s+Course Schedule`) so it works across semesters. Rows that don't parse are counted and the first 10 are dumped to stderr — when the packet format changes, the parser will need updating.

2. **Per-semester data** (`semesters/{id}/`). Two files per semester:
   - `classes.json` — converter output (Banner or PDF). Each class has `id` (synthesized from subj-num-sec-crn), `code`, `department`, `quad` (`"1"`/`"A"`/`"B"`), `meetings: [{days, start, end}]`, `attributes`, `credits`.
   - `config.json` — hand-built from page 2 of the registration packet ("CALENDAR OF CLASS SESSIONS"): `fullStart`/`fullEnd`, `aQuadStart`/`aQuadEnd`, `bQuadStart`/`bQuadEnd`, `finalsStart`/`finalsEnd`, `finalsDays`, `finalsDayLabels`, `holidays[]` (YYYY-MM-DD), plus the `periodCodes` and `examSlots` tables that drive finals placement.
   - `semesters/index.json` is the registry: `default` semester + ordered list `[{id, label, order}]`. Adding a new semester is a data-only change (no JS edit).

3. **App** (`app.js`, ~970 lines, single ES module). One `state` object; every mutation calls `renderAll()` which re-renders four UI regions. State is hydrated from `localStorage[\`schedule.selected.${id}\`]` on load (per-semester scoped) and written back on every change. `FINALS_DAYS`, `FINALS_DAY_LABELS`, `PERIOD_CODES`, `EXAM_SLOTS` are `let`-bound at module scope and reassigned by `applySemesterConfig(cfg)` after each fetch — keeps the dozen reference sites in render functions unchanged across switches.

4. **ICS export** (`ics.js`). Lazy-imported when the user clicks "Download .ics". Hand-rolled RFC 5545 generator: VTIMEZONE for `America/Chicago`, one weekly `VEVENT` per `(class, meeting)` with `RRULE` bounded by the class's quad window, holiday `EXDATE`s, plus one-off finals `VEVENT`s.

### Multi-semester switching

`init()` reads `semesters/index.json`, picks `localStorage["schedule.activeSemester"]` (falls back to `index.default`), then fetches `config.json` + `classes.json` for that semester in parallel. The `<select id="semester-picker">` in the topbar `<h1>` triggers `switchSemester(id)`, which:

- Clears filter state (departments/tags differ across semesters; a stale dept filter would silently zero the result list).
- Re-fetches config + classes, calls `applySemesterConfig`, rebuilds filter dropdowns, calls `renderAll()`.
- Persists the active id under `schedule.activeSemester`.

Selections live under per-semester keys (`schedule.selected.fall-2026`, `schedule.selected.spring-2026`) so they don't bleed. On load, `remapSelected()` re-points stale ids by CRN (the last id segment) — a Banner refresh can renumber a section, which changes its id but not its CRN. Note `index.default` only applies to first-time visitors; returning users land on their remembered `schedule.activeSemester`. A one-time `migrateLegacyStorage()` runs on every boot to copy any pre-multi-semester `schedule.selected` value into `schedule.selected.fall-2026` and remove the legacy key (idempotent).

### Two views

The app toggles between **weekly** and **finals** view via `state.view`. Most render functions branch on this:

- **Weekly**: 5 day cols (Mon–Fri), shows actual class meetings.
- **Finals**: 4 day cols (`finalsDayLabels` from the active config — e.g. `Mon · Dec 14`...`Thu · Dec 17` for Fall 2026), shows where each selected class's final exam falls. Driven by the active semester's `periodCodes` + `examSlots`. `classExamInfo(c)` returns one of: `scheduled` (placed on calendar via period code), `late` (once-weekly ≥4 PM, placed at original day/time), `a-quad` (note: last regular class session), `pending` (has a period code but the semester's `examSlots` lacks it — the exam grid isn't published yet), `arrange` (off-grid, instructor arranges), `tba` (no meetings).

The finals exam grid is non-obvious — codes 6/7/E share the same Thu 1:30 slot, A/B share an 8 AM slot, and Monday is reserved for late-afternoon/night once-weekly classes (no period-code exams). The day-of-week mapping is **not stable across semesters**: Wheaton publishes a different exam grid each term (e.g. period 1 lands on Wed in Fall 2026 but Tue in Spring 2026). Always transcribe `examSlots` from the last page of *that* semester's registration packet PDF — never copy from another semester.

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

The calendar grid is CSS Grid with percent-based block positioning (`pctTop()`, height percentages). The number of day columns is set via inline `gridTemplateColumns` in `renderCalendar()` (overridden by the `.finals` class on small screens via media queries). Range is fixed: `CAL_START_MIN` (8 AM) to `CAL_END_MIN` (10 PM) — these are layout constants, not per-semester.

### ICS export details

`ics.js` exports `buildIcs(config, classes, finalsEvents, quadOf)` (returns the ICS string) and `downloadIcs(...)` (Blob + `<a download>` click). `app.js` precomputes the finals events list using `classExamInfo()` so `ics.js` stays ignorant of finals semantics.

Non-obvious bits:

- **VTIMEZONE is a static block** (post-2007 US Central DST rules: `BYDAY=2SU;BYMONTH=3` start, `BYDAY=1SU;BYMONTH=11` end). Don't compute DST from JS Date — copy a known-good block.
- **A-quad classes get no separate finals VEVENT.** Their last regular class session within `aQuadEnd` *is* the exam — the recurring weekly RRULE captures it. `scheduled` and `late` finals each get a one-off VEVENT; `arrange` and `tba` get nothing.
- **Date math is epoch-ms based** (`Date.UTC(y,m-1,d)` + integer ms arithmetic). Never use local-tz Date constructors — the dev's machine TZ would shift the day.
- **`UNTIL` for tzid'd events must be UTC.** We use `{windowEnd}T235959Z`, safely past any class meeting time in Central.
- **Holidays in `config.holidays`** become `EXDATE` lines, one per line (not comma-joined — Outlook is finicky). Filter applies only when the holiday's weekday matches one of the meeting's days, so weekend dates in a break list are harmless.
- **CRLF line endings** (Outlook silently fails on bare LF). 75-octet line folding for long `SUMMARY`/`DESCRIPTION`.
- **UID is deterministic** (`{semesterId}-{classId}-(m{idx}|final)@wheaton-schedule`) so re-imports replace rather than duplicate in clients that honor it.
- **Partial-day "no classes before 3pm" days** (Presidents' Day, Faculty Development Day) deliberately do NOT go in `holidays[]` — EXDATE removes the whole day, so it's better to keep those classes visible than nuke the after-3pm sections.

### Adding a new semester

1. Run `pwsh tools/banner_to_json.ps1 -Semester fall-2027` in your own terminal. It writes `classes.json`, a draft `config.json` and the `index.json` entry. Re-run with `-Refresh` any time to pick up registrar changes (the draft config is never overwritten).
   (PDF fallback: drop the packet at `tools/sources/{semester}.pdf` and run `python3 tools/pdf_to_json.py --semester ...`.)
2. Finish the draft config. Holidays come from the public **approved academic calendar PDF** (2026–2032 edition: <https://www.wheaton.edu/__data/assets/file/0017/30464/2026-2032CalendarApprovedFeb2026.pdf> — wheaton.edu 403s bot user-agents, so download with a browser UA). Verify the Banner-derived dates against it too. `examSlots` can stay `{}` until the registrar publishes the exam grid — the app shows "Exam time not yet published" — then transcribe it and delete the `_draft` field. Keep the registrar's exam-schedule PDF as `tools/sources/{semester}-finals.pdf` (e.g. `spring-2027-finals.pdf`).
3. Config field sources (when building by hand from the registration packet) — **two separate sections of the PDF**; never copy another semester's config wholesale, both sections vary per term:
   - **Page 2** ("CALENDAR OF CLASS SESSIONS") for the date fields: `fullStart`/`fullEnd`, `aQuadStart`/`aQuadEnd`, `bQuadStart`/`bQuadEnd`, `finalsStart`/`finalsEnd`, `finalsDayLabels`, and every campus holiday (each break date listed individually in `holidays[]`).
   - **Last page** ("FINAL EXAMINATION SCHEDULE") for `examSlots`. The day-of-week mapping is **not stable across semesters** — period 1 lands on Wed in Fall 2026 but Tue in Spring 2026, A/B move from Tue to Thu, etc. Transcribe the grid cell-by-cell from that semester's PDF. (`periodCodes` *is* stable — that table on the same page lists the standard MWF/TR class meeting times and rarely changes.)
   The Wheaton academic calendar *webpage* is auth-walled (CAS SSO); the approved-calendar PDF above is public.
4. If not using the Banner script, add a `{id, label, order}` entry to `semesters/index.json`. `order` is a sortable integer; convention is `YYYYS` where `S` is `1=spring`, `2=fall` (so newer semesters sort first).

### Responsive layout

Two breakpoints in `styles.css`:

- **≤720 px**: sidebar stacks above the calendar (capped at 50vh, internal scroll), topbar wraps and hides the disclaimer, filter row wraps two-per-row.
- **≤480 px**: day-head dates hide (just "Mon"), block titles hide (code + time only), tighter padding.

The finals day labels use a `Mon · Dec 14` format that's split into `.cdh-primary` / `.cdh-secondary` spans so the date can be hidden separately on phones.

## Deployment

Live at <https://enochshill.github.io/wheaton-schedule/>, served as a static site by GitHub Pages from the `main` branch root. Pushing to `main` auto-rebuilds within ~1 minute. Tags like `v1.0` mark releases.

`index.html` imports `app.js` via a dynamic `import()` with a `Date.now()` query string so browsers don't cache stale JS across deploys. Inside `app.js`, `fetchJson()` cache-busts every fetch (config, catalog, index) the same way, and `ics.js` is similarly imported with a query string.

### WSL git gotcha

Native Linux `git` on a `/mnt/c/...` path fails (`chmod on .git/config.lock failed`) because the 9p mount maps everything to `uid=0`. If this repo ever lives under `/mnt/c/`, use the Windows-side binary instead — `"/mnt/c/Program Files/Git/cmd/git.exe"`. It also bundles Git Credential Manager so HTTPS pushes pop a Windows browser prompt rather than failing on missing creds. When the repo lives under `/home/...` (Linux filesystem), native Linux `git` works fine and the SSH remote handles auth via your `~/.ssh/` keys.
