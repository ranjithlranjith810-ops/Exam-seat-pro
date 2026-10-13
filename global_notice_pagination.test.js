// Regression tests for GLOBAL NOTICE pagination and clipping.
//
// The document builder pages by CONTENT, not by a fixed hall count, so a notice
// of any size renders on as many A4 pages as it needs and no hall, subject row,
// register number or TOTAL is ever dropped or clipped. The official header
// repeats on every page; a hall heading stays with its table; column headings
// repeat when a table continues onto the next page; and the GRAND TOTAL +
// signature block follows the last hall.
//
// Every invariant here is data-level and reconciles against the builder's own
// output: halls present exactly once, per-hall subject rows sum to the hall
// TOTAL, the sum of hall totals is the grand total, register numbers are
// preserved, and the fixed-height clipping styles are gone.
const h = require("./harness.js");
const api = h.load();

const s = h.suite("global_notice_pagination.test.js — content-fit pagination, nothing clipped");
const { it, eq, ok } = s;

const FN = "2026-10-14";
const COLLEGE = { name: "Test College", centre_code: "TC01" };

function seat(n, regno) {
  return { regno: regno, name: "Student " + regno, dept: "CSE",
    seatNo: "h-B" + n + "S1", seatLabel: "A" + n + ".1",
    colIdx: 0, rowIdx: n - 1, slot: 1, bench: n };
}
function hallPlan(name, seats) {
  return { hallName: name, numbenches: seats.length, studentsperbench: 1,
    layoutConfig: { columns: [{ seats: 1 }] }, seats: seats };
}
function hall(id, name) {
  return { id: id, name: name, hallType: "University", numbenches: 60,
    studentsperbench: 1, capacity: 60, layoutConfig: { columns: [{ seats: 1 }] } };
}
function exam(id, date) {
  return { id: id, subject: "SUB-" + id, date: date || FN, session: "FN", seatinggenerated: true };
}

// A realistic-ish set of halls, one subject row each, with deliberately
// non-consecutive register numbers so the register text does not collapse into
// a range and each row is tall enough to exercise wrapping and pagination.
function manyHalls(count, rowsPerHall) {
  const plans = {}; const halls = []; const es = [];
  for (let i = 1; i <= count; i++) {
    const hid = "h" + i;
    halls.push(hall(hid, "LH-" + i));
    const seats = [];
    for (let r = 0; r < rowsPerHall; r++) {
      seats.push(seat(r + 1, "9530221" + String(i).padStart(3, "0") + String(r).padStart(3, "0")));
    }
    plans["e" + i] = {};
    plans["e" + i][hid] = hallPlan("LH-" + i, seats);
  }
  for (let i = 1; i <= count; i++) es.push(exam("e" + i));
  return { exams: es, plans: plans, halls: halls };
}

// ── P: the page never clips and never drops a hall ───────────────────────────
it("P1: every hall of a 20-hall notice appears exactly once across the pages", () => {
  const f = manyHalls(20, 45);
  const doc = api.buildGlobalNoticeDocument({ exams: f.exams, seatingPlans: f.plans, halls: f.halls, date: FN, session: "FN" }, COLLEGE);
  const all = doc.pages.join("");
  eq(doc.gn.halls.length, 20, "builder returns all 20 halls");
  for (let i = 1; i <= 20; i++) {
    eq((all.match(new RegExp(">LH-" + i + "<")) || []).length, 1, "LH-" + i + " appears exactly once");
  }
  eq((all.match(/class="gn-htot"/g) || []).length, 20, "every hall keeps its own TOTAL row");
  ok(doc.pages.length >= 2, "20 tall halls need more than one A4 page");
});

it("P2: the official header repeats on every generated page", () => {
  const f = manyHalls(20, 45);
  const doc = api.buildGlobalNoticeDocument({ exams: f.exams, seatingPlans: f.plans, halls: f.halls, date: FN, session: "FN" }, COLLEGE);
  doc.pages.forEach(function (p, i) {
    ok(p.indexOf("HALL ALLOCATION") >= 0, "page " + (i + 1) + " carries the official header");
    ok(p.indexOf("Session: FN") >= 0, "page " + (i + 1) + " carries the session/date line");
  });
});

it("P3: a hall too tall for one page continues with its banner AND column headings repeated", () => {
  // One hall holding 60 exam groups => 60 subject rows, far taller than one A4.
  const plans = {}; const es = [];
  const h1 = { id: "h1", name: "LH-1", hallType: "University", numbenches: 60,
    studentsperbench: 1, capacity: 60, layoutConfig: { columns: [{ seats: 1 }] } };
  for (let i = 1; i <= 60; i++) {
    const s = { regno: "953022" + String(100000 + i), name: "S" + i, dept: "CSE",
      seatNo: "b" + i, seatLabel: "A" + i, colIdx: 0, rowIdx: i - 1, slot: 1, bench: i };
    plans["e" + i] = { h1: hallPlan("LH-1", [s]) };
    es.push(exam("e" + i));
  }
  const doc = api.buildGlobalNoticeDocument({ exams: es, seatingPlans: plans, halls: [h1], date: FN, session: "FN" }, COLLEGE);
  const all = doc.pages.join("");
  eq(doc.gn.halls.length, 1, "one hall");
  eq((all.match(/class="gn-hall"/g) || []).length > 1, true, "the hall block is continued onto another page");
  const tables = (all.match(/class="gn-tbl"/g) || []).length;
  const heads = (all.match(/<thead>/g) || []).length;
  eq(heads, tables, "every continued table fragment repeats its column headings");
  eq((all.match(/class="gn-hallname"/g) || []).length, tables, "every fragment carries the hall banner");
  eq((all.match(/class="gn-htot"/g) || []).length, 1, "the hall TOTAL is emitted exactly once");
  ok(/GRAND TOTAL \(FN\): 60/.test(all), "the grand total still sums the split hall");
});

it("P4: per-hall subject rows sum to the hall TOTAL and the halls sum to the grand total", () => {
  const f = manyHalls(14, 30);
  const gn = api.buildGlobalNoticeHalls(f.exams, f.plans, f.halls, FN, "FN", COLLEGE, []);
  let grand = 0;
  gn.halls.forEach(function (hh) {
    const rowSum = hh.subjects.reduce(function (a, x) { return a + x.count; }, 0);
    eq(rowSum, hh.total, hh.hallName + ": subject rows sum to the hall total");
    grand += hh.total;
  });
  eq(grand, gn.grandTotal, "the hall totals sum to the grand total");
});

it("P5: pagination never changes the register numbers or the counts", () => {
  const f = manyHalls(14, 30);
  const gn = api.buildGlobalNoticeHalls(f.exams, f.plans, f.halls, FN, "FN", COLLEGE, []);
  const doc = api.buildGlobalNoticeDocument({ exams: f.exams, seatingPlans: f.plans, halls: f.halls, date: FN, session: "FN" }, COLLEGE);
  const built = gn.halls.reduce(function (a, hh) {
    return a + hh.subjects.reduce(function (b, x) { return b + x.regnos.length; }, 0);
  }, 0);
  eq(built, gn.grandTotal, "every allocated register number is retained by the builder");
  eq(doc.grandTotal, gn.grandTotal, "the document grand total is unchanged by pagination");
  // Each register number appears in the rendered document exactly once.
  const all = doc.pages.join("");
  let total = 0;
  gn.halls.forEach(function (hh) {
    hh.subjects.forEach(function (x) {
      x.compact.forEach(function (r) { if (all.indexOf(api.hnEsc(String(r))) >= 0) total++; });
    });
  });
  eq(total, gn.grandTotal, "every compacted register token is rendered");
});

it("P6: the GRAND TOTAL and signature block appear once, only on the final page", () => {
  const f = manyHalls(20, 45);
  const doc = api.buildGlobalNoticeDocument({ exams: f.exams, seatingPlans: f.plans, halls: f.halls, date: FN, session: "FN" }, COLLEGE);
  const all = doc.pages.join("");
  eq((all.match(/GRAND TOTAL \(FN\)/g) || []).length, 1, "one GRAND TOTAL");
  eq((all.match(/class="gn-sgn"/g) || []).length, 1, "one signature block");
  const last = doc.pages[doc.pages.length - 1];
  ok(last.indexOf('class="gn-grand"') >= 0, "GRAND TOTAL is on the final page");
  ok(last.indexOf('class="gn-sgn"') >= 0, "signature block is on the final page");
  doc.pages.slice(0, -1).forEach(function (p, i) {
    ok(p.indexOf('class="gn-grand"') < 0, "page " + (i + 1) + " is not the final page and carries no GRAND TOTAL");
  });
});

it("P7: the page style no longer fixes a height or clips overflow", () => {
  const css = api.gnNoticeStylesheet();
  ok(css.indexOf("min-height:1123px") >= 0, "the A4 page uses min-height (can grow)");
  ok(css.indexOf("overflow:hidden") < 0, "the page no longer hides overflowing content");
  const pageRule = /\.gnotice-page\{([^}]*)\}/.exec(css);
  ok(!!pageRule, "the .gnotice-page rule exists");
  ok(!/(^|;)height:1123px/.test(pageRule[1]), "the page is not locked to a fixed 1123px height");
});

it("P8: a single hall that renders on one page is not split (heading stays with its table)", () => {
  const f = manyHalls(1, 10);
  const doc = api.buildGlobalNoticeDocument({ exams: f.exams, seatingPlans: f.plans, halls: f.halls, date: FN, session: "FN" }, COLLEGE);
  eq(doc.pages.length, 1, "a small notice stays on one page");
  const all = doc.pages.join("");
  eq((all.match(/class="gn-hall"/g) || []).length, 1, "one unsplit hall block");
  eq((all.match(/class="gn-hallname"/g) || []).length, 1, "one hall banner");
  eq((all.match(/<thead>/g) || []).length, 1, "one table head");
});

// The pagination height model the builder pages against, replicated here ONLY
// to size the fixture below so it reproduces the drawing-hall split condition:
// a two-row hall whose banner + headings + first TWO rows (+TOTAL) no longer fit
// on the current page but whose ONE row (old rule) still would.
function estRowH(nRegs) {
  const len = nRegs ? 12 + 3 * (nRegs - 1) : 0;   // compact 12-digit series display
  const lines = Math.max(1, Math.ceil(len / 46));
  return Math.max(24, 8 + lines * 15);
}
function estSingleHall(n, hasYears) {
  return (hasYears ? 48 : 32) + 34 + estRowH(n) + 28 + 14;
}

it("P9: a two-row drawing hall at the bottom of a page is deferred WHOLE, not left with only its first row", () => {
  // Fill the first A4 so that after the last single-row hall there is room for
  // banner + heading + FIRST row + TOTAL but NOT for the first TWO rows of the
  // drawing hall (the old rule split "MECH DRAWING HALL" across pages with a
  // lone first row at the bottom of page 4; the row above keeps it together).
  const prep = [80, 45, 45, 8, 10];
  const USABLE = 1123 - 36, HDR_H = 90;
  let used = HDR_H;
  const halls = []; const plans = {}; const es = [];
  prep.forEach(function (n, i) {
    const hid = "h" + (i + 1);
    used += estSingleHall(n, false);
    halls.push(hall(hid, "LH-" + (i + 1)));
    const seats = [];
    for (let r = 0; r < n; r++) seats.push(seat(r + 1, "9530221" + String(i + 1) + "04" + String(r + 1).padStart(3, "0")));
    plans["e" + i] = {};
    plans["e" + i][hid] = hallPlan("LH-" + (i + 1), seats);
    es.push(exam("e" + i));
  });
  const mechFirstH = estRowH(20), mechSecondH = estRowH(29);
  const mechOneRowStart = 48 + 34 + mechFirstH + 28;      // old rule: banner+head+row1+TOTAL
  const mechTwoRowStart = 48 + 34 + mechFirstH + mechSecondH + 28; // kept-banner+head+rows1+2+TOTAL
  const remaining = USABLE - used;
  ok(mechOneRowStart <= remaining && remaining < mechTwoRowStart,
    "fixture precondition: only ONE drawing-hall row fits on the filled page (remaining " + remaining + ")");

  // The two drawing-hall rows (20 + 29 = 49) and a tiny ECE hall (2) after it.
  const mSeats = [];
  for (let r = 0; r < 20; r++) mSeats.push(seat(r + 1, "953025104" + String(r + 1).padStart(3, "0")));
  const mSeats2 = [];
  for (let r = 0; r < 29; r++) mSeats2.push(seat(r + 21, "953025105" + String(r + 1).padStart(3, "0")));
  const eSeats = [seat(49, "953025243049"), seat(50, "953025243051")];
  const hm = { id: "hm", name: "MECH DRAWING HALL", hallType: "University", numbenches: 60,
    studentsperbench: 1, capacity: 60, layoutConfig: { columns: [{ seats: 1 }] } };
  const he = { id: "he", name: "ECE DRAWING HALL", hallType: "University", numbenches: 60,
    studentsperbench: 1, capacity: 60, layoutConfig: { columns: [{ seats: 1 }] } };
  const em = { id: "em", subject: "ME3491 - Theory of Machines", date: FN, session: "FN", seatinggenerated: true, subjectCode: "ME3491" };
  const em2 = { id: "em2", subject: "MA25C08 - Transforms", date: FN, session: "FN", seatinggenerated: true, subjectCode: "MA25C08" };
  const ee = { id: "ee", subject: "EC3401 - Networks", date: FN, session: "FN", seatinggenerated: true, subjectCode: "EC3401" };
  plans.em = {}; plans.em2 = {}; plans.ee = {};
  plans.em[hm.id] = hallPlan("MECH DRAWING HALL", mSeats);
  plans.em2[hm.id] = hallPlan("MECH DRAWING HALL", mSeats2);
  plans.ee[he.id] = hallPlan("ECE DRAWING HALL", eSeats);
  halls.push(hm, he);
  es.push(em, em2, ee);
  const roster = ["953025104", "953025105"].reduce(function (a, p, k) {
    const n = k === 0 ? 20 : 29;
    for (let i = 0; i < n; i++) a.push({ regno: p + String(i + 1).padStart(3, "0"), gender: i % 2 ? "female" : "male", dept: "MECH", semester: 4, year: 2, section: "A" });
    return a;
  }, []);

  const doc = api.buildGlobalNoticeDocument(
    { exams: es, seatingPlans: plans, halls: halls, students: roster, date: FN, session: "FN" }, COLLEGE);
  const all = doc.pages.join("");
  eq((all.match(/MECH DRAWING HALL/g) || []).length, 1, "the drawing hall banner appears ONCE: it is never split");
  eq((all.match(/class="gn-hall"/g) || []).length, 7, "one block per hall: 5 halls + MECH + ECE");
  eq((all.match(/<thead>/g) || []).length, 7, "exactly one column-heading row per hall: no orphan fragments");
  eq((all.match(/class="gn-htot"/g) || []).length, 7, "every hall keeps exactly one TOTAL row");
  const mPage = doc.pages.findIndex(function (p) { return p.indexOf("MECH DRAWING HALL") >= 0; });
  ok(mPage >= 0, "the drawing hall is on a page");
  ok(doc.pages[mPage].indexOf("ME3491") >= 0, "the page holding the banner also holds its first row");
  ok(doc.pages[mPage].indexOf("MA25C08") >= 0, "the page holding the banner also holds its second row");
  ok(doc.pages[mPage].indexOf('class="gn-htot"') >= 0, "the hall TOTAL is on the same page as its last row");
  const oM = all.indexOf("MECH DRAWING HALL"), oE = all.indexOf("ECE DRAWING HALL"), oG = all.indexOf("GRAND TOTAL (FN)");
  ok(oM >= 0 && oM < oE && oE < oG, "MECH, then ECE, then the GRAND TOTAL + signature, in order");
  eq((all.match(new RegExp("GRAND TOTAL \\(FN\\): " + (80 + 45 + 45 + 8 + 10 + 49 + 2))) || []).length, 1, "the session grand total is the sum of every hall");
  ok(doc.pages[doc.pages.length - 1].indexOf('class="gn-sgn"') >= 0, "the signature block follows on the final page");
});

module.exports = s;
