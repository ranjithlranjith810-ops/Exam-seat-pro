// Regression tests for ExamSeatPro v66 — CAT Seating LIVE-FAILURE REPAIR.
//
// The real deployment lost 14-10-2026 FN exams to:
//   A. a "Hall conflict: LH-18, LH-19 already assigned" toast that treated
//      plan-based (shareable) hall usage as an exclusive reservation,
//   B. seating plans saved under alias keys not being honoured as occupied,
//   C. Seating Plans reporting 17 seated while the Hall Notice showed 11 for the
//      same physical hall/date/session,
//   D. retries claiming a result that was not what the DB actually kept.
//
// The invariants pinned here, in order:
//   T1  a hall fills to EXACTLY its usable capacity (min(declared, physical))
//   T2  remaining students spill to the next eligible hall in order
//   T3  an adjacency-impossible remainder is reported as NO_LEGAL_SEAT, never
//       conflated with a pure capacity shortfall (HALL_CAPACITY_EXHAUSTED)
//   T4  reservations in a same-FN other exam are honoured even when that plan is
//       keyed by the hall NAME/alias, and hallids-explicit reservations exclude
//       the hall while plan-only usage SHARES it
//   T5  an exam never conflicts with its OWN saved plan during regeneration
//   T6  a failed plan read is DATA_LOAD_FAILED, never silently treated as free
//       seats (single-exam guard and bulk path)
//   T7  department adjacency is enforced in generation AND validation
//   T8  year adjacency is enforced when enabled, generation AND validation
//   T9  manual placement cannot bypass an enabled rule or capacity overflow
//   T10 a FAILED retry keeps + flags the previous plan (keptExisting/preserved)
//   T11 Seating Plans merged count === Hall Notice picker/total count for the
//       SAME canonical hall (regno + seat-key dedupe, alias-safe)
//   T12 a SUCCESSFUL retry persists the new plan and it survives a reload
const h = require("./harness.js");
const api = h.load();

const s = h.suite("cat_live_repair.test.js — CAT live shaping, reservations, Seating-Plans vs Hall-Notice, retry truth");
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
      id: dept + "_y" + (year || 1) + "_" + i,
      regno: "9" + String(10 + i + (year - 1) * 64).padStart(4, "0") + String(dept.charCodeAt(0)) + "Y" + (year || 1) + String(i).padStart(2, "0"),
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
      colIdx: ci, rowIdx: ri, slot: sl, dept: "MECH", year: 1,
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

function examOf(id, subject, roster, hallids, groups) {
  return {
    id: id, subject: subject, subjectTitle: subject,
    category: "CAT", examCategory: "CAT", date: FN, session: "FN", status: "scheduled",
    hallids: hallids || [], groups: groups || [{ dept: "MECH", year: 1 }],
    registerNumbers: (roster || []).map(function (x) { return x.regno; }),
  };
}

function sameDept(a, b) {
  return String((a && a.dept == null ? "GEN" : (a && a.dept)) || "").trim().toUpperCase()
      === String((b && b.dept == null ? "GEN" : (b && b.dept)) || "").trim().toUpperCase();
}
function sameYear(a, b) {
  return String((a && a.year) == null ? "" : a.year) === String((b && b.year) == null ? "" : b.year);
}
function adjacentPairsBy(plan, cmp) {
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
      if (left && cmp(a, left)) pairs++;
      if (facing && cmp(a, facing)) pairs++;
    }
  }
  return pairs;
}
const adjacentPairsByDept = function (plan) { return adjacentPairsBy(plan, sameDept); };
const adjacentPairsByYear = function (plan) { return adjacentPairsBy(plan, sameYear); };

// ── T1. usable capacity — configured = declared, physical = layout, usable = min ──
it("T1: a 45-seat hall fills to EXACTLY 45 (usable = min(declared 45, physical 45))", () => {
  const lh1 = hall("lh1", "LH-1", "CAT", 5, [3, 3, 3], 45);
  eq(api.hallPhysicalCapacity(lh1), 45, "physical inventory is 45");
  eq(api.hallUsableCapacity(lh1), 45, "usable = min(declared, physical) = 45");
  const roster = students(45, "MECH", 1);
  const exam = examOf("t1", "T1", roster, ["lh1"]);
  const lookups = api.bulkBuildLookups(roster, [exam], [lh1]);
  const res = api.bulkGenerateOne(exam, roster, [lh1], RULES_OFF, [exam], {}, lookups);
  ok(res.ok, "45 students on a 45-seat hall must generate — got: " + res.reason);
  const seats = Object.values(res.plan || {}).reduce(function (a, hp) { return a + ((hp.seats || []).length); }, 0);
  eq(seats, 45, "all 45 seated");
  eq(api.validatePlan(res.plan, RULES_OFF), [], "validator clean for the full hall");
  eq(api.planIntegrityProblems(res.plan), [], "integrity clean at the usable bound");
});

// ── T2. spillover — first hall fills first, the rest flow to the next ───────────
it("T2: 50 students on two 45-seat halls spill 45 → 5 (first-hall-first, zero unplaced)", () => {
  const lh1 = hall("lh1", "LH-1", "CAT", 5, [3, 3, 3], 45);
  const lh2 = hall("lh2", "LH-2", "University", 5, [3, 3, 3], 45);
  const roster = students(50, "MECH", 1);
  const exam = examOf("t2", "T2", roster, ["lh1", "lh2"]);
  const lookups = api.bulkBuildLookups(roster, [exam], [lh1, lh2]);
  const res = api.bulkGenerateOne(exam, roster, [lh1, lh2], RULES_OFF, [exam], {}, lookups);
  ok(res.ok, "50 onto 90 seats must be successful — got: " + res.reason);
  eq(res.plan.lh1.seats.length, 45, "first hall filled to its usable bound first");
  eq(res.plan.lh2.seats.length, 5, "second hall absorbed the remaining 5");
  eq(Object.values(res.plan).reduce(function (a, hp) { return a + hp.seats.length; }, 0), 50, "all 50 seated");
  eq((res.unplaced || []).length, 0, "no unplaced students");
});

// ── T3. NO_LEGAL_SEAT vs HALL_CAPACITY_EXHAUSTED are told apart truthfully ──────
it("T3: a rule-blocked remainder is NO_LEGAL_SEAT, a pure capacity shortage is HALL_CAPACITY_EXHAUSTED", () => {
  // [2,3] single-row hall (5 seats): four seats fill as CSE, ECE, CSE, ECE, but
  // B1.3 sits beside the ECE at B1.2 and the only remaining student is a FIFTH
  // ECE — B1.3 is genuinely stranded by the rule with a free seat left over (the
  // back-fill repaired the old forward-scan gaps elsewhere, but cannot conjure a
  // third department), so this remainder is NO_LEGAL_SEAT, not capacity.
  const small = hall("h8", "H8", "University", 1, [2, 3]);
  const blockedRoster = students(2, "CSE", 1).concat(students(3, "ECE", 1));
  const examR = examOf("t3r", "T3 Rule", blockedRoster, ["h8"],
    [{ dept: "CSE", year: 1 }, { dept: "ECE", year: 1 }]);
  const lookupsR = api.bulkBuildLookups(blockedRoster, [examR], [small]);
  const rules = { splitGender: false, noSameDept: true, noSameYear: false, benchAdjacency: false };
  const resRules = api.bulkGenerateOne(examR, blockedRoster, [small], rules, [examR], {}, lookupsR);
  ok(!resRules.ok && resRules.category === "NO_LEGAL_SEAT",
    "rule-rejected remainder must be NO_LEGAL_SEAT — got " + resRules.category + ": " + resRules.reason);
  // The same 5-seat hall, rules off, with more students than it holds: a pure
  // capacity shortage, so the same reason-dependent path reports capacity.
  const capRoster = students(8, "MECH", 1);
  const examC = examOf("t3c", "T3 Capacity", capRoster, ["h8"], [{ dept: "MECH", year: 1 }]);
  const lookupsC = api.bulkBuildLookups(capRoster, [examC], [small]);
  const resCap = api.bulkGenerateOne(examC, capRoster, [small], RULES_OFF, [examC], {}, lookupsC);
  ok(!resCap.ok && resCap.category === "HALL_CAPACITY_EXHAUSTED",
    "pure capacity remainder must be HALL_CAPACITY_EXHAUSTED — got " + resCap.category + ": " + resCap.reason);
});

// ── T4. reservations: alias-keyed plans are honoured; hallids are exclusive ─────
ait("T4: a same-FN other exam's plan is honoured even keyed by hall NAME, while hallids are exclusive", async () => {
  const lh1 = hall("lh1", "LH-1", "CAT", 5, [3, 3, 3], 45);
  const other = examOf("legacy", "Other FN", students(6, "ECE", 1), []);
  // Legacy storage: plan keyed by the hall NAME, rows carry only bench/slot.
  const reserved = [];
  for (let b = 1; b <= 6; b++) reserved.push({ regno: "RES" + b, bench: b, slot: 1, dept: "ECE", year: 1 });
  const otherPlan = { "LH-1": planEntry(lh1, reserved) };
  const cand = examOf("cand", "Robotics II", students(6, "AID S", 1), []);
  const reserv = await api.examReservationData(cand, [cand, other], [lh1], { [other.id]: otherPlan }, null);
  eq(reserv.error, null, "reservation read succeeded");
  ok(!reserv.busyHallIds.has("lh1"), "plan-only usage SHARES the hall (never an exclusive block)");
  ok(reserv.hallUsedSeats && reserv.hallUsedSeats["lh1"], "occupied seats are known for the hall");
  const used = reserv.hallUsedSeats["lh1"];
  ok(used.has("lh1-B1S1") && used.has("lh1-B6S1"),
    "alias-keyed plan seats surface as the SAME canonical generator keys (lh1-B1S1..lh1-B6S1)");
  const groups = [{ label: "Robotics II", dept: "MIX", year: 1, students: students(6, "AID S", 1), rules: RULES_OFF }];
  const plan = api.generateSmartSeating(groups, [lh1], reserv.hallUsedSeats);
  const placed = (plan.lh1 && plan.lh1.seats) || [];
  eq(placed.length, 6, "all 6 candidates seated");
  const reservedKeys = new Set(reserved.map(function (x) { return "lh1-B" + x.bench + "S" + x.slot; }));
  const collision = placed.filter(function (x) { return reservedKeys.has(x.seatNo); });
  eq(collision.length, 0, "no candidate sits on a seat the other exam holds");
  ok(!placed.some(function (x) { return x.seatNo === "lh1-B1S1"; }),
    "the generator's FIRST coordinate (lh1-B1S1) was handed to the other exam and stays empty");
  // Explicit hallids ARE exclusive.
  const ex2 = examOf("ex2", "Exclusive", students(1, "CSE", 1), ["lh1"]);
  const reserv2 = await api.examReservationData(cand, [cand, ex2], [lh1], {}, null);
  ok(reserv2.busyHallIds.has("lh1"), "an explicit hallids list honestly reserves the hall");
});

// ── T5. an exam never conflicts with its OWN saved plan ─────────────────────────
it("T5: regeneration never treats the exam's own saved plan as an external reservation", async () => {
  const lh1 = hall("lh1", "LH-1", "CAT", 5, [3, 3, 3], 45);
  const roster = students(16, "AID S", 1).concat(students(1, "MECH", 1));
  const robotics = examOf("robotics", "Foundations of Robotics", roster, ["lh1"]);
  const ownPlan = { "lh1": planEntry(lh1, gridSeats(17, 3, 5, 3)) };
  const reserv = await api.examReservationData(robotics, [robotics], [lh1], { [robotics.id]: ownPlan }, null);
  eq(reserv.error, null);
  ok(!reserv.busyHallIds.has("lh1"), "own plan does not hard-block its own hall");
  ok(!reserv.hallUsedSeats["lh1"], "own plan seats are fully replaceable (not occupied)");
  const newPlan = { "lh1": planEntry(lh1, gridSeats(17, 3, 5, 3)) };
  const conflicts = api.findPlanHallSessionConflicts(robotics.id, newPlan, [robotics], { [robotics.id]: ownPlan }, [lh1]);
  eq(conflicts.length, 0, "the same seat labels in the exam's own old plan are no conflict (nor duplicates)");
});

// ── T6. failed plan reads are DATA_LOAD_FAILED, never silent frees ──────────────
ait("T6: a plan-load error surfaces as DATA_LOAD_FAILED and saves nothing", async () => {
  const lh1 = hall("lh1", "LH-1", "CAT", 5, [3, 3, 3], 45);
  const other = examOf("locked", "Locked Exam", [], []);
  const cand = examOf("c", "C", students(4, "AID S", 1), []);
  const reserv = await api.examReservationData(cand, [cand, other], [lh1], {}, async function () {
    throw new Error("PERMISSION_DENIED");
  });
  ok(reserv.error && reserv.error.examId === "locked",
    "the failing exam is named in the reservation error — got " + JSON.stringify(reserv.error));
  ok(reserv.error.message.indexOf("PERMISSION_DENIED") >= 0, "the real exception is surfaced, not swallowed");
  const exam = examOf("self", "Self", students(6, "MECH", 1), []);
  let saved = 0;
  const res = await api.runBulkSeating({
    exams: [exam], allExams: [exam], students: students(6, "MECH", 1), halls: [lh1], rules: RULES_OFF,
    loadPlan: async function () { throw new Error("reader failed"); },
    savePlan: async function () { saved++; },
  });
  eq(res.results[0].status, "failed", "unreadable previous plan must fail, not 'regenerate into empty'");
  eq(res.results[0].category, "DATA_LOAD_FAILED", "the category is first-class");
  eq(saved, 0, "nothing is saved when occupancy is unknown");
});

// ── T7. department adjacency — generation AND validation ────────────────────────
it("T7: no same-dept side-by-side on the mandated fixture; validator and manual gate agree", () => {
  const lh1 = hall("lh1", "LH-1", "CAT", 5, [3, 3, 3], 45);
  const roster = students(16, "AID S", 1).concat(students(1, "MECH", 1));
  const exam = examOf("robotics", "Foundations of Robotics", roster, ["lh1"],
    [{ dept: "AID S", year: 1 }, { dept: "MECH", year: 1 }]);
  const rules = { splitGender: false, noSameDept: true, noSameYear: false, benchAdjacency: false };
  const lookups = api.bulkBuildLookups(roster, [exam], [lh1]);
  const res = api.bulkGenerateOne(exam, roster, [lh1], rules, [exam], {}, lookups);
  ok(res.ok, "mandated fixture must generate — got: " + res.reason);
  eq(adjacentPairsByDept(res.plan), 0, "zero same-dept pairs in the generated plan");
  eq(api.validatePlan(res.plan, rules), [], "validator is clean");
  // The pool needs TWO departments for the rule to be active; the violating pair
  // is AID S/AID S while a lone MECH seat keeps the rule enforceable.
  const manual = { "lh1": planEntry(lh1, [
    { regno: "A1", dept: "AID S", year: 1, colIdx: 0, rowIdx: 0, slot: 1, seatNo: "lh1-B1S1", seatLabel: "A1.1" },
    { regno: "A2", dept: "AID S", year: 1, colIdx: 0, rowIdx: 0, slot: 2, seatNo: "lh1-B1S2", seatLabel: "A1.2" },
    { regno: "M1", dept: "MECH", year: 1, colIdx: 1, rowIdx: 0, slot: 1, seatNo: "lh1-B6S1", seatLabel: "B1.1" },
  ])};
  const probs = api.validatePlan(manual, rules);
  ok(probs.some(function (p) { return /adjacency violation/i.test(p); }),
    "a planted same-dept pair must be named by validation: " + probs.join("; "));
  const gate = api.manualRuleGate(["No Same Department Side-by-Side: A1 & A2 are seated beside each other (row 1, bench 1)"], rules);
  eq(gate.block, true, "the manual save gate blocks the engine's own describe string");
});

// ── T8. year adjacency — when enabled ───────────────────────────────────────────
it("T8: no same-year side-by-side when noSameYear is ON; validator and gate agree", () => {
  // 2-slot benches let two study years alternate deterministically (every bench is
// one year-1 + one year-2 seat), so a full 32-student placement is guaranteed.
  const lh1 = hall("lh1", "LH-1", "CAT", 45, [2]);
  const roster = students(16, "AID S", 1).concat(students(16, "AID S", 2));
  const exam = examOf("years", "Years", roster, ["lh1"],
    [{ dept: "AID S", year: 1 }, { dept: "AID S", year: 2 }]);
  const rules = { splitGender: false, noSameDept: false, noSameYear: true, benchAdjacency: false };
  const lookups = api.bulkBuildLookups(roster, [exam], [lh1]);
  const res = api.bulkGenerateOne(exam, roster, [lh1], rules, [exam], {}, lookups);
  ok(res.ok, "two-year roster must generate under noSameYear — got: " + res.reason);
  ok(res.unsatisfiableRules.indexOf("noSameYear") < 0, "noSameYear is satisfiable here, not silently dropped");
  eq(adjacentPairsByYear(res.plan), 0, "zero same-year pairs");
  eq(api.validatePlan(res.plan, rules), [], "validator clean under noSameYear");
  // The pool needs TWO study years for the rule to be active; a lone year-2 seat
  // keeps the year rule enforceable while the planted pair stays year 1.
  const manual = { "lh1": planEntry(lh1, [
    { regno: "Y1", dept: "AID S", year: 1, colIdx: 0, rowIdx: 0, slot: 1, seatNo: "lh1-B1S1", seatLabel: "A1.1" },
    { regno: "Y2", dept: "AID S", year: 1, colIdx: 0, rowIdx: 0, slot: 2, seatNo: "lh1-B1S2", seatLabel: "A1.2" },
    { regno: "Y3", dept: "AID S", year: 2, colIdx: 1, rowIdx: 0, slot: 1, seatNo: "lh1-B6S1", seatLabel: "B1.1" },
  ])};
  const probs = api.validatePlan(manual, rules);
  ok(probs.some(function (p) { return /adjacency violation/i.test(p); }),
    "a planted same-year pair must be named by validation: " + probs.join("; "));
  const gate = api.manualRuleGate(["No Same Year Side-by-Side: Y1 & Y2 are seated beside each other (row 1, bench 1)"], rules);
  eq(gate.block, true, "the manual save gate blocks the engine's own describe string");
});

// ── T9. manual placement/overflow cannot bypass active rules or capacity ────────
it("T9: manual save cannot bypass an enabled rule or a capacity overflow", () => {
  const rules = { splitGender: false, noSameDept: true, noSameYear: false, benchAdjacency: false };
  const deptViol = ["No Same Department Side-by-Side: 91650006 & 91650007 are seated beside each other (row 1, bench 1)"];
  const yearRules = { splitGender: false, noSameDept: false, noSameYear: true, benchAdjacency: false };
  const yearViol = ["No Same Year Side-by-Side: 91650006 & 91650007 are seated beside each other (row 1, bench 1)"];
  eq(api.manualRuleGate(deptViol, rules).block, true, "dept rule blocks a manual save");
  eq(api.manualRuleGate(yearViol, yearRules).block, true, "year rule blocks a manual save");
  eq(api.manualRuleGate(deptViol, RULES_OFF).block, false, "the same pair rules-off is not blocked by the rule");
  const lh1 = hall("lh1", "LH-1", "CAT", 5, [3, 3, 3], 45);
  const overflow = { "lh1": planEntry(lh1, gridSeats(46, 3, 5, 3)) };
  const probs = api.planIntegrityProblems(overflow);
  ok(probs.some(function (p) { return /[Cc]apacity/.test(p); }),
    "46 rows on a 45-cap hall must be flagged as capacity misuse: " + probs.join("; "));
});

// ── T10. a FAILED retry keeps + flags the previous plan ─────────────────────────
ait("T10: a failed retry over capacity preserves and reports the previous plan (keptExisting, preserved=1)", async () => {
  const lh1 = hall("lh1", "LH-1", "University", 54, [1], 45);
  const oldPlan = { lh1: planEntry(lh1, gridSeats(45, 1, 54, 1)) };
  const roster = students(61, "MECH", 1);
  const bigExam = examOf("big", "BIG", roster, ["lh1"]);
  const saved = [];
  const res = await api.runBulkSeating({
    exams: [bigExam], allExams: [bigExam], students: roster, halls: [lh1], rules: RULES_OFF,
    loadPlan: async function () { return oldPlan; },
    savePlan: async function (id) { saved.push(id); },
    confirmOverwrite: function () { return true; },
  });
  const r = res.results[0];
  eq(saved.length, 0, "a failed retry must not write anything");
  eq(r.status, "failed", "61 > 45 must fail");
  eq(r.category, "HALL_CAPACITY_EXHAUSTED", "precise category (not NO_LEGAL_SEAT)");
  eq(r.keptExisting, true, "result discloses the previous plan was preserved");
  eq(res.plansById.big, oldPlan, "plansById still holds the untouched previous plan");
  eq(res.summary.preserved, 1, "the batch summary counts the preserved plan");
});

// ── T11. Seating Plans merged view === Hall Notice view (same canonical hall) ───
it("T11: Seating Plans merged count, Hall Notice picker and Hall Notice TOTAL agree on the same canonical hall", () => {
  const lh1 = hall("lh1", "LH-1", "University", 54, [1], 45);
  const rows = function (prefix, n, base) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const b = base + i; // bench 1-based
      out.push({
        regno: prefix + i, name: prefix + i, dept: "MECH", year: 1,
        seatNo: "lh1-B" + b + "S1", seatLabel: prefix + "S" + i,
        colIdx: 0, rowIdx: b - 1, slot: 1, bench: b,
      });
    }
    return out;
  };
  // Exam A: 17 unique rows + 6 leftover duplicate rows (same regnos, OTHER seats).
  const aSeats = rows("REG-A", 17, 1).concat(rows("REG-A", 6, 18));
  // Exam B: plan saved under the hall NAME alias, seating a subset of A's seats.
  const bSeats = rows("REG-B", 11, 1);
  const exams = [
    examOf("a", "Foundations of Robotics", [], ["lh1"]),
    examOf("b", "Other FN", [], []),
  ];
  const plans = {
    a: { "lh1": planEntry(lh1, aSeats) },
    b: { "LH-1": planEntry(lh1, bSeats) }, // alias key
  };
  const merged = api.hallMergedUniqueSeats(exams, plans, [lh1], "lh1");
  eq(merged.length, 17, "Seating Plans grid counts the surviving 17 (regno+seat-key first-wins)");
  const groups = api.hallNoticesGroup(exams, plans, [lh1], null, null, null);
  const g = groups.find(function (x) { return x.hallId === "lh1"; });
  ok(g, "the notice group exists for the canonical hall");
  eq(g.total, 17, "Hall Notice TOTAL counts the same 17");
  const perHall = api.hallNoticePerHall(exams, plans, [lh1]);
  eq(perHall.perHall["lh1"].seats.length, 17, "Hall Notice picker seats for LH-1 count the same 17");
  const dupes = api.seatingPlanDuplicateRows(plans.a);
  eq(dupes.filter(function (d) { return d.kind === "duplicate-student"; }).length, 6,
    "the 6 duplicated rows are surfaced as duplicate-student, never silently miscounted");
  ok(merged.some(function (r) { return (r.regno || "").indexOf("REG-B") >= 0; }) === false,
    "exam B's rows duplicate A's seats and are dropped first-wins, so the notice stays at 17");
});

// ── T12. a SUCCESSFUL retry persists the new plan and it survives a reload ─────
ait("T12: successful retry persists the new plan and a reload keeps it (skipped/preserved)", async () => {
  const lh1 = hall("lh1", "LH-1", "CAT", 5, [3, 3, 3], 45);
  const roster = students(16, "AID S", 1).concat(students(1, "MECH", 1));
  const robotics = examOf("robotics", "Foundations of Robotics", roster, ["lh1"],
    [{ dept: "AID S", year: 1 }, { dept: "MECH", year: 1 }]);
  const rules = { splitGender: false, noSameDept: true, noSameYear: false, benchAdjacency: false };
  const db = {};
  const res = await api.runBulkSeating({
    exams: [robotics], allExams: [robotics], students: roster, halls: [lh1], rules: rules,
    loadPlan: async function () { return null; },
    savePlan: async function (id, plan) { db[id] = plan; },
    confirmOverwrite: function () { return true; },
  });
  eq(res.results[0].status, "completed", "the retry generates");
  const savedSeats = Object.values(db.robotics || {}).reduce(function (a, hp) { return a + ((hp.seats || []).length); }, 0);
  eq(savedSeats, 17, "exactly the retry's 17 seats are persisted");
  eq(res.plansById.robotics, db.robotics, "plansById holds the persisted plan");
  // Reload: a later run reads the persisted plan and refuses to overwrite it.
  const res2 = await api.runBulkSeating({
    exams: [robotics], allExams: [robotics], students: roster, halls: [lh1], rules: rules,
    loadPlan: async function () { return db.robotics; },
    savePlan: async function (id, plan) { db[id] = plan; },
    confirmOverwrite: function () { return false; },
  });
  eq(res2.results[0].status, "skipped", "an existing plan is kept on reload");
  ok(res2.results[0].reason.indexOf("Existing plan kept") >= 0, "the skip reason is explicit");
  eq(res2.summary.preserved, 1, "the reload batch counts the preserved plan");
});

module.exports = s;