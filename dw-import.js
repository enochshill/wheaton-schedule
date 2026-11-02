// Degree Works -> Four-Year Planner bookmarklet body.
//
// Not loaded by the page. planner.js fetches this file's text and wraps it
// as  javascript:(function(){var PLANNER_URL="…";<this file>})();
// so `PLANNER_URL` is in scope and the planner's own address (GitHub Pages
// or localhost) is baked in. Runs inside the student's Degree Works tab with
// their session; nothing is sent anywhere except to the planner tab via
// postMessage. Keep it plain ES2017 with no imports — it's pasted inline.
//
// Output: the import payload documented in planner.js ("Degree Works
// import"); planner-demo.json is a complete example.

/* global PLANNER_URL */

// Degree Works Dashboard (Ellucian, React + MUI) audit layout, as of 2026:
//   <h3 id="block-RA…">Title<span>INCOMPLETE</span></h3> + "Credits required: N"
//   header lines, then one <table> per block. Each requirement is a <tr>
//   whose <th> holds the label (plus a visually-hidden "… Not complete" /
//   "… Requirement is complete" status span) and whose <td>s hold either
//   "Still needed:" + rule text, or a course (code, title, grade, credits,
//   term, repeated). Extra courses and "Satisfied by:" lines are <th>-less
//   rows that follow. The requirement tree is NOT nested in the DOM — depth
//   is only visible as the label's indent — so we rebuild it from that.
//   CSS class names are build hashes (jss…, eds-ltr-…); never match on them.

var SKIP_BLOCKS = /^(notes|in-progress|preregistered|not applicable|insufficient|over the limit|exceptions|fallthrough|not counted)/i;
var COURSE_CODE = /^[A-Z][A-Z_ ]{0,6} ?\d{2,3}[A-Z]?$/;

function dwText(el) {
  // Join text nodes with spaces: adjacent <button>s ("COMM" "101") have no
  // whitespace between them, so textContent would glue them together.
  if (!el) return "";
  var parts = [];
  var walker = el.ownerDocument.createTreeWalker(el, 4 /* SHOW_TEXT */);
  while (walker.nextNode()) parts.push(walker.currentNode.nodeValue);
  return parts.join(" ").replace(/\s+/g, " ").replace(/ ([,.:;)])/g, "$1").trim();
}

function dwOwnText(el) {
  var s = "";
  for (var i = 0; i < el.childNodes.length; i++) {
    if (el.childNodes[i].nodeType === 3) s += " " + el.childNodes[i].nodeValue;
  }
  return s.replace(/\s+/g, " ").trim();
}

function dwNum(s) {
  var m = /(\d+(?:\.\d+)?)/.exec(s || "");
  return m ? Number(m[1]) : null;
}

function dwStatus(text) {
  if (/requirement is complete/i.test(text)) return "met";
  if (/should be complete/i.test(text)) return "inprog";
  if (/not complete/i.test(text)) return "needed";
  return "info";
}

// The visible label is the <p>'s own text; the status icon's hidden
// "<label> Not complete" sits in a nested span (or, for group headers,
// in the neighbouring grid cell).
function dwLabelP(th) {
  var ps = th.querySelectorAll("p");
  return ps.length ? ps[ps.length - 1] : null;
}

// Top-level rows put their status icon in a narrow cell left of the label;
// nested rows put it inside the label <p>, whose left padding grows with
// depth (8px, 32px, …). So: icon outside → 0, else padding + 1.
function dwIndent(p) {
  if (!p.querySelector("svg")) return 0;
  var cs = p.ownerDocument.defaultView.getComputedStyle(p);
  return (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.marginLeft) || 0) + 1;
}

// Assign each requirement row a depth (0 = top) by ranking the indents.
function dwDepths(rows) {
  var keys = rows.map(function (r) { return dwIndent(r.p); });
  var levels = Array.from(new Set(keys)).sort(function (a, b) { return a - b; });
  return keys.map(function (k) { return levels.indexOf(k); });
}

function dwCourseFromCells(tds) {
  var t = tds.map(dwText);
  if (t.length < 5 || !COURSE_CODE.test(t[0])) return null;
  // Letter grades never leave the Degree Works tab; only TR (transfer) and
  // RE/IP (in progress) are needed.
  var grade = /^(TR|RE|IP)$/i.test(t[2]) ? t[2] : "";
  return { code: t[0], title: t[1], grade: grade, credits: t[3], term: t[4] };
}

// The element wrapping one block: climb from its <h3> while the parent
// still contains only this block.
function dwBlockRoot(h3) {
  var el = h3;
  while (el.parentElement && el.parentElement.tagName !== "MAIN" &&
         el.parentElement.querySelectorAll("h3").length === 1) el = el.parentElement;
  return el;
}

function dwHeaderValue(root, label) {
  // The innermost element whose text is "Label: value" (shortest match).
  var re = new RegExp("^" + label + ":?\\s*([^:\\s].*)$", "i");
  var best = null;
  var els = root.querySelectorAll("div, p, span");
  for (var i = 0; i < els.length; i++) {
    if (els[i].closest("table")) continue;
    var m = re.exec(dwText(els[i]));
    if (m && (best === null || m[1].length < best.length)) best = m[1];
  }
  return best;
}

function dwBlockNotes(root) {
  var notes = [];
  var ps = root.querySelectorAll("p");
  for (var i = 0; i < ps.length; i++) {
    var p = ps[i];
    if (p.closest("table, button, h3, [role=button]") || p.querySelector("p")) continue;
    var t = dwText(p);
    if (t && notes.indexOf(t) < 0) notes.push(t);
  }
  return notes;
}

function dwBlock(h3) {
  var root = dwBlockRoot(h3);
  var title = dwOwnText(h3) || dwText(h3).replace(/\s*(IN)?COMPLETE$/, "");
  var block = {
    title: title,
    creditsRequired: dwNum(dwHeaderValue(root, "Credits required")),
    creditsApplied: dwNum(dwHeaderValue(root, "Credits applied")),
    catalogYear: dwHeaderValue(root, "Catalog year") || "",
    notes: dwBlockNotes(root),
    courses: [],
    reqs: [],
  };

  var flat = [];        // requirement rows in order, before nesting
  var lastCourse = null;
  var current = null;   // course list new course rows attach to
  var trs = root.querySelectorAll("tbody > tr");
  for (var i = 0; i < trs.length; i++) {
    var tr = trs[i];
    var th = tr.querySelector("th");
    var tds = Array.prototype.slice.call(tr.querySelectorAll("td"));
    var p = th && dwLabelP(th);
    if (th && p) {
      var req = { label: dwOwnText(p) || dwText(p), status: dwStatus(dwText(th)), courses: [], children: [] };
      var needIdx = tds.findIndex(function (td) { return /^still needed:?$/i.test(dwText(td)); });
      var ruleTd = tds.filter(function (td) { return td.hasAttribute("colspan"); }).pop();
      var course = dwCourseFromCells(tds);
      if (course) {
        req.courses.push(course);
        lastCourse = course;
      } else if (ruleTd && (needIdx >= 0 || tds[0] && !dwText(tds[0]))) {
        req.stillNeeded = dwText(ruleTd);
      }
      flat.push({ req: req, p: p });
      current = req.courses;
      continue;
    }
    // <th>-less rows: another course for the requirement above, or a
    // "Satisfied by:" line for the course above. Electives blocks have
    // no requirements at all — their courses belong to the block.
    var text = dwText(tr);
    var sat = /^satisfied by:\s*(.+)$/i.exec(text);
    if (sat && lastCourse) { lastCourse.satisfiedBy = sat[1]; continue; }
    var c = dwCourseFromCells(tds);
    if (c) {
      (current || block.courses).push(c);
      lastCourse = c;
    }
  }

  if (flat.length) {
    var depths = dwDepths(flat);
    var stack = [];
    flat.forEach(function (f, k) {
      var d = depths[k];
      while (stack.length && stack[stack.length - 1].depth >= d) stack.pop();
      (stack.length ? stack[stack.length - 1].req.children : block.reqs).push(f.req);
      stack.push({ depth: d, req: f.req });
    });
  }
  return block;
}

// The student header's expected graduation date ("Expected graduation
// date May 2030", label and value often in sibling elements). Searched
// page-wide — the header sits outside <main>. Must contain a year, so
// links like "Apply for graduation" don't match. Planner parses the value.
var GRAD_LABEL = /^(?:expected|exp\.?|anticipated|projected|intended|planned)?\s*grad(?:uation)?(?:\s+(?:date|term|year))?\s*:?\s*(.*\d{4}.*)$/i;
function dwExpectedGraduation(doc) {
  var best = null;
  var els = doc.body.querySelectorAll("div, p, span, li, dt, dd, tr, th, td, label");
  for (var i = 0; i < els.length; i++) {
    var t = dwText(els[i]);
    if (t.length > 80) continue;
    var m = GRAD_LABEL.exec(t);
    if (m && (best === null || m[1].length < best.length)) best = m[1];
  }
  return best;
}

function scrapeDegreeWorks(doc) {
  var main = doc.querySelector("main") || doc.body;
  var h3s = Array.prototype.slice.call(main.querySelectorAll("h3"));
  if (!h3s.length || !main.querySelector("table")) return null;

  var blocks = h3s.map(dwBlock).filter(function (b) {
    return !SKIP_BLOCKS.test(b.title) && (b.reqs.length || b.courses.length);
  });
  if (!blocks.length) return null;

  var degreeBlock = blocks.filter(function (b) { return /^degree in/i.test(b.title); })[0];
  var degree = null;
  if (degreeBlock) {
    var upper = null;
    degreeBlock.notes.forEach(function (n) {
      var m = /minimum of (\d+) credits in upper division.*?taken (\d+) credits/i.exec(n);
      if (m) upper = m;
    });
    degree = {
      title: degreeBlock.title,
      creditsRequired: degreeBlock.creditsRequired,
      creditsApplied: degreeBlock.creditsApplied,
      upperDivisionRequired: upper ? Number(upper[1]) : null,
      upperDivisionApplied: upper ? Number(upper[2]) : null,
      notes: degreeBlock.notes,
    };
  }
  var whatIfTab = doc.querySelector("#what-if[aria-selected=true]");
  var catalogYear = (degreeBlock || blocks[0]).catalogYear;
  blocks.forEach(function (b) { delete b.catalogYear; });

  return {
    type: "dw-import",
    version: 1,
    whatIf: !!whatIfTab,
    catalogYear: catalogYear,
    expectedGraduation: dwExpectedGraduation(doc),
    degree: degree,
    blocks: blocks,
  };
}

var payload;
try {
  payload = scrapeDegreeWorks(document);
} catch (err) {
  payload = null;
  console.error("[planner] Degree Works read failed:", err);
}

if (!payload) {
  alert("Send to Planner: couldn't find a degree audit on this page.\n\nOpen your audit in Degree Works (Worksheets tab) and try again.");
} else {
  var plannerOrigin = new URL(PLANNER_URL).origin;
  var win = window.open(PLANNER_URL, "wheaton-four-year-planner");
  if (!win) {
    alert("Send to Planner: your browser blocked the planner tab. Allow pop-ups for this site and try again.");
  } else {
    var sent = false;
    var onMessage = function (e) {
      if (e.source !== win || e.origin !== plannerOrigin || !e.data || e.data.type !== "planner-ready") return;
      win.postMessage(payload, plannerOrigin);
      sent = true;
      window.removeEventListener("message", onMessage);
    };
    window.addEventListener("message", onMessage);
    setTimeout(function () {
      window.removeEventListener("message", onMessage);
      if (!sent) console.warn("[planner] planner tab never answered");
    }, 30000);
  }
}
