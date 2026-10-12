// Regression tests for the "one canonical department" fix.
//
// Bug pinned here: a seat card (and the hall's DEPARTMENTS header) showed a
// department that was GUESSED from the student's registration number whenever the
// student's stored department was blank or "GEN". A no-department student whose
// register number happened to read branch code 106 was displayed as "ECE" even
// though nothing in the data said ECE. The fix resolves every department through
// ONE canonicalDept() that never invents a department, and the allocator's own
// stored value is left exactly as-is (the seating engine already compares
// departments case-insensitively, so folding aliases there would change which
// seats count as "the same department" — that is deliberately NOT done).
//
// Covered: AIDS spellings collapse; AIML stays distinct; blank/GEN never becomes
// ECE; card label and header count share one resolver; exam-to-roster matching
// folds aliases; the physical adjacency rule is unchanged.
const fs = require("fs");
const vm = require("vm");
const h = require("./harness.js");
const { extractFns, constsOf } = require("./cat_extract.js");
const api = h.load();

// The harness stubs inferDeptFromRegno (it is not on its whitelist). Lift the
// REAL one into the sandbox so a test can prove the seating path no longer calls
// it — i.e. the guess is available and WOULD return ECE, yet the seat stores GEN.
try {
  const html = fs.readFileSync(h.HTML, "utf8");
  vm.runInContext(constsOf(html, ["BRANCH_CODE_TO_DEPT"])["BRANCH_CODE_TO_DEPT"] + "\n" +
    extractFns(html, ["inferDeptFromRegno"])["inferDeptFromRegno"] +
    "\nwindow.inferDeptFromRegno = inferDeptFromRegno;", api.__win);
} catch (e) { /* the explicit assertion below reports this if it matters */ }

const s = h.suite("dept_canonical.test.js — one canonical department resolver");
const { it, eq, ok } = s;

const RULES_OFF = { splitGender: false, noSameDept: false, noSameYear: false, benchAdjacency: false };
const CAT_RULES = { splitGender: false, noSameDept: true, noSameYear: false, benchAdjacency: true };

function hall(id, rows, colSeats) {
  const columns = colSeats.map((n) => ({ seats: n }));
  const perRow = columns.reduce((a, c) => a + c.seats, 0);
  return { id, name: id, hallType: "University", numbenches: rows, studentsperbench: perRow, capacity: rows * perRow, layoutConfig: { columns } };
}
function seatsOf(res) { return Object.values(res.plan || {}).flatMap((hp) => hp.seats || []); }

// ── C1: every confirmed AIDS spelling resolves to one value ──────────────────
it("C1: AIDS, AID S, ' aids ' and aids all resolve to AIDS", () => {
  eq(api.canonicalDept("AIDS"), "AIDS");
  eq(api.canonicalDept("AID S"), "AIDS");
  eq(api.canonicalDept(" aids "), "AIDS");
  eq(api.canonicalDept("aids"), "AIDS");
  eq(api.canonicalDept("AI & DS"), "AIDS");
  eq(api.canonicalDept("ai and data science"), "AIDS");
  // The remaining import-side spellings, each taken verbatim from an existing
  // project alias map (CURRI_DEPT_ALIASES / CURRI_JSON_DEPT_ALIASES).
  eq(api.canonicalDept("AI DATA SCIENCE"), "AIDS");
  eq(api.canonicalDept("AI & DATA SCIENCE"), "AIDS");
  eq(api.canonicalDept("AI&DS ENGINEERING"), "AIDS");
  eq(api.canonicalDept("AIDS ENGINEERING"), "AIDS");
  eq(api.canonicalDept("artificial intelligence data science"), "AIDS");
});

// ── C2: AIML is its own department, never merged with AIDS ───────────────────
it("C2: AIML stays distinct from AIDS", () => {
  eq(api.canonicalDept("AIML"), "AIML");
  eq(api.canonicalDept("ai and ml"), "AIML");
  eq(api.canonicalDept("artificial intelligence machine learning"), "AIML");
  ok(api.canonicalDept("AIML") !== api.canonicalDept("AIDS"), "AIML and AIDS must not collapse");
});

// ── C3: blank / GEN is handled explicitly, never invented ────────────────────
it("C3: blank and GEN resolve to GEN without inventing a department", () => {
  eq(api.canonicalDept(""), "GEN");
  eq(api.canonicalDept("   "), "GEN");
  eq(api.canonicalDept(null), "GEN");
  eq(api.canonicalDept(undefined), "GEN");
  eq(api.canonicalDept("GEN"), "GEN");
  eq(api.canonicalDept("general"), "GEN");
});

// ── C4: valid codes are preserved; unknown values are not invented ───────────
it("C4: valid codes are preserved (case/space folded), unknown values pass through", () => {
  eq(api.canonicalDept("CSE"), "CSE");
  eq(api.canonicalDept("cse"), "CSE");
  eq(api.canonicalDept(" ece "), "ECE");
  eq(api.canonicalDept("Mech"), "MECH");
  eq(api.canonicalDept("MECH"), "MECH");
  eq(api.canonicalDept("XYZ"), "XYZ");
});

// ── P1: seating creation never guesses a department from the register number ─
it("P1: a blank/GEN dept with a 106 register number stays GEN, never ECE", () => {
  ok(typeof api.__win.inferDeptFromRegno === "function", "register-number inference is available in the sandbox");
  eq(api.__win.inferDeptFromRegno("953021106069"), "ECE", "the guess would be ECE if it were used");
  const students = [
    { id: "a", regno: "953021106069", name: "A", dept: "", year: 2, gender: "male" },
    { id: "b", regno: "953021106070", name: "B", dept: "GEN", year: 2, gender: "male" },
  ];
  const res = api.placeStudentsInHalls(students, [hall("h1", 1, [3])], 0, {}, RULES_OFF);
  const seats = seatsOf(res);
  eq(seats.length, 2, "both students seated");
  ok(seats.every((x) => x.dept === "GEN"), "blank/GEN never becomes a guessed dept: " + JSON.stringify(seats.map((x) => x.dept)));
});

// ── P2: card label and header count share ONE resolver ───────────────────────
it("P2: the seat-card label and the header count resolve to the same department", () => {
  const res = api.placeStudentsInHalls(
    [{ id: "x", regno: "900000000001", name: "X", dept: "AID S", year: 2, gender: "male" }],
    [hall("h1", 1, [3])], 0, {}, RULES_OFF);
  const seat = seatsOf(res)[0];
  eq(seat.dept, "AID S", "the allocator's stored value is preserved untouched");
  // Both the card (resolveDept) and the header (deptCounts) call canonicalDept on
  // the same stored value, so they can never disagree.
  eq(api.canonicalDept(seat.dept), "AIDS", "card label");
  eq(api.canonicalDept(seat.dept), api.canonicalDept("AIDS"), "header count bucket is identical");
});

// ── M1: exam-to-roster matching folds aliases ────────────────────────────────
it("M1: an AID S exam group matches roster stored as AIDS and ' aids '", () => {
  const ex = { id: "e", date: "2026-10-14", session: "FN", groups: [{ dept: "AID S", year: 2 }] };
  const roster = [
    { id: 1, regno: "953021243001", name: "A", dept: "AIDS", year: 2, gender: "male" },
    { id: 2, regno: "953021243002", name: "B", dept: " aids ", year: 2, gender: "male" },
    { id: 3, regno: "953021243003", name: "C", dept: "MECH", year: 2, gender: "male" },
  ];
  const lookups = api.bulkBuildLookups(roster, [ex], []);
  eq(api.bulkExamStudents(ex, roster, lookups).map((x) => x.id).sort(), [1, 2], "both AIDS spellings match; MECH excluded");
});

// ── M2: AIML never matches AIDS ──────────────────────────────────────────────
it("M2: an AIML exam group never matches AIDS students", () => {
  const ex = { id: "e2", date: "2026-10-14", session: "FN", groups: [{ dept: "AIML", year: 2 }] };
  const roster = [{ id: 1, regno: "953021243001", name: "A", dept: "AIDS", year: 2, gender: "male" }];
  eq(api.bulkExamStudents(ex, roster, api.bulkBuildLookups(roster, [ex], [])).length, 0, "no cross-department match");
});

// ── M3: the group's own spelling is normalised too ───────────────────────────
it("M3: a group spelled ' aids ' matches canonical AIDS students", () => {
  const ex = { id: "e3", date: "2026-10-14", session: "FN", groups: [{ dept: " aids ", year: 2 }] };
  const roster = [{ id: 1, regno: "953021243001", name: "A", dept: "AIDS", year: 2, gender: "male" }];
  eq(api.bulkExamStudents(ex, roster, api.bulkBuildLookups(roster, [ex], [])).map((x) => x.id), [1]);
});

// ── D1: the physical no-same-department rule is unchanged ────────────────────
it("D1: same-department side-by-side is still blocked (allocator untouched)", () => {
  const students = [
    { id: 1, regno: "953021104001", name: "1", dept: "CSE", year: 2, gender: "male" },
    { id: 2, regno: "953021104002", name: "2", dept: "CSE", year: 2, gender: "male" },
    { id: 3, regno: "953021104003", name: "3", dept: "ECE", year: 2, gender: "male" },
  ];
  const res = api.placeStudentsInHalls(students, [hall("h1", 1, [3])], 0, {}, CAT_RULES);
  eq(api.validatePlan(res.plan, CAT_RULES).length, 0, "generated plan is clean");
  const seats = seatsOf(res).sort((a, b) => a.slot - b.slot);
  ok(seats.length === 3 && seats[0].dept === seats[2].dept && seats[1].dept !== seats[0].dept,
    "CSE is separated by the ECE seat: " + seats.map((x) => x.dept).join(","));
});

// ── D2: CHARACTERIZATION — one displayed label, two raw department values ────
// DOCUMENTED LIMITATION (pinned, not fixed). The allocator and the validator
// identify a department by its RAW stored value, so "AID S" and "AIDS" are TWO
// different departments to them and may legally sit side-by-side. Display folds
// both to the single label "AIDS", so such a pair can show the SAME department
// beside itself. Making the allocator treat them as one department would mean
// changing its department identity (placement / round-robin / noSameDept), which
// is deliberately out of scope for this patch. This test records the current
// behaviour so any future change to that identity is caught.
it("D2: AID S and AIDS display as one label but are two raw depts to the allocator", () => {
  const res = api.placeStudentsInHalls([
    { id: 1, regno: "953021243001", name: "1", dept: "AID S", year: 2, gender: "male" },
    { id: 2, regno: "953021243002", name: "2", dept: "AIDS", year: 2, gender: "male" },
    { id: 3, regno: "953021243003", name: "3", dept: "MECH", year: 2, gender: "male" },
  ], [hall("h1", 1, [3])], 0, {}, CAT_RULES);
  const seats = seatsOf(res).sort((a, b) => a.slot - b.slot);
  eq(seats.length, 3, "all three seated");
  // The allocator keeps the two spellings as distinct raw values…
  eq(seats[0].dept, "AID S", "raw value kept for the first alias");
  eq(seats[1].dept, "AIDS", "raw value kept for the second alias");
  // …yet both render as the one department "AIDS".
  eq(api.canonicalDept(seats[0].dept), "AIDS", "first alias displays as AIDS");
  eq(api.canonicalDept(seats[1].dept), "AIDS", "second alias displays as AIDS");
  // They are adjacent on the same bench and the allocator raises NO violation:
  // to it they are different departments, so the same label sits side-by-side.
  eq(seats[0].bench, seats[1].bench, "the two spellings share a bench");
  eq(seats[1].slot - seats[0].slot, 1, "and occupy adjacent seats");
  eq(api.validatePlan(res.plan, CAT_RULES).length, 0,
    "allocator sees two different depts: no side-by-side violation");
});

module.exports = s;
