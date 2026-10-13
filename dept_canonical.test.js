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

// ── D2: CHARACTERIZATION — one displayed label, one canonical department ────
// Column-wise department separation (approved design) identities a department
// by its CANONICAL value, so "AID S" and "AIDS" are now ONE department to the
// allocator: they never share a VERTICAL column as two internally-mixed halves,
// and with equal remaining demand (1 each here) the deterministic tie-break
// seats the alias spellings into consecutive single-seat columns — AID S, AIDS,
// MECH. The allocator's RAW (case-insensitive) string comparison means the two
// spellings may sit ADJACENT to each other; that is deliberate and shared by
// validatePlan, so the plan is clean. Display folds both to the single label
// "AIDS", and each seat keeps the RAW stored value. This test records the
// resulting behaviour so any future change to that identity is caught.
it("D2: AID S and AIDS display as one label AND are one canonical department to the allocator", () => {
  const res = api.placeStudentsInHalls([
    { id: 1, regno: "953021243001", name: "1", dept: "AID S", year: 2, gender: "male" },
    { id: 2, regno: "953021243002", name: "2", dept: "AIDS", year: 2, gender: "male" },
    { id: 3, regno: "953021243003", name: "3", dept: "MECH", year: 2, gender: "male" },
  ], [hall("h1", 1, [3])], 0, {}, CAT_RULES);
  const seats = seatsOf(res).sort((a, b) => a.slot - b.slot);
  eq(seats.length, 3, "all three seated");
  // The allocator keeps the two spellings as distinct raw values on the seats…
  eq(seats[0].dept, "AID S", "raw value kept for the first alias");
  eq(seats[1].dept, "AIDS", "raw value kept for the second alias");
  eq(seats[2].dept, "MECH", "MECH owns the trailing single-seat column");
  // …yet both render as the one department "AIDS".
  eq(api.canonicalDept(seats[0].dept), "AIDS", "first alias displays as AIDS");
  eq(api.canonicalDept(seats[1].dept), "AIDS", "second alias displays as AIDS");
  // Canonical identity: each single-seat column is one canonical department. The
  // alias spellings may be ADJACENT because the engine compares departments
  // case-insensitively on the raw value (deliberate — see index.html's legalFor
  // comment); validatePlan uses the same comparison, so this stays clean.
  eq(api.validatePlan(res.plan, CAT_RULES).length, 0,
    "one canonical dept: the plan is a pure single-student column set with no adjacency violation");
});

// ── M4: the CAT preview/import matcher folds aliases too ─────────────────────
// catGroupStudents is the roster resolver the CAT timetable import and the
// single-exam generate flow share. It must fold both sides through canonicalDept
// like bulkExamStudents, or the AIDS exams (whose section key "AI & DS" is folded
// to "AIDS") match nobody when the roster spells the department "AI & DS"/"AID S".
it("M4: catGroupStudents folds aliases on both sides and keeps AIML distinct", () => {
  const roster = [
    { id: 1, regno: "953021243001", dept: "AI & DS", year: 2, gender: "male" },
    { id: 2, regno: "953021243002", dept: "AID S", year: 3, gender: "male" },
    { id: 3, regno: "953021243003", dept: "AIDS", year: 2, gender: "male" },
    { id: 4, regno: "953021243004", dept: "AIML", year: 2, gender: "male" },
  ];
  eq(api.catGroupStudents({ dept: "AIDS", sem: "03", year: "2" }, roster, null).map((x) => x.id).sort(), [1, 3]);
  eq(api.catGroupStudents({ dept: "AIDS", sem: "05", year: "3" }, roster, null).map((x) => x.id), [2]);
  // A group written with the JSON spelling matches the canonical roster too.
  eq(api.catGroupStudents({ dept: "AI & DS", sem: "03", year: "2" }, [{ id: 9, dept: "AIDS", year: 2 }], null).map((x) => x.id), [9]);
  // A blank/GEN student is never swept into an AIDS exam.
  eq(api.catGroupStudents({ dept: "AIDS", sem: "03", year: "2" }, [{ id: 8, dept: "", year: 2, regno: "x" }], null).length, 0);
});

module.exports = s;
