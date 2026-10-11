// Generated fixtures: seventeen layouts the reader has never seen.
//
// The two real sheets in corpus/ are ruled, portrait, one page, dates down the left
// and staff always printed under the subject in a second row. A reader that quietly
// assumes THAT shape will pass both of them and still fail on the next sheet a
// college uploads. So the layouts here vary the things that actually vary between
// institutions:
//
//   ruled / borderless, portrait / landscape, one to four year columns,
//   dates down / dates across, FN+AN sessions, code / name / staff in separate
//   columns, subjects printed with no code, no staff and no sections, two
//   departments on one page, a table continuing onto page two, five ways of
//   writing a date, and year headings written as roman numerals, words and digits.
//
// A spec says what to DRAW and what the CORRECT ANSWER IS, in one place, so the
// expectation is written from the drawing and never from the reader's output.
// Dates are given as the string to print AND as the ISO date it means, because
// converting between them is the reader's job and must be tested, not assumed.

const COLLEGE = "Mother Theresa Engineering College";

// Styles mirror the real sheets: subjects, headers and dates in bold, staff in
// italic, non-exam activities in the plain body face.
const B = "b";
const I = "i";
const N = "n";

function titleBlock(lines) {
  return lines.map((l, i) => Object.assign({}, l, {
    size: l.size || (i === 0 ? 13 : 9.5),
    bold: i === 0,
    align: "center",
  }));
}

const TITLE = titleBlock([
  { text: COLLEGE },
  { text: "DEPARTMENT OF COMPUTER SCIENCE AND ENGINEERING" },
  { text: "ACADEMIC YEAR 2026-27   ODD SEMESTER   (III, V & VII)" },
  { text: "CONTINUOUS ASSESSMENT TEST 2" },
  { text: "SCHEDULE: 06.10.2026 TO 16.10.2026   TIME: 9:30 AM TO 12:30 PM" },
]);

// d = the date AS PRINTED, iso = what it means. An entry with no code and no name
// but a nonExam string is an activity, not an exam.
function E(d, y, code, name, staff, extra) {
  return Object.assign({ d, y, code, name, staff: staff || [] }, extra || {});
}
function NE(d, y, phrase) { return { d, y, code: null, name: null, nonExam: phrase, staff: [] }; }

const SPECS = [];

// -- 1. the shape both real sheets have, with sections in the year headings ----
SPECS.push({
  name: "ruled_3yr_sections",
  note: "ruled, dates down the left, three years across, sections in the header",
  layout: "years-across",
  dept: "CSE",
  sections: ["A", "B"],
  years: [2, 3, 4],
  yearHeaders: { 2: "II YEAR (A & B)", 3: "III YEAR (A & B)", 4: "IV YEAR (A & B)" },
  dates: {
    "06.10.2026": "2026-10-06", "07.10.2026": "2026-10-07", "08.10.2026": "2026-10-08",
    "09.10.2026": "2026-10-09", "14.10.2026": "2026-10-14", "15.10.2026": "2026-10-15",
  },
  title: TITLE,
  rows: 30,
  entries: [
    E("06.10.2026", 2, "CS25C01", "Discrete Mathematics", ["Dr. A. Kumar"]),
    E("06.10.2026", 3, "CS3501", "Theory of Computation", ["Ms. R. Iyer"]),
    E("06.10.2026", 4, "CS4501", "Compiler Design", ["Mr. B. Nair"]),
    E("07.10.2026", 2, "CS25C02", "Data Structures", ["Dr. S. Menon"]),
    E("07.10.2026", 3, "CS3502", "Database Management Systems", ["Ms. L. Das"]),
    E("07.10.2026", 4, "CS4502", "Operating Systems", ["Mr. P. Singh"]),
    E("08.10.2026", 2, "CS25C03", "Analog Circuits", ["Dr. K. Rao"]),
    NE("08.10.2026", 3, "NAAN MUDALVAN"),
    E("08.10.2026", 4, "CS4503", "Computer Networks", ["Ms. N. Pillai"]),
    E("09.10.2026", 2, "CS25C04", "Digital Logic", ["Mr. T. Varghese"]),
    E("09.10.2026", 3, "CS3504", "Software Engineering", ["Dr. M. Fernandes"]),
    E("09.10.2026", 4, "CS4504", "Theory of Computation", ["Mr. Y. Joseph"]),
    E("14.10.2026", 2, "CS25C05", "C Programming", ["Dr. A. Kumar"]),
    E("14.10.2026", 3, "CS3505", "Computer Architecture", ["Ms. R. Iyer"]),
    E("14.10.2026", 4, "CS4505", "Web Technology", ["Mr. B. Nair"]),
    E("15.10.2026", 2, "CS25C06", "Probability and Statistics", ["Dr. S. Menon"]),
    E("15.10.2026", 3, "CS3506", "Parallel Programming", ["Ms. L. Das"]),
    E("15.10.2026", 4, "CS4506", "Data Science", ["Mr. P. Singh"]),
  ],
  expectMeta: {
    academicYear: "2026-27", term: "odd",
    dateRange: { from: "2026-10-06", to: "2026-10-16" },
    timeRange: "9:30 AM TO 12:30 PM",
  },
});

// -- 2. a single-year sheet ---------------------------------------------------
SPECS.push({
  name: "ruled_1yr",
  note: "a single-year sheet, third year only",
  layout: "years-across",
  dept: "ECE",
  years: [3],
  dates: { "06.10.2026": "2026-10-06", "07.10.2026": "2026-10-07", "08.10.2026": "2026-10-08", "09.10.2026": "2026-10-09" },
  widths: [110, 370],
  title: titleBlock([
    { text: COLLEGE },
    { text: "DEPARTMENT OF ELECTRONICS AND COMMUNICATION ENGINEERING" },
    { text: "ACADEMIC YEAR 2026-27   ODD SEMESTER" },
    { text: "CONTINUOUS ASSESSMENT TEST 1" },
    { text: "DATES: 06.10.2026 TO 09.10.2026   TIME: 1:30 PM TO 4:30 PM" },
  ]),
  entries: [
    E("06.10.2026", 3, "EC3501", "Digital Signal Processing", ["Dr. V. Raman"]),
    E("07.10.2026", 3, "EC3502", "Analog Communication", ["Mr. S. Kumar"]),
    E("08.10.2026", 3, "EC3503", "VLSI Design", ["Dr. P. Nair"]),
    E("09.10.2026", 3, "EC3504", "Embedded Systems", ["Ms. A. Das"]),
  ],
  expectMeta: {
    academicYear: "2026-27", term: "odd", assessment: "continuous assessment test 1",
    dateRange: { from: "2026-10-06", to: "2026-10-09" }, timeRange: "1:30 PM TO 4:30 PM",
    session: "AN",
  },
});

// -- 3. four year columns -----------------------------------------------------
SPECS.push({
  name: "ruled_4yr",
  note: "four year columns, the widest table most colleges print",
  layout: "years-across",
  dept: "MECH",
  years: [1, 2, 3, 4],
  widths: [80, 112, 112, 112, 112],
  dates: { "06.10.2026": "2026-10-06", "07.10.2026": "2026-10-07", "08.10.2026": "2026-10-08" },
  title: TITLE,
  rows: 32,
  entries: [
    E("06.10.2026", 1, "ME1501", "Engineering Mathematics", ["Dr. R. Iyer"]),
    E("06.10.2026", 2, "ME2501", "Thermodynamics", ["Dr. K. Menon"]),
    E("06.10.2026", 3, "ME3501", "Machine Design", ["Dr. M. Rao"]),
    E("06.10.2026", 4, "ME4501", "Automobile Engineering", ["Dr. S. Nair"]),
    E("07.10.2026", 1, "ME1502", "Engineering Physics", ["Dr. P. Das"]),
    E("07.10.2026", 2, "ME2502", "Fluid Mechanics", ["Dr. T. Pillai"]),
    E("07.10.2026", 3, "ME3502", "Heat Transfer", ["Dr. Y. Singh"]),
    E("07.10.2026", 4, "ME4502", "Industrial Automation", ["Dr. B. Kumar"]),
    E("08.10.2026", 1, "ME1503", "Engineering Chemistry", ["Dr. L. Nair"]),
    E("08.10.2026", 2, "ME2503", "Engineering Graphics", ["Dr. N. Das"]),
    E("08.10.2026", 3, "ME3503", "Manufacturing Processes", ["Dr. V. Iyer"]),
    E("08.10.2026", 4, "ME4503", "CAD and CAM", ["Dr. A. Menon"]),
  ],
  expectMeta: { academicYear: "2026-27", term: "odd", dateRange: { from: "2026-10-06", to: "2026-10-16" } },
});

// -- 4. the transpose: dates across, years down ------------------------------
SPECS.push({
  name: "dates_across",
  note: "the transpose: dates across the top, years down the left",
  layout: "dates-across",
  dept: "CIVIL",
  years: [2, 3, 4],
  widths: [96, 104, 104, 104, 104],
  dates: {
    "06.10.2026": "2026-10-06", "07.10.2026": "2026-10-07",
    "08.10.2026": "2026-10-08", "09.10.2026": "2026-10-09",
  },
  title: TITLE,
  rows: 30,
  entries: [
    E("06.10.2026", 2, "CV2501", "Surveying", ["Dr. H. Iyer"]),
    E("07.10.2026", 2, "CV2502", "Concrete Technology", ["Dr. J. Nair"]),
    E("08.10.2026", 2, "CV2503", "Structural Mechanics", ["Dr. G. Das"]),
    E("09.10.2026", 2, "CV2504", "Geotechnical Engineering", ["Dr. F. Rao"]),
    E("06.10.2026", 3, "CV3501", "Design of Structures", ["Dr. D. Kumar"]),
    E("07.10.2026", 3, "CV3502", "Transportation Engineering", ["Dr. C. Menon"]),
    E("08.10.2026", 3, "CV3503", "Water Resources", ["Dr. E. Pillai"]),
    E("09.10.2026", 3, "CV3504", "Environmental Engineering", ["Dr. A. Singh"]),
    E("06.10.2026", 4, "CV4501", "Estimating and Costing", ["Dr. Z. Nair"]),
    E("07.10.2026", 4, "CV4502", "Construction Management", ["Dr. Y. Das"]),
    E("08.10.2026", 4, "CV4503", "Prestressed Concrete", ["Dr. X. Rao"]),
    E("09.10.2026", 4, "CV4504", "Project Work", ["Dr. W. Iyer"]),
  ],
  expectMeta: { academicYear: "2026-27", term: "odd", dateRange: { from: "2026-10-06", to: "2026-10-16" } },
});

// -- 5. landscape ------------------------------------------------------------
SPECS.push({
  name: "landscape_ruled",
  note: "the same ruled shape rotated onto a landscape page",
  layout: "years-across",
  page: { width: 842, height: 595 },
  dept: "CSE",
  sections: ["A", "B"],
  years: [2, 3, 4],
  yearHeaders: { 2: "II YEAR (A & B)", 3: "III YEAR (A & B)", 4: "IV YEAR (A & B)" },
  widths: [86, 150, 150, 150],
  dates: { "06.10.2026": "2026-10-06", "07.10.2026": "2026-10-07", "09.10.2026": "2026-10-09" },
  title: titleBlock([
    { text: COLLEGE },
    { text: "DEPARTMENT OF COMPUTER SCIENCE AND ENGINEERING" },
    { text: "ACADEMIC YEAR 2026-27   ODD SEMESTER   CAT II" },
    { text: "DATES 06.10.2026 TO 16.10.2026   TIME 9:30 AM TO 12:30 PM" },
  ]),
  top: 140,
  rows: 30,
  entries: [
    E("06.10.2026", 2, "CS25C01", "Discrete Mathematics", ["Dr. A. Kumar"]),
    E("06.10.2026", 3, "CS3501", "Theory of Computation", ["Ms. R. Iyer"]),
    E("06.10.2026", 4, "CS4501", "Compiler Design", ["Mr. B. Nair"]),
    E("07.10.2026", 2, "CS25C02", "Data Structures", ["Dr. S. Menon"]),
    E("07.10.2026", 3, "CS3502", "Database Management Systems", ["Ms. L. Das"]),
    E("07.10.2026", 4, "CS4502", "Operating Systems", ["Mr. P. Singh"]),
    E("09.10.2026", 2, "CS25C03", "Analog Circuits", ["Dr. K. Rao"]),
    E("09.10.2026", 3, "CS3503", "Software Engineering", ["Dr. M. Fernandes"]),
    E("09.10.2026", 4, "CS4503", "Theory of Computation", ["Mr. Y. Joseph"]),
  ],
  expectMeta: { academicYear: "2026-27", term: "odd", dateRange: { from: "2026-10-06", to: "2026-10-16" } },
});

// -- 6. NO RULES -------------------------------------------------------------
SPECS.push({
  name: "borderless",
  note: "no drawn rules anywhere; a cell exists only because the text is aligned",
  layout: "years-across",
  ruled: false,
  align: "left",
  dept: "CSE",
  years: [2, 3],
  widths: [110, 175, 175],
  dates: {
    "06.10.2026": "2026-10-06", "07.10.2026": "2026-10-07",
    "08.10.2026": "2026-10-08", "09.10.2026": "2026-10-09",
  },
  title: TITLE,
  rows: 34,
  entries: [
    E("06.10.2026", 2, "CS25C01", "Discrete Mathematics", ["Dr. A. Kumar"]),
    E("06.10.2026", 3, "CS3501", "Theory of Computation", ["Ms. R. Iyer"]),
    E("07.10.2026", 2, "CS25C02", "Data Structures", ["Dr. S. Menon"]),
    E("07.10.2026", 3, "CS3502", "Database Systems", ["Ms. L. Das"]),
    E("08.10.2026", 2, "CS25C03", "Analog Circuits", ["Dr. K. Rao"]),
    E("08.10.2026", 3, "CS3503", "Software Engineering", ["Dr. M. Fernandes"]),
    E("09.10.2026", 2, "CS25C04", "Digital Logic", ["Mr. T. Varghese"]),
    E("09.10.2026", 3, "CS3504", "Computer Architecture", ["Mr. Y. Joseph"]),
  ],
  expectMeta: { academicYear: "2026-27", term: "odd", dateRange: { from: "2026-10-06", to: "2026-10-16" } },
});

// -- 7. two sessions a day ---------------------------------------------------
SPECS.push({
  name: "fn_an_rows",
  note: "FN and AN printed as separate rows that share one date column",
  layout: "years-across",
  dept: "CSE",
  sessions: true,
  years: [2, 3],
  yearHeaders: { 2: "II YEAR (A)", 3: "III YEAR (A)" },
  widths: [104, 150, 150],
  dates: { "06.10.2026": "2026-10-06", "07.10.2026": "2026-10-07" },
  title: TITLE,
  rows: 30,
  entries: [
    E("06.10.2026", 2, "CS25C01", "Discrete Mathematics", ["Dr. A. Kumar"], { session: "FN" }),
    E("06.10.2026", 3, "CS3501", "Theory of Computation", ["Ms. R. Iyer"], { session: "FN" }),
    E("06.10.2026", 2, "CS25C07", "Probability and Statistics", ["Dr. S. Menon"], { session: "AN" }),
    E("06.10.2026", 3, "CS3507", "Computer Graphics", ["Ms. L. Das"], { session: "AN" }),
    E("07.10.2026", 2, "CS25C02", "Data Structures", ["Dr. K. Rao"], { session: "FN" }),
    E("07.10.2026", 3, "CS3502", "Database Systems", ["Dr. M. Fernandes"], { session: "FN" }),
    E("07.10.2026", 2, "CS25C08", "Probability and Combinatorics", ["Mr. T. Varghese"], { session: "AN" }),
    E("07.10.2026", 3, "CS3508", "Numerical Methods", ["Mr. Y. Joseph"], { session: "AN" }),
  ],
  expectMeta: { academicYear: "2026-27", term: "odd", dateRange: { from: "2026-10-06", to: "2026-10-16" } },
});

// -- 8. code / name / staff in separate columns ------------------------------
SPECS.push({
  name: "split_code_name_staff",
  note: "CODE | SUBJECT | STAFF in three separate columns per year",
  layout: "years-across-split",
  dept: "CSE",
  years: [2, 3],
  widths: [78, 62, 108, 62, 108, 62, 108],
  dates: { "06.10.2026": "2026-10-06", "07.10.2026": "2026-10-07" },
  title: TITLE,
  rows: 30,
  entries: [
    E("06.10.2026", 2, "CS25C01", "Discrete Mathematics", ["Dr. A. Kumar"]),
    E("06.10.2026", 3, "CS3501", "Theory of Computation", ["Ms. R. Iyer"]),
    E("07.10.2026", 2, "CS25C02", "Data Structures", ["Dr. S. Menon"]),
    E("07.10.2026", 3, "CS3502", "Database Systems", ["Ms. L. Das"]),
  ],
  expectMeta: { academicYear: "2026-27", term: "odd", dateRange: { from: "2026-10-06", to: "2026-10-16" } },
});

// -- 9. nothing optional is printed ------------------------------------------
SPECS.push({
  name: "no_staff_no_sections",
  note: "no staff line and no section letters anywhere in the file",
  layout: "years-across",
  dept: "CSE",
  years: [2, 3],
  widths: [100, 150, 150],
  dates: { "06.10.2026": "2026-10-06", "07.10.2026": "2026-10-07", "08.10.2026": "2026-10-08" },
  title: titleBlock([
    { text: COLLEGE },
    { text: "DEPARTMENT OF COMPUTER SCIENCE AND ENGINEERING" },
    { text: "ACADEMIC YEAR 2026-27   EVEN SEMESTER" },
    { text: "END SEMESTER EXAMINATION TIMETABLE" },
    { text: "06.10.2026 TO 16.10.2026" },
  ]),
  entries: [
    E("06.10.2026", 2, "CS2601", "Discrete Mathematics"),
    E("06.10.2026", 3, "CS3601", "Theory of Computation"),
    E("07.10.2026", 2, "CS2602", "Data Structures"),
    E("07.10.2026", 3, "CS3602", "Database Systems"),
    E("08.10.2026", 2, "CS2603", "Analog Circuits"),
    E("08.10.2026", 3, "CS3603", "Software Engineering"),
  ],
  expectMeta: {
    academicYear: "2026-27", term: "even", dateRange: { from: "2026-10-06", to: "2026-10-16" },
  },
  expectNoSections: true,
  allowNoStaff: true,
});

// -- 10. subjects with no course code ----------------------------------------
SPECS.push({
  name: "subjects_without_codes",
  note: "subjects printed with a name only, no course code at all",
  layout: "years-across",
  dept: "CSE",
  years: [2, 3],
  widths: [100, 150, 150],
  dates: { "06.10.2026": "2026-10-06", "07.10.2026": "2026-10-07", "08.10.2026": "2026-10-08" },
  title: TITLE,
  entries: [
    E("06.10.2026", 2, null, "Discrete Mathematics", ["Dr. A. Kumar"]),
    E("06.10.2026", 3, null, "Theory of Computation", ["Ms. R. Iyer"]),
    E("07.10.2026", 2, null, "Data Structures", ["Dr. S. Menon"]),
    E("07.10.2026", 3, null, "Database Systems", ["Ms. L. Das"]),
    E("08.10.2026", 2, null, "Analog Circuits", ["Dr. K. Rao"]),
    E("08.10.2026", 3, null, "Software Engineering", ["Dr. M. Fernandes"]),
  ],
  allowNoCode: true,
  expectMeta: { academicYear: "2026-27", term: "odd", dateRange: { from: "2026-10-06", to: "2026-10-16" } },
});

// -- 11. a common paper for every section -----------------------------------
SPECS.push({
  name: "first_year_common",
  note: "a first-year common paper shared by every section",
  layout: "years-across",
  dept: "CSE",
  years: [1, 2],
  yearHeaders: { 1: "I YEAR (A & B & C)", 2: "II YEAR (A & B)" },
  widths: [96, 158, 158],
  dates: {
    "06.10.2026": "2026-10-06", "07.10.2026": "2026-10-07",
    "08.10.2026": "2026-10-08", "09.10.2026": "2026-10-09",
  },
  title: TITLE,
  entries: [
    E("06.10.2026", 1, "HS1501", "English", ["Dr. A. Kumar"]),
    E("06.10.2026", 2, "CS25C01", "Discrete Mathematics", ["Ms. R. Iyer"]),
    E("07.10.2026", 1, "HS1502", "Mathematics", ["Dr. S. Menon"]),
    E("07.10.2026", 2, "CS25C02", "Data Structures", ["Ms. L. Das"]),
    E("08.10.2026", 1, "HS1503", "Physics", ["Dr. K. Rao"]),
    E("08.10.2026", 2, "CS25C03", "Analog Circuits", ["Dr. M. Fernandes"]),
    E("09.10.2026", 1, "HS1504", "Chemistry", ["Mr. T. Varghese"]),
    E("09.10.2026", 2, "CS25C04", "Digital Logic", ["Mr. Y. Joseph"]),
  ],
  expectMeta: { academicYear: "2026-27", term: "odd", dateRange: { from: "2026-10-06", to: "2026-10-16" } },
});

// -- 12. two departments on one page -----------------------------------------
SPECS.push({
  name: "two_departments_one_page",
  note: "CSE above ECE, each with its own table, on a single page",
  layout: "years-across",
  ruled: true,
  dept: "CSE",
  sections: ["A", "B"],
  years: [2, 3],
  yearHeaders: { 2: "II YEAR (A & B)", 3: "III YEAR (A & B)" },
  widths: [92, 130, 130],
  dates: { "06.10.2026": "2026-10-06", "07.10.2026": "2026-10-07" },
  title: titleBlock([
    { text: COLLEGE },
    // Each table is headed by its own department, exactly as the second one is:
    // a sheet that names one department above the top table only would be testing
    // something no real college prints.
    { text: "DEPARTMENT OF COMPUTER SCIENCE AND ENGINEERING" },
    { text: "ACADEMIC YEAR 2026-27   ODD SEMESTER   CAT II" },
    { text: "DATES 06.10.2026 TO 16.10.2026   TIME 9:30 AM TO 12:30 PM" },
  ]),
  top: 130,
  rows: 26,
  entries: [
    E("06.10.2026", 2, "CS25C01", "Discrete Mathematics", ["Dr. A. Kumar"]),
    E("06.10.2026", 3, "CS3501", "Theory of Computation", ["Ms. R. Iyer"]),
    E("07.10.2026", 2, "CS25C02", "Data Structures", ["Dr. S. Menon"]),
    E("07.10.2026", 3, "CS3502", "Database Systems", ["Ms. L. Das"]),
  ],
  secondTable: {
    // A second table lower down the page, under its own department line.
    label: "DEPARTMENT OF ELECTRONICS AND COMMUNICATION ENGINEERING",
    code: "ECE",
    years: [3, 4],
    widths: [92, 130, 130],
    top: 330,
    entries: [
      E("06.10.2026", 3, "EC3501", "Digital Signal Processing", ["Dr. V. Raman"]),
      E("06.10.2026", 4, "EC4501", "VLSI Design", ["Mr. S. Kumar"]),
      E("07.10.2026", 3, "EC3502", "Analog Communication", ["Dr. P. Nair"]),
      E("07.10.2026", 4, "EC4502", "Embedded Systems", ["Ms. A. Das"]),
    ],
  },
  expectMeta: { academicYear: "2026-27", term: "odd", dateRange: { from: "2026-10-06", to: "2026-10-16" } },
  expectTables: 2,
});

// -- 13. a table that runs onto page two -------------------------------------
SPECS.push({
  name: "two_page_table",
  note: "one table continuing onto page two with the header repeated",
  layout: "years-across",
  dept: "CSE",
  years: [2, 3],
  widths: [92, 150, 150],
  dates: {
    "06.10.2026": "2026-10-06", "07.10.2026": "2026-10-07", "08.10.2026": "2026-10-08",
    "09.10.2026": "2026-10-09", "14.10.2026": "2026-10-14",
  },
  title: TITLE,
  top: 190,
  rows: 30,
  entries: [
    E("06.10.2026", 2, "CS25C01", "Discrete Mathematics", ["Dr. A. Kumar"]),
    E("06.10.2026", 3, "CS3501", "Theory of Computation", ["Ms. R. Iyer"]),
    E("07.10.2026", 2, "CS25C02", "Data Structures", ["Dr. S. Menon"]),
    E("07.10.2026", 3, "CS3502", "Database Systems", ["Ms. L. Das"]),
    E("08.10.2026", 2, "CS25C03", "Analog Circuits", ["Dr. K. Rao"]),
    E("08.10.2026", 3, "CS3503", "Software Engineering", ["Dr. M. Fernandes"]),
  ],
  secondPage: {
    title: [{ text: "CONTINUED", size: 10, bold: true, align: "center" }],
    top: 80,
    entries: [
      E("09.10.2026", 2, "CS25C04", "Digital Logic", ["Mr. T. Varghese"]),
      E("09.10.2026", 3, "CS3504", "Computer Architecture", ["Mr. Y. Joseph"]),
      E("14.10.2026", 2, "CS25C05", "C Programming", ["Dr. A. Kumar"]),
      E("14.10.2026", 3, "CS3505", "Parallel Programming", ["Ms. R. Iyer"]),
    ],
  },
  expectMeta: { academicYear: "2026-27", term: "odd", dateRange: { from: "2026-10-06", to: "2026-10-16" } },
});

// -- 14. five ways of writing the same date ----------------------------------
SPECS.push({
  name: "date_formats",
  note: "five ways of writing a date, one of them ambiguous on its own",
  layout: "years-across",
  dept: "CSE",
  years: [2, 3],
  widths: [124, 140, 140],
  dates: {
    "06-Oct-2026": "2026-10-06",
    "7th October 2026": "2026-10-07",
    "Oct 8, 2026": "2026-10-08",
    "09-10-2026": "2026-10-09",
    "14.10.2026": "2026-10-14",
  },
  title: titleBlock([
    { text: COLLEGE },
    { text: "DEPARTMENT OF COMPUTER SCIENCE AND ENGINEERING" },
    { text: "ACADEMIC YEAR 2026-27   ODD SEMESTER" },
    { text: "SCHEDULE 06-Oct-2026 to 16-Oct-2026" },
  ]),
  entries: [
    E("06-Oct-2026", 2, "CS25C01", "Discrete Mathematics", ["Dr. A. Kumar"]),
    E("06-Oct-2026", 3, "CS3501", "Theory of Computation", ["Ms. R. Iyer"]),
    E("7th October 2026", 2, "CS25C02", "Data Structures", ["Dr. S. Menon"]),
    E("7th October 2026", 3, "CS3502", "Database Systems", ["Ms. L. Das"]),
    E("Oct 8, 2026", 2, "CS25C03", "Analog Circuits", ["Dr. K. Rao"]),
    E("Oct 8, 2026", 3, "CS3503", "Software Engineering", ["Dr. M. Fernandes"]),
    E("09-10-2026", 2, "CS25C04", "Digital Logic", ["Mr. T. Varghese"]),
    E("09-10-2026", 3, "CS3504", "Computer Architecture", ["Mr. Y. Joseph"]),
    E("14.10.2026", 2, "CS25C05", "C Programming", ["Dr. A. Kumar"]),
    E("14.10.2026", 3, "CS3505", "Parallel Programming", ["Ms. R. Iyer"]),
  ],
  expectMeta: {
    academicYear: "2026-27", term: "odd", dateRange: { from: "2026-10-06", to: "2026-10-16" },
  },
});

// -- 15. year headings in four different styles ------------------------------
SPECS.push({
  name: "roman_and_arabic_years",
  note: "year headings written as words, roman numerals and digits in one table",
  layout: "years-across",
  dept: "CSE",
  years: [1, 2, 3, 4],
  yearHeaders: { 1: "FIRST YEAR", 2: "II YEAR", 3: "THIRD YEAR", 4: "4th YEAR" },
  widths: [82, 110, 110, 110, 110],
  dates: { "06.10.2026": "2026-10-06", "07.10.2026": "2026-10-07" },
  title: TITLE,
  rows: 30,
  entries: [
    E("06.10.2026", 1, "CS1501", "Basics of C", ["Dr. A. Kumar"]),
    E("06.10.2026", 2, "CS2501", "Data Structures", ["Dr. S. Menon"]),
    E("06.10.2026", 3, "CS3501", "Theory of Computation", ["Ms. R. Iyer"]),
    E("06.10.2026", 4, "CS4501", "Compiler Design", ["Mr. B. Nair"]),
    E("07.10.2026", 1, "CS1502", "Programming Laboratory", ["Dr. P. Das"]),
    E("07.10.2026", 2, "CS2502", "Discrete Mathematics", ["Ms. L. Das"]),
    E("07.10.2026", 3, "CS3502", "Database Systems", ["Mr. T. Varghese"]),
    E("07.10.2026", 4, "CS4502", "Operating Systems", ["Dr. M. Fernandes"]),
  ],
  expectMeta: { academicYear: "2026-27", term: "odd", dateRange: { from: "2026-10-06", to: "2026-10-16" } },
});

// -- 16. a department the master list has never heard of ---------------------
SPECS.push({
  name: "department_not_in_master",
  note: "a department the master list has never heard of",
  layout: "years-across",
  dept: null,
  unknownDeptName: "FOOD TECHNOLOGY",
  unknownDeptLabel: "DEPARTMENT OF FOOD TECHNOLOGY",
  years: [2, 3],
  widths: [100, 150, 150],
  dates: { "06.10.2026": "2026-10-06", "07.10.2026": "2026-10-07" },
  title: titleBlock([
    { text: COLLEGE },
    { text: "DEPARTMENT OF FOOD TECHNOLOGY" },
    { text: "ACADEMIC YEAR 2026-27   ODD SEMESTER" },
    { text: "DATES 06.10.2026 TO 16.10.2026" },
  ]),
  entries: [
    E("06.10.2026", 2, "FT2501", "Food Chemistry", ["Dr. A. Kumar"]),
    E("06.10.2026", 3, "FT3501", "Food Microbiology", ["Ms. R. Iyer"]),
    E("07.10.2026", 2, "FT2502", "Food Processing", ["Dr. S. Menon"]),
    E("07.10.2026", 3, "FT3502", "Food Safety", ["Ms. L. Das"]),
  ],
  expectMeta: { academicYear: "2026-27", term: "odd", dateRange: { from: "2026-10-06", to: "2026-10-16" } },
});

// -- 17. borderless with wide gutters ----------------------------------------
SPECS.push({
  name: "wide_padding_borderless",
  note: "borderless, with wide gutters and tall rows, so nothing touches",
  layout: "years-across",
  ruled: false,
  align: "left",
  font: 10,
  dept: "CSE",
  years: [2, 3],
  widths: [136, 190, 190],
  dates: {
    "06.10.2026": "2026-10-06", "07.10.2026": "2026-10-07",
    "08.10.2026": "2026-10-08", "09.10.2026": "2026-10-09",
  },
  title: titleBlock([
    { text: COLLEGE },
    { text: "DEPARTMENT OF COMPUTER SCIENCE AND ENGINEERING" },
    { text: "ACADEMIC YEAR 2026-27   ODD SEMESTER   CAT II" },
    { text: "DATES 06.10.2026 TO 16.10.2026   TIME 9:30 AM TO 12:30 PM" },
  ]),
  top: 200,
  rows: 46,
  entries: [
    E("06.10.2026", 2, "CS25C01", "Discrete Mathematics", ["Dr. A. Kumar"]),
    E("06.10.2026", 3, "CS3501", "Theory of Computation", ["Ms. R. Iyer"]),
    E("07.10.2026", 2, "CS25C02", "Data Structures", ["Dr. S. Menon"]),
    E("07.10.2026", 3, "CS3502", "Database Systems", ["Ms. L. Das"]),
    E("08.10.2026", 2, "CS25C03", "Analog Circuits", ["Dr. K. Rao"]),
    E("08.10.2026", 3, "CS3503", "Software Engineering", ["Dr. M. Fernandes"]),
    E("09.10.2026", 2, "CS25C04", "Digital Logic", ["Mr. T. Varghese"]),
    E("09.10.2026", 3, "CS3504", "Computer Architecture", ["Mr. Y. Joseph"]),
  ],
  expectMeta: { academicYear: "2026-27", term: "odd", dateRange: { from: "2026-10-06", to: "2026-10-16" } },
});

// Build the golden expectation straight from the entries, so a test failure means
// the reader disagreed with the drawing rather than with itself.
function golden(spec) {
  const exams = [];
  /* Each table's entries are grouped under THAT table's department. Grouping them
     all under the first department merges one department's third-year paper with
     another department's third-year paper on the same day into a single exam that
     exists on no page at all. A continuation on page two belongs to the first
     table, so it keeps the first department. */
  const sources = [
    { dept: spec.dept, entries: spec.entries || [] },
    { dept: (spec.secondTable && spec.secondTable.code) || spec.dept,
      entries: (spec.secondTable && spec.secondTable.entries) || [] },
    { dept: spec.dept, entries: (spec.secondPage && spec.secondPage.entries) || [] },
  ];
  sources.forEach((src) => src.entries.forEach((e) => {
      const iso = spec.dates[e.d];
      const dept = src.dept || spec.unknownDeptName || "?";
      const key = dept + "|" + iso + "|" + e.y + "|" + (e.session || "");
      let b = exams.filter((x) => x.key === key)[0];
      if (!b) {
        b = { key, dept, date: iso, year: e.y, session: e.session || null, subjects: [], nonExam: [], staff: [] };
        exams.push(b);
      }
      if (e.nonExam) b.nonExam.push(e.nonExam);
      else b.subjects.push({ code: e.code, name: e.name });
      e.staff.forEach((s) => { if (b.staff.indexOf(s) < 0) b.staff.push(s); });
    }));
  return {
    name: spec.name,
    note: spec.note,
    layout: spec.layout,
    ruled: spec.ruled !== false,
    sessions: !!spec.sessions,
    allowNoCode: !!spec.allowNoCode,
    allowNoStaff: !!spec.allowNoStaff,
    expectNoSections: !!spec.expectNoSections,
    unknownDept: spec.dept ? null : spec.unknownDeptName,
    deptCode: spec.dept || null,
    secondDeptCode: (spec.secondTable && spec.secondTable.code) || null,
    sections: spec.sections || null,
    years: spec.years,
    expectTables: spec.expectTables || 1,
    meta: spec.expectMeta || {},
    exams: exams,
  };
}

module.exports = { SPECS, COLLEGE, B, I, N, titleBlock, golden };