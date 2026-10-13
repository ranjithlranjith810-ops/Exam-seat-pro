// Regression tests for the GLOBAL NOTICE gender-wise display (Boys / Girls /
// Unclassified).
//
// The ONLY gender source is the authoritative student roster, matched by the
// exact register number. A seat is counted as Boys when the roster gender is
// male/"m", Girls when female/"f", and Unclassified otherwise (blank,
// unrecognised, or a register number with no roster row). Gender is NEVER
// inferred from a register number, department, hall name, label or name. Every
// hall/row tally must reconcile: boys + girls + unclassified === the printed
// student count, and the grand totals equal the sum of the halls.
const h = require("./harness.js");
const api = h.load();

const s = h.suite("global_notice_gender.test.js — Boys/Girls/Unclassified on the Global Notice");
const { it, eq, ok } = s;

const FN = "2026-10-14";
const COLLEGE = { name: "Test College", centre_code: "TC01" };

function seat(n, regno, extra) {
  return Object.assign({
    regno: regno, name: "Student " + regno, dept: "CSE",
    seatNo: "h1-B" + n + "S1", seatLabel: "A" + n + ".1",
    colIdx: 0, rowIdx: n - 1, slot: 1, bench: n,
  }, extra || {});
}
function lh1() {
  return { id: "h1", name: "LH-1", hallType: "University", numbenches: 40,
    studentsperbench: 2, capacity: 80, layoutConfig: { columns: [{ seats: 2 }, { seats: 0 }] } };
}
function exam(id, subject) {
  return { id: id, subject: subject, date: FN, session: "FN", seatinggenerated: true };
}
function planOf(seats) {
  return { h1: { hallName: "LH-1", numbenches: 40, studentsperbench: 2,
    layoutConfig: { columns: [{ seats: 2 }, { seats: 0 }] }, seats: seats } };
}
function roster(rows) {
  return rows.map(function (r) {
    return { regno: r[0], gender: r[1], dept: r[2] || "CSE", semester: r[3] || 3, year: r[4] || 2, section: r[5] || "A" };
  });
}

// ── U: the gender-kind normaliser ────────────────────────────────────────────
it("U1: only male/m and female/f are recognised; everything else is unknown", () => {
  ["male", "MALE", "m", " M ", "boy", "Boys"].forEach(function (v) { eq(api.hnGenderKind(v), "male", v); });
  ["female", "FEMALE", "f", " F ", "girl", "Girls"].forEach(function (v) { eq(api.hnGenderKind(v), "female", v); });
  ["", " ", "x", "other", "transgender", null, undefined, "M2", "fm"].forEach(function (v) { eq(api.hnGenderKind(v), "unknown", String(v)); });
});

// ── G: per-hall / per-row tallies ────────────────────────────────────────────
it("G1: Boys/Girls/Unclassified are counted per hall and reconcile with the total", () => {
  const e = exam("e1", "CS3492 - DBMS");
  const seats = [];
  for (let i = 1; i <= 6; i++) seats.push(seat(i, "95302210400" + i));
  const plans = { e1: planOf(seats) };
  const students = roster([
    ["953022104001", "male"], ["953022104002", "male"], ["953022104003", "male"],
    ["953022104004", "female"], ["953022104005", "female"], ["953022104006", ""],
  ]);
  const gn = api.buildGlobalNoticeHalls([e], plans, [lh1()], FN, "FN", COLLEGE, students);
  eq(gn.halls.length, 1);
  const hh = gn.halls[0];
  eq(hh.boys, 3, "three boys");
  eq(hh.girls, 2, "two girls");
  eq(hh.unknown, 1, "one blank gender");
  eq(hh.total, 6);
  eq(hh.boys + hh.girls + hh.unknown, hh.total, "hall tally reconciles");
  eq(gn.boys, 3); eq(gn.girls, 2); eq(gn.unknown, 1); eq(gn.grandTotal, 6);
  eq(gn.boys + gn.girls + gn.unknown, gn.grandTotal, "grand tally reconciles");
});

it("G2: a register number with NO roster row is Unclassified, not Boys/Girls", () => {
  const e = exam("e1", "CS3492 - DBMS");
  const seats = [seat(1, "953022104001"), seat(2, "953022104999")];
  const plans = { e1: planOf(seats) };
  const students = roster([["953022104001", "male"]]);
  const gn = api.buildGlobalNoticeHalls([e], plans, [lh1()], FN, "FN", COLLEGE, students);
  eq(gn.halls[0].boys, 1);
  eq(gn.halls[0].girls, 0);
  eq(gn.halls[0].unknown, 1, "the unknown register number is Unclassified");
  eq(gn.grandTotal, 2);
});

it("G3: per-subject rows carry their own Boys/Girls and sum to the hall total", () => {
  const e = exam("e1", "CS3492 - DBMS");
  const seats = [];
  for (let i = 1; i <= 4; i++) seats.push(seat(i, "95302210400" + i));
  const plans = { e1: planOf(seats) };
  // Two sections → two Dept&Year rows.
  const students = roster([
    ["953022104001", "male", "CSE", 3, 2, "A"],
    ["953022104002", "female", "CSE", 3, 2, "A"],
    ["953022104003", "male", "CSE", 3, 2, "B"],
    ["953022104004", "female", "CSE", 3, 2, "B"],
  ]);
  const gn = api.buildGlobalNoticeHalls([e], plans, [lh1()], FN, "FN", COLLEGE, students);
  const rows = gn.halls[0].subjects;
  eq(rows.length, 2, "two sections are two rows");
  const sumB = rows.reduce(function (a, r) { return a + r.boys; }, 0);
  const sumG = rows.reduce(function (a, r) { return a + r.girls; }, 0);
  const sumU = rows.reduce(function (a, r) { return a + r.unknown; }, 0);
  eq(sumB, 2, "section rows sum to the hall boys");
  eq(sumG, 2, "section rows sum to the hall girls");
  eq(sumU, 0);
  rows.forEach(function (r) { eq(r.boys + r.girls + r.unknown, r.count, "row reconciles: " + r.label); });
});

it("G4: the roster gender is authoritative — dept/hall/label never override it", () => {
  const e = exam("e1", "CS3492 - DBMS");
  // Seat says MECH (a dept that might stereotypically read male); roster says female.
  const seats = [seat(1, "953022104001", { dept: "MECH" })];
  const plans = { e1: planOf(seats) };
  const students = roster([["953022104001", "female", "MECH"]]);
  const gn = api.buildGlobalNoticeHalls([e], plans, [lh1()], FN, "FN", COLLEGE, students);
  eq(gn.halls[0].girls, 1, "the roster feminine gender wins");
  eq(gn.halls[0].boys, 0);
  eq(gn.halls[0].unknown, 0);
});

it("G5: no gender is ever inferred from the student NAME", () => {
  const e = exam("e1", "CS3492 - DBMS");
  const seats = [seat(1, "953022104001", { name: "Aishwarya Priya" }), seat(2, "953022104002", { name: "Arjun Kumar" })];
  const plans = { e1: planOf(seats) };
  // No roster rows at all: the clearly feminine/masculine names must NOT be used.
  const gn = api.buildGlobalNoticeHalls([e], plans, [lh1()], FN, "FN", COLLEGE, []);
  eq(gn.halls[0].boys, 0, "no name-based male inference");
  eq(gn.halls[0].girls, 0, "no name-based female inference");
  eq(gn.halls[0].unknown, 2, "both are Unclassified");
});

it("G6: without any roster every seat is Unclassified and a warning is raised", () => {
  const e = exam("e1", "CS3492 - DBMS");
  const seats = [seat(1, "953022104001"), seat(2, "953022104002")];
  const plans = { e1: planOf(seats) };
  const gn = api.buildGlobalNoticeHalls([e], plans, [lh1()], FN, "FN", COLLEGE, []);
  eq(gn.boys, 0); eq(gn.girls, 0); eq(gn.unknown, 2); eq(gn.grandTotal, 2);
  ok(gn.warnings.some(function (w) { return /Unclassified/i.test(w); }), "an Unclassified warning is announced, never silent");
});

// ── Document rendering ───────────────────────────────────────────────────────
it("G7: the printed notice shows Boys/Girls/Uncl. columns and a gender grand total", () => {
  const e = exam("e1", "CS3492 - DBMS");
  const seats = [seat(1, "953022104001"), seat(2, "953022104002"), seat(3, "953022104003")];
  const plans = { e1: planOf(seats) };
  const students = roster([["953022104001", "male"], ["953022104002", "male"], ["953022104003", "female"]]);
  const doc = api.buildGlobalNoticeDocument({ exams: [e], seatingPlans: plans, halls: [lh1()], date: FN, session: "FN", students: students }, COLLEGE);
  const page = doc.pages[0];
  ok(page.indexOf('<th class="gn-boyc gn-boys">Boys</th>') >= 0, "Boys column header");
  ok(page.indexOf('<th class="gn-girlc gn-girls">Girls</th>') >= 0, "Girls column header");
  ok(page.indexOf('<th class="gn-uncc gn-uncl">Uncl.</th>') >= 0, "Unclassified column header");
  ok(/GRAND TOTAL \(FN\): 3/.test(page), "the student grand total is unchanged");
  ok(/Boys: 2/.test(page) && /Girls: 1/.test(page) && /Unclassified: 0/.test(page), "gender grand-total breakdown");
  eq((page.match(/class="gn-c gn-boys"/g) || []).length, 2, "one boys cell per subject row + hall total");
});

it("G8: the printed notice marks Unclassified seats and never drops them from the total", () => {
  const e = exam("e1", "CS3492 - DBMS");
  const seats = [seat(1, "953022104001"), seat(2, "953022104999")];
  const plans = { e1: planOf(seats) };
  const students = roster([["953022104001", "male"]]);
  const doc = api.buildGlobalNoticeDocument({ exams: [e], seatingPlans: plans, halls: [lh1()], date: FN, session: "FN", students: students }, COLLEGE);
  const page = doc.pages[0];
  ok(/GRAND TOTAL \(FN\): 2/.test(page), "the unclassified seat still counts in the total");
  ok(/Boys: 1/.test(page) && /Unclassified: 1/.test(page), "flagged, not discarded");
});

it("G9: a hall's boys/girls reconcile across a multi-hall, multi-subject notice", () => {
  const e1 = exam("e1", "CS3492 - DBMS");
  const e2 = exam("e2", "CS3501 - Networks");
  const plans = {
    e1: { h1: { hallName: "LH-1", numbenches: 40, studentsperbench: 2, layoutConfig: { columns: [{ seats: 2 }, { seats: 0 }] }, seats: [seat(1, "953022104001"), seat(2, "953022104002")] } },
    e2: { h1: { hallName: "LH-1", numbenches: 40, studentsperbench: 2, layoutConfig: { columns: [{ seats: 2 }, { seats: 0 }] }, seats: [seat(3, "953022104003"), seat(4, "953022104004")] } },
  };
  const students = roster([
    ["953022104001", "male"], ["953022104002", "female"],
    ["953022104003", "female"], ["953022104004", "male"],
  ]);
  const gn = api.buildGlobalNoticeHalls([e1, e2], plans, [lh1()], FN, "FN", COLLEGE, students);
  eq(gn.halls.length, 1, "same hall+session+date is ONE notice group");
  eq(gn.halls[0].total, 4);
  eq(gn.halls[0].boys, 2);
  eq(gn.halls[0].girls, 2);
  eq(gn.halls[0].unknown, 0);
  eq(gn.boys + gn.girls + gn.unknown, gn.grandTotal);
});

// ── Non-regression: the seating data itself is untouched ─────────────────────
it("G10: register numbers and per-row student counts are unchanged by the gender work", () => {
  const e = exam("e1", "CS3492 - DBMS");
  const seats = [seat(1, "953022104001"), seat(2, "953022104002")];
  const plans = { e1: planOf(seats) };
  const students = roster([["953022104001", "male"], ["953022104002", "female"]]);
  const gn = api.buildGlobalNoticeHalls([e], plans, [lh1()], FN, "FN", COLLEGE, students);
  eq(gn.halls[0].subjects[0].count, 2, "student count untouched");
  eq(gn.halls[0].subjects[0].regnos, ["953022104001", "953022104002"], "register numbers untouched and in order");
  eq(gn.halls[0].subjects[0].display, "953022104001, 002", "compact display untouched (same-series run)");
});

module.exports = s;
