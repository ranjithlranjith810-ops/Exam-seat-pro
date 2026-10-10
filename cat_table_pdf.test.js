// Real-PDF regression test for the CAT timetable reader.
//
// cat_pipeline.test.js feeds the parser SYNTHESIZED rows, which proves the rules
// but never proves them against a real sheet. This suite closes that gap: it opens
// one actual published timetable - a single-page, text-layer CAT sheet with drawn
// cell borders - and asserts the exact exams that sheet prints.
//
// Only pdf.js runs outside the sandbox, and only to hand the parser a genuine page
// object. Everything after that - ruling lines, grid, cells, metadata, preview - is
// the same code the browser runs, pulled out of index.html by name.
//
// If pdf.js is not installed the whole suite reports as one failure rather than
// taking the other suites down with it, so the rest of run.js still reports.
const fs = require("fs");
const path = require("path");
const h = require("./harness.js");
const api = h.load();

const s = h.suite("cat_table_pdf.test.js \u2014 real PDF, ruled-grid reader");
const { ait, eq, ok } = s;

const FIXTURE = path.join(__dirname, "fixtures", "CAT-II_Timetable_CSE_2026-27_Digital.pdf");

// The sheet's own text layer, minus its table, in reading order.
const HEADER = [
  "St. Mother Theresa Engineering College, Vagaikulam, Tuticorin",
  "ACADEMIC YEAR 2026-27 | ODD SEMESTER",
  "CONTINUOUS ASSESSMENT TEST-II TIME TABLE (06.10.2026 TO 16.10.2026)",
  "DEPARTMENT OF COMPUTER SCIENCE AND ENGINEERING",
  "SEM: III, V & VII TIME: 9:30 AM TO 12:30 PM",
  "FN",
].join("\n");

// Every exam the sheet prints, exactly as printed. Staff are listed with the
// honorifics the sheet uses, because the preview shows what the sheet says.
// "Mrs.C." with no space is not a typo in this file - it is what the PDF prints.
const EXPECTED = [
  ["2026-10-06", "3", "05", "CCS375", "WEB TECHNOLOGIES", ["Ms.P. Jebarajathi", "Mr. A. Michael"]],
  ["2026-10-06", "4", "07", "GE3751", "PRINCIPLES OF MANAGEMENT", ["Mrs. Mathumalar", "Mrs. Amala Sundari"]],
  ["2026-10-07", "2", "03", "CS25C10", "OBJECT ORIENTED SOFTWARE ENGINEERING", ["Mrs. M. Dani Packiaseeli", "Ms. C. Bhagya Lakshmi"]],
  ["2026-10-07", "3", "05", "CS3591", "COMPUTER NETWORKS", ["Mr. A. Michael", "Mrs. S. Jeyam Jacquline"]],
  ["2026-10-07", "4", "07", "CME365", "RENEWABLE ENERGY TECHNOLOGIES", ["Dr. Faustina Adline", "Dr. Vanthana", "Dr. Karthikeyan"]],
  ["2026-10-08", "2", "03", "CS25C08", "DATA STRUCTURES", ["Ms. Haritha", "Mrs.C. Durga Janani"]],
  ["2026-10-08", "3", "05", "CCS334", "BIG DATA ANALYTICS", ["Mrs. M. Dani Packiaseeli", "Dr. KM. Abubackkar Sithiq"]],
  ["2026-10-08", "4", "07", "OMR353", "SENSORS", ["Mr. Densingh Xavier S.P", "Mr. B. Arul Rajan"]],
  ["2026-10-09", "2", "03", "CS25C09", "JAVA PROGRAMMING", ["Mrs. S. Jeyam Jacquline", "Ms. V. Pavitha"]],
  ["2026-10-09", "3", "05", "CS3501", "COMPILER DESIGN", ["Ms. Haritha", "Ms. C. Bhagya Lakshmi"]],
  ["2026-10-14", "2", "03", "MA25C08", "DISCRETE MATHEMATICS", ["Dr. S. Kavitha", "Dr. Uma Maheshwari"]],
  ["2026-10-14", "3", "05", "CB3491", "CRYPTOGRAPHY AND CYBER SECURITY", ["Mrs. S. Jeyam Jacquline", "Mrs.C. Durga Janani"]],
  ["2026-10-14", "4", "07", "GE3791", "HUMAN VALUES AND ETHICS", ["Dr. T. Vela", "Dr. Pravin Bavithra"]],
  ["2026-10-15", "2", "03", "CS25C11", "OPERATING SYSTEMS", ["Mr. A. Michael", "Ms. Haritha"]],
  ["2026-10-15", "3", "05", "CS3551", "DISTRIBUTED COMPUTING", ["Dr. KM. Abubackkar Sithiq", "Mr. I. Rajasubramanian"]],
];

// The two NAAN MUDALVAN cells the sheet prints, by date and year column.
const IGNORED = [["2026-10-06", "2"], ["2026-10-09", "4"]];

// Opens the fixture and runs the browser pipeline over it once. Everything below
// asserts against this one result, so the file is parsed exactly one time.
async function readSheet() {
  const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");
  // verbosity 0 keeps errors and drops the standard-font fetch warnings, which are
  // expected here: the sheet is parsed for its TEXT and its ruling lines, so no
  // glyphs are ever rasterised and the font programs are never needed.
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(FIXTURE)), verbosity: 0,
  }).promise;
  const page = await doc.getPage(1);

  // Exactly what catExtractPdfRows builds for a page whose borders are drawn.
  const geo = await api.catTextItemsForPage(page);
  const rules = await api.catPageRulingLines(page);
  const grid = api.catGridFromRules(rules, api.catPageBox(page));

  const rows = await api.catTextRowsForPage(page);
  const headerText = rows.rows.map((r) => r.text).join("\n");

  const parsed = api.catParseTimetable([rows.rows], {
    headerText, tables: grid ? [{ pageNo: 1, items: geo.items, grid }] : [],
  });
  const meta = api.catParseMeta(headerText, { branches: [] });
  const entries = api.catBuildEntries(parsed.cells, meta);
  const preview = api.catBuildPreview(entries, {
    exams: [], students: [], branches: [], deptCode: "CSE", collegeId: null,
    dateRange: { from: meta.dateFrom, to: meta.dateTo },
  });
  return { page, rules, grid, parsed, meta, preview, headerText };
}

function load() {
  if (!fs.existsSync(FIXTURE)) throw new Error("fixture PDF is missing: " + FIXTURE);
  return readSheet();
}

// ---- the printed sheet is found and read as a grid ----------------------------

ait("the fixture is a single-page text-layer PDF with drawn cell borders", async () => {
  const { page, rules } = await load();
  ok(page, "no page");
  const items = (await page.getTextContent()).items;
  ok(items.length > 80, "text layer looks too thin: " + items.length + " items");
  ok(rules.h.length >= 10 && rules.v.length >= 4,
    "ruling lines not found: " + rules.h.length + " h / " + rules.v.length + " v");
});

ait("the sheet is read by the ruled-grid reader, not the line reader", async () => {
  const { parsed } = await load();
  ok(/ruled-grid/.test(parsed.reader || ""), "reader was: " + parsed.reader);
});

ait("all three study-year columns and all six dates are found", async () => {
  const { parsed } = await load();
  eq(parsed.columnYears, ["2", "3", "4"]);
  eq(parsed.dates, ["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-14", "2026-10-15"]);
  eq(parsed.blankCells, 1, "one cell is printed blank (15.10 / IV YEAR)");
});

// ---- the exams are exactly the ones on the sheet -----------------------------

ait("every printed exam is read, with the code, name, year, semester and staff", async () => {
  const { parsed } = await load();
  const got = parsed.cells.filter((c) => !c.nonExam)
    .map((c) => [c.date, c.year, c.sem, c.code, c.name, c.staffNames]);
  eq(got, EXPECTED, "the parsed exams do not match the sheet");
});

ait("no cell carries a code or name the sheet does not print", async () => {
  const { parsed } = await load();
  ok(parsed.cells.every((c) => c.nonExam || c.code), "an exam was read with no subject code");
  ok(parsed.cells.every((c) => c.nonExam || c.name), "an exam was read with no subject name");
  ok(parsed.cells.every((c) => !/\d{1,2}\.\d{1,2}\.\d{4}/.test(c.code || "")),
    "a date leaked into a subject code");
});

ait("a code printed with a printer's space is normalised, and only that", async () => {
  const { parsed } = await load();
  const codes = parsed.cells.filter((c) => !c.nonExam).map((c) => c.code);
  ok(codes.includes("CB3491"), "CB 3491 was not normalised: " + codes.join(", "));
  ok(codes.includes("CS3551"), "CS 3551 was not normalised: " + codes.join(", "));
  ok(codes.includes("CS25C10"), "a code with a letter and a digit suffix lost part of itself");
});

ait("every exam keeps the (A & B) sections printed on its column", async () => {
  const { parsed } = await load();
  const secs = new Set(parsed.cells.filter((c) => !c.nonExam).map((c) => c.sections.join("")));
  eq([...secs], ["AB"], "sections were lost or invented");
});

ait("no exam is assigned a date the sheet does not print", async () => {
  const { parsed } = await load();
  const printed = ["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-14", "2026-10-15"];
  ok(parsed.cells.every((c) => printed.includes(c.date)), "an exam landed on an unprinted date");
  ok(parsed.cells.every((c) => !c.date || /^\d{4}-\d{2}-\d{2}$/.test(c.date)),
    "a date is not ISO");
});

// ---- non-exam cells are reported, not invented into exams -------------------

ait("NAAN MUDALVAN is reported as a non-exam cell, never as an exam", async () => {
  const { parsed } = await load();
  const got = parsed.cells.filter((c) => c.nonExam)
    .map((c) => [c.date, c.year, /NAAN/.test(c.name || c.raw)]);
  eq(got, IGNORED.map(([d, y]) => [d, y, true]), "the non-exam cells are wrong");
  ok(parsed.cells.filter((c) => !c.nonExam).every((c) => !/NAAN/.test(c.name || "")),
    "NAAN MUDALVAN was turned into an exam");
});

ait("the blank cell yields no cell at all and no error", async () => {
  const { parsed, preview } = await load();
  ok(!parsed.cells.some((c) => c.date === "2026-10-15" && c.year === "4"),
    "the blank 15.10 / IV YEAR cell was read as an exam");
  ok(preview.rows.every((r) => !(r.date === "2026-10-15" && r.year === "4")),
    "the blank cell reached the preview");
});

// ---- the sheet's own header is read ------------------------------------------

ait("the SEM list maps left to right onto the three year columns", async () => {
  const { meta, parsed } = await load();
  eq(meta.semesterList, ["03", "05", "07"]);
  eq(meta.timetableSemester, "III, V & VII");
  const byYear = {};
  parsed.cells.forEach((c) => { if (c.sem) byYear[c.year] = c.sem; });
  eq(byYear, { 2: "03", 3: "05", 4: "07" }, "a year column was given the wrong semester");
});

ait("the odd/even flag comes from the printed line, not from the SEM list", async () => {
  const { meta } = await load();
  eq(meta.semester, "Odd Semester");
  eq(meta.semesterEven, false);
});

ait("the printed title date range is read and both ends are ISO", async () => {
  const { meta } = await load();
  eq(meta.dateFrom, "2026-10-06");
  eq(meta.dateTo, "2026-10-16");
});

ait("the sitting, session and department are read from the header", async () => {
  const { meta } = await load();
  eq(meta.assessment, "Continuous Assessment Test-II");
  eq(meta.examTime, "9:30 AM \u2013 12:30 PM");
  eq(meta.session, "FN");
  eq(meta.department, "COMPUTER SCIENCE AND ENGINEERING");
});

ait("header and meta text never become exams", async () => {
  const { parsed } = await load();
  const blob = parsed.cells.map((c) => (c.code || "") + " " + (c.name || "")).join(" | ");
  // "ENGINEERING" is deliberately absent: OBJECT ORIENTED SOFTWARE ENGINEERING is a
  // real subject on this sheet, so only the words that appear NOWHERE in a subject
  // line can be used to catch header furniture.
  ["ODD", "TIME TABLE", "ACADEMIC YEAR", "THERESA", "ASSESSMENT", "TUTICORIN", "VAGAIKULAM", "SEMESTER"]
    .forEach((word) => ok(!blob.includes(word), "header text became an exam: " + word));
});

// ---- the preview the user confirms ------------------------------------------

ait("the preview is 15 ready rows, 2 ignored, and nothing blocked", async () => {
  const { preview } = await load();
  eq(preview.summary.total, 17, "row count");
  eq(preview.summary.ignored, 2, "ignored count");
  eq(preview.summary.valid, 15, "valid count");
  eq(preview.summary.ready, 15, "ready count");
  eq(preview.summary.blockedRows, 0, "blocked rows");
  eq(preview.summary.missingCodes, 0, "exams with no code");
  eq(preview.summary.missingNames, 0, "exams with no name");
  eq(preview.summary.duplicates, 0, "duplicate exams");
  eq(preview.summary.conflicts, 0, "conflicts");
});

ait("no preview row reports an invalid date", async () => {
  const { preview } = await load();
  const bad = preview.rows.filter((r) => (r.errors || []).some((e) => /DATE/i.test(e)));
  eq(bad.map((r) => r.date), [], "rows with a date error");
});

ait("every preview row points at the date and year column it was printed in", async () => {
  const { preview } = await load();
  const exams = preview.rows.filter((r) => !r.ignored);
  ok(exams.length === EXPECTED.length, "row count changed");
  exams.forEach((r) => {
    ok(/^date \d{4}-\d{2}-\d{2} · (I|II|III|IV) YEAR \(A & B\)$/.test(r.sourceCell),
      "unreadable sourceCell: " + r.sourceCell);
  });
});

module.exports = s;