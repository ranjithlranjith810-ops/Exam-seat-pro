// Regression tests for seat-inventory integrity.
//
// These pin the contract the seating engine, the manual-placement modal, the
// attendance allocator and the hall notice all rely on: ONE shared physical
// seat inventory, capacity counted from that inventory, and duplicate students
// / seats detected case- and whitespace-insensitively. A plan that violates any
// of these is refused at save time, so the helpers are asserted directly as
// pure functions over plain objects — no React, Firebase or DOM.
//
// The functions are loaded from index.html BY NAME through the same harness the
// other engine tests use, so a change in index.html is exercised immediately.
const h = require("./harness.js");
const api = h.load();

const s = h.suite("seating_integrity.test.js — seat inventory, capacity and duplicate integrity");
const { it, eq, ok } = s;

const RULES_OFF = { splitGender: false, noSameDept: false, noSameYear: false, benchAdjacency: false };

function students(n, dept, year, gender) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: dept + year + "_" + i,
      regno: "9" + String(year) + String(i).padStart(4, "0"),
      name: dept + " " + i, dept: dept, year: year, gender: gender || "male",
    });
  }
  return out;
}

// A hall whose physical layout is the given per-bench column widths.
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

// A plan hall entry built only from the quantities planIntegrityProblems reads.
function planHall(hallName, rows, columns, seats) {
  return {
    hallName: hallName, numbenches: rows,
    studentsperbench: columns.reduce(function (a, c) { return a + (c.seats || 1); }, 0),
    layoutConfig: { columns: columns }, seats: seats,
  };
}

// ── normRegno ────────────────────────────────────────────────────────────────
it("normRegno trims and upper-cases so cosmetic differences cannot duplicate a student", () => {
  eq(api.normRegno("  abc123 "), "ABC123");
  eq(api.normRegno("abc123"), api.normRegno(" ABC123 "));
  eq(api.normRegno(""), "");
  eq(api.normRegno(null), "");
  eq(api.normRegno(undefined), "");
  eq(api.normRegno(953022104001), "953022104001");
});

// ── hallSeatInventory ────────────────────────────────────────────────────────
it("hallSeatInventory falls back to numbenches x a single-seat column per studentsperbench", () => {
  const inv = api.hallSeatInventory({ numbenches: 12, studentsperbench: 3 });
  eq(inv.nRows, 12);
  eq(api.hallSeatSlotsPerRow(inv), 3);
  eq(inv.columns.length, 3);
});

it("hallSeatInventory defaults to 15 rows x 3 single-seat columns when nothing is configured", () => {
  const inv = api.hallSeatInventory({});
  eq(inv.nRows, 15);
  eq(api.hallSeatSlotsPerRow(inv), 3);
});

it("hallSeatInventory reads layoutConfig columns and clamps seats to 1..6", () => {
  const inv = api.hallSeatInventory({ numbenches: 4, layoutConfig: { columns: [{ seats: 2 }, { seats: 3 }, { seats: 9 }, { seats: 0 }] } });
  eq(inv.nRows, 4);
  eq(inv.columns.map(function (c) { return c.seats; }), [2, 3, 6, 1]);
  eq(api.hallSeatSlotsPerRow(inv), 12);
});

it("hallSeatInventory records in-range 0-based aisle seats as blocked and drops invalid ones", () => {
  const inv = api.hallSeatInventory({ layoutConfig: { columns: [{ seats: 3, aisleSeats: [1, 5, -1, 1] }] } });
  eq(inv.columns[0].blocked, [1]);
});

// ── capacity: ONE inventory for every caller ─────────────────────────────────
it("hallPhysicalCapacity is nRows x every physical slot, so a 6-seat bench counts as 6", () => {
  eq(api.hallPhysicalCapacity(hall("h6", 2, [6])), 12);
  eq(api.hallPhysicalCapacity({ numbenches: 3, studentsperbench: 4 }), 12);
});

it("calcHallCapacity uses the same inventory as the renderer (editor's 6 seats are not truncated to 4)", () => {
  const h6 = hall("h6", 2, [6]);
  eq(api.calcHallCapacity(h6), api.hallPhysicalCapacity(h6));
  eq(api.calcHallCapacity(h6), 12);
});

it("hallSeatSlotsPerRow is the sum of the declared bench widths", () => {
  const inv = api.hallSeatInventory(hall("hx", 1, [2, 1, 2]));
  eq(api.hallSeatSlotsPerRow(inv), 5);
  eq(api.hallSeatSlotsPerRow(null), 0);
});

// ── planIntegrityProblems — structural, never rule-based ─────────────────────
it("planIntegrityProblems reports no problem for a plan that was actually generated", () => {
  const h1 = hall("h1", 2, [2, 2]);  // capacity 8
  const res = api.placeStudentsInHalls(students(4, "CSE", 1), [h1], 0, {}, RULES_OFF);
  eq(res.unplaced.length, 0);
  eq(api.planIntegrityProblems(res.plan), []);
});

it("planIntegrityProblems flags capacity overflow", () => {
  const seats = [];
  for (let i = 0; i < 9; i++) seats.push(seatAt("h1-B" + i + "S1", 0, 0, 1, { regno: "R" + i }));
  const plan = { h1: planHall("H1", 2, [{ seats: 2 }, { seats: 2 }], seats) };  // capacity 8
  ok(api.planIntegrityProblems(plan).some(function (p) { return /Capacity overflow/.test(p); }));
});

it("planIntegrityProblems flags a physical seat claimed twice", () => {
  const plan = { h1: planHall("H1", 2, [{ seats: 2 }], [
    seatAt("h1-B1S1", 0, 0, 1, { regno: "R1" }),
    seatAt("h1-B1S1", 0, 0, 1, { regno: "R2" }),
  ]) };
  ok(api.planIntegrityProblems(plan).some(function (p) { return /Duplicate seat/.test(p); }));
});

it("planIntegrityProblems treats registration numbers as case/space-insensitive", () => {
  const plan = { h1: planHall("H1", 2, [{ seats: 2 }], [
    seatAt("h1-B1S1", 0, 0, 1, { regno: "abc" }),
    seatAt("h1-B2S1", 0, 1, 1, { regno: " ABC " }),
  ]) };
  ok(api.planIntegrityProblems(plan).some(function (p) { return /Duplicate student/.test(p); }));
});

it("planIntegrityProblems flags the same student record assigned twice", () => {
  const plan = { h1: planHall("H1", 2, [{ seats: 2 }], [
    seatAt("h1-B1S1", 0, 0, 1, { id: "s1", regno: "R1" }),
    seatAt("h1-B2S1", 0, 1, 1, { id: "s1", regno: "R2" }),
  ]) };
  ok(api.planIntegrityProblems(plan).some(function (p) { return /Duplicate student record/.test(p); }));
});

it("planIntegrityProblems rejects a seat outside the hall grid or the bench's slots", () => {
  const outOfGrid = { h1: planHall("H1", 2, [{ seats: 2 }], [seatAt("h1-x", 5, 0, 1)]) };
  ok(api.planIntegrityProblems(outOfGrid).some(function (p) { return /outside hall layout/.test(p); }));

  const outOfSlots = { h1: planHall("H1", 1, [{ seats: 2 }], [seatAt("h1-y", 0, 0, 5)]) };
  ok(api.planIntegrityProblems(outOfSlots).some(function (p) { return /beyond the physical slots/.test(p); }));
});

it("planIntegrityProblems rejects an occupied aisle / blocked seat", () => {
  const plan = { h1: planHall("H1", 1, [{ seats: 3, aisleSeats: [1] }], [seatAt("h1-B1S2", 0, 0, 2)]) };
  ok(api.planIntegrityProblems(plan).some(function (p) { return /Blocked\/aisle seat occupied/.test(p); }));
});

it("planIntegrityProblems rejects a labelled seat with no physical coordinates", () => {
  const plan = { h1: planHall("H1", 1, [{ seats: 2 }], [{ regno: "R1", seatLabel: "A1.1" }]) };
  ok(api.planIntegrityProblems(plan).some(function (p) { return /no hall coordinates/.test(p); }));
});

it("planIntegrityProblems ignores empty plan entries and an empty plan", () => {
  eq(api.planIntegrityProblems({}), []);
  eq(api.planIntegrityProblems({ h1: { hallName: "H1", seats: [] } }), []);
  eq(api.planIntegrityProblems(null), []);
});

// ── placement obeys the same inventory ───────────────────────────────────────
it("placeStudentsInHalls seats every slot of a 6-seat bench declared in layoutConfig", () => {
  const h6 = hall("h6", 1, [6]);
  const res = api.placeStudentsInHalls(students(6, "CSE", 1), [h6], 0, {}, RULES_OFF);
  eq(res.unplaced.length, 0);
  eq(Object.values(res.plan).reduce(function (a, hp) { return a + hp.seats.length; }, 0), 6);
});

it("placeStudentsInHalls never seats on a blocked aisle seat and surfaces the overflow", () => {
  const hb = hall("hb", 1, [{ seats: 3, aisleSeats: [1] }]);
  const res = api.placeStudentsInHalls(students(3, "CSE", 1), [hb], 0, {}, RULES_OFF);
  const seats = Object.values(res.plan).flatMap(function (hp) { return hp.seats; });
  eq(seats.length, 2, "only the two usable seats are filled");
  eq(res.unplaced.length, 1, "the third student is surfaced for manual placement");
  ok(seats.every(function (x) { return x.slot !== 2; }), "the aisle seat stays empty");
});

it("a generated hall entry's capacity matches hallPhysicalCapacity and passes integrity", () => {
  const hx = hall("hx", 3, [3, 2]);
  const res = api.placeStudentsInHalls(students(7, "CSE", 1), [hx], 0, {}, RULES_OFF);
  const hp = res.plan[hx.id];
  eq(hp.numbenches, api.hallSeatInventory(hx).nRows);
  eq(hp.studentsperbench, api.hallSeatSlotsPerRow(api.hallSeatInventory(hx)));
  eq(hp.capacity, api.hallPhysicalCapacity(hx));
  eq(api.planIntegrityProblems(res.plan), []);
});

// ── validatePlan — normalised duplicate detection ────────────────────────────
it("validatePlan catches duplicate students after normalising registration numbers", () => {
  const plan = { h1: { hallName: "H1", seats: [
    { regno: "abc", seatNo: "h1-B1S1" },
    { regno: " ABC ", seatNo: "h1-B2S1" },
  ] } };
  ok(api.validatePlan(plan, RULES_OFF).some(function (p) { return /Duplicate student/.test(p); }));
});

it("validatePlan catches the same student record assigned twice", () => {
  const plan = { h1: { hallName: "H1", seats: [
    { id: "s1", regno: "R1", seatNo: "h1-B1S1" },
    { id: "s1", regno: "R2", seatNo: "h1-B2S1" },
  ] } };
  ok(api.validatePlan(plan, RULES_OFF).some(function (p) { return /Duplicate student record/.test(p); }));
});

// ── dedupe at every entry point ──────────────────────────────────────────────
it("generateSmartSeating removes a student who is duplicated by id OR by normalised regno", () => {
  const groups = [{
    label: "g", dept: "MIX", year: 1, rules: RULES_OFF,
    students: [
      { id: "s1", regno: "953022104001", name: "A", dept: "CSE", year: 1, gender: "male" },
      { id: "s2", regno: " 953022104001 ", name: "A dup", dept: "CSE", year: 1, gender: "male" },
      { id: "s1", regno: "953022104002", name: "B dup id", dept: "CSE", year: 1, gender: "male" },
    ],
  }];
  const plan = api.generateSmartSeating(groups, [hall("h1", 5, [3])], {});
  const seated = Object.values(plan).flatMap(function (hp) { return hp.seats || []; });
  eq(seated.length, 1, "only one unique student is seated");
  eq(api.__win.__lastSeatingResult.report.dupesRemoved, 2, "both duplicates are reported");
});

it("bulkExamStudents de-duplicates a student matched twice by normalised regno", () => {
  const exam = { id: "e", groups: [{ dept: "CSE", year: 1 }] };
  const st = [
    { id: "a", regno: "ABC", dept: "CSE", year: 1 },
    { id: "b", regno: " abc ", dept: "CSE", year: 1 },
  ];
  const lookups = api.bulkBuildLookups(st, [exam], []);
  eq(api.bulkExamStudents(exam, st, lookups).length, 1);
});

// ── resolveHall — one canonical id per physical hall name ────────────────────
it("resolveHall collapses same-name records to one id, preferring a record that carries a layout", () => {
  const halls = [{ id: "a", name: "LH-5" }, { id: "b", name: "LH5", layoutConfig: { columns: [{ seats: 3 }] } }];
  const r = api.resolveHall(halls, "a", { hallName: "LH-5" });
  eq(r.id, "b", "the layout-bearing record is the canonical one");
});

it("resolveHall keeps the first record for a name when no sibling has a layout", () => {
  const halls = [{ id: "a", name: "LH-5" }, { id: "b", name: "LH 5" }];
  eq(api.resolveHall(halls, "a", { hallName: "LH-5" }).id, "a");
});

it("resolveHall prefers an exact id, then an exact name, before normalising", () => {
  const halls = [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }];
  eq(api.resolveHall(halls, "b", {}).id, "b");
  eq(api.resolveHall(halls, "nope", { hallName: "Alpha" }).id, "a");
});

// ── findPlanHallSessionConflicts — physical-seat clash guard ─────────────────
it("findPlanHallSessionConflicts finds a seat two plans claim in the same hall/date/session", () => {
  const exams = [
    { id: "e1", subject: "A", date: "2025-12-01", session: "FN" },
    { id: "e2", subject: "B", date: "2025-12-01", session: "FN" },
  ];
  const halls = [{ id: "h1", name: "H1" }];
  const stored = { e1: { h1: { hallName: "H1", seats: [{ regno: "r1", seatNo: "h1-B1S1" }] } } };
  const plan = { h1: { hallName: "H1", seats: [{ regno: "r2", seatNo: "h1-B1S1" }] } };
  ok(api.findPlanHallSessionConflicts("e2", plan, exams, stored, halls).length > 0);
});

it("findPlanHallSessionConflicts ignores disjoint seats and a different session", () => {
  const exams = [
    { id: "e1", subject: "A", date: "2025-12-01", session: "FN" },
    { id: "e2", subject: "B", date: "2025-12-01", session: "FN" },
    { id: "e3", subject: "C", date: "2025-12-01", session: "AN" },
  ];
  const halls = [{ id: "h1", name: "H1" }];
  const stored = { e1: { h1: { hallName: "H1", seats: [{ regno: "r1", seatNo: "h1-B1S1" }] } } };
  const otherSeat = { h1: { hallName: "H1", seats: [{ regno: "r2", seatNo: "h1-B2S1" }] } };
  eq(api.findPlanHallSessionConflicts("e2", otherSeat, exams, stored, halls).length, 0);

  const sameSeatOtherSession = { h1: { hallName: "H1", seats: [{ regno: "r3", seatNo: "h1-B1S1" }] } };
  eq(api.findPlanHallSessionConflicts("e3", sameSeatOtherSession, exams, stored, halls).length, 0);
});

it("findPlanHallSessionConflicts accepts an exam-like object for a not-yet-saved exam", () => {
  const exams = [{ id: "e1", subject: "A", date: "2025-12-01", session: "FN" }];
  const halls = [{ id: "h1", name: "H1" }];
  const stored = { e1: { h1: { hallName: "H1", seats: [{ regno: "r1", seatNo: "h1-B1S1" }] } } };
  const plan = { h1: { hallName: "H1", seats: [{ regno: "r9", seatNo: "h1-B1S1" }] } };
  const ref = { id: "new", date: "2025-12-01", session: "FN" };
  ok(api.findPlanHallSessionConflicts(ref, plan, exams, stored, halls).length > 0);
});

module.exports = s;
