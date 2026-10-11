// Proves the divider detector reads a PRINTED RULE out of the rendered pixels,
// not just whitespace between OCR words.
//
// This is the half of the split that the word-level tests cannot reach: OCR often
// gives no clue that a line was drawn, and a cell whose subject and staff are only
// separated by that rule must still split correctly. The canvas here is a hand
// built stand-in for the rendered attempt - no real PDF is needed and nothing is
// invented about any college.

const h = require("./harness.js");
const api = h.load();

const s = h.suite("cat_ink.test.js — printed-rule divider detection");
const { it, eq, ok } = s;

// The page must be tall enough to hold every row: ink is read back by absolute
// pixel row, so a canvas shorter than the sheet silently stops finding rules in
// its lower half.
const ROWS = 8;

// A fake rendered page. `bands` lists {y, h, ink} in absolute pixel rows; ink is
// the fraction of the row's width covered in dark pixels.
function fakeCanvas(bands) {
  return {
    width: PW, height: PH,
    getContext() {
      return {
        getImageData(x0, y0, w, h) {
          const data = new Uint8ClampedArray(w * h * 4).fill(255);
          for (let y = 0; y < h; y++) {
            const abs = y0 + y;
            const band = bands.find((b) => abs >= b.y && abs < b.y + b.h);
            if (!band) continue;
            const cols = Math.round(band.ink * w);
            for (let x = 0; x < cols; x++) {
              const i = (y * w + x) * 4;
              data[i] = data[i + 1] = data[i + 2] = 0;
            }
          }
          return { data, width: w, height: h };
        },
      };
    },
  };
}

// Geometry of one dated row, in pixels from the row's own date line.
// The row pitch has to be comfortably more than twice the staff offset: a dated
// row's vertical band ends at the midpoint to the NEXT date, so a staff line
// printed too close to the next row would fall outside its own band.
const ROW_PITCH = 140;
const SUBJECT_Y = 0;      // relative to the row line
const WRAP_Y = 20;        // the subject name carried onto a second line
const RULE_Y = 50;        // the drawn rule, below the whole subject
const STAFF_Y = 60;       // staff printed under the rule

// One dated row: subject near the top, a drawn rule, then staff well below.
function wordSheet() {
  const w = (text, x0, y0) => {
    const width = Math.max(6, text.length * 6);
    return { text, confidence: 90, bbox: { x0, y0, x1: x0 + width, y1: y0 + 10 } };
  };
  const words = [w("DATE", 0, 20), w("II YEAR", 200, 20)];
  for (let i = 0; i < ROWS; i++) {
    const y = 60 + i * ROW_PITCH;
    words.push(w("0" + (i + 2) + ".06.2025", 0, y));
    words.push(w("ZZ1" + (10 + i), 200, y));
    words.push(w("SUBJECT " + (i + 1), 200, y + SUBJECT_Y));
    words.push(w("OF MECHANICS", 200, y + WRAP_Y));
    words.push(w("ALPHA PERSON", 200, y + STAFF_Y));
  }
  return words;
}

// Inked bands matching wordSheet: a text row, then a full-width rule below it.
function inkBands() {
  const bands = [];
  for (let i = 0; i < ROWS; i++) {
    const y = 60 + i * ROW_PITCH;
    bands.push({ y: y + SUBJECT_Y, h: 10, ink: 0.30 });
    bands.push({ y: y + WRAP_Y, h: 10, ink: 0.30 });
    bands.push({ y: y + RULE_Y, h: 3, ink: 1.0 });
    bands.push({ y: y + STAFF_Y, h: 10, ink: 0.30 });
  }
  return bands;
}

// One cell's ink box: subject, rule and staff of the FIRST dated row.
const CELL_BOX = { x0: 196, y0: 56, x1: 330, y1: 126 };

const PW = 600, PH = 60 + ROWS * ROW_PITCH + 60;

it("a drawn rule is detected as the divider", () => {
  const d = api.catCellDividerY(fakeCanvas(inkBands()), CELL_BOX);
  ok(d, "a rule was found in the pixels");
  eq(d.method, "line", "and it is reported as a drawn line, not a gap");
});

it("the detected rule sits between the subject and the staff", () => {
  const d = api.catCellDividerY(fakeCanvas(inkBands()), CELL_BOX);
  // Subject at y=60..70, its wrapped line at y=80..90, the rule at y=110..113,
  // staff at y=120..130. The rule sits below the whole subject and above the staff.
  ok(d.y > 90 && d.y <= 116, "the rule is in the blank band between them",
    "y=" + d.y);
});

it("with no pixels the word-gap detector is still used", () => {
  // Same sheet, no attempt canvas: the OCR word path must still split, because a
  // sheet that prints staff with only whitespace between them has no rule to find.
  const words = wordSheet();
  const out = api.catOcrRowsFromWords(words, 1,
    "ACADEMIC YEAR 2025 - 2026 ODD SEMESTER", null);
  const parsed = api.catParseTimetable([out.rows], { headerText: "DATE II YEAR" });
  parsed.cells.filter((c) => !c.nonExam).forEach((c) => {
    ok(!/\bPERSON\b/i.test(c.name || ""), "staff kept out of the name", c.name);
    eq(c.staffNames.join(" "), "ALPHA PERSON",
      "the gap between subject and staff was still read as a divider");
  });
});

it("a printed rule is preferred over the whitespace gap", () => {
  const words = wordSheet();
  const canvas = fakeCanvas(inkBands());
  const out = api.catOcrRowsFromWords(words, 1,
    "ACADEMIC YEAR 2025 - 2026 ODD SEMESTER", { canvas });
  const parsed = api.catParseTimetable([out.rows], { headerText: "DATE II YEAR" });
  const cells = parsed.cells.filter((c) => !c.nonExam);
  eq(cells.length, 8, "every row still produced exactly one exam");
  cells.forEach((c) => {
    eq(c.divider && c.divider.method, "line",
      "the drawn rule was used, not the word gap");
    eq(c.staffNames.join(" "), "ALPHA PERSON", "staff still separated correctly");
    ok(!/\bPERSON\b/i.test(c.name || ""), "staff kept out of the name", c.name);
  });
});

it("a page with text but no rule finds no divider", () => {
  // Text only, and only one block of it inside the sampled box, so the blank rows
  // are just padding around a single line.
  const bands = [];
  for (let i = 0; i < ROWS; i++) {
    const y = 60 + i * ROW_PITCH;
    bands.push({ y, h: 10, ink: 0.30 });
  }
  eq(api.catCellDividerY(fakeCanvas(bands), CELL_BOX), null,
    "no rule and no wide blank band means no divider");
});

it("a blank cell has no divider", () => {
  eq(api.catCellDividerY(fakeCanvas([]), CELL_BOX), null, "nothing drawn at all");
});

// Words on one printed line. The cursor ADVANCES by each word's own width, so the
// boxes tile left to right the way a printed line does. Laying each word out at a
// fixed multiple of its own length instead overlaps the boxes and scrambles the
// reading order, which is a fault in the fixture rather than in the parser.
function line(texts, y0, xFrom) {
  let x = xFrom == null ? 200 : xFrom;
  return texts.map((t) => {
    const width = Math.max(6, t.length * 6);
    const word = { text: t, confidence: 90, bbox: { x0: x, y0, x1: x + width, y1: y0 + 10 } };
    x += width;
    return word;
  });
}
function w(text, x0, y0) {
  const width = Math.max(6, text.length * 6);
  return { text, confidence: 90, bbox: { x0, y0, x1: x0 + width, y1: y0 + 10 } };
}

// ---- the wrapped name that a real sheet produced -----------------------------
// Reproduces the failure seen on a scanned ECE timetable: "Probability Statistics
// and" / "Random Processes" is ONE subject name wrapped over two lines, but the
// detector treated the wrap as subject-over-staff and offered "Random Processes" as
// a staff name, leaving the saved subject name truncated to half of itself.
//
// The sheet is printed with generous leading, so the gap between the two lines of
// the wrap is as tall as the text. Line height alone cannot tell a wrap from a
// staff block, and this case has only two lines, so no within-cell rhythm exists
// to measure either. The whole name must survive.
it("a two-line wrapped name is never split into a subject and a staff", () => {
  // The code, then the wrapped name at the sheet's own line pitch.
  const y = 60;
  const words = [w("DATE", 0, 20), w("II YEAR", 200, 20)]
    .concat([w("08.06.2025", 0, y)])
    .concat(line(["MAZ25C05"], y))
    .concat(line(["Probability", "Statistics", "and"], y + 20))
    .concat(line(["Random", "Processes"], y + 34));
  const out = api.catOcrRowsFromWords(words, 1,
    "ACADEMIC YEAR 2025 - 2026 ODD SEMESTER", null);
  const parsed = api.catParseTimetable([out.rows], { headerText: "DATE II YEAR" });
  const cell = parsed.cells.filter((c) => !c.nonExam)[0];
  ok(cell, "the row produced an exam cell");
  eq(cell.code, "MAZ25C05", "the code was read");
  eq(cell.name, "Probability Statistics and Random Processes",
    "the wrapped name was kept whole");
  eq(cell.staffNames.length, 0, "no part of the name was offered as staff");
});

it("a staff block set well below a two-line subject still splits", () => {
  // The counterpart, so the stricter bar above has not simply disabled splitting:
  // a staff block set clearly apart must still be read. Three lines of subject give
  // the cell a rhythm to measure against, which is what the split now depends on.
  const y = 60;
  const words = [w("DATE", 0, 20), w("II YEAR", 200, 20)]
    .concat([w("09.06.2025", 0, y)])
    .concat(line(["EC5351"], y))
    .concat(line(["Wireless", "Communication"], y + 20))
    .concat(line(["and", "Networking"], y + 34))
    .concat(line(["ALPHA", "PERSON"], y + 220));
  const out = api.catOcrRowsFromWords(words, 1,
    "ACADEMIC YEAR 2025 - 2026 ODD SEMESTER", null);
  const parsed = api.catParseTimetable([out.rows], { headerText: "DATE II YEAR" });
  const cell = parsed.cells.filter((c) => !c.nonExam)[0];
  ok(cell, "the row produced an exam cell");
  eq(cell.name, "Wireless Communication and Networking", "the subject name is complete");
  eq(cell.staffNames.join(" "), "ALPHA PERSON", "the distant staff block was still read");
});

it("a degenerate box never throws", () => {
  // Boxes can be inverted or off-canvas after cropping; detection must degrade to
  // "no divider" rather than throwing and losing the whole page.
  const canvas = fakeCanvas(inkBands());
  [{ x0: 10, y0: 10, x1: 5, y1: 5 },
   { x0: 0, y0: 0, x1: 0, y1: 0 },
   { x0: -50, y0: -50, x1: 5000, y1: 5000 }].forEach((box) => {
    let r;
    try { r = api.catCellDividerY(canvas, box); }
    catch (e) { throw new Error("threw on " + JSON.stringify(box) + ": " + e.message); }
    ok(r === null || typeof r.y === "number", "returned a shape or null");
  });
});

module.exports = s;