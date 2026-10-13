// Regression tests for GLOBAL NOTICE subject-row grouping (issue 1).
//
// Each Global Notice row is one subject × academic-year × dept × section group
// of ONE exam paper. The grouping key is exam identity + subject code +
// dept/year/section — NEVER the subject code alone. Two different exam papers
// that happen to carry the same subject code must therefore stay on separate
// rows (each row shows that exam's own code and counts), while all the seats of
// a single exam still collapse into one row. Rows keep the correct year roman
// numeral and the correct per-exam code.
const h = require("./harness.js");
const api = h.load();

const s = h.suite("global_notice_subject_rows.test.js — correct subject code per exam/dept/year");
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
function exam(id, opts) {
  const o = Object.assign({ subject: "CS3492 - DBMS", date: FN, session: "FN", seatinggenerated: true }, opts || {});
  o.id = id;
  return o;
}
function planOf(seats) {
  return { h1: { hallName: "LH-1", numbenches: 40, studentsperbench: 2,
    layoutConfig: { columns: [{ seats: 2 }, { seats: 0 }] }, seats: seats } };
}
function roster(rows) {
  return rows.map(function (r) {
    return { regno: r[0], gender: r[1] || "male", dept: r[2] || "CSE", semester: r[3] || 3, year: r[4] || 2, section: r[5] || "A" };
  });
}
// n consecutive register numbers of one 9-digit series (same prefix).
function regs(prefix, n, from) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(prefix + String((from || 1) + i).padStart(3, "0"));
  return out;
}
// Seats on DISJOINT benches: `start` offsets the bench number so the seats of
// two different exams cannot collide on the same physical seat (the notice
// dedupes by seat key and would otherwise drop whole rows).
function seatsFor(regnos, start) {
  const base = (start == null ? 1 : start);
  return regnos.map(function (r, i) { return seat(base + i, r); });
}
function gn(exams, plans, students) {
  return api.buildGlobalNoticeHalls(exams, plans, [lh1()], FN, "FN", COLLEGE, students || []);
}

// ── SR: exam identity is part of the row key ─────────────────────────────────
it("SR1: two DIFFERENT exam papers with the SAME subject code are never merged into one row", () => {
  const e1 = exam("e1", { subjectCode: "CS3492" });
  const e2 = exam("e2", { subjectCode: "CS3492" });
  const plans = {
    e1: planOf(seatsFor(regs("953022104", 5), 1)),
    e2: planOf(seatsFor(regs("953022105", 3), 101)),
  };
  const students = roster(regs("953022104", 5).concat(regs("953022105", 3)).map(function (r) { return [r, "male", "CSE", 3, 2, "A"]; }));
  const out = gn([e1, e2], plans, students);
  const rows = out.halls[0].subjects;
  eq(out.halls[0].total, 8, "both papers' seats are all counted in one hall");
  eq(rows.length, 2, "same code but a different exam paper => two separate rows");
  eq(rows[0].subject, "CS3492", "row shows the exam's own code");
  eq(rows[1].subject, "CS3492", "row shows the exam's own code");
  const counts = rows.map(function (r) { return r.count; }).sort(function (a, b) { return a - b; });
  eq(counts[0], 3, "paper e2 keeps its own count");
  eq(counts[1], 5, "paper e1 keeps its own count");
  rows.forEach(function (r) { eq(r.label, "II CSE A", "the Dept&Year label reads each row's year/dept/section"); });
});

it("SR2: same code but a different academic year stays a separate row with the correct roman year", () => {
  const e1 = exam("e1", { subjectCode: "CS3492" });
  const e2 = exam("e2", { subjectCode: "CS3492" });
  const plans = {
    e1: planOf(seatsFor(regs("953022104", 3), 1)),   // II year
    e2: planOf(seatsFor(regs("953022105", 4), 101)), // III year
  };
  const students = roster(
    regs("953022104", 3).map(function (r) { return [r, "male", "CSE", 5, 3, "A"]; })
      .concat(regs("953022105", 4).map(function (r) { return [r, "male", "CSE", 3, 2, "A"]; })));
  const rows = gn([e1, e2], plans, students).halls[0].subjects;
  eq(rows.length, 2, "same code, different years => two rows");
  eq(rows[0].label, "II CSE A", "II row sorts before III");
  eq(rows[1].label, "III CSE A", "III row keeps its own year label");
  eq(rows[0].count, 4);
  eq(rows[1].count, 3);
});

it("SR3: every seat of ONE exam still collapses into a single row (no over-splitting)", () => {
  const e1 = exam("e1", { subjectCode: "CS3492" });
  const plans = { e1: planOf(seatsFor(regs("953022104", 10))) };
  const students = roster(regs("953022104", 10).map(function (r) { return [r, "male", "CSE", 3, 2, "A"]; }));
  const rows = gn([e1], plans, students).halls[0].subjects;
  eq(rows.length, 1, "one exam paper => one row");
  eq(rows[0].count, 10, "all ten seats in that one row");
  eq(rows[0].subject, "CS3492");
});

it("SR4: each row uses EACH exam's own subject code (subjectCode or subject prefix)", () => {
  const e1 = exam("e1", { subjectCode: "CS3492" });

  // No subjectCode: resolves from the subject " code - title " prefix.
  const e2 = { id: "e2", subject: "CS3501 - Computer Networks", date: FN, session: "FN", seatinggenerated: true };

  const e3 = exam("e3", { subjectCode: "EE3401" });
  const plans = {
    e1: planOf(seatsFor(regs("953022104", 2), 1)),
    e2: planOf(seatsFor(regs("953022105", 2), 101)),
    e3: planOf(seatsFor(regs("953022106", 2), 201)),
  };
  const allRegs = regs("953022104", 2).concat(regs("953022105", 2)).concat(regs("953022106", 2));
  const students = roster(allRegs.map(function (r) { return [r, "male", "CSE", 3, 2, "A"]; }));
  const rows = gn([e1, e2, e3], plans, students).halls[0].subjects;
  const codes = rows.map(function (r) { return r.subject; });
  eq(rows.length, 3, "three papers => three rows");
  ok(codes.indexOf("CS3492") >= 0, "paper e1 prints CS3492");
  ok(codes.indexOf("CS3501") >= 0, "paper e2 prints its subject-prefix code CS3501");
  ok(codes.indexOf("EE3401") >= 0, "paper e3 prints EE3401");
});

it("SR5: the printed document shows same-code rows side by side and keeps the correct hall total", () => {
  const e1 = exam("e1", { subjectCode: "MA25C08" });
  const e2 = exam("e2", { subjectCode: "MA25C08" });
  const plans = {
    e1: planOf(seatsFor(regs("953022104", 3), 1)),
    e2: planOf(seatsFor(regs("953022105", 4), 101)),
  };
  const students = roster(
    regs("953022104", 3).map(function (r) { return [r, "male", "CSE", 3, 2, "A"]; })
      .concat(regs("953022105", 4).map(function (r) { return [r, "female", "CSE", 3, 2, "A"]; })));
  const doc = api.buildGlobalNoticeDocument({ exams: [e1, e2], seatingPlans: plans, halls: [lh1()], date: FN, session: "FN", students: students }, COLLEGE);
  const page = doc.pages[0];
  const cells = (page.match(/>MA25C08</g) || []).length;
  eq(cells, 2, "both rows print the same code, once per row");
  eq((page.match(/class="gn-c gn-boys">/g) || []).length, 3, "Boys cell per row + hall total row");
  eq(doc.gn.halls[0].total, 7, "hall total still counts all 7 regnos");
  ok(/GRAND TOTAL \(FN\): 7/.test(page), "grand total is unchanged");
  ok(/Boys: 3/.test(page) && /Girls: 4/.test(page), "gender tallies reconcile");
});

module.exports = s;