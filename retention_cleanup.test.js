// Unit tests for the 48-hour retention cleanup. The core module is dependency
// free; each case awaits its dynamic import, so these run the EXACT file the
// scheduled Netlify function imports — and the module must import cleanly with
// no firebase-admin present.
const fs = require("fs");
const { pathToFileURL } = require("url");

const h = require("./harness.js");
const s = h.suite("retention_cleanup.test.js — only exams 48h past their session end are candidates");
const { it, ait, eq, ok } = s;

const READY = import(pathToFileURL("netlify/shared/retention_core.mjs").href);

const NOW = Date.UTC(2026, 9, 14, 11, 30); // 2026-10-14 17:00 IST (end of an AN exam)

ait("the core module imports cleanly with no firebase-admin dependency", async () => {
  const c = await READY;
  ok(typeof c.runRetentionCleanup === "function", "runRetentionCleanup is exported");
  ok(typeof c.evaluateExam === "function", "evaluateExam is exported");
});

// ── date parsing ─────────────────────────────────────────────────────────────
ait("parseExamDate reads ISO, printed day-first and named-month forms", async () => {
  const c = await READY;
  eq(c.parseExamDate("2026-10-14"), { y: 2026, m: 10, d: 14 }, "ISO");
  eq(c.parseExamDate("2026/10/14"), { y: 2026, m: 10, d: 14 }, "ISO slashed");
  eq(c.parseExamDate("14.10.2026"), { y: 2026, m: 10, d: 14 }, "DD.MM.YYYY (app's printed form)");
  eq(c.parseExamDate("14-10-2026"), { y: 2026, m: 10, d: 14 }, "DD-MM-YYYY");
  eq(c.parseExamDate("14/10/2026"), { y: 2026, m: 10, d: 14 }, "DD/MM/YYYY");
  eq(c.parseExamDate("06-Oct-2026"), { y: 2026, m: 10, d: 6 }, "dd-MMM-yyyy (CAT reader)");
  eq(c.parseExamDate("06.Oct.2026"), { y: 2026, m: 10, d: 6 }, "dd.MMM.yyyy");
});

ait("parseExamDate never fabricates a date that cannot exist", async () => {
  const c = await READY;
  eq(c.parseExamDate(null), null, "null");
  eq(c.parseExamDate(""), null, "empty");
  eq(c.parseExamDate("not-a-date"), null, "garbage");
  eq(c.parseExamDate("2026-14-14"), null, "month 13");
  eq(c.parseExamDate("31.02.2026"), null, "Feb 31");
  eq(c.parseExamDate("21-100-2026"), null, "absurd month token");
  eq(c.parseExamDate("2026"), null, "year only");
});

// ── session end timestamps ───────────────────────────────────────────────────
ait("session ends match the attendance sheets: FN 13:00, AN 17:00, in college time", async () => {
  const c = await READY;
  // In IST (+330) an FN exam on 2026-10-14 ends 13:00 IST = 07:30 UTC.
  eq(c.examEndTimestamp("2026-10-14", "FN", { tzOffsetMinutes: 330 }),
     Date.UTC(2026, 9, 14, 7, 30), "FN ends 13:00 IST");
  eq(c.examEndTimestamp("2026-10-14", "AN", { tzOffsetMinutes: 330 }),
     Date.UTC(2026, 9, 14, 11, 30), "AN ends 17:00 IST");
  eq(c.examEndTimestamp("2026-10-14", "fn", { tzOffsetMinutes: 330 }),
     Date.UTC(2026, 9, 14, 7, 30), "session case is normalised");
});

ait("unparseable dates/sessions yield a null end (never auto-deleted)", async () => {
  const c = await READY;
  eq(c.examEndTimestamp("garbage", "FN", {}), null, "bad date");
  eq(c.examEndTimestamp("2026-10-14", "MORNING", {}), null, "unknown session");
  eq(c.examEndTimestamp(null, "FN", {}), null, "no date");
});

// ── retention verdicts ───────────────────────────────────────────────────────
ait("evaluateExam only expires exams fully outside the retention window", async () => {
  const c = await READY;
  const cfg = { sessionEndMin: { FN: 780, AN: 1020 }, retentionMs: 48 * 3600 * 1000, tzOffsetMinutes: 0 };
  const end = Date.UTC(2026, 9, 14, 13, 0); // FN ends 13:00 UTC with tz offset 0
  eq(c.evaluateExam({ id: "E", date: "2026-10-14", session: "FN" }, cfg, end - 3600 * 1000), "not_ended");
  eq(c.evaluateExam({ id: "E", date: "2026-10-14", session: "FN" }, cfg, end + 1), "too_recent");
  eq(c.evaluateExam({ id: "E", date: "2026-10-14", session: "FN" }, cfg, end + 47 * 3600 * 1000), "too_recent");
  eq(c.evaluateExam({ id: "E", date: "2026-10-14", session: "FN" }, cfg, end + 48 * 3600 * 1000 + 1), "expired");
  eq(c.evaluateExam({ date: "2026-10-14", session: "FN" }, cfg, end + 999 * 3600 * 1000), "unparsable", "missing id is never deleted");
  eq(c.evaluateExam({ id: "E", date: "10-2026", session: "FN" }, cfg, end + 999 * 3600 * 1000), "unparsable", "broken date");
  eq(c.evaluateExam(null, cfg, end), "unparsable", "null exam");
});

ait("retentionCleanupTargets returns expired exams in input order only", async () => {
  const c = await READY;
  const cfg = { sessionEndMin: { FN: 780, AN: 1020 }, retentionMs: 48 * 3600 * 1000, tzOffsetMinutes: 0 };
  // C ends at 13:00 UTC on 2026-10-12; the run runs one hour after that.
  const now = Date.UTC(2026, 9, 12, 14, 0);
  const exams = [
    { id: "A", date: "2026-01-01", session: "FN" }, // months past -> expired
    { id: "B", date: "2026-10-16", session: "FN" }, // future -> not_ended
    { id: "C", date: "2026-10-12", session: "FN" }, // 1h past -> too_recent
    { id: "D", date: "broken", session: "FN" },     // unparsable
  ];
  eq(c.retentionCleanupTargets(exams, cfg, now).map((e) => e.id), ["A"]);
  eq(c.retentionCleanupTargets([], cfg, now), [], "empty list");
});

// ── update building ──────────────────────────────────────────────────────────
ait("planDocsByExam maps exam->plan, first plan per exam wins", async () => {
  const c = await READY;
  eq(c.planDocsByExam([
    { id: "P1", exam_id: "E1" },
    { id: "P2", exam_id: "E1" },
    { id: "P3", exam_id: "E2" },
  ]), { E1: "P1", E2: "P3" });
});

ait("buildRetentionDeleteUpdate nulls the exam and its plan atomically", async () => {
  const c = await READY;
  const u = c.buildRetentionDeleteUpdate(
    [{ id: "E1" }, { id: "E2" }],
    [{ id: "P1", exam_id: "E1" }, { id: "P2", exam_id: "E2" }, { id: "P3", exam_id: "GONE" }],
  );
  eq(u["exams/E1"], null);
  eq(u["exams/E2"], null);
  eq(u["seating_plans/P1"], null);
  eq(u["seating_plans/P2"], null);
  eq(u["seating_plans/P3"], undefined, "a plan for a non-target exam is never added");
});

// ── runRetentionCleanup: dry run does nothing ────────────────────────────────
ait("a dry run computes candidates and writes nothing", async () => {
  const c = await READY;
  const writes = [];
  const summary = await c.runRetentionCleanup({
    getExams: () => Promise.resolve([{ id: "E1", date: "2024-01-01", session: "FN" }]),
    getPlans: () => Promise.resolve([{ id: "P1", exam_id: "E1" }]),
    write: (u) => { writes.push(u); return Promise.resolve(); },
    log: () => {},
  }, { dryRun: true, retentionMs: 48 * 3600 * 1000, tzOffsetMinutes: 0, sessionEndMin: { FN: 780, AN: 1020 } }, Date.now() + 1);
  eq(summary.dryRun, true);
  eq(summary.examined, 1);
  eq(summary.candidates, 1);
  eq(summary.deleted, 0);
  eq(writes.length, 0, "dry run never writes");
});

// ── runRetentionCleanup: live run ────────────────────────────────────────────
ait("a live run deletes only expired exams and joins their plans in one write", async () => {
  const c = await READY;
  const writes = [];
  const summary = await c.runRetentionCleanup({
    getExams: () => Promise.resolve([
      { id: "OLD", date: "2024-01-01", session: "AN" },   // expired -> deleted
      { id: "NOW", date: "2026-10-14", session: "AN" },   // finishes exactly now -> kept
    ]),
    getPlans: () => Promise.resolve([{ id: "POLD", exam_id: "OLD" }, { id: "PNOW", exam_id: "NOW" }]),
    examExists: () => Promise.resolve(true),
    write: (u) => { writes.push(u); return Promise.resolve(); },
    log: () => {},
  }, { dryRun: false, retentionMs: 48 * 3600 * 1000, tzOffsetMinutes: 330, sessionEndMin: { FN: 780, AN: 1020 } }, NOW);
  eq(summary.deleted, 1, "one expired exam deleted");
  eq(summary.plansDeleted, 1, "its plan deleted with it");
  const all = Object.assign({}, ...writes);
  eq(all["exams/OLD"], null);
  eq(all["seating_plans/POLD"], null);
  eq(all["exams/NOW"], undefined, "an in-session exam is never touched");
  eq(all["seating_plans/PNOW"], undefined);
});

ait("verify-before-delete skips an exam that vanished since the read", async () => {
  const c = await READY;
  const writes = [];
  const summary = await c.runRetentionCleanup({
    getExams: () => Promise.resolve([{ id: "GONE", date: "2024-01-01", session: "FN" }, { id: "STAY", date: "2024-01-01", session: "FN" }]),
    getPlans: () => Promise.resolve([{ id: "PG", exam_id: "GONE" }, { id: "PS", exam_id: "STAY" }]),
    examExists: (id) => Promise.resolve(id === "STAY"),
    write: (u) => { writes.push(u); return Promise.resolve(); },
    log: () => {},
  }, { dryRun: false, retentionMs: 48 * 3600 * 1000, tzOffsetMinutes: 0, sessionEndMin: { FN: 780, AN: 1020 } }, Date.UTC(2026, 9, 15, 8, 30));
  eq(summary.deleted, 1);
  ok(!writes.some((u) => u["seating_plans/PG"]), "the vanished exam's plan is never guessed at");
  ok(summary.skipped.some((sk) => sk.id === "GONE"), "the vanish is reported as a skip");
});

ait("the run is bounded: excess paths are deferred, not force-applied", async () => {
  const c = await READY;
  const exams = Array.from({ length: 3 }, (_, i) => ({ id: "E" + i, date: "2024-01-01", session: "FN" }));
  const writes = [];
  const summary = await c.runRetentionCleanup({
    getExams: () => Promise.resolve(exams),
    getPlans: () => Promise.resolve([{ id: "P0", exam_id: "E0" }, { id: "P1", exam_id: "E1" }, { id: "P2", exam_id: "E2" }]),
    examExists: () => Promise.resolve(true),
    write: (u) => { writes.push(u); return Promise.resolve(); },
    log: () => {},
  }, { dryRun: false, retentionMs: 48 * 3600 * 1000, tzOffsetMinutes: 0, sessionEndMin: { FN: 780, AN: 1020 }, maxDeletesPerRun: 2 }, Date.now() + 1);
  eq(summary.deferred, 1, "the third exam stayed over the budget");
  eq(summary.deleted, 2, "two exam + plan pairs applied within the budget");
  const all = Object.assign({}, ...writes);
  eq(all["exams/E0"], null, "E0 applied");
  eq(all["exams/E1"], null, "E1 applied");
  eq(all["seating_plans/P2"], undefined, "a deferred exam is never half-deleted");
});

ait("multi-location writes are chunked to at most 200 paths per request", async () => {
  const c = await READY;
  const N = 250;
  const exams = Array.from({ length: N }, (_, i) => ({ id: "E" + i, date: "2024-01-01", session: "FN" }));
  const sizes = [];
  const summary = await c.runRetentionCleanup({
    getExams: () => Promise.resolve(exams),
    getPlans: () => Promise.resolve(exams.map((_, i) => ({ id: "P" + i, exam_id: "E" + i }))),
    examExists: () => Promise.resolve(true),
    write: (u) => { sizes.push(Object.keys(u).length); return Promise.resolve(); },
    log: () => {},
  }, { dryRun: false, retentionMs: 48 * 3600 * 1000, tzOffsetMinutes: 0, sessionEndMin: { FN: 780, AN: 1020 }, maxDeletesPerRun: 1000 }, Date.now() + 1);
  eq(summary.deleted, N, "all 250 expired exams deleted across the run");
  ok(sizes.every((n) => n <= 200), "every write carries <= 200 paths: " + JSON.stringify(sizes));
  ok(sizes.length > 1, "the write was split into several requests");
});

// ── parity with the app ──────────────────────────────────────────────────────
ait("the retention session ends agree with the app's attendance sheets", async () => {
  const c = await READY;
  const html = fs.readFileSync("index.html", "utf8");
  ok(html.indexOf("01:00 PM") >= 0 && html.indexOf("05:00 PM") >= 0, "the attendance labels print 01:00 PM / 05:00 PM");
  ok(/function isExamEnded/.test(html), "the app still has isExamEnded");
  ok(html.indexOf('hour >= 13') >= 0, "the app treats 13:00 as FN end");
  ok(html.indexOf('hour >= 17') >= 0, "the app treats 17:00 as AN end");
  eq(c.DEFAULT_SESSION_END_MIN.FN, 13 * 60, "core FN end = 13:00");
  eq(c.DEFAULT_SESSION_END_MIN.AN, 17 * 60, "core AN end = 17:00");
});

it("the scheduled function stays inert until configured", () => {
  const fn = fs.readFileSync("netlify/functions/retention-cleanup.mjs", "utf8");
  ok(/schedule:\s*"@daily"/.test(fn), "the function is scheduled @daily");
  ok(fn.indexOf('RETENTION_DRY_RUN || "true"') >= 0, "dry run is the default");
  ok(/requiredEnv/.test(fn), "missing credentials make the run fail closed");
  ok(fn.indexOf("firebase-admin") >= 0, "it uses the Admin SDK, not browser Firebase");
  const core = fs.readFileSync("netlify/shared/retention_core.mjs", "utf8");
  ok(core.indexOf('import ') < 0, "the core module has zero imports — testable anywhere");
});

it("the deployment doc states the feature is NOT active yet", () => {
  const doc = fs.readFileSync("RETENTION_48H.md", "utf8");
  ok(/NOT DEPLOYED \/ NOT ACTIVE/.test(doc), "the status is honest");
  ok(/RETENTION_DRY_RUN/.test(doc), "dry-run-first is documented");
});

module.exports = s;