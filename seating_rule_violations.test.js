// Regression tests for the "No Same Department Side-by-Side" physical seating
// fix, plus the rule/enforcement save-guard contract around it.
//
// The bug this pins: in Bulk Seating by Date with ONLY "No Same Department
// Side-by-Side" on (CAT Bench Adjacency NOT toggled), a saved LH-1 plan still
// contained AID S students seated side-by-side (e.g. 2026-10-14 FN). The old
// engine fell back to a legacy whole-previous-bench rule for University exams,
// which NEVER inspected same-bench slots and exempted a same-department column
// spill. The corrected engine uses ONE physical facing-seat model for EVERY
// side-by-side rule (same-bench left slot + bench-boundary facing seat), and
// the authoritative validator uses that same physical model, so the buggy plan
// is refused at save time.
//
// The LH-1 fixture mirrors the report: 16 x "AID S" + 1 MECH, with the MECH
// record sitting between the AID S block in regno order. Practically the
// executor of the old bug would place all 17 but with five same-dept
// side-by-side pairs; the corrected allocator interleaves the MECH and seats
// everyone with zero same-dept neighbours.
const h = require("./harness.js");
const api = h.load();

const s = h.suite("seating_rule_violations.test.js — No Same Department physical adjacency + save guard");
const { it, ait, eq, ok } = s;

const RULES_OFF = { splitGender: false, noSameDept: false, noSameYear: false, benchAdjacency: false };
const DEPT_ONLY = { splitGender: false, noSameDept: true, noSameYear: false, benchAdjacency: false };

// ── fixture / helpers ─────────────────────────────────────────────────────────
// LH-1, 6 rows, three 2-seat benches per row: A1.1..A6.2, B1.1..B6.2, C1.1..C6.2.
function LH1() {
  const columns = [{ seats: 2 }, { seats: 2 }, { seats: 2 }];
  return {
    id: "LH-1", name: "LH-1", hallType: "University", numbenches: 6,
    studentsperbench: 6, capacity: 36, layoutConfig: { columns },
  };
}
const reg = (n) => "9530231040" + String(n).padStart(2, "0");
function stu(n, dept, year, gender) {
  return { id: "st" + n, regno: reg(n), name: "Student " + n, dept, year, gender: gender || "male" };
}
const lh1Roster = () => {
  const out = [];
  for (let i = 1; i <= 3; i++) out.push(stu(i, "AID S", 2));        // rids 01..03
  out.push(stu(4, "MECH", 3));                                        // rid 04 — interleaves the AID S block
  for (let i = 5; i <= 17; i++) out.push(stu(i, "AID S", 2));         // rids 05..17
  return out;
};

function exam(id, date, session, groups, extra) {
  return Object.assign({
    id: id, subject: "University", subjectTitle: id, date: date, session: session,
    groups: groups, status: "scheduled",
  }, extra || {});
}
function students(n, dept, year) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(stu(100 + i, dept, year));
  return out;
}
function hall(id, rows, colSeats, extra) {
  const columns = colSeats.map(function (c) { return (typeof c === "object") ? c : { seats: c }; });
  const perRow = columns.reduce(function (a, c) { return a + (c.seats || 1); }, 0);
  return Object.assign({
    id: id, name: id, hallType: "University",
    numbenches: rows, studentsperbench: perRow, capacity: rows * perRow,
    layoutConfig: { columns: columns },
  }, extra || {});
}

// A saved seat record with physical coordinates.
function seatAt(seatNo, ci, ri, slot, extra) {
  return Object.assign({
    regno: "R" + seatNo, seatNo: seatNo,
    colIdx: ci, rowIdx: ri, slot: slot, seatLabel: seatNo,
  }, extra || {});
}
// A plan hall entry built from the quantities the validators read.
// `manual: true` marks seats placed by the manual-placement flow.
function planHall(hallName, rows, columns, seats, extra) {
  return Object.assign({
    hallName: hallName, numbenches: rows,
    studentsperbench: columns.reduce(function (a, c) { return a + (c.seats || 1); }, 0),
    layoutConfig: { columns: columns }, seats: seats,
  }, extra || {});
}

function flatSeats(plan) {
  return Object.values(plan).flatMap(function (hp) { return (hp.seats || []); });
}
const norm = (v) => String((v == null) ? "GEN" : v).trim().toUpperCase() || "GEN";

// Independent physical-neighbour scan (never calls the engine): for every
// occupied seat, its immediate left slot in the SAME bench and — for a bench's
// leftmost slot — the rightmost filled seat of the previous bench in the same
// row. Rows are never compared. This is the definition the fix demands.
function physicalAdjacentPairs(plan) {
  const pairs = [];
  Object.values(plan).forEach(function (hp) {
    const grid = {};
    (hp.seats || []).forEach(function (x) {
      const key = (x.colIdx ?? 0) + "_" + (x.rowIdx ?? 0);
      if (!grid[key]) grid[key] = [];
      grid[key].push(x);
    });
    (hp.seats || []).forEach(function (x) {
      const ci = x.colIdx ?? 0, ri = x.rowIdx ?? 0, si = x.slot ?? 0;
      let left = null;
      for (const L of grid[ci + "_" + ri] || []) if (L.slot === si - 1) { left = L; break; }
      if (!left && ci > 0 && si === 1) {
        for (const L of grid[(ci - 1) + "_" + ri] || [])
          if (!left || (L.slot || 0) > (left.slot || 0)) left = L;
      }
      if (left) pairs.push([left, x]);
    });
  });
  return pairs;
}
function sameFieldPairs(plan, field) {
  return physicalAdjacentPairs(plan).filter(function (p) { return norm(p[0][field]) === norm(p[1][field]); });
}
function hasMixedFieldPair(plan, field, a, b) {
  return physicalAdjacentPairs(plan).some(function (p) {
    return (norm(p[0][field]) === norm(a) && norm(p[1][field]) === norm(b)) ||
           (norm(p[0][field]) === norm(b) && norm(p[1][field]) === norm(a));
  });
}

// ── S1: the reported LH-1 bug ─────────────────────────────────────────────────
// noSameDept TRUE, benchAdjacency FALSE — the exact toggles from the report.
// All 17 seated, the MECH physically interlaced with AID S, and not ONE same-dept
// side-by-side pair survives.
it("S1: noSameDept alone blocks every same-dept side-by-side pair in LH-1", () => {
  const res = api.placeStudentsInHalls(lh1Roster(), [LH1()], 0, {}, DEPT_ONLY);
  eq(res.unplaced.length, 0, "all 17 placed");
  eq(flatSeats(res.plan).length, 17);
  eq(api.validatePlan(res.plan, DEPT_ONLY).length, 0, "the authoritative validator agrees");
  eq(sameFieldPairs(res.plan, "dept").length, 0, "zero physical same-dept neighbours");
  ok(hasMixedFieldPair(res.plan, "dept", "AID S", "MECH"), "the MECH is interleaved beside the AID S block");
});

// ── S2: rules-off control ─────────────────────────────────────────────────────
// The same roster with no rules may legitimately have same-dept neighbours; the
// fix must not forbid adjacency when the admin has not asked for it.
it("S2: with rules off the same roster keeps its same-dept neighbours", () => {
  const res = api.placeStudentsInHalls(lh1Roster(), [LH1()], 0, {}, RULES_OFF);
  eq(res.unplaced.length, 0);
  eq(api.validatePlan(res.plan, RULES_OFF).length, 0);
  ok(sameFieldPairs(res.plan, "dept").length > 0, "rules off permits same-dept side-by-side");
});

// ── S3: the bulk modal rule reaches the engine and the validator ──────────────
// The Bulk Seating by Date flow with only noSameDept on refuses nothing, and the
// plan it would SAVE has no physical same-dept pairs and validates clean.
ait("S3: bulk flow with noSameDept only produces a clean interleaved plan", async () => {
  const e = exam("E1", "2026-10-14", "FN", [{ dept: "AID S", year: 2 }, { dept: "MECH", year: 3 }]);
  const st = lh1Roster();
  const gen = api.bulkGenerateOne(e, st, [LH1()], DEPT_ONLY, [e], {}, api.bulkBuildLookups(st, [e], [LH1()]));
  eq(gen.ok, true, gen.reason || "17 students should fit LH-1");
  eq(gen.assigned, 17);
  ok(!(gen.ruleWarnings || []).some(function (w) { return /only one department/.test(w); }), "two departments means no rule exception");
  eq(api.validatePlan(gen.plan, DEPT_ONLY).length, 0);
  eq(sameFieldPairs(gen.plan, "dept").length, 0);
});

// ── S4: the validator refuses a planted same-bench violation ─────────────────
// "AIDS" and "AID S" must collapse to one department when normalised, so a plan
// that seats A1.1=ADS and A1.2=AID S side-by-side is refused at save time.
it("S4: validator flags same-bench same-dept adjacency (normalised depts)", () => {
  const plan = { "LH-1": planHall("LH-1", 6, [{ seats: 2 }, { seats: 2 }, { seats: 2 }], [
    seatAt("LH-1-B1S1", 0, 0, 1, { regno: "R1", dept: " CSE ", year: 1, id: "id1" }),
    seatAt("LH-1-B1S2", 0, 0, 2, { regno: "R2", dept: "cse", year: 1, id: "id2" }),
    seatAt("LH-1-B2S2", 1, 0, 2, { regno: "R3", dept: "ECE", year: 2, id: "id3" }),
  ]) };
  const problems = api.validatePlan(plan, DEPT_ONLY);
  ok(problems.some(function (p) { return /Department adjacency violation/.test(p); }), problems.join("; ") || "no problems reported");
  eq(api.validatePlan(plan, RULES_OFF).length, 0, "the same physical plan is fine with rules off");
});

// ── S5: bench-boundary adjacency is flagged, non-facing is not ───────────────
it("S5: validator flags the facing seat across a bench boundary", () => {
  const bad = { "LH-1": planHall("LH-1", 6, [{ seats: 2 }, { seats: 2 }, { seats: 2 }], [
    seatAt("LH-1-B1S2", 0, 0, 2, { regno: "R1", dept: "CSE", year: 1, id: "id1" }),
    seatAt("LH-1-B2S1", 1, 0, 1, { regno: "R2", dept: "CSE", year: 1, id: "id2" }),
    seatAt("LH-1-B3S1", 2, 0, 1, { regno: "R3", dept: "MECH", year: 3, id: "id3" }),
  ]) };
  const badProbs = api.validatePlan(bad, DEPT_ONLY);
  ok(badProbs.some(function (p) { return /Department adjacency violation/.test(p); }), badProbs.join("; ") || "no problems reported");

  const legal = { "LH-1": planHall("LH-1", 6, [{ seats: 2 }, { seats: 2 }, { seats: 2 }], [
    seatAt("LH-1-B1S1", 0, 0, 1, { regno: "R1", dept: "CSE", year: 1, id: "id1" }),
    seatAt("LH-1-B2S2", 1, 0, 2, { regno: "R2", dept: "CSE", year: 1, id: "id2" }),
    seatAt("LH-1-B3S1", 2, 0, 1, { regno: "R3", dept: "MECH", year: 3, id: "id3" }),
  ]) };
  eq(api.validatePlan(legal, DEPT_ONLY).length, 0, "B2S2 is not facing B1S1, and C1S1 faces only MECH");
});

// ── S6: manual placement is not an escape hatch ───────────────────────────────
// A hall-admin manually dropping a same-dept student beside another in the same
// bench produces a plan the save guard refuses.
it("S6: a manually-placed side-by-side violation is refused at validation", () => {
  const plan = { "LH-1": planHall("LH-1", 6, [{ seats: 2 }, { seats: 2 }, { seats: 2 }], [
    seatAt("LH-1-B1S1", 0, 0, 1, { regno: "R1", dept: "CSE", year: 1, id: "id1" }),
    seatAt("LH-1-B1S2", 0, 0, 2, { regno: "R2", dept: "CSE", year: 1, id: "id2", manual: true }),
    seatAt("LH-1-B2S1", 1, 0, 1, { regno: "R3", dept: "ECE", year: 2, id: "id3", manual: true }),
  ], { manual: true }) };
  ok(api.validatePlan(plan, DEPT_ONLY).some(function (p) { return /Department adjacency violation/.test(p); }), "manual flag does not override the physical rule");
  eq(api.planIntegrityProblems(plan).length, 0, "the plan itself is structurally sound — only the rule blocks it");
});

// ── S7: duplicates after normalisation and shared seats ───────────────────────
it("S7: validator refuses duplicate regnos, records and seats", () => {
  const plan = { h1: planHall("H1", 2, [{ seats: 2 }, { seats: 2 }], [
    seatAt("H1-B1S1", 0, 0, 1, { regno: " 953023104001 ", id: "dup" }),
    seatAt("H1-B2S2", 1, 0, 2, { regno: "953023104001", id: "other" }),
    seatAt("H1-B2S1", 1, 0, 1, { regno: "R2", id: "dup" }),
    seatAt("H1-B1S2", 0, 0, 2, { regno: "R3", id: "c", seatNo: "H1-B1S2" }),
    seatAt("H1-B1S2", 0, 1, 2, { regno: "R4", id: "d", seatNo: "H1-B1S2" }),
  ]) };
  const p = api.validatePlan(plan, RULES_OFF);
  ok(p.some(function (x) { return /Duplicate student 953023104001/.test(x); }), p.join("; "));
  ok(p.some(function (x) { return /Duplicate student record dup/.test(x); }), p.join("; "));
  ok(p.some(function (x) { return /Duplicate seat H1-B1S2/.test(x); }), p.join("; "));
});

// ── S8: true capacity overflow is structural and always refused ──────────────
it("S8: capacity overflow blocks the plan", () => {
  const seats = [];
  for (let i = 0; i < 9; i++) seats.push(seatAt("H1-B" + i + "S1", 0, 0, 1, { regno: "R" + i, dept: "CSE", year: 1 }));
  const plan = { h1: planHall("H1", 2, [{ seats: 2 }, { seats: 2 }], seats) };
  ok(api.planIntegrityProblems(plan).some(function (x) { return /Capacity overflow/.test(x); }));
});

// ── S9: aisle / beyond-slot seats are structural problems ────────────────────
it("S9: occupied aisle seats and out-of-slot seats are refused structurally", () => {
  const plan = { h1: planHall("H1", 2, [{ seats: 2, aisleSeats: [1] }, { seats: 2 }], [
    seatAt("H1-B1S1", 0, 0, 1, { regno: "R1", dept: "CSE", year: 1 }),
    seatAt("H1-B1S2", 0, 0, 2, { regno: "R2", dept: "ECE", year: 1 }),
    seatAt("H1-B1S3", 0, 1, 3, { regno: "R3", dept: "MECH", year: 1 }),
  ]) };
  const p = api.planIntegrityProblems(plan);
  ok(p.some(function (x) { return /Blocked\/aisle seat occupied/.test(x); }), p.join("; "));
  ok(p.some(function (x) { return /beyond the physical slots/.test(x); }), p.join("; "));
});

// ── S10: same hall + same session is a conflict, never silent sharing ────────
ait("S10: a second same-session exam cannot take a hall already claimed today", async () => {
  const a = exam("A", "2026-10-14", "FN", [{ dept: "AID S", year: 2 }]);
  const b = exam("B", "2026-10-14", "FN", [{ dept: "MECH", year: 3 }]);
  const st = students(4, "AID S", 2).concat(students(4, "MECH", 3));
  const saved = {};
  const res = await api.runBulkSeating({
    exams: [a, b], allExams: [a, b], students: st, halls: [LH1()],
    rules: RULES_OFF, savePlan: async function (id, plan) { saved[id] = plan; },
  });
  const byId = {};
  res.results.forEach(function (r) { byId[r.examId] = r; });
  eq(byId.A.status, "completed", "first exam takes the hall");
  eq(byId.B.status, "failed", "second same-session exam conflicts");
  eq(byId.B.code, "hall_conflict");
  ok(saved.A, "only A was saved");
  ok(!saved.B, "B was never saved");
});

// ── S11: FN and AN on the same date are separate plans ───────────────────────
ait("S11: FN and AN plans for the same date stay separate", async () => {
  const exams = [
    exam("FN1", "2026-10-14", "FN", [{ dept: "AID S", year: 2 }]),
    exam("AN1", "2026-10-14", "AN", [{ dept: "AID S", year: 2 }]),
  ];
  const st = lh1Roster();
  const saved = {};
  const res = await api.runBulkSeating({
    exams: exams, allExams: exams, students: st, halls: [LH1()],
    rules: DEPT_ONLY, savePlan: async function (id, plan) { saved[id] = plan; },
  });
  eq(res.summary.completed, 2);
  ok(saved.FN1 && saved.AN1, "each session has its own plan");
  ok(saved.FN1 !== saved.AN1, "distinct plan objects");
});

// ── S12: insufficient capacity fails loudly, never a partial save ────────────
ait("S12: overflow fails the exam and reports unplaced, without saving", async () => {
  const e = exam("A", "2026-10-14", "FN", [{ dept: "CSE", year: 1 }]);
  const st = students(5, "CSE", 1);
  let saved = 0;
  const res = await api.runBulkSeating({
    exams: [e], allExams: [e], students: st, halls: [hall("h1", 1, [1, 1])], // capacity 2
    rules: RULES_OFF, savePlan: async function () { saved++; },
  });
  eq(res.results[0].status, "failed");
  eq(res.results[0].code, "unplaced");
  eq(saved, 0, "nothing persisted");
  eq((res.results[0].unplaced || []).length, 3, "3 of 5 unplaced");
  eq(Object.values(res.results[0].plan || {}).reduce(function (a, hp) { return a + ((hp.seats || []).length); }, 0), 2);
});

// ── S13: retry upserts, never duplicates ─────────────────────────────────────
ait("S13: a retry after a failed save upserts the same exam id once", async () => {
  const e = exam("A", "2026-10-14", "FN", [{ dept: "CSE", year: 1 }]);
  const st = students(4, "CSE", 1);
  const calls = [];
  let failFirst = true;
  const savePlan = async function (id, plan) { calls.push(id); if (failFirst) { failFirst = false; throw new Error("network"); } };
  const first = await api.runBulkSeating({ exams: [e], allExams: [e], students: st, halls: [hall("h1", 2, [2, 2])], rules: RULES_OFF, savePlan: savePlan, confirmOverwrite: function () { return true; } });
  eq(first.results[0].status, "save_failed");
  const second = await api.runBulkSeating({ exams: [e], allExams: [e], students: st, halls: [hall("h1", 2, [2, 2])], rules: RULES_OFF, savePlan: savePlan, plansById: first.plansById, confirmOverwrite: function () { return true; } });
  eq(second.results[0].status, "completed");
  eq(calls, ["A", "A"], "the retry upserts the same exam id, never a second plan");
  eq(Object.keys(second.plansById).length, 1);
});

// ── S14: seating view and hall notice agree on the fixed fixture ─────────────
it("S14: the LH-1 notice lists exactly the 17 seated students, once each", () => {
  const e = exam("E1", "2026-10-14", "FN", [{ dept: "AID S", year: 2 }, { dept: "MECH", year: 3 }]);
  const groups = [{ label: "University", dept: "MIX", year: 1, students: lh1Roster(), rules: DEPT_ONLY }];
  const plan = api.generateSmartSeating(groups, [LH1()], {});
  const unh = api.hallNoticePerHall([e], { E1: plan }, [LH1()]);
  const rows = (unh.perHall["LH-1"] || {}).seats || [];
  eq(rows.length, 17, "notice carries all 17 students");
  eq(new Set(rows.map(function (r) { return api.normRegno(r.regno); })).size, 17, "no student appears twice");
  const roster = new Set(lh1Roster().map(function (x) { return api.normRegno(x.regno); }));
  ok(rows.every(function (r) { return roster.has(api.normRegno(r.regno)); }), "every notice row is a seated student");
});

// ── G1-G6: sideBySideRulesActive boundary (never overblocks) ────────────────
it("G1: single department disables noSameDept and CAT adjacency", () => {
  eq(api.sideBySideRulesActive(students(4, "CSE", 1), { noSameDept: true, benchAdjacency: false }), false);
  eq(api.sideBySideRulesActive(students(4, "CSE", 1), { noSameDept: true, benchAdjacency: true }), false);
});

it("G2: two departments enable noSameDept", () => {
  eq(api.sideBySideRulesActive(students(2, "CSE", 1).concat(students(2, "ECE", 1)), DEPT_ONLY), true);
});

it("G3: same spelling never splits; only genuinely different stored values activate", () => {
  eq(api.sideBySideRulesActive([{ dept: " cse ", year: 1 }, { dept: "CSE", year: 1 }], { noSameDept: true }), false, "trim/case collapse: one department");
  eq(api.sideBySideRulesActive([{ dept: "AID S", year: 2 }, { dept: "AID S", year: 2 }], { noSameDept: true }), false, "the app's own spelling is one department");
  eq(api.sideBySideRulesActive([{ dept: "AID S", year: 2 }, { dept: "AIDS", year: 2 }], { noSameDept: true }), true, "internal spacing is significant: two stored values");
});

it("G4: year rule activates only with two years present", () => {
  eq(api.sideBySideRulesActive(students(4, "CSE", 1), { noSameYear: true }), false);
  eq(api.sideBySideRulesActive(students(3, "CSE", 1).concat(students(3, "CSE", 2)), { noSameYear: true }), true);
  eq(api.sideBySideRulesActive(students(3, "CSE", 1).concat(students(3, "CSE", 2)), { noSameYear: true }), true);
  eq(api.sideBySideRulesActive(students(4, "CSE", 1), { noSameYear: true, noSameDept: true }), false, "dept rule unsatisfiable alone does not carry a year rule");
});

it("G5: no rules or empty pools never activate", () => {
  eq(api.sideBySideRulesActive(students(4, "CSE", 1), RULES_OFF), false);
  eq(api.sideBySideRulesActive([], DEPT_ONLY), false);
  eq(api.sideBySideRulesActive(students(4, "CSE", 1), null), false);
});

it("G6: CAT adjacency with two departments activates", () => {
  eq(api.sideBySideRulesActive(students(2, "CSE", 1).concat(students(2, "ECE", 1)), { splitGender: false, noSameDept: false, noSameYear: false, benchAdjacency: true }), true);
});

module.exports = s;