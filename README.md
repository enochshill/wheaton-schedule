# Wheaton Schedule Builder

A static, browser-based tool for putting together a Wheaton College class schedule for **Fall 2026**. Search the course catalog, filter by department / quad / attribute / credits / start time, drop classes onto a weekly calendar, and see time conflicts highlighted in real time. Selections persist in `localStorage`.

> Always verify in Banner before registering — the catalog data here is a one-time export from the registration packet PDF.

## Running it

It's a static site with no build step. Either open `index.html` directly, or serve the folder so `fetch()` works cleanly:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Project layout

```
schedule/
├── index.html        # markup + topbar / sidebar / calendar shell
├── app.js            # all logic — single ES module, no framework
├── styles.css        # layout + calendar grid styles
├── classes.json      # course catalog the app loads at startup
└── tools/
    ├── source.pdf      # Wheaton Fall 2026 Registration Packet
    └── pdf_to_json.py  # one-off converter: source.pdf -> classes.json
```

## How it works

### 1. Catalog comes from the PDF

`tools/pdf_to_json.py` walks every page of `source.pdf` with `pypdf`, finds rows that start with a 5-digit CRN, and parses each into a structured object:

```json
{
  "id": "AQTS-111-0-83298",
  "crn": "83298",
  "code": "AQTS 111",
  "department": "AQTS",
  "section": "0",
  "quad": "1",
  "xl": "",
  "title": "Intro to Urban Leadership",
  "credits": "2",
  "attributes": [],
  "meetings": [{ "days": ["R"], "start": "11:15", "end": "13:05" }],
  "notes": ""
}
```

The parser handles the messy bits of the packet: cross-listed (XL) prefixes, variable credit ranges (`2 TO 4`), TBA / hybrid rows with no time block, and trailing attribute tags (e.g. `SHAR`, `AAQR`) mixed in with cap and fee numbers. Rows it can't parse are counted and the first 10 are dumped to stderr.

Re-run after replacing `source.pdf`:

```bash
pip install pypdf
python3 tools/pdf_to_json.py
```

Output is written to `classes.json` at the repo root.

### 2. The app (`app.js`)

A single ES module — no framework, no bundler. On load it `fetch`es `classes.json` (cache-busted so old shapes don't stick around in the browser), restores the saved selection from `localStorage`, populates the filter dropdowns from the data itself (departments, attribute tags, credits, distinct start times), and renders.

State lives in one `state` object. Every mutation calls `renderAll()` which re-renders the four UI regions:

- **Search results** (sidebar) — filtered list, capped at 200 with a "refine to narrow" hint
- **Calendar** (main) — Mon–Fri grid, 8 AM–10 PM, percent-positioned blocks
- **Conflict banner** — appears above the calendar when overlaps are detected
- **Unscheduled tray** — TBA classes you've added but that can't be placed on the grid

### 3. Quad-aware conflict detection

Wheaton's semester is split into **A quad** (first half), **B quad** (second half), and **full-semester** classes. The conflict logic accounts for this:

- A vs B = no conflict (they never run at the same time), but they still render side-by-side on the grid so you can see the time shape
- A vs FULL or B vs FULL = real conflict
- FULL vs FULL = real conflict

Two passes happen on every render:

1. `findConflicts()` — straight O(n²) over per-day blocks; small n, easy to read. Powers the warning banner.
2. `blocksWithLayout()` — sweeps each day chronologically, assigns a column index to overlapping blocks (so they sit next to each other), and flags only the truly conflicting ones with a `.conflict` style.

### 4. Persistence

Selected class IDs are JSON-serialized into `localStorage` under the key `schedule.selected`. That's it — nothing leaves the browser.

## Tweaking

- **Calendar window:** `CAL_START_MIN` / `CAL_END_MIN` at the top of `app.js`
- **Result cap:** `MAX_RESULTS` (default 200)
- **Term label:** the `<span class="term">` in `index.html`
- **New term:** drop in a new `source.pdf`, re-run the converter, update the term label
