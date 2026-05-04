// RFC 5545 .ics generator for the Wheaton schedule builder.
//
// Exports:
//   buildIcs(config, classes, finalsEvents, quadOf) -> string
//   downloadIcs(config, classes, finalsEvents, quadOf, filename?) -> void
//
// Semantics:
//   - One weekly VEVENT per (class, meeting) pair, with RRULE bounded by the
//     class's quad window (A / B / FULL).
//   - EXDATE entries skip semester holidays that fall on a meeting weekday.
//   - One-off VEVENT per finalsEvent (kinds "scheduled" and "late"). A-quad
//     classes get no finals event — their last regular session IS the exam.

const TZID = "America/Chicago";

// Static VTIMEZONE block (US Central, post-2007 DST rules). Compatible with
// Apple Calendar, Google Calendar, Outlook. Don't compute DST from JS Date.
const VTIMEZONE_BLOCK = [
  "BEGIN:VTIMEZONE",
  "TZID:America/Chicago",
  "BEGIN:STANDARD",
  "DTSTART:19701101T020000",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0600",
  "RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11",
  "TZNAME:CST",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:19700308T020000",
  "TZOFFSETFROM:-0600",
  "TZOFFSETTO:-0500",
  "RRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3",
  "TZNAME:CDT",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
];

const DAY_TO_BYDAY = { M: "MO", T: "TU", W: "WE", R: "TH", F: "FR", S: "SA", U: "SU" };
// JS Date.getUTCDay(): 0=Sun ... 6=Sat. Map our day letters to that.
const DAY_TO_DOW = { U: 0, M: 1, T: 2, W: 3, R: 4, F: 5, S: 6 };

// --- Date math (epoch-ms based to stay timezone-independent) -----------

function parseYmd(s) {
  const [y, m, d] = s.split("-").map(Number);
  return { y, m, d };
}

function ymdToEpochUtc({ y, m, d }) {
  return Date.UTC(y, m - 1, d);
}

function epochToYmd(ms) {
  const dt = new Date(ms);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function ymdString(ymd) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${ymd.y}${pad(ymd.m)}${pad(ymd.d)}`;
}

function dowOf(ymd) {
  return new Date(ymdToEpochUtc(ymd)).getUTCDay();
}

// First date >= windowStart whose weekday matches `dayLetter`.
function firstOccurrenceOnOrAfter(windowStart, dayLetter) {
  const target = DAY_TO_DOW[dayLetter];
  if (target === undefined) return null;
  const startMs = ymdToEpochUtc(windowStart);
  const startDow = new Date(startMs).getUTCDay();
  const delta = ((target - startDow) + 7) % 7;
  return epochToYmd(startMs + delta * 86400000);
}

function isWithinWindow(ymd, windowStart, windowEnd) {
  const ms = ymdToEpochUtc(ymd);
  return ms >= ymdToEpochUtc(windowStart) && ms <= ymdToEpochUtc(windowEnd);
}

// --- ICS text utilities ------------------------------------------------

// RFC 5545 TEXT escape: backslash, comma, semicolon, newlines.
function escapeText(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

// Fold lines to 75 octets per RFC 5545. Continuation lines start with a space.
// We use byte length (TextEncoder) — class titles are usually ASCII but may
// contain a stray non-ASCII character.
const enc = new TextEncoder();
function foldLine(line) {
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let buf = "";
  let bufBytes = 0;
  let firstSegment = true;
  for (const ch of line) {
    const chBytes = enc.encode(ch).length;
    const limit = firstSegment ? 75 : 74; // continuation lines have a leading space, costing 1 byte
    if (bufBytes + chBytes > limit) {
      out.push(buf);
      firstSegment = false;
      buf = " " + ch;
      bufBytes = 1 + chBytes;
    } else {
      buf += ch;
      bufBytes += chBytes;
    }
  }
  if (buf.length) out.push(buf);
  return out.join("\r\n");
}

// HH:MM (24h) -> HHMMSS for ICS local-time format.
function hhmmToIcs(hhmm) {
  return hhmm.replace(":", "") + "00";
}

function localDateTime(ymd, hhmm) {
  return `${ymdString(ymd)}T${hhmmToIcs(hhmm)}`;
}

// --- Quad window resolution -------------------------------------------

function quadWindow(config, quad) {
  if (quad === "A") return { start: parseYmd(config.aQuadStart), end: parseYmd(config.aQuadEnd) };
  if (quad === "B") return { start: parseYmd(config.bQuadStart), end: parseYmd(config.bQuadEnd) };
  return { start: parseYmd(config.fullStart), end: parseYmd(config.fullEnd) };
}

// --- VEVENT builders ---------------------------------------------------

function dtstamp() {
  // Z-suffixed UTC timestamp of when the file was generated.
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T` +
         `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function buildWeeklyVEvent(config, c, meetingIdx, meeting, quad, stamp) {
  const window = quadWindow(config, quad);
  // Find the earliest weekday in this meeting that has an occurrence in the window.
  let earliest = null;
  for (const day of meeting.days) {
    const occ = firstOccurrenceOnOrAfter(window.start, day);
    if (!occ) continue;
    if (!isWithinWindow(occ, window.start, window.end)) continue;
    if (!earliest || ymdToEpochUtc(occ) < ymdToEpochUtc(earliest)) earliest = occ;
  }
  if (!earliest) return null; // window doesn't include any meeting day

  const byday = meeting.days.map(d => DAY_TO_BYDAY[d]).filter(Boolean).join(",");
  // UNTIL must be UTC for tzid'd events. End-of-day UTC on windowEnd is safely
  // past any class meeting time in Central Time.
  const untilStr = `${ymdString(window.end)}T235959Z`;

  // EXDATE: holidays in the window that fall on one of the meeting's days.
  const meetingDows = new Set(meeting.days.map(d => DAY_TO_DOW[d]));
  const exdates = [];
  for (const h of (config.holidays || [])) {
    const hYmd = parseYmd(h);
    if (!isWithinWindow(hYmd, window.start, window.end)) continue;
    if (!meetingDows.has(dowOf(hYmd))) continue;
    exdates.push(localDateTime(hYmd, meeting.start));
  }

  const desc = [
    `CRN ${c.crn || ""}`,
    quadLabelOf(quad),
    c.credits ? `${c.credits} cr` : "",
  ].filter(Boolean).join("\n");

  const lines = [
    "BEGIN:VEVENT",
    `UID:${config.id}-${c.id}-m${meetingIdx}@wheaton-schedule`,
    `DTSTAMP:${stamp}`,
    `SUMMARY:${escapeText(`${c.code} ${c.title}`)}`,
    desc ? `DESCRIPTION:${escapeText(desc)}` : null,
    `DTSTART;TZID=${TZID}:${localDateTime(earliest, meeting.start)}`,
    `DTEND;TZID=${TZID}:${localDateTime(earliest, meeting.end)}`,
    `RRULE:FREQ=WEEKLY;BYDAY=${byday};UNTIL=${untilStr}`,
    ...exdates.map(e => `EXDATE;TZID=${TZID}:${e}`),
    "END:VEVENT",
  ].filter(Boolean);
  return lines;
}

function buildFinalVEvent(config, ev, stamp) {
  // ev = { classId, code, title, kind, day, startStr, endStr, code? (period code) }
  const finalsStart = parseYmd(config.finalsStart);
  const finalsEnd = parseYmd(config.finalsEnd);
  // Map ev.day onto the finals-week date range.
  const target = DAY_TO_DOW[ev.day];
  if (target === undefined) return null;
  const startMs = ymdToEpochUtc(finalsStart);
  const startDow = new Date(startMs).getUTCDay();
  const delta = ((target - startDow) + 7) % 7;
  const dateMs = startMs + delta * 86400000;
  if (dateMs > ymdToEpochUtc(finalsEnd)) return null;
  const date = epochToYmd(dateMs);

  const note = ev.kind === "late"
    ? "Final exam at original meeting time"
    : `Final exam (period ${ev.code || "?"})`;
  const lines = [
    "BEGIN:VEVENT",
    `UID:${config.id}-${ev.classId}-final@wheaton-schedule`,
    `DTSTAMP:${stamp}`,
    `SUMMARY:${escapeText(`${ev.code ? ev.code + " " : ""}${ev.title || ""} — Final`)}`,
    `DESCRIPTION:${escapeText(note)}`,
    `DTSTART;TZID=${TZID}:${localDateTime(date, ev.startStr)}`,
    `DTEND;TZID=${TZID}:${localDateTime(date, ev.endStr)}`,
    "END:VEVENT",
  ];
  return lines;
}

function quadLabelOf(quad) {
  return quad === "A" ? "A quad" : quad === "B" ? "B quad" : "Full semester";
}

// --- Public API --------------------------------------------------------

export function buildIcs(config, classes, finalsEvents, quadOf) {
  if (!config) throw new Error("missing semester config");
  for (const k of ["fullStart", "fullEnd", "aQuadStart", "aQuadEnd", "bQuadStart", "bQuadEnd", "finalsStart", "finalsEnd"]) {
    if (!config[k]) throw new Error(`semester config missing ${k}`);
  }
  const stamp = dtstamp();
  const out = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//wheaton-schedule//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeText(`Wheaton ${config.label}`)}`,
    `X-WR-TIMEZONE:${TZID}`,
    ...VTIMEZONE_BLOCK,
  ];
  for (const c of classes) {
    const quad = quadOf(c);
    c.meetings.forEach((m, idx) => {
      const lines = buildWeeklyVEvent(config, c, idx, m, quad, stamp);
      if (lines) out.push(...lines);
    });
  }
  for (const ev of finalsEvents) {
    const lines = buildFinalVEvent(config, ev, stamp);
    if (lines) out.push(...lines);
  }
  out.push("END:VCALENDAR");
  // Fold each line to 75 octets, then join with CRLF (Outlook silently fails
  // on bare LF).
  return out.map(foldLine).join("\r\n") + "\r\n";
}

export function downloadIcs(config, classes, finalsEvents, quadOf, filename) {
  const text = buildIcs(config, classes, finalsEvents, quadOf);
  const fname = filename || `wheaton-schedule-${config.id}.ics`;
  const blob = new Blob([text], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
