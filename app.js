// Schedule Builder — single-file ES module.
// Loads classes.json, runs search/filter, renders the calendar, and detects
// time conflicts. Selected classes persist to localStorage.

const STORAGE_KEY = "schedule.selected";
const DAYS = ["M", "T", "W", "R", "F"];
const DAY_LABELS = { M: "Mon", T: "Tue", W: "Wed", R: "Thu", F: "Fri" };
const FINALS_DAYS = ["M", "T", "W", "R"];
const FINALS_DAY_LABELS = {
  M: "Mon · Dec 14",
  T: "Tue · Dec 15",
  W: "Wed · Dec 16",
  R: "Thu · Dec 17",
};
const CAL_START_MIN = 8 * 60;     // 8:00 AM
const CAL_END_MIN = 22 * 60;      // 10:00 PM
const TOTAL_MIN = CAL_END_MIN - CAL_START_MIN;
const MAX_RESULTS = 200;

// Standard class periods (PDF "Period Codes" appendix). Class start time +
// day pattern → period code → finals exam slot.
const PERIOD_CODES = [
  { code: "1", days: "MWF", start: "08:00" },
  { code: "2", days: "MWF", start: "09:20" },
  { code: "3", days: "MWF", start: "11:35" },
  { code: "4", days: "MWF", start: "12:55" },
  { code: "5", days: "MWF", start: "14:15" },
  { code: "6", days: "MWF", start: "15:35" },
  { code: "7", days: "MWF", start: "16:55" },
  { code: "A", days: "TR",  start: "07:30" },
  { code: "B", days: "TR",  start: "08:30" },
  { code: "C", days: "TR",  start: "11:15" },
  { code: "D", days: "TR",  start: "13:15" },
  { code: "E", days: "TR",  start: "15:15" },
];

// Finals-week exam slot per period code.
const EXAM_SLOTS = {
  "1": { day: "W", start: "08:00", end: "10:00" },
  "2": { day: "R", start: "08:00", end: "10:00" },
  "3": { day: "T", start: "10:30", end: "12:30" },
  "4": { day: "R", start: "10:30", end: "12:30" },
  "5": { day: "W", start: "13:30", end: "15:30" },
  // 6, 7, E share Thu 1:30–3:30 (rarely-used slots, combined).
  "6": { day: "R", start: "13:30", end: "15:30" },
  "7": { day: "R", start: "13:30", end: "15:30" },
  // A, B share Tue 8:00–10:00.
  "A": { day: "T", start: "08:00", end: "10:00" },
  "B": { day: "T", start: "08:00", end: "10:00" },
  "C": { day: "W", start: "10:30", end: "12:30" },
  "D": { day: "T", start: "13:30", end: "15:30" },
  "E": { day: "R", start: "13:30", end: "15:30" },
};

const state = {
  classes: [],
  byId: new Map(),
  query: "",
  filterDept: "ALL",
  filterQuad: "ALL",
  filterTag: "ALL",
  filterCredits: "ALL",
  filterStartAt: "",
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

function loadSelected() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

function saveSelected() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...state.selectedIds]));
}

// --- Filtering ---------------------------------------------------------

function filteredClasses() {
  const q = state.query.trim().toLowerCase();
  const startAt = state.filterStartAt;
  const out = [];
  for (const c of state.classes) {
    if (state.filterDept !== "ALL" && c.department !== state.filterDept) continue;
    if (state.filterQuad !== "ALL" && quadOf(c) !== state.filterQuad) continue;
    if (state.filterTag !== "ALL" && !(c.attributes || []).includes(state.filterTag)) continue;
    if (state.filterCredits !== "ALL" && c.credits !== state.filterCredits) continue;
    if (q) {
      const hay = `${c.code} ${c.title} ${c.department}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    if (startAt) {
      // Class must have at least one meeting that starts exactly at this time.
      if (!c.meetings.some(m => m.start === startAt)) continue;
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
  // O(n^2) over blocks — n is small (a student has ~5–8 classes).
  // Two blocks conflict only if same day, overlapping times, AND their
  // quads share semester time (A vs B never conflict).
  const conflicts = [];
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i], b = blocks[j];
      if (a.day !== b.day) continue;
      if (a.startMin >= b.endMin || b.startMin >= a.endMin) continue;
      if (!quadsOverlap(a.quad, b.quad)) continue;
      conflicts.push({ a, b });
    }
  }
  return conflicts;
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
  const sel = document.getElementById("dept-filter");
  const depts = [...new Set(state.classes.map(c => c.department))].sort();
  const current = sel.value || "ALL";
  sel.innerHTML = '<option value="ALL">All depts</option>' +
    depts.map(d => `<option value="${d}">${d}</option>`).join("");
  sel.value = current;
}

function renderStartTimeFilter() {
  const sel = document.getElementById("start-filter");
  // Collect every distinct meeting start time, sort chronologically.
  const set = new Set();
  for (const c of state.classes) {
    for (const m of c.meetings) set.add(m.start);
  }
  const times = [...set].sort();
  const current = sel.value || "";
  sel.innerHTML = '<option value="">Any start time</option>' +
    times.map(t => `<option value="${t}">${fmtTime12(t)}</option>`).join("");
  sel.value = current;
}

function renderTagFilter() {
  const sel = document.getElementById("tag-filter");
  const counts = new Map();
  for (const c of state.classes) {
    for (const a of c.attributes || []) {
      counts.set(a, (counts.get(a) || 0) + 1);
    }
  }
  const tags = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const current = sel.value || "ALL";
  sel.innerHTML = '<option value="ALL">Any tag</option>' +
    tags.map(([t, n]) => `<option value="${t}">${t} (${n})</option>`).join("");
  sel.value = current;
}

function renderCreditsFilter() {
  const sel = document.getElementById("credits-filter");
  const set = new Set();
  for (const c of state.classes) {
    if (c.credits) set.add(c.credits);
  }
  // Sort: numeric simple values first, then ranges.
  const all = [...set];
  const simple = all.filter(v => /^\d+(\.\d+)?$/.test(v))
                    .sort((a, b) => parseFloat(a) - parseFloat(b));
  const ranges = all.filter(v => !/^\d+(\.\d+)?$/.test(v))
                    .sort();
  const current = sel.value || "ALL";
  sel.innerHTML = '<option value="ALL">Any credits</option>' +
    simple.map(v => `<option value="${v}">${v} credit${v === "1" ? "" : "s"}</option>`).join("") +
    ranges.map(v => `<option value="${v}">${v} (variable)</option>`).join("");
  sel.value = current;
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
    head.textContent = labels[d];
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
  const conflicts = findConflicts(blocks);
  if (conflicts.length === 0) {
    banner.classList.add("hidden");
    banner.innerHTML = "";
    return;
  }
  banner.classList.remove("hidden");
  const items = conflicts.map(({ a, b }) => {
    const overlapStart = Math.max(a.startMin, b.startMin);
    const overlapEnd = Math.min(a.endMin, b.endMin);
    const dayLabel = isFinals ? FINALS_DAY_LABELS[a.day] : DAY_LABELS[a.day];
    return `<li>
      <strong>${escapeHtml(a.code)}</strong> &harr;
      <strong>${escapeHtml(b.code)}</strong>
      on ${escapeHtml(dayLabel)} ${escapeHtml(minToStr(overlapStart))}–${escapeHtml(minToStr(overlapEnd))}
    </li>`;
  }).join("");
  const heading = isFinals
    ? `⚠ ${conflicts.length} exam conflict${conflicts.length === 1 ? "" : "s"} detected:`
    : `⚠ ${conflicts.length} time conflict${conflicts.length === 1 ? "" : "s"} detected:`;
  banner.innerHTML = `
    <div>${heading}</div>
    <ul>${items}</ul>
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

// --- Wire up -----------------------------------------------------------

async function init() {
  // Cache-bust so old classes.json (before the attributes column was parsed)
  // doesn't stick around in the browser.
  const resp = await fetch(`classes.json?v=${Date.now()}`, { cache: "no-store" });
  state.classes = await resp.json();
  state.byId = new Map(state.classes.map(c => [c.id, c]));
  state.selectedIds = loadSelected();

  renderDeptFilter();
  renderStartTimeFilter();
  renderTagFilter();
  renderCreditsFilter();

  document.getElementById("query").addEventListener("input", e => {
    state.query = e.target.value;
    renderResults();
  });
  document.getElementById("dept-filter").addEventListener("change", e => {
    state.filterDept = e.target.value;
    renderResults();
  });
  document.getElementById("quad-filter").addEventListener("change", e => {
    state.filterQuad = e.target.value;
    renderResults();
  });
  document.getElementById("tag-filter").addEventListener("change", e => {
    state.filterTag = e.target.value;
    renderResults();
  });
  document.getElementById("credits-filter").addEventListener("change", e => {
    state.filterCredits = e.target.value;
    renderResults();
  });
  document.getElementById("start-filter").addEventListener("change", e => {
    state.filterStartAt = e.target.value;
    renderResults();
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
    `<div style="padding:20px;color:#dc2626">Failed to load classes.json: ${escapeHtml(err.message)}</div>`,
  );
});
