// Regression tests for the hall-first Bulk Seating by Date flow.
//
// Before: the modal was EXAM-first — pick a date, tick exams, generate. The
// operator could not see which halls were free, how many seats remained in
// them, or how many students would be left over, until AFTER a run had already
// overwritten plans. A batch could "succeed" for one exam and silently fail
// another because the halls of its type were full.
//
// Now: pick a date AND session, then a hall-selection step shows every hall's
// physical/usable/occupied/remaining seats and a clear selectable state, and
// blocks generation until the chosen halls can seat the (de-duplicated) demand.
// Generation is confined to the halls actually picked.
//
// The selection maths is pure, so the whole capacity/eligibility contract is
// asserted here over synthetic data; the generator is driven directly with an
// injected savePlan.
const fs = require("fs");
const h = require("./harness.js");
const api = h.load();

const s = h.suite("hall_selection.test.js — hall-first bulk seating");
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

// ── session filter ───────────────────────────────────────────────────────────
it("H1 bulkSessionExams keeps only the requested date + session", () => {
  const exams = [
    exam("FN1", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }]),
    exam("AN1", "2025-12-01", "AN", [{ dept: "CSE", year: 1 }]),
    exam("FN2", "2025-12-02", "FN", [{ dept: "CSE", year: 1 }]),
  ];
  eq(api.bulkSessionExams(exams, "2025-12-01", "FN").map(function (e) { return e.id; }), ["FN1"]);
  eq(api.bulkSessionExams(exams, "2025-12-01", "an").map(function (e) { return e.id; }), ["AN1"]);
});

it("H2 bulkExamRows stays date-only when session is omitted, filters when given", () => {
  const exams = [
    exam("FN1", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }]),
    exam("AN1", "2025-12-01", "AN", [{ dept: "CSE", year: 1 }]),
  ];
  const st = students(3, "CSE", 1);
  const halls = [hall("h1", "University", 5)];
  eq(api.bulkExamRows(exams, "2025-12-01", st, halls, {}).map(function (r) { return r.id; }), ["FN1", "AN1"], "date-only is unchanged");
  eq(api.bulkExamRows(exams, "2025-12-01", st, halls, {}, "FN").map(function (r) { return r.id; }), ["FN1"]);
  eq(api.bulkExamRows(exams, "2025-12-01", st, halls, {}, "AN").map(function (r) { return r.id; }), ["AN1"]);
});

// ── roster de-duplication ────────────────────────────────────────────────────
it("H3 a student admitted to two selected exams is counted once for demand", () => {
  const a1 = exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }]);
  const b1 = exam("B", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }]);
  const st = students(4, "CSE", 1);
  const rec = api.bulkDedupeRoster([a1, b1], st, api.bulkBuildLookups(st, [a1, b1], []));
  eq(rec.count, 4, "not 8");
  eq(rec.duplicates.length, 4, "every shared regno is reported");
  ok(rec.duplicates[0].exams.length === 2, "the duplicate names both exams");
});

it("H4 the reported demand de-duplicates across the selected exams", () => {
  const a1 = exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }]);
  const b1 = exam("B", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }]);
  const st = students(4, "CSE", 1);
  const plan = api.bulkHallSelectionData({
    date: "2025-12-01", session: "FN", allExams: [a1, b1], students: st,
    halls: [hall("h1", "University", 5)], plansById: {}, selectedExamIds: ["A", "B"],
    selectedHallIds: ["h1"], loadComplete: true,
  });
  eq(plan.totals.demand, 4);
});

// ── occupancy ────────────────────────────────────────────────────────────────
it("H5 occupancy counts OTHER plans' seats and excludes the exams being regenerated", () => {
  const sel = exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }]);
  const other = exam("B", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }]);
  const halls = [hall("h1", "University", 5)];
  const plans = { A: { h1: { hallName: "h1", seats: [{ bench: 1, slot: 1, examId: "A" }] } },
                  B: { h1: { hallName: "h1", seats: [{ bench: 2, slot: 1, examId: "B" }] } } };
  const occ = api.bulkHallOccupancy([sel, other], halls, plans, "2025-12-01", "FN", ["A"]);
  eq(occ["h1"].size, 1, "only exam B's seat occupies the hall");
});

it("H6 a selected exam's own old plan does not count against its new layout", () => {
  const sel = exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }]);
  const halls = [hall("h1", "University", 5)];
  const plans = { A: { h1: { hallName: "h1", seats: [{ bench: 1, slot: 1 }, { bench: 1, slot: 2 }] } } };
  const occ = api.bulkHallOccupancy([sel], halls, plans, "2025-12-01", "FN", ["A"]);
  ok(!occ["h1"] || occ["h1"].size === 0, "own plan ignored");
});

// ── per-hall rows ────────────────────────────────────────────────────────────
it("H7 remaining = usable - occupied, and physical/usable are both exposed", () => {
  const sel = exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }]);
  const other = exam("B", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }]);
  const halls = [{ id: "h1", name: "h1", hallType: "University", numbenches: 5, studentsperbench: 3, capacity: 10 }];
  const plans = { B: { h1: { hallName: "h1", seats: [{ bench: 1, slot: 1 }, { bench: 1, slot: 2 }, { bench: 1, slot: 3 }] } } };
  const plan = api.bulkHallSelectionData({
    date: "2025-12-01", session: "FN", allExams: [sel, other], students: students(4, "CSE", 1),
    halls: halls, plansById: plans, selectedExamIds: ["A"], selectedHallIds: ["h1"], loadComplete: true,
  });
  const row = plan.hallRows.filter(function (r) { return r.id === "h1"; })[0];
  eq(row.physical, 15, "physical inventory");
  eq(row.usable, 10, "declared capacity bounds the usable seats");
  eq(row.occupied, 3, "the other exam's seats count");
  eq(row.remaining, 7);
});

it("H8 a hall whose type no selected exam uses is unselectable with a reason", () => {
  const sel = exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }]);
  const plan = api.bulkHallSelectionData({
    date: "2025-12-01", session: "FN", allExams: [sel], students: students(2, "CSE", 1),
    halls: [hall("h1", "University", 5), hall("c1", "CAT", 5)], plansById: {},
    selectedExamIds: ["A"], selectedHallIds: [], loadComplete: true,
  });
  const cat = plan.hallRows.filter(function (r) { return r.id === "c1"; })[0];
  eq(cat.selectable, false);
  ok(/uses CAT halls/.test(cat.reason), cat.reason);
});

it("H9 an unreadable plans load disables every hall and the whole validation", () => {
  const sel = exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }]);
  const plan = api.bulkHallSelectionData({
    date: "2025-12-01", session: "FN", allExams: [sel], students: students(2, "CSE", 1),
    halls: [hall("h1", "University", 5)], plansById: {}, selectedExamIds: ["A"],
    selectedHallIds: [], loadComplete: false,
  });
  eq(plan.hallRows[0].selectable, false);
  eq(plan.validation.ok, false);
  ok(/could not be fully loaded/i.test(plan.validation.errors[0]));
});

it("H10 alias hall records collapse to a single selectable row", () => {
  const sel = exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }]);
  const plan = api.bulkHallSelectionData({
    date: "2025-12-01", session: "FN", allExams: [sel], students: students(2, "CSE", 1),
    halls: [hall("h1", "University", 5), { id: "h1-copy", name: "h1", hallType: "University", numbenches: 5, studentsperbench: 3 }],
    plansById: {}, selectedExamIds: ["A"], selectedHallIds: [], loadComplete: true,
  });
  eq(plan.hallRows.length, 1, "one physical hall, one row");
});

it("H11 selecting no hall is blocked with a clear error", () => {
  const sel = exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }]);
  const plan = api.bulkHallSelectionData({
    date: "2025-12-01", session: "FN", allExams: [sel], students: students(2, "CSE", 1),
    halls: [hall("h1", "University", 5)], plansById: {}, selectedExamIds: ["A"],
    selectedHallIds: [], loadComplete: true,
  });
  eq(plan.validation.ok, false);
  ok(/Select at least one hall/.test(plan.validation.errors.join(" ")));
});

it("H12 too much demand for the selected halls is blocked and reports the shortfall", () => {
  const sel = exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }]);
  const plan = api.bulkHallSelectionData({
    date: "2025-12-01", session: "FN", allExams: [sel], students: students(20, "CSE", 1),
    halls: [hall("h1", "University", 1, 3)], plansById: {}, selectedExamIds: ["A"],
    selectedHallIds: ["h1"], loadComplete: true,
  });
  eq(plan.totals.capacityStatus, "insufficient");
  eq(plan.totals.canAccommodate, 3);
  eq(plan.totals.shortfall, 17);
  eq(plan.validation.ok, false);
  ok(/free seat\(s\) but 20 student/.test(plan.validation.errors.join(" ")));
});

it("H13 sufficient capacity is OK and reports spare seats", () => {
  const sel = exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }]);
  const plan = api.bulkHallSelectionData({
    date: "2025-12-01", session: "FN", allExams: [sel], students: students(4, "CSE", 1),
    halls: [hall("h1", "University", 5)], plansById: {}, selectedExamIds: ["A"],
    selectedHallIds: ["h1"], loadComplete: true,
  });
  eq(plan.totals.capacityStatus, "sufficient");
  eq(plan.totals.freeAfter, 11);
  eq(plan.validation.ok, true);
});

it("H14 selecting an exam but no exam keeps the estimate honest (no demand)", () => {
  const sel = exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }]);
  const plan = api.bulkHallSelectionData({
    date: "2025-12-01", session: "FN", allExams: [sel], students: students(4, "CSE", 1),
    halls: [hall("h1", "University", 5)], plansById: {}, selectedExamIds: [],
    selectedHallIds: [], loadComplete: true,
  });
  eq(plan.totals.demand, 0);
  eq(plan.totals.capacityStatus, "no_eligible");
  eq(plan.validation.ok, false, "no exam selected is still blocked");
  eq(plan.hallRows[0].selectable, false);
});

// ── generation is confined to the chosen halls ───────────────────────────────
ait("H15 runBulkSeating only writes to the selected hall", async () => {
  const exams = [exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }])];
  const st = students(4, "CSE", 1);
  const halls = [hall("h1", "University", 5), hall("h2", "University", 5)];
  const saved = {};
  const res = await api.runBulkSeating({
    exams: exams, allExams: exams, students: st, halls: halls, rules: R(), coSeat: true,
    selectedHallIds: ["h1"], savePlan: async function (id, plan) { saved[id] = plan; },
  });
  eq(res.summary.completed, 1);
  eq(Object.keys(saved.A), ["h1"], "only the selected hall received seats");
});

ait("H16 a selected hall too small to seat demand fails honestly (no overwrite)", async () => {
  const exams = [exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }])];
  const st = students(4, "CSE", 1);
  const halls = [hall("h1", "University", 1, 3)];
  let wrote = null;
  const res = await api.runBulkSeating({
    exams: exams, allExams: exams, students: st, halls: halls, rules: R(), coSeat: true,
    selectedHallIds: ["h1"], plansById: { A: { h1: { seats: [{ bench: 1, slot: 1 }] } } },
    savePlan: async function (id, plan) { wrote = plan; },
  });
  eq(res.summary.completed, 0);
  eq(res.summary.failed, 1);
  ok(wrote === null, "the existing plan was not overwritten");
  eq(res.results[0].keptExisting, true);
});

ait("H17 a selected hall of the wrong type reports NO_ELIGIBLE_HALLS", async () => {
  const exams = [exam("A", "2025-12-01", "FN", [{ dept: "CSE", year: 1 }])];
  const halls = [hall("c1", "CAT", 5)];
  const res = await api.runBulkSeating({
    exams: exams, allExams: exams, students: students(4, "CSE", 1), halls: halls, rules: R(), coSeat: true,
    selectedHallIds: ["c1"], savePlan: async function () {},
  });
  eq(res.summary.completed, 0);
  eq(res.results[0].category, "NO_ELIGIBLE_HALLS");
});

// ── App is wired to the hall-first flow ──────────────────────────────────────
function modalBody() {
  const html = fs.readFileSync(h.HTML, "utf8");
  const start = html.indexOf("function BulkSeatingModal(");
  ok(start >= 0, "BulkSeatingModal exists");
  return html.slice(start, html.indexOf("function ExamsPage(", start));
}

it("H18 the modal has a session selector and a hall selection state", () => {
  const body = modalBody();
  ok(body.indexOf("const [bsession,setBsession]") >= 0, "session state exists");
  ok(body.indexOf("const [selectedHalls,setSelectedHalls]") >= 0, "hall selection state exists");
  ok(body.indexOf("bulkHallSelectionData") >= 0, "the live hall plan is computed");
  ok(body.indexOf("toggleHall") >= 0 && body.indexOf("selectAllHalls") >= 0, "hall controls exist");
});

it("H19 configure leads into the hall step before preview, not straight to preview", () => {
  const body = modalBody();
  const start = body.indexOf("function startBatch()");
  const seg = body.slice(start, body.indexOf("function continueToPreview", start));
  ok(/setStage\("halls"\)/.test(seg), "startBatch enters the hall step");
  ok(body.indexOf('stage==="halls"') >= 0, "a halls stage is rendered");
  ok(body.indexOf("continueToPreview") >= 0, "a continue action gates on validation");
});

it("H20 runBatch passes the selected halls into the generator", () => {
  const body = modalBody();
  const start = body.indexOf("async function runBatch");
  const seg = body.slice(start, body.indexOf("function startBatch", start));
  ok(seg.indexOf("selectedHallIds: Array.from(selectedHalls)") >= 0, "the chosen halls are handed to runBulkSeating");
});

it("H21 runBulkSeatingCoSeated honours cfg.selectedHallIds", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  const start = html.indexOf("async function runBulkSeatingCoSeated(cfg)");
  ok(start >= 0, "the co-seated orchestrator exists");
  const body = html.slice(start, html.indexOf("async function runBulkSeating(cfg)", start));
  ok(body.indexOf("cfg.selectedHallIds") >= 0, "the selection is read");
  ok(body.indexOf("canonicalHallId") >= 0, "selection ids are canonicalised");
});

module.exports = s;
