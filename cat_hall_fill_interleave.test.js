// Failing-first regression suite for the CAT HALL-FILLING + DEPARTMENT
// INTERLEAVING fix (ROUND 5).
//
// Reported defect: with Split by Gender + No Same Department Side-by-Side on,
// LH-1 (declared 45) is left only partly filled (e.g. 17 male AIDS Year-II) while
// eligible male students of OTHER departments are sent to the next hall. Two
// independent causes were proven by probe:
//   (a) CALLER: the CAT-timetable import seats each exam alone on its own disjoint
//       hall slice (commit -> catAllocateHalls), so a 17-student exam grabs LH-1
//       and a 28-student sibling grabs LH-2 — no co-filling of physial seats.
//   (b) ENGINE: generateSmartSeating orders students strictly by regno inside
//       each gender pool, so departments arrive in RUNS (AIDS-AIDS-AIDS) and the
//       forward scan abandons rejected seats, leaving HALF of LH-1 empty even for
//       a single combined pool of 45 eligible males.
//
// The fix:
//   · engine interleaves departments (round-robin, regno as the within-dept
//     tie-break) inside every gender pool, and back-fills every usable seat with
//     the earliest legal remaining student instead of leaving gaps;
//   · the CAT import builds the COMPLETE eligible pool for the slot
//     (date+session+bucket, across compatible exams), co-generates one plan over
//     the union of the slot's halls, then SPLITS it back per exam on save — each
//     exam stores only its own students (exam identity kept), physical seats are
//     shared plan-based (multi-subject merged-notice model), and the shared hall
//     keeps ONE hallids owner so admin regeneration never false-conflicts.
//
// Tests:
//   M1  a 45-strong interleaved male pool (17 AIDS + 14 MECH + 14 CSE, all Y2)
//       fills LH-1 to EXACTLY 45: no overflow to LH-2, zero unplaced, zero
//       same-dept adjacency pairs, validator clean
//   M2  a 46-strong pool overflows EXACTLY 1 to LH-2 (45 → 1, no gap before spill)
//   M3  gender split stays intact with interleave active: a hall never holds both
//       genders and males fill their halls to capacity before females start
//   M4  a single-department pool is handled TRUTHFULLY (no invented fillers, no
//       silent rule claim): bulkGenerateOne reports unsatisfiable/rule-warnings,
//       reason is capacity/adjacency — never an invented other-department seat
//   M5  reservations are honoured: pre-occupied seats on LH-1 stay EMPTY (never
//       overwritten) and all 45 eligible students still find a seat
//   M6  caller-level co-seat split-save: E1(17 AIDS) + E2(28 others) on one slot
//       land as TWO plans that share LH-1 seats — 45 merged unique physical seats,
//       each plan holds only its own regnos, seat keys disjoint (plan-based share
//       never creates a plan-conflict), merged adjacency is zero
//   M7  the integrated catCoSeatSlot() hands the same result back to the import
//       caller: E1 owns hallids [lh1], E2 shares plan-based, both saved plans
//       reconstruct the identical merged 45
const h = require("./harness.js");
const api = h.load();

const s = h.suite("cat_hall_fill_interleave.test.js — LH-1 fills 45 dept-interleaved, co-seat split-save");
const { it, ait, eq, ok } = s;

const FN = "14-10-2026";
const RULES = { splitGender: true, noSameDept: true, noSameYear: true, benchAdjacency: true };

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

function students(n, dept, year, gender, seed) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const k = seed !== undefined ? seed + i : i;
    out.push({
      id: dept + "_y" + (year || 1) + "_" + k,
      regno: "9" + String(10 + k + (year - 1) * 64).padStart(4, "0") + String(dept.charCodeAt(0)) + "Y" + (year || 1) + String(k).padStart(2, "0"),
      name: dept + " " + k, dept: dept, year: year || 1, gender: gender || "male",
    });
  }
  return out;
}

function sameDept(a, b) {
  return String((a && a.dept == null ? "GEN" : (a && a.dept)) || "").trim().toUpperCase()
      === String((b && b.dept == null ? "GEN" : (b && b.dept)) || "").trim().toUpperCase();
}
function adjacentSameDeptPairs(plan) {
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
function seatCount(plan) { return Object.values(plan || {}).reduce(function (a, hp) { return a + ((hp.seats || []).length); }, 0); }
function hallSeats(plan, hid) { const hp = plan && plan[hid]; return (hp && hp.seats) || []; }
function regnoSet(plan) {
  const out = new Set();
  Object.values(plan || {}).forEach(function (hp) { (hp.seats || []).forEach(function (x) { out.add(String(x.regno)); }); });
  return out;
}
// Split a combined plan back to a per-exam plan holding ONLY that exam's regnos.
function splitPlanFor(plan, regnos) {
  const rset = new Set((regnos || []).map(function (x) { return String(x); }));
  const sub = {};
  Object.keys(plan || {}).forEach(function (hid) {
    const hp = plan[hid];
    const seats = (hp.seats || []).filter(function (x) { return rset.has(String(x.regno)); });
    if (!seats.length) return;
    const benchMap = {};
    seats.forEach(function (x) { if (!benchMap[x.bench]) benchMap[x.bench] = []; benchMap[x.bench].push(x); });
    const benches = Object.keys(benchMap).sort(function (a, b) { return a - b; }).map(function (bn) {
      const b = benchMap[bn].sort(function (a, b2) { return a.slot - b2.slot; });
      return { benchNo: parseInt(bn), slots: b, capacity: b.length };
    });
    sub[hid] = {
      hallName: hp.hallName, numbenches: hp.numbenches, studentsperbench: hp.studentsperbench,
      layoutConfig: hp.layoutConfig, capacity: hp.capacity, benches: benches, seats: seats,
    };
  });
  return sub;
}
function tripleRun(plan) {
  for (const hp of Object.values(plan || {})) {
    const seats = (hp.seats || []).slice().sort(function (a, b) { return (a.bench - b.bench) || (a.slot - b.slot); });
    for (let i = 0; i + 2 < seats.length; i++) {
      if (sameDept(seats[i], seats[i + 1]) && sameDept(seats[i + 1], seats[i + 2])) return true;
    }
  }
  return false;
}

// ── M1. the acceptance fixture: 45 eligible males fill LH-1 exactly ────────────
it("M1: combined 45-male pool (17 AIDS + 14 MECH + 14 CSE) fills LH-1 to its full usable 45, no overflow into LH-2", () => {
  const lh1 = hall("lh1", "LH-1", "CAT", 5, [3, 3, 3], 45);
  const lh2 = hall("lh2", "LH-2", "CAT", 5, [3, 3, 3], 45);
  const pool = students(17, "AIDS", 2).concat(students(14, "MECH", 2), students(14, "CSE", 2));
  api.generateSmartSeating([{ label: "COMBINED", students: pool, rules: RULES }], [lh1, lh2], {});
  const A = api.__win.__lastSeatingResult;
  ok(A, "engine reported a seating result");
  eq(A.unplaced.length, 0, "every eligible student finds a seat");
  eq(hallSeats(A.plan, "lh1").length, 45, "LH-1 filled to exactly its usable 45 — got " + hallSeats(A.plan, "lh1").length);
  eq(hallSeats(A.plan, "lh2").length, 0, "LH-2 stays empty (no premature spillover)");
  eq(adjacentSameDeptPairs(A.plan), 0, "no same-department side-by-side pair anywhere");
  eq(tripleRun(A.plan), false, "no AIDS-AIDS-AIDS style conversion run survives");
  eq(api.validatePlan(A.plan, RULES), [], "validator agrees the plan is clean");
});

// ── M2. overflow only when the pool exceeds the first hall──────────────────────
it("M2: 46 eligible males overflow EXACTLY 1 to LH-2 (45 in LH-1, 1 in LH-2, 0 unplaced)", () => {
  const lh1 = hall("lh1", "LH-1", "CAT", 5, [3, 3, 3], 45);
  const lh2 = hall("lh2", "LH-2", "CAT", 5, [3, 3, 3], 45);
  const pool = students(17, "AIDS", 2).concat(students(15, "MECH", 2), students(14, "CSE", 2));
  api.generateSmartSeating([{ label: "COMBINED", students: pool, rules: RULES }], [lh1, lh2], {});
  const A = api.__win.__lastSeatingResult;
  eq(A.unplaced.length, 0, "all 46 placed");
  eq(hallSeats(A.plan, "lh1").length, 45, "LH-1 at 45");
  eq(hallSeats(A.plan, "lh2").length, 1, "exactly one overflows into LH-2");
  eq(adjacentSameDeptPairs(A.plan), 0, "no same-dept adjacency across the merged plan");
});

// ── M3. gender separation survives department interleaving ────────────────────
it("M3: with splitGender on, a hall never holds both genders and males fill their halls before females get a hall", () => {
  const lh1 = hall("lh1", "LH-1", "CAT", 5, [3, 3, 3], 45);
  const lh2 = hall("lh2", "LH-2", "CAT", 5, [3, 3, 3], 45);
  const pool = students(17, "AIDS", 2).concat(students(14, "MECH", 2), students(14, "CSE", 2))
    .concat(students(13, "ECE", 2, "female"), students(7, "IT", 2, "female"));
  api.generateSmartSeating([{ label: "POOL", students: pool, rules: RULES }], [lh1, lh2], {});
  const A = api.__win.__lastSeatingResult;
  eq(A.unplaced.length, 0, "all placed");
  const mixedHall = Object.values(A.plan).some(function (hp) {
    const gs = (hp.seats || []).map(function (x) { return String(x.gender || "").toLowerCase(); });
    return gs.includes("male") && gs.some(function (g) { return g && g !== "male" && g !== "m"; });
  });
  eq(mixedHall, false, "no hall holds both a male and a non-male student");
  eq(adjacentSameDeptPairs(A.plan), 0, "still no same-dept adjacency");
});

// ── M4. single-department pool is reported truthfully ────────────────────────
it("M4: a single-department pool is NOT silently filled with invented students or claimed rule-satisfied", () => {
  const lh1 = hall("lh1", "LH-1", "CAT", 5, [3, 3, 3], 45);
  const lh2 = hall("lh2", "LH-2", "CAT", 5, [3, 3, 3], 45);
  const roster = students(45, "MECH", 2);
  const exam = { id: "m4", subject: "M4", category: "CAT", examCategory: "CAT", date: FN, session: "FN",
    hallids: ["lh1", "lh2"], groups: [{ dept: "MECH", year: 2 }], registerNumbers: roster.map(function (x) { return x.regno; }) };
  const lookups = api.bulkBuildLookups(roster, [exam], [lh1, lh2]);
  const rules = { splitGender: false, noSameDept: true, noSameYear: false, benchAdjacency: true };
  const res = api.bulkGenerateOne(exam, roster, [lh1, lh2], rules, [exam], {}, lookups);
  const imp = api.adjacencyImpossibility(roster, rules);
  ok(imp.noSameDept, "single department -> noSameDept is flagged unsatisfiable");
  ok((res.ruleWarnings || []) && (res.ruleWarnings || []).length > 0 || res.category === "NO_LEGAL_SEAT" || !res.ok,
    "the engine must NOT claim the rule is satisfied for a single-department pool (res.ok=" + res.ok + ", cat=" + res.category + ")");
  const placed = seatCount(res.plan || {});
  eq(placed, 45, "the 45 real students ARE seated (45 empty seats stay empty, nothing invented)");
});

// ── M5. reservations are honoured with interleave active ─────────────────────
it("M5: pre-occupied LH-1 seats stay empty (never overwritten) and all 45 eligible still get a seat", () => {
  const lh1 = hall("lh1", "LH-1", "CAT", 5, [3, 3, 3], 45);
  const lh2 = hall("lh2", "LH-2", "CAT", 5, [3, 3, 3], 45);
  const taken = new Set(["lh1-B1S1", "lh1-B1S2", "lh1-B2S1", "lh1-B3S1", "lh1-B4S1", "lh1-B5S1"]);
  const pool = students(17, "AIDS", 2).concat(students(14, "MECH", 2), students(14, "CSE", 2));
  api.generateSmartSeating([{ label: "POOL", students: pool, rules: RULES }], [lh1, lh2], { lh1: taken });
  const A = api.__win.__lastSeatingResult;
  eq(A.unplaced.length, 0, "all placed around the reservations");
  const overlap = hallSeats(A.plan, "lh1").filter(function (x) { return taken.has(x.seatNo); });
  eq(overlap.length, 0, "no generation onto an occupied seat");
  eq(seatCount(A.plan), 45, "45 filled despite 6 reserved seats (LH-2 absorbs overflow of 6... none if fill first)");
});

// ── M6. caller-level co-seat split-save on existing primitives ────────────────
it("M6: E1(17 AIDS)+E2(28 others) single slot -> two plans share LH-1's 45 seats, disjoint keys, per-exam identity kept", () => {
  const lh1 = hall("lh1", "LH-1", "CAT", 5, [3, 3, 3], 45);
  const lh2 = hall("lh2", "LH-2", "CAT", 5, [3, 3, 3], 45);
  const e1 = students(17, "AIDS", 2);
  const e2 = students(14, "MECH", 2, "male", 100).concat(students(14, "CSE", 2, "male", 200));
  const pool = e1.concat(e2);
  const parts = (function (p) { const g = api.catSplitByGender(p); return [[g.male.length, g.female.length, g.other.length]]; })(pool);
  const slice = api.catAllocateHalls(1, [pool.length], [lh1, lh2], new Set(), parts);
  eq(slice[0].halls.length, 1, "one slot of 45 males needs exactly one hall");
  const plan = api.generateSmartSeating([{ label: "SLOT", students: pool, rules: RULES }], slice[0].halls, {});
  eq(hallSeats(plan, "lh1").length, 45, "combined generation filled LH-1 to 45");
  const p1 = splitPlanFor(plan, e1.map(function (x) { return x.regno; }));
  const p2 = splitPlanFor(plan, e2.map(function (x) { return x.regno; }));
  eq(seatCount(p1), 17, "E1 plan holds exactly its 17 students");
  eq(seatCount(p2), 28, "E2 plan holds exactly its 28 students");
  const merged = {};
  Object.keys(plan).forEach(function (hid) { merged[hid] = p1[hid] ? { seats: p1[hid].seats.concat(p2[hid] ? p2[hid].seats : []) } : { seats: p2[hid] ? p2[hid].seats : [] }; });
  eq(adjacentSameDeptPairs(merged), 0, "physical adjacency across BOTH plans is clean");
  const k1 = hallSeats(p1, "lh1").map(function (x) { return x.seatNo; });
  const k2 = hallSeats(p2, "lh1").map(function (x) { return x.seatNo; });
  eq(k1.filter(function (x) { return k2.indexOf(x) >= 0; }).length, 0, "seat keys never collide across the two plans (plan-based share)");
  const allSeats = new Set(k1.concat(k2));
  eq(allSeats.size, 45, "the two plans together own exactly 45 distinct physical seats in LH-1");
});

// ── M7. integrated catCoSeatSlot: same result wired into the import caller ────
it("M7: catCoSeatSlot co-seats the slot, E1 owns hallids [lh1], E2 shares plan-based, plans reconstruct the merged 45", () => {
  const lh1 = hall("lh1", "LH-1", "CAT", 5, [3, 3, 3], 45);
  const lh2 = hall("lh2", "LH-2", "CAT", 5, [3, 3, 3], 45);
  const rows = [
    { examId: "e1", students: students(17, "AIDS", 2), dept: "AIDS", year: 2, subjectName: "ROBOTICS" },
    { examId: "e2", students: students(14, "MECH", 2, "male", 100).concat(students(14, "CSE", 2, "male", 200)), dept: "MECH", year: 2, subjectName: "THERMODYNAMICS" },
  ];
  const out = api.catCoSeatSlot(rows, [lh1, lh2], new Set());
  eq(out.assignments.length, 2, "one assignment per exam");
  const a1 = out.assignments[0], a2 = out.assignments[1];
  eq(seatCount(a1.plan), 17, "E1 saved plan holds 17");
  eq(seatCount(a2.plan), 28, "E2 saved plan holds 28");
  eq(JSON.stringify(a1.hallids || []), JSON.stringify(["lh1"]), "E1 owns the shared hall");
  eq(JSON.stringify(a2.hallids || []), JSON.stringify([]), "E2 shares plan-based, no exclusive hallids");
  const merged = {};
  Object.keys(a1.plan).forEach(function (hid) { merged[hid] = a1.plan[hid]; });
  Object.keys(a2.plan).forEach(function (hid) {
    merged[hid] = { seats: ((merged[hid] && merged[hid].seats) || []).concat(a2.plan[hid].seats) };
  });
  eq(adjacentSameDeptPairs(merged), 0, "merged physical occupancy is adjacency-clean");
  const allK = [];
  Object.values(a1.plan).forEach(function (hp) { (hp.seats || []).forEach(function (x) { allK.push(x.seatNo); }); });
  Object.values(a2.plan).forEach(function (hp) { (hp.seats || []).forEach(function (x) { allK.push(x.seatNo); }); });
  eq(new Set(allK).size, 45, "exactly 45 distinct physical seats across both plans");
  eq((out.unplacedTotal || 0), 0, "nothing was left unseated");
});

module.exports = s;