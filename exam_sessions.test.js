// Regression tests for the grouped Exam Sessions (EXAMS) page.
//
// The Exams page now renders compact per-exam rows under date ➜ session
// headings ("Wednesday, 14 October 2026" / "FN (Morning)") instead of one big
// card per exam. All the grouping/heading logic lives in pure helpers
// (examGroupsByDateSession, examDateHeading, examWeekday) so it is asserted here
// directly, while the page wiring (per-group select-all, collapsed groups,
// preserved per-row actions) is pinned against the rendered source. Nothing here
// touches React, Firebase or the DOM; grouping NEVER merges or rewrites records,
// so ids, native date values and exam-to-plan linkage are untouched.
const fs = require("fs");
const h = require("./harness.js");
const api = h.load();

const s = h.suite("exam_sessions.test.js — grouped Exam Sessions page");
const { it, eq, ok } = s;

function exam(id, date, session, extra) {
  return Object.assign({
    id: id, subject: "University", subjectTitle: id, date: date, session: session,
    groups: [{ dept: "CSE", year: 1 }], status: "scheduled",
  }, extra || {});
}

// ── grouping logic ───────────────────────────────────────────────────────────
it("G1 exams group by date, then by session, with FN before AN on the same date", () => {
  const in1 = [
    exam("e2", "2026-10-14", "AN"),
    exam("e1", "2026-10-14", "FN"),
    exam("e3", "2026-10-14", "FN"),
    exam("e4", "2026-10-15", "FN"),
  ];
  const g = api.examGroupsByDateSession(in1);
  eq(g.map(x => x.date), ["2026-10-14", "2026-10-15"], "dates sort ascending");
  eq(g[0].sessions.map(x => x.session), ["FN", "AN"], "same date, FN then AN");
  eq(g[0].sessions[0].exams.map(x => x.id), ["e1", "e3"], "session order preserved within FN");
  eq(g[0].sessions[1].exams.map(x => x.id), ["e2"], "AN has its own subgroup");
  eq(g[0].exams.map(x => x.id), ["e1", "e3", "e2"], "flattened in session order");
  eq(g[1].exams.map(x => x.id), ["e4"], "second date is a separate group");
});

it("G2 grouping never merges or rewrites exam records — identity and values are preserved", () => {
  const orig = [exam("x1", "2026-10-14", "FN", { groups: [{ dept: "MECH", sem: "03" }], registerNumbers: ["A"] })];
  const g = api.examGroupsByDateSession(orig);
  const round = g[0].sessions[0].exams[0];
  eq(round === orig[0], true, "same object reference, not a clone/merge");
  eq(round.id, "x1");
  eq(round.date, "2026-10-14", "native YYYY-MM-DD date value untouched");
  eq(round.session, "FN");
  eq(round.registerNumbers[0], "A");
});

it("G3 missing, junk and multi-day dates group safely and sort last", () => {
  const g = api.examGroupsByDateSession([
    exam("a", "", "FN"),
    exam("b", "2026-10-06 to 2026-10-16", "AN"),
    exam("c", "junk", "FN"),
    exam("d", "2026-10-14", "FN"),
  ]);
  eq(g.map(x => x.date), ["2026-10-14", "", "2026-10-06 to 2026-10-16", "junk"],
    "invalid/missing dates never crash and sort after valid ISO dates");
  eq(g[0].exams[0].id, "d", "valid date still first");
  eq(g[1].exams.map(x => x.id), ["a"], "blank date groups under its own group");
  eq(g[2].sessions[0].session, "AN", "the multi-day range keeps its session");
});

it("G4 empty input yields empty groups (no phantom empty date/session groups)", () => {
  eq(api.examGroupsByDateSession([]), [], "no exams → no groups");
  eq(api.examGroupsByDateSession(null), [], "null-safe");
});

it("G5 unknown sessions fall back to their own subgroup after FN and AN", () => {
  const g = api.examGroupsByDateSession([
    exam("a", "2026-10-14", "FN"),
    exam("b", "2026-10-14", "QA"),
    exam("c", "2026-10-14", "AN"),
  ]);
  eq(g[0].sessions.map(x => x.session), ["FN", "AN", "QA"], "unknown session sorts last, still visible");
});

// ── heading helpers ──────────────────────────────────────────────────────────
it("G6 examDateHeading renders '<Weekday>, <date>' via the shared date formatter", () => {
  eq(api.examDateHeading("2026-10-14"), "Wednesday, 14 October 2026");
  eq(api.examDateHeading("2026-01-05"), "Monday, 5 January 2026");
  eq(api.examWeekday("2026-12-31"), "Thursday");
  eq(api.examWeekday("2026-10-14"), "Wednesday");
});

it("G7 examDateHeading falls back to the shared formatter for missing/blank dates", () => {
  eq(api.examDateHeading(""), "", "blank stays blank (the page shows its own fallback label)");
  eq(api.examDateHeading("junk"), "junk", "junk passed through unchanged, per examDateLong");
  eq(api.examDateHeading("2026-10-06 to 2026-10-16"), "2026-10-06 to 2026-10-16", "ranges never collapsed");
  eq(api.examWeekday(""), "", "no weekday for a blank date");
  eq(api.examWeekday("not-a-date"), "", "no weekday for an invalid date");
  eq(api.examWeekday("2026-02-30"), "", "calendar-invalid dates do not fabricate a weekday");
});

// ── page wiring (source-level, the parts that must not regress) ──────────────
function examsPageBody() {
  const html = fs.readFileSync(h.HTML, "utf8");
  const start = html.indexOf("function ExamsPage(");
  ok(start >= 0, "ExamsPage exists");
  return html.slice(start, html.indexOf("function SeatingPage(", start));
}

it("G8 the page groups visible exams through examGroupsByDateSession and keeps the shared formatters", () => {
  const body = examsPageBody();
  ok(/examGroupsByDateSession\(visibleExams\)/.test(body), "the page drives the tested grouping helper");
  ok(/examDateHeading\(g\.date\)/.test(body), "date headings use the weekday+date helper");
  ok(/examSessionLong\(s\.session\)/.test(body), "session sub-headings use the shared session formatter");
  ok(/examSessionLong\(exam\.session\)/.test(body), "each row still shows the shared session label");
  ok(/examDateLong\(exam\.date\)/.test(body), "each row still shows the shared date label");
  ok(!/nice and simple flat list/.test(body), "sanity check on the slice boundary");
});

it("G9 individual selection and the bulk-delete workflow are unchanged", () => {
  const body = examsPageBody();
  ok(/toggleExamSel\(exam\.id\)/.test(body), "each row keeps the individual toggle");
  ok(/selExams\.has\(exam\.id\)/.test(body), "row highlight reads the same selection set");
  ok(/const \[selExams,setSelExams\]/.test(body), "the selection state is the same Set");
  ok(/bulkRemoveExams/.test(body), "bulk delete still consumes the same selection");
  ok(/visibleExams\.map/.test(body) || /examGroupsByDateSession\(visibleExams\)/.test(body), "visibleExams feeding the page list");
  ok(/allExamsVisibleSelected/.test(body), "the top-level select-all toolbar is preserved");
});

it("G10 per-group and per-session select-all exist; per-row actions are preserved", () => {
  const body = examsPageBody();
  ok(/toggleGroupAll\(g\)/.test(body), "date-group select-all toggles the whole group");
  ok(/toggleSessionAll\(s\)/.test(body), "session select-all toggles one session subgroup");
  ok(/checked=\{dSel\}/.test(body), "group checkbox reflects group selection");
  ok(/checked=\{sSel\}/.test(body), "session checkbox reflects session selection");
  ok(/openEdit\(exam\)/.test(body), "per-row Edit survives");
  ok(/onGenerate\(exam\)/.test(body), "per-row Generate / Re-Generate survives");
  ok(/removeExam\(exam\)/.test(body), "per-row Remove survives");
  ok(/exam\.seatinggenerated\?"Re-Generate":"Generate Seating"/.test(body), "generate label still reflects status");
});

it("G11 expand/collapse controls and per-group counts exist", () => {
  const body = examsPageBody();
  ok(/const \[collapsed,setCollapsed\]/.test(body), "collapse state exists");
  ok(/toggleCollapse/.test(body), "per-group toggle exists");
  ok(/collapseAll/.test(body), "'Collapse all' exists");
  ok(/expandAll/.test(body), "'Expand all' exists");
  ok(/g\.exams\.length/.test(body), "date group shows its exam count");
  ok(/s\.exams\.length/.test(body), "session subgroup shows its exam count");
  ok(/(gSeated|gPending)/.test(body), "seated/pending breakdown per group");
});

it("G12 the empty state, the add modal, the bulk modal and the tabs are untouched", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  const body = examsPageBody();
  ok(/No upcoming exams\./.test(body), "upcoming empty-state message kept");
  ok(/No ended exams\./.test(body), "ended empty-state message kept");
  ok(/showAdd&&<Modal title=\{editExam\?"Edit Exam":"Create Exam"\}/.test(body), "create/edit modal still wired");
  ok(/showBulk&&<BulkSeatingModal/.test(body), "Bulk Seating by Date still wired");
  const tabsStart = html.indexOf("Upcoming / Ended tabs");
  ok(tabsStart > 0 && html.indexOf("isExamEnded", tabsStart) > tabsStart, "upcoming/ended tabs still use isExamEnded");
});

module.exports = s;