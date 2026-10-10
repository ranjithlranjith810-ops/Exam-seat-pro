// Unit tests for CAT structure, metadata and identity.
//
// Placeholder subject/staff tokens (ZZ###, SUBJECT ALPHA, STAFF ONE) are used
// throughout. They are deliberately not real subjects, codes or staff names: the
// point is to prove the PARSER's rules, never to guess at real timetable content.
const h = require("./harness.js");
const api = h.load();

const s = h.suite("cat.test.js — structure, metadata, identity");
const { it, eq, ok } = s;

// ---- section sets (§3 / §5 / §14) -----------------------------------------
it("(A & B) yields both sections", () => {
  eq(api.catParseSectionSet("II YEAR (A & B)"), ["A", "B"]);
});
it("(A, B) yields both sections", () => {
  eq(api.catParseSectionSet("III YEAR (A, B)"), ["A", "B"]);
});
it("a mis-read section letter is still a section", () => {
  // "B" misread as "1" must survive as the section slot.
  eq(api.catParseSectionSet("II YEAR (A & 1)"), ["A", "1"]);
  eq(api.catParseSectionSet("II YEAR (A & B1)"), ["A", "B1"]);
});
it("a long run of digits is a header, not a section", () => {
  // Dates, codes and page furniture follow the bracket. They must not be
  // promoted to section names.
  eq(api.catParseSectionSet("II YEAR (12.06.2025)"), []);
  eq(api.catParseSectionSet("II YEAR (2025)"), []);
});
it("no parentheses means no sections", () => {
  eq(api.catParseSectionSet("II YEAR"), []);
});
it("a year is never mistaken for a section", () => {
  eq(api.catParseSectionSet("II YEAR"), []);
  ok(!api.catParseSectionSet("II YEAR (A & B)").includes("YEAR"));
});
it("sections attach to the right column mark", () => {
  const t = "II YEAR (A & B) III YEAR";
  const marks = api.catYearMarks(t);
  eq(marks.length, 2);
  eq(api.catSectionsForMark(t, marks[0]), ["A", "B"]);
  eq(api.catSectionsForMark(t, marks[1]), []);
});

// ---- identity and de-duplication (§13 / §14) -------------------------------
const cell = (o) => Object.assign({ date: "2025-06-02", year: "2", code: "ZZ101", name: "SUBJECT ALPHA" }, o);

it("same date+year+code with a different name is ONE exam", () => {
  const out = api.catDedupeCells([
    cell({ name: "SUBJECT ALPHA" }),
    cell({ name: "SUBJECT ALPHA FINE" }),
  ]);
  eq(out.length, 1, "name must not be part of identity");
});
it("the first-seen name is the one kept", () => {
  const out = api.catDedupeCells([cell({ name: "FIRST NAME" }), cell({ name: "SECOND NAME" })]);
  eq(out[0].name, "FIRST NAME");
});
it("a different year is a different exam", () => {
  eq(api.catDedupeCells([cell({ year: "2" }), cell({ year: "3" })]).length, 2);
});
it("a different date is a different exam", () => {
  eq(api.catDedupeCells([cell({ date: "2025-06-02" }), cell({ date: "2025-06-04" })]).length, 2);
});
it("a different code is a different exam", () => {
  eq(api.catDedupeCells([cell({ code: "ZZ101" }), cell({ code: "ZZ102" })]).length, 2);
});
it("sections never split one exam into two", () => {
  const out = api.catDedupeCells([
    cell({ sections: ["A"] }),
    cell({ sections: ["B"] }),
    cell({ sections: ["A", "B"] }),
  ]);
  eq(out.length, 1, "a sectioned column must yield one exam");
});
it("a non-exam cell keys on NONEXAM, not on its empty code", () => {
  const out = api.catDedupeCells([
    { date: "2025-06-02", year: "2", code: "", nonExam: true, name: "" },
    { date: "2025-06-02", year: "2", code: "", nonExam: true, name: "" },
  ]);
  eq(out.length, 1);
});

// ---- non-exam activities (§8.2) --------------------------------------------
it("NAAN MUDALVAN is recognised as a non-exam activity", () => {
  ok(api.catIsNonExamActivity("NAAN MUDALVAN"));
  ok(api.catIsNonExamActivity("NAANMUDALVAN"));
  ok(api.catIsNonExamActivity("NAAN MUDHALVAN"), "the mis-spelling is accepted too");
});
it("a real subject is not a non-exam activity", () => {
  ok(!api.catIsNonExamActivity("ZZ101 SUBJECT ALPHA"));
});

// ---- study year normalisation (§5) -----------------------------------------
it("roman, spelled and mis-read year tokens all normalise", () => {
  eq(api.catStudyYear("II YEAR"), "2");
  eq(api.catStudyYear("THIRD YEAR"), "3");
  eq(api.catStudyYear("2ND YEAR"), "2");
  eq(api.catStudyYear("11 YEAR"), "2", "11 is a mis-read II");
  eq(api.catStudyYear("111 YEAR"), "3", "111 is a mis-read III");
  eq(api.catStudyYear("1L YEAR"), "2");
});
it("I YEAR never becomes year 2 by accident", () => {
  ok(api.catStudyYear("I YEAR") !== "2");
});
it("a year header carrying sections is still one year", () => {
  eq(api.catYearMarks("II YEAR (A & B)").map((m) => m.year), ["2"]);
});

// ---- timetable semester (§3E) ------------------------------------------------
it("SEM: III, V & VII is read as the semester list", () => {
  eq(api.catDetectTimetableSemester("SEM: III, V & VII"), "III, V & VII");
});
it("a plain SEM value is read", () => {
  eq(api.catDetectTimetableSemester("SEM : V"), "V");
});
it("the odd/even flag and the semester list are separate things", () => {
  const t = "SEM: III, V & VII";
  eq(api.catDetectSemesterKind(t), true, "odd semesters -> true");
  eq(api.catDetectTimetableSemester(t), "III, V & VII");
});
it("no SEM line yields no invented semesters", () => {
  eq(api.catDetectTimetableSemester("DEPARTMENT OF SAMPLE"), "");
});
it("a year column is not read as a semester", () => {
  eq(api.catDetectTimetableSemester("II YEAR III YEAR"), "");
});

// ---- cell parsing (§10) ------------------------------------------------------
it("an alphanumeric code and its name are split", () => {
  const c = api.catParseCell("ZZ101 SUBJECT ALPHA");
  eq(c.code, "ZZ101");
  eq(c.name, "SUBJECT ALPHA");
});
it("a code with a digit suffix is kept whole", () => {
  eq(api.catParseCell("ZZ101A SUBJECT ALPHA").code, "ZZ101A");
});
it("text with no code yields no code rather than a guess", () => {
  eq(api.catParseCell("SUBJECT ALPHA ONLY").code, "");
});

// ---- validation split: errors block, warnings never (§20) --------------------
const meta = { departmentMatched: true };
const entry = (o) => Object.assign({
  ignored: false, subCode: "ZZ101", subjectName: "SUBJECT ALPHA", raw: "ZZ101 SUBJECT ALPHA",
  date: "2025-06-02", year: "2", session: "FN", staffNames: [], divider: "",
}, o);

it("a good entry produces no errors", () => {
  const v = api.catValidateRows([entry()], meta);
  eq(v.errors.length, 0);
  ok(v.ok);
});
it("a missing code blocks the save", () => {
  const v = api.catValidateRows([entry({ subCode: "" })], meta);
  eq(v.errors.length, 1);
  eq(v.errors[0].errors[0], "SUBJECT CODE NOT EXTRACTED");
  ok(!v.ok);
});
it("a missing date blocks the save", () => {
  const v = api.catValidateRows([entry({ date: "" })], meta);
  ok(v.errors[0].errors.includes("INVALID DATE"));
});
it("a year outside 1..4 blocks the save", () => {
  ok(api.catValidateRows([entry({ year: "9" })], meta).errors.length === 1);
  ok(api.catValidateRows([entry({ year: "" })], meta).errors.length === 1);
});
it("an unresolved department blocks the save", () => {
  const v = api.catValidateRows([entry()], { departmentMatched: false });
  ok(v.errors[0].errors.includes("DEPARTMENT NOT RESOLVED"));
});
it("several codes in one cell WARN but do not block", () => {
  const v = api.catValidateRows([entry({ raw: "ZZ101 SUBJECT ALPHA ZZ102 OTHER" })], meta);
  eq(v.errors.length, 0, "must not block");
  eq(v.warnings.length, 1);
  ok(v.warnings[0].warnings.includes("MULTIPLE SUBJECT CODES"));
  ok(v.ok, "a warning must leave the save available");
});
it("unreliable staff WARNS but does not block the code and name saving", () => {
  const v = api.catValidateRows([entry({ divider: "line", staffNames: [] })], meta);
  eq(v.errors.length, 0, "staff must never block the subject");
  eq(v.warnings.length, 1);
  ok(v.warnings[0].warnings.includes("STAFF NOT RELIABLE"));
  ok(v.ok);
});
it("an ignored non-exam row is never validated", () => {
  eq(api.catValidateRows([entry({ ignored: true, subCode: "", date: "" })], meta).errors.length, 0);
});

module.exports = s;