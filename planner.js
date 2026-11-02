// Four-Year Planner — single-file ES module.
// Left: eight semesters (plus any summers) with completed, in-progress and
// planned courses. Right: requirement blocks imported from Degree Works,
// with planned courses auto-matched against each "Still needed" rule.
// Everything lives in localStorage — no student data leaves the browser.

import {
  termIdFromLabel, termLabel, termSortKey, nextMainTerm, termForDate,
  normCode, splitCode, parseCredits, isUpperDivision,
  parseRule, parseChoose, ruleMatches, describeRule, evaluatePlan, isSatisfied, walk,
} from "./planner-rules.js";

const PLANS_KEY = "planner.plans";
const LEGACY_PLAN_KEY = "planner.plan"; // single-plan predecessor
const PLAN_VERSION = 1;
const DEFAULT_CREDITS_REQUIRED = 124;
const DEFAULT_UPPER_REQUIRED = 36;
const MAX_RESULTS = 150;

const state = {
  plan: emptyPlan(),         // the active plan (same object as its entry in store.plans)
  store: null,               // { activeId, plans: [{ id, name, updatedAt, plan }] }
  catalog: new Map(),        // code -> { code, title, credits, creditsNum, attributes: Set, terms: Map(termId -> Set(quad)) }
  semesterIndex: null,
  currentTerm: termForDate(new Date()),
  unmetOnly: false,
  collapsed: new Set(),      // block ids collapsed in the requirements pane
  eval: new Map(),           // reqId -> evaluation (see planner-rules.js)
  reqsByUid: new Map(),      // course uid -> [reqId] it counts toward
  dialog: null,              // { term, rule, reqId } while the course dialog is open
  editingUid: null,
  draggingUid: null,
};

function emptyPlan() {
  return { version: PLAN_VERSION, startTerm: null, dw: null, blocks: [], courses: [], overrides: {} };
}

// --- Persistence --------------------------------------------------------

// Several named plans per browser. Each is a full, independent plan; a
// Degree Works re-import refreshes the imported record in all of them.

function newEntry(name, plan = emptyPlan()) {
  return { id: `plan-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, updatedAt: new Date().toISOString(), plan };
}

function loadStore() {
  try {
    const raw = localStorage.getItem(PLANS_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      s.plans = (s.plans || []).filter(e => e.plan?.version === PLAN_VERSION).map(e => ({ ...e, plan: scrubGrades({ ...emptyPlan(), ...e.plan }) }));
      if (s.plans.length) return s;
    }
    const legacy = JSON.parse(localStorage.getItem(LEGACY_PLAN_KEY) || "null");
    const first = newEntry("My plan", legacy?.version === PLAN_VERSION ? { ...emptyPlan(), ...legacy } : emptyPlan());
    // Only drop the old key once the new store is written.
    const store = { activeId: first.id, plans: [first] };
    localStorage.setItem(PLANS_KEY, JSON.stringify(store));
    localStorage.removeItem(LEGACY_PLAN_KEY);
    return store;
  } catch {
    const first = newEntry("My plan");
    return { activeId: first.id, plans: [first] };
  }
}

// Letter grades are never kept: on a shared computer, leftover plans
// should reveal what a student took, not how they did. Only the codes
// that carry meaning here survive (TR = transfer, RE/IP = in progress).
const KEPT_GRADES = /^(TR|RE|IP)$/i;
function keptGrade(g) {
  return KEPT_GRADES.test(g || "") ? g.toUpperCase() : "";
}
function scrubGrades(plan) {
  for (const c of plan.courses || []) c.grade = keptGrade(c.grade);
  return plan;
}

// "Delete all my data on this computer": drop the stored plans and start
// over in memory without writing anything back.
function wipeAll() {
  try {
    localStorage.removeItem(PLANS_KEY);
    localStorage.removeItem(LEGACY_PLAN_KEY);
  } catch { /* private mode */ }
  const first = newEntry("My plan");
  state.store = { activeId: first.id, plans: [first] };
  state.plan = first.plan;
  state.collapsed.clear();
  renderAll();
}

function activeEntry() {
  return state.store.plans.find(e => e.id === state.store.activeId) || state.store.plans[0];
}

function setActive(id) {
  state.store.activeId = id;
  state.plan = activeEntry().plan;
  state.collapsed.clear();
  savePlan({ touch: false });
  renderAll();
}

function savePlan({ touch = true } = {}) {
  if (touch) activeEntry().updatedAt = new Date().toISOString();
  try { localStorage.setItem(PLANS_KEY, JSON.stringify(state.store)); } catch { /* private mode */ }
}

function uniqueName(base) {
  const names = new Set(state.store.plans.map(e => e.name));
  if (!names.has(base)) return base;
  for (let n = 2; ; n++) if (!names.has(`${base} ${n}`)) return `${base} ${n}`;
}

// A fresh plan that keeps the imported Degree Works record but no planning.
function recordOnly(plan) {
  const copy = structuredClone(plan);
  return {
    ...copy,
    courses: copy.courses.filter(c => c.source === "dw"),
    blocks: copy.blocks.filter(b => !b.whatIf),
    overrides: {},
  };
}

async function fetchJson(url) {
  const sep = url.includes("?") ? "&" : "?";
  const res = await fetch(`${url}${sep}v=${Date.now()}`);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

// --- Catalog: every course seen in any semester's classes.json ----------

async function loadCatalog() {
  const index = await fetchJson("semesters/index.json");
  state.semesterIndex = index;
  const lists = await Promise.all(index.semesters.map(s =>
    fetchJson(`semesters/${s.id}/classes.json`).then(cls => ({ s, cls })).catch(() => ({ s, cls: [] }))));
  // Oldest first so the newest term's title/credits win.
  lists.sort((a, b) => a.s.order - b.s.order);
  const catalog = new Map();
  for (const { s, cls } of lists) {
    for (const c of cls) {
      const code = normCode(c.code);
      let e = catalog.get(code);
      if (!e) {
        e = { code, attributes: new Set(), terms: new Map() };
        catalog.set(code, e);
      }
      e.title = c.title;
      e.credits = c.credits;
      e.creditsNum = parseCredits(c.credits);
      c.attributes.forEach(a => e.attributes.add(a));
      if (!e.terms.has(s.id)) e.terms.set(s.id, new Set());
      e.terms.get(s.id).add(c.quad);
    }
  }
  state.catalog = catalog;
}

function attrsFor(course) {
  if (course.attributes?.length) return course.attributes;
  return [...(state.catalog.get(course.code)?.attributes || [])];
}

// A course's quad: stored value, else what that term's sections say
// (only when every section agrees on A or B).
function quadFor(course) {
  if (course.quad && course.quad !== "1") return course.quad;
  const quads = state.catalog.get(course.code)?.terms.get(course.term);
  if (quads && quads.size === 1) {
    const q = [...quads][0];
    if (q === "A" || q === "B") return q;
  }
  return "1";
}

// Most common quad for a code across all catalogs — used when planning.
function defaultQuad(code) {
  const e = state.catalog.get(code);
  if (!e) return "1";
  const all = [...e.terms.values()].flatMap(s => [...s]);
  if (all.length && all.every(q => q === "A")) return "A";
  if (all.length && all.every(q => q === "B")) return "B";
  return "1";
}

function offeredSeasons(e) {
  const seasons = new Set([...e.terms.keys()].map(t => t.split("-")[0]));
  return [...seasons];
}

// --- Degree Works import ------------------------------------------------
//
// Payload (built by dw-import.js, or planner-demo.json):
//   { type: "dw-import", version: 1, whatIf, catalogYear,
//     degree: { title, creditsRequired, creditsApplied, upperDivisionRequired, upperDivisionApplied, notes },
//     blocks: [{ title, creditsRequired, creditsApplied, notes, courses, reqs: [ReqNode] }] }
//   ReqNode: { label, status: "met"|"inprog"|"needed", stillNeeded, courses: [DwCourse], children: [ReqNode] }
//   DwCourse: { code, title, grade, credits, term, satisfiedBy }

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

function blockKind(title) {
  if (/^degree in/i.test(title)) return "degree";
  if (/general education|christ at the core/i.test(title)) return "core";
  if (/^major/i.test(title)) return "major";
  if (/^minor/i.test(title)) return "minor";
  if (/certificate|fellowship|\bFP\b/i.test(title)) return "cert";
  if (/elective/i.test(title)) return "electives";
  return "other";
}
const KIND_ORDER = { degree: 0, core: 1, major: 2, minor: 3, cert: 4, other: 5, electives: 6 };
const KIND_LABEL = { degree: "Degree", core: "Core", major: "Major", minor: "Minor", cert: "Certificate", other: "Program", electives: "Electives" };

function dwCourse(c, courses) {
  const code = normCode(c.code);
  const transfer = c.grade === "TR" || !!c.satisfiedBy;
  const term = transfer ? null : termIdFromLabel(c.term);
  const uid = `dw:${code}:${term || "tr"}`;
  if (!courses.has(uid)) {
    const inprog = /^(RE|IP)$/i.test(c.grade || "") || /^\(.*\)$/.test(String(c.credits).trim());
    courses.set(uid, {
      uid, code, title: c.title || "", credits: parseCredits(c.credits),
      term, termText: c.term || "", quad: "1",
      status: inprog ? "inprog" : "done", grade: keptGrade(c.grade),
      transfer, satisfiedBy: c.satisfiedBy || "", source: "dw",
    });
  }
  return uid;
}

function normalizeBlock(b, courses, whatIf) {
  const blockId = slug(b.title) || "block";
  const seen = new Set();
  const norm = (node, path) => {
    let id = `${blockId}/${[...path, slug(node.label)].join("/")}`;
    for (let n = 2; seen.has(id); n++) id = `${blockId}/${[...path, slug(node.label)].join("/")}-${n}`;
    seen.add(id);
    const kids = (node.children || []).map(k => norm(k, [...path, slug(node.label)]));
    return {
      id,
      label: node.label,
      status: node.status || "info",
      stillNeeded: node.stillNeeded || "",
      rule: kids.length ? null : parseRule(node.stillNeeded),
      choose: parseChoose(node.stillNeeded),
      courseUids: (node.courses || []).map(c => dwCourse(c, courses)),
      children: kids,
    };
  };
  return {
    id: blockId,
    title: b.title,
    kind: blockKind(b.title),
    whatIf: !!whatIf,
    creditsRequired: b.creditsRequired ?? null,
    creditsApplied: b.creditsApplied ?? null,
    notes: b.notes || [],
    courseUids: (b.courses || []).map(c => dwCourse(c, courses)),
    reqs: (b.reqs || []).map(r => norm(r, [])),
  };
}

// What-If imports go into the active plan only; a regular audit refreshes
// the Degree Works record in every saved plan.
function applyImport(p) {
  const targets = p.whatIf ? [state.plan] : state.store.plans.map(e => e.plan);
  let result;
  for (const plan of targets) {
    const r = importInto(plan, p);
    if (plan === state.plan) result = r;
  }
  savePlan();
  const { added, courseCount, blockCount } = result;
  const others = targets.length > 1 ? ` Updated in all ${targets.length} of your plans.` : "";
  const what = p.whatIf
    ? (added.length ? `Added What-If to “${activeEntry().name}”: ${added.map(b => b.title).join(", ")}.` : "That What-If audit had no new programs to add.")
    : `Imported ${courseCount} courses and ${blockCount} requirement blocks${p.demo ? " (demo student)" : " from Degree Works"}.${others}`;
  showBanner(what);
  renderAll();
}

function importInto(plan, p) {
  const courses = new Map();
  const blocks = (p.blocks || []).map(b => normalizeBlock(b, courses, p.whatIf));
  const titles = new Set(plan.blocks.map(b => b.title));
  let added;

  if (p.whatIf) {
    // What-If audits repeat the degree and core blocks; take only the new programs.
    added = blocks.filter(b => !titles.has(b.title) && !["degree", "core", "electives"].includes(b.kind));
    plan.blocks.push(...added);
    const have = new Set(plan.courses.map(c => c.uid));
    plan.courses.push(...[...courses.values()].filter(c => !have.has(c.uid)));
  } else {
    added = blocks;
    const dwKeys = new Set([...courses.values()].map(c => `${c.code}|${c.term}`));
    plan.courses = plan.courses.filter(c =>
      c.source !== "dw" && !(c.status === "planned" && dwKeys.has(`${c.code}|${c.term}`)));
    plan.courses.push(...courses.values());
    const newTitles = new Set(blocks.map(b => b.title));
    plan.blocks = [...blocks, ...plan.blocks.filter(b => b.whatIf && !newTitles.has(b.title))];
    plan.dw = { importedAt: new Date().toISOString(), catalogYear: p.catalogYear || "", degree: p.degree || null, demo: !!p.demo };
  }
  plan.blocks.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  if (!plan.startTerm) {
    const terms = plan.courses.filter(c => c.term && c.source === "dw").map(c => c.term)
      .filter(t => /^(fall|spring)-/.test(t)).sort((a, b) => termSortKey(a) - termSortKey(b));
    plan.startTerm = terms[0] || null;
  }
  return { added, courseCount: courses.size, blockCount: blocks.length };
}

// The bookmarklet opens this page and waits for "planner-ready", then
// posts the payload. Only the opener (the Degree Works tab) is trusted.
function listenForImport() {
  if (!window.opener) return;
  window.addEventListener("message", (e) => {
    if (e.source !== window.opener || e.data?.type !== "dw-import") return;
    applyImport(e.data);
  });
  try { window.opener.postMessage({ type: "planner-ready" }, "*"); } catch { /* opener gone */ }
}

// --- Terms --------------------------------------------------------------

function startTerm() {
  if (state.plan.startTerm) return state.plan.startTerm;
  const cur = state.currentTerm;
  return cur.startsWith("summer") ? `fall-${cur.split("-")[1]}` : cur;
}

// Eight fall/spring terms from the start, the summers between them, and
// any other term a course sits in (a fifth year, a J-term).
function planTerms() {
  const main = [];
  let t = startTerm();
  for (let i = 0; i < 8; i++) { main.push(t); t = nextMainTerm(t); }
  const set = new Set(main);
  const first = termSortKey(main[0]), last = termSortKey(main[7]);
  for (const id of main) {
    const y = Number(id.split("-")[1]);
    const summer = `summer-${y}`;
    if (termSortKey(summer) > first && termSortKey(summer) < last) set.add(summer);
  }
  return { main, all: [...set].sort((a, b) => termSortKey(a) - termSortKey(b)) };
}

function termStatus(id) {
  const d = termSortKey(id) - termSortKey(state.currentTerm);
  return d < 0 ? "done" : d === 0 ? "current" : "future";
}

function canPlanIn(id) {
  return !state.plan.dw || termStatus(id) !== "done";
}

// Academic year a term belongs to: fall Y -> Y; spring/summer Y -> Y-1.
function academicYear(id) {
  const [season, y] = [id.split("-")[0], Number(id.split("-")[1])];
  return season === "fall" ? y : y - 1;
}

// --- Rendering ----------------------------------------------------------

const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function fmtCr(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function evaluate() {
  const enriched = state.plan.courses.map(c => ({ ...c, attributes: attrsFor(c) }));
  state.eval = evaluatePlan(state.plan.blocks, enriched, state.plan.overrides);
  state.reqsByUid = new Map();
  for (const [reqId, ev] of state.eval) {
    for (const uid of [...(ev.applied || []), ...(ev.planned || [])]) {
      if (!state.reqsByUid.has(uid)) state.reqsByUid.set(uid, []);
      state.reqsByUid.get(uid).push(reqId);
    }
  }
}

function renderAll() {
  evaluate();
  renderPlanPicker();
  renderHead();
  renderTransfer();
  renderYears();
  renderReqs();
}

function creditTotals() {
  const plan = state.plan;
  const sum = (pred) => plan.courses.filter(pred).reduce((s, c) => s + c.credits, 0);
  const planned = sum(c => c.status === "planned");
  const plannedUpper = sum(c => c.status === "planned" && isUpperDivision(c.code));
  const deg = plan.dw?.degree;
  // Degree Works' own applied count is authoritative for past work (it
  // knows about courses not shown in any block); fall back to summing.
  const doneAll = sum(c => c.status === "done");
  const inprog = sum(c => c.status === "inprog");
  const applied = deg?.creditsApplied ?? doneAll + inprog;
  const upperApplied = deg?.upperDivisionApplied ?? sum(c => c.status !== "planned" && isUpperDivision(c.code));
  return {
    done: Math.max(0, applied - inprog), inprog, planned,
    required: deg?.creditsRequired ?? DEFAULT_CREDITS_REQUIRED,
    upperApplied, plannedUpper,
    upperRequired: deg?.upperDivisionRequired ?? DEFAULT_UPPER_REQUIRED,
  };
}

function progressBar(parts, total) {
  const segs = parts.map(([cls, n]) =>
    `<span class="bar-seg ${cls}" style="width:${Math.min(100, (n / total) * 100)}%"></span>`).join("");
  return `<div class="bar" role="img">${segs}</div>`;
}

function renderHead() {
  const t = creditTotals();
  const sumAll = t.done + t.inprog + t.planned;
  const upperAll = t.upperApplied + t.plannedUpper;
  const startOpts = [];
  const cy = Number(state.currentTerm.split("-")[1]);
  for (let y = cy - 5; y <= cy + 1; y++) startOpts.push(`spring-${y}`, `fall-${y}`);
  const st = startTerm();
  if (!startOpts.includes(st)) startOpts.push(st);
  startOpts.sort((a, b) => termSortKey(a) - termSortKey(b));

  const dw = state.plan.dw;
  const source = dw
    ? `${dw.demo ? "Demo student" : "Degree Works import"} · ${new Date(dw.importedAt).toLocaleDateString()}${dw.catalogYear ? ` · Catalog ${escapeHtml(dw.catalogYear.replace(/^Academic Year\s*/i, ""))}` : ""}`
    : `No Degree Works data yet — <button type="button" class="link-btn" data-action="open-import">import it</button> or start planning by hand.`;

  $("plan-head").innerHTML = `
    <div class="ph-row">
      <label class="ph-start">First semester
        <select id="start-term">${startOpts.map(id => `<option value="${id}" ${id === st ? "selected" : ""}>${termLabel(id)}</option>`).join("")}</select>
      </label>
      <span class="ph-source">${source}</span>
    </div>
    <div class="ph-bars">
      <div class="ph-bar">
        <div class="ph-bar-label"><strong>Total credits</strong> ${fmtCr(sumAll)} / ${t.required}
          <span class="ph-bar-detail">${fmtCr(t.done)} done · ${fmtCr(t.inprog)} in progress · ${fmtCr(t.planned)} planned${sumAll < t.required ? ` · <b>${fmtCr(t.required - sumAll)} to plan</b>` : ""}</span></div>
        ${progressBar([["seg-done", t.done], ["seg-inprog", t.inprog], ["seg-planned", t.planned]], t.required)}
      </div>
      <div class="ph-bar">
        <div class="ph-bar-label"><strong>Upper division (300+)</strong> ${fmtCr(upperAll)} / ${t.upperRequired}
          <span class="ph-bar-detail">${fmtCr(t.upperApplied)} taken · ${fmtCr(t.plannedUpper)} planned${upperAll < t.upperRequired ? ` · <b>${fmtCr(t.upperRequired - upperAll)} to plan</b>` : ""}</span></div>
        ${progressBar([["seg-done", t.upperApplied], ["seg-planned", t.plannedUpper]], t.upperRequired)}
      </div>
    </div>`;
  $("start-term").addEventListener("change", (e) => {
    state.plan.startTerm = e.target.value;
    savePlan();
    renderAll();
  });

  const summary = $("plan-summary");
  summary.textContent = `${fmtCr(sumAll)} / ${t.required} credits`;
}

function courseChip(c) {
  const q = quadFor(c);
  const reqIds = state.reqsByUid.get(c.uid) || [];
  const counts = reqIds.map(id => findReq(id)?.label).filter(Boolean);
  const tags = attrsFor(c).filter(a => a !== "SHAR");
  const title = [
    `${c.code} — ${c.title}`,
    c.status === "planned" ? "Planned" : c.status === "inprog" ? `In progress${c.grade ? ` (${c.grade})` : ""}` : `Completed${c.grade ? ` · ${c.grade}` : ""}`,
    c.satisfiedBy ? `Satisfied by: ${c.satisfiedBy}` : "",
    counts.length ? `Counts toward: ${counts.join("; ")}` : (c.status === "planned" ? "Not matched to a requirement (general elective)" : ""),
    c.status === "planned" ? "Click to edit · drag to move" : "",
  ].filter(Boolean).join("\n");
  const planned = c.status === "planned";
  return `
    <div class="chip st-${c.status} q-${q}${planned && !counts.length ? " unmatched" : ""}" data-uid="${escapeHtml(c.uid)}"
         ${planned ? `draggable="true" tabindex="0" role="button"` : ""} title="${escapeHtml(title)}">
      <span class="chip-top">
        ${q !== "1" ? `<span class="chip-quad">${q}</span>` : ""}<span class="chip-code">${escapeHtml(c.code)}</span>
        <span class="chip-cr">${fmtCr(c.credits)}</span>
      </span>
      <span class="chip-title">${escapeHtml(c.title)}</span>
      ${tags.length ? `<span class="chip-tags">${tags.map(a => `<span>${escapeHtml(a)}</span>`).join("")}</span>` : ""}
    </div>`;
}

function renderTransfer() {
  const list = state.plan.courses.filter(c => c.transfer);
  const wrap = $("transfer");
  if (!list.length) { wrap.innerHTML = ""; return; }
  const total = list.reduce((s, c) => s + c.credits, 0);
  wrap.innerHTML = `
    <details class="transfer-box" ${list.length <= 6 ? "open" : ""}>
      <summary><strong>Transfer &amp; AP credit</strong> <span class="muted">${list.length} courses · ${fmtCr(total)} credits</span></summary>
      <div class="transfer-chips">${list.map(courseChip).join("")}</div>
    </details>`;
}

function renderYears() {
  const { main, all } = planTerms();
  const byTerm = new Map(all.map(t => [t, []]));
  const orphans = [];
  for (const c of state.plan.courses) {
    if (c.transfer) continue;
    if (c.term && !byTerm.has(c.term)) byTerm.set(c.term, []);
    if (c.term) byTerm.get(c.term).push(c);
    else orphans.push(c);
  }
  // Summers only show when something is in them.
  const shown = [...byTerm.keys()].filter(t => main.includes(t) || byTerm.get(t).length)
    .sort((a, b) => termSortKey(a) - termSortKey(b));
  const years = new Map();
  for (const t of shown) {
    const ay = academicYear(t);
    if (!years.has(ay)) years.set(ay, []);
    years.get(ay).push(t);
  }
  const firstAy = academicYear(main[0]);
  const html = [...years.entries()].map(([ay, terms]) => {
    const n = ay - firstAy + 1;
    const yearLabel = n >= 1 && n <= 4 ? `Year ${n}` : n > 4 ? `Year ${n}` : "Before Year 1";
    const cells = ["fall", "spring", "summer", "winter", "j-term"].map(season => {
      const id = terms.find(t => t.startsWith(`${season}-`));
      if (!id) return season === "fall" || season === "spring" ? `<div class="term empty"></div>` : "";
      return termCard(id, byTerm.get(id) || []);
    }).join("");
    return `
      <section class="year">
        <h2 class="year-label">${yearLabel} <span class="muted">${ay}–${String(ay + 1).slice(2)}</span></h2>
        <div class="year-terms" style="grid-template-columns: repeat(${Math.max(2, cellsCount(terms))}, minmax(0, 1fr))">${cells}</div>
      </section>`;
  }).join("");
  $("years").innerHTML = html + (orphans.length
    ? `<section class="year"><h2 class="year-label">Unscheduled</h2><div class="term-body">${orphans.map(courseChip).join("")}</div></section>` : "");
}

function cellsCount(terms) {
  return 2 + terms.filter(t => !/^(fall|spring)-/.test(t)).length;
}

function termCard(id, courses) {
  const status = termStatus(id);
  const total = courses.reduce((s, c) => s + c.credits, 0);
  const statusLabel = { done: "Completed", current: "In progress", future: "Planned" }[status];
  const order = { "1": 0, A: 1, B: 2 };
  courses = [...courses].sort((a, b) => order[quadFor(a)] - order[quadFor(b)] || a.code.localeCompare(b.code));
  const quadLoad = (q) => courses.filter(c => { const cq = quadFor(c); return cq === q || cq === "1"; }).reduce((s, c) => s + c.credits, 0);
  const hasQuads = courses.some(c => quadFor(c) !== "1");
  const heavy = total > 18;
  return `
    <div class="term st-${status}" data-term="${id}">
      <div class="term-head">
        <span class="term-name">${termLabel(id)}</span>
        <span class="term-status">${statusLabel}</span>
        <span class="term-cr${heavy ? " heavy" : ""}" title="${heavy ? "More than 18 credits — check overload rules" : ""}">${fmtCr(total)} cr</span>
      </div>
      ${hasQuads ? `<div class="quad-head"><span>A quad · ${fmtCr(quadLoad("A"))} cr</span><span>B quad · ${fmtCr(quadLoad("B"))} cr</span></div>` : ""}
      <div class="term-body" data-term="${id}">
        ${courses.map(courseChip).join("")}
        ${!courses.length ? `<div class="term-empty">${canPlanIn(id) ? "Drag a course here or add one" : "No courses"}</div>` : ""}
      </div>
      ${canPlanIn(id) ? `<button type="button" class="add-course" data-action="add" data-term="${id}">+ Add course</button>` : ""}
    </div>`;
}

// --- Requirements pane --------------------------------------------------

function findReq(id) {
  for (const b of state.plan.blocks) {
    let hit = null;
    walk(b.reqs, r => { if (r.id === id) hit = r; });
    if (hit) return hit;
  }
  return null;
}

function blockOf(reqId) {
  return state.plan.blocks.find(b => reqId.startsWith(`${b.id}/`));
}

const STATE_LABEL = {
  met: "Complete", inprog: "In progress", planned: "Planned", partial: "Partly planned",
  needed: "Still needed", manual: "Marked satisfied", info: "",
};

function reqCredits(r, ev) {
  if (r.rule && ev?.progress && ev.state === "partial") {
    return `${fmtCr(ev.progress[0])}/${fmtCr(ev.progress[1])}${r.rule.unit === "credit" ? " cr" : " classes"}`;
  }
  const uids = [...(ev?.applied || []), ...(ev?.planned || [])];
  const cr = uids.reduce((s, u) => s + (state.plan.courses.find(c => c.uid === u)?.credits || 0), 0);
  if (cr) return `${fmtCr(cr)} cr`;
  if (r.rule) {
    return r.rule.unit === "credit" ? `${fmtCr(r.rule.count)} cr` : `${r.rule.count} class${r.rule.count === 1 ? "" : "es"}`;
  }
  return "";
}

function reqNode(r, depth) {
  const ev = state.eval.get(r.id) || { state: r.status };
  const st = ev.state;
  const done = st === "met" || st === "inprog";
  if (state.unmetOnly && done) return "";
  const kids = (r.children || []).map(k => reqNode(k, depth + 1)).join("");
  const courseById = (u) => state.plan.courses.find(c => c.uid === u);
  const applied = (ev.applied || []).map(courseById).filter(Boolean);
  const planned = (ev.planned || []).map(courseById).filter(Boolean);
  const leafOpen = !r.children?.length && (st === "needed" || st === "partial");
  const plannedChips = planned.map(c => `
    <span class="rc rc-planned" data-uid="${escapeHtml(c.uid)}">${escapeHtml(c.code)} <span class="muted">${termLabel(c.term)}</span>
      <button type="button" class="rc-x" data-action="exclude" data-req="${escapeHtml(r.id)}" data-uid="${escapeHtml(c.uid)}" title="Don't count this course here">×</button></span>`).join("");
  const appliedChips = applied.map(c =>
    `<span class="rc rc-${c.status}" data-uid="${escapeHtml(c.uid)}" title="${escapeHtml(c.title)}">${escapeHtml(c.code)}${c.grade ? ` <span class="muted">${escapeHtml(c.grade)}</span>` : ""}</span>`).join("");

  let actions = "";
  if (leafOpen && st !== "manual") {
    // Degree-level rows (application, GPA) aren't course requirements.
    const assignable = blockOf(r.id)?.kind === "degree" ? []
      : state.plan.courses.filter(c => c.status === "planned" && !(ev.planned || []).includes(c.uid));
    actions = `
      <div class="req-actions">
        ${r.rule ? `<button type="button" class="mini-btn primary" data-action="find" data-req="${escapeHtml(r.id)}">Find courses</button>` : ""}
        ${assignable.length ? `<select class="mini-select" data-action="assign" data-req="${escapeHtml(r.id)}">
          <option value="">Assign a planned course…</option>
          ${assignable.map(c => `<option value="${escapeHtml(c.uid)}">${escapeHtml(c.code)} · ${termLabel(c.term)}</option>`).join("")}
        </select>` : ""}
        <button type="button" class="mini-btn" data-action="manual" data-req="${escapeHtml(r.id)}" title="E.g. a waiver or substitution your advisor approved">Mark satisfied</button>
      </div>`;
  } else if (st === "manual") {
    actions = `<div class="req-actions"><button type="button" class="mini-btn" data-action="manual" data-req="${escapeHtml(r.id)}">Undo “satisfied”</button></div>`;
  }
  const need = leafOpen && r.stillNeeded && !/^see\s/i.test(r.stillNeeded)
    ? `<div class="req-need">${escapeHtml(r.rule ? describeRule(r.rule) : r.stillNeeded)}${r.rule && !ruleCheckable(r.rule) ? ` <span class="warn" title="None of the courses in our catalogs carry this attribute, so planned courses can't be matched automatically — use “Assign”.">can't auto-check</span>` : ""}</div>`
    : "";
  return `
    <div class="req depth-${Math.min(depth, 3)} rs-${st}" data-req="${escapeHtml(r.id)}">
      <div class="req-row">
        <span class="req-icon" title="${STATE_LABEL[st] || ""}"></span>
        <span class="req-label">${escapeHtml(r.label)}${r.choose ? ` <span class="muted">(choose ${r.choose})</span>` : ""}</span>
        <span class="req-meta">${reqCredits(r, ev)}</span>
      </div>
      ${appliedChips || plannedChips ? `<div class="req-courses">${appliedChips}${plannedChips}</div>` : ""}
      ${need}${actions}
      ${kids}
    </div>`;
}

// An attribute-only rule we can't match against any known course (e.g.
// GPA/GPB — the packet collapses those into GP).
function ruleCheckable(rule) {
  return rule.options.some(o => !o.attrs.length || o.attrs.some(a =>
    [...state.catalog.values()].some(e => e.attributes.has(a))));
}

function blockState(b) {
  const states = b.reqs.map(r => state.eval.get(r.id)?.state || r.status).filter(s => s !== "info");
  if (!states.length) return "info";
  if (states.every(s => s === "met")) return "met";
  if (states.every(s => s === "met" || s === "inprog")) return "inprog";
  if (states.every(isSatisfied)) return "planned";
  return "needed";
}

function renderReqs() {
  const wrap = $("reqs");
  const blocks = state.plan.blocks;
  if (!blocks.length) {
    wrap.innerHTML = `
      <div class="empty-reqs">
        <p>Your requirements show up here once you import them from Degree Works.</p>
        <button type="button" class="mini-btn primary" data-action="open-import">Import from Degree Works</button>
        <p class="muted">Planning a minor or certificate? Run a <b>What-If</b> audit in Degree Works and import it the same way.</p>
      </div>`;
    return;
  }
  wrap.innerHTML = blocks.map(b => {
    const st = blockState(b);
    const collapsed = state.collapsed.has(b.id);
    const plannedUids = new Set();
    walk(b.reqs, r => (state.eval.get(r.id)?.planned || []).forEach(u => plannedUids.add(u)));
    const plannedCr = [...plannedUids].reduce((s, u) => s + (state.plan.courses.find(c => c.uid === u)?.credits || 0), 0);
    const meta = [];
    if (b.creditsRequired != null) meta.push(`${b.creditsRequired} cr required`);
    if (b.creditsApplied != null) meta.push(`${b.creditsApplied} applied`);
    if (plannedCr) meta.push(`+${fmtCr(plannedCr)} planned`);
    let body;
    if (b.kind === "degree") {
      // Credit totals are the bars at the top of the plan; the "See …
      // section" rows just point at the other blocks.
      const rows = b.reqs.filter(r => !/^see\s/i.test(r.stillNeeded) && !/minimum credits|upper division/i.test(r.label));
      body = rows.map(r => reqNode(r, 0)).join("")
        + (state.plan.dw?.degree?.notes || []).map(n => `<p class="block-note">${escapeHtml(n)}</p>`).join("");
    } else if (b.kind === "electives") {
      const list = b.courseUids.map(u => state.plan.courses.find(c => c.uid === u)).filter(Boolean);
      body = `<div class="req-courses">${list.map(c => `<span class="rc rc-${c.status}" data-uid="${escapeHtml(c.uid)}" title="${escapeHtml(c.title)}">${escapeHtml(c.code)}</span>`).join("")}</div>`;
    } else {
      body = b.notes.map(n => `<p class="block-note">${escapeHtml(n)}</p>`).join("") + b.reqs.map(r => reqNode(r, 0)).join("");
    }
    return `
      <section class="block rs-${st}${collapsed ? " collapsed" : ""}" data-block="${escapeHtml(b.id)}">
        <header class="block-head" data-action="toggle-block" data-block="${escapeHtml(b.id)}">
          <span class="req-icon"></span>
          <span class="block-title">${escapeHtml(b.title)}</span>
          <span class="kind kind-${b.kind}">${b.whatIf ? "What-If · " : ""}${KIND_LABEL[b.kind]}</span>
          ${b.whatIf ? `<button type="button" class="rc-x" data-action="remove-block" data-block="${escapeHtml(b.id)}" title="Remove this program">×</button>` : ""}
        </header>
        ${meta.length ? `<div class="block-meta">${meta.join(" · ")}</div>` : ""}
        <div class="block-body">${body}</div>
      </section>`;
  }).join("");
}

// --- Highlighting: hover a requirement to see its courses, and back -----

function setHighlight(uids, reqIds) {
  document.querySelectorAll(".hl").forEach(el => el.classList.remove("hl"));
  for (const u of uids) document.querySelectorAll(`.chip[data-uid="${CSS.escape(u)}"]`).forEach(el => el.classList.add("hl"));
  for (const r of reqIds) document.querySelectorAll(`.req[data-req="${CSS.escape(r)}"] > .req-row`).forEach(el => el.classList.add("hl"));
}

function wireHighlight() {
  $("reqs").addEventListener("mouseover", (e) => {
    const el = e.target.closest(".req");
    if (!el) return;
    const ids = [el.dataset.req];
    walk([findReq(el.dataset.req)].filter(Boolean), r => ids.push(r.id));
    const uids = ids.flatMap(id => [...(state.eval.get(id)?.applied || []), ...(state.eval.get(id)?.planned || [])]);
    setHighlight(uids, []);
  });
  $("reqs").addEventListener("mouseleave", () => setHighlight([], []));
  const plan = document.querySelector(".plan-pane");
  plan.addEventListener("mouseover", (e) => {
    const el = e.target.closest(".chip");
    if (!el) { setHighlight([], []); return; }
    setHighlight([el.dataset.uid], state.reqsByUid.get(el.dataset.uid) || []);
  });
  plan.addEventListener("mouseleave", () => setHighlight([], []));
}

// --- Course dialog: search the catalog, add to a term -------------------

function futureTerms() {
  return planTerms().all.filter(canPlanIn);
}

function openCourseDialog({ term = null, reqId = null } = {}) {
  const req = reqId ? findReq(reqId) : null;
  const terms = futureTerms();
  const target = term || terms.find(t => termStatus(t) === "future") || terms[0];
  state.dialog = { term: target, reqId, rule: req?.rule || null };
  $("cd-title").textContent = req ? `Courses for “${req.label}”` : "Add a course";
  $("cd-rule").innerHTML = req?.rule
    ? `Showing courses that match <b>${escapeHtml(describeRule(req.rule))}</b> <button type="button" class="link-btn" id="cd-clear-rule">show all courses</button>`
    : "";
  $("cd-rule").hidden = !req?.rule;
  $("cd-term").innerHTML = terms.map(t => `<option value="${t}" ${t === target ? "selected" : ""}>${termLabel(t)}</option>`).join("");
  $("cd-query").value = "";
  $("cd-custom").open = false;
  renderCourseResults();
  $("course-dialog").showModal();
  $("cd-query").focus();
  $("cd-clear-rule")?.addEventListener("click", () => {
    state.dialog.rule = null;
    $("cd-rule").hidden = true;
    renderCourseResults();
  });
}

function renderCourseResults() {
  const d = state.dialog;
  const tokens = $("cd-query").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const season = d.term.split("-")[0];
  const have = new Map(state.plan.courses.map(c => [c.code, c]));
  let list = [...state.catalog.values()];
  if (d.rule) list = list.filter(e => ruleMatches(d.rule, { code: e.code, attributes: [...e.attributes] }));
  if (tokens.length) {
    list = list.filter(e => {
      const hay = `${e.code} ${e.code.replace(" ", "")} ${e.title} ${[...e.attributes].join(" ")}`.toLowerCase();
      return tokens.every(t => hay.includes(t));
    });
  }
  // Courses offered in the same season as the target term float up.
  const inSeason = (e) => offeredSeasons(e).includes(season);
  list.sort((a, b) => (inSeason(b) - inSeason(a)) || a.code.localeCompare(b.code, undefined, { numeric: true }));
  const total = list.length;
  list = list.slice(0, MAX_RESULTS);
  $("cd-count").textContent = `${total} course${total === 1 ? "" : "s"}${total > MAX_RESULTS ? ` — showing ${MAX_RESULTS}, refine your search` : ""}`;
  $("cd-results").innerHTML = list.map(e => {
    const prior = have.get(e.code);
    const seasons = offeredSeasons(e).map(s => s[0].toUpperCase() + s.slice(1));
    const offered = [...e.terms.keys()].sort((a, b) => termSortKey(a) - termSortKey(b)).map(termLabel).join(", ");
    const tags = [...e.attributes].filter(a => a !== "SHAR");
    return `
      <li class="cd-row">
        <div class="cd-main">
          <div><span class="cd-code">${escapeHtml(e.code)}</span> <span class="cd-cr">${escapeHtml(e.credits)} cr</span>
            ${tags.map(a => `<span class="pill tag">${escapeHtml(a)}</span>`).join("")}</div>
          <div class="cd-name">${escapeHtml(e.title)}</div>
          <div class="cd-offered ${inSeason(e) ? "" : "off-season"}" title="Offered: ${escapeHtml(offered)}">Offered ${escapeHtml(seasons.join(" & "))}${inSeason(e) ? "" : ` — not seen in a ${season} term yet`}</div>
          ${prior ? `<div class="cd-prior">${prior.status === "planned" ? "Already planned" : "Already taken"} · ${prior.term ? termLabel(prior.term) : "transfer"}</div>` : ""}
        </div>
        <button type="button" class="add-btn" data-code="${escapeHtml(e.code)}">Add</button>
      </li>`;
  }).join("") || `<li class="cd-none">No matching courses in the catalogs we have. Use “Course not listed?” below.</li>`;
}

function addPlanned({ code, title, credits, attributes = [], quad }) {
  const d = state.dialog;
  const term = $("cd-term").value;
  const c = {
    uid: `p:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    code: normCode(code), title, credits, term,
    quad: quad || defaultQuad(normCode(code)),
    status: "planned", source: "user", attributes,
  };
  state.plan.courses.push(c);
  // Added from a requirement's "Find courses": count it there.
  if (d?.reqId) {
    const o = (state.plan.overrides[d.reqId] ||= {});
    o.pins = [...(o.pins || []), c.uid];
  }
  savePlan();
  renderAll();
  showBanner(`Added ${c.code} to ${termLabel(term)}.`, 2500);
}

function wireCourseDialog() {
  const dlg = $("course-dialog");
  $("cd-query").addEventListener("input", renderCourseResults);
  $("cd-term").addEventListener("change", (e) => { state.dialog.term = e.target.value; renderCourseResults(); });
  $("cd-results").addEventListener("click", (e) => {
    const btn = e.target.closest(".add-btn");
    if (!btn) return;
    const entry = state.catalog.get(btn.dataset.code);
    addPlanned({ code: entry.code, title: entry.title, credits: entry.creditsNum });
    dlg.close();
  });
  $("cd-custom-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    const code = f.code.value.trim();
    if (!splitCode(code).subj) return;
    addPlanned({
      code,
      title: f.title.value.trim() || "Custom course",
      credits: Number(f.credits.value) || 0,
      attributes: f.tags.value.split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(Boolean),
      quad: f.quad.value,
    });
    f.reset();
    dlg.close();
  });
  dlg.querySelector("[data-close]").addEventListener("click", () => dlg.close());
}

// --- Edit dialog for a planned course -----------------------------------

function openEditDialog(uid) {
  const c = state.plan.courses.find(x => x.uid === uid);
  if (!c || c.status !== "planned") return;
  state.editingUid = uid;
  const f = $("edit-form");
  $("ed-title").textContent = `${c.code} — ${c.title}`;
  f.term.innerHTML = futureTerms().map(t => `<option value="${t}" ${t === c.term ? "selected" : ""}>${termLabel(t)}</option>`).join("");
  f.quad.value = c.quad || "1";
  f.credits.value = c.credits;
  const counts = (state.reqsByUid.get(uid) || []).map(id => findReq(id)?.label).filter(Boolean);
  $("ed-counts").textContent = counts.length ? `Counts toward: ${counts.join("; ")}` : "Not matched to any requirement — counts as a general elective.";
  $("edit-dialog").showModal();
}

function wireEditDialog() {
  const dlg = $("edit-dialog");
  const f = $("edit-form");
  f.addEventListener("submit", (e) => {
    e.preventDefault();
    const c = state.plan.courses.find(x => x.uid === state.editingUid);
    if (c) {
      c.term = f.term.value;
      c.quad = f.quad.value;
      c.credits = Number(f.credits.value) || 0;
      savePlan();
      renderAll();
    }
    dlg.close();
  });
  $("ed-remove").addEventListener("click", () => {
    removeCourse(state.editingUid);
    dlg.close();
  });
  dlg.querySelector("[data-close]").addEventListener("click", () => dlg.close());
}

function removeCourse(uid) {
  state.plan.courses = state.plan.courses.filter(c => c.uid !== uid);
  for (const o of Object.values(state.plan.overrides)) {
    if (o.pins) o.pins = o.pins.filter(u => u !== uid);
    if (o.excludes) o.excludes = o.excludes.filter(u => u !== uid);
  }
  savePlan();
  renderAll();
}

// --- Import dialog ------------------------------------------------------

async function openImportDialog() {
  const link = $("bookmarklet");
  try {
    // Drop whole-line comments and indentation: every byte is %-encoded into
    // the bookmark, and very long javascript: URLs can fail to drag in.
    const src = (await fetch(`dw-import.js?v=${Date.now()}`).then(r => r.text()))
      .split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("//") && !l.startsWith("/*")).join("\n");
    const plannerUrl = location.href.split(/[?#]/)[0];
    link.href = `javascript:${encodeURIComponent(`(function(){var PLANNER_URL=${JSON.stringify(plannerUrl)};\n${src}\n})();`)}`;
  } catch {
    link.removeAttribute("href");
  }
  $("import-dialog").showModal();
}

function wireImportDialog() {
  const dlg = $("import-dialog");
  dlg.querySelector("[data-close]").addEventListener("click", () => dlg.close());
  $("bookmarklet").addEventListener("click", (e) => {
    e.preventDefault();
    showBanner("Drag the button to your bookmarks bar, then click it while viewing Degree Works.", 5000);
  });
  $("bm-copy").addEventListener("click", async () => {
    const href = $("bookmarklet").getAttribute("href");
    if (!href) return;
    try {
      await navigator.clipboard.writeText(href);
      showBanner("Copied. Right-click the bookmarks bar → Add page…, name it Send to Planner, and paste into URL.", 9000);
    } catch {
      showBanner("Couldn't copy. Right-click the orange button → Copy link address instead.", 6000);
    }
  });
  // The demo gets its own plan so it never mixes with a real record.
  $("demo-btn").addEventListener("click", async () => {
    const demo = await fetchJson("planner-demo.json");
    const entry = newEntry(uniqueName("Demo student"));
    importInto(entry.plan, demo);
    state.store.plans.push(entry);
    setActive(entry.id);
    showBanner("Opened the demo student as a separate plan.");
    dlg.close();
  });
  $("restore-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const { name, ...p } = JSON.parse(await file.text());
      if (p?.version !== PLAN_VERSION || !Array.isArray(p.courses)) throw new Error("not a plan");
      const entry = newEntry(uniqueName(name || file.name.replace(/\.json$/i, "")), scrubGrades({ ...emptyPlan(), ...p }));
      state.store.plans.push(entry);
      setActive(entry.id);
      showBanner(`Opened “${entry.name}” from the backup file.`);
      dlg.close();
    } catch {
      showBanner("That file isn't a planner backup.", 4000);
    }
  });
}

function exportPlan() {
  const { name } = activeEntry();
  const blob = new Blob([JSON.stringify({ name, ...state.plan }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${slug(name) || "plan"}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// --- Banner -------------------------------------------------------------

let bannerTimer = null;
function showBanner(msg, ms = 6000) {
  const el = $("banner");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// --- Events -------------------------------------------------------------

function wireEvents() {
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (el) {
      const a = el.dataset.action;
      if (a === "open-import") return openImportDialog();
      if (a === "add") return openCourseDialog({ term: el.dataset.term });
      if (a === "find") return openCourseDialog({ reqId: el.dataset.req });
      if (a === "toggle-block") {
        if (e.target.closest("button")) return;
        const id = el.dataset.block;
        state.collapsed.has(id) ? state.collapsed.delete(id) : state.collapsed.add(id);
        return renderReqs();
      }
      if (a === "remove-block") {
        state.plan.blocks = state.plan.blocks.filter(b => b.id !== el.dataset.block);
        savePlan();
        return renderAll();
      }
      if (a === "exclude") {
        const o = (state.plan.overrides[el.dataset.req] ||= {});
        o.excludes = [...new Set([...(o.excludes || []), el.dataset.uid])];
        o.pins = (o.pins || []).filter(u => u !== el.dataset.uid);
        savePlan();
        return renderAll();
      }
      if (a === "manual") {
        const o = (state.plan.overrides[el.dataset.req] ||= {});
        o.manual = !o.manual;
        savePlan();
        return renderAll();
      }
      return;
    }
    const chip = e.target.closest(".chip.st-planned");
    if (chip) openEditDialog(chip.dataset.uid);
  });
  document.addEventListener("keydown", (e) => {
    const chip = e.target.closest?.(".chip.st-planned");
    if (chip && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openEditDialog(chip.dataset.uid); }
    if (chip && (e.key === "Delete" || e.key === "Backspace")) removeCourse(chip.dataset.uid);
  });
  document.addEventListener("change", (e) => {
    if (e.target.dataset.action !== "assign" || !e.target.value) return;
    const reqId = e.target.dataset.req, uid = e.target.value;
    // A course counts once per block: pull it from sibling requirements.
    const block = blockOf(reqId);
    walk(block?.reqs, r => {
      const o = state.plan.overrides[r.id];
      if (o?.pins) o.pins = o.pins.filter(u => u !== uid);
    });
    const o = (state.plan.overrides[reqId] ||= {});
    o.pins = [...(o.pins || []), uid];
    o.excludes = (o.excludes || []).filter(u => u !== uid);
    savePlan();
    renderAll();
  });

  // Drag planned courses between terms.
  const years = $("years");
  years.addEventListener("dragstart", (e) => {
    const chip = e.target.closest(".chip.st-planned");
    if (!chip) return;
    state.draggingUid = chip.dataset.uid;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", chip.dataset.uid);
    chip.classList.add("dragging");
  });
  years.addEventListener("dragend", () => {
    state.draggingUid = null;
    document.querySelectorAll(".dragging, .drop-ok").forEach(el => el.classList.remove("dragging", "drop-ok"));
  });
  years.addEventListener("dragover", (e) => {
    const term = e.target.closest(".term[data-term]");
    if (!term || !state.draggingUid || !canPlanIn(term.dataset.term)) return;
    e.preventDefault();
    document.querySelectorAll(".drop-ok").forEach(el => el !== term && el.classList.remove("drop-ok"));
    term.classList.add("drop-ok");
  });
  years.addEventListener("drop", (e) => {
    const term = e.target.closest(".term[data-term]");
    if (!term || !state.draggingUid) return;
    e.preventDefault();
    const c = state.plan.courses.find(x => x.uid === state.draggingUid);
    if (c && canPlanIn(term.dataset.term)) {
      c.term = term.dataset.term;
      savePlan();
      renderAll();
    }
  });

  $("unmet-only").addEventListener("change", (e) => { state.unmetOnly = e.target.checked; renderReqs(); });
  $("import-btn").addEventListener("click", openImportDialog);
  wirePlanMenu();
}

// --- Named plans: picker + New / Duplicate / Rename / Delete / Download --

function renderPlanPicker() {
  const sel = $("plan-picker");
  const plans = [...state.store.plans].sort((a, b) => a.name.localeCompare(b.name));
  sel.innerHTML = plans.map(e =>
    `<option value="${escapeHtml(e.id)}" ${e.id === state.store.activeId ? "selected" : ""}>${escapeHtml(e.name)}</option>`).join("");
  $("plan-updated").textContent = `Saved in this browser · ${new Date(activeEntry().updatedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
  $("pm-delete").textContent = state.store.plans.length > 1 ? "Delete this plan…" : "Clear this plan…";
}

function askName(message, fallback) {
  const name = prompt(message, fallback);
  return name && name.trim() ? name.trim().slice(0, 60) : null;
}

function wirePlanMenu() {
  const menu = $("plan-menu");
  const done = () => { menu.open = false; };
  $("plan-picker").addEventListener("change", (e) => setActive(e.target.value));
  $("pm-new").addEventListener("click", () => {
    done();
    const name = askName("Name the new plan (e.g. “Econ + Spanish minor”):", uniqueName("New plan"));
    if (!name) return;
    const entry = newEntry(uniqueName(name), state.plan.dw ? recordOnly(state.plan) : emptyPlan());
    state.store.plans.push(entry);
    setActive(entry.id);
    showBanner(`Created “${entry.name}”${state.plan.dw ? " with your Degree Works record" : ""}.`);
  });
  $("pm-dup").addEventListener("click", () => {
    done();
    const name = askName("Name the copy:", uniqueName(`${activeEntry().name} (copy)`));
    if (!name) return;
    const entry = newEntry(uniqueName(name), structuredClone(state.plan));
    state.store.plans.push(entry);
    setActive(entry.id);
  });
  $("pm-rename").addEventListener("click", () => {
    done();
    const name = askName("Rename this plan:", activeEntry().name);
    if (!name) return;
    activeEntry().name = name;
    savePlan();
    renderPlanPicker();
  });
  $("pm-export").addEventListener("click", () => { done(); exportPlan(); });
  $("pm-delete").addEventListener("click", () => {
    done();
    const entry = activeEntry();
    if (state.store.plans.length === 1) {
      if (!confirm(`Clear “${entry.name}”, including imported Degree Works data, from this browser?`)) return;
      entry.plan = emptyPlan();
      setActive(entry.id);
      return;
    }
    if (!confirm(`Delete “${entry.name}”? This can't be undone (download it first if you might want it back).`)) return;
    state.store.plans = state.store.plans.filter(e => e !== entry);
    setActive(state.store.plans[0].id);
  });
  $("pm-wipe").addEventListener("click", () => {
    done();
    const n = state.store.plans.length;
    if (!confirm(`Delete all ${n === 1 ? "planner data" : `${n} plans`}, including imported Degree Works data, from this browser? This can't be undone.`)) return;
    wipeAll();
    showBanner("All planner data was deleted from this browser.");
  });
  // Another tab wiped the data: drop this tab's copy too, or its next save
  // would write everything back.
  window.addEventListener("storage", (e) => {
    if ((e.key === PLANS_KEY || e.key === null) && e.newValue === null) {
      wipeAll();
      showBanner("Planner data was deleted in another tab.");
    }
  });
  document.addEventListener("click", (e) => { if (menu.open && !menu.contains(e.target)) done(); });
}

// --- Boot ---------------------------------------------------------------

async function init() {
  state.store = loadStore();
  state.plan = activeEntry().plan;
  savePlan({ touch: false }); // persists a migrated legacy plan right away
  wireEvents();
  wireHighlight();
  wireCourseDialog();
  wireEditDialog();
  wireImportDialog();
  listenForImport();
  renderAll();
  try {
    await loadCatalog();
  } catch (err) {
    showBanner(`Couldn't load the course catalogs (${err.message}). Search won't work.`, 10000);
  }
  renderAll();
}

init();
