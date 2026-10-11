// Proves the CAT bench-adjacency rule seats exactly the layout a CAT hall uses,
// and that it never mass-unplaces students.
//
// The CAT hall is a bench layout: A1.1, A1.2, A1.3 | B1.1, B1.2, B1.3 | C1.1, ...
// Only IMMEDIATELY facing seats count as side-by-side, and the target arrangement
// is a checkerboard across those nine seats:
//
//   one department   -> A1.1, A1.3, B1.2, C1.1, C1.3
//   another departme nt -> A1.2, B1.1, B1.3, C1.2
//
// Two failure modes are pinned here, both of which the previous
// whole-previous-bench comparison got wrong in opposite directions:
//
//   false positive — A1.1 = CSE seated beside B1.2 = CSE is NOT an adjacency, but
//                   the old rule compared against every seat in bench A1 and
//                   rejected it, which made this checkerboard unreachable.
//   false negative — A1.1 and A1.2 ARE neighbours, and the old rule never looked
//                   at same-bench slots at all.
//
// Rows are never compared: A1.1 is unconstrained by A2.1.
//
// The engine is loaded from index.html BY NAME through the same harness the CAT
// parser tests use, so these assertions cannot pass against a stale copy.
//
// Covered here: T1-T6 placement, T7 rule activation, T8/T10 validation,
// T9 non-regression, T11 year adjacency, T12-T14 gender and hall allocation.

const h = require("./harness.js");
const api = h.load();

const s = h.suite("cat_bench_adjacency.test.js — CAT facing-seat department adjacency");
const { it, eq, ok } = s;

const place = api.placeStudentsInHalls;
const validate = api.validatePlan;
const validateGender = api.validateGenderSeparation;

// A hall is rows x columns, where each column is a bench holding `seats`
// side-by-side slots. This mirrors how the app derives a hall's seats, so the
// labels asserted here are the real A1.1 / B1.2 labels the notice prints.
function hall(id, name, rows, colSeats) {
  const columns = colSeats.map((n) => ({ seats: n }));
  const perRow = columns.reduce((a, c) => a + c.seats, 0);
  return {
    id, name,
    numbenches: rows,
    studentsperbench: perRow,
    capacity: rows * perRow,
    layoutConfig: { columns },
  };
}

// Register numbers sort as strings, so a fixed-width prefix keeps regno order
// identical to the order the students are supplied in.
const reg = (n) => "9530221040" + String(n).padStart(2, "0");
function stu(n, dept, year, gender) {
  return { id: "st" + n, regno: reg(n), name: "Student " + n, dept, year, gender };
}

function seatsOf(res) {
  return Object.values(res.plan).flatMap((h) => h.seats || []);
}
function seatOf(seats, label) {
  return seats.find((x) => x.seatLabel === label);
}
// deptAt returns the department at a seat label, or "" when the seat is empty.
// An empty seat is itself part of what these tests assert: a rejected seat stays
// empty rather than the student being dropped or reordered.
function deptAt(seats, label) {
  const s = seatOf(seats, label);
  return s ? s.dept : "";
}

const CAT_RULES = { splitGender: false, noSameDept: true, noSameYear: false, benchAdjacency: true };

// ── T1: the target checkerboard is produced exactly ─────────────────────────
//
// Five students of one department and four of another, in strict regno order,
// fill a 3x3 hall as the alternating pattern the CAT bench layout requires.
it("T1: 3x3 checkerboard fills A1.1/A1.3/B1.2/C1.1/C1.3 with one dept", () => {
  const depts = ["CSE", "ECE", "CSE", "ECE", "CSE", "ECE", "CSE", "ECE", "CSE"];
  const students = depts.map((d, i) => stu(i + 1, d, 2, "male"));
  const res = place(students, [hall("h1", "Hall A", 1, [3, 3, 3])], 0, {}, CAT_RULES);
  const seats = seatsOf(res);
  eq(res.unplaced.length, 0, "everyone placed");
  eq(seats.length, 9, "all 9 seats filled");
  eq(deptAt(seats, "A1.1"), "CSE", "A1.1");
  eq(deptAt(seats, "A1.2"), "ECE", "A1.2");
  eq(deptAt(seats, "A1.3"), "CSE", "A1.3");
  eq(deptAt(seats, "B1.1"), "ECE", "B1.1");
  eq(deptAt(seats, "B1.2"), "CSE", "B1.2");
  eq(deptAt(seats, "B1.3"), "ECE", "B1.3");
  eq(deptAt(seats, "C1.1"), "CSE", "C1.1");
  eq(deptAt(seats, "C1.2"), "ECE", "C1.2");
  eq(deptAt(seats, "C1.3"), "CSE", "C1.3");
  eq(validate(res.plan, CAT_RULES).length, 0, "no adjacency violations");
});

// ── T2: same-bench neighbours ARE checked (the old false negative) ───────────
//
<<<<<<< HEAD
// A1.2 sits immediately beside A1.1, so a second CSE must not take it. The
// allocator's back-fill then fills A1.2 with the ECE (a legal student) and the
// second CSE moves on to A1.3 — the same physical guarantee as before, minus the
// wasted empty seat. The seat never holds a second CSE, which is the point.
=======
// A1.2 sits immediately beside A1.1, so a second CSE must not take it. The seat
// is left EMPTY and the student moves on to A1.3 — which is the whole point:
// rejecting a seat is not the same as dropping a student.
>>>>>>> origin/main
//
// Two departments are present on purpose. With only one department the rule
// switches itself off as unsatisfiable (see T6), and this test would prove
// nothing.
<<<<<<< HEAD
it("T2: same-bench slot si-1 is compared, so a 2nd CSE cannot take A1.2", () => {
=======
it("T2: same-bench slot si-1 is compared, so A1.2 is skipped for a 2nd CSE", () => {
>>>>>>> origin/main
  const students = [
    stu(1, "CSE", 2, "male"), stu(2, "CSE", 2, "male"), stu(3, "ECE", 2, "male"),
  ];
  const res = place(students, [hall("h1", "Hall A", 1, [3, 3])], 0, {}, CAT_RULES);
  const seats = seatsOf(res);
  eq(res.unplaced.length, 0, "no student was unplaced");
  eq(deptAt(seats, "A1.1"), "CSE", "A1.1 takes the first CSE");
<<<<<<< HEAD
  eq(deptAt(seats, "A1.2"), "ECE", "A1.2 refuses a 2nd CSE (beside A1.1) and is back-filled with the ECE");
  eq(deptAt(seats, "A1.3"), "CSE", "A1.3 takes the second CSE, now standing beside the ECE");
  eq(deptAt(seats, "B1.1"), "", "B1.1 stays empty — facing the CSE at A1.3, no remaining student fits");
  eq(validate(res.plan, CAT_RULES).length, 0, "no adjacency violations");
=======
  eq(deptAt(seats, "A1.2"), "", "A1.2 is empty — it is beside A1.1");
  eq(deptAt(seats, "A1.3"), "CSE", "A1.3 takes the second CSE");
  eq(deptAt(seats, "B1.1"), "ECE", "B1.1 takes the ECE, which faces A1.3 (CSE)");
>>>>>>> origin/main
});

// ── T3: non-facing same-dept seats are LEGAL (the old false positive) ─────────
//
<<<<<<< HEAD
// The second CSE here lands at A1.3: slot 1 and slot 3 of the same bench are NOT
// adjacent (A1.2 sits between them), so CSE/A1.1 and CSE/A1.3 are a legal
// same-dept pair, and the planner places them back-to-back without a gap. The
// previous rule compared a seat against ALL of the previous bench, so A1.1's
// department made every later-seen seat look conflicting and the second CSE was
// stranded. Benches are never compared, so the bench-separated CSE legal pair in
// this plan validates clean (as does the two-benches-apart pair in T8).
it("T3: a same-dept seat with another seat between is not treated as adjacent", () => {
=======
// B1.3 = CSE here shares a department with A1.1 = CSE, but the two seats are two
// benches and one slot apart, so nothing about them is adjacent. The previous
// rule compared a seat against ALL of the previous bench, so A1.1's department
// made B1.3 look conflicting, the seat was skipped and the student was stranded.
it("T3: a same-dept seat two benches away is not treated as adjacent", () => {
>>>>>>> origin/main
  const students = [
    stu(1, "CSE", 2, "male"), stu(2, "ECE", 2, "male"),
    stu(3, "ECE", 2, "male"), stu(4, "CSE", 2, "male"),
  ];
  const res = place(students, [hall("h1", "Hall A", 1, [3, 3])], 0, {}, CAT_RULES);
  const seats = seatsOf(res);
  eq(res.unplaced.length, 0, "no student was unplaced");
  eq(deptAt(seats, "A1.1"), "CSE", "A1.1 CSE");
<<<<<<< HEAD
  eq(deptAt(seats, "A1.2"), "ECE", "A1.2 ECE sits beside A1.1");
  eq(deptAt(seats, "A1.3"), "CSE", "A1.3 CSE — same dept as A1.1, but not adjacent to it");
  eq(deptAt(seats, "B1.1"), "ECE", "B1.1 ECE faces A1.3 CSE");
  eq(validate(res.plan, CAT_RULES).length, 0, "a bench-separated same-dept pair is not a violation");
=======
  eq(deptAt(seats, "B1.3"), "CSE", "B1.3 CSE — same dept as A1.1, but not adjacent to it");
  eq(deptAt(seats, "B1.2"), "ECE", "B1.2 ECE sits beside B1.3");
  eq(validate(res.plan, CAT_RULES).length, 0, "no adjacency violations");
>>>>>>> origin/main
});

// ── T4: front-to-back is never compared ─────────────────────────────────────
//
// Two CSE students directly one behind the other (A1.1 and A2.1) must both be
// placed. Only slots and benches matter.
// A second department is included so benchAdjacency is genuinely ACTIVE for this
// test — with a single department it would switch itself off (T6) and prove
// nothing about row comparison.
it("T4: rows are never compared (A1.1 and A2.1 both CSE is fine)", () => {
  const students = [
    stu(1, "CSE", 2, "male"), stu(2, "CSE", 2, "male"), stu(3, "ECE", 2, "male"),
  ];
  const res = place(students, [hall("h1", "Hall A", 3, [1])], 0, {}, CAT_RULES);
  const seats = seatsOf(res);
  eq(res.unplaced.length, 0, "no student was unplaced");
  eq(deptAt(seats, "A1.1"), "CSE", "A1.1");
  eq(deptAt(seats, "A2.1"), "CSE", "A2.1 directly behind A1.1");
  eq(deptAt(seats, "A3.1"), "ECE", "A3.1");
  eq(validate(res.plan, CAT_RULES).length, 0, "front-to-back same-dept is not a violation");
});

// ── T5: facing seats across benches ARE checked ─────────────────────────────
//
// A 1-wide bench A followed by a 3-wide bench B: B1.1 faces A1.1, while B1.2 and
// B1.3 face nothing.
it("T5: the leftmost slot of a bench faces the previous bench's rightmost seat", () => {
  const students = [
    stu(1, "CSE", 2, "male"), stu(2, "ECE", 2, "male"), stu(3, "ECE", 2, "male"),
  ];
  const res = place(students, [hall("h1", "Hall A", 1, [1, 3])], 0, {}, CAT_RULES);
  const seats = seatsOf(res);
  eq(res.unplaced.length, 0, "everyone placed");
  eq(deptAt(seats, "A1.1"), "CSE", "A1.1 CSE");
  eq(deptAt(seats, "B1.1"), "ECE", "B1.1 ECE — it faces A1.1, which is CSE");
  eq(deptAt(seats, "B1.2"), "", "B1.2 is empty — it is beside B1.1, also ECE");
  eq(deptAt(seats, "B1.3"), "ECE", "B1.3 takes the second ECE");
});

// ── T6: single-department papers are exempt, never mass-unplaced ────────────
//
// A one-subject CAT paper is usually one department. Adjacent same-dept seating
// is then unavoidable, so the rule must switch itself off rather than reject
// every seat and strand the whole cohort.
it("T6: a single-department exam disables the rule instead of unplacing everyone", () => {
  const students = [];
  for (let i = 1; i <= 8; i++) students.push(stu(i, "CSE", 2, "male"));
  const res = place(students, [hall("h1", "Hall A", 4, [3])], 0, {}, CAT_RULES);
  const seats = seatsOf(res);
  eq(res.unplaced.length, 0, "no student was unplaced");
  eq(seats.length, 8, "all 8 seated");
  eq(deptAt(seats, "A1.2"), "CSE", "A1.2 beside A1.1 is allowed on a one-dept paper");
  eq(validate(res.plan, CAT_RULES).length, 0, "no false violation reported");
});

// ── T7: exemption is exactly at the 2-department boundary ───────────────────
it("T7: benchAdjacencyActive is off below 2 departments, on at 2", () => {
  const active = api.benchAdjacencyActive;
  const r = { benchAdjacency: true };
  eq(active([stu(1, "CSE", 2, "male")], r), false, "1 dept → inactive");
  eq(active([stu(1, "CSE", 2, "male"), stu(2, "CSE", 2, "male")], r), false, "1 dept repeated → inactive");
  eq(active([stu(1, "CSE", 2, "male"), stu(2, "ECE", 2, "male")], r), true, "2 depts → active");
  eq(active([stu(1, "CSE", 2, "male")], { benchAdjacency: false }), false, "flag off → inactive");
  // Case and stray whitespace must not be read as two departments.
  eq(active([
    { ...stu(1, "CSE", 2, "male"), dept: "cse" },
    { ...stu(2, "CSE", 2, "male"), dept: " CSE " },
  ], r), false, "same dept in different case → inactive");
  eq(active([
    { ...stu(1, "CSE", 2, "male"), dept: "" },
    { ...stu(2, "CSE", 2, "male"), dept: "GEN" },
  ], r), false, "blank dept counts as GEN, not a second department");
});

// ── T8: validation agrees with placement ───────────────────────────────────
//
// A hand-built plan holding a genuine facing-seat conflict must be reported,
// otherwise a violating plan could reach the database through the pre-persist
// gate. A non-facing same-dept pair must NOT be reported.
it("T8: validatePlan reports a real facing-seat conflict and ignores a non-facing one", () => {
  const mk = (label, dept, ci, rowIdx, slot) => ({
    regno: label, dept, year: 2, seatNo: "h1-" + label, hallId: "h1",
    colIdx: ci, rowIdx, slot, seatLabel: label,
  });
  const build = (seats) => ({
    h1: { hallName: "Hall A", nRows: 1, nCols: 2, capacity: 6, benches: [], seats },
  });
  // A1.3 and B1.1 genuinely face each other. C1.1 is a third department so the
  // two-department precondition for the rule is satisfied.
  const bad = build([
    mk("A1.3", "CSE", 0, 0, 3), mk("B1.1", "CSE", 1, 0, 1), mk("C1.1", "ECE", 2, 0, 1),
  ]);
  ok(validate(bad, CAT_RULES).length > 0, "facing same-dept conflict is reported");
  // A1.1 and B1.2 are both CSE but two benches apart — legal.
  const good = build([
    mk("A1.1", "CSE", 0, 0, 1), mk("B1.2", "CSE", 1, 0, 2), mk("C1.1", "ECE", 2, 0, 1),
  ]);
  eq(validate(good, CAT_RULES).length, 0, "non-facing same-dept is not a violation");
});

<<<<<<< HEAD
// ── T9: there is no legacy model any more — noSameDept alone behaves like ─────
//
// CAT. The bug this pins: with only "No Same Department Side-by-Side" on (CAT
// Bench Adjacency NOT toggled), the old code fell back to the legacy
// whole-previous-bench comparison, which never inspected same-bench slots, so
// A1.1 and A1.2 could both be CSE in a saved University plan. The corrected
// engine uses the SAME physical facing-seat model for every side-by-side rule:
// A1.2 is beside A1.1 and stays empty, and the second CSE moves on to A1.3.
it("T9: noSameDept without benchAdjacency still prevents same-bench adjacency", () => {
  const rules = { splitGender: false, noSameDept: true, noSameYear: false };
  const students = [stu(1, "CSE", 2, "male"), stu(2, "CSE", 2, "male"), stu(3, "ECE", 2, "male")];
  const res = place(students, [hall("h1", "Hall A", 1, [3, 3])], 0, {}, rules);
  const seats = seatsOf(res);
  eq(res.unplaced.length, 0, "no student was unplaced");
  eq(deptAt(seats, "A1.1"), "CSE", "A1.1 CSE");
  eq(deptAt(seats, "A1.2"), "ECE", "A1.2 refuses the 2nd CSE — it is physically beside the CSE at A1.1 — and is back-filled with the ECE");
  eq(deptAt(seats, "A1.3"), "CSE", "the second CSE moves on to A1.3");
  eq(deptAt(seats, "B1.1"), "", "B1.1 is empty — it faces the CSE at A1.3");
  eq(validate(res.plan, rules).length, 0, "the plan validates clean");
=======
// ── T9: legacy behaviour is untouched when the flag is off ──────────────────
//
// University exams keep the old whole-previous-bench comparison, and same-bench
// adjacency stays allowed. This is the guard that the CAT change did not leak
// into other categories.
it("T9: without benchAdjacency the legacy whole-bench rule still applies", () => {
  const rules = { splitGender: false, noSameDept: true, noSameYear: false };
  const students = [stu(1, "CSE", 2, "male"), stu(2, "CSE", 2, "male")];
  const res = place(students, [hall("h1", "Hall A", 1, [3, 3])], 0, {}, rules);
  const seats = seatsOf(res);
  eq(deptAt(seats, "A1.1"), "CSE", "A1.1 CSE");
  eq(deptAt(seats, "A1.2"), "CSE", "A1.2 CSE — same-bench adjacency still allowed");
  eq(seats.filter((x) => x.colIdx === 1).length, 0, "bench B untouched by the legacy rule");
>>>>>>> origin/main
});

// ── T10: ragged bench widths still find the true facing seat ───────────────
//
// A hall may mix bench widths (layoutConfig.columns allows 1-4 seats each). The
// facing seat is the RIGHTMOST of the previous bench, whatever width that is.
it("T10: ragged bench widths — facing seat is the previous bench's rightmost slot", () => {
  const mk = (label, dept, ci, rowIdx, slot) => ({
    regno: label, dept, year: 2, seatNo: "h1-" + label, hallId: "h1",
    colIdx: ci, rowIdx, slot, seatLabel: label,
  });
  // Bench A is 2 wide, so A1.2 is its rightmost slot and faces B1.1.
  const bad = {
    h1: {
      hallName: "Hall A", nRows: 1, nCols: 3, capacity: 7, benches: [],
      seats: [mk("A1.2", "CSE", 0, 0, 2), mk("B1.1", "CSE", 1, 0, 1), mk("C1.1", "ECE", 2, 0, 1)],
    },
  };
  ok(validate(bad, CAT_RULES).length > 0, "A1.2 (rightmost of a 2-wide bench) faces B1.1");
  // Same layout, different department on the facing seat.
  const good = {
    h1: {
      hallName: "Hall A", nRows: 1, nCols: 3, capacity: 7, benches: [],
      seats: [mk("A1.2", "ECE", 0, 0, 2), mk("B1.1", "CSE", 1, 0, 1), mk("C1.1", "ECE", 2, 0, 1)],
    },
  };
  eq(validate(good, CAT_RULES).length, 0, "different dept on the facing seat is fine");
});

// ── T11: no-same-year follows the corrected facing-seat model too ──────────
//
<<<<<<< HEAD
// B1.1 faces A1.1, so a year-2 student cannot take it: the year-2 ECE is refused
// there. B1.2 is beside B1.1, not beside A1.1, so it is free — the year-3 CSE
// back-fills B1.1 (facing a year-2 student, which is fine) and the year-2 ECE
// takes B1.2 (beside a year-3 student, which is fine).
=======
// B1.1 faces A1.1, so a year-2 student cannot take it. B1.2 is beside B1.1, not
// beside A1.1, so it is free.
>>>>>>> origin/main
it("T11: noSameYear is compared on facing seats only under benchAdjacency", () => {
  const rules = { splitGender: false, noSameDept: false, noSameYear: true, benchAdjacency: true };
  const students = [stu(1, "CSE", 2, "male"), stu(2, "ECE", 2, "male"), stu(3, "CSE", 3, "male")];
  const res = place(students, [hall("h1", "Hall A", 1, [1, 3])], 0, {}, rules);
  const seats = seatsOf(res);
  eq(res.unplaced.length, 0, "everyone placed");
<<<<<<< HEAD
  eq(seatOf(seats, "B1.1").year, 3, "B1.1 refused the year-2 student (faces year-2 A1.1) and is back-filled with year 3");
  eq(seatOf(seats, "B1.2").year, 2, "B1.2 takes the year-2 student, beside a year-3 student");
  eq(deptAt(seats, "B1.3"), "", "B1.3 stays empty — the cohort is fully seated");
  eq(validate(res.plan, rules).length, 0, "no year adjacency violations");
=======
  eq(deptAt(seats, "B1.1"), "", "B1.1 is empty — it faces the year-2 A1.1");
  eq(seatOf(seats, "B1.2").year, 2, "B1.2 takes the year-2 student");
  eq(seatOf(seats, "B1.3").year, 3, "B1.3 takes the year-3 student");
>>>>>>> origin/main
});

// ── T12: gender split still separates halls under CAT rules ────────────────
//
// The CAT path always runs splitGender + benchAdjacency together. Females must
// land in a hall no male occupies, and unknown genders must not join the male
// block.
it("T12: male → female → unknown occupy disjoint halls in order", () => {
  const rules = { splitGender: true, noSameDept: true, noSameYear: false, benchAdjacency: true };
  const students = [
    stu(1, "CSE", 2, "male"), stu(2, "CSE", 2, "male"),
    stu(3, "CSE", 2, "female"),
    stu(4, "CSE", 2, ""),        // unrecognised gender
  ];
  const halls = [hall("h1", "Male Hall", 2, [3]), hall("h2", "Female Hall", 2, [3]), hall("h3", "Other Hall", 2, [3])];
  const plan = api.generateSmartSeating([{ label: "CAT", students, rules }], halls, {});
  const hallOf = (regno) => {
    for (const hp of Object.values(plan)) {
      if ((hp.seats || []).some((x) => x.regno === regno)) return hp.hallName;
    }
    return null;
  };
  eq(hallOf(reg(1)), "Male Hall", "male 1");
  eq(hallOf(reg(2)), "Male Hall", "male 2");
  eq(hallOf(reg(3)), "Female Hall", "female starts in the next hall");
  eq(hallOf(reg(4)), "Other Hall", "unknown gender gets its own hall");
  eq(validateGender(plan).length, 0, "no hall mixes male and female");
});

// ── T13: unknown gender is never folded into the male block ────────────────
//
// Regression for the old `males.concat(others)` behaviour, which seated every
// unrecognised gender in a male hall. A blank gender must also not crash.
it("T13: a blank or abbreviated gender is never seated with the males", () => {
  const rules = { splitGender: true, noSameDept: true, noSameYear: false, benchAdjacency: true };
  const students = [
    stu(1, "CSE", 2, "male"),
    stu(2, "CSE", 2, undefined),   // blank gender
    stu(3, "CSE", 2, "Female"),    // mixed case
    stu(4, "CSE", 2, "M"),         // single letter
  ];
  const halls = [hall("h1", "H1", 1, [3]), hall("h2", "H2", 1, [3]), hall("h3", "H3", 1, [3])];
  const plan = api.generateSmartSeating([{ label: "CAT", students, rules }], halls, {});
  const hallOf = (regno) => {
    for (const hp of Object.values(plan)) {
      if ((hp.seats || []).some((x) => x.regno === regno)) return hp.hallName;
    }
    return null;
  };
  eq(hallOf(reg(1)), "H1", "explicit male in H1");
  eq(hallOf(reg(4)), "H1", "single-letter M treated as male");
  eq(hallOf(reg(3)), "H2", "mixed-case Female treated as female");
  eq(hallOf(reg(2)), "H3", "blank gender skipped past the male and female blocks");
});

// ── T14: a batch of CAT exams gets disjoint halls ──────────────────────────
//
// Every CAT exam used to be handed EVERY CAT hall, so 14 exams all claimed the
// same rooms. Halls are taken in natural order and never reused within a batch.
it("T14: catAllocateHalls gives each exam a disjoint slice in natural order", () => {
  const halls = [
    hall("h1", "CAT 1", 5, [3]), hall("h2", "CAT 2", 5, [3]),
    hall("h3", "CAT 3", 5, [3]), hall("h4", "CAT 4", 5, [3]),
  ];
  // Each hall holds 15, so 25 students need two halls and the four-hall pool is
// exhausted exactly — no exam may fall back onto a hall the other already owns.
const slices = api.catAllocateHalls(2, [25, 25], halls, new Set());
  eq(slices[0].halls.map((x) => x.id), ["h1", "h2"], "exam 1 takes the first two halls");
  eq(slices[1].halls.map((x) => x.id), ["h3", "h4"], "exam 2 takes the next two");
  eq(slices[0].halls.length + slices[1].halls.length, 4, "no hall is shared");

  // A hall already taken by another exam on the same date+session is skipped,
  // and the next exam continues from there rather than restarting at h1.
const slices2 = api.catAllocateHalls(2, [5, 5], halls, new Set(["h1"]));
  eq(slices2[0].halls.map((x) => x.id), ["h2"], "a busy hall is skipped");
  eq(slices2[1].halls.map((x) => x.id), ["h3"], "the next exam continues after it");

// Too few halls for the cohort: allocation reports short rather than handing
// the same room to two exams.
const slices3 = api.catAllocateHalls(2, [40, 40], halls, new Set());
  ok(slices3[0].halls.length + slices3[1].halls.length <= 4, "never more halls than exist");

// Gender partitions each start in a fresh hall, so a hall the males only partly
// fill cannot lend its remaining seats to the female block. Sizing by the flat
// roster total under-counts here: 6 + 14 = 20 students look like 2 halls of 15,
// but the females need a hall of their own and 6 males leave 9 seats unusable.
it("T15: catAllocateHalls sizes by gender partition, not by the flat total", () => {
  // 6 males + 20 females = 26 students. Two halls hold 30 seats, so a flat total
  // is satisfied by 2 halls — but the 6 males leave 9 seats stranded in hall 1 and
  // the female block, which must start in a fresh hall, needs 20 of its own.
  const parts = [[6, 20, 0]];
  const byTotal = api.catAllocateHalls(1, [26], halls, new Set());
  const byParts = api.catAllocateHalls(1, [26], halls, new Set(), parts);
  eq(byTotal[0].halls.length, 2, "a flat total of 26 appears to fit in 2 halls of 15");
  eq(byParts[0].halls.length, 3, "but the female block needs halls of its own");
  ok(byParts[0].capacity >= 26, "the partition-aware slice still covers everyone");

  // The "other" block is a partition too, so it must not be squeezed into the
  // female hall.
  const withOther = api.catAllocateHalls(1, [15], halls, new Set(), [[5, 5, 5]]);
  eq(withOther[0].halls.length, 3, "male + female + other each take a hall");

  // An empty partition costs no hall.
  const noOther = api.catAllocateHalls(1, [15], halls, new Set(), [[5, 5, 0]]);
  eq(noOther[0].halls.length, 2, "an empty 'other' block takes no hall");

  // A single partition spanning several halls still works — the partition loop
  // must roll on to the next hall rather than stopping at the first.
  const bigBlock = api.catAllocateHalls(1, [40], halls, new Set(), [[40, 0, 0]]);
  eq(bigBlock[0].halls.length, 3, "40 males span all three halls");
  eq(bigBlock[0].capacity, 45, "capacity is the sum of the halls handed over");
});

// ── T16: the two halves fit together ──────────────────────────────────────
//
// catSplitByGender returns {male, female, other}; catAllocateHalls consumes that
// as a 3-tuple. Wiring them by hand as literal arrays (as T15 does) hides a
// mismatch in the key names — which is exactly how the CAT import died with
// "Cannot read properties of undefined (reading 'length')". This test runs the
// real helper's output straight into the real allocator.
it("T16: catSplitByGender output feeds catAllocateHalls without a mismatch", () => {
  const students = [
    stu(1, "CSE", 2, "male"), stu(2, "CSE", 2, "M"),
    stu(3, "CSE", 2, "female"), stu(4, "CSE", 2, "F"),
    stu(5, "CSE", 2, ""), stu(6, "CSE", 2, "x"),
  ];
  const split = api.catSplitByGender(students);
  eq(split.male.length, 2, "male + M");
  eq(split.female.length, 2, "female + F");
  eq(split.other.length, 2, "blank + unrecognised gender");

  // The exact expression commit() builds.
  const parts = [[split.male.length, split.female.length, split.other.length]];
  const slices = api.catAllocateHalls(1, [students.length], halls, new Set(), parts);
  eq(slices[0].halls.length, 3, "three partitions need three halls");
  eq(slices[0].capacity, 45, "all three halls are usable in total");

  // And the plan the engine builds from that slice seats everyone, one gender
  // per hall. CAT_SEATING_RULES is used rather than CAT_RULES because the latter
  // has splitGender off — the importer always runs with splitting on.
  const plan = api.generateSmartSeating(
    [{ label: "CAT", students, rules: api.CAT_SEATING_RULES }],
    slices[0].halls, {}
  );
  const sr = api.__win.__lastSeatingResult || {};
  eq((sr.unplaced || []).length, 0, "everyone placed");
  eq((sr.report && sr.report.validation || []).length, 0, "no rule violations reported");
  eq(validateGender(plan).length, 0, "no hall mixes genders");
});
});

module.exports = s;