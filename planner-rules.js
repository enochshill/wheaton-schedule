// Four-Year Planner — Degree Works rule parsing + requirement matching.
// Pure functions, no DOM, so they can be exercised from Node:
//   node -e "import('./planner-rules.js').then(m => console.log(m.parseRule('4 Credits in CORE 3@')))"

// --- Terms --------------------------------------------------------------

const SEASON_ORDER = { winter: 0, "j-term": 0, spring: 1, summer: 2, fall: 3 };
const SEASON_LABEL = { winter: "Winter", "j-term": "J-Term", spring: "Spring", summer: "Summer", fall: "Fall" };

// "Fall 2025" -> "fall-2025". Returns null for anything unrecognized.
export function termIdFromLabel(label) {
  const m = /^\s*(fall|spring|summer|winter|j-term)\s+(\d{4})\s*$/i.exec(label || "");
  return m ? `${m[1].toLowerCase()}-${m[2]}` : null;
}

export function termLabel(id) {
  const [season, year] = splitTerm(id);
  return `${SEASON_LABEL[season] || season} ${year}`;
}

export function termSortKey(id) {
  const [season, year] = splitTerm(id);
  return year * 10 + (SEASON_ORDER[season] ?? 5);
}

function splitTerm(id) {
  const i = id.lastIndexOf("-");
  return [id.slice(0, i), Number(id.slice(i + 1))];
}

// The fall/spring term after `id` (summer and J-term are skipped).
export function nextMainTerm(id) {
  const [season, year] = splitTerm(id);
  return season === "fall" ? `spring-${year + 1}` : `fall-${year}`;
}

// The term a date falls in, for deciding completed / current / future.
// Fall runs Aug–Dec, spring Jan–May, summer Jun–Jul.
export function termForDate(d) {
  const y = d.getFullYear(), m = d.getMonth() + 1;
  if (m >= 8) return `fall-${y}`;
  if (m >= 6) return `summer-${y}`;
  return `spring-${y}`;
}

// --- Courses ------------------------------------------------------------

// "B EC 496" / "B_EC 496" / "BEC 496" -> {subj: "BEC", num: "496"}.
// Subjects are de-spaced to match classes.json (see banner_to_json.ps1).
export function splitCode(code) {
  const m = /^\s*([A-Za-z_ ]+?)\s*(\d[\w@]*)\s*$/.exec(code || "");
  if (!m) return { subj: (code || "").replace(/[\s_]/g, "").toUpperCase(), num: "" };
  return { subj: m[1].replace(/[\s_]/g, "").toUpperCase(), num: m[2].toUpperCase() };
}

export function normCode(code) {
  const { subj, num } = splitCode(code);
  return num ? `${subj} ${num}` : subj;
}

// "4", "(4)", "2 TO 4", "2 OR 4" -> first number (the minimum).
export function parseCredits(s) {
  if (typeof s === "number") return s;
  const m = /(\d+(?:\.\d+)?)/.exec(String(s ?? ""));
  return m ? Number(m[1]) : 0;
}

export function isUpperDivision(code) {
  const n = parseInt(splitCode(code).num, 10);
  return n >= 300;
}

// --- Rule parsing -------------------------------------------------------
//
// Degree Works "Still needed" text, e.g.
//   1 Class in BITH 315 or 318 with term >= Summer 2017 or 374 or 376
//   4 Credits in CORE 3@
//   1 Class in ARTH 494 or ECON 492 or ENGR 494 or @ 494
//   2 Classes in @ @ with attribute = GPA or attribute = GPB
//   12 Credits in ECON 3@ or 4@ or B_EC 496
// becomes
//   { count, unit: "class"|"credit", mode: "any"|"all",
//     options: [{ subj, num, attrs: [] }] }
// "@" is Degree Works' wildcard. Qualifiers we can't check against a plan
// (term >=, resident = Y, grade) are dropped. Returns null if unparseable.

const RULE_RE = /^\s*(\d+(?:\.\d+)?)\s+(class(?:es)?|credits?|hours?)\s+in\s+(.+?)\s*$/i;
const CHOOSE_RE = /choose\s+from\s+(\d+)\s+of\s+the\s+following/i;
const SUBJ_RE = /^(?:@|[A-Z][A-Z_]*)$/;
const NUM_RE = /^(?:@|\d[\dA-Z]*@?|\d@)$/;
const QUALIFIER_KEYS = new Set(["attribute", "term", "resident", "grade", "dwresident", "dwterm"]);

export function parseChoose(text) {
  const m = CHOOSE_RE.exec(text || "");
  return m ? Number(m[1]) : null;
}

export function parseRule(text) {
  const m = RULE_RE.exec((text || "").replace(/\s+/g, " "));
  if (!m) return null;
  const count = Number(m[1]);
  const unit = /^class/i.test(m[2]) ? "class" : "credit";
  const toks = m[3].split(" ");
  const options = [];
  let mode = "any";
  let lastSubj = null;
  let i = 0;

  const isQualifierAt = (j) =>
    j < toks.length && QUALIFIER_KEYS.has(toks[j].toLowerCase()) && /^(=|>=|<=|>|<|<>)$/.test(toks[j + 1] || "");

  while (i < toks.length) {
    const t = toks[i];
    const lower = t.toLowerCase();
    if (lower === "or") { i++; continue; }
    if (lower === "and") { mode = "all"; i++; continue; }
    if (lower === "with" || (isQualifierAt(i) && options.length)) {
      // with KEY OP VALUE [or KEY OP VALUE]...
      if (lower === "with") i++;
      while (isQualifierAt(i)) {
        const key = toks[i].toLowerCase();
        i += 2;
        const valueToks = [];
        while (i < toks.length && !/^(or|and|with)$/i.test(toks[i])) valueToks.push(toks[i++]);
        if (key === "attribute" && options.length) options[options.length - 1].attrs.push(valueToks.join(" ").toUpperCase());
        if (toks[i] && /^or$/i.test(toks[i]) && isQualifierAt(i + 1)) i++;
        else break;
      }
      continue;
    }
    // "B EC 496": two-part subject before a number.
    if (SUBJ_RE.test(t) && SUBJ_RE.test(toks[i + 1] || "") && NUM_RE.test(toks[i + 2] || "") && t !== "@") {
      lastSubj = (t + toks[i + 1]).replace(/_/g, "");
      options.push({ subj: lastSubj, num: toks[i + 2], attrs: [] });
      i += 3;
      continue;
    }
    if (SUBJ_RE.test(t) && NUM_RE.test(toks[i + 1] || "")) {
      lastSubj = t === "@" ? "@" : t.replace(/_/g, "");
      options.push({ subj: lastSubj, num: toks[i + 1], attrs: [] });
      i += 2;
      continue;
    }
    if (NUM_RE.test(t) && lastSubj) {
      options.push({ subj: lastSubj, num: t, attrs: [] });
      i++;
      continue;
    }
    i++; // unknown token — skip
  }
  if (!options.length) return null;
  // "1 Class in MATH 231 and 232" means both.
  if (mode === "all" && unit === "class") return { count: Math.max(count, options.length), unit, mode, options };
  return { count, unit, mode, options };
}

function numPatternRe(num) {
  const esc = num.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/@/g, ".*");
  return new RegExp(`^${esc}$`, "i");
}

export function optionMatches(opt, course) {
  const { subj, num } = splitCode(course.code);
  if (opt.subj !== "@" && opt.subj !== subj) return false;
  if (opt.num !== "@" && !numPatternRe(opt.num).test(num)) return false;
  if (opt.attrs.length) {
    const have = course.attributes || [];
    if (!opt.attrs.some(a => have.includes(a))) return false;
  }
  return true;
}

export function ruleMatches(rule, course) {
  return rule.options.some(o => optionMatches(o, course));
}

// Short human description, used where the original text is too long.
export function describeRule(rule) {
  const opts = rule.options.map(o => {
    const base = o.subj === "@" && o.num === "@" ? "any course" : `${o.subj === "@" ? "any" : o.subj} ${o.num === "@" ? "course" : o.num}`;
    return o.attrs.length ? `${base} with ${o.attrs.join("/")}` : base;
  });
  const unit = rule.unit === "class" ? (rule.count === 1 ? "class" : "classes") : "credits";
  return `${rule.count} ${unit}: ${opts.join(rule.mode === "all" ? " and " : " or ")}`;
}

// --- Requirement evaluation ---------------------------------------------
//
// Requirement node (normalized from the import):
//   { id, label, status: "met"|"inprog"|"needed", rule, choose,
//     courseUids: [], stillNeeded, children: [] }
// A course may satisfy requirements in several blocks (Core + Major
// overlap, as Degree Works allows), but only one requirement per block.
//
// Returns Map(reqId -> { state, applied: [uid], planned: [uid], progress })
// state: "met" | "inprog" | "planned" | "partial" | "needed" | "manual" | "info"

const DONE_STATES = new Set(["met", "inprog", "planned", "manual"]);

export function isSatisfied(state) {
  return DONE_STATES.has(state);
}

export function evaluatePlan(blocks, courses, overrides = {}) {
  const result = new Map();
  const planned = courses.filter(c => c.status === "planned");
  for (const block of blocks) {
    const used = new Set();
    // Imported applications are fixed; claim them first so planned
    // courses don't double-dip inside the block.
    walk(block.reqs, r => r.courseUids?.forEach(u => used.add(u)));

    // Leaves with a rule, most-constrained first, so a broad elective
    // bucket doesn't grab the only course that fits a narrow requirement.
    const leaves = [];
    walk(block.reqs, r => {
      if (!r.children?.length && r.rule && r.status === "needed" && !overrides[r.id]?.manual) leaves.push(r);
    });
    const candidatesOf = (r) => planned.filter(c => ruleMatches(r.rule, c) && !(overrides[r.id]?.excludes || []).includes(c.uid));
    leaves.sort((a, b) => candidatesOf(a).length - candidatesOf(b).length);

    // Pins first (user-assigned), then auto-match.
    for (const r of leaves) {
      const pins = (overrides[r.id]?.pins || []).filter(u => planned.some(c => c.uid === u));
      pins.forEach(u => used.add(u));
      result.set(r.id, { pins });
    }
    for (const r of leaves) {
      const pinned = result.get(r.id).pins;
      const take = [...pinned];
      let have = measure(r.rule, take, courses);
      for (const c of candidatesOf(r)) {
        if (have >= r.rule.count) break;
        if (used.has(c.uid)) continue;
        take.push(c.uid);
        used.add(c.uid);
        have = measure(r.rule, take, courses);
      }
      const state = have >= r.rule.count ? "planned" : have > 0 ? "partial" : "needed";
      result.set(r.id, { state, applied: r.courseUids || [], planned: take, progress: [have, r.rule.count] });
    }

    // Everything else bottom-up.
    const evalNode = (r) => {
      const kids = (r.children || []).map(evalNode);
      if (overrides[r.id]?.manual) {
        const out = { state: "manual", applied: r.courseUids || [], planned: [] };
        result.set(r.id, out);
        return out;
      }
      if (result.has(r.id) && result.get(r.id).state) return result.get(r.id);
      let state;
      if (r.status === "met" || r.status === "inprog") state = r.status;
      else if (kids.length) {
        const n = r.choose ?? kids.length;
        const satisfied = kids.filter(k => isSatisfied(k.state));
        if (satisfied.length >= n) {
          state = satisfied.every(k => k.state === "met") ? "met"
            : satisfied.every(k => k.state === "met" || k.state === "inprog") ? "inprog" : "planned";
        } else state = satisfied.length || kids.some(k => k.state === "partial") ? "partial" : "needed";
      } else if (r.status === "needed" && !r.rule) {
        // Requirement whose text we couldn't parse, or a pinned-only one.
        const pins = (overrides[r.id]?.pins || []).filter(u => planned.some(c => c.uid === u));
        state = pins.length ? "planned" : "needed";
        const out = { state, applied: r.courseUids || [], planned: pins };
        result.set(r.id, out);
        return out;
      } else state = r.status || "info";
      const out = { state, applied: r.courseUids || [], planned: [] };
      result.set(r.id, out);
      return out;
    };
    block.reqs.forEach(evalNode);
  }
  return result;
}

function measure(rule, uids, courses) {
  if (rule.unit === "class") return uids.length;
  return uids.reduce((s, u) => s + (courses.find(c => c.uid === u)?.credits || 0), 0);
}

export function walk(nodes, fn) {
  for (const n of nodes || []) {
    fn(n);
    walk(n.children, fn);
  }
}
