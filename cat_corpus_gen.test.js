// The reader against seventeen generated layouts it has never seen.
//
// cat_corpus.test.js covers the two REAL sheets. This file covers everything the
// real sheets are not: borderless, landscape, dates across the top, FN/AN, code and
// name and staff in separate columns, subjects with no code, no staff, no sections,
// two departments on one page, a table running onto page two, four kinds of year
// heading, five kinds of date, and a department the master list has never heard of.
//
// Every expectation comes from corpus/golden/*.json, which cat_make_fixtures.js
// writes from the SPEC rather than from the reader's output. A failure here means
// the reader disagreed with the drawing, which is the only disagreement worth
// caring about.
const fs = require("fs");
const path = require("path");
const h = require("./harness.js");
const { readPdf, examKey } = require("./cat_read_file.js");
const { SPECS } = require("./cat_corpus_specs.js");

const s = h.suite("cat_corpus_gen.test.js \u2014 seventeen generated layouts");
const { ait, eq, ok } = s;

const GEN = path.join(__dirname, "corpus", "gen");
const GOLD = path.join(__dirname, "corpus", "golden");

function goldenOf(name) {
  return JSON.parse(fs.readFileSync(path.join(GOLD, name + ".json"), "utf8"));
}

function gotExams(r) {
  const out = [];
  r.tables.forEach((t) => t.exams.forEach((b) => out.push(examKey(b))));
  return out.sort();
}

function wantExams(g) {
  const out = [];
  g.exams.forEach((e) => out.push([
    e.date, e.year, e.session || "",
    e.subjects.map((x) => (x.code ? x.code : "~" + x.name)).sort().join(","),
    e.staff.slice().sort().join("&"),
    "NE:" + e.nonExam.slice().sort().join("&"),
  ].join("|")));
  return out.sort();
}

function diff(got, want) {
  const missing = want.filter((x) => got.indexOf(x) < 0);
  const extra = got.filter((x) => want.indexOf(x) < 0);
  return { missing, extra };
}

function describe(d) {
  const lines = [];
  d.missing.slice(0, 4).forEach((x) => lines.push("      missing: " + x));
  d.extra.slice(0, 4).forEach((x) => lines.push("      extra  : " + x));
  if (d.missing.length > 4) lines.push("      ... and " + (d.missing.length - 4) + " more missing");
  if (d.extra.length > 4) lines.push("      ... and " + (d.extra.length - 4) + " more extra");
  return lines.join("\n");
}

// Every layout gets the same three checks: the right exams, the right metadata, and
// no leftover cells. Individually too, so a failure names the layout that broke.
SPECS.forEach((spec) => {
  const g = goldenOf(spec.name);

  ait(spec.name + ": reads every date, year, subject and member of staff", async () => {
    const r = await readPdf(path.join(GEN, spec.name + ".pdf"));
    const got = gotExams(r);
    const want = wantExams(g);
    const d = diff(got, want);
    ok(!d.missing.length && !d.extra.length,
      "got " + got.length + ", expected " + want.length + "\n" + describe(d));
  });

  ait(spec.name + ": accounts for every cell it read", async () => {
    const r = await readPdf(path.join(GEN, spec.name + ".pdf"));
    eq(r.recon.leftovers.length, 0,
      "unaccounted: " + JSON.stringify(r.recon.leftovers).slice(0, 300));
  });

  ait(spec.name + ": reads the printed metadata", async () => {
    const r = await readPdf(path.join(GEN, spec.name + ".pdf"));
    const f = r.meta.fields;
    if (g.meta.academicYear) eq(f.academicYear, g.meta.academicYear, "academic year");
    if (g.meta.term) eq(f.term, g.meta.term, "term");
    if (g.meta.assessment) eq(f.assessment, g.meta.assessment, "assessment");
    if (g.meta.dateRange) {
      eq(f.dateRange && f.dateRange.from, g.meta.dateRange.from, "range from");
      eq(f.dateRange && f.dateRange.to, g.meta.dateRange.to, "range to");
    }
    if (g.meta.timeRange) eq(f.timeRange, g.meta.timeRange, "time range");
    if (g.meta.session) eq(f.sessionFromTime, g.meta.session, "session from the clock time");
  });
});

// ---- the specific claims, checked one at a time so a failure names itself ----
ait("the ruled three-year sheet keeps its sections and its non-exam activity", async () => {
  const g = goldenOf("ruled_3yr_sections");
  const r = await readPdf(path.join(GEN, "ruled_3yr_sections.pdf"));
  eq(r.tables.length, 1);
  eq(r.tables[0].cols, 4, "DATE plus three years");
  eq(r.tables[0].sections.sections, ["A", "B"]);
  const naan = r.tables[0].exams.filter((b) => b.date === "2026-10-08" && b.year === 3)[0];
  ok(naan, "08.10 year 3 is there");
  eq(naan.subjectCount, 0, "it holds an activity, not a paper");
  eq(naan.nonExamCount, 1);
  eq(naan.ready, false, "and it is not silently ready");
});

ait("a single-year sheet is not padded out with years that are not there", async () => {
  const r = await readPdf(path.join(GEN, "ruled_1yr.pdf"));
  const years = {};
  r.tables[0].exams.forEach((b) => { years[b.year] = 1; });
  eq(Object.keys(years), ["3"]);
  eq(r.tables[0].cols, 2, "DATE plus one year");
});

ait("a four-year sheet yields all four years", async () => {
  const r = await readPdf(path.join(GEN, "ruled_4yr.pdf"));
  const years = {};
  r.tables[0].exams.forEach((b) => { years[b.year] = 1; });
  eq(Object.keys(years).sort(), ["1", "2", "3", "4"]);
});

ait("dates across the top and years down the left give the same answer", async () => {
  const r = await readPdf(path.join(GEN, "dates_across.pdf"));
  // "years-down" is the mode's name for this shape: the year labels run down the
  // side, which is what puts the dates across the top.
  eq(r.tables[0].orient.mode, "years-down", "the layout is recognised, not assumed");
  eq(r.tables[0].orient.datesAxis, "row", "and the dates run along the row");
  const b = r.tables[0].exams.filter((x) => x.date === "2026-10-08" && x.year === 4)[0];
  ok(b, "08.10 fourth year");
  eq(b.subjects.map((x) => x.code), ["CV4503"]);
  eq(b.staff, ["Dr. X. Rao"]);
});

ait("a landscape page is read the same way as a portrait one", async () => {
  const r = await readPdf(path.join(GEN, "landscape_ruled.pdf"));
  eq(r.tables[0].method, "ruled grid");
  eq(r.tables[0].cols, 4);
  eq(r.tables[0].exams.length, 9);
});

ait("a borderless sheet still finds its columns", async () => {
  const r = await readPdf(path.join(GEN, "borderless.pdf"));
  eq(r.recon.leftovers.length, 0);
  const b = r.tables[0].exams.filter((x) => x.date === "2026-10-07" && x.year === 3)[0];
  ok(b, "07.10 third year");
  eq(b.subjects.map((x) => x.code), ["CS3502"]);
  eq(b.staff, ["Ms. L. Das"]);
});

ait("FN and AN are kept apart instead of being merged into one sitting", async () => {
  const r = await readPdf(path.join(GEN, "fn_an_rows.pdf"));
  const bucket = (d, y, sess) => r.tables[0].exams.filter(
    (x) => x.date === d && x.year === y && x.session === sess)[0];
  const fn2 = bucket("2026-10-06", 2, "FN");
  const an2 = bucket("2026-10-06", 2, "AN");
  ok(fn2 && an2, "both sessions are separate exams");
  eq(fn2.subjects.map((x) => x.code), ["CS25C01"]);
  eq(an2.subjects.map((x) => x.code), ["CS25C07"]);
  eq(fn2.staff, ["Dr. A. Kumar"]);
  eq(an2.staff, ["Dr. S. Menon"]);
});

ait("code, subject and staff printed in separate columns are joined, not shuffled", async () => {
  const r = await readPdf(path.join(GEN, "split_code_name_staff.pdf"));
  const b = r.tables[0].exams.filter((x) => x.date === "2026-10-07" && x.year === 2)[0];
  ok(b, "07.10 second year");
  eq(b.subjects.map((x) => x.code), ["CS25C02"], "the code comes from the CODE column");
  eq(b.subjects.map((x) => x.name), ["Data Structures"], "the name from the SUBJECT column");
  eq(b.staff, ["Dr. S. Menon"], "and the staff from the STAFF column");
  const b3 = r.tables[0].exams.filter((x) => x.date === "2026-10-07" && x.year === 3)[0];
  eq(b3.subjects.map((x) => x.name), ["Database Systems"]);
  eq(b3.staff, ["Ms. L. Das"], "year 3 keeps its own staff");
});

ait("a sheet with no staff and no sections says so instead of inventing them", async () => {
  const r = await readPdf(path.join(GEN, "no_staff_no_sections.pdf"));
  const t = r.tables[0];
  eq(t.sections.sections, []);
  eq(t.sections.printed, null);
  r.tables[0].exams.forEach((b) => eq(b.staff, [], "no staff is printed, so none is reported"));
  eq(r.tables[0].exams.filter((b) => b.ready).length, 0,
    "every exam waits for the user, because the date and year are known but staff is not");
});

ait("subjects printed with no code keep their name and get no code", async () => {
  const r = await readPdf(path.join(GEN, "subjects_without_codes.pdf"));
  const b = r.tables[0].exams.filter((x) => x.date === "2026-10-06" && x.year === 2)[0];
  eq(b.subjects.map((x) => x.name), ["Discrete Mathematics"]);
  eq(b.subjects.map((x) => x.code), [null], "no code is invented");
  eq(b.subjects[0].codeConf.level, "none");
});

ait("a first-year common paper is attached to the first year, not to every year", async () => {
  const r = await readPdf(path.join(GEN, "first_year_common.pdf"));
  const one = r.tables[0].exams.filter((x) => x.date === "2026-10-06" && x.year === 1)[0];
  const two = r.tables[0].exams.filter((x) => x.date === "2026-10-06" && x.year === 2)[0];
  eq(one.subjects.map((x) => x.code), ["HS1501"]);
  eq(two.subjects.map((x) => x.code), ["CS25C01"]);
  eq(one.staff, ["Dr. A. Kumar"]);
  eq(two.staff, ["Ms. R. Iyer"]);
});

ait("two departments on one page stay two separate tables with their own departments", async () => {
  const r = await readPdf(path.join(GEN, "two_departments_one_page.pdf"));
  eq(r.tables.length, 2, "the page holds two timetables");
  const cse = r.tables.filter((t) => t.exams.some((b) => b.subjects.some((x) => /^CS/.test(x.code || ""))))[0];
  const ece = r.tables.filter((t) => t !== cse)[0];
  ok(cse && ece, "one table for CSE and one for ECE");
  eq(cse.dept.department.code, "CSE");
  eq(ece.dept.department.code, "ECE");
  eq(cse.exams.length, 4);
  eq(ece.exams.length, 4);
});

ait("a table that runs onto page two keeps every row and the repeated header", async () => {
  const r = await readPdf(path.join(GEN, "two_page_table.pdf"));
  const got = gotExams(r);
  const want = wantExams(goldenOf("two_page_table"));
  eq(got, want);
  eq(r.tables[0].exams.length, 10, "all ten rows, across both pages");
});

ait("five ways of writing a date all mean the day they are supposed to", async () => {
  const r = await readPdf(path.join(GEN, "date_formats.pdf"));
  const got = {};
  r.tables[0].exams.forEach((b) => { got[b.date] = 1; });
  eq(Object.keys(got).sort(), [
    "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-14",
  ]);
  // 09-10-2026 is ambiguous on its own; the printed range 06-Oct to 16-Oct settles it.
  const b = r.tables[0].exams.filter((x) => x.date === "2026-10-09")[0];
  ok(b, "the ambiguous date resolved to 9 October");
});

ait("year headings written four different ways all give the same years", async () => {
  const r = await readPdf(path.join(GEN, "roman_and_arabic_years.pdf"));
  const years = {};
  r.tables[0].exams.forEach((b) => { years[b.year] = 1; });
  eq(Object.keys(years).sort(), ["1", "2", "3", "4"],
    "FIRST YEAR, II YEAR, THIRD YEAR and 4th YEAR");
});

ait("a department outside the master list keeps its printed name and is not guessed", async () => {
  const r = await readPdf(path.join(GEN, "department_not_in_master.pdf"));
  const t = r.tables[0];
  eq(t.dept.department.code, null, "no code is invented for an unknown department");
  ok(/FOOD TECHNOLOGY/.test(t.dept.department.name || ""),
    "the printed name is kept: " + t.dept.department.name);
  eq(t.dept.needsConfirmation, true, "and the user is asked to confirm it");
});

ait("wide gutters do not stop a borderless sheet being read", async () => {
  const r = await readPdf(path.join(GEN, "wide_padding_borderless.pdf"));
  eq(r.recon.leftovers.length, 0);
  eq(r.tables[0].exams.length, 8);
});

// ---- the corpus as a whole --------------------------------------------------
ait("all seventeen layouts are present on disk and match their specs", async () => {
  const { buildPdf, golden } = require("./cat_make_fixtures.js");
  SPECS.forEach((spec) => {
    const pdf = path.join(GEN, spec.name + ".pdf");
    ok(fs.existsSync(pdf), spec.name + ".pdf is missing");
    ok(fs.readFileSync(pdf).equals(buildPdf(spec)),
      spec.name + ".pdf is stale; run node cat_make_fixtures.js");
    const onDisk = fs.readFileSync(path.join(GOLD, spec.name + ".json"), "utf8");
    eq(onDisk, JSON.stringify(golden(spec), null, 2) + "\n",
      spec.name + ".json is stale; run node cat_make_fixtures.js");
  });
});

module.exports = s;