// Unit tests for the cell divider, staff parsing and cell confidence.
//
// These exercise the geometry rules on synthetic word lists rather than on a
// rendered page, because the divider decision is a pure function of where the
// words sit. Tesseract itself is not run here.
const h = require("./harness.js");
const api = h.load();

const s = h.suite("cat_ocr.test.js — cell divider, staff, confidence");
const { it, eq, ok } = s;

// A word as the OCR path produces it: y0/y1 plus x0 and the text.
const w = (text, y0, y1, x0) => ({ text, y0, y1, x0: x0 == null ? 0 : x0 });
const lineOf = (words, y, h2) => words.map((t, i) => w(t, y, y + (h2 || 10), i * 60));

// ---- divider: the gap form (§9) ---------------------------------------------
// A cell with a staff block needs at least three lines before the gap can be
// read as a divider, because the bar is learned from the cell's own line pitch.
// The fixtures below therefore put a middle line in the subject, which is also
// the common real shape: a wrapped subject name with staff set below it.
it("a subject block and a staff block separated by a clear gap produce a divider", () => {
  const words = lineOf(["ZZ101", "SUBJECT"], 10)
    .concat(lineOf(["NAME", "CONTINUED"], 40))
    .concat(lineOf(["STAFF", "ONE"], 110));
  const d = api.catCellDividerFromWords(words);
  ok(d, "a divider should be found");
  eq(d.method, "gap");
  ok(d.y > 50 && d.y < 105, "the split must fall between the blocks, got y=" + d.y);
});
it("the split separates subject from staff, not the reverse", () => {
  const words = lineOf(["ZZ101", "SUBJECT"], 10)
    .concat(lineOf(["NAME", "CONTINUED"], 40))
    .concat(lineOf(["STAFF", "ONE"], 110));
  const sp = api.catSplitCellByDivider(words, api.catCellDividerFromWords(words));
  eq(sp.subject.map((x) => x.text).join(" "), "ZZ101 SUBJECT NAME CONTINUED");
  eq(sp.staff.map((x) => x.text).join(" "), "STAFF ONE");
});
it("two lines alone are not enough to call a gap a divider", () => {
  // A wrapped subject name on a generously printed sheet also leaves a tall
  // blank band between its two lines. With no third line to measure the sheet's
  // own pitch against, that band cannot be read as a staff divider, so no split
  // is made and the name stays whole.
  const words = lineOf(["ZZ101", "PROBABILITY"], 10).concat(lineOf(["STATISTICS"], 80));
  eq(api.catCellDividerFromWords(words), null);
});
it("a single unbroken block of text has no divider", () => {
  const words = lineOf(["ZZ101", "SUBJECT", "ALPHA", "NAME"], 10);
  eq(api.catCellDividerFromWords(words), null);
});
it("two words on one line have no divider", () => {
  eq(api.catCellDividerFromWords([w("ZZ101", 10, 20), w("ALPHA", 10, 20, 80)]), null);
});
it("a gap at the very top is furniture, not a divider", () => {
  // Lead-in above the subject is the sheet's own header text, so a split there
  // would invent a staff line out of nothing.
  const words = lineOf(["SUBJECT", "OF", "SAMPLE"], 10).concat(lineOf(["ZZ101", "ALPHA"], 90));
  const d = api.catCellDividerFromWords(words);
  ok(!d || d.y > 30, "must not split near the top edge");
});
it("a gap at the very bottom is not a divider either", () => {
  const words = lineOf(["ZZ101", "ALPHA"], 10)
    .concat(lineOf(["MIDDLE"], 60))
    .concat(lineOf(["STAFF"], 200));
  const d = api.catCellDividerFromWords(words);
  ok(!d || d.y < 180, "must not split near the bottom edge, got y=" + (d && d.y));
});
it("a gap too small to be a divider is ignored", () => {
  const words = [w("ZZ101", 10, 20), w("ALPHA", 22, 32)];
  eq(api.catCellDividerFromWords(words), null);
});
it("a wrapped subject on two close lines has no divider", () => {
  // The wrap case must NOT be mistaken for subject-over-staff.
  const words = [w("ZZ101", 10, 20), w("SUBJECT", 10, 20, 60),
    w("ALPHA", 24, 34), w("CONTINUED", 24, 34, 60)];
  eq(api.catCellDividerFromWords(words), null);
});
it("the widest gap wins when several are present", () => {
  const words = lineOf(["ZZ101", "SUBJECT"], 10).concat(lineOf(["MIDDLE"], 40))
    .concat(lineOf(["STAFF", "ONE"], 100));
  const d = api.catCellDividerFromWords(words);
  ok(d.y > 45, "should split above the staff block, got y=" + d.y);
});
it("one word cannot be divided", () => {
  eq(api.catCellDividerFromWords([w("ZZ101", 10, 20)]), null);
});
it("no words cannot be divided", () => {
  eq(api.catCellDividerFromWords([]), null);
});
it("a cell with no divider still returns every word as subject", () => {
  const words = lineOf(["ZZ101", "ALPHA"], 10);
  const sp = api.catSplitCellByDivider(words, null);
  eq(sp.subject.length, 2);
  eq(sp.staff.length, 0);
});

// ---- staff name parsing (§12) -------------------------------------------------
// Placeholder names, shaped like real ones but obviously not real people.
it("plain names are read", () => {
  eq(api.catStaffNames("ALPHA PERSON BRAVO PERSON"), ["ALPHA PERSON BRAVO PERSON"],
    "one unbroken run cannot be split reliably and is kept whole");
});
it("comma and ampersand separators both work", () => {
  eq(api.catStaffNames("ALPHA PERSON, BRAVO PERSON"), ["ALPHA PERSON", "BRAVO PERSON"]);
  eq(api.catStaffNames("ALPHA PERSON & BRAVO PERSON"), ["ALPHA PERSON", "BRAVO PERSON"]);
});
it("a printed STAFF label is removed", () => {
  eq(api.catStaffNames("STAFF: ALPHA PERSON"), ["ALPHA PERSON"]);
});
it("an honorific at the start of a name is KEPT — the sheet prints it", () => {
  eq(api.catStaffNames("DR. ALPHA PERSON, MR. BRAVO PERSON"), ["DR. ALPHA PERSON", "MR. BRAVO PERSON"],
    "staff names are shown exactly as printed, so an honorific is part of the name");
});
it("a word inside a name is never stripped", () => {
  eq(api.catStaffNames("STAFF ONE STAFF TWO"), ["STAFF ONE STAFF TWO"],
    "only a leading honorific may go");
});
it("a duplicate name is listed once", () => {
  eq(api.catStaffNames("ALPHA PERSON, ALPHA PERSON"), ["ALPHA PERSON"]);
});
it("a subject code is never offered as a person", () => {
  eq(api.catStaffNames("ZZ101"), []);
  eq(api.catStaffNames("ZZ101 SUBJECT ALPHA"), []);
});
it("a time is never offered as a person", () => {
  eq(api.catStaffNames("10:00 AM - 01:00 PM"), []);
});
it("a date is never offered as a person", () => {
  eq(api.catStaffNames("02.06.2025"), []);
});
it("sheet furniture is never offered as a person", () => {
  eq(api.catStaffNames("TOTAL 30"), []);
  eq(api.catStaffNames("ROOM 204"), []);
  eq(api.catStaffNames("II YEAR"), []);
});
it("a bare number is never a person", () => {
  eq(api.catStaffNames("204"), []);
});
it("empty text yields no names", () => {
  eq(api.catStaffNames(""), []);
  eq(api.catStaffNames("   "), []);
});
it("the name count is capped", () => {
  const many = Array.from({ length: 20 }, (_, i) => "PERSON" + i).join(", ");
  eq(api.catStaffNames(many).length, api.CAT_STAFF_MAX, "must stop exactly at the cap");
});
it("a name with digits inside words is kept", () => {
  eq(api.catStaffNames("PERSON ONE2"), ["PERSON ONE2"]);
});

// ---- confidence (§8 / §18) -----------------------------------------------------
it("a cell with a code and a name is confident", () => {
  const c = api.catCellConfidence({ code: "ZZ101", name: "SUBJECT ALPHA" });
  ok(c >= 0.8, "expected >= 0.8, got " + c);
});
it("a cell with no code is far less confident", () => {
  const good = api.catCellConfidence({ code: "ZZ101", name: "SUBJECT ALPHA" });
  const bad = api.catCellConfidence({ code: "", name: "SUBJECT ALPHA" });
  ok(bad < 0.5, "expected < 0.5, got " + bad);
  ok(good - bad >= 0.4, "a missing code must cost real confidence");
});
it("a detected divider with readable staff raises confidence", () => {
  const a = api.catCellConfidence({ code: "ZZ101", name: "SUBJECT ALPHA" });
  const b = api.catCellConfidence({ code: "ZZ101", name: "SUBJECT ALPHA",
    divider: { method: "line" }, staffNames: ["ALPHA PERSON"] });
  ok(b > a, "divider plus staff should raise it: " + a + " -> " + b);
});
it("a divider with nothing readable below it lowers confidence", () => {
  const a = api.catCellConfidence({ code: "ZZ101", name: "SUBJECT ALPHA",
    divider: { method: "line" }, staffNames: ["ALPHA PERSON"] });
  const b = api.catCellConfidence({ code: "ZZ101", name: "SUBJECT ALPHA",
    divider: { method: "line" }, staffNames: [] });
  ok(b < a, "empty staff below a rule should lower it: " + a + " -> " + b);
});
it("a non-exam cell is fully confident: the token is fixed", () => {
  eq(api.catCellConfidence({ nonExam: true }), 1);
});
it("confidence always stays within 0..1", () => {
  for (const c of [{}, { code: "ZZ101" }, { code: "", name: "" }, { nonExam: true, code: "ZZ1" }]) {
    const v = api.catCellConfidence(c);
    ok(v >= 0 && v <= 1, "out of range: " + v);
  }
});

module.exports = s;