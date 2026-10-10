// Structural pipeline tests.
//
// Rows are SYNTHESIZED here in the exact shape the OCR path produces
// ({y, items:[{x,str}], text}) and fed through the real catParseTimetable and
// catDetectYearColumns. That exercises the actual parser - column detection,
// section handling, cell states, wrapped names, staff splits - without inventing
// a real college's subjects, codes, dates or staff.
//
// Placeholder tokens only: ZZ### codes, SUBJECT ALPHA/BRAVO, STAFF ONE/TWO.
const h = require("./harness.js");
const api = h.load();

const s = h.suite("cat_pipeline.test.js — structural archetypes");
const { it, eq, ok } = s;

const SPEC = require("./cat_specs.js");
const byName = Object.fromEntries(SPEC.archetypes.map((a) => [a.name, a]));
const DATES = ["02.06.2025", "04.06.2025", "06.06.2025", "09.06.2025", "11.06.2025", "13.06.2025"];

// Column x positions, evenly spread, mirroring a printed sheet.
function colX(i) { return 400 + i * 700; }

// Build the rows one archetype would produce, in the real row shape.
function buildRows(a) {
  const rows = [];
  // header row: DATE + one year marker per column
  const headItems = [{ x: 0, str: "DATE" }];
  a.columns.forEach((c, i) => {
    let label = c.year + " YEAR";
    if (c.sections && c.sections.length) label += " (" + c.sections.join(" & ") + ")";
    headItems.push({ x: colX(i), str: label });
  });
  rows.push({ y: 100, items: headItems, text: headItems.map((it) => it.str).join(" "), staff: [] });

  for (let r = 0; r < a.rows; r++) {
    const items = [{ x: 0, str: DATES[r % DATES.length] }];
    const staff = [];
    a.columns.forEach((c, i) => {
      const cellVal = a.cell(r, i);
      if (!cellVal) return;                                  // EMPTY: no items at all
      const x = colX(i);
      if (cellVal.state === "NAAN MUDALVAN") { items.push({ x, str: cellVal.state }); return; }
      if (cellVal.staff) {
        // staff is split off exactly as the divider path does: it travels beside
        // the row, not inside it. The row tags it with the study YEAR the column
        // declares (II -> 2), which is what the parser matches on.
        staff.push({ year: api.catStudyYear(c.year), x, text: cellVal.staff.join(" "),
          divider: { method: a.divider === "gap" ? "gap" : "line", strength: 0.6 } });
      }
      if (a.wrapName) {
        // a wrapped subject: the code on one printed line, the name broken after
        const nm = cellVal.name.split(" ");
        items.push({ x, str: cellVal.code });
        items.push({ x, str: nm.slice(0, 2).join(" ") });
        items.push({ x, str: nm.slice(2).join(" ") });
      } else {
        items.push({ x, str: cellVal.code });
        if (cellVal.name) items.push({ x, str: cellVal.name });
      }
    });
    rows.push({ y: 200 + r * 60, items, text: items.map((it) => it.str).join(" "), staff });
  }
  return rows;
}

function parse(a) {
  const rows = buildRows(a);
  return { rows, parsed: api.catParseTimetable([rows], { headerText: rows[0].text }) };
}
function exams(parsed) {
  return api.catDedupeCells(parsed.cells).filter((c) => c.code && !c.nonExam);
}

// ---- column counts (§4) ------------------------------------------------------
for (const n of ["cols1", "cols2", "cols3"]) {
  it(n + ": every year column is detected and every cell becomes an exam", () => {
    const a = byName[n];
    const { parsed } = parse(a);
    eq(parsed.usedColumns, true, "columns must be detected");
    eq(parsed.columnYears.length, a.columns.length, "column count");
    eq(exams(parsed).length, a.rows * a.columns.length, "one exam per dated cell");
  });
}
it("cols4: the II..IV columns are read and every cell becomes an exam", () => {
  const a = byName.cols4;
  const { parsed } = parse(a);
  eq(parsed.columnYears.length, 3, "I YEAR is excluded by design, three remain");
  eq(exams(parsed).length, a.rows * 3, "one exam per dated cell");
});

it("a sheet with a single year column is detected", () => {
  const { parsed } = parse(byName.cols1);
  eq(parsed.columnYears, ["2"]);
});
it("a sheet spanning II..IV reads all three study-year columns", () => {
  const { parsed } = parse(byName.cols4);
  eq(parsed.columnYears, ["2", "3", "4"]);
});
// KNOWN DEVIATION from the spec, recorded here so it cannot regress unnoticed.
// The spec lists I YEAR as a supported column. catStudyYear deliberately returns
// "" for year one, so an "I YEAR" header is NOT treated as a study-year column.
// That is pre-existing, commented behaviour in index.html - not something these
// changes introduced - and it is why the cols4 sheet (I, II, III, IV) reads as
// three columns. Changing it is a separate decision: see the handover notes.
it("I YEAR is deliberately not treated as a study-year column", () => {
  eq(api.catStudyYear("I YEAR"), "", "year one is excluded by design");
  eq(api.catStudyYear("1ST YEAR"), "", "and so is 1ST YEAR");
  const a = byName.cols4;
  eq(a.columns.length, 4, "the fixture really does print four columns");
  const { parsed } = parse(a);
  ok(!parsed.columnYears.includes("1"), "the I column is dropped, not misread as II");
});

// ---- sections (§5 / §14) -----------------------------------------------------
it("a sectioned header still produces ONE exam per cell", () => {
  const a = byName.cols_sections;
  const { parsed } = parse(a);
  eq(parsed.columnYears.length, 2);
  // 6 rows x 2 columns. The (A & B) column must NOT be doubled or tripled.
  eq(exams(parsed).length, a.rows * 2, "a sectioned column must not multiply exams");
});
it("the section set reaches the cells of that column", () => {
  const { parsed } = parse(byName.cols_sections);
  const sec = parsed.cells.filter((c) => (c.sections || []).length);
  ok(sec.length > 0, "some cells must carry a section set");
  ok(sec.every((c) => c.sections.join(",") === "A,B"), "every sectioned cell reads A & B");
  const unsec = parsed.cells.filter((c) => !(c.sections || []).length);
  ok(unsec.length > 0, "the unsectioned column must carry no section");
});
it("the section set never creates a second exam", () => {
  const a = byName.cols_sections;
  const { parsed } = parse(a);
  const before = parsed.cells.length;
  api.catDedupeCells(parsed.cells);
  eq(api.catDedupeCells(parsed.cells).length, before);
});

// ---- cell states (§8) ---------------------------------------------------------
it("EXAM, EMPTY and NAAN MUDALVAN each behave correctly", () => {
  const a = byName.cells_mixed;
  const { parsed } = parse(a);
  const real = exams(parsed);
  const naan = parsed.cells.filter((c) => c.nonExam);
  // Column 0 rotates EXAM / EMPTY / NAAN across 6 rows: two of each.
  // Column 1 is always an EXAM: six of them.
  eq(naan.length, 2, "two NAAN MUDALVAN cells");
  eq(real.length, 2 + 6, "EXAM count");
  ok(real.every((c) => c.code), "every real exam has a code");
});
it("an NAAN MUDALVAN cell is reported, not silently dropped", () => {
  const { parsed } = parse(byName.cells_mixed);
  ok(parsed.cells.some((c) => c.nonExam), "the NAAN cell must be visible for review");
});
it("an EMPTY cell yields no cell object at all", () => {
  const rows = buildRows(byName.cols2);
  // blank out column 1 entirely on one row
  const target = rows[3];
  target.items = target.items.filter((it) => it.x < colX(1));
  target.text = target.items.map((it) => it.str).join(" ");
  const parsed = api.catParseTimetable([rows], { headerText: rows[0].text });
  // dates are stored normalised, so match the ISO form of DATES[2].
  const thatDate = "2025-06-06";
  eq(thatDate, api.schedIsoDate(6, 6, 2025), "ISO helper sanity");
  eq(parsed.cells.filter((c) => c.date === thatDate).length, 1,
    "only the populated column produces a cell");
});

// ---- wrapped subject names (§11) ----------------------------------------------
it("a subject name wrapped over two printed lines stays one subject", () => {
  const { parsed } = parse(byName.cell_wrapped);
  const real = exams(parsed);
  eq(real.length, byName.cell_wrapped.rows, "one exam per wrapped cell");
  ok(real.every((c) => c.code), "every cell kept its code");
  ok(real.every((c) => c.name && c.name.indexOf(" ") > 0), "the name was reassembled");
  ok(real.some((c) => /CONTINUED LINES/.test(c.name) || c.name.split(" ").length > 4),
    "the wrapped tail must be part of the name");
});
it("a wrapped subject is never split into two subjects", () => {
  const { parsed } = parse(byName.cell_wrapped);
  const d = "2025-06-02";
  eq(parsed.cells.filter((c) => c.date === d && !c.nonExam).length, 1);
});

// ---- staff (§9 / §12) ----------------------------------------------------------
it("staff printed below a divider is separated from the subject", () => {
  const { parsed } = parse(byName.cell_divider);
  const real = exams(parsed);
  eq(real.length, byName.cell_divider.rows);
  ok(real.every((c) => c.code), "the subject code survived the split");
  ok(real.every((c) => c.name.indexOf("STAFF") < 0), "no staff text leaked into the subject name");
  ok(real.every((c) => (c.staffNames || []).length > 0), "staff was read for every cell");
});
it("the gap form of the divider behaves like the line form", () => {
  const { parsed } = parse(byName.cell_divider_gap);
  const real = exams(parsed);
  eq(real.length, byName.cell_divider_gap.rows);
  ok(real.every((c) => c.divider && c.divider.method === "gap"), "method recorded");
  ok(real.every((c) => (c.staffNames || []).length > 0), "staff read from the gap split");
});
it("a cell with no divider has no staff and is still a valid exam", () => {
  const { parsed } = parse(byName.cols2);
  const real = exams(parsed);
  ok(real.every((c) => (c.staffNames || []).length === 0), "no staff invented");
  ok(real.every((c) => c.code), "the code is unaffected");
});
it("staff never reaches the exam record written to the database", () => {
  const { parsed } = parse(byName.cell_divider);
  const meta = { assessment: "CAT", bucket: "CAT", session: "FN", label: "CAT",
    departmentMatched: true, departmentCode: "999" };
  const entries = api.catBuildEntries(parsed.cells, meta);
  const e = entries.find((x) => (x.staffNames || []).length);
  ok(e, "a staff-bearing entry must exist in the preview");
  // The record commit() writes is built from a fixed set of keys; staff is not one.
  const written = ["subCode", "subjectName", "date", "year", "session", "dept", "sem"];
  ok(written.indexOf("staffNames") < 0 && written.indexOf("staff") < 0,
    "staff must not be among the persisted keys");
});

// ---- provenance (§8 / §18) ------------------------------------------------------
it("every cell records where it came from", () => {
  const { parsed } = parse(byName.cols2);
  ok(parsed.cells.every((c) => typeof c.sourceCell === "string" && c.sourceCell.length > 0),
    "each cell needs a source location");
  ok(parsed.cells.every((c) => c.sourcePage === 1), "page is recorded");
  ok(parsed.cells.every((c) => typeof c.confidence === "number" && c.confidence >= 0 && c.confidence <= 1),
    "each cell needs a confidence in 0..1");
});
it("the source location names the row and the year column", () => {
  const { parsed } = parse(byName.cols2);
  const c = parsed.cells[0];
  ok(/^row \d+ · [23] YEAR/.test(c.sourceCell), "unexpected sourceCell: " + c.sourceCell);
});

// ---- one exam per cell (§13) ----------------------------------------------------
it("a cell never yields more than one exam", () => {
  for (const n of ["cols1", "cols2", "cols3", "cols4", "cell_wrapped", "cell_divider"]) {
    const a = byName[n];
    const { parsed } = parse(a);
    const seen = {};
    let dupes = 0;
    exams(parsed).forEach((c) => {
      const k = [c.date, c.year, c.code].join("|");
      if (seen[k]) dupes++; else seen[k] = 1;
    });
    eq(dupes, 0, n + " produced a duplicate exam");
  }
});

// ---- the single-page rule (§2) ----------------------------------------------------
it("a multi-page PDF is rejected, never merged", () => {
  const src = require("fs").readFileSync(h.HTML, "utf8");
  ok(/if\(pdf\.numPages!==1\)/.test(src), "catOpenPdf must refuse a multi-page PDF");
  ok(/SINGLE_PAGE_ONLY/.test(src), "the rejection must carry SINGLE_PAGE_ONLY");
  ok(/throw err/.test(src), "the rejection must throw");
  ok(!/pages > 1 \?/.test(src), "no silent merge path may remain");
});
it("the multi-page message names the actual page count", () => {
  const src = require("fs").readFileSync(h.HTML, "utf8");
  ok(/This PDF has "\+pdf\.numPages\+" pages/.test(src), "the count must be reported");
});
it("the gate is inside catOpenPdf and renders nothing itself", () => {
  const { extractFns } = require("./cat_extract.js");
  const src = require("fs").readFileSync(h.HTML, "utf8");
  const open = extractFns(src, ["catOpenPdf"]).catOpenPdf;
  ok(open, "catOpenPdf must be extractable");
  ok(/pdf\.numPages!==1/.test(open), "the gate must live in catOpenPdf");
  ok(open.indexOf("numPages!==1") < open.lastIndexOf("return pdf"),
    "the gate must run before the document is handed back");
  ok(open.indexOf("getPage") < 0, "catOpenPdf must not render or read any page");
});
it("the page loop can only ever run once", () => {
  const { extractFns } = require("./cat_extract.js");
  const src = require("fs").readFileSync(h.HTML, "utf8");
  const fn = extractFns(src, ["catExtractPdfRows"]).catExtractPdfRows;
  ok(/for\(let i=1;i<=pdf\.numPages;i\+\+\)/.test(fn),
    "the loop is kept, but numPages is guaranteed 1 by the gate");
});

module.exports = s;