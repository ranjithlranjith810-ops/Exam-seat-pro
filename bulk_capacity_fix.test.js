// Regression tests for the Bulk Seating capacity + truthful-failure fix.
//
// Reported bug: Bulk Seating by Date for 14-10-2026 repeatedly saved 13 exams,
// failed 1, with 16 students unplaced, and the failing exam's reason blamed the
// "No Same Department Side-by-Side" rule even though LH-1's declared capacity
// (45) was the real limit. Two defects caused this:
//
//   1. CAPACITY DISAGREEMENT — hall capacity came only from the LAYOUT
//      (rows × slotsPerRow) everywhere in the seating engine, while LH-1's
//      stored/declared `capacity: 45` was shown in other screens. Allocation,
//      previews, summaries and the notice each read their own number, so the
//      same hall reported different totals and the engine could exceed a
//      declared 45.
//   2. REASON MISATTRIBUTION — whenever noSameDept was ON, the "unplaced"
//      reason blamed the adjacency rule even for a PURE capacity overflow that
//      no rule had ever rejected (in a single-column hall the rule CANNOT reject
//      anything).
//
// The corrected engine uses ONE usable capacity everywhere (declared bounded by
// physical inventory), fills the first eligible hall to exactly that count
// before moving on, and reports the REAL blocker. These tests pin that contract
// with synthetic fixtures; the 13/1/16 batch below is a sanitized equivalent of
// the reported 14-10-2026 failure (no real student identities are involved).
const h = require("./harness.js");
const api = h.load();

const s = h.suite("bulk_capacity_fix.test.js — declared capacity, first-hall-first, truthful reasons");
const { it, ait, eq, ok } = s;

const RULES_OFF = { splitGender: false, noSameDept: false, noSameYear: false, benchAdjacency: false };

// A hall whose PHYSICAL grid is `rows` x (sum of col seats) with an optional
// DECLARED `capacity`. When omitted the declared field is absent (legacy hall).
function hall(id, rows, colSeats, capacity) {
  const columns = colSeats.map(function (c) { return (typeof c === "object") ? c : { seats: c }; });
  const perRow = columns.reduce(function (a, c) { return a + (c.seats || 1); }, 0);
  return Object.assign({
    id: id, name: id, hallType: "University",
    numbenches: rows, studentsperbench: perRow,
    layoutConfig: { columns: columns },
  }, (capacity !== undefined) ? { capacity: capacity } : {});
}

function students(n, dept, year, gender) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: dept + year + "_" + i,
      regno: "9" + String(year) + String(dept.charCodeAt(0)) + String(i).padStart(4, "0"),
      name: dept + " " + i, dept: dept, year: year, gender: gender || "male",
    });
  }
  return out;
}

// A saved seat sliding deterministically through a 3x? grid: every physical slot
// gets a unique seatNo and a valid coordinate, so ONLY capacity is stressed.
function gridSeats(n, nCols, nRows, nSlots) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const ci = i % nCols, sl = Math.min(nSlots, Math.floor(i / (nCols * nRows)) + 1);
    const ri = Math.floor(i / nCols) % nRows;
    out.push({
      regno: "R" + i, seatNo: "g-" + ci + "_" + ri + "_" + sl, seatLabel: "X" + i,
      colIdx: ci, rowIdx: ri, slot: sl,
    });
  }
  return out;
}

function planEntryOf(h, seats) {
  return {
    hallName: h.name, numbenches: h.numbenches,
    studentsperbench: h.studentsperbench, layoutConfig: h.layoutConfig,
    capacity: api.hallUsableCapacity(h), seats: seats,
  };
}

// ── 1. usable capacity = declared bounded by physical inventory ──────────────
it("hallUsableCapacity equals declared when declared <= physical", () => {
  const h45 = hall("lh1", 6, [3, 3, 3], 45);   // physical 54, declared 45
  eq(api.hallPhysicalCapacity(h45), 54);
  eq(api.hallConfiguredCapacity(h45), 45);
  eq(api.hallUsableCapacity(h45), 45);
  eq(api.calcHallCapacity(h45), 45, "every caller reads the same usable number");
  eq(api.hallCapacityConfigError(h45), "");
});

it("declared > physical is bounded to physical AND reported as a config error", () => {
  const hBad = hall("lh1", 4, [3, 3, 3], 45);   // physical 36, declared 45
  eq(api.hallPhysicalCapacity(hBad), 36);
  eq(api.hallUsableCapacity(hBad), 36);
  const msg = api.hallCapacityConfigError(hBad);
  ok(msg.indexOf("45") >= 0 && msg.indexOf("36") >= 0, "error names both numbers: " + msg);
});

it("legacy hall without a capacity field is bounded by its physical inventory", () => {
  const hLegacy = hall("h", 5, [2, 2, 2]);
  eq(api.hallConfiguredCapacity(hLegacy), null);
  eq(api.hallUsableCapacity(hLegacy), api.hallPhysicalCapacity(hLegacy));
  eq(api.hallCapacityConfigError(hLegacy), "");
});

it("invalid capacity values are ignored and fall back to physical inventory", () => {
  eq(api.hallConfiguredCapacity(Object.assign(hall("h", 3, [2]), { capacity: "abc" })), null);
  eq(api.hallConfiguredCapacity(Object.assign(hall("h", 3, [2]), { capacity: 0 })), null);
  eq(api.hallConfiguredCapacity(Object.assign(hall("h", 3, [2]), { capacity: -5 })), null);
});

// ── 2. validation enforces the declared bound (auto and manual alike) ────────
it("planIntegrityProblems allows exactly the declared capacity and blocks one more", () => {
  const h45 = hall("lh1", 6, [3, 3, 3], 45);   // 54 physical slots, declared 45
  eq(api.planIntegrityProblems({ lh1: planEntryOf(h45, gridSeats(45, 3, 6, 3)) }), []);
  const probs = api.planIntegrityProblems({ lh1: planEntryOf(h45, gridSeats(46, 3, 6, 3)) });
  ok(probs.some(function (p) { return /Capacity overflow/.test(p); }), "46 seats in a 45-declared hall is rejected: " + probs.join("; "));
});

it("a generated plan that respects the declared bound passes integrity", () => {
  const h45 = hall("lh1", 6, [3, 3, 3], 45);
  const res = api.placeStudentsInHalls(students(45, "MECH", 1), [h45], 0, {}, RULES_OFF);
  eq(res.unplaced.length, 0);
  eq(api.planIntegrityProblems(res.plan), []);
});

// ── 3. first-hall-first within the declared bound, never overfill ────────────
it("placeStudentsInHalls never exceeds a hall's declared capacity", () => {
  const h45 = hall("lh1", 6, [3, 3, 3], 45);   // 54 physical seats
  const res = api.placeStudentsInHalls(students(50, "MECH", 1), [h45], 0, {}, RULES_OFF);
  eq(res.plan[h45.id].seats.length, 45, "exactly the declared 45 are placed");
  eq(res.plan[h45.id].capacity, 45);
  eq(res.unplaced.length, 5);
  ok(res.unplaced.every(function (u) { return u.reason.indexOf("capacity") >= 0; }));
});

it("the first eligible hall fills to its declared capacity before the next hall is used", () => {
  const h1 = hall("lh1", 6, [3, 3, 3], 45);   // declared 45
  const h2 = hall("lh2", 6, [3, 3, 3]);       // 54 physical, no declared limit
  const res = api.placeStudentsInHalls(students(54, "MECH", 1), [h1, h2], 0, {}, RULES_OFF);
  eq(res.unplaced.length, 0);
  eq(res.plan[h1.id].seats.length, 45, "LH-1 fills to exactly its declared 45 first");
  eq(res.plan[h2.id].seats.length, 9, "the overflow of 9 lands in the next hall");
});

it("a generated hall entry's capacity equals the hall's usable capacity", () => {
  const h45 = hall("lh1", 6, [3, 3, 3], 45);
  const res = api.placeStudentsInHalls(students(10, "MECH", 1), [h45], 0, {}, RULES_OFF);
  eq(res.plan[h45.id].capacity, api.hallUsableCapacity(h45));
});

// ── 4. the unplaced reason must NAME THE REAL BLOCKER ─────────────────────────
it("REPRO: capacity overflow where adjacency is impossible is reported as CAPACITY, not as the rule", () => {
  // Single-column hall: no row ever has a left neighbour and no bench faces the
  // previous one, so No-Same-Department cannot reject ANY seat. Roster 16 AID S
  // + 45 MECH = 61 students, hall declared 45. The OLD code blamed the rule here
  // ("No legal seat satisfies the active rules…"); the corrected engine says
  // capacity — which is what actually happened.
  const h45 = hall("lh1", 54, [1], 45);   // 54 single-seat rows, declared 45
  const roster = students(16, "AID S", 1).concat(students(45, "MECH", 1));
  const res = api.placeStudentsInHalls(roster, [h45], 0, {}, { splitGender: false, noSameDept: true, noSameYear: false });
  eq(res.plan[h45.id].seats.length, 45, "exactly the declared 45 are seated");
  eq(res.unplaced.length, 16);
  ok(res.unplaced[0].reason.indexOf("capacity") >= 0, "reason names capacity: " + res.unplaced[0].reason);
  ok(res.unplaced[0].reason.indexOf("No legal seat") < 0, "reason does NOT blame the rule");
});

it("a genuine adjacency block is still reported as the rule", () => {
  // [2,3] single-row hall: bench A is 2 slots, bench B is 3 slots, and B1.1
  // faces the rightmost seat of bench A (A1.2). Under noSameDept four seats
  // fill as CSE, ECE, CSE, ECE — but B1.3 sits beside the ECE at B1.2 and the
  // only remaining student is the FIFTH ECE, so B1.3 is genuinely stranded by
  // the RULE with a free seat left over. Back-fill repairs the old forward-scan
  // gaps elsewhere, but it cannot conjure a department that is not in the
  // roster, and the reason must still name the rule, not capacity.
  const hh = hall("h1", 1, [2, 3]);
  const roster = students(2, "CSE", 1).concat(students(3, "ECE", 1));
  const res = api.placeStudentsInHalls(roster, [hh], 0, {}, { splitGender: false, noSameDept: true, noSameYear: false });
  eq(res.plan[hh.id].seats.length, 4, "four legal non-adjacent seats are used");
  eq(res.unplaced.length, 1, "the rule genuinely strands the remaining ECE");
  ok(res.unplaced[0].reason.indexOf("No legal seat") >= 0, "reason blames the rule: " + res.unplaced[0].reason);
});

// ── 5. config-error surfacing in the bulk rows ─────────────────────────────────
it("bulkExamRows reports a hall whose declared capacity exceeds its physical inventory", () => {
  const hBad = hall("lhx", 4, [3, 3, 3], 45);   // declared 45, physical 36
  const e = {
    id: "e", subject: "U", date: "2025-12-01", session: "FN", status: "scheduled",
    groups: [{ dept: "MECH", year: 1 }], hallids: [hBad.id],
  };
  const rows = api.bulkExamRows([e], "2025-12-01", students(5, "MECH", 1), [hBad], {});
  eq(rows.length, 1);
  ok((rows[0].capacityWarnings || []).length >= 1, "row carries a warning");
  ok(rows[0].capacityWarnings[0].indexOf("45") >= 0, "warning names the declared value");
  eq(rows[0].hallCapacity, 36, "row capacity is the bounded usable value");
});

// ── 6. REPRO: the reported 14-10-2026 batch — 13 saved, 1 failed, 16 unplaced ──
ait("REPRO: 14-10-2026 Bulk Seating — 13 saved, 1 failed, 16 unplaced, truthful capacity reason", async () => {
  const FN = "14-10-2026";
  // LH-1: declared 45, physical 54 (single-column so adjacency cannot reject).
  const lh1 = hall("lh1", 54, [1], 45);
  const smallHalls = [];
  for (let i = 2; i <= 14; i++) smallHalls.push(hall("lh" + i, 10, [1, 1, 1]));   // 30 seats each
  const halls = [lh1].concat(smallHalls);

  // 13 small exams, each pinning 10 unique MECH students to its own hall.
  const smallExams = [], allStudents = [];
  const ids = new Set();
  for (let i = 0; i < 13; i++) {
    const sts = [];
    for (let j = 0; j < 10; j++) {
      const s = {
        id: "s" + i + "_" + j,
        regno: "910" + String(70 + i) + String(j).padStart(4, "0"),
        name: "St" + i + "_" + j, dept: "MECH", year: 1, gender: "male",
      };
      sts.push(s);
      allStudents.push(s);
      ids.add(s.id);
    }
    smallExams.push({
      id: "small" + i, subject: "University", subjectTitle: "SMALL" + i,
      date: FN, session: "FN", status: "scheduled",
      groups: [{ dept: "MECH", year: 1 }],
      registerNumbers: sts.map(function (x) { return x.regno; }),
      hallids: [smallHalls[i].id],
    });
  }

  // The failing exam: 61 students (16 AID S + 45 MECH) pinned to LH-1 (declared 45).
  const bigSts = [];
  for (let j = 0; j < 61; j++) {
    const st = {
      id: "big_" + j,
      regno: "920" + String(j).padStart(4, "0"),
      name: "Big" + j, dept: (j < 16 ? "AID S" : "MECH"), year: 1, gender: "male",
    };
    bigSts.push(st);
    allStudents.push(st);
    ids.add(st.id);
  }
  eq(ids.size, allStudents.length, "every synthetic student is unique");
  const bigExam = {
    id: "big", subject: "University", subjectTitle: "BIG",
    date: FN, session: "FN", status: "scheduled",
    groups: [{ dept: "AID S", year: 1 }, { dept: "MECH", year: 1 }],
    registerNumbers: bigSts.map(function (x) { return x.regno; }),
    hallids: [lh1.id],
  };
  const exams = smallExams.concat([bigExam]);

  const saved = [];
  const res = await api.runBulkSeating({
    exams: exams, allExams: exams, students: allStudents, halls: halls,
    rules: { splitGender: false, noSameDept: true, noSameYear: false, benchAdjacency: false },
    savePlan: async function (id) { saved.push(id); },
  });

  eq(res.summary.completed, 13, "13 exams saved");
  eq(res.summary.failed, 1, "exactly 1 exam failed");
  eq(res.summary.unplaced, 16, "16 students unplaced");
  const failed = res.results.filter(function (r) { return r.status === "failed"; });
  eq(failed.length, 1);
  ok(failed[0].reason.indexOf("Hall capacity exhausted") >= 0, "failure names capacity: " + failed[0].reason);
  ok(failed[0].reason.indexOf("No legal seat") < 0, "failure no longer blames the adjacency rule");
  eq((failed[0].unplaced || []).length, 16);
  ok(saved.length === 13 && saved.indexOf("big") < 0, "the oversized exam is never saved");
});

module.exports = s;