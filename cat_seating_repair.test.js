// Regression tests for ExamSeatPro v66 — Critical CAT Seating Engine Repair.
//
// Reported defects:
//   A. A CAT exam ("Foundations of Robotics", 14-10-2026 FN) with 17 eligible
//      students was assigned ZERO seats and reported "Hall capacity exhausted";
//      a retry repeated the same failure.
//   B. Same-department students can still sit side-by-side in CAT layouts.
//   C. A failed Retry leaves the OLD seating visible with no "previous plan
//      preserved" disclosure — a failed generation could be mistaken for a
//      successful replacement.
//
// The engine must use ONE authoritative physical capacity model
// (configured = declared, physical = layout, usable = min), fill the first
// eligible hall to its usable bound first, discover CAT halls from the exam's
// category bucket (never treat a course title as a hall type), never silently
// swallow a plan-load failure, never silently disable an enabled rule, hard-
// block enabled mandatory-rule violations at manual placement and save, and
// reveal exactly what a retry did (new plan, preserved old plan, or failures
// categorised as NO_ELIGIBLE_HALLS / HALLS_RESERVED / HALL_CAPACITY_EXHAUSTED /
// NO_LEGAL_SEAT / ADJACENCY_CONSTRAINT_UNSATISFIABLE / INVALID_HALL_LAYOUT /
// DATA_LOAD_FAILED / VALIDATION_REJECTED / SAVE_FAILED).
//
// The mandated fixture (16 AID S + 1 MECH on LH-1, declared 45 = physical 45,
// noSameDept ON, benchAdjacency OFF) is pinned below together with the
// CURRENT-DEFECT cases that fail against the engine as shipped.
const h = require("./harness.js");
const api = h.load();

const s = h.suite("cat_seating_repair.test.js — CAT capacity, adjacency, retry truthfulness");
const { it, ait, eq, ok } = s;

const FN = "14-10-2026";
const RULES_OFF = { splitGender: false, noSameDept: false, noSameYear: false, benchAdjacency: false };

function hall(id, name, hallType, rows, colSeats, capacity) {
  const columns = colSeats.map(function (c) { return (typeof c === "object") ? c : { seats: c }; });
  const perRow = columns.reduce(function (a, c) { return a + (c.seats || 1); }, 0);
  const out = {
    id: id, name: name, hallType: hallType,
    numbenches: rows, studentsperbench: perRow,
    layoutConfig: { columns: columns },
  };
  if (capacity !== undefined) out.capacity = capacity;
  return out;
}

function students(n, dept, year, gender) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: dept + "_" + i,
      regno: "9" + String(10 + i).padStart(4, "0") + String(dept.charCodeAt(0)) + String(i).padStart(2, "0"),
      name: dept + " " + i, dept: dept, year: year || 1, gender: gender || "male",
    });
  }
  return out;
}

function gridSeats(n, nCols, nRows, nSlots) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const ci = i % nCols, sl = Math.min(nSlots, Math.floor(i / (nCols * nRows)) + 1);
    const ri = Math.floor(i / nCols) % nRows;
    out.push({
      regno: "R" + i, seatNo: "g-" + ci + "_" + ri + "_" + sl, seatLabel: "X" + i,
      colIdx: ci, rowIdx: ri, slot: sl, dept: "MECH",
    });
  }
  return out;
}

function planEntry(hallObj, seats) {
  return {
    hallName: hallObj.name, numbenches: hallObj.numbenches,
    studentsperbench: hallObj.studentsperbench, layoutConfig: hallObj.layoutConfig,
    capacity: api.hallUsableCapacity(hallObj), seats: seats,
  };
}

// Physical side-by-side model shared by the allocator, the validator and the
// manual renderer: within a bench, the seat immediately on the left; across
// benches within the same row, the seat facing the LEFT column's rightmost
// filled slot. Rows are never compared.
function sameDept(a, b) {
  return String((a && a.dept == null ? "GEN" : (a && a.dept)) || "").trim().toUpperCase()
      === String((b && b.dept == null ? "GEN" : (b && b.dept)) || "").trim().toUpperCase();
}
function adjacentPairs(plan) {
  let pairs = 0;
  for (const hp of Object.values(plan || {})) {
    const seats = (hp && hp.seats) || [];
    for (const a of seats) {
      const left = seats.find(function (x) { return x.colIdx === a.colIdx && x.rowIdx === a.rowIdx && x.slot === a.slot - 1; });
      let facing = null;
      if (a.slot === 1 && a.colIdx > 0) {
        const prev = seats.filter(function (x) { return x.colIdx === a.colIdx - 1 && x.rowIdx === a.rowIdx; });
        if (prev.length) facing = prev.reduce(function (m, x) { return x.slot > m.slot ? x : m; });
      }
      if (left && sameDept(a, left)) pairs++;
      if (facing && sameDept(a, facing)) pairs++;
    }
  }
  return pairs;
}

// ── A1. CAT hall discovery from the category bucket (course-title subject) ────
it("A1: CURRENT-DEFECT — a CAT exam with a course-title subject discovers its CAT hall pool", () => {
  const catHall = hall("h_cat1", "CAT Hall 1", "CAT", 5, [3, 3, 3], 45);
  const exam = {
    id: "e1", subject: "Foundations of Robotics", category: "CAT", examCategory: "CAT",
    date: FN, session: "FN", status: "scheduled", hallids: [], groups: [{ dept: "AID S", year: 1 }],
  };
  const sel = api.bulkSelectHalls(exam, [exam], [catHall], {});
  ok(sel.halls.some(function (x) { return x.id === "h_cat1"; }),
    "CAT exam pool must include the free CAT hall; got empty pool of size " + sel.halls.length +
    " (subject is a course title, not a hall type)");
});

it("A1b: LOCK — exam.hallType and subject-as-known-type still win", () => {
  const catHall = hall("h_cat1", "CAT Hall 1", "CAT", 5, [3, 3, 3], 45);
  const uniHall = hall("u1", "U1", "University", 5, [3, 3, 3], 45);
  const eExplicit = { id: "e", subject: "X", hallType: "CAT", date: FN, session: "FN", hallids: [], groups: [] };
  const sel = api.bulkSelectHalls(eExplicit, [eExplicit], [catHall, uniHall], {});
  ok(sel.halls.some(function (x) { return x.id === "h_cat1"; }) && !sel.halls.some(function (x) { return x.id === "u1"; }),
    "explicit hallType CAT must select the CAT hall only");
  const eSubj = { id: "e", subject: "University", date: FN, session: "FN", hallids: [], groups: [] };
  const sel2 = api.bulkSelectHalls(eSubj, [eSubj], [catHall, uniHall], {});
  ok(!sel2.halls.some(function (x) { return x.id === "h_cat1"; }) && sel2.halls.some(function (x) { return x.id === "u1"; }),
    "subject 'University' behaves as the University pool");
});

// ── A2. the reported CAT exam actually seats its 17 students ─────────────────
it("A2: CURRENT-DEFECT — 17 eligible students on a 45-cap CAT hall generate a full plan", () => {
  const catHall = hall("lh1", "LH-1", "CAT", 5, [3, 3, 3], 45);
  const roster = students(16, "AID S", 1).concat(students(1, "MECH", 1));
  const exam = {
    id: "robotics", subject: "Foundations of Robotics", subjectTitle: "Foundations of Robotics",
    category: "CAT", examCategory: "CAT", date: FN, session: "FN", status: "scheduled",
    hallids: [], groups: [{ dept: "AID S", year: 1 }, { dept: "MECH", year: 1 }],
    registerNumbers: roster.map(function (x) { return x.regno; }),
  };
  const lookups = api.bulkBuildLookups(roster, [exam], [catHall]);
  const res = api.bulkGenerateOne(exam, roster, [catHall],
    { splitGender: false, noSameDept: true, noSameYear: false, benchAdjacency: false },
    [exam], {}, lookups);
  ok(res.ok, "generation must succeed for 17 students on a 45-seat CAT hall — got: " + res.reason);
  const seats = Object.values(res.plan || {}).reduce(function (a, hp) { return a + ((hp.seats || []).length); }, 0);
  eq(seats, 17);
});

// ── A3. hall identity is canonical — ids, names and aliases all resolve ───────
it("A3: CURRENT-DEFECT — a hall referenced by NAME still reports its full capacity", () => {
  const catHall = hall("h_cat1", "CAT Hall 1", "CAT", 5, [3, 3, 3], 45);
  const exam = { id: "e", subject: "S", date: FN, session: "FN", hallids: ["CAT Hall 1"], groups: [] };
  eq(api.bulkExamHallCapacity(exam, [catHall]), 45,
    "exam.hallids holding the hall NAME must resolve to the hall record (alias-safe)");
});

// ── A4. a plan-load failure is a first-class, NON-silent outcome ──────────────
ait("A4: CURRENT-DEFECT — a plan load error for a same-session exam never silently frees the hall", async () => {
  const cat1 = hall("h_cat1", "CAT Hall 1", "CAT", 5, [3, 3, 3], 45);
  const cat2 = hall("h_cat2", "CAT Hall 2", "CAT", 5, [3, 3, 3], 45);
  const e1 = {
    id: "e1", subject: "S1", date: FN, session: "FN", status: "scheduled",
    hallids: ["h_cat1"], groups: [{ dept: "MECH", year: 1 }],
    registerNumbers: students(40, "MECH", 1).map(function (x) { return x.regno; }),
  };
  const e2 = {
    id: "e2", subject: "S2", date: FN, session: "FN", status: "scheduled",
    hallids: ["h_cat1", "h_cat2"], groups: [{ dept: "CSE", year: 1 }],
    registerNumbers: students(40, "CSE", 1).map(function (x) { return x.regno; }),
  };
  const allStudents = students(40, "MECH", 1).concat(students(40, "CSE", 1));
  const allExams = [e1, e2];
  const saved = [];
  const res = await api.runBulkSeating({
    exams: allExams, allExams: allExams, students: allStudents, halls: [cat1, cat2],
    rules: RULES_OFF,
    loadPlan: async function (id) { if (id === "e1") throw new Error("PERMISSION_DENIED"); return null; },
    savePlan: async function (id) { saved.push(id); },
  });
  const r1 = res.results.find(function (r) { return r.examId === "e1"; });
  const r2 = res.results.find(function (r) { return r.examId === "e2"; });
  ok(r1.status === "failed" && r1.category === "DATA_LOAD_FAILED",
    "e1 must surface as a DATA_LOAD_FAILED failure — got status " + r1.status + " category " + r1.category);
  ok(saved.indexOf("e1") < 0, "a plan whose seats could not be read must never be silently regenerated/saved");
  const plan2 = (r2 && r2.plan) || {};
  ok(!Object.prototype.hasOwnProperty.call(plan2, "h_cat1"),
    "e2 must not draft a plan into h_cat1 (its occupancy is unknown after e1's load failure)");
});

// ── B1. mandated fixture: 16 AID S + 1 MECH on LH-1, noSameDept ON ────────────
it("B1: 16 AID S + 1 MECH on LH-1 (45=45), noSameDept ON, benchAdjacency OFF — zero side-by-side pairs, validator clean", () => {
  const lh1 = hall("lh1", "LH-1", "CAT", 5, [3, 3, 3], 45);
  const roster = students(16, "AID S", 1).concat(students(1, "MECH", 1));
  const exam = {
    id: "robotics", subject: "Foundations of Robotics", category: "CAT", examCategory: "CAT",
    date: FN, session: "FN", status: "scheduled", hallids: ["lh1"],
    groups: [{ dept: "AID S", year: 1 }, { dept: "MECH", year: 1 }],
    registerNumbers: roster.map(function (x) { return x.regno; }),
  };
  const lookups = api.bulkBuildLookups(roster, [exam], [lh1]);
  const rules = { splitGender: false, noSameDept: true, noSameYear: false, benchAdjacency: false };
  const res = api.bulkGenerateOne(exam, roster, [lh1], rules, [exam], {}, lookups);
  ok(res.ok, "mandated fixture must generate — got: " + res.reason);
  const seats = Object.values(res.plan || {}).reduce(function (a, hp) { return a + ((hp.seats || []).length); }, 0);
  eq(seats, 17);
  eq(api.validatePlan(res.plan, rules), [], "generated plan must pass validation");
  eq(api.planIntegrityProblems(res.plan), [], "generated plan must pass integrity");
  eq(adjacentPairs(res.plan), 0, "no same-department side-by-side pair may exist");
});

it("B1b: the validator refuses the same fixture once a same-dept pair is planted", () => {
  const lh1 = hall("lh1", "LH-1", "CAT", 5, [3, 3, 3], 45);
  const roster = students(16, "AID S", 1).concat(students(1, "MECH", 1));
  const exam = {
    id: "robotics", subject: "Foundations of Robotics", category: "CAT", date: FN, session: "FN",
    status: "scheduled", hallids: ["lh1"],
    groups: [{ dept: "AID S", year: 1 }, { dept: "MECH", year: 1 }],
    registerNumbers: roster.map(function (x) { return x.regno; }),
  };
  const lookups = api.bulkBuildLookups(roster, [exam], [lh1]);
  const rules = { splitGender: false, noSameDept: true, noSameYear: false, benchAdjacency: false };
  const res = api.bulkGenerateOne(exam, roster, [lh1], rules, [exam], {}, lookups);
  const hp = res.plan.lh1;
  const mec = hp.seats.find(function (x) { return (x.dept || "").toUpperCase() === "MECH"; });
  const aid = hp.seats.find(function (x) { return (x.dept || "").toUpperCase() === "AID S"; });
  eq(adjacentPairs(res.plan), 0, "fixture starts clean");
  const neighbour = hp.seats.find(function (x) {
    return x !== mec && x.rowIdx === mec.rowIdx &&
      ((x.colIdx === mec.colIdx && x.slot === mec.slot - 1) || (x.colIdx === mec.colIdx - 1 && mec.slot === 1));
  });
  if (neighbour) {
    const tampered = JSON.parse(JSON.stringify(res.plan));
    tampered.lh1.seats = tampered.lh1.seats.map(function (x) { return (x === neighbour || x.seatNo === neighbour.seatNo) ? Object.assign({}, x, { dept: mec.dept }) : x; });
    const probs = api.validatePlan(tampered, rules);
    ok(probs.some(function (p) { return /Department adjacency violation/i.test(p); }),
      "a planted same-dept pair must be named by validation: " + probs.join("; "));
  } else {
    ok(true, "no adjacent relational seat existed to tamper (solo MECH sits isolated)");
  }
});

// ── B4. an enabled-but-unsatisfiable rule is surfaced, never silent ───────────
it("B4: CURRENT-DEFECT — a single-department exam under noSameDept carries an explicit unsatisfiable flag", () => {
  const hh = hall("lh1", "LH-1", "CAT", 5, [3, 3, 3], 45);
  const roster = students(8, "AID S", 1);
  const exam = {
    id: "single", subject: "DM for AI", category: "CAT", date: FN, session: "FN",
    status: "scheduled", hallids: ["lh1"], groups: [{ dept: "AID S", year: 1 }],
    registerNumbers: roster.map(function (x) { return x.regno; }),
  };
  const lookups = api.bulkBuildLookups(roster, [exam], [hh]);
  const res = api.bulkGenerateOne(exam, roster, [hh],
    { splitGender: false, noSameDept: true, noSameYear: false, benchAdjacency: false },
    [exam], {}, lookups);
  ok(Array.isArray(res.unsatisfiableRules) && res.unsatisfiableRules.indexOf("noSameDept") >= 0,
    "bulkGenerateOne must surface the rule it could not enforce as unsatisfiableRules=['noSameDept']");
});

// ── C1. a failed regeneration NEVER replaces the saved plan, and says so ───────
ait("C1: CURRENT-DEFECT — a failed regeneration keeps + flags the previous plan (keptExisting, no overwrite)", async () => {
  const lh1 = hall("lh1", "LH-1", "University", 54, [1], 45);
  const oldPlan = { lh1: planEntry(lh1, gridSeats(45, 1, 54, 1)) };
  const bigExam = {
    id: "big", subject: "BIG", subjectTitle: "BIG", date: FN, session: "FN", status: "scheduled",
    hallids: ["lh1"], groups: [{ dept: "MECH", year: 1 }],
    registerNumbers: students(61, "MECH", 1).map(function (x) { return x.regno; }),
  };
  const saved = [];
  const res = await api.runBulkSeating({
    exams: [bigExam], allExams: [bigExam], students: students(61, "MECH", 1), halls: [lh1],
    rules: RULES_OFF,
    loadPlan: async function () { return oldPlan; },
    savePlan: async function (id) { saved.push(id); },
    confirmOverwrite: function () { return true; },
  });
  const r = res.results[0];
  eq(saved.length, 0, "a failed regeneration must not save anything");
  ok(r.status === "failed", "regeneration over 45 cap must fail: " + r.reason);
  eq(r.category, "HALL_CAPACITY_EXHAUSTED", "the failure category must be precise (got " + r.category + ")");
  eq(r.keptExisting, true, "the result must disclose that the previous plan was preserved");
  eq(res.plansById.big, oldPlan, "plansById must still hold the untouched previous plan");
});

// ── A5. examHallTypePool — single authoritative hall-type source ──────────────
it("A5: LOCK — examHallTypePool resolves the exact eligible hall type", () => {
  eq(api.examHallTypePool({ subject: "Foundations of Robotics", category: "CAT" }), ["CAT"]);
  eq(api.examHallTypePool({ subject: "Physics" }), ["University"]);
  eq(api.examHallTypePool({ subject: "Embedded Lab", category: "Lab" }), ["Lab"]);
  eq(api.examHallTypePool({ subject: "X", hallType: "CAT" }), ["CAT"]);
});

// ── B2. adjacencyImpossibility — a single-dept roster cannot satisfy the rule ─
it("B2: LOCK — adjacencyImpossibility detects a rule the roster cannot satisfy", () => {
  const imp = api.adjacencyImpossibility(students(17, "AID S", 1), { noSameDept: true });
  eq(imp.noSameDept, true);
  ok((imp.note || "").indexOf("one department") >= 0, "the note explains the impossibility");
  const ok2 = api.adjacencyImpossibility(students(16, "AID S", 1).concat(students(1, "MECH", 1)), { noSameDept: true });
  eq(ok2.noSameDept, false);
  const off = api.adjacencyImpossibility(students(5, "AID S", 1), {});
  eq(off.noSameDept, false, "no rule, no impossibility");
});

// ── B3. manualRuleGate — enabled mandatory-rule violations hard-block save ────
it("B3: LOCK — enabled mandatory-rule violations can NEVER be saved or placed", () => {
  const rules = { splitGender: false, noSameDept: true, noSameYear: false, benchAdjacency: false };
  const viol = ["No Same Department Side-by-Side: 91650006 & 91650007 are seated beside each other (row 1, bench 1)"];
  const g = api.manualRuleGate(viol, rules);
  eq(g.block, true, "a same-department adjacency under an enabled rule blocks manual save");
  ok(g.blocked.length === 1, "the blocking problems are enumerated");
  eq(api.manualRuleGate([], rules).block, false, "a clean plan is not blocked");
  eq(api.manualRuleGate(viol, { splitGender: false, noSameDept: false, noSameYear: false, benchAdjacency: false }).block, false,
    "the same pair with the rule OFF is not blocked by the rule");
});

module.exports = s;