// Schedule Builder — single-file ES module.
// Loads a per-semester catalog + config, runs search/filter, renders the
// calendar, and detects time conflicts. Selected classes persist to
// localStorage scoped per semester.

const ACTIVE_SEMESTER_KEY = "schedule.activeSemester";
const LEGACY_STORAGE_KEY = "schedule.selected"; // single-semester predecessor
const storageKey = (semesterId) => `schedule.selected.${semesterId}`;

const DAYS = ["M", "T", "W", "R", "F"];
const DAY_LABELS = { M: "Mon", T: "Tue", W: "Wed", R: "Thu", F: "Fri" };
const CAL_START_MIN = 8 * 60;     // 8:00 AM
const CAL_END_MIN = 22 * 60;      // 10:00 PM
const TOTAL_MIN = CAL_END_MIN - CAL_START_MIN;
const MAX_RESULTS = 200;

// Per-semester values, populated by applySemesterConfig() after fetching
// semesters/{id}/config.json. Kept as `let` (instead of const) so the dozen
// reference sites in render functions can stay unchanged across switches.
let FINALS_DAYS = ["M", "T", "W", "R"];
let FINALS_DAY_LABELS = {};
let PERIOD_CODES = [];
let EXAM_SLOTS = {};

const state = {
  semesterId: null,
  semester: null,           // active semester config object
  semesterIndex: null,      // semesters/index.json contents
  classes: [],
  byId: new Map(),
  query: "",
  filterDepts: new Set(),
  filterQuad: "ALL",
  filterTags: new Set(),
  filterCreditBuckets: new Set(),
  filterSlots: new Set(),
  hideTBA: false,
  selectedIds: new Set(),
  view: "weekly",  // "weekly" | "finals"
};

// --- Time utilities ----------------------------------------------------

function toMin(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function fmtTime12(hhmm) {
  let [h, m] = hhmm.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ampm}`;
}

function fmtDays(days) {
  return days.join("");
}

function fmtMeeting(mt) {
  return `${fmtDays(mt.days)} ${fmtTime12(mt.start)}–${fmtTime12(mt.end)}`;
}

// Quad helpers. The PDF's quad column has values "1" (full), "A", "B",
// plus a few rare codes (PF1, H1) we treat as full-semester.
function quadOf(c) {
  const q = (c.quad || "").toUpperCase();
  if (q === "A") return "A";
  if (q === "B") return "B";
  return "FULL";
}
function quadLabel(q) {
  return q === "A" ? "A quad" : q === "B" ? "B quad" : "Full semester";
}
function quadShort(q) {
  return q === "A" ? "A½" : q === "B" ? "B½" : "";
}
// Two blocks only really conflict if their quads share calendar time.
// A and B never overlap (first half vs second half); FULL overlaps with
// everything.
function quadsOverlap(qA, qB) {
  if (qA === "A" && qB === "B") return false;
  if (qA === "B" && qB === "A") return false;
  return true;
}

// --- Credits filter ----------------------------------------------------

const CREDIT_BUCKETS = [
  { id: "0", label: "0 credits",  test: v => v === "0" },
  { id: "1", label: "1 credit",   test: v => v === "1" },
  { id: "2", label: "2 credits",  test: v => v === "2" },
  { id: "3", label: "3 credits",  test: v => v === "3" },
  { id: "4", label: "4 credits",  test: v => v === "4" },
  { id: "variable", label: "Variable (e.g. 2 TO 4)", test: v => /\b(TO|OR)\b/i.test(v) },
];
const OTHER_CREDIT_ID = "other";

function classMatchesAnyCreditBucket(c, ids) {
  const v = c.credits || "";
  if (!v) return false;
  for (const id of ids) {
    if (id === OTHER_CREDIT_ID) {
      if (!CREDIT_BUCKETS.some(b => b.test(v))) return true;
    } else {
      const b = CREDIT_BUCKETS.find(x => x.id === id);
      if (b && b.test(v)) return true;
    }
  }
  return false;
}

// --- Time-slot filter --------------------------------------------------

// Standard undergrad meeting times (from the period-codes appendix). The
// filter dropdown shows these by name; non-matching meeting times collapse
// into a single "Other times" bucket.
function meetingIsMWF(m) {
  return m.days.length > 0 && m.days.every(d => "MWF".includes(d));
}
function meetingIsTR(m) {
  return m.days.length > 0 && m.days.every(d => "TR".includes(d));
}
const TIME_SLOTS = [
  { id: "mwf-1", label: "MWF 8:00 AM",  test: m => meetingIsMWF(m) && m.start === "08:00" },
  { id: "mwf-2", label: "MWF 9:20 AM",  test: m => meetingIsMWF(m) && m.start === "09:20" },
  { id: "mwf-3", label: "MWF 11:35 AM", test: m => meetingIsMWF(m) && m.start === "11:35" },
  { id: "mwf-4", label: "MWF 12:55 PM", test: m => meetingIsMWF(m) && m.start === "12:55" },
  { id: "mwf-5", label: "MWF 2:15 PM",  test: m => meetingIsMWF(m) && m.start === "14:15" },
  { id: "tr-a",  label: "TR 7:30 AM",   test: m => meetingIsTR(m)  && m.start === "07:30" },
  { id: "tr-b",  label: "TR 8:30 AM",   test: m => meetingIsTR(m)  && m.start === "08:30" },
  { id: "tr-c",  label: "TR 11:15 AM",  test: m => meetingIsTR(m)  && m.start === "11:15" },
  { id: "tr-d",  label: "TR 1:15 PM",   test: m => meetingIsTR(m)  && m.start === "13:15" },
  { id: "evening", label: "Evening (after 5 PM)", test: m => toMin(m.start) >= 17 * 60 },
];
const OTHER_SLOT_ID = "other";

function meetingMatchesSlotId(m, slotId) {
  if (slotId === OTHER_SLOT_ID) return !TIME_SLOTS.some(s => s.test(m));
  const slot = TIME_SLOTS.find(s => s.id === slotId);
  return slot ? slot.test(m) : false;
}

function classMatchesAnySlot(c, slotIds) {
  if (!c.meetings.length) return false;
  for (const m of c.meetings) {
    for (const id of slotIds) {
      if (meetingMatchesSlotId(m, id)) return true;
    }
  }
  return false;
}

// --- Finals exam mapping -----------------------------------------------

// Match a class's first meeting against the standard period grid. Returns
// the period code (e.g. "4", "C") or null if the meeting doesn't fit.
function classPeriodCode(c) {
  const m = c.meetings[0];
  if (!m) return null;
  const set = new Set(m.days);
  if (set.size === 0) return null;
  const isMWF = [...set].every(d => "MWF".includes(d));
  const isTR  = [...set].every(d => "TR".includes(d));
  for (const p of PERIOD_CODES) {
    if (p.start !== m.start) continue;
    if (p.days === "MWF" && isMWF) return p.code;
    if (p.days === "TR"  && isTR)  return p.code;
  }
  return null;
}

// What happens to a class during finals week.
//   { kind: "scheduled", code, day, startStr, endStr }   placed on calendar
//   { kind: "late",      day, startStr, endStr }         late-afternoon, original time
//   { kind: "a-quad" }                                    last regular class session
//   { kind: "arrange" }                                   off-grid → arrange w/ instructor
//   { kind: "tba" }                                       no meetings on file
function classExamInfo(c) {
  if (quadOf(c) === "A") return { kind: "a-quad" };
  if (!c.meetings.length) return { kind: "tba" };
  const code = classPeriodCode(c);
  if (code) {
    const slot = EXAM_SLOTS[code];
    return { kind: "scheduled", code, day: slot.day, startStr: slot.start, endStr: slot.end };
  }
  // Late-afternoon / night once-weekly classes meet at their normal time
  // during finals week. Only place if that day is Mon–Thu.
  const m = c.meetings[0];
  if (m.days.length === 1 && toMin(m.start) >= 16 * 60 && "MTWR".includes(m.days[0])) {
    return { kind: "late", day: m.days[0], startStr: m.start, endStr: m.end };
  }
  return { kind: "arrange" };
}

function expandToFinalsBlocks(classes) {
  const blocks = [];
  for (const c of classes) {
    const info = classExamInfo(c);
    if (info.kind !== "scheduled" && info.kind !== "late") continue;
    blocks.push({
      classId: c.id,
      code: c.code,
      title: c.title,
      // No A/B distinction in finals view — every block is on the calendar
      // for the same week, so use FULL so the conflict logic flags overlaps.
      quad: "FULL",
      day: info.day,
      startMin: toMin(info.startStr),
      endMin: toMin(info.endStr),
      startStr: info.startStr,
      endStr: info.endStr,
      examCode: info.code || "",
      examKind: info.kind,
    });
  }
  return blocks;
}

// --- Persistence -------------------------------------------------------

function loadSelected(semesterId) {
  try {
    const raw = localStorage.getItem(storageKey(semesterId));
    if (!raw) return new Set();
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

function saveSelected() {
  if (!state.semesterId) return;
  localStorage.setItem(storageKey(state.semesterId), JSON.stringify([...state.selectedIds]));
}

// One-time migration: the original app stored selections under a single
// global key. Move that into the Fall 2026 namespace if present, then drop
// the legacy key. Idempotent — safe to call on every boot.
function migrateLegacyStorage() {
  const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!legacy) return;
  const target = storageKey("fall-2026");
  if (!localStorage.getItem(target)) {
    localStorage.setItem(target, legacy);
  }
  localStorage.removeItem(LEGACY_STORAGE_KEY);
}

// --- Filtering ---------------------------------------------------------

function filteredClasses() {
  const q = state.query.trim().toLowerCase();
  const out = [];
  for (const c of state.classes) {
    if (state.filterDepts.size > 0 && !state.filterDepts.has(c.department)) continue;
    if (state.filterQuad !== "ALL" && quadOf(c) !== state.filterQuad) continue;
    if (state.filterTags.size > 0) {
      const tags = c.attributes || [];
      if (!tags.some(t => state.filterTags.has(t))) continue;
    }
    if (state.filterCreditBuckets.size > 0) {
      if (!classMatchesAnyCreditBucket(c, state.filterCreditBuckets)) continue;
    }
    if (q) {
      const hay = `${c.code} ${c.title} ${c.department}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    if (state.filterSlots.size > 0) {
      if (!classMatchesAnySlot(c, state.filterSlots)) continue;
    }
    if (state.hideTBA && !c.meetings.length) continue;
    out.push(c);
  }
  return out;
}

// --- Conflict detection ------------------------------------------------

function expandToBlocks(classes) {
  // Flatten selected classes into per-day blocks.
  const blocks = [];
  for (const c of classes) {
    const q = quadOf(c);
    for (const mt of c.meetings) {
      for (const d of mt.days) {
        blocks.push({
          classId: c.id,
          code: c.code,
          title: c.title,
          quad: q,
          day: d,
          startMin: toMin(mt.start),
          endMin: toMin(mt.end),
          startStr: mt.start,
          endStr: mt.end,
        });
      }
    }
  }
  return blocks;
}

function findConflicts(blocks) {
  // Returns deduped conflict entries: [{ days: ["T","R"], classes: [block, ...] }]
  // Same set of classes conflicting on multiple days collapses to one entry.
  // Avoids both the C(n,2) pair-explosion AND the per-day duplicates a TR
  // class pair would otherwise produce.
  const n = blocks.length;
  const adj = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = blocks[i], b = blocks[j];
      if (a.day !== b.day) continue;
      if (a.startMin >= b.endMin || b.startMin >= a.endMin) continue;
      if (!quadsOverlap(a.quad, b.quad)) continue;
      adj[i].push(j);
      adj[j].push(i);
    }
  }
  // Per-day connected components.
  const seen = new Array(n).fill(false);
  const dayClusters = [];
  for (let i = 0; i < n; i++) {
    if (seen[i] || adj[i].length === 0) continue;
    const stack = [i];
    const comp = [];
    while (stack.length) {
      const v = stack.pop();
      if (seen[v]) continue;
      seen[v] = true;
      comp.push(blocks[v]);
      for (const u of adj[v]) if (!seen[u]) stack.push(u);
    }
    if (comp.length >= 2) dayClusters.push(comp);
  }
  // Group day-clusters that share the same set of class IDs.
  const allDays = state.view === "finals" ? FINALS_DAYS : DAYS;
  const byKey = new Map();
  for (const cluster of dayClusters) {
    const ids = [...new Set(cluster.map(b => b.classId))].sort();
    const key = ids.join("|");
    if (!byKey.has(key)) {
      byKey.set(key, { ids, days: new Set(), blockByClass: new Map() });
    }
    const entry = byKey.get(key);
    entry.days.add(cluster[0].day);
    for (const b of cluster) {
      if (!entry.blockByClass.has(b.classId)) entry.blockByClass.set(b.classId, b);
    }
  }
  return [...byKey.values()].map(e => ({
    days: [...e.days].sort((a, b) => allDays.indexOf(a) - allDays.indexOf(b)),
    classes: e.ids.map(id => e.blockByClass.get(id)),
  }));
}

function blocksWithLayout(blocks) {
  // Lay overlapping blocks (same day, overlapping times) side-by-side,
  // regardless of quad. Mark a block as `conflict` only if it has a true
  // quad-overlapping neighbor (A vs B = visual split but no conflict).
  const out = blocks.map(b => ({ ...b, col: 0, totalCols: 1, conflict: false }));
  for (const day of DAYS) {
    const dayBlocks = out.filter(b => b.day === day).sort((a, b) => a.startMin - b.startMin);
    if (dayBlocks.length === 0) continue;
    const active = []; // { block, col }
    let groupBlocks = [];
    const finishGroup = () => {
      if (groupBlocks.length > 1) {
        const cols = Math.max(...groupBlocks.map(b => b.col)) + 1;
        for (const b of groupBlocks) b.totalCols = cols;
        // Per-block conflict: another block in the group overlaps in time
        // AND has an overlapping quad.
        for (const b of groupBlocks) {
          for (const other of groupBlocks) {
            if (other === b) continue;
            const timeOverlap = b.startMin < other.endMin && other.startMin < b.endMin;
            if (timeOverlap && quadsOverlap(b.quad, other.quad)) {
              b.conflict = true;
              break;
            }
          }
        }
      }
      groupBlocks = [];
    };
    for (const block of dayBlocks) {
      for (let i = active.length - 1; i >= 0; i--) {
        if (active[i].block.endMin <= block.startMin) active.splice(i, 1);
      }
      if (active.length === 0) finishGroup();
      const used = new Set(active.map(a => a.col));
      let col = 0;
      while (used.has(col)) col++;
      block.col = col;
      active.push({ block, col });
      groupBlocks.push(block);
    }
    finishGroup();
  }
  return out;
}

// --- Rendering ---------------------------------------------------------

function renderDeptFilter() {
  const wrap = document.getElementById("dept-filter");
  const counts = new Map();
  for (const c of state.classes) {
    counts.set(c.department, (counts.get(c.department) || 0) + 1);
  }
  const options = [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([d, n]) => ({ value: d, label: d, count: n }));
  renderMultiFilter(wrap, options, state.filterDepts, "dept");
}

// Render a multi-select dropdown into `wrap`. `options` is [{value, label, count}].
// `selected` is a Set the caller mutates. `singularLabel` ("tag", "start time")
// is used for the summary text.
function renderMultiFilter(wrap, options, selected, singularLabel) {
  const summaryFor = () => {
    const n = selected.size;
    if (n === 0) return `Any ${singularLabel}`;
    if (n === 1) return `${singularLabel}: ${[...selected][0]}`;
    return `${n} ${singularLabel}s`;
  };
  const opts = options.map(o => `
    <label class="mf-opt">
      <input type="checkbox" value="${escapeHtml(o.value)}" ${selected.has(o.value) ? "checked" : ""}>
      <span class="mf-name">${escapeHtml(o.label)}</span>
      <span class="mf-count">${o.count ?? ""}</span>
    </label>
  `).join("");
  wrap.innerHTML = `
    <details class="multi-filter">
      <summary class="multi-filter-btn"><span class="mf-summary-text">${escapeHtml(summaryFor())}</span></summary>
      <div class="multi-filter-menu">
        <div class="mf-header">
          <span>Select multiple</span>
          <button type="button" class="mf-clear">Clear</button>
        </div>
        ${opts}
      </div>
    </details>
  `;
  const updateSummary = () => {
    wrap.querySelector(".mf-summary-text").textContent = summaryFor();
  };
  wrap.addEventListener("change", e => {
    if (!e.target.matches('input[type="checkbox"]')) return;
    const v = e.target.value;
    if (e.target.checked) selected.add(v);
    else selected.delete(v);
    updateSummary();
    renderResults();
  });
  wrap.querySelector(".mf-clear").addEventListener("click", e => {
    e.preventDefault();
    if (selected.size === 0) return;
    selected.clear();
    wrap.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
    updateSummary();
    renderResults();
  });
}

function renderStartTimeFilter() {
  const wrap = document.getElementById("start-filter");
  // Count how many classes have at least one meeting matching each slot.
  const counts = new Map();
  for (const s of TIME_SLOTS) counts.set(s.id, 0);
  counts.set(OTHER_SLOT_ID, 0);
  for (const c of state.classes) {
    if (!c.meetings.length) continue;
    const matched = new Set();
    for (const m of c.meetings) {
      let inAny = false;
      for (const slot of TIME_SLOTS) {
        if (slot.test(m)) { matched.add(slot.id); inAny = true; }
      }
      if (!inAny) matched.add(OTHER_SLOT_ID);
    }
    for (const id of matched) counts.set(id, counts.get(id) + 1);
  }
  const options = [
    ...TIME_SLOTS.map(s => ({ value: s.id, label: s.label, count: counts.get(s.id) })),
    { value: OTHER_SLOT_ID, label: "Other times", count: counts.get(OTHER_SLOT_ID) },
  ];
  renderMultiFilter(wrap, options, state.filterSlots, "time slot");
}

function renderTagFilter() {
  const wrap = document.getElementById("tag-filter");
  const counts = new Map();
  for (const c of state.classes) {
    for (const a of c.attributes || []) counts.set(a, (counts.get(a) || 0) + 1);
  }
  const options = [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([t, n]) => ({ value: t, label: t, count: n }));
  renderMultiFilter(wrap, options, state.filterTags, "tag");
}

function renderCreditsFilter() {
  const wrap = document.getElementById("credits-filter");
  const counts = new Map();
  for (const b of CREDIT_BUCKETS) counts.set(b.id, 0);
  counts.set(OTHER_CREDIT_ID, 0);
  for (const c of state.classes) {
    const v = c.credits || "";
    if (!v) continue;
    let matched = false;
    for (const b of CREDIT_BUCKETS) {
      if (b.test(v)) { counts.set(b.id, counts.get(b.id) + 1); matched = true; break; }
    }
    if (!matched) counts.set(OTHER_CREDIT_ID, counts.get(OTHER_CREDIT_ID) + 1);
  }
  const options = [
    ...CREDIT_BUCKETS.map(b => ({ value: b.id, label: b.label, count: counts.get(b.id) })),
    { value: OTHER_CREDIT_ID, label: "Other", count: counts.get(OTHER_CREDIT_ID) },
  ];
  renderMultiFilter(wrap, options, state.filterCreditBuckets, "credit option");
}

function renderResults() {
  const list = document.getElementById("results");
  const counter = document.getElementById("result-count");
  const all = filteredClasses();
  const shown = all.slice(0, MAX_RESULTS);
  counter.textContent = all.length > MAX_RESULTS
    ? `Showing first ${MAX_RESULTS} of ${all.length} matches — refine filters to narrow.`
    : `${all.length} match${all.length === 1 ? "" : "es"}`;

  list.innerHTML = "";
  for (const c of shown) {
    const li = document.createElement("li");
    li.className = "result-row";
    const meetings = c.meetings.length
      ? c.meetings.map(m => `<span class="pill">${escapeHtml(fmtMeeting(m))}</span>`).join("")
      : `<span class="pill tba">TBA / unscheduled</span>`;
    const q = quadOf(c);
    const quadPill = `<span class="pill quad-${q.toLowerCase()}">${escapeHtml(quadLabel(q))}</span>`;
    const creditsPill = c.credits
      ? `<span class="pill">${escapeHtml(c.credits)} cr</span>`
      : "";
    const tagPills = (c.attributes || [])
      .map(a => `<span class="pill tag">${escapeHtml(a)}</span>`)
      .join("");
    const isSelected = state.selectedIds.has(c.id);
    li.innerHTML = `
      <div class="result-meta">
        <div>
          <span class="result-code">${escapeHtml(c.code)}${c.crn ? ` <span class="section">· CRN ${escapeHtml(c.crn)}</span>` : ""}</span>
        </div>
        <div class="result-title" title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</div>
        <div class="result-when">${quadPill}${creditsPill}${tagPills}${meetings}</div>
      </div>
      <button class="add-btn" data-id="${escapeHtml(c.id)}" ${isSelected ? "disabled" : ""}>
        ${isSelected ? "Added" : "+ Add"}
      </button>
    `;
    list.appendChild(li);
  }
}

function pctTop(min) {
  return ((min - CAL_START_MIN) / TOTAL_MIN) * 100;
}

function renderCalendar() {
  const cal = document.getElementById("calendar");
  cal.innerHTML = "";

  const isFinals = state.view === "finals";
  const days = isFinals ? FINALS_DAYS : DAYS;
  const labels = isFinals ? FINALS_DAY_LABELS : DAY_LABELS;
  cal.classList.toggle("finals", isFinals);
  cal.style.gridTemplateColumns = `50px repeat(${days.length}, 1fr)`;

  // Header row: empty corner + day labels.
  const corner = document.createElement("div");
  corner.className = "cal-corner";
  cal.appendChild(corner);
  for (const d of days) {
    const head = document.createElement("div");
    head.className = "cal-day-head";
    const parts = labels[d].split(" · ");
    if (parts.length === 2) {
      head.innerHTML = `<span class="cdh-primary">${escapeHtml(parts[0])}</span><span class="cdh-secondary">${escapeHtml(parts[1])}</span>`;
    } else {
      head.textContent = labels[d];
    }
    cal.appendChild(head);
  }

  // Time column with hour labels.
  const timeCol = document.createElement("div");
  timeCol.className = "cal-time-col";
  for (let m = CAL_START_MIN; m < CAL_END_MIN; m += 60) {
    const label = document.createElement("div");
    label.className = "cal-hour-label";
    label.textContent = fmtTime12(`${Math.floor(m / 60)}:00`);
    label.style.top = `${pctTop(m)}%`;
    timeCol.appendChild(label);
  }
  cal.appendChild(timeCol);

  // Day columns with hour/half-hour gridlines.
  const dayCols = {};
  for (const d of days) {
    const col = document.createElement("div");
    col.className = "cal-day-col";
    col.dataset.day = d;
    for (let m = CAL_START_MIN; m <= CAL_END_MIN; m += 30) {
      const line = document.createElement("div");
      line.className = m % 60 === 0 ? "cal-hour-line" : "cal-half-line";
      line.style.top = `${pctTop(m)}%`;
      col.appendChild(line);
    }
    cal.appendChild(col);
    dayCols[d] = col;
  }

  // Place blocks (percent-based positioning so the calendar fits its
  // container regardless of viewport size).
  const selected = [...state.selectedIds].map(id => state.byId.get(id)).filter(Boolean);
  const blocks = isFinals ? expandToFinalsBlocks(selected) : expandToBlocks(selected);
  const laid = blocksWithLayout(blocks);
  for (const b of laid) {
    const col = dayCols[b.day];
    if (!col) continue;
    const topP = pctTop(b.startMin);
    const heightP = ((b.endMin - b.startMin) / TOTAL_MIN) * 100;
    const widthPct = 100 / b.totalCols;
    const leftPct = b.col * widthPct;
    const el = document.createElement("div");
    el.className = "cal-block" + (b.conflict ? " conflict" : "") + ` quad-${b.quad.toLowerCase()}`;
    el.style.top = `${Math.max(topP, 0)}%`;
    el.style.height = `${heightP}%`;
    el.style.left = `calc(${leftPct}% + 1px)`;
    el.style.width = `calc(${widthPct}% - 2px)`;
    if (isFinals) {
      const codeNote = b.examKind === "late"
        ? "at original meeting time"
        : `period ${b.examCode}`;
      el.title = `${b.code} ${b.title}\nFinal exam: ${fmtTime12(b.startStr)}–${fmtTime12(b.endStr)} (${codeNote})\nClick to remove`;
      const badge = b.examKind === "late"
        ? `<span class="b-quad">late</span>`
        : `<span class="b-quad">${escapeHtml(b.examCode)}</span>`;
      el.innerHTML = `
        <span class="b-code">${badge}${escapeHtml(b.code)}</span>
        <span class="b-title">${escapeHtml(b.title)}</span>
        <span class="b-time">${escapeHtml(fmtTime12(b.startStr))}–${escapeHtml(fmtTime12(b.endStr))}</span>
      `;
    } else {
      el.title = `${b.code} ${b.title} (${quadLabel(b.quad)})\n${fmtTime12(b.startStr)}–${fmtTime12(b.endStr)}\nClick to remove`;
      const quadBadge = b.quad === "FULL"
        ? ""
        : `<span class="b-quad">${escapeHtml(quadShort(b.quad))}</span>`;
      el.innerHTML = `
        <span class="b-code">${quadBadge}${escapeHtml(b.code)}</span>
        <span class="b-title">${escapeHtml(b.title)}</span>
        <span class="b-time">${escapeHtml(fmtTime12(b.startStr))}–${escapeHtml(fmtTime12(b.endStr))}</span>
      `;
    }
    el.addEventListener("click", () => removeClass(b.classId));
    col.appendChild(el);
  }
}

function renderConflictBanner() {
  const banner = document.getElementById("conflict-banner");
  const isFinals = state.view === "finals";
  const selected = [...state.selectedIds].map(id => state.byId.get(id)).filter(Boolean);
  const blocks = isFinals ? expandToFinalsBlocks(selected) : expandToBlocks(selected);
  const clusters = findConflicts(blocks);
  if (clusters.length === 0) {
    banner.classList.add("hidden");
    banner.innerHTML = "";
    return;
  }
  banner.classList.remove("hidden");
  // Preserve open/closed state across re-renders.
  const wasOpen = banner.querySelector("details")?.open ?? false;
  const items = clusters.map(entry => {
    const days = entry.days.map(d => DAY_LABELS[d]).join(", ");
    const parts = entry.classes.map(b =>
      `<strong>${escapeHtml(b.code)}</strong> <span class="cf-time">${escapeHtml(minToStr(b.startMin))}–${escapeHtml(minToStr(b.endMin))}</span>`
    ).join(" &harr; ");
    return `<li><span class="cf-day">${escapeHtml(days)}</span> ${parts}</li>`;
  }).join("");
  const noun = isFinals ? "exam conflict" : "time conflict";
  const heading = `⚠ ${clusters.length} ${noun}${clusters.length === 1 ? "" : "s"}`;
  banner.innerHTML = `
    <details${wasOpen ? " open" : ""}>
      <summary>${heading} <span class="cf-hint">click for details</span></summary>
      <ul>${items}</ul>
    </details>
  `;
}

function renderUnscheduledTray() {
  const tray = document.getElementById("unscheduled-tray");
  const list = document.getElementById("unscheduled-list");
  const heading = tray.querySelector("h3");
  const selected = [...state.selectedIds].map(id => state.byId.get(id)).filter(Boolean);

  let groups; // [{ label, items: [{c, note}] }]
  if (state.view === "finals") {
    const aQuad = [], arrange = [], tba = [];
    for (const c of selected) {
      const info = classExamInfo(c);
      if (info.kind === "a-quad") aQuad.push(c);
      else if (info.kind === "arrange") arrange.push(c);
      else if (info.kind === "tba") tba.push(c);
    }
    groups = [
      { label: "A quad — final on last regular class session", items: aQuad },
      { label: "Off-grid — arrange with instructor", items: arrange },
      { label: "TBA / unscheduled", items: tba },
    ].filter(g => g.items.length);
    if (heading) heading.textContent = "Finals notes";
  } else {
    const tba = selected.filter(c => !c.meetings.length);
    groups = tba.length ? [{ label: "Unscheduled (TBA)", items: tba }] : [];
    if (heading) heading.textContent = "Unscheduled (TBA)";
  }

  if (groups.length === 0) {
    tray.classList.add("hidden");
    list.innerHTML = "";
    return;
  }
  tray.classList.remove("hidden");
  list.innerHTML = "";
  for (const g of groups) {
    if (state.view === "finals") {
      const labelLi = document.createElement("li");
      labelLi.className = "tray-group-label";
      labelLi.textContent = g.label;
      list.appendChild(labelLi);
    }
    for (const c of g.items) {
      const li = document.createElement("li");
      li.textContent = `${c.code} — ${c.title} ✕`;
      li.title = "Click to remove";
      li.addEventListener("click", () => removeClass(c.id));
      list.appendChild(li);
    }
  }
}

function renderSummary() {
  const sel = [...state.selectedIds].map(id => state.byId.get(id)).filter(Boolean);
  const total = sel.reduce((acc, c) => {
    // credits may be "4", "0.5", "2 TO 4" — best-effort sum: take the first number.
    const n = parseFloat(c.credits);
    return acc + (isFinite(n) ? n : 0);
  }, 0);
  const summary = document.getElementById("schedule-summary");
  summary.textContent = sel.length
    ? `${sel.length} class${sel.length === 1 ? "" : "es"} · ~${total} credits`
    : "No classes selected";
}

function renderAll() {
  renderResults();
  renderCalendar();
  renderConflictBanner();
  renderFinalsLegend();
  renderUnscheduledTray();
  renderSummary();
}

function renderFinalsLegend() {
  const el = document.getElementById("finals-legend");
  if (!el) return;
  if (state.view !== "finals") {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  el.classList.remove("hidden");
  const mwf = PERIOD_CODES.filter(p => p.days === "MWF")
    .map(p => `<span class="leg-pill"><b>${p.code}</b> ${fmtTime12(p.start)}</span>`)
    .join("");
  const tr = PERIOD_CODES.filter(p => p.days === "TR")
    .map(p => `<span class="leg-pill"><b>${p.code}</b> ${fmtTime12(p.start)}</span>`)
    .join("");
  el.innerHTML = `
    <div class="leg-row"><span class="leg-label">MWF</span>${mwf}</div>
    <div class="leg-row"><span class="leg-label">TR</span>${tr}</div>
  `;
}

// --- Mutations ---------------------------------------------------------

function addClass(id) {
  if (!state.byId.has(id)) return;
  state.selectedIds.add(id);
  saveSelected();
  renderAll();
}

function removeClass(id) {
  state.selectedIds.delete(id);
  saveSelected();
  renderAll();
}

function clearAll() {
  if (state.selectedIds.size === 0) return;
  if (!confirm("Remove all classes from your schedule?")) return;
  state.selectedIds.clear();
  saveSelected();
  renderAll();
}

// --- Helpers -----------------------------------------------------------

function minToStr(m) {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return fmtTime12(`${h}:${String(mm).padStart(2, "0")}`);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- Semester loading --------------------------------------------------

const cacheBust = (url) => `${url}${url.includes("?") ? "&" : "?"}v=${Date.now()}`;

async function fetchJson(url) {
  const resp = await fetch(cacheBust(url), { cache: "no-store" });
  if (!resp.ok) throw new Error(`${url}: ${resp.status} ${resp.statusText}`);
  return resp.json();
}

function applySemesterConfig(cfg) {
  state.semester = cfg;
  state.semesterId = cfg.id;
  PERIOD_CODES = cfg.periodCodes || [];
  EXAM_SLOTS = cfg.examSlots || {};
  FINALS_DAYS = cfg.finalsDays || ["M", "T", "W", "R"];
  FINALS_DAY_LABELS = cfg.finalsDayLabels || {};
  document.title = `Wheaton Schedule Builder · ${cfg.label}`;
}

async function loadSemester(semesterId) {
  const [cfg, classes] = await Promise.all([
    fetchJson(`semesters/${semesterId}/config.json`),
    fetchJson(`semesters/${semesterId}/classes.json`),
  ]);
  applySemesterConfig(cfg);
  state.classes = classes;
  state.byId = new Map(classes.map(c => [c.id, c]));
  state.selectedIds = loadSelected(semesterId);
  localStorage.setItem(ACTIVE_SEMESTER_KEY, semesterId);
}

async function switchSemester(semesterId) {
  if (semesterId === state.semesterId) return;
  // Reset filter state — departments/tags differ across semesters and a
  // stale dept filter would silently zero the result list.
  state.query = "";
  state.filterDepts = new Set();
  state.filterTags = new Set();
  state.filterCreditBuckets = new Set();
  state.filterSlots = new Set();
  state.filterQuad = "ALL";
  await loadSemester(semesterId);
  // Reflect cleared filters in the inputs.
  const queryEl = document.getElementById("query");
  if (queryEl) queryEl.value = "";
  const quadEl = document.getElementById("quad-filter");
  if (quadEl) quadEl.value = "ALL";
  renderDeptFilter();
  renderStartTimeFilter();
  renderTagFilter();
  renderCreditsFilter();
  renderAll();
}

function populateSemesterPicker() {
  const sel = document.getElementById("semester-picker");
  if (!sel) return;
  const list = (state.semesterIndex.semesters || [])
    .slice()
    .sort((a, b) => (b.order || 0) - (a.order || 0));
  sel.innerHTML = list
    .map(s => `<option value="${escapeHtml(s.id)}"${s.id === state.semesterId ? " selected" : ""}>${escapeHtml(s.label)}</option>`)
    .join("");
}

async function handleIcsDownload() {
  try {
    const { downloadIcs } = await import(cacheBust("./ics.js"));
    const selected = [...state.selectedIds].map(id => state.byId.get(id)).filter(Boolean);
    if (selected.length === 0) {
      alert("Select at least one class before exporting.");
      return;
    }
    const finalsEvents = [];
    for (const c of selected) {
      const info = classExamInfo(c);
      if (info.kind === "scheduled" || info.kind === "late") {
        finalsEvents.push({ classId: c.id, code: c.code, title: c.title, ...info });
      }
    }
    downloadIcs(state.semester, selected, finalsEvents, quadOf);
  } catch (err) {
    alert(`Failed to build .ics: ${err.message}`);
    throw err;
  }
}

// --- Wire up -----------------------------------------------------------

async function init() {
  migrateLegacyStorage();
  state.semesterIndex = await fetchJson("semesters/index.json");
  const stored = localStorage.getItem(ACTIVE_SEMESTER_KEY);
  const knownIds = new Set((state.semesterIndex.semesters || []).map(s => s.id));
  const startId = (stored && knownIds.has(stored)) ? stored : state.semesterIndex.default;
  await loadSemester(startId);

  populateSemesterPicker();
  renderDeptFilter();
  renderStartTimeFilter();
  renderTagFilter();
  renderCreditsFilter();

  document.getElementById("semester-picker").addEventListener("change", e => {
    switchSemester(e.target.value).catch(err => {
      alert(`Failed to load semester: ${err.message}`);
      // Roll the picker back to the still-active semester.
      e.target.value = state.semesterId;
    });
  });
  document.getElementById("query").addEventListener("input", e => {
    state.query = e.target.value;
    renderResults();
  });
  document.getElementById("quad-filter").addEventListener("change", e => {
    state.filterQuad = e.target.value;
    renderResults();
  });
  // Close any open multi-filter dropdown when clicking outside or opening another.
  document.addEventListener("click", e => {
    document.querySelectorAll(".multi-filter[open]").forEach(d => {
      if (!d.contains(e.target)) d.open = false;
    });
  });
  document.querySelectorAll(".multi-filter-wrap").forEach(wrap => {
    wrap.addEventListener("toggle", e => {
      if (!e.target.open) return;
      document.querySelectorAll(".multi-filter[open]").forEach(d => {
        if (d !== e.target) d.open = false;
      });
    }, true);
  });
  document.getElementById("hide-tba").addEventListener("change", e => {
    state.hideTBA = e.target.checked;
    renderResults();
  });
  document.getElementById("results").addEventListener("click", e => {
    const btn = e.target.closest(".add-btn");
    if (!btn || btn.disabled) return;
    addClass(btn.dataset.id);
  });
  document.getElementById("clear-btn").addEventListener("click", clearAll);
  document.getElementById("view-toggle").addEventListener("click", toggleView);
  document.getElementById("ics-btn").addEventListener("click", handleIcsDownload);

  updateViewToggleLabel();
  renderAll();
}

function toggleView() {
  state.view = state.view === "weekly" ? "finals" : "weekly";
  updateViewToggleLabel();
  renderAll();
}

function updateViewToggleLabel() {
  const btn = document.getElementById("view-toggle");
  if (!btn) return;
  btn.textContent = state.view === "weekly" ? "Final exams" : "Weekly view";
}

init().catch(err => {
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<div style="padding:20px;color:#dc2626">Failed to load schedule data: ${escapeHtml(err.message)}</div>`,
  );
});
