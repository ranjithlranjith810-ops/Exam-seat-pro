// Unit tests for the new staged reader in cat_core.js.
//
// These test the CONTENT decisions in isolation: how a date, a year label, a
// subject code and a member of staff are read out of a single cell. Nothing here
// looks at where the cell sits on the page, which is the whole point - the same
// text is read the same way in any position.
//
// The layout-level behaviour (rules, grid, header, orientation) is covered by
// cat_corpus.test.js against real and generated PDFs.
const h = require("./harness.js");
const C = require("./cat_core.js");
const s = h.suite("cat_core.test.js \u2014 content reading, one cell at a time");
const { it, eq, ok } = s;

// A cell as the stages build it: text plus the words inside it.
function cell(text, extra) {
  return Object.assign({
    text: String(text),
    words: String(text).split(/\s+/).filter(Boolean).map((w) => ({ text: w })),
  }, extra || {});
}

// ---- dates --------------------------------------------------------------
  it("reads the college's own numeric format 06.10.2026", () => {
    eq(C.parseDate("06.10.2026", {}).iso, "2026-10-06");
  });
  it("accepts slashes and hyphens as well as dots", () => {
    eq(C.parseDate("06/10/2026", {}).iso, "2026-10-06");
    eq(C.parseDate("06-10-2026", {}).iso, "2026-10-06");
  });
  it("reads a named month", () => {
    eq(C.parseDate("06 Oct 2026", {}).iso, "2026-10-06");
    eq(C.parseDate("6th October 2026", {}).iso, "2026-10-06");
    eq(C.parseDate("Oct 6, 2026", {}).iso, "2026-10-06");
  });
  it("reads a named month written the way a college writes it: 06-Oct-2026", () => {
    eq(C.parseDate("06-Oct-2026", {}).iso, "2026-10-06");
    eq(C.parseDate("16-OCT-2026", {}).iso, "2026-10-16");
    eq(C.parseDate("6.Oct.2026", {}).iso, "2026-10-06");
  });
  it("finds every date-looking run of text, and no others", () => {
    eq(C.dateTokensIn("SCHEDULE 06-Oct-2026 to 16-Oct-2026").length, 2);
    eq(C.dateTokensIn("DATES 06.10.2026 TO 16.10.2026   TIME 9:30 AM TO 12:30 PM").length, 2,
      "the clock times are not dates");
    eq(C.dateTokensIn("ACADEMIC YEAR 2026-27 ODD SEMESTER").length, 0,
      "an academic year is not a date");
    eq(C.dateTokensIn("06.10.2026 FN").length, 1, "a session suffix is not part of the date");
  });
  it("swaps the order only when one part cannot be a month", () => {
    eq(C.parseDate("12/31/2026", {}).iso, "2026-12-31", "12/31 can only be month-first");
    eq(C.parseDate("31/12/2026", {}).iso, "2026-12-31", "31/12 can only be day-first");
  });
  it("keeps the weekday and checks it against the date", () => {
    eq(C.parseDate("06.10.2026 TUESDAY", {}).weekday, "TUESDAY");
    eq(C.parseDate("06.10.2026 TUESDAY", {}).weekdayMatches, true);
    eq(C.parseDate("06.10.2026 MONDAY", {}).weekdayMatches, false);
  });
  it("rejects a date that does not exist rather than shifting it", () => {
    eq(C.parseDate("31.02.2026", {}), null, "31 February must not become 3 March");
  });
  it("never settles 03.04 silently: it stays flagged", () => {
    const d = C.parseDate("03.04.2026", {});
    eq(d.ambiguous, true);
    ok(d.conf.level === "low", "an unsettled ambiguity must be low confidence");
    ok(d.candidates.length === 2, "both readings must be offered");
  });
  it("uses the title range to settle an ambiguity when exactly one fits", () => {
    eq(C.parseDate("03.04.2026", { range: { from: "2026-03-25", to: "2026-04-05" } }).iso, "2026-04-03");
    eq(C.parseDate("03.04.2026", { range: { from: "2026-02-01", to: "2026-03-10" } }).iso, "2026-03-04");
  });
  it("leaves the ambiguity flagged when the range does not help", () => {
    const d = C.parseDate("03.04.2026", { range: { from: "2020-01-01", to: "2030-12-31" } });
    eq(d.ambiguous, true, "a range that contains both readings settles nothing");
  });
  it("reads a bare day number only once the month is known", () => {
    eq(C.parseDate("15", {}), null);
    eq(C.parseDate("15", { month: 10, year: 2026 }).iso, "2026-10-15");
  });
  it("does not read a word as a date", () => {
    eq(C.parseDate("NAAN MUDALVAN", {}), null);
  });

  // ---- year labels --------------------------------------------------------
  it("reads Roman and Arabic year labels to the same number", () => {
    eq(C.parseYearLabel("II YEAR").year, 2);
    eq(C.parseYearLabel("2nd YEAR").year, 2);
    eq(C.parseYearLabel("THIRD YEAR").year, 3);
  });
  it("reads a semester and does NOT invent a year from it", () => {
    const y = C.parseYearLabel("SEM: III & V");
    eq(y.semester, 3);
    eq(y.year, null, "SEM is a semester, not a year");
  });
  it("does not read ordinary text as a year", () => {
    eq(C.parseYearLabel("THEORY"), null);
  });
  it("matches a department that only adds a generic tail word", () => {
    const master = [{ code: "AI&DS", name: "Artificial Intelligence and Data Science" }];
    const r = C.resolveDepartment("ARTIFICIAL INTELLIGENCE AND DATA SCIENCE ENGINEERING", master);
    eq(r.department.code, "AI&DS");
    eq(r.needsConfirmation, false, "the whole distinctive name still matched word for word");
    ok(/ENGINEERING/.test(r.conf.why), "the dropped word is named rather than hidden");
  });
  it("does not use the tail rule to rescue a name that differs", () => {
    const master = [{ code: "AI&DS", name: "Artificial Intelligence and Data Science" }];
    const r = C.resolveDepartment("ARTIFICIAL INTELLIGENCE AND DATA TECHNOLOGY ENGINEERING", master);
    ok(r.route !== "alias" && r.route !== "exact",
      "the tail rule did not treat this as a match just because it ends in ENGINEERING");
    eq(r.needsConfirmation, true);
  });
  it("takes the semesters from the labelled SEM: and not from ODD SEMESTER", () => {
    const m = C.extractMeta([
      { text: "ACADEMIC YEAR 2026-27 | ODD SEMESTER" },
      { text: "SEM: III, V & VII   TIME: 9:30 AM TO 12:30 PM" },
    ]);
    eq(m.fields.semesterValue, "III, V & VII", "the semesters the sheet is actually for");
    eq(m.fields.semesterLine, "SEM: III, V & VII");
  });
  it("says so when the sheet names no semesters at all", () => {
    const m = C.extractMeta([{ text: "ACADEMIC YEAR 2026-27  ODD SEMESTER" }]);
    eq(m.fields.semesterValue, undefined, "nothing was invented for a value that was never printed");
    eq(m.conf.semesterLine.level, "medium", "but the word itself was really printed");
  });

  // ---- sessions -----------------------------------------------------------
  it("reads FN and AN", () => {
    eq(C.parseSessionLabel("FN").session, "FN");
    eq(C.parseSessionLabel("AN").session, "AN");
  });
  it("matches session words whole, so substrings do not count", () => {
    eq(C.parseSessionLabel("MANDATE"), null, "MANDATE contains AN");
    eq(C.parseSessionLabel("FINANCE"), null, "FINANCE starts FN");
  });
  it("takes the session vocabulary from the caller", () => {
    eq(C.parseSessionLabel("P1", { P1: ["P1"] }).session, "P1");
  });

  // ---- subject codes ------------------------------------------------------
  it("reads every code shape the college actually prints", () => {
    const codes = ["CS3591", "CCS375", "CS25C10", "GE3751A", "CB 3491",
                   "AD25C01", "MA25C08", "CW3551", "MR21CS105", "CS25105", "CS3591P"];
    codes.forEach((c) => {
      const sc = C.scoreCodeToken(c);
      ok(sc && sc.score >= 0.7, c + " should read as a code, got " + JSON.stringify(sc));
    });
  });
  it("does not read names, honorifics or words as codes", () => {
    ["Ms", "Dr", "S.P", "ABANDONED", "THEORY", "DATA", "ABCDEFGHIJ1"].forEach((c) => {
      const sc = C.scoreCodeToken(c);
      ok(!(sc && sc.score >= 0.7), c + " should not read as a code");
    });
  });
  it("splits code and name and keeps the name's capitalisation", () => {
    const p = C.parseSubject(cell("CS3591 - TheoryofComputation"));
    eq(p.code, "CS3591");
    eq(p.name, "TheoryofComputation");
    eq(p.conf.level, "high", "a code, a separator and a name is a certain reading");
  });
  it("reads a code printed with no separator, and says so", () => {
    const p = C.parseSubject(cell("CS3551DataStructures"));
    eq(p.code, "CS3551", "the code must not swallow the D of Data");
    eq(p.name, "DataStructures");
    eq(p.conf.level, "low");
    eq(C.parseSubject(cell("CS25C10DataStructures")).code, "CS25C10");
    eq(C.parseSubject(cell("MR21CS105DataStructures")).code, "MR21CS105");
  });
  it("accepts a subject name with no code at all", () => {
    eq(C.parseSubject(cell("SELF STUDY")).code, null);
  });

  // ---- borders ------------------------------------------------------------
  it("counts a stroked line as a border and ignores a filled shape", () => {
    const OPS = require("pdfjs-dist/legacy/build/pdf.js").OPS;
    const box = { x0: 0, x1: 600, top: 0, bottom: 800 };
    const line = (y) => {
      const r = C.rulesFromOperators({
        fnArray: [OPS.constructPath, OPS.stroke],
        argsArray: [[[OPS.moveTo, OPS.lineTo], [10, y, 590, y]], null],
      }, 1, box, OPS);
      return r.h.length;
    };
    const filled = C.rulesFromOperators({
      fnArray: [OPS.constructPath, OPS.fill],
      argsArray: [[[OPS.moveTo, OPS.lineTo, OPS.lineTo, OPS.lineTo],
                   [10, 100, 590, 100, 590, 130, 10, 130]], null],
    }, 1, box, OPS);
    eq(line(100), 1, "a drawn line is a border");
    eq(filled.h.length + filled.v.length, 0,
      "a shaded band or a logo is painted, not drawn, so its edges are not borders");
  });

  // ---- staff --------------------------------------------------------------
  it("reads a glued title and name as one person", () => {
    eq(C.parseStaff(cell("Dr.KM.AbubackkarSithiq", { italic: true })).names[0], "Dr.KM.AbubackkarSithiq");
  });
  it("does not let a word that starts like a title count as one", () => {
    eq(C.honorificOf("DRAFT"), null);
  });
  it("splits two staff on & without breaking initials", () => {
    const p = C.parseStaff(cell("Ms.P.Jebarajathi & Dr.K.AbubackkarSithiq"));
    eq(p.names.length, 2);
    eq(p.names[0], "Ms.P.Jebarajathi", "the dot in P. is an initial, not a separator");
    eq(p.names[1], "Dr.K.AbubackkarSithiq");
  });
  it("does not read an all-caps activity label as a person", () => {
    eq(C.parseStaff(cell("NAAN MUDALVAN")), null);
    eq(C.parseStaff(cell("MODEL EXAM")), null);
  });

  // ---- classification -----------------------------------------------------
  const type = (text, extra) => C.classifyCell(cell(text, extra), {}).type;

  it("classifies each kind of cell", () => {
    eq(type("06.10.2026"), "DATE");
    eq(type("II YEAR"), "YEAR_LABEL");
    eq(type("FN"), "SESSION");
    eq(type("CS3591 - Theory"), "SUBJECT");
    eq(type("SELF STUDY"), "SUBJECT");
    eq(type("NAAN MUDALVAN"), "NON_EXAM");
    eq(type("Dr.KM.AbubackkarSithiq"), "STAFF");
    eq(type("   "), "EMPTY");
  });
  it("leaves unrecognised debris as UNKNOWN instead of inventing a subject", () => {
    eq(type("zzzz qqqq"), "UNKNOWN");
  });
  it("breaks the name-vs-subject tie on evidence, not position", () => {
    eq(type("Self Study"), "SUBJECT", "no code, no title, no italic: a subject name");
    eq(type("Aswin Vijayaraghavan", { italic: true }), "STAFF", "italic type is evidence of a person");
eq(type("R. Jebarajathi"), "SUBJECT", "no title and no italic is not enough to call it staff");
  });
it("a cell knows whether its text was italic or bold", () => {
  const word = (t, cy, style) => Object.assign(
    { text: t, x0: 10, x1: 60, cx: 35, top: cy, bottom: cy + 8, cy: cy + 4, italic: false, bold: false }, style);
  const grid = { xs: [0, 100], ys: [0, 20, 40, 60], bands: 3, cols: 1, page: 1 };
  const cells = C.cellsFromGrid(grid, [
    word("Ms. A", 2, { italic: true }),
    word("CS3591", 22, { bold: true }),
    word("Self", 42, {}),
  ], {});
  eq(cells.map((c) => c.text), ["Ms. A", "CS3591", "Self"], "one word per band");
  eq(cells[0].italic, true, "the staff cell is italic");
  eq(cells[1].bold, true, "the subject cell is bold");
  eq(cells[2].italic, false);
  eq(cells[2].bold, false);
});

it("bold name-shaped text with no code reads as a subject, not staff", () => {
  const r = C.classifyCell({ text: "Data Structures", bold: true, italic: false, words: [] }, {});
  eq(r.type, "SUBJECT");
  eq(r.name, "Data Structures");
});

it("italic name-shaped text with no title reads as staff", () => {
  const r = C.classifyCell({ text: "Aswin Vijayaraghavan", bold: false, italic: true, words: [] }, {});
  eq(r.type, "STAFF");
  eq(r.staff, ["Aswin Vijayaraghavan"]);
});

it("a subject name printed without a code is recorded without inventing one", () => {
  const words = ["Data", "Structures"].map((t, i) =>
    ({ text: t, x0: i * 40, x1: i * 40 + 38, cx: i * 40 + 19, top: 0, bottom: 9, cy: 4 }));
  const r = C.classifyCell({ text: "Data Structures", words }, {});
  eq(r.type, "SUBJECT");
  eq(r.code, null, "there is no code to invent");
  eq(r.codeConf.level, "none");
});

module.exports = s;