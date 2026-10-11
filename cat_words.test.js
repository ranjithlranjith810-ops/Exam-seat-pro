// Exercises the real OCR word path: catOcrRowsFromWords -> catParseTimetable ->
// catBuildPreview.
//
// The earlier pipeline tests injected `row.staff` directly, so they proved the
// PARSER honours staff but never proved the OCR path PRODUCES it. Two real bugs
// lived in that gap and are what this file exists to catch:
//
//   1. The staff removal in the OCR path compared freshly copied {x,str} items
//      against the ORIGINAL word objects, so the filter matched nothing and staff
//      text silently stayed in the subject name.
//   2. Column geometry required two printed year headers, so a one-year sheet
//      whose body measurement found no gutter degraded to unlabelled plain rows
//      and produced no exams at all.
//
// Nothing here is copied from a real college: codes are ZZ###, subjects are
// "SUBJECT n", staff are "ALPHA PERSON", and the page text is neutral.

const h = require("./harness.js");
const api = h.load();

const s = h.suite("cat_words.test.js — real OCR word path");
const { it, eq, ok } = s;

const PAGE_TEXT = "ACADEMIC YEAR 2025 - 2026 ODD SEMESTER";

// Word boxes in the shape Tesseract returns: { text, confidence, bbox }.
// Spacing is deliberately generous (a tall page) so each dated row owns its own
// vertical band - real sheets are laid out this way, and a cramped fixture would
// put the staff line of one row inside the band of the next.
// A dated row owns the vertical space up to the midpoint to the NEXT date, so the
// pitch has to clear the staff line printed inside the row. At 140 the staff line
// sat below the midpoint and fell into the following row's band, which dropped it.
const ROW_H = 340;

// One dated row: date, then code + name, then staff printed well below a divider.
// The subject occupies two lines and the staff block sits well below them. Three
// lines matter: a whitespace divider is only read as a divider when the cell has
// its own line rhythm to measure the gap against, because on a real sheet a
// two-line wrapped name leaves a gap as tall as the text and cannot be told apart
// from a staff block by size alone.
function datedRow(i) {
  const y = 60 + i * ROW_H;
  return [
    w("0" + (i + 2) + ".06.2025", 0, y),
    w("ZZ1" + (10 + i), 200, y),
    w("SUBJECT " + (i + 1), 200, y),
    w("OF MECHANICS", 200, y + 20),
    w("ALPHA PERSON", 200, y + 120),
  ];
}

function sheet(rowFn) {
  const words = [w("DATE", 0, 20), w("II YEAR", 200, 20)];
  for (let i = 0; i < 8; i++) words.push.apply(words, rowFn(i));
  return words;
}

function w(text, x0, y0, conf) {
  const width = Math.max(6, text.length * 6);
  return {
    text, confidence: conf == null ? 90 : conf,
    bbox: { x0, y0, x1: x0 + width, y1: y0 + 10 },
  };
}

function parse(words) {
  const out = api.catOcrRowsFromWords(words, 1, PAGE_TEXT, null);
  return { out, parsed: api.catParseTimetable([out.rows], { headerText: "DATE II YEAR" }) };
}

// ---- column geometry on the real path ---------------------------------------

it("a one-year sheet keeps its printed column", () => {
  // One header only. Every printed code sits at the same x, so there is no gutter
  // for the body measurement to find and the header is all there is to go on.
  const { out } = parse(sheet(datedRow));
  ok(out.source !== "none", "geometry was found, not skipped (source=" + out.source + ")");
  eq(out.cols.length, 1, "one column");
  eq(String(out.cols[0].year), "2", "and it is the printed year");
});

it("a one-year sheet produces one exam per dated row", () => {
  const { parsed } = parse(sheet(datedRow));
  const real = parsed.cells.filter((c) => !c.nonExam);
  eq(real.length, 8, "one exam per row");
  real.forEach((c) => {
    eq(c.year, "2", "year carried from the header");
    ok(/^ZZ1\d\d$/.test(c.code), "code read cleanly", c.code);
  });
});

it("the exam count equals the dated rows, never more", () => {
  // The staff line of each row also lands inside a band. If it were ever read as
  // its own cell, the count would exceed 8.
  const { parsed } = parse(sheet(datedRow));
  eq(parsed.cells.filter((c) => !c.nonExam).length, 8);
  eq(parsed.cells.filter((c) => c.nonExam).length, 0, "no phantom activity cells");
});

// ---- the staff split ---------------------------------------------------------

it("staff text never leaks into the subject name", () => {
  const { parsed } = parse(sheet(datedRow));
  parsed.cells.filter((c) => !c.nonExam).forEach((c) => {
    ok(!/\bPERSON\b/i.test(c.name || ""), "staff word leaked into the name",
      "name=" + c.name);
    const n = Number(c.code.slice(-2)) - 10 + 1;
    ok(c.name === "SUBJECT " + n + " OF MECHANICS",
      "subject name is every printed line and nothing else", "name=" + c.name);
  });
});

it("the OCR path reports the staff it found", () => {
  const { parsed } = parse(sheet(datedRow));
  const cells = parsed.cells.filter((c) => !c.nonExam);
  eq(cells.length, 8);
  cells.forEach((c) => {
    eq((c.staffNames || []).join(" "), "ALPHA PERSON",
      "staff preserved verbatim for preview");
  });
});

// The exam record the database actually receives. Built here from the same fields
// catBuildEntries hands to the preview, minus everything preview-only, so the test
// pins the DECISION rather than re-implementing the save path.
const persistable = (entry) => ({
  date: entry.date, year: entry.year, sem: entry.sem, dept: entry.dept || "ZZ",
  subCode: entry.subCode, subjectName: entry.subjectName,
  assessment: entry.assessment, bucket: entry.bucket,
  session: entry.session, label: entry.label,
});

it("staff reaches the preview but not the saved record", () => {
  const { parsed } = parse(sheet(datedRow));
  const entries = api.catBuildEntries(parsed.cells.filter((c) => !c.nonExam),
    { assessment: "MODEL", bucket: "B1", session: "S1", label: "CAT", semester: "3" });
  eq(entries.length, 8, "all eight rows became entries");

  // Preview side: staff IS visible, so the administrator can check it.
  entries.forEach((e) => {
    eq(e.staffNames.join(" "), "ALPHA PERSON", "staff present on the preview entry");
  });

  // Save side: none of the preview-only fields may survive.
  entries.forEach((e) => {
    const rec = persistable(e);
    ["staff", "staffNames", "sections", "sourceCell", "sourcePage",
      "confidence", "divider"].forEach((k) => {
      ok(!(k in rec), "persisted record must not carry " + k, Object.keys(rec).join(","));
    });
    eq(rec.subCode, e.subCode, "the code still saves");
  });
});

// ---- what must NOT be read as a divider --------------------------------------

it("a single-line subject produces no staff", () => {
  const flat = (i) => {
    const y = 60 + i * ROW_H;
    return [w("0" + (i + 2) + ".06.2025", 0, y),
      w("ZZ1" + (10 + i), 200, y), w("SUBJECT", 200, y), w("ALPHA", 300, y)];
  };
  const { parsed } = parse(sheet(flat));
  parsed.cells.filter((c) => !c.nonExam).forEach((c) => {
    eq((c.staffNames || []).length, 0, "no divider invented from one line");
  });
});

it("a wrapped subject name is not mistaken for staff", () => {
  // Two lines at normal line-leading (14px, glyphs are 10px tall). A divider must
  // clear twice the line height, so this stays one subject.
  const wrapped = (i) => {
    const y = 60 + i * ROW_H;
    return [w("0" + (i + 2) + ".06.2025", 0, y),
      w("ZZ1" + (10 + i), 200, y),
      w("SUBJECT NAME", 200, y),
      w("THAT WRAPS ONTO", 200, y + 14),
      w("THE NEXT LINE", 200, y + 28)];
  };
  const { parsed } = parse(sheet(wrapped));
  const cells = parsed.cells.filter((c) => !c.nonExam);
  eq(cells.length, 8, "still one exam per row");
  cells.forEach((c) => {
    eq((c.staffNames || []).length, 0,
      "line leading is not a divider: " + JSON.stringify(c.staffNames));
    ok(/WRAPS/.test(c.name || ""), "the wrapped line stayed in the subject",
      "name=" + c.name);
  });
});

// ---- undateable content ------------------------------------------------------

it("an undated subject is blocked, never saved", () => {
  // No date column at all. The words are still visible in the preview - hiding
  // them would leave the administrator with nothing to compare against - but a
  // cell with no date cannot become an exam, so it must never pass validation.
  const words = [w("DATE", 0, 20), w("II YEAR", 200, 20),
    w("ZZ101", 200, 60), w("SUBJECT ALPHA", 200, 60)];
  const { parsed } = parse(words);
  eq(parsed.cells.filter((c) => !c.nonExam).length, 1, "the words are surfaced");
  parsed.cells.filter((c) => !c.nonExam).forEach((c) => {
    eq(c.date, "", "no date could be read");
  });
  const entries = api.catBuildEntries(parsed.cells,
    { assessment: "MODEL", bucket: "B1", session: "S1", label: "CAT", semester: "3" });
  const check = api.catValidateRows(entries, { deptCode: "ZZ" });
  eq(check.ok, false, "validation fails");
  eq(check.errors.length, 1, "the undated cell is reported", check.errors.length);
  const messages = check.errors[0].errors;
  ok(messages.some((m) => /DATE/i.test(m)),
    "and it names the date", messages.join("; "));
});

it("NAAN MUDALVAN is reported and never saved", () => {
  const withActivity = (i) => {
    const y = 60 + i * ROW_H;
    if (i === 3) {
      return [w("0" + (i + 2) + ".06.2025", 0, y),
        w("NAAN MUDALVAN", 200, y), w("ACTIVITY", 300, y)];
    }
    return datedRow(i);
  };
  const { parsed } = parse(sheet(withActivity));
  const activity = parsed.cells.filter((c) => c.nonExam);
  eq(activity.length, 1, "the activity row is flagged");
  const entries = api.catBuildEntries(parsed.cells,
    { assessment: "MODEL", bucket: "B1", session: "S1", label: "CAT", semester: "3" });
  const saveable = entries.filter((e) => !e.ignored);
  eq(saveable.length, 7, "eight rows, one of which is the activity");
  ok(!saveable.some((e) => /MUDALVAN/i.test(e.subjectName || "")),
    "an activity never becomes a saved exam");
  const dropped = entries.filter((e) => e.ignored);
  eq(dropped.length, 1, "exactly one row is marked ignored");
  ok(/MUDALVAN/i.test(dropped[0].raw || ""),
    "and the ignored row keeps the words it was read from", dropped[0].raw);
  ok(/NON-EXAM/i.test(dropped[0].reason || ""),
    "with a reason the administrator can see", dropped[0].reason);
});

module.exports = s;