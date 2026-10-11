// Regression tests for the count-consistency contract of the HALL NOTICE path.
//
// Reported bug: the same physical hall (LH-1) on the same date + session showed
// 17 students in the Seating View but 47 in the Hall Notice selector, and the
// printed notice then showed "TOTAL" lower than the selector promised. Root
// cause: the notice SELECTOR counted every saved seat row across every plan
// (raw), while the rendered notice keeps the FIRST claimant of each physical
// seat and the first appearance of each student. Skewed numbers made the notice
// look wrong and hid a seat-collision problem in saved plans.
//
// These tests pin the single-source contract: every hall-facing counter — the
// notice selector, the summary, and the rendered TOTAL — counts the SAME
// first-wins deduped seat set produced by the notice renderer, while a genuine
// multi-subject hall that uses DISJOINT seats must never lose a student.
//
// Functions are loaded by name from index.html through the shared harness.
const h = require("./harness.js");
const api = h.load();

const s = h.suite("hall_notice_count.test.js — every hall-facing count equals the first-wins deduped seat set");
const { it, eq, ok } = s;

const FN = "2026-10-14";
const COLLEGE = { name: "Test College", centre_code: "TC01" };

// One physical seat with every identity field the renderer's seat keys use.
function seat(n, regno, extra) {
  return Object.assign({
    regno: regno, name: "Student " + regno, dept: "CSE",
    seatNo: "h1-B" + n + "S1", seatLabel: "A" + n + ".1",
    colIdx: 0, rowIdx: n - 1, slot: 1, bench: n,
  }, extra || {});
}

// Hall LH-1 as ONE record carrying a real layout.
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

function findOption(options, name) {
  return options.filter(function (o) { return o.name === name; })[0] || null;
}

// The rendered FIRST-WINS result must already exist: a seat claimed by two plans
// keeps the first claimant. The count bug is that the SELECTOR and group total
// were the RAW row count, not this surviving set.
it("REPRO: two plans reuse the same physical LH-1 seats -> selector said 47, notice renders 17", () => {
  const e1 = exam("e1", "CS3492 - DBMS");
  const e2 = exam("e2", "CS3501 - Networks");
  // e1 seats 17 students in benches 1..17.
  const s1 = [];
  for (let i = 1; i <= 17; i++) s1.push(seat(i, "953022104" + String(i).padStart(3, "0")));
  // e2 seats 30 students but its saved rows collapse onto the SAME 17 physical
  // seats (every saved seat duplicates a bench from e1), so raw = 47.
  const s2 = [];
  for (let i = 1; i <= 30; i++) s2.push(seat((i - 1) % 17 + 1, "953022105" + String(i).padStart(3, "0")));
  const plans = { e1: planOf(s1), e2: planOf(s2) };
  const halls = [lh1()];
  const examsArr = [e1, e2];

  const groups = api.hallNoticesGroup(examsArr, plans, halls, null, null, null);
  eq(groups.length, 1, "one hall/date/session group");
  eq(groups[0].total, 17, "group total is the surviving physical-seat set, not the raw 47");

  const { perHall, hallDates } = api.hallNoticePerHall(examsArr, plans, halls);
  const opt = findOption(api.hallNoticeOptions(halls, perHall, hallDates), "LH-1");
  ok(opt, "LH-1 appears in the selector");
  eq(opt.count, 17, "selector count equals the rendered TOTAL");

  const doc = api.buildHallNoticesPrintDocument({ exams: examsArr, seatingPlans: plans, halls: halls }, COLLEGE);
  eq(doc.notices.length, 1, "one notice");
  eq(doc.notices[0].rows, 17, "document notice rows are the surviving set");
  ok(/TOTAL:<\/strong> 17/.test(doc.pages[0]), "rendered TOTAL is 17 (got: " + (doc.pages[0].match(/TOTAL:<\/strong> (\d+)/) || ["", "?"])[1] + ")");
});

it("REPRO: alias hall records for one physical hall collapse to one selector entry with the surviving count", () => {
  const e1 = exam("e1", "CS3492 - DBMS");
  // Plans keyed by two DIFFERENT ids ("h1" with layout, "hLegacy" without) that
  // both mean LH-1. resolveHall must collapse them and the count must survive it.
  const s1 = [];
  for (let i = 1; i <= 17; i++) s1.push(seat(i, "953022104" + String(i).padStart(3, "0")));
  const sLegacy = [];
  for (let i = 1; i <= 30; i++) sLegacy.push(seat((i - 1) % 17 + 1, "953022105" + String(i).padStart(3, "0")));
  const plans = {
    e1: { h1: { hallName: "LH-1", numbenches: 40, studentsperbench: 2, layoutConfig: { columns: [{ seats: 2 }, { seats: 0 }] }, seats: s1 } },
  };
  const e2 = exam("e2", "CS3501 - Networks");
  plans.e2 = { hLegacy: { hallId: "hLegacy", hallName: "LH-1", seats: sLegacy } };
  const halls = [lh1(), { id: "hLegacy", name: "LH-1" }];
  const examsArr = [e1, e2];

  const groups = api.hallNoticesGroup(examsArr, plans, halls, null, null, null);
  eq(groups.length, 1, "aliases collapse to one group");
  ok(groups[0].hallId === "h1", "canonical id is the layout-bearing record");

  const { perHall, hallDates } = api.hallNoticePerHall(examsArr, plans, halls);
  const options = api.hallNoticeOptions(halls, perHall, hallDates);
  eq(options.filter(function (o) { return o.name === "LH-1"; }).length, 1, "one dropdown entry for LH-1");
  eq(findOption(options, "LH-1").count, 17, "selector count survives aliasing");
  eq(findOption(options, "LH-1").id, "h1", "dropdown id equals the canonical layout-bearing record");
});

it("NO-OVERDEDUPE: two subjects legitimately sharing a hall on DISJOINT seats keep every student", () => {
  const e1 = exam("e1", "CS3492 - DBMS");
  const e2 = exam("e2", "CS3501 - Networks");
  const s1 = [];
  for (let i = 1; i <= 17; i++) s1.push(seat(i, "953022104" + String(i).padStart(3, "0")));
  const s2 = [];
  for (let i = 18; i <= 30; i++) s2.push(seat(i, "953022105" + String(i - 17).padStart(3, "0")));
  const plans = { e1: planOf(s1), e2: planOf(s2) };
  const halls = [lh1()];
  const examsArr = [e1, e2];

  const groups = api.hallNoticesGroup(examsArr, plans, halls, null, null, null);
  eq(groups[0].total, 30, "disjoint seats are all counted");
  eq(groups[0].rows.length, 30, "no student is dropped");

  const doc = api.buildHallNoticesPrintDocument({ exams: examsArr, seatingPlans: plans, halls: halls }, COLLEGE);
  ok(/TOTAL:<\/strong> 30/.test(doc.pages[0]), "rendered TOTAL is 30");
});

it("REPRO: the same student listed twice in one hall+date+session is counted once", () => {
  const e1 = exam("e1", "CS3492 - DBMS");
  const e2 = exam("e2", "CS3501 - Networks");
  // e2 re-seats the SAME student (reuse of bench 1) plus a fresh row.
  const s1 = [seat(1, "953022104001"), seat(2, "953022104002")];
  const s2 = [seat(1, "953022104001"), seat(3, "953022104003")];
  const plans = { e1: planOf(s1), e2: planOf(s2) };
  const halls = [lh1()];
  const examsArr = [e1, e2];

  const groups = api.hallNoticesGroup(examsArr, plans, halls, null, null, null);
  eq(groups[0].total, 3, "student repeated across plans is counted once");
});

it("hnNoticeDedupeRows is first-wins and stable: same regno on two seats and two regnos on one seat resolve identically to the grid", () => {
  const rows = [
    seat(1, "R1"),
    seat(1, "R2"),            // seat-collision: R2 dropped
    seat(2, "R1"),            // regno repeat: dropped
    seat(3, "R3"),
  ];
  const kept = api.hnNoticeDedupeRows(rows, { hallId: "h1", date: FN, session: "FN" });
  eq(kept.length, 2, "kept = R1@bench1, R3@bench3");
  eq(kept[0].regno, "R1");
  eq(kept[1].regno, "R3");
  eq(queriesFor(kept, "R1").seats.length + queriesFor(kept, "R3").seats.length, 2, "every kept row has exactly one physical seat");
});

it("the aggregation contract: selector count === group total === rendered TOTAL === surviving rows", () => {
  const examsArr = [], plans = {}, halls = [lh1()];
  const mk = function (eid, benchFor, count, prefix) {
    const e = exam(eid, "SUB-" + eid);
    examsArr.push(e);
    const ss = [];
    for (let i = 0; i < count; i++) ss.push(seat(benchFor(i + 1), prefix + String(i + 1).padStart(3, "0")));
    plans[eid] = planOf(ss);
    return e;
  };
  mk("e1", function (i) { return (i - 1) % 17 + 1; }, 17, "953022104");        // benches 1..17 (17)
  mk("e2", function (i) { return i <= 17 ? (i - 1) % 17 + 1 : i; }, 25, "953022105");    // 17 collide + benches 18..25
  mk("e3", function (i) { return i <= 17 ? (i - 1) % 17 + 1 : i + 8; }, 30, "953022106"); // 17 collide + benches 26..38
  // RAW = 72 rows. SURVIVING physical seats = 17 + 8 + 13 = 38.
  const groups = api.hallNoticesGroup(examsArr, plans, halls, null, null, null);
  const { perHall, hallDates } = api.hallNoticePerHall(examsArr, plans, halls);
  const opt = findOption(api.hallNoticeOptions(halls, perHall, hallDates), "LH-1");
  const doc = api.buildHallNoticesPrintDocument({ exams: examsArr, seatingPlans: plans, halls: halls }, COLLEGE);
  eq(groups[0].total, 38, "group total is the surviving set, not the raw 72");
  eq(opt.count, groups[0].total, "selector equals group total");
  eq(doc.notices[0].rows, groups[0].total, "document rows equal group total");
  ok(/TOTAL:<\/strong> 38/.test(doc.pages[0]), "rendered TOTAL equals the surviving set");
});

// Regno -> its seat rows (kept rows only).
function queriesFor(rows, regno) {
  return { seats: rows.filter(function (r) { return r.regno === regno; }) };
}

// ── DATE + SESSION SCOPING ───────────────────────────────────────────────────
// Reported bug: the Hall Notice dropdown read "LH-1 (139 seated)" and its
// preview showed an OLD date (06.10.2026) with a sparse first page, while the
// Seating Plans page — which shows ONE date+session — read 45 for the SAME
// physical hall. Root cause: the Hall Notice counted and rendered EVERY saved
// date/session at once. These tests pin the fix: the notice is scoped to exactly
// one (date, session) chosen from the SAVED plan metadata, and the selector
// count, the rendered grid and the TOTAL all describe that same allocation.

// Same physical hall reused across several exam dates. The per-date counts sum
// to 139 — the exact number the dropdown wrongly reported — while 2026-10-14 FN
// alone is 45, matching the Seating Plans page.
const HALL_DATES = [
  ["2026-10-06", 10], ["2026-10-07", 17], ["2026-10-08", 17], ["2026-10-09", 17],
  ["2026-10-14", 45], ["2026-10-15", 17], ["2026-10-16", 16],
];

function multiDateFixture() {
  const examsArr = [], plans = {};
  HALL_DATES.forEach(function (row, di) {
    const e = exam("e" + di, "SUB-" + di);
    e.date = row[0];
    examsArr.push(e);
    const seats = [];
    for (let i = 1; i <= row[1]; i++) seats.push(seat(i, "9530" + String(di).padStart(2, "0") + String(i).padStart(3, "0")));
    plans[e.id] = planOf(seats);
  });
  return { examsArr: examsArr, plans: plans, halls: [lh1()] };
}

it("REPRO: the unscoped selector aggregated EVERY date (139) while one date+session is 45", () => {
  const f = multiDateFixture();
  const all = api.hallNoticePerHall(f.examsArr, f.plans, f.halls);
  const allOpt = findOption(api.hallNoticeOptions(f.halls, all.perHall, all.hallDates), "LH-1");
  eq(allOpt.count, 139, "unscoped selector sums every date (the reported 139)");

  const sc = api.hallNoticePerHall(f.examsArr, f.plans, f.halls, "2026-10-14", "FN");
  const scOpt = findOption(api.hallNoticeOptions(f.halls, sc.perHall, sc.hallDates), "LH-1");
  eq(scOpt.count, 45, "14-10 FN selector matches the Seating Plans count (45)");
});

it("REPRO: the scoped builder renders ONLY the selected date, never the stale 06.10.2026", () => {
  const f = multiDateFixture();
  const doc = api.buildHallNoticesPrintDocument(
    { exams: f.examsArr, seatingPlans: f.plans, halls: f.halls, date: "2026-10-14", session: "FN", hallId: "h1" }, COLLEGE);
  eq(doc.pages.length, 1, "one date+session+hall = one A4 page");
  eq(doc.notices.length, 1, "one notice");
  eq(doc.notices[0].date, "2026-10-14", "notice carries the SELECTED date");
  ok(/14\.10\.2026/.test(doc.pages[0]), "header shows the selected date");
  ok(!/06\.10\.2026/.test(doc.pages[0]), "the stale 06.10.2026 date can never appear");
  ok(/TOTAL:<\/strong> 45/.test(doc.pages[0]), "scoped TOTAL is 45");

  // The UNFILTERED build is the old, broken preview: many dates, earliest first.
  const allDoc = api.buildHallNoticesPrintDocument(
    { exams: f.examsArr, seatingPlans: f.plans, halls: f.halls, hallId: "h1" }, COLLEGE);
  ok(allDoc.pages.length > 1, "unfiltered preview spans every date (why 06.10.2026 showed first)");
  ok(/06\.10\.2026/.test(allDoc.pages[0]), "unfiltered page 0 is the earliest date");
});

it("every occupied seat cell prints the saved register number — never a raw index/placeholder", () => {
  const f = multiDateFixture();
  const doc = api.buildHallNoticesPrintDocument(
    { exams: f.examsArr, seatingPlans: f.plans, halls: f.halls, date: "2026-10-14", session: "FN", hallId: "h1" }, COLLEGE);
  const page = doc.pages[0];
  eq((page.match(/<div class="cell">/g) || []).length, 45, "exactly one occupied cell per surviving student");
  const vals = page.match(/<div class="val">([^<]*)<\/div>/g) || [];
  eq(vals.length, 90, "register no. + dept value for each of the 45 students");
  ok(vals.every(function (v) { return !/^<div class="val">1<\/div>$/.test(v); }), "no cell value is a bare 1 placeholder");
  ok(page.indexOf("953004001") >= 0, "a real saved register number is rendered in its cell");
});

it("scoping by each date+session neither double counts nor loses a student vs the whole set", () => {
  const f = multiDateFixture();
  const pairs = api.hallNoticeDateSessions(f.examsArr, f.plans, f.halls);
  eq(pairs.length, 7, "seven distinct date+session pairs are offered");
  const sum = pairs.reduce(function (a, p) {
    const sc = api.hallNoticePerHall(f.examsArr, f.plans, f.halls, p.date, p.session);
    const opt = findOption(api.hallNoticeOptions(f.halls, sc.perHall, sc.hallDates), "LH-1");
    return a + (opt ? opt.count : 0);
  }, 0);
  const all = api.hallNoticePerHall(f.examsArr, f.plans, f.halls);
  const allOpt = findOption(api.hallNoticeOptions(f.halls, all.perHall, all.hallDates), "LH-1");
  eq(sum, allOpt.count, "per-(date,session) counts add up to the whole set");
});

it("preview, print and PDF consume the SAME scoped document (deterministic rebuild)", () => {
  const f = multiDateFixture();
  const opts = { exams: f.examsArr, seatingPlans: f.plans, halls: f.halls, date: "2026-10-14", session: "FN", hallId: "h1" };
  const a = api.buildHallNoticesPrintDocument(opts, COLLEGE);
  const b = api.buildHallNoticesPrintDocument(opts, COLLEGE);
  eq(a.pages, b.pages, "the same options rebuild a byte-identical document");
  eq(a.css, b.css, "same stylesheet");
});

module.exports = s;