// ─────────────────────────────────────────────────────────────────────────────
// retention_core.mjs — pure logic for the 48-hour exam retention cleanup.
//
// This file has ZERO dependencies on purpose: it must be importable from the
// Node test harness (dynamic import) without firebase-admin, so every retention
// decision can be asserted as a plain function. The scheduled Netlify function
// (netlify/functions/retention-cleanup.mjs) supplies only the RTDB glue.
//
// Semantics (kept in lock-step with the app's own isExamEnded):
//   • an exam ends at the end of its printed session on its printed date —
//     FN ends 13:00, AN ends 17:00, in the college's local time;
//   • a scheduled run never touches an exam until the retention window has
//     fully elapsed AFTER that end, so a college still printing last week's
//     hall notices is not surprised by disappeared exams;
//   • the whole feature defaults to DRY RUN; automatic deletion happens only
//     after an operator sets RETENTION_DRY_RUN=false and watches a clean run;
//   • an exam whose date or session cannot be parsed is NEVER auto-deleted.
//
// Dates arrive in several shapes: ISO (2026-10-14, what manual entry and the
// backup write), the college's printed day-first forms (14.10.2026, 14-10-2026,
// 14/10/2026) and the CAT reader's named month (06-Oct-2026). Non-ISO forms are
// read DAY-first, exactly as the app displays them (fmtDate turns an ISO date
// into DD.MM.YYYY). Mis-reading day↔month can only ever KEEP an exam longer —
// never delete one early — because day-first is the app's own convention and a
// month-swapped date is still usually in the past once 48h have passed; when it
// is not, day-first keeps it, which is the safe direction.
// ─────────────────────────────────────────────────────────────────────────────

export const MONTHS_3 = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

// Session end times in minutes-from-local-midnight, matching the attendance
// sheets' printed labels (FN 10:00–01:00, AN 02:00–05:00).
export const DEFAULT_SESSION_END_MIN = { FN: 13 * 60, AN: 17 * 60 };

// India (IST, +5:30) is the default deployment timezone. Netlify scheduled
// functions run in UTC, so without this offset a 13:00 IST end would be treated
// as 13:00 UTC and an exam could be considered "ended" 5.5h early.
export const DEFAULT_TZ_OFFSET_MINUTES = 330;

export const DEFAULT_RETENTION_MS = 48 * 60 * 60 * 1000;

export function defaultRetentionConfig(over) {
  return Object.assign({
    sessionEndMin: Object.assign({}, DEFAULT_SESSION_END_MIN),
    retentionMs: DEFAULT_RETENTION_MS,
    tzOffsetMinutes: DEFAULT_TZ_OFFSET_MINUTES,
    dryRun: true,
    maxDeletesPerRun: 500,
    includeIds: true,
  }, over || {});
}

const MONTH_NUMBER = (function () {
  const map = {};
  MONTHS_3.forEach(function (m, i) { map[m] = i + 1; });
  return map;
})();

// "2026-10-14" / "2026/10/14"  -> year-first (ISO)
// "14.10.2026" / "14-10-2026" / "14/10/2026" -> DAY-first, the app's own format
// "06-Oct-2026" / "06.Oct.2026" -> day + named month
// Returns { y, m, d } or null when the value cannot be a real date.
export function parseExamDate(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const parts = s.split(/[-/.]/).filter((p) => p !== "");
  if (parts.length !== 3) return null;
  let y, m, d;
  const p0 = parts[0], p1 = parts[1], p2 = parts[2];
  if (/^\d{4}$/.test(p0)) {
    y = parseInt(p0, 10); m = parseInt(p1, 10); d = parseInt(p2, 10);
  } else {
    const named = MONTH_NUMBER[p1.toUpperCase()];
    if (named) { d = parseInt(p0, 10); m = named; y = parseInt(p2, 10); }
    else { d = parseInt(p0, 10); m = parseInt(p1, 10); y = parseInt(p2, 10); }
  }
  if (!Number.isInteger(y) || y < 1900 || y > 2200) return null;
  if (!Number.isInteger(m) || m < 1 || m > 12) return null;
  if (!Number.isInteger(d) || d < 1) return null;
  const maxDays = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > maxDays) return null;
  return { y: y, m: m, d: d };
}

// The instant (epoch ms) an exam is over: end of its session on its printed
// date, expressed in the configured college timezone. Null when unparseable.
export function examEndTimestamp(dateStr, session, cfg) {
  const c = cfg || defaultRetentionConfig();
  const p = parseExamDate(dateStr);
  if (!p) return null;
  const up = String(session || "").toUpperCase();
  const endMin = (c.sessionEndMin && c.sessionEndMin[up]) ||
    DEFAULT_SESSION_END_MIN[up];
  if (!endMin) return null;
  const tz = typeof c.tzOffsetMinutes === "number" ? c.tzOffsetMinutes : DEFAULT_TZ_OFFSET_MINUTES;
  return Date.UTC(p.y, p.m - 1, p.d) - tz * 60000 + endMin * 60000;
}

// One exam's retention verdict:
//   "not_ended"  — date+session end is still in the future (or is today)
//   "too_recent" — the exam is over but inside the retention window
//   "expired"    — over AND past the retention window: eligible for cleanup
//   "unparsable" — no reliable end can be derived; NEVER auto-deleted
export function evaluateExam(exam, cfg, nowMs) {
  const c = cfg || defaultRetentionConfig();
  if (!exam || !exam.id || !exam.date) return "unparsable";
  const end = examEndTimestamp(exam.date, exam.session, c);
  if (end === null) return "unparsable";
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  if (end >= now) return "not_ended";
  if (now - end < c.retentionMs) return "too_recent";
  return "expired";
}

// The exams a run would clean up: every one whose retention verdict is
// "expired", in input order. Pure — no reads or writes happen here.
export function retentionCleanupTargets(exams, cfg, nowMs) {
  const c = cfg || defaultRetentionConfig();
  return (exams || []).filter(function (e) {
    return e && e.id && evaluateExam(e, c, nowMs) === "expired";
  });
}

// Map exam_id -> plan document id (first plan seen per exam wins, the same rule
// the app's own plan loader uses).
export function planDocsByExam(planDocs) {
  const out = {};
  (planDocs || []).forEach(function (p) {
    if (!p || !p.id || !p.exam_id) return;
    if (Object.prototype.hasOwnProperty.call(out, p.exam_id)) return;
    out[p.exam_id] = p.id;
  });
  return out;
}

// One multi-location update that nulls the target exams AND their seating-plan
// docs, so the retention cleanup is atomic and never leaves orphans behind.
export function buildRetentionDeleteUpdate(targets, planDocs) {
  const plans = planDocsByExam(planDocs);
  const updates = {};
  (targets || []).forEach(function (t) {
    if (!t || !t.id) return;
    updates["exams/" + t.id] = null;
    if (plans[t.id]) updates["seating_plans/" + plans[t.id]] = null;
  });
  return updates;
}

// Run one retention pass against injected RTDB accessors.
//
// deps: {
//   getExams:  () => Promise<[ {id,date,session}, ... ]>  — whole /exams node
//   getPlans:  () => Promise<[ {id,exam_id}, ... ]>       — whole /seating_plans
//   examExists:(id) => Promise<boolean>                   — verify-before-delete
//   write:     (updates) => Promise<void>                 — multi-location write
//   log:       (msg) => void                              — optional
// }
// cfg:  defaultRetentionConfig(...). Returns a run summary; never throws on
//       data issues (each candidate is guarded), only on a guarded DB call.
export async function runRetentionCleanup(deps, cfg, nowMs) {
  const c = cfg || defaultRetentionConfig();
  if (!deps || typeof deps.getExams !== "function") {
    throw new Error("retention run needs a getExams() reader");
  }
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  const list = await deps.getExams();
  const candidates = retentionCleanupTargets(list, c, now);
  const summary = {
    dryRun: !!c.dryRun,
    examined: Array.isArray(list) ? list.length : 0,
    candidates: candidates.length,
    ids: c.includeIds ? candidates.map(function (e) { return e.id; }) : [],
    deleted: 0,
    plansDeleted: 0,
    skipped: [],
    deferred: 0,
  };
  if (deps.log) deps.log(
    "[retention] " + (summary.dryRun ? "DRY RUN " : "") + "examined=" + summary.examined +
    " candidates=" + summary.candidates + (summary.dryRun ? " (no writes)" : ""));
  if (c.dryRun || candidates.length === 0) return summary;

  const planDocs = await deps.getPlans();
  // verify-before-delete: an exam that vanished since the read is never
  // re-deleted, and its plan path is never guessed at.
  const entries = []; // verified exam ids, each with its plan id
  for (const e of candidates) {
    if (!e || !e.id) continue;
    if (deps.examExists) {
      let exists;
      try { exists = await deps.examExists(e.id); }
      catch (err) { summary.skipped.push({ id: e.id, reason: "verify_error" }); continue; }
      if (!exists) { summary.skipped.push({ id: e.id, reason: "already_gone" }); continue; }
    }
    entries.push({ id: e.id });
  }
  const planMap = planDocsByExam(planDocs);
  entries.forEach(function (e) { if (planMap[e.id]) e.planId = planMap[e.id]; });

  // The budget is applied in EXAM units, never in paths: an exam is always
  // deleted together with its seating plan, so a budget cut can never strand
  // an orphaned plan. Rejected as the run logic used to split pairs.
  const budget = Math.max(1, typeof c.maxDeletesPerRun === "number" ? c.maxDeletesPerRun : 500);
  const apply = entries.slice(0, budget);
  summary.deferred = Math.max(0, entries.length - apply.length);
  if (summary.deferred > 0) summary.skipped.push("budgeted: " + summary.deferred + " exam(s) deferred to the next run");
  summary.deleted = apply.length;
  summary.plansDeleted = apply.filter(function (e) { return !!e.planId; }).length;

  // Each request stays <= CHUNK paths; exam+plan pairs are never split across
  // requests.
  const CHUNK = 200;
  const parts = [];
  let part = [], count = 0;
  for (const e of apply) {
    const pairKeys = ["exams/" + e.id];
    if (e.planId) pairKeys.push("seating_plans/" + e.planId);
    if (part.length && count + pairKeys.length > CHUNK) { parts.push(part); part = []; count = 0; }
    pairKeys.forEach(function (k) { part.push(k); count++; });
  }
  if (part.length) parts.push(part);
  for (const keys of parts) {
    const update = {};
    keys.forEach(function (k) { update[k] = null; });
    await deps.write(update);
  }
  if (deps.log) deps.log(
    "[retention] deleted=" + summary.deleted + " plans=" + summary.plansDeleted +
    " skipped=" + summary.skipped.length + " deferred=" + summary.deferred);
  return summary;
}