// Round 6, Issue B — largest-remaining-demand-first column assignment + the
// strict-column capacity estimate that powers the Bulk Seating by Date picker.
//
// Bug pinned here: the column-wise allocator used to commit vertical columns to
// departments by a blind round-robin cursor. On a batch of single-column halls
// (one bench column per hall) this stranded the HIGH-demand department: MECH
// (198 of 558 students) left a column tail empty while small departments held
// whole full columns, so 66 students sat unplaced on 14 halls. The approved
// correction commits the NEXT column to the canonical department with the
// LARGEST remaining demand (deterministic tie-break by first-seen order), so a
// demand like 198 spreads across enough columns and everything that CAN fit is
// seated. Strict purity is unchanged: a column is exactly one canonical
// department and a department that runs out mid-column leaves the tail EMPTY.
//
// The strict-column picker estimate (bulkColumnCapacityEstimate /
// bulkHallSelectionData.columnEstimate) measures usable columns, not free seats:
// with a department side-by-side rule a seat is only realisable when the
// selection provides a whole column for its department. It is labelled an
// estimate (reservations/gender-split/bench-adjacency can only raise the true
// requirement) and never blocks generation.
//
// Covered: the 14/15/16 single-column repro; gender-aware and no-gender
// estimates; per-hall column purity + validity on the successful plan;
// determinism; blocked/reserved seats; no-save-on-failure; picker warnings.

const h = require("./harness.js");
const api = h.load();

const s = h.suite("bulk_largest_first.test.js — largest-demand-first columns + strict-column estimate");
const { it, ait, eq, ok } = s;

const FN = "2026-10-14";
const GENDER_RULES = { splitGender: true, noSameDept: true, noSameYear: false, benchAdjacency: false };
const NO_GENDER_RULES = { splitGender: false, noSameDept: true, noSameYear: false, benchAdjacency: false };

const DEPT_SIZES = { "AI & DS": 60, "CSE": 120, "ECE": 100, "EEE": 80, "MECH": 198 };
const DEPT_YEARS = { "AI & DS": [2, 3], "CSE": [2, 3, 4], "ECE": [2, 3, 4], "EEE": [2, 3, 4], "MECH": [2, 3, 4] };
const DEPT_TOTAL = Object.keys(DEPT_SIZES).reduce(function (n, d) { return n + DEPT_SIZES[d]; }, 0); // 558

function hall(id, rows, colSeats, capacity) {
  const columns = colSeats.map(function (n) { return { seats: n }; });
  const perRow = columns.reduce(function (a, c) { return a + c.seats; }, 0);
  return {
    id: id, name: "LH-" + id.replace("lh", ""), hallType: "University",
    numbenches: rows, studentsperbench: perRow,
    capacity: capacity != null ? capacity : rows * perRow,
    layoutConfig: { columns: columns },
  };
}

// The 14-10-2026 FN repro pool: 14 CAT exams (one per dept×year = 2+3+3+3+3),
// 558 students, gender split by every-third index. With coSeat the exams merge
// into one pool sharing `nHalls` halls of the given bench geometry. Single-column
// halls are declared 45 (54 physical rows), matching the real LH records.
function fixture(nHalls, colSeats, rows, gen) {
  const single = colSeats.length === 1 && colSeats[0] === 1;
  const halls = [];
  for (let i = 1; i <= nHalls; i++) halls.push(hall("lh" + i, single ? 54 : (rows || 5), colSeats, single ? 45 : undefined));
  const students = [], exams = [];
  let regno = 953021243000, k = 0;
  Object.keys(DEPT_SIZES).forEach(function (dept) {
    const years = DEPT_YEARS[dept];
    for (let i = 0; i < DEPT_SIZES[dept]; i++, k++) {
      students.push({
        id: "st" + k, regno: String(regno + k), name: "Student " + k,
        dept: dept, year: years[i % years.length],
        gender: (i % 3 === 0 && gen !== false) ? "female" : "male",
      });
    }
  });
  Object.keys(DEPT_SIZES).forEach(function (dept) {
    DEPT_YEARS[dept].forEach(function (yr) {
      const roster = students.filter(function (s) { return s.dept === dept && s.year === yr; });
      if (!roster.length) return;
      exams.push({
        id: "e" + dept.replace(/[^A-Za-z0-9]/g, "") + "y" + yr, subject: "University",
        subjectTitle: dept + " Y" + yr, category: "CAT", date: FN, session: "FN",
        status: "scheduled", groups: [{ dept: dept, year: yr }],
        registerNumbers: roster.map(function (s) { return s.regno; }),
      });
    });
  });
  return { halls: halls, students: students, exams: exams };
}

function runBulk(halls, students, exams, rules, spies) {
  const saved = [], overwrites = [];
  return api.runBulkSeating({
    exams: exams, allExams: exams, students: students, halls: halls, rules: rules,
    coSeat: true, selectedHallIds: halls.map(function (x) { return x.id; }),
    savePlan: async function (id) { saved.push(id); },
    loadPlan: async function () { return null; },
    confirmOverwrite: function () { overwrites.push(1); return true; },
  }).then(function (res) {
    return { res: res, saved: saved, overwrites: overwrites };
  });
}

function mergedRoster(halls, students, exams) {
  const lookups = api.bulkBuildLookups(students, exams, halls);
  return api.bulkDedupeRoster(exams, students, lookups);
}

// A vertical column is one (colLabel, slot) inside ONE hall.
function impureColumns(plan, rules) {
  const cols = {};
  Object.values(plan).forEach(function (hp) {
    (hp.seats || []).forEach(function (x) {
      const k = x.hallId + "|" + x.colLabel + ".slot" + x.slot;
      (cols[k] = cols[k] || []).push(x);
    });
  });
  return Object.values(cols).filter(function (col) {
    return new Set(col.map(function (x) { return api.canonicalDept(x.dept); })).size > 1;
  }).map(function (col) {
    return col.map(function (x) { return x.seatLabel + ":" + x.dept; }).join(",");
  });
}

const EST_CONFIG = function (fx, n) {
  return { exams: fx.exams, students: fx.students, halls: fx.halls.slice(0, n), rules: GENDER_RULES };
};

// ── B1. the reported 14-single-column disaster: largest-first strands 41, ─────
// ──     not the 66 the round-robin cursor left behind, and saves nothing ──────
ait("B1: 14 single-column halls strand 41 (< 66 round-robin baseline); nothing saved", async () => {
  const fx = fixture(14, [1]);
  const { res, saved, overwrites } = await runBulk(fx.halls, fx.students, fx.exams, GENDER_RULES);
  eq(res.summary.total, 14, "14 exams in the co-seated batch");
  eq(res.summary.completed, 0, "no exam saved when the merged slot has unplaced students");
  eq(res.summary.failed, 14, "every exam of the slot fails together");
  eq(res.summary.unplaced, 41, "41 students stranded on 14 single-column halls");
  ok(res.summary.unplaced < 66, "LARGEST-FIRST: down from the 66 the round-robin cursor left unplaced");
  eq(res.summary.assigned, 0, "the failed slot assigns nothing");
  eq(saved.length, 0, "a partial plan is never written");
  eq(overwrites.length, 0, "confirmOverwrite is never even consulted on the failed slot");
});

// ── B2. one more hall makes the estimate satisfied and everyone seats ─────────
ait("B2: 16 single-column halls seat all 558 (completed 14, unplaced 0)", async () => {
  const fx = fixture(16, [1]);
  const { res, saved } = await runBulk(fx.halls, fx.students, fx.exams, GENDER_RULES);
  eq(res.summary.completed, 14, "all 14 exams saved");
  eq(res.summary.failed, 0, "no failures");
  eq(res.summary.unplaced, 0, "all 558 seated");
  eq(saved.length, 14, "every plan persisted");
  const est = api.bulkColumnCapacityEstimate(EST_CONFIG(fx, 16));
  ok(est.sufficient, "16 available columns satisfy the estimated 16 (est: " + JSON.stringify(est) + ")");
});

// ── B3. the successful plan is strictly pure per hall and validates clean ─────
it("B3: the 558-student co-seat plan keeps every column one canonical department", () => {
  const fx = fixture(16, [1]);
  const roster = mergedRoster(fx.halls, fx.students, fx.exams);
  eq(roster.count, 558, "merged roster is the whole pool");
  const res = api.placeStudentsInHalls(roster.students, fx.halls, 0, {}, GENDER_RULES);
  eq(res.unplaced.length, 0, "all 558 placed on 16 halls");
  const placed = Object.values(res.plan).reduce(function (n, hp) { return n + (hp.seats || []).length; }, 0);
  eq(placed, 558, "every seat record present");
  eq(impureColumns(res.plan, GENDER_RULES).length, 0, "no vertical column mixes canonical departments");
  eq(api.validatePlan(res.plan, GENDER_RULES).length, 0, "the plan satisfies the facing-seat rules");
});

// ── B4. the estimate is gender-aware and honest at every boundary ─────────────
it("B4: requiredColumns 16 (MECH 5, CSE 3, ECE 3, EEE 3, AIDS 2) vs 14/15/16 available", () => {
  const fx14 = fixture(14, [1]);
  const est14 = api.bulkColumnCapacityEstimate(EST_CONFIG(fx14, 14));
  eq(est14.active, true, "department rule + >=2 canonical departments engages the estimate");
  eq(est14.demand, 558, "demand is the deduped eligible pool");
  eq(est14.columnsAvailable, 14, "14 usable columns across the 14 halls");
  eq(est14.requiredColumns, 16, "16 complete columns needed under gender split");
  eq(est14.gapColumns, 2, "2-column shortfall");
  ok(!est14.sufficient, "14 halls are honestly marked insufficient");
  eq(est14.extraHalls, 2, "2 more single-column halls close the gap");
  ok(/add 2 hall/.test(est14.gapMessage), "gapMessage is actionable: " + est14.gapMessage);
  const byDept = est14.perDepartment.map(function (r) { return r.dept + ":" + r.requiredColumns; }).join(",");
  eq(byDept, "MECH:5,CSE:3,ECE:3,EEE:3,AIDS:2", "per-department spread matches reality (got: " + byDept + ")");

  const fx15 = fixture(15, [1]);
  const est15 = api.bulkColumnCapacityEstimate(EST_CONFIG(fx15, 15));
  eq(est15.columnsAvailable, 15, "15 available");
  eq(est15.gapColumns, 1, "still 1 short");
  ok(!est15.sufficient, "15 halls still marked insufficient");

  const fx16 = fixture(16, [1]);
  const est16 = api.bulkColumnCapacityEstimate(EST_CONFIG(fx16, 16));
  eq(est16.gapColumns, 0, "no gap at 16");
  ok(est16.sufficient, "16 halls marked sufficient");
});

// ── B5/B6. other geometries that MUST all seat are sealed as green ────────────
ait("B5: no-gender split on 15 single-column halls seats everyone", async () => {
  const fx = fixture(15, [1], undefined, false);
  const { res, saved } = await runBulk(fx.halls, fx.students, fx.exams, NO_GENDER_RULES);
  eq(res.summary.completed, 14, "all 14 exams saved");
  eq(res.summary.unplaced, 0, "no unplaced students");
  eq(saved.length, 14);
});

ait("B6: 15 halls of 5-row [3,3,3] (45 seats each) seat everyone under gender split", async () => {
  const fx = fixture(15, [3, 3, 3], 5);
  const { res, saved } = await runBulk(fx.halls, fx.students, fx.exams, GENDER_RULES);
  eq(res.summary.completed, 14, "all 14 exams saved");
  eq(res.summary.unplaced, 0, "all 558 seated");
  eq(saved.length, 14);
});

// ── B7. the picker surfaces the strict-column warning, never a blocking error ─
it("B7: bulkHallSelectionData warns on the 14-hall selection and still allows it", () => {
  const fx = fixture(14, [1]);
  const data = api.bulkHallSelectionData({
    date: FN, session: "FN", allExams: fx.exams, students: fx.students, halls: fx.halls,
    selectedExamIds: fx.exams.map(function (e) { return e.id; }),
    selectedHallIds: fx.halls.map(function (x) { return x.id; }),
    rules: GENDER_RULES,
  });
  eq(data.demand, 558, "demand counted");
  const ce = data.columnEstimate;
  eq(ce.active, true, "estimate engaged");
  eq(ce.columnsAvailable, 14, "14 usable columns in the selection");
  eq(ce.requiredColumns, 16, "16 needed");
  ok(!ce.sufficient, "selection marked insufficient");
  ok(data.validation.warnings.length >= 1, "a strict-column warning is surfaced");
  ok(data.validation.warnings[0].indexOf("MECH ~5") >= 0, "warning names the per-department spread");
  eq(data.validation.errors.length, 0, "free seats cover the demand, so no blocking error");
  eq(data.totals.freeAfter, 14 * 45 - 558, "free-seat arithmetic is untouched by the warning");
});

// ── B8. determinism: identical roster + halls ⇒ identical every time ──────────
it("B8: the largest-first assignment is deterministic", () => {
  const fx = fixture(16, [1]);
  const roster = mergedRoster(fx.halls, fx.students, fx.exams);
  const a = api.placeStudentsInHalls(roster.students, fx.halls, 0, {}, GENDER_RULES);
  const b = api.placeStudentsInHalls(roster.students, fx.halls, 0, {}, GENDER_RULES);
  const mapA = Object.values(a.plan).flatMap(function (hp) { return hp.seats || []; })
    .map(function (x) { return x.seatLabel + ":" + x.dept; }).sort();
  const mapB = Object.values(b.plan).flatMap(function (hp) { return hp.seats || []; })
    .map(function (x) { return x.seatLabel + ":" + x.dept; }).sort();
  eq(mapA, mapB, "identical seat→dept mapping on both runs");
  eq(mapA.length, 558, "both runs seat the full pool");
});

// ── B9. seats reserved by a coexisting plan are honoured, never overwritten ───
it("B9: blocked seats stay untouched and reduce what the hall can take", () => {
  const lh = { id: "lh1", name: "LH-1", hallType: "University", numbenches: 45, studentsperbench: 1, capacity: 45, layoutConfig: { columns: [{ seats: 1 }] } };
  const pool = [];
  for (let i = 0; i < 45; i++) pool.push({ id: "m" + i, regno: "9" + String(9000 + i), name: "M " + i, dept: "MECH", year: 1, gender: "male" });
  const blocked = new Set();
  for (let i = 1; i <= 5; i++) blocked.add("lh1-B" + i + "S1");
  api.generateSmartSeating([{ label: "E", students: pool, rules: NO_GENDER_RULES }], [lh], { lh1: blocked });
  const A = api.__win.__lastSeatingResult;
  const seats = (A.plan.lh1 && A.plan.lh1.seats) || [];
  eq(seats.length, 40, "45 usable − 5 blocked = 40 seated");
  eq(seats.filter(function (x) { return blocked.has(x.seatNo); }).length, 0, "no blocked seat is ever assigned");
  eq((A.unplaced || []).length, 5, "the 5 overflow students are honestly reported");
});

// ── B10. estimate helpers return the documented shape even before selection ───
it("B10: the estimate never claims a universal minimum — reservations can only raise it", () => {
  const fx = fixture(14, [1]);
  const est = api.bulkColumnCapacityEstimate({ exams: fx.exams, students: fx.students, halls: fx.halls.slice(0, 14), rules: GENDER_RULES });
  eq(est.estimate, true, "labelled as an estimate");
  ok(est.caveat.length > 0, "carries the caveat: " + est.caveat);
  const estOff = api.bulkColumnCapacityEstimate({ exams: fx.exams, students: fx.students, halls: fx.halls.slice(0, 14), rules: { splitGender: false, noSameDept: false, noSameYear: false } });
  ok(!estOff.active, "no department rule ⇒ estimate inactive (active is undefined/false), generation unblocked");
  eq(estOff.sufficient, true, "inactive estimate never blocks");
});

module.exports = s;