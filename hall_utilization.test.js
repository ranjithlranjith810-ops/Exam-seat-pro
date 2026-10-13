// Regression suite for HALL UTILIZATION (ROUND 6, ISSUE A).
//
// Reported defect: LH-1 (83 seats, declared usable 45) prints a Hall Notice for
// 14-10-2026 FN showing only 38 students in CAN/15-12-2025 and BHN/16-12-2025,
// halls that declared 45 usable seats but sat short while eligible students were
// still unplaced.
//
// The acceptance contract this suite pins:
//   R1  a hall whose usable capacity is 45 seats (3x3 layout, 5 rows) is filled
//       to EXACTLY the number of eligible legal students (38 of 45 stays in the
//       same hall — it never spills into the next hall just because it is not
//       full); every free seat is accounted for with a truthful reason
//   R2  overflow past usable capacity is EXACT (45 → 15), first hall full before
//       the second is touched
//   R3  a seat reserved by a coexisting exam's saved plan is never overwritten,
//       and the reservation is counted in the per-hall empty-seat accounting
//   R4  a seat stays empty ONLY when no remaining student can legally take it —
//       the engine never fills it out of rule (a facing-seat island the rules
//       genuinely block reports an honest rule reason, not a fabricated seat)
//   R5  gender blocks aggregate their own per-hall empty accounting; a hall
//       never holds both genders
//   R6  the merged co-seated pool for the real 14-10-2026 FN mix fills LH-1 to
//       its full usable 45 with zero unplaced — the exact caller-level fixture
//       that previously sat at 38
//   R7  per-hall empty-seat accounting is REPORT data only: it is never written
//       into the saved plan entries
//   R8  the generation report's emptySeats agrees with the per-hall accounting
//
// The engine fills every legally-fillable seat by construction: the main scan
// back-fills each seat with the earliest legal remaining student, so LH-1 fills
// to its usable capacity BEFORE the next hall is used. A seat is therefore left
// empty exactly when it is already occupied/reserved or no remaining student is
// legal anywhere in the eligible halls. The retro-fill pass re-visits every hall
// after the queue changes so no earlier seat that BECOMES legal after neighbours
// were filled is skipped — and, as R4 proves, it refuses every seat that is not
// legal, so a short hall always has an honest explanation.
const h = require("./harness.js");
const api = h.load();

const s = h.suite("hall_utilization.test.js — halls fill to usable capacity; empty seats carry truthful reasons");
const { it, eq, ok } = s;

const FN = "2026-10-14";
const RULES = { splitGender: false, noSameDept: true, noSameYear: true, benchAdjacency: true };
const COLLEGE = { name: "Test College", centre_code: "TC01" };

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

// LH-1 CAT hall as saved in the real dataset: cols [3,3,3], 5 rows, cap 45.
function lh1() { return hall("lh1", "LH-1", "CAT", 5, [3, 3, 3], 45); }
function lh2() { return hall("lh2", "LH-2", "CAT", 5, [3, 3, 3], 45); }

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

function hallSeats(plan, hid) { const hp = plan && plan[hid]; return (hp && hp.seats) || []; }
function last() { return api.__win.__lastSeatingResult; }
function emptyFor(r, hid) { return ((r.report && r.report.hallEmptySeats) || r.hallEmptySeats || []).filter(function (x) { return x.hallId === hid; })[0] || null; }
function sameDept(a, b) {
  return String((a && a.dept == null ? "GEN" : (a && a.dept)) || "").trim().toUpperCase()
      === String((b && b.dept == null ? "GEN" : (b && b.dept)) || "").trim().toUpperCase();
}
function adjPairs(plan) {
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

// ── R1. a partial-but-legal pool NEVER spills to the next hall ────────────────
it("R1: 38 eligible students on a 45-cap hall stay in LH-1 (38 placed, 7 empty seats accounted, LH-2 untouched)", () => {
  const pool = students(13, "AIDS", 2).concat(students(12, "MECH", 2), students(13, "CSE", 2));
  api.generateSmartSeating([{ label: "E1", students: pool, rules: RULES }], [lh1(), lh2()], {});
  const A = last();
  eq(A.unplaced.length, 0, "all 38 eligible students find a seat");
  eq(hallSeats(A.plan, "lh1").length, 38, "LH-1 holds exactly the 38 eligible students — got " + hallSeats(A.plan, "lh1").length);
  eq(hallSeats(A.plan, "lh2").length, 0, "LH-2 is never touched (first hall fills to its legal capacity before the next)");
  eq(adjPairs(A.plan), 0, "no same-department side-by-side pair");
  eq(api.validatePlan(A.plan, RULES), [], "the plan is clean under the rules");

  const e1 = emptyFor(A, "lh1");
  ok(e1, "LH-1 has a per-hall empty-seat record");
  eq(e1.capacity, 45, "capacity is the hall's usable 45");
  eq(e1.occupied, 38, "38 occupied");
  eq(e1.reserved, 0, "no seats reserved by another exam");
  eq(e1.empty, 7, "exactly 7 free seats stay free");
  ok(e1.reason.indexOf("Eligible pool has no more eligible/legal student for this hall") >= 0,
    "pool exhausted -> honest pool reason (got: " + e1.reason + ")");
  ok(!emptyFor(A, "lh2"), "an untouched hall has no empty-seat record (only visited halls are reported)");
});

// ── R2. overflow is EXACT: 45 then 15, zero gaps, zero unplaced ───────────────
it("R2: 60 students over a 45-cap hall overflow EXACTLY 15 (45→15) with every hall full and no unplaced", () => {
  const pool = students(15, "AIDS", 2).concat(students(15, "MECH", 2), students(15, "CSE", 2), students(15, "ECE", 2));
  api.generateSmartSeating([{ label: "E1", students: pool, rules: RULES }], [lh1(), lh2()], {});
  const A = last();
  eq(A.unplaced.length, 0, "all 60 placed");
  eq(hallSeats(A.plan, "lh1").length, 45, "LH-1 filled to exactly 45");
  eq(hallSeats(A.plan, "lh2").length, 15, "LH-2 takes exactly the 15 remainder — got " + hallSeats(A.plan, "lh2").length);
  eq(adjPairs(A.plan), 0, "no adjacency violation across the merged plan");
  const e1 = emptyFor(A, "lh1");
  const e2 = emptyFor(A, "lh2");
  eq(e1.empty, 0, "LH-1 has no free seat");
  eq(e2.occupied, 15, "LH-2 holds exactly the 15 remainder, so the run is full");
  eq(e2.empty, 30, "LH-2's own declared capacity is 45 — its remaining 30 seats are free ONLY because the pool is exhausted (got " + e2.empty + ")");
  eq(e2.reason, "Eligible pool has no more eligible/legal student for this hall", "the surplus free seats carry the truthful pool-exhausted reason");
  eq(e1.reason, "", "full halls carry no empty-seat reason");
});

// ── R3. reserved seats are never overwritten and show up in the accounting ────
it("R3: a seat reserved by a coexisting plan stays empty; the reservation is counted", () => {
  const pool = students(45, "AIDS", 2).concat(students(0, "MECH", 2), students(0, "CSE", 2));
  const used = { lh1: new Set(["lh1-B1S1"]) };   // another exam already owns bench 1 slot 1
  api.generateSmartSeating([{ label: "E1", students: students(45, "AIDS", 2), rules: RULES }], [lh1(), lh2()], used);
  // Single-department pool => noSameDept auto-disables; 45 distinct students.
  const A = last();
  eq(A.unplaced.length, 0, "all students placed");
  const inLh1 = hallSeats(A.plan, "lh1");
  eq(inLh1.length, 44, "LH-1 holds 44 (45 usable minus the 1 reserved seat)");
  ok(!inLh1.some(function (x) { return x.seatNo === "lh1-B1S1"; }), "the reserved seat is never assigned");
  eq(hallSeats(A.plan, "lh2").length, 1, "exactly one student overflows to LH-2 because LH-1's seat is reserved");
  const e1 = emptyFor(A, "lh1");
  eq(e1.reserved, 1, "the coexisting plan's reservation is counted");
  eq(e1.occupied, 44, "44 occupied");
  eq(e1.empty, 0, "no free seat remains once the reservation is subtracted");
});

// ── R4. a seat the rules genuinely block stays empty — with a truthful reason ─
it("R4: a facing-seat island the rules genuinely block is not force-filled (4 of 6 placed, honest rule reason)", () => {
  // [3,3] single-row hall, 5 MECH + 1 CSE. COLUMN-WISE MODE + largest-first:
  // the left column is the MECH demand — A1.1 MECH, A1.2 back-fills a CSE (a
  // MECH can never sit beside A1.1), A1.3 MECH. On the right column B1.1 FACES
  // the MECH at A1.3 so a MECH can never start there, and B1.3 sits beside the
  // MECH at B1.2: exactly B1.2 fills. 4 seats fill; the 2 MECH students that
  // cannot complete any pure column are reported, never invented into a seat.
  const h6 = hall("h1", "LH-1", "CAT", 1, [3, 3], 6);
  const pool = students(5, "MECH", 2).concat(students(1, "CSE", 2));
  api.generateSmartSeating([{ label: "E1", students: pool, rules: RULES }], [h6], {});
  const A = last();
  eq(hallSeats(A.plan, "h1").length, 4, "the 4 legally fillable pure-column seats are filled (A1.1/A1.2/A1.3/B1.2) — got " + hallSeats(A.plan, "h1").length);
  eq(A.unplaced.length, 2, "the 2 genuinely blockable MECH students are reported unplaced");
  ok(A.unplaced[0].reason.indexOf("No legal seat satisfies the active rules") >= 0,
    "a rule rejection reports the RULE, never capacity (got: " + A.unplaced[0].reason + ")");
  eq(api.validatePlan(A.plan, RULES), [], "no rule is bent to seat them");
  const e1 = emptyFor(A, "h1");
  eq(e1.empty, 2, "2 seats stay empty (B1.1 and B1.3 — facing/beside an un-fillable start)");
  eq(e1.occupied, 4, "4 occupied");
  ok(e1.reason.indexOf("Eligible students remain but no legal seat is available in the eligible halls") >= 0,
    "students remain -> the empty seats are explained as genuinely un-fillable (got: " + e1.reason + ")");
});

// ── R5. gender blocks aggregate their own empty accounting; halls never mix ───
it("R5: splitGender aggregates male- and female-block empty accounting; halls never hold both genders", () => {
  const male = students(20, "MECH", 2, "male");
  const female = students(20, "ECE", 2, "female");
  const R5 = { splitGender: true, noSameDept: true, noSameYear: false, benchAdjacency: true };
  api.generateSmartSeating([{ label: "POOL", students: male.concat(female), rules: R5 }], [lh1(), lh2()], {});
  const A = last();
  eq(A.unplaced.length, 0, "all placed");
  eq(hallSeats(A.plan, "lh1").length, 20, "males own LH-1");
  eq(hallSeats(A.plan, "lh2").length, 20, "females own LH-2 (started in the hall AFTER the last male hall)");
  eq(api.validateGenderSeparation(A.plan), [], "no hall holds both genders");
  const es = (A.report && A.report.hallEmptySeats) || [];
  eq(es.length, 2, "both gender blocks contribute their own hall empty-seat records");
  eq(es.every(function (x) { return x.empty === 25 && x.occupied === 20; }), true,
    "each gender hall: 20 occupied, 25 free, capacity 45");
  ok(es.every(function (x) { return x.reason.indexOf("Eligible pool has no more eligible/legal student") >= 0; }),
    "each gender pool was exhausted -> pool reason");
});

// ── R6. the real 14-10-2026 FN co-seated mix seats every pure column ──────────
it("R6: real 14-10-2026 FN mix (7/24/7/7) co-seated on one slot seats 41 in LH-1's pure columns (4 straddle, 0 unplaced), TOTAL 41", () => {
  const pool = students(7, "CSE", 1, "male", 0)
    .concat(students(24, "MECH", 1, "male", 10), students(7, "IT", 1, "male", 40), students(7, "ECE", 1, "male", 60));
  api.generateSmartSeating([{ label: "E1", students: pool, rules: RULES }], [lh1(), lh2()], {});
  const A = last();
  // 45 students (7 CSE + 24 MECH + 7 IT + 7 ECE) do not tile into the 5-row pure
  // columns of a single 45-seat hall: largest-remaining-demand-first gives the
  // combined 45 rows to MECH (5 columns), CSE (2), IT (2) and ECE (1 more), so
  // only the first 3 ECE fit and the rest straddle into LH-2. All 45 are seated;
  // no column ever mixes.
  eq(A.unplaced.length, 0, "0 unplaced");
  eq(hallSeats(A.plan, "lh1").length, 41, "LH-1 seats exactly its pure columns — got " + hallSeats(A.plan, "lh1").length);
  eq(hallSeats(A.plan, "lh2").length, 4, "the 4 students that cannot complete an LH-1 column straddle into LH-2");
  eq(adjPairs(A.plan), 0, "co-seated merged plan has zero adjacency violations");
  eq(emptyFor(A, "lh1").empty, 4, "LH-1's 4 tail-free slots stay empty (strict purity, never re-mixed)");

  const exams = [{ id: "e1", subject: "MERGED", date: FN, session: "FN", seatinggenerated: true }];
  const plans = { e1: A.plan };
  const doc = api.buildHallNoticesPrintDocument({ exams: exams, seatingPlans: plans, halls: [lh1(), lh2()], date: FN, session: "FN", hallId: "lh1" }, COLLEGE);
  eq(doc.pages.length, 1, "one date+session+hall = one page");
  ok(/TOTAL:<\/strong> 41/.test(doc.pages[0]), "Hall Notice TOTAL is 41 — the exact count the merged plan saves");
  const distinct = new Set(hallSeats(A.plan, "lh1").map(function (x) { return x.seatNo; }));
  eq(distinct.size, 41, "TOTAL == distinct occupied physical seats");
});

// ── R7. empty-seat accounting is report data, never saved into the plan ───────
it("R7: per-hall empty-seat accounting never leaks into the saved plan entries", () => {
  api.generateSmartSeating([{ label: "E1", students: students(38, "MECH", 2), rules: RULES }], [lh1(), lh2()], {});
  const A = last();
  const hp = A.plan.lh1;
  ok(hp, "plan entry exists");
  ok(!("hallEmptySeats" in hp), "no empty-seat field on the plan entry");
  ok(!("reserved" in hp) && !("empty" in hp), "no capacity-accounting leak into the saved plan");
  ok(Array.isArray(A.hallEmptySeats) || (A.report && Array.isArray(A.report.hallEmptySeats)),
    "the accounting is available on the generation result/report only");
});

// ── R8. report.emptySeats agrees with the per-hall accounting ─────────────────
it("R8: the generation report's emptySeats equals the sum of the per-hall empty seats", () => {
  api.generateSmartSeating([{ label: "E1", students: students(38, "MECH", 2), rules: RULES }], [lh1()], {});
  const A = last();
  eq(A.report.totalStudents, 38, "report counts the whole pool");
  eq(A.report.assigned, 38, "38 assigned");
  eq(A.report.unassigned, 0, "0 unassigned");
  const sumEmpty = (A.report.hallEmptySeats || []).reduce(function (a, x) { return a + x.empty; }, 0);
  eq(A.report.emptySeats, sumEmpty, "report.emptySeats " + A.report.emptySeats + " == sum of per-hall " + sumEmpty);
});

module.exports = s;