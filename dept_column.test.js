// Regression tests for column-wise department separation.
//
// Bug pinned here: the engine fills seats column-first / slot-major (A1.1, A2.1,
// ... A5.1 for column A slot 1) but its queue is department-INTERLEAVED whenever a
// department side-by-side rule is active. The observable SEAT GRID therefore shows
// alternating departments down one vertical column (CSE, ECE, MECH, CSE, ECE ...),
// i.e. every seat sits directly behind a student of a DIFFERENT department.
//
// Fix (design approved): when a department side-by-side rule is requested AND the
// roster sorts into >= 2 raw departments AND >= 2 canonical departments, the
// allocator groups students by canonicalDept (AID S / AIDS share one column) and
// assigns each vertical column to exactly ONE department. Strict purity: a column
// is never completed with a second department; a department that runs out
// mid-column leaves the remaining rows EMPTY, and the retro-fill pass is bypassed
// so an empty seat is never silently completed with a different department.
// Remaining (unplaceable) students surface through `unplaced` as before.
//
// Covered: activation gate; balanced rotation; canonical alias purity (AID S +
// AIDS one column, AIML distinct); strict mid-column tail left empty (no retro-fill
// mixing); multi-hall overflow; split-gender interplay; determinism; the horizontal
// facing-seat rule still yields a clean validatePlan; gate-off runs keep the
// legacy interleaved path.
const h = require("./harness.js");
const api = h.load();

const s = h.suite("dept_column.test.js — column-wise department separation");
const { it, eq, ok } = s;

const RULES_OFF = { splitGender: false, noSameDept: false, noSameYear: false, benchAdjacency: false };
const CAT_RULES = { splitGender: false, noSameDept: true, noSameYear: false, benchAdjacency: true };
const NSD_RULES = { splitGender: false, noSameDept: true, noSameYear: false, benchAdjacency: false };
const YEAR_RULES = { splitGender: false, noSameDept: false, noSameYear: true, benchAdjacency: false };

function hall(id, rows, colSeats) {
  const columns = colSeats.map((n) => ({ seats: n }));
  const perRow = columns.reduce((a, c) => a + c.seats, 0);
  return { id, name: id, hallType: "University", numbenches: rows, studentsperbench: perRow, capacity: rows * perRow, layoutConfig: { columns } };
}
function seatsOf(res) { return Object.values(res.plan || {}).flatMap((hp) => hp.seats || []); }
// Vertical columns: fixed (colLabel, slot) across ALL rows, front to back.
function verticalColumns(seats) {
  const cols = {};
  (seats || []).forEach((x) => {
    const k = x.colLabel + ".slot" + x.slot;
    (cols[k] = cols[k] || []).push(x);
  });
  return cols;
}
function canonicalOf(col) { const u = new Set(col.map((x) => api.canonicalDept(x.dept))); return [...u].sort().join(","); }
function pure(col) { return canonicalOf(col).indexOf(",") < 0; }

// ── G1: the gate fires for a department side-by-side rule with real mixing ────
it("G1: gate on for noSameDept with >=2 raw AND >=2 canonical departments", () => {
  const pool = [
    { id: 1, regno: "900000000001", name: "1", dept: "CSE", year: 2, gender: "male" },
    { id: 2, regno: "900000000002", name: "2", dept: "ECE", year: 2, gender: "male" },
  ];
  ok(api.deptColumnModeActive(pool, CAT_RULES), "CAT rules + CSE/ECE must engage column mode");
  ok(api.deptColumnModeActive(pool, NSD_RULES), "noSameDept alone must engage column mode");
});

// ── G2: the gate stays OFF for a single canonical department, a year-only rule ─
it("G2: gate off for one canonical dept, a year-only rule, or no rule at all", () => {
  const aliasOnly = [
    { id: 1, regno: "900000000001", name: "1", dept: "AID S", year: 2, gender: "male" },
    { id: 2, regno: "900000000002", name: "2", dept: "AIDS", year: 2, gender: "male" },
    { id: 3, regno: "900000000003", name: "3", dept: "AI & DS", year: 2, gender: "male" },
  ];
  const twoRaw = [
    { id: 1, regno: "900000000001", name: "1", dept: "CSE", year: 2, gender: "male" },
    { id: 2, regno: "900000000002", name: "2", dept: "ECE", year: 4, gender: "male" },
  ];
  eq(api.deptColumnModeActive(aliasOnly, CAT_RULES), false, "AID S/AIDS/AI & DS are one canonical dept — trivially pure");
  eq(api.deptColumnModeActive(twoRaw, YEAR_RULES), false, "a year-only rule never engages column mode");
  eq(api.deptColumnModeActive(twoRaw, RULES_OFF), false, "no rules never engage column mode");
  eq(api.deptColumnModeActive([{ id: 1, regno: "0", dept: "CSE", year: 2 }], CAT_RULES), false, "a single student can never mix");
});

// ── C1: balanced rotation — every vertical column is one canonical department ──
it("C1: CSE/ECE/MECH each own a whole vertical column (no mixing anywhere)", () => {
  const pool = [];
  ["CSE", "ECE", "MECH"].forEach((d, di) => {
    for (let i = 0; i < 3; i++) pool.push({ id: d + "_" + i, regno: "9" + di + "000" + i + "01", name: d + i, dept: d, year: 2, gender: "male" });
  });
  const res = api.placeStudentsInHalls(pool, [hall("lh", 3, [3])], 0, {}, CAT_RULES);
  const cols = verticalColumns(seatsOf(res));
  eq(Object.keys(cols).length, 3, "one vertical column per seat slot");
  Object.keys(cols).forEach((k) => ok(pure(cols[k]), "vertical column " + k + " must be a single canonical dept: " + canonicalOf(cols[k])));
  ok(api.validatePlan(res.plan, CAT_RULES).length === 0, "plan still satisfies the horizontal facing-seat rules");
});

// ── C2: canonical identity — AID S and AIDS share ONE column, AIML stays apart ─
it("C2: AID S and AIDS share one pure column; AIML is its own column", () => {
  const pool = [
    { id: "a1", regno: "950001600001", name: "a1", dept: "AID S", year: 2, gender: "male" },
    { id: "a2", regno: "950001600002", name: "a2", dept: "AID S", year: 2, gender: "male" },
    { id: "a3", regno: "950001600003", name: "a3", dept: "AIDS", year: 2, gender: "male" },
    { id: "a4", regno: "950001600004", name: "a4", dept: "AIDS", year: 2, gender: "male" },
    { id: "m1", regno: "950001600005", name: "m1", dept: "AIML", year: 2, gender: "male" },
    { id: "m2", regno: "950001600006", name: "m2", dept: "AIML", year: 2, gender: "male" },
    { id: "m3", regno: "950001600007", name: "m3", dept: "AIML", year: 2, gender: "male" },
  ];
  const res = api.placeStudentsInHalls(pool, [hall("lh", 3, [3])], 0, {}, CAT_RULES);
  const cols = verticalColumns(seatsOf(res));
  const aidsCols = Object.keys(cols).filter((k) => canonicalOf(cols[k]) === "AIDS");
  const aimlCols = Object.keys(cols).filter((k) => canonicalOf(cols[k]) === "AIML");
  eq(aidsCols.length, 2, "the 4 AIDS-alias students span two AIDS columns");
  eq(aimlCols.length, 1, "AIML owns one clean column");
  Object.keys(cols).forEach((k) => ok(pure(cols[k]), "vertical column " + k + " must be a single canonical dept: " + canonicalOf(cols[k])));
  // The alias spellings are allowed to sit inside one canonical AIDS column.
  ok(aidsCols.some((k) => new Set(cols[k].map((x) => x.dept)).size > 1), "AID S and AIDS cohabit the same canonical column");
});

// ── C3: contiguous strict purity — "AID S - B1.1, AIDS - B1.2" is re-segmented ─
it("C3: two AIDS alias rows are no longer stacked into one mixed column", () => {
  const pool = [
    { id: "a1", regno: "950001600001", name: "a1", dept: "AID S", year: 2, gender: "male" },
    { id: "a2", regno: "950001600002", name: "a2", dept: "AIDS", year: 2, gender: "male" },
    { id: "m1", regno: "950001600003", name: "m1", dept: "MECH", year: 2, gender: "male" },
    { id: "m2", regno: "950001600004", name: "m2", dept: "MECH", year: 2, gender: "male" },
  ];
  const res = api.placeStudentsInHalls(pool, [hall("lh", 2, [3])], 0, {}, CAT_RULES);
  const cols = verticalColumns(seatsOf(res));
  Object.keys(cols).forEach((k) => ok(pure(cols[k]), "vertical column " + k + " must be pure: " + canonicalOf(cols[k])));
});

// ── C4: STRICT tail — a department that runs out mid-column leaves rows EMPTY ─
it("C4: mid-column exhaustion leaves the tail empty (never a different dept)", () => {
  const pool = [
    { id: "c1", regno: "900000000001", name: "c1", dept: "CSE", year: 2, gender: "male" },
    { id: "c2", regno: "900000000002", name: "c2", dept: "CSE", year: 2, gender: "male" },
    { id: "m1", regno: "900000000003", name: "m1", dept: "MECH", year: 2, gender: "male" },
    { id: "m2", regno: "900000000004", name: "m2", dept: "MECH", year: 2, gender: "male" },
    { id: "m3", regno: "900000000005", name: "m3", dept: "MECH", year: 2, gender: "male" },
    { id: "m4", regno: "900000000006", name: "m4", dept: "MECH", year: 2, gender: "male" },
  ];
  // 3-row, 3-column hall. Largest-remaining-demand-first: MECH (4) owns A.slot1
  // completely; remaining MECH 1 < CSE 2, so CSE owns A.slot2 and MECH's last
  // student takes A.slot3. All 6 seat, and every DEPARTMENT-CLOSED column tail
  // stays EMPTY: A.slot2 drops CSE's third row, A.slot3 wastes its rows 2-3.
  const res = api.placeStudentsInHalls(pool, [hall("lh", 3, [3])], 0, {}, CAT_RULES);
  const seats = seatsOf(res);
  eq(seats.length, 6, "all six students are seated honestly");
  const col = verticalColumns(seats)["A.slot1"];
  eq(col.length, 3, "MECH fills A.slot1 completely — the largest remaining demand");
  ok(col.every((x) => x.dept === "MECH"), "A.slot1 is all MECH");
  const col2 = verticalColumns(seats)["A.slot2"];
  eq(col2.length, 2, "CSE fills A.slot2 then runs out — the tail row stays empty (never a different dept)");
  ok(col2.every((x) => x.dept === "CSE"), "A.slot2 is all CSE");
  const col3 = verticalColumns(seats)["A.slot3"];
  eq(col3.length, 1, "the final MECH takes A.slot3's first row");
  ok(col3.every((x) => x.dept === "MECH"), "A.slot3's one seat is MECH");
  eq(res.unplaced.length, 0, "no student is stranded once columns are given to the largest demand first");
  ok(api.validatePlan(res.plan, CAT_RULES).length === 0, "plan validates clean");
});

// ── C5: multi-hall overflow keeps the department cycle AND purity across halls ─
it("C5: department cycle continues across halls without re-mixing a column", () => {
  const pool = [];
  ["CSE", "ECE"].forEach((d, di) => {
    for (let i = 0; i < 6; i++) pool.push({ id: d + "_" + i, regno: "9" + di + "000" + i + "01", name: d + i, dept: d, year: 2, gender: "male" });
  });
  const res = api.placeStudentsInHalls(pool, [hall("h1", 2, [3]), hall("h2", 2, [3])], 0, {}, CAT_RULES);
  eq(seatsOf(res).length, 12, "all twelve students seated across two halls");
  ["h1", "h2"].forEach((hid) => {
    const cols = verticalColumns(Object.values(res.plan[hid] || {}).flatMap((hp) => hp.seats || []));
    Object.keys(cols).forEach((k) => ok(pure(cols[k]), hid + " vertical column " + k + " must be pure: " + canonicalOf(cols[k])));
  });
  ok(api.validatePlan(res.plan, CAT_RULES).length === 0, "plan validates clean across halls");
});

// ── C6: splitGender blocks keep column purity inside each gender's hall ──────
it("C6: split-gender blocks each keep column purity", () => {
  const pool = [
    { id: "mc1", regno: "900000000001", name: "mc1", dept: "CSE", year: 2, gender: "male" },
    { id: "mc2", regno: "900000000002", name: "mc2", dept: "CSE", year: 2, gender: "male" },
    { id: "me1", regno: "900000000003", name: "me1", dept: "ECE", year: 2, gender: "male" },
    { id: "me2", regno: "900000000004", name: "me2", dept: "ECE", year: 2, gender: "male" },
    { id: "fc1", regno: "900000000005", name: "fc1", dept: "CSE", year: 2, gender: "female" },
    { id: "fc2", regno: "900000000006", name: "fc2", dept: "CSE", year: 2, gender: "female" },
    { id: "fe1", regno: "900000000007", name: "fe1", dept: "ECE", year: 2, gender: "female" },
    { id: "fe2", regno: "900000000008", name: "fe2", dept: "ECE", year: 2, gender: "female" },
  ];
  api.generateSmartSeating(
    [{ label: "E", dept: "MIX", year: 1, students: pool, rules: { ...CAT_RULES, splitGender: true } }],
    [hall("mh", 2, [3]), hall("fh", 2, [3])], {});
  const sr = api.__win.__lastSeatingResult;
  // generateSmartSeating RETURNS the plan itself; __lastSeatingResult.plan _is_
  // that same plan object, so it is wrapped for the {plan, unplaced} reader.
  const seats = seatsOf({ plan: sr.plan });
  eq(seats.length, 8, "both genders seated across their own halls");
  const byHall = {};
  seats.forEach((x) => { (byHall[x.hallId] = byHall[x.hallId] || []).push(x); });
  ["mh", "fh"].forEach((hid) => {
    const cols = verticalColumns(byHall[hid] || []);
    Object.keys(cols).forEach((k) => ok(pure(cols[k]), hid + " vertical column " + k + " must be pure: " + canonicalOf(cols[k])));
  });
  ok(api.validatePlan(sr.plan, { ...CAT_RULES, splitGender: true }).length === 0, "split plan validates clean");
});

// ── C7: determinism — the same roster always produces the same seats ─────────
it("C7: column-wise output is deterministic for identical input", () => {
  const pool = [];
  ["CSE", "ECE", "CIVIL"].forEach((d, di) => {
    for (let i = 0; i < 4; i++) pool.push({ id: d + "_" + i, regno: "9" + di + "00" + i + "01", name: d + i, dept: d, year: 2, gender: "male" });
  });
  const one = seatsOf(api.placeStudentsInHalls(pool, [hall("lh", 3, [4])], 0, {}, CAT_RULES));
  const two = seatsOf(api.placeStudentsInHalls(pool, [hall("lh", 3, [4])], 0, {}, CAT_RULES));
  eq(one.map((x) => x.seatLabel + ":" + x.dept), two.map((x) => x.seatLabel + ":" + x.dept), "identical seat-to-dept mapping on both runs");
});

// ── C8: reserved seats are skipped without breaking column purity ────────────
it("C8: another exam's reserved seat is skipped; the column stays pure", () => {
  const pool = [];
  ["CSE", "ECE"].forEach((d, di) => {
    for (let i = 0; i < 3; i++) pool.push({ id: d + "_" + i, regno: "9" + di + "000" + i + "01", name: d + i, dept: d, year: 2, gender: "male" });
  });
  const res = api.placeStudentsInHalls(pool, [hall("lh", 3, [2])], 0, { lh: new Set(["lh-B2S1"]) }, CAT_RULES);
  const seats = seatsOf(res);
  eq(seats.some((x) => x.seatNo === "lh-B2S1"), false, "the reserved seat is never used");
  const cols = verticalColumns(seats);
  Object.keys(cols).forEach((k) => ok(pure(cols[k]), "vertical column " + k + " must be pure: " + canonicalOf(cols[k])));
  ok(api.validatePlan(res.plan, CAT_RULES).length === 0, "plan validates clean");
});

// ── C9: noSameYear alone keeps the legacy interleaved path (gate off) ────────
it("C9: a year-only rule does not re-order departments (gate off)", () => {
  const pool = [
    { id: 1, regno: "900000000001", name: "1", dept: "CSE", year: 2, gender: "male" },
    { id: 2, regno: "900000000002", name: "2", dept: "ECE", year: 4, gender: "male" },
  ];
  const res = api.placeStudentsInHalls(pool, [hall("lh", 1, [2])], 0, {}, YEAR_RULES);
  const seat = seatsOf(res).sort((a, b) => a.slot - b.slot)[0];
  eq(seat.dept, "CSE", "strict regno order preserved (no column grouping)");
});

module.exports = s;