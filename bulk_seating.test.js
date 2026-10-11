// Regression tests for Bulk Seating by Date.
//
// Everything here drives the pure bulk helpers (date filtering, eligibility,
// lookup maps, hall selection, per-exam generation/validation) and the
// runBulkSeating orchestrator directly, with injected loadPlan/savePlan fakes.
// No React, Firebase or DOM is involved, so the whole batch contract — including
// failure, cancellation and retry — is asserted deterministically.
const fs = require("fs");
const h = require("./harness.js");
const api = h.load();

const s = h.suite("bulk_seating.test.js — bulk generation by date");
const { it, ait, eq, ok } = s;

function students(n, dept, year, gender) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: dept + year + "_" + i,
      regno: "6" + String(year) + String(dept.charCodeAt(0)) + String(i).padStart(4, "0"),
      name: dept + " " + i,
      dept: dept, year: year,
      gender: gender === "alt" ? (i % 2 ? "female" : "male") : (gender || "male"),
    });
  }
  return out;
}
function hall(id, type, rows, perBench) {
  return { id: id, name: id, hallType: type || "University", numbenches: rows, studentsperbench: perBench || 3 };
}
function exam(id, date, session, groups, extra) {
  return Object.assign({
    id: id, subject: "University", subjectTitle: id, date: date, session: session,
    groups: groups, status: "scheduled",
  }, extra || {});
}
const R = () => ({ splitGender: false, noSameDept: false, noSameYear: false, benchAdjacency: false });

// ── date filtering ───────────────────────────────────────────────────────────
it("only exams on the selected date are returned", () => {
  const exams = [exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }]),
                 exam("B", "2025-12-02", "FN", [{ dept: "CSE", year: 1 }])];
  const rows = api.bulkExamRows(exams, "2025-12-01", students(3, "CSE", 1), [hall("h1", "University", 5)], {});
  eq(rows.map(function (r) { return r.id; }), ["A"]);
});

it("an empty or unknown date returns no rows", () => {
  const exams = [exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }])];
  eq(api.bulkExamRows(exams, "2099-01-01", [], [hall("h1", "University", 5)], {}), []);
  eq(api.bulkExamRows(exams, "", [], [hall("h1", "University", 5)], {}), []);
});

it("date matching tolerates surrounding whitespace and normalises sessions", () => {
  const exams = [exam("A", " 2025-12-01 ", " fn ", [{ dept: "CSE", year: 1 }])];
  const rows = api.bulkExamRows(exams, "2025-12-01", students(3, "CSE", 1), [hall("h1", "University", 5)], {});
  eq(rows.length, 1);
  eq(api.bulkCanonSession(" an "), "AN");
});

// ── FN / AN separation ───────────────────────────────────────────────────────
ait("FN and AN exams on the same date are separate plans", async () => {
  const exams = [
    exam("FN1", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }]),
    exam("AN1", "2025-12-01", "AN", [{ dept: "CSE", year: 1 }]),
  ];
  const st = students(6, "CSE", 1, "alt");
  const saved = {};
  const res = await api.runBulkSeating({
    exams: exams, allExams: exams, students: st, halls: [hall("h1", "University", 5)],
    rules: R(), savePlan: async function (id, plan) { saved[id] = plan; },
  });
  eq(res.summary.completed, 2, "both saved");
  ok(saved.FN1 && saved.AN1, "each session has its own plan");
  ok(saved.FN1 !== saved.AN1, "distinct plan objects, not one shared plan");
});

// ── eligibility ──────────────────────────────────────────────────────────────
it("an exam with no matching students is ineligible with a clear reason", () => {
  const exams = [exam("A", "2025-12-01", "FN", [{ dept: "ECE", year: 3 }])];
  const rows = api.bulkExamRows(exams, "2025-12-01", students(5, "CSE", 1), [hall("h1", "University", 5)], {});
  eq(rows[0].eligible, false);
  ok(/No eligible students/.test(rows[0].ineligibleReason), rows[0].ineligibleReason);
  eq(rows[0].eligibleStudents, 0);
});

it("a cancelled exam is ineligible and never merged with others", () => {
  const exams = [exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }], { status: "cancelled" })];
  const rows = api.bulkExamRows(exams, "2025-12-01", students(5, "CSE", 1), [hall("h1", "University", 5)], {});
  eq(rows[0].eligible, false);
  ok(/Cancelled/.test(rows[0].ineligibleReason));
});

it("eligibility respects year as well as department", () => {
  const exams = [exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 2 }])];
  const st = students(4, "CSE", 1).concat(students(6, "CSE", 2));
  const rows = api.bulkExamRows(exams, "2025-12-01", st, [hall("h1", "University", 5)], {});
  eq(rows[0].eligibleStudents, 6);
});

it("bulkExamStudents de-duplicates a student matched by two groups", () => {
  const exams = [exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }, { dept: "CSE", year: 1 }])];
  const st = students(4, "CSE", 1);
  const lookups = api.bulkBuildLookups(st, exams, []);
  const matched = api.bulkExamStudents(exams[0], st, lookups);
  eq(matched.length, 4, "no student counted twice");
});

// ── selection / exclusion ────────────────────────────────────────────────────
ait("only the selected exams are processed", async () => {
  const exams = [
    exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }]),
    exam("B", "2025-12-01", "AN", [{ dept: "CSE", year: 1 }]),
  ];
  const savedIds = [];
  await api.runBulkSeating({
    exams: [exams[0]], allExams: exams, students: students(4, "CSE", 1),
    halls: [hall("h1", "University", 5)], rules: R(),
    savePlan: async function (id) { savedIds.push(id); },
  });
  eq(savedIds, ["A"], "B was excluded");
});

ait("no exams selected is a clean no-op", async () => {
  const res = await api.runBulkSeating({ exams: [], allExams: [], students: [], halls: [], rules: R(), savePlan: async function () {} });
  eq(res.summary.total, 0);
  eq(res.summary.completed, 0);
  eq(res.results.length, 0);
});

// ── each seating rule ────────────────────────────────────────────────────────
ait("splitGender keeps male and female students in separate halls", async () => {
  const exams = [exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }])];
  const st = students(8, "CSE", 1, "alt");
  const gen = api.bulkGenerateOne(exams[0], st, [hall("h1", "University", 5), hall("h2", "University", 5)],
    { splitGender: true }, exams, {}, api.bulkBuildLookups(st, exams, []));
  eq(gen.ok, true, gen.reason || "");
  eq(api.validateGenderSeparation(gen.plan).length, 0);
});

ait("noSameDept produces a plan with no department adjacency violations", async () => {
  const exams = [exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }, { dept: "ECE", year: 1 }])];
  const st = students(6, "CSE", 1).concat(students(6, "ECE", 1));
  const gen = api.bulkGenerateOne(exams[0], st, [hall("h1", "University", 6), hall("h2", "University", 6)],
    { noSameDept: true }, exams, {}, api.bulkBuildLookups(st, exams, []));
  eq(gen.ok, true, gen.reason || "");
  eq(api.validatePlan(gen.plan, { noSameDept: true }).length, 0);
});

ait("noSameYear produces a plan with no year adjacency violations", async () => {
  const exams = [exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }, { dept: "CSE", year: 2 }])];
  const st = students(6, "CSE", 1).concat(students(6, "CSE", 2));
  const gen = api.bulkGenerateOne(exams[0], st, [hall("h1", "University", 6), hall("h2", "University", 6)],
    { noSameYear: true }, exams, {}, api.bulkBuildLookups(st, exams, []));
  eq(gen.ok, true, gen.reason || "");
  eq(api.validatePlan(gen.plan, { noSameYear: true }).length, 0);
});

ait("bulk hall selection treats course titles as University exams and not hall types", async () => {
  const exams = [exam("COURSE", "2025-12-01", "FN", [{ dept: "ECE", year: 2 }], { subject: "MIC and RF Design" })];
  const st = students(12, "ECE", 2);
  const gen = api.bulkGenerateOne(exams[0], st, [hall("h1", "University", 5)], R(), exams, {}, api.bulkBuildLookups(st, exams, []));
  eq(gen.ok, true, gen.reason || "course title should fall back to University hall type");
});

ait("bulk expands a single preferred hall for split-gender seating and keeps department rules", async () => {
  const exams = [exam("MIC", "2025-12-01", "FN", [{ dept: "ECE", year: 2 }], { subject: "MIC and RF Design", hallids: ["h1"] })];
  const st = students(31, "ECE", 2, "alt");
  const halls = [hall("h1", "University", 15, 3), hall("h2", "University", 15, 3), hall("h3", "University", 15, 3)];
  const rules = { splitGender: true, noSameDept: true, noSameYear: false, benchAdjacency: true };
  const gen = api.bulkGenerateOne(exams[0], st, halls, rules, exams, {}, api.bulkBuildLookups(st, exams, halls));
  eq(gen.ok, true, gen.reason || "31 students should fit across separate gender halls");
  eq((gen.unplaced || []).length, 0);
  eq(Object.keys(gen.plan).length, 2, "one hall per gender partition");
  eq(api.validatePlan(gen.plan, rules).length, 0, "department/bench rules validate");
  eq(api.validateGenderSeparation(gen.plan).length, 0, "genders remain in separate halls");
  ok((gen.ruleWarnings || []).some(function (w) { return /only one department/.test(w); }), "single-department rule exception is explicit");
});

ait("hall IDs on ungenerated exams are not treated as occupied reservations", async () => {
  const exams = [
    exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }], { hallids: ["h1", "h2"] }),
    exam("B", "2025-12-01", "FN", [{ dept: "ECE", year: 1 }], { hallids: ["h1", "h2"] }),
  ];
  const pool = api.bulkSelectHalls(exams[0], exams, [hall("h1", "University", 5), hall("h2", "University", 5)], {});
  eq(pool.halls.length, 2, "candidate hall IDs do not reserve halls before a plan exists");
  eq(pool.conflict, false);
});

ait("benchAdjacency validates on a CAT bench layout", async () => {
  const catHall = { id: "cat1", name: "CAT1", hallType: "CAT", numbenches: 6, layoutConfig: { columns: [{ seats: 3 }, { seats: 3 }] } };
  const exams = [exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }, { dept: "ECE", year: 1 }], { subject: "CAT" })];
  const st = students(8, "CSE", 1).concat(students(8, "ECE", 1));
  const gen = api.bulkGenerateOne(exams[0], st, [catHall], { benchAdjacency: true, noSameDept: true }, exams, {}, api.bulkBuildLookups(st, exams, []));
  eq(gen.ok, true, gen.reason || "");
  eq(api.validatePlan(gen.plan, { benchAdjacency: true, noSameDept: true }).length, 0);
});

// ── independent plans, no duplication ────────────────────────────────────────
ait("multiple exams receive independent, seat-disjoint plans", async () => {
  const exams = [
    exam("FN1", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }]),
    exam("FN2", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }]),
  ];
  const st = students(6, "CSE", 1);
  const saved = {};
  const res = await api.runBulkSeating({
    exams: exams, allExams: exams, students: st, halls: [hall("h1", "University", 5), hall("h2", "University", 5)],
    rules: R(), savePlan: async function (id, plan) { saved[id] = plan; },
  });
  ok(res.plansById.FN1 && res.plansById.FN2, "both plans tracked");
  const seats1 = new Set(Object.values(saved.FN1).flatMap(function (hp) { return (hp.seats || []).map(function (x) { return x.seatNo; }); }));
  const seats2 = Object.values(saved.FN2).flatMap(function (hp) { return (hp.seats || []).map(function (x) { return x.seatNo; }); });
  const overlap = seats2.filter(function (sn) { return seats1.has(sn); });
  eq(overlap.length, 0, "same-session exams do not reuse a physical seat");
});

ait("a plan never assigns the same student twice", async () => {
  const exams = [exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }])];
  const st = students(10, "CSE", 1);
  const gen = api.bulkGenerateOne(exams[0], st, [hall("h1", "University", 5), hall("h2", "University", 5)],
    R(), exams, {}, api.bulkBuildLookups(st, exams, []));
  const regnos = Object.values(gen.plan).flatMap(function (hp) { return (hp.seats || []).map(function (x) { return x.regno; }); });
  eq(regnos.length, new Set(regnos).size, "no duplicate registration numbers");
});

// ── capacity / unplaced ──────────────────────────────────────────────────────
ait("insufficient capacity fails the exam instead of saving unplaced students", async () => {
  const exams = [exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }])];
  const st = students(20, "CSE", 1);
  let saved = 0;
  const res = await api.runBulkSeating({
    exams: exams, allExams: exams, students: st, halls: [hall("h1", "University", 2)],
    rules: R(), savePlan: async function () { saved++; },
  });
  eq(res.results[0].status, "failed");
  eq(saved, 0, "nothing saved when students cannot be seated");
  ok((res.results[0].unplaced || []).length > 0);
});

// ── existing plans / overwrite confirmation ─────────────────────────────────
ait("an existing plan is preserved when overwrite is not confirmed", async () => {
  const exams = [exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }])];
  let saved = 0;
  const existing = { hX: { hallName: "X", seats: [{ regno: "old", seatNo: "X-B1S1" }] } };
  const res = await api.runBulkSeating({
    exams: exams, allExams: exams, students: students(4, "CSE", 1), halls: [hall("h1", "University", 5)],
    rules: R(), plansById: { A: existing }, confirmOverwrite: function () { return false; },
    savePlan: async function () { saved++; },
  });
  eq(saved, 0, "existing plan untouched");
  eq(res.results[0].status, "skipped");
  eq(res.summary.preserved, 1);
  ok(res.plansById.A === existing, "the existing plan is retained in state");
});

ait("an existing plan is replaced once the batch is explicitly confirmed", async () => {
  const exams = [exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }])];
  let saved = 0;
  const res = await api.runBulkSeating({
    exams: exams, allExams: exams, students: students(4, "CSE", 1), halls: [hall("h1", "University", 5)],
    rules: R(), plansById: { A: { hX: { seats: [] } } }, confirmOverwrite: function () { return true; },
    savePlan: async function () { saved++; },
  });
  eq(saved, 1);
  eq(res.results[0].status, "completed");
});

ait("a plan read failure does not look like a missing plan", async () => {
  const exams = [exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }])];
  let saved = 0;
  const res = await api.runBulkSeating({
    exams: exams, allExams: exams, students: students(4, "CSE", 1), halls: [hall("h1", "University", 5)],
    rules: R(), loadPlan: async function () { return undefined; }, confirmOverwrite: function () { return true; },
    savePlan: async function () { saved++; },
  });
  eq(saved, 1, "an unverified read is treated as 'needs generation', not as success");
  eq(res.results[0].status, "completed");
});

// ── failure isolation, reporting, retry ──────────────────────────────────────
ait("one exam failing does not corrupt another exam's plan", async () => {
  const exams = [
    exam("OK", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }]),
    exam("BAD", "2025-12-01", "AN", [{ dept: "CSE", year: 1 }], { subject: "CAT" }),
  ];
  const st = students(4, "CSE", 1);
  const res = await api.runBulkSeating({
    exams: exams, allExams: exams, students: st, halls: [hall("h1", "University", 5)],
    rules: R(), savePlan: async function () {},
  });
  const byId = {};
  res.results.forEach(function (r) { byId[r.examId] = r; });
  eq(byId.OK.status, "completed");
  eq(byId.BAD.status, "failed");
  eq(byId.BAD.code, "no_halls");
  ok(res.plansById.OK, "the successful exam's plan is stored");
});

ait("a failed database write is reported as save_failed, never success", async () => {
  const exams = [exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }])];
  const res = await api.runBulkSeating({
    exams: exams, allExams: exams, students: students(4, "CSE", 1), halls: [hall("h1", "University", 5)],
    rules: R(), savePlan: async function () { throw new Error("PERMISSION_DENIED"); },
  });
  eq(res.results[0].status, "save_failed");
  ok(/PERMISSION_DENIED/.test(res.results[0].reason));
  eq(res.summary.completed, 0);
  eq(res.summary.saveFailed, 1);
});

ait("a retry saves the exam once and does not duplicate the plan", async () => {
  const exams = [exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }])];
  const st = students(4, "CSE", 1);
  const calls = [];
  let failFirst = true;
  const savePlan = async function (id, plan) { calls.push(id); if (failFirst) { failFirst = false; throw new Error("network"); } };
  const first = await api.runBulkSeating({ exams: exams, allExams: exams, students: st, halls: [hall("h1", "University", 5)], rules: R(), savePlan: savePlan, confirmOverwrite: function () { return true; } });
  eq(first.results[0].status, "save_failed");
  const second = await api.runBulkSeating({ exams: exams, allExams: exams, students: st, halls: [hall("h1", "University", 5)], rules: R(), savePlan: savePlan, plansById: first.plansById, confirmOverwrite: function () { return true; } });
  eq(second.results[0].status, "completed");
  eq(calls, ["A", "A"], "the retry upserts the same exam id, never a second plan");
  eq(Object.keys(second.plansById).length, 1);
});

// ── cancellation ─────────────────────────────────────────────────────────────
ait("cancellation between exams leaves the rest untouched", async () => {
  const exams = [
    exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }]),
    exam("B", "2025-12-01", "AN", [{ dept: "CSE", year: 1 }]),
    exam("C", "2025-12-02", "FN", [{ dept: "CSE", year: 1 }]),
  ];
  const st = students(4, "CSE", 1);
  const saved = [];
  let done = 0;
  const res = await api.runBulkSeating({
    exams: exams, allExams: exams, students: st, halls: [hall("h1", "University", 5)], rules: R(),
    isCancelled: function () { return done >= 1; },
    savePlan: async function (id) { saved.push(id); done++; },
  });
  eq(saved, ["A"], "only the first exam was saved before cancellation");
  eq(res.results.filter(function (r) { return r.status === "skipped"; }).length, 2);
});

// ── data reuse (no N+1 reads) ────────────────────────────────────────────────
ait("existing in-memory plans are not re-read from the database", async () => {
  const exams = [
    exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }]),
    exam("B", "2025-12-01", "AN", [{ dept: "CSE", year: 1 }]),
  ];
  const st = students(4, "CSE", 1);
  let loads = 0;
  await api.runBulkSeating({
    exams: exams, allExams: exams, students: st, halls: [hall("h1", "University", 5)], rules: R(),
    plansById: { A: { h1: { seats: [] } } },
    loadPlan: async function () { loads++; return null; },
    savePlan: async function () {},
  });
  eq(loads, 1, "only the plan missing from memory is read (B), never A");
});

// ── DATE SCOPING: a run never writes another date ────────────────────────────
// Reported confusion: a Bulk Seating run for 14-10-2026 reported "14 exams
// generated and saved" while seating for 15-10 and 16-10 was also visible. Those
// other dates were PRE-EXISTING (their own earlier runs); the batch is strictly
// scoped to the selected exams, which are only the chosen date's exams. This test
// pins that: only the selected date's exams are written and pre-existing plans on
// other dates are left untouched.
ait("a run for one date writes ONLY that date's exams and preserves other dates' plans", async () => {
  const d14 = [
    exam("E14A", "2026-10-14", "FN", [{ dept: "CSE", year: 1 }]),
    exam("E14B", "2026-10-14", "FN", [{ dept: "ECE", year: 1 }]),
  ];
  const other = [
    exam("E15", "2026-10-15", "FN", [{ dept: "CSE", year: 1 }]),
    exam("E16", "2026-10-16", "FN", [{ dept: "CSE", year: 1 }]),
  ];
  const allExams = d14.concat(other);
  // Pre-existing plans for the other dates, exactly as a previous run saved them.
  const pre15 = { h1: { hallName: "h1", seats: [{ regno: "OLD15", dept: "CSE", seatNo: "h1-B1S1" }] } };
  const pre16 = { h1: { hallName: "h1", seats: [{ regno: "OLD16", dept: "CSE", seatNo: "h1-B1S1" }] } };
  const plansById = { E15: pre15, E16: pre16 };
  const written = {};
  const res = await api.runBulkSeating({
    exams: d14, allExams: allExams,
    students: students(4, "CSE", 1).concat(students(4, "ECE", 1)),
    halls: [hall("h1", "University", 5), hall("h2", "University", 5)], rules: R(),
    plansById: plansById,
    savePlan: async function (id, plan) { written[id] = plan; },
  });
  eq(Object.keys(written).sort(), ["E14A", "E14B"], "only the selected date's exams were written");
  ok(!("E15" in written) && !("E16" in written), "15-10 and 16-10 were never written");
  eq(res.results.map(function (r) { return r.examId; }).sort(), ["E14A", "E14B"], "only 14-10 exams were processed");
  eq(res.summary.completed, 2, "both 14-10 exams completed");
  eq(plansById.E15, pre15, "the pre-existing 15-10 plan is untouched");
  eq(plansById.E16, pre16, "the pre-existing 16-10 plan is untouched");
});

// ── existing single-exam behaviour is untouched ──────────────────────────────
it("the seating engine and single-exam flow are unchanged", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  ok(/function generateSmartSeating\(groups, halls, hallUsedSeats\)/.test(html), "engine signature preserved");
  ok(/const plan = generateSmartSeating\(groups, examHalls, hallUsedSeats\)/.test(html), "single-exam flow still calls the engine directly");
  ok(/async function runBulkSeating\(cfg\)/.test(html), "bulk orchestrator is separate from the single-exam flow");
});

it("bulk persistence goes through the college-scoped Store helpers", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  const start = html.indexOf("function BulkSeatingModal(");
  ok(start >= 0, "the bulk modal exists");
  const body = html.slice(start, html.indexOf("function ExamsPage(", start));
  ok(/Store\.setSeatingPlan\(/.test(body), "saves via the college-scoped seating-plan helper");
  ok(/Store\.updateExam\(/.test(body), "updates the exam via the college-scoped helper");
  ok(/runBulkSeating\(/.test(body), "the UI drives the tested orchestrator");
  ok(/typeof onGenerate!=="function"|onGenerate/.test(html), "sanity");
});

module.exports = s;
