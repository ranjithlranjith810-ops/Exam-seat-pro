// Regression tests for the ONE shared heading + academic-year labelling change.
//
// The HALL NOTICE PROFORMA and the GLOBAL NOTICE print the SAME heading, taken
// from ONE resolver (`resolveNoticeHeading`). Precedence: a per-call override,
// then the college's shared `exam_title`, both verbatim; when blank, the heading
// is DERIVED from exam metadata only (category label + date academic year +
// group semesters) — never from a register number, and never hard-coded for a
// specific exam type. Missing/ambiguous metadata falls back to the legacy
// NOV/DEC line with an explicit warning. Every occupied seat also prints its
// academic-year label ("II CSE A"), sourced from the student roster first and
// the exam's own curriculum group second, with year/section never invented.
const h = require("./harness.js");
const api = h.load();

const s = h.suite("notice_title.test.js — one shared heading + academic-year labels for Hall & Global notices");
const { it, eq, ok } = s;

const FN = "2026-10-14";
const EN = "\u2013";
const OFFICIAL = "CAT-II 2026" + EN + "2027 ODD [II, III & IV Year]";
const OFFICIAL_HTML = "CAT-II 2026" + EN + "2027 ODD [II, III &amp; IV Year]";
const COLLEGE = { name: "Test College", centre_code: "TC01" };
const COLLEGE_TITLED = { name: "Test College", centre_code: "TC01", exam_title: OFFICIAL };

function seat(n, regno, extra) {
  return Object.assign({
    regno: regno, name: "Student " + regno, dept: "CSE",
    seatNo: "h1-B" + n + "S1", seatLabel: "A" + n + ".1",
    colIdx: 0, rowIdx: n - 1, slot: 1, bench: n,
  }, extra || {});
}

function lh1() {
  return {
    id: "h1", name: "LH-1", hallType: "University", numbenches: 40,
    studentsperbench: 2, capacity: 80,
    layoutConfig: { columns: [{ seats: 2 }, { seats: 0 }] },
  };
}

function exam(id, subject) {
  return { id: id, subject: subject, date: FN, session: "FN", seatinggenerated: true };
}

function planOf(seats) {
  return { h1: { hallName: "LH-1", numbenches: 40, studentsperbench: 2, layoutConfig: { columns: [{ seats: 2 }, { seats: 0 }] }, seats: seats } };
}

// One CAT exam on one hall, two/few seats, extra fields merged onto the exam.
function hallFixture(eOpts) {
  const e = exam("e1", "CS3492 - DBMS");
  Object.assign(e, eOpts || {});
  const seats = [seat(1, "953022104001"), seat(2, "953022104002")];
  const plans = { e1: planOf(seats) };
  return { exams: [e], plans: plans, halls: [lh1()] };
}

const CAT_GROUPS = [{ dept: "CSE", sem: "03" }, { dept: "CSE", sem: "05" }, { dept: "CSE", sem: "07" }];
const CAT_META = { examCategory: "Continuous Assessment Test-II 2026-27", category: "CAT", groups: CAT_GROUPS };

// ── THE RESOLVER ITSELF ──────────────────────────────────────────────────────
it("U1: the academic year follows the Aug-Jul cycle from the exam date only", () => {
  eq(api.hnAcademicYearOf(FN), "2026" + EN + "2027", "October is in the 2026-27 academic year");
  eq(api.hnAcademicYearOf("2026-03-10"), "2025" + EN + "2026", "March is in the 2025-26 academic year");
  eq(api.hnAcademicYearOf(""), "");
});

it("U2: CAT heading tokens read exactly CAT-II-style and are never hard-coded per exam", () => {
  eq(api.hnNoticeTypeToken({ examCategory: "Continuous Assessment Test-II 2026-27", category: "CAT" }), "CAT-II");
  eq(api.hnNoticeTypeToken({ examCategory: "CAT-2" }), "CAT-II", "a digit 2 maps to II");
  eq(api.hnNoticeTypeToken({ examCategory: "CAT-3", category: "CAT" }), "CAT-III", "CAT-3 is CAT-III, not II");
  eq(api.hnNoticeTypeToken({ examCategory: "CAT II EXAMINATIONS", category: "CAT" }), "CAT-II");
  eq(api.hnNoticeTypeToken({ examCategory: "Test-2", category: "CAT" }), "CAT-II");
  eq(api.hnNoticeTypeToken({ examCategory: "CAT", category: "CAT" }), "CAT");
  eq(api.hnNoticeTypeToken({ examCategory: "UNIVERSITY EXAMINATIONS NOV/DEC 2025", category: "University" }), "UNIVERSITY EXAMINATIONS");
  eq(api.hnNoticeTypeToken({ examCategory: "PRACTICAL EXAMINATIONS", category: "Lab" }), "PRACTICAL EXAMINATIONS");
  eq(api.hnNoticeTypeToken({ examCategory: "some generic session" }), "", "unrecognised reads blank, never CAT");
});

it("U3: precedence override > college title > derived CAT heading > legacy NOV/DEC with a warning", () => {
  const cat = exam("e1", "CS3492 - DBMS");
  Object.assign(cat, CAT_META);
  eq(api.resolveNoticeHeading({ exams: [cat], date: FN, noticeTitle: "OVERRIDE", exam_title: OFFICIAL }).title, "OVERRIDE");
  eq(api.resolveNoticeHeading({ exams: [cat], date: FN, exam_title: OFFICIAL }).title, OFFICIAL, "college title is verbatim");
  const derived = api.resolveNoticeHeading({ exams: [cat], date: FN });
  eq(derived.title, OFFICIAL, "derived heading matches the college's official line");
  eq(derived.warnings.length, 0, "a clean derivation is silent");
  const generic = exam("e2", "CS3501 - Networks");
  const fb = api.resolveNoticeHeading({ exams: [generic], date: FN });
  eq(fb.title, "ANNA UNIVERSITY EXAMINATIONS NOV/DEC 2026");
  ok(fb.warnings.length >= 1, "the fallback is announced, never silent");
});

it("T5: a University/Lab exam with no CAT metadata keeps the classic NOV/DEC line", () => {
  const e = exam("u1", "UVA701 - Univ Exam");
  e.category = "University";
  e.examCategory = "UNIVERSITY EXAMINATIONS NOV/DEC 2025";
  const r = api.resolveNoticeHeading({ exams: [e], date: FN });
  eq(r.title, "ANNA UNIVERSITY EXAMINATIONS NOV/DEC 2026", "university notices are not relabelled as CAT");
  ok(r.warnings.length >= 1, "and the fallback warns");
});

// ── HALL NOTICE ──────────────────────────────────────────────────────────────
it("T1: the Hall Notice prints the college's official exam_title above SEATING ARRANGEMENT", () => {
  const f = hallFixture();
  const doc = api.buildHallNoticesPrintDocument({ exams: f.exams, seatingPlans: f.plans, halls: f.halls, date: FN, session: "FN", hallId: "h1" }, COLLEGE_TITLED);
  eq(doc.pages.length, 1);
  ok(doc.pages[0].indexOf('<div class="pf-univ">' + OFFICIAL_HTML + '</div>') >= 0, "official title on the pf-univ line");
  ok(doc.pages[0].indexOf('<div class="pf-title">SEATING ARRANGEMENT</div>') >= 0, "subheading preserved");
});

it("T2: a per-call noticeTitle override beats both the college title and any derived heading", () => {
  const f = hallFixture(CAT_META);
  const hd = api.buildHallNoticesPrintDocument({ exams: f.exams, seatingPlans: f.plans, halls: f.halls, date: FN, session: "FN", hallId: "h1", noticeTitle: "OFFICIAL OVERRIDE" }, COLLEGE_TITLED);
  ok(hd.pages[0].indexOf('<div class="pf-univ">OFFICIAL OVERRIDE</div>') >= 0, "override wins on the Hall Notice");
  const gd = api.buildGlobalNoticeDocument({ exams: f.exams, seatingPlans: f.plans, halls: f.halls, date: FN, session: "FN", noticeTitle: "OFFICIAL OVERRIDE" }, COLLEGE_TITLED);
  eq(gd.gn.examination, "OFFICIAL OVERRIDE", "same override wins on the Global Notice");
});

it("G1b/H: with no shared title, both documents derive the SAME official CAT heading from exam metadata", () => {
  const f = hallFixture(CAT_META);
  const hd = api.buildHallNoticesPrintDocument({ exams: f.exams, seatingPlans: f.plans, halls: f.halls, date: FN, session: "FN", hallId: "h1" }, COLLEGE);
  const gd = api.buildGlobalNoticeDocument({ exams: f.exams, seatingPlans: f.plans, halls: f.halls, date: FN, session: "FN" }, COLLEGE);
  eq(gd.gn.examination, OFFICIAL);
  const hTitle = (hd.pages[0].match(/<div class="pf-univ">([^<]+)<\/div>/) || [])[1];
  const gTitle = (gd.pages[0].match(/<div class="gn-univ">([^<]+)<\/div>/) || [])[1];
  eq(hTitle, OFFICIAL_HTML, "Hall Notice pf-univ");
  eq(gTitle, OFFICIAL_HTML, "Global Notice gn-univ");
  eq(hTitle, gTitle, "the two documents can never disagree");
});

it("H2: the hall sheet still prints Session FN and Date dd.mm.yyyy", () => {
  const f = hallFixture();
  const page = api.buildHallNoticesPrintDocument({ exams: f.exams, seatingPlans: f.plans, halls: f.halls, date: FN, session: "FN", hallId: "h1" }, COLLEGE).pages[0];
  ok(/Session<\/span><span class="kf-s">\.<\/span><span class="kf-v">FN<\/span>/.test(page), "Session . FN key fact");
  ok(/Date<\/span><span class="kf-s">\.<\/span><span class="kf-v">14\.10\.2026<\/span>/.test(page), "Date . 14.10.2026 key fact");
});

function rosterFixture() {
  const f = hallFixture();
  f.students = [
    { regno: "953022104001", name: "A", semester: 3, year: 2, dept: "CSE", section: "a" },
    { regno: "953022104002", name: "B", semester: 5, year: 3, dept: "CSE", section: "B" },
    { regno: "953022104003", name: "C", semester: 7, year: 4, dept: "CSE", section: "C" },
  ];
  f.plans.e1 = planOf([seat(1, "953022104001"), seat(2, "953022104002"), seat(3, "953022104003")]);
  return f;
}

it("H3/H8: each occupied seat cell prints its academic-year label from the student roster (with section)", () => {
  const f = rosterFixture();
  const doc = api.buildHallNoticesPrintDocument({ exams: f.exams, seatingPlans: f.plans, halls: f.halls, date: FN, session: "FN", hallId: "h1", students: f.students }, COLLEGE);
  const page = doc.pages[0];
  const vals = page.match(/<div class="val">([^<]*)<\/div>/g) || [];
  eq(vals.length, 6, "one regno val + one dept-year val per student");
  ok(page.indexOf('<div class="val">II CSE A</div>') >= 0, "year + canonical dept + section");
  ok(page.indexOf('<div class="val">III CSE B</div>') >= 0, "II I maps from semester 5");
  ok(page.indexOf('<div class="val">IV CSE C</div>') >= 0, "IV maps from semester 7");
});

it("H4: the roster year is authoritative even when a single group would disagree", () => {
  const f = rosterFixture();
  f.exams[0].groups = [{ dept: "CSE", sem: "03" }];
  const page = api.buildHallNoticesPrintDocument({ exams: f.exams, seatingPlans: f.plans, halls: f.halls, date: FN, session: "FN", hallId: "h1", students: f.students }, COLLEGE).pages[0];
  ok(page.indexOf('<div class="val">III CSE B</div>') >= 0, "student 2 stays III from its roster row");
  ok(page.indexOf('<div class="val">IV CSE C</div>') >= 0, "student 3 stays IV from its roster row");
  ok(page.indexOf('<div class="val">II CSE C</div>') < 0, "the group can never relabel a roster student");
});

it("H5: with no roster and no groups, the dept prints alone — no year is guessed", () => {
  const f = hallFixture();
  const page = api.buildHallNoticesPrintDocument({ exams: f.exams, seatingPlans: f.plans, halls: f.halls, date: FN, session: "FN", hallId: "h1" }, COLLEGE).pages[0];
  ok(page.indexOf('<div class="val">CSE</div>') >= 0, "plain dept value when nothing is known");
  ok(page.indexOf('<div class="val">II CSE</div>') < 0, "no invented II year");
});

it("H6: without a roster, the exam group semester supplies the year from the curriculum", () => {
  const f = hallFixture({ groups: [{ dept: "CSE", sem: "05" }] });
  const page = api.buildHallNoticesPrintDocument({ exams: f.exams, seatingPlans: f.plans, halls: f.halls, date: FN, session: "FN", hallId: "h1" }, COLLEGE).pages[0];
  ok(page.indexOf('<div class="val">III CSE</div>') >= 0, "semester 05 is a III Year student");
  ok(page.indexOf('<div class="val">II CSE</div>') < 0, "semester 05 is never called II");
});

it("H7: register numbers, seat labels and TOTAL are untouched by the year labelling", () => {
  const f = rosterFixture();
  const page = api.buildHallNoticesPrintDocument({ exams: f.exams, seatingPlans: f.plans, halls: f.halls, date: FN, session: "FN", hallId: "h1", students: f.students }, COLLEGE).pages[0];
  ok(/TOTAL:<\/strong> 3/.test(page), "TOTAL is still the surviving set");
  ok(page.indexOf("953022104003") >= 0, "saved register number printed unchanged");
  ok(page.indexOf("A3.1") >= 0, "saved seat label printed unchanged");
  eq((page.match(/<div class="cell">/g) || []).length, 3, "still exactly one cell per student");
});

// ── GLOBAL NOTICE ────────────────────────────────────────────────────────────
it("G1: the Global Notice header carries the official title + HALL ALLOCATION + Session + Date", () => {
  const f = hallFixture();
  const doc = api.buildGlobalNoticeDocument({ exams: f.exams, seatingPlans: f.plans, halls: f.halls, date: FN, session: "FN" }, COLLEGE_TITLED);
  eq(doc.gn.examination, OFFICIAL);
  eq(doc.pages.length, 1);
  ok(doc.pages[0].indexOf('<div class="gn-univ">' + OFFICIAL_HTML + '</div>') >= 0, "official title in the header");
  ok(doc.pages[0].indexOf('<div class="gn-doc">HALL ALLOCATION</div>') >= 0, "document line stays HALL ALLOCATION");
  ok(/Session: FN/.test(doc.pages[0]) && /Date: 14\.10\.2026/.test(doc.pages[0]), "session and date printed");
  ok(doc.pages[0].indexOf('<th class="gn-dept">Dept & Year</th>') >= 0, "column header is Dept & Year");
});

it("G2: subject rows label each group by year + canonical dept + section from the roster", () => {
  const e = exam("e1", "CS3492 - DBMS");
  e.groups = [{ dept: "CSE", sem: "03" }, { dept: "AIDS", sem: "05" }, { dept: "ECE", sem: "07" }];
  const students = [
    { regno: "953022104001", semester: 3, year: 2, dept: "CSE", section: "A" },
    { regno: "953022104002", semester: 5, year: 3, dept: "AIDS", section: "B" },
    { regno: "953022104003", semester: 7, year: 4, dept: "ECE", section: "C" },
  ];
  const seats = [
    seat(1, "953022104001", { dept: "CSE" }),
    seat(2, "953022104002", { dept: "AIDS" }),
    seat(3, "953022104003", { dept: "ECE" }),
  ];
  const plans = { e1: planOf(seats) };
  const gn = api.buildGlobalNoticeHalls([e], plans, [lh1()], FN, "FN", COLLEGE, students);
  eq(gn.halls.length, 1);
  eq(gn.halls[0].subjects.map(function (x) { return x.label; }).join(", "), "II CSE A, III AIDS B, IV ECE C");
  eq(gn.halls[0].years.join(","), "II,III,IV");
  eq(gn.grandTotal, 3);
});

it("G3: a subject offered to II and IV is SPLIT into two rows whose counts sum to the hall total", () => {
  const e = exam("e1", "CS3492 - DBMS");
  e.groups = [{ dept: "CSE", sem: "03" }, { dept: "CSE", sem: "07" }];
  const students = [
    { regno: "953022104001", semester: 3, year: 2, dept: "CSE", section: "A" },
    { regno: "953022104002", semester: 3, year: 2, dept: "CSE", section: "A" },
    { regno: "953022104003", semester: 3, year: 2, dept: "CSE", section: "A" },
    { regno: "953022104004", semester: 7, year: 4, dept: "CSE", section: "A" },
    { regno: "953022104005", semester: 7, year: 4, dept: "CSE", section: "A" },
    { regno: "953022104006", semester: 7, year: 4, dept: "CSE", section: "A" },
  ];
  const seats = [];
  for (let i = 1; i <= 6; i++) seats.push(seat(i, "95302210400" + i));
  const plans = { e1: planOf(seats) };
  const gn = api.buildGlobalNoticeHalls([e], plans, [lh1()], FN, "FN", COLLEGE, students);
  eq(gn.halls.length, 1);
  const rows = gn.halls[0].subjects;
  eq(rows.length, 2, "II and IV are separate rows");
  eq(rows[0].label, "II CSE A");
  eq(rows[0].count, 3);
  eq(rows[1].label, "IV CSE A");
  eq(rows[1].count, 3);
  eq(gn.halls[0].total, 6, "the split still sums to the hall total");
  eq(gn.grandTotal, 6);
  const page = api.buildGlobalNoticeDocument({ exams: [e], seatingPlans: plans, halls: [lh1()], date: FN, session: "FN", students: students }, COLLEGE).pages[0];
  ok(page.indexOf('>II CSE A</td>') >= 0 && page.indexOf('>IV CSE A</td>') >= 0, "both labels render in the Global Notice");
  ok(page.indexOf("Years: II &amp; IV") >= 0, "per-hall year summary line");
});

it("G8: without groups and without a roster no year is invented in the Global Notice", () => {
  const f = hallFixture();
  const gn = api.buildGlobalNoticeHalls(f.exams, f.plans, f.halls, FN, "FN", COLLEGE, []);
  ok(gn.halls.length === 1, "one hall");
  ok(gn.halls[0].subjects.every(function (x) { return x.label === "CSE"; }), "labels stay dept-only");
  eq(gn.halls[0].years.length, 0, "no Years summary without an authoritative year");
});

it("G5: every hall appears across the paginated pages — none is lost, totals agree", () => {
  const e = exam("e0", "CS3492 - DBMS");
  const plans = {}; const halls = [];
  for (let i = 1; i <= 12; i++) {
    const hid = "h" + i;
    plans[e.id] = plans[e.id] || {};
    plans[e.id][hid] = { hallName: "LH-" + i, numbenches: 2, studentsperbench: 1, layoutConfig: { columns: [{ seats: 1 }] }, seats: [seat(1, "953022100" + String(i).padStart(3, "0"))] };
    halls.push({ id: hid, name: "LH-" + i, numbenches: 2, studentsperbench: 1, capacity: 2, layoutConfig: { columns: [{ seats: 1 }] } });
  }
  const doc = api.buildGlobalNoticeDocument({ exams: [e], seatingPlans: plans, halls: halls, date: FN, session: "FN" }, COLLEGE);
  eq(doc.gn.halls.length, 12);
  eq(doc.pages.length, 2, "12 one-seat halls need two A4 pages (content-fit)");
  const all = doc.pages.join("");
  for (let i = 1; i <= 12; i++) ok(all.indexOf("LH-" + i) >= 0, "LH-" + i + " is present somewhere");
  ok(/GRAND TOTAL \(FN\): 12/.test(all), "the grand total sums all 12 halls");
  const grand = doc.gn.halls.reduce(function (a, hh) { return a + hh.total; }, 0);
  eq(doc.grandTotal, grand, "document grand total equals the per-hall sum");
});

// Content-fit pagination: no fixed halls-per-page, so nothing is ever clipped.
it("G5b: every hall renders exactly once with its own TOTAL and the header repeats per page", () => {
  const e = exam("e0", "CS3492 - DBMS");
  const plans = {}; const halls = [];
  for (let i = 1; i <= 12; i++) {
    const hid = "h" + i;
    plans[e.id] = plans[e.id] || {};
    plans[e.id][hid] = { hallName: "LH-" + i, numbenches: 2, studentsperbench: 1, layoutConfig: { columns: [{ seats: 1 }] }, seats: [seat(1, "953022100" + String(i).padStart(3, "0"))] };
    halls.push({ id: hid, name: "LH-" + i, numbenches: 2, studentsperbench: 1, capacity: 2, layoutConfig: { columns: [{ seats: 1 }] } });
  }
  const doc = api.buildGlobalNoticeDocument({ exams: [e], seatingPlans: plans, halls: halls, date: FN, session: "FN" }, COLLEGE);
  const all = doc.pages.join("");
  eq((all.match(/class="gn-hall"/g) || []).length, 12, "each hall block rendered exactly once (no clip, no duplicate)");
  eq((all.match(/class="gn-htot"/g) || []).length, 12, "every hall keeps its own TOTAL row");
  for (let i = 1; i <= 12; i++) {
    eq((all.match(new RegExp(">LH-" + i + "<")) || []).length, 1, "LH-" + i + " appears exactly once");
  }
  doc.pages.forEach(function (p, i) { ok(p.indexOf("HALL ALLOCATION") >= 0, "page " + (i + 1) + " repeats the official header"); });
});

module.exports = s;