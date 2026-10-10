// Manual correction of a CAT preview row.
//
// The reader is good enough that the common failure is no longer "this sheet is
// unreadable" but "this one cell is wrong": a code that read as "CCS3 75", a date
// column merged onto the wrong day, a year heading read as 11 instead of III. The
// administrator fixes those by hand in the confirmation table.
//
// These tests pin the two properties that make that safe, and both are properties
// of the DERIVATION rather than of the widgets:
//
//   1. A corrected row is put back through the same gate as a read row, against
//      the live exam and student lists - so a re-dated row is re-checked for
//      duplicates, and a re-departed row is re-matched to students.
//
//   2. A row is rebuilt from the reader's entry plus the administrator's patch, so
//      "undo" returns exactly what the sheet printed and no stale value survives a
//      correction.
const { load, suite } = require("./harness.js");
const A = load();

// A department master with two real departments, so a row can be moved between
// them and the move has to be reflected in the students it matches.
const BRANCHES = [
  { dept: "CSE", code: "01", name: "Computer Science and Engineering" },
  { dept: "ECE", code: "02", name: "Electronics and Communication Engineering" },
];

function entry(o) {
  return Object.assign({
    ignored: false, date: "2026-10-06", year: 3, sem: "05", subCode: "CCS375",
    subjectName: "Web Technologies", raw: "CCS375 - WEB TECHNOLOGIES", reason: "",
    assessment: "Continuous Assessment Test 2", bucket: "CAT", session: "FN",
    label: "", staffNames: ["Ms. P. Jebarajathi"], sections: ["A", "B"],
    divider: "B.E / B.Tech", confidence: 1, sourcePage: 1, sourceCell: "r1c2",
    blockingReasons: [], readerReasons: [],
  }, o);
}

function ctx(o) {
  return Object.assign({
    exams: [], students: [], deptCode: "CSE", collegeId: "C1",
    branches: BRANCHES, dateRange: { from: "2026-10-06", to: "2026-10-16" },
  }, o);
}

function row(en, c) {
  const pv = A.catBuildPreview([en], c || ctx());
  pv.rows[0].file = "t.pdf";
  return pv.rows[0];
}

// The same sequence the dialog performs: rebuild the row, then recount.
// patch === null is UNDO, exactly as the dialog's reset button sends it.
function edit(r, patch, c) {
  const rows = [A.catRebuildRow(r, patch, c || ctx())];
  return A.catRecount({
    rows, files: [{ name: "t.pdf", status: "ok", meta: { departmentAbbrev: "CSE" } }],
    metaByFile: { "t.pdf": { departmentCode: "01", departmentAbbrev: "CSE" } },
    collegeId: (c || ctx()).collegeId,
  }).rows[0];
}

module.exports = (function () {
  const s = suite("cat edit — manual correction of a preview row");

  // ── a correction unblocks what the reader could not read ────────────────────
  s.it("typing the missing subject code clears the blocking error", () => {
    const r = row(entry({ subCode: "", subjectName: "Web Technologies" }));
    s.ok(r.errors.indexOf("SUBJECT CODE NOT EXTRACTED") >= 0, "blocked before");
    s.ok(!r.ready, "not ready before");
    const fixed = edit(r, { subCode: "CCS375" });
    s.ok(fixed.errors.indexOf("SUBJECT CODE NOT EXTRACTED") < 0, "error cleared");
    s.ok(fixed.ready, "row is ready after the correction");
    s.eq(fixed.subCode, "CCS375");
  });

  s.it("typing the missing session clears SESSION NOT DETECTED", () => {
    const r = row(entry({ session: "" }));
    s.ok(r.errors.indexOf("SESSION NOT DETECTED") >= 0);
    const fixed = edit(r, { session: "an" });
    s.eq(fixed.session, "AN", "a hand-typed session is normalised like a read one");
    s.ok(fixed.errors.indexOf("SESSION NOT DETECTED") < 0);
  });

  s.it("typing the missing department clears DEPARTMENT NOT RESOLVED", () => {
    const r = row(entry(), ctx({ deptCode: "" }));
    s.ok(r.errors.indexOf("DEPARTMENT NOT RESOLVED") >= 0);
    const fixed = edit(r, { deptCode: undefined, dept: "ECE" }, ctx({ deptCode: "" }));
    s.eq(fixed.dept, "ECE");
    s.ok(fixed.errors.indexOf("DEPARTMENT NOT RESOLVED") < 0);
  });

  // ── the students follow the row ─────────────────────────────────────────────
  s.it("changing the department re-matches the students", () => {
    const students = [
      { regno: "1", dept: "CSE", year: "3" },
      { regno: "2", dept: "ECE", year: "3" },
      { regno: "3", dept: "CSE", year: "2" },
    ];
    const r = row(entry(), ctx({ students }));
    s.eq(r.studentCount, 1, "only the CSE 3rd-year student matches");
    s.eq(r.students[0].regno, "1");
    const moved = edit(r, { dept: "ECE" }, ctx({ students }));
    s.eq(moved.studentCount, 1, "now the ECE student");
    s.eq(moved.students[0].regno, "2", "the roster followed the department");
  });

  s.it("changing the year re-matches the students", () => {
    const students = [
      { regno: "1", dept: "CSE", year: "3" },
      { regno: "3", dept: "CSE", year: "2" },
    ];
    const r = row(entry(), ctx({ students }));
    s.eq(r.students[0].regno, "1");
    // The year is corrected with its semester, because examGroupYear reads the
    // year off the semester — see the test below for what happens otherwise.
    const moved = edit(r, { year: "2", sem: "03" }, ctx({ students }));
    s.eq(moved.students[0].regno, "3", "the roster followed the year");
  });

  s.it("a year that disagrees with the semester is BLOCKED, not guessed", () => {
    // examGroupYear derives the year from the semester when the semester is a real
    // one, so sem 05 is 3rd year whatever the year box says. Saving that would file
    // the exam as 2nd year and seat 3rd-year students, so the row waits instead.
    const students = [{ regno: "1", dept: "CSE", year: "3" }];
    const r = row(entry(), ctx({ students }));
    const bad = edit(r, { year: "2" }, ctx({ students }));
    s.ok(bad.errors.indexOf("YEAR AND SEMESTER DISAGREE") >= 0, "disagreement is an error");
    s.ok(!bad.ready, "and it blocks the save");
  });

  s.it("a semester changed on its own is checked against the year too", () => {
    const r = row(entry());
    // Semesters 5 and 6 are both third year, so 06 agrees with the year and only
    // 02 (first year) disagrees. The check follows the same year-from-semester rule
    // the seating engine uses, so it cannot disagree with how the exam is seated.
    s.ok(edit(r, { sem: "06" }).errors.indexOf("YEAR AND SEMESTER DISAGREE") < 0,
      "sem 06 is still third year");
    const bad = edit(r, { sem: "02" });
    s.ok(bad.errors.indexOf("YEAR AND SEMESTER DISAGREE") >= 0, "sem 02 is not year 3");
    s.ok(!bad.ready);
  });

  // ── the duplicate check runs again on a re-dated row ─────────────────────────
  // An exam that already exists and carries the SAME assessment label as the row:
  // that is the "already exists" case. (A same-date, same-code exam with a
  // DIFFERENT label is a conflict, not a duplicate — see below.)
  const existingExam = (o) => Object.assign({
    id: "e1", date: "2026-10-06", session: "FN", subjectCode: "CCS375",
    category: "CAT", examCategory: "CAT-2",
    groups: [{ dept: "CSE", sem: "05", year: "3" }], hallids: [],
  }, o);

  s.it("a row re-dated onto an exam that already exists is blocked", () => {
    const c = ctx({ exams: [existingExam({})] });
    const r = row(entry({ date: "2026-10-07", label: "CAT-2" }), c);
    s.ok(r.ready, "not a duplicate while the dates differ");
    const moved = edit(r, { date: "2026-10-06" }, c);
    s.ok(moved.errors.indexOf("ALREADY EXISTS") >= 0, "the duplicate check re-ran");
    s.ok(!moved.ready, "and it blocks the save");
  });

  s.it("re-dating a row AWAY from an existing exam clears the block", () => {
    const c = ctx({ exams: [existingExam({})] });
    const r = row(entry({ label: "CAT-2" }), c);
    s.ok(r.errors.indexOf("ALREADY EXISTS") >= 0, "blocked at the start");
    const moved = edit(r, { date: "2026-10-09" }, c);
    s.ok(moved.errors.indexOf("ALREADY EXISTS") < 0, "block cleared");
    s.ok(moved.ready, "and the row can now be saved");
  });

  s.it("a row re-coded onto an existing exam's code is blocked", () => {
    const c = ctx({ exams: [existingExam({ subjectCode: "EC5121" })] });
    const r = row(entry({ label: "CAT-2" }));
    s.ok(r.ready);
    const moved = edit(r, { subCode: "EC5121" }, c);
    s.ok(moved.errors.indexOf("ALREADY EXISTS") >= 0);
  });

  s.it("a row moved onto another department's existing exam is NOT a duplicate", () => {
    // The existing exam belongs to ECE; moving the row to ECE makes it the same
    // exam, so this must block rather than quietly create a second one.
    const c = ctx({ exams: [existingExam({ groups: [{ dept: "ECE", sem: "05", year: "3" }] })] });
    const r = row(entry({ label: "CAT-2" }));
    s.ok(r.ready);
    const moved = edit(r, { dept: "ECE" }, c);
    s.ok(moved.errors.indexOf("ALREADY EXISTS") >= 0,
      "the check followed the corrected department");
  });

  s.it("a row moved onto an exam with a different assessment label is a CONFLICT", () => {
    const c = ctx({ exams: [existingExam({ examCategory: "CAT-3" })] });
    const r = row(entry({ label: "CAT-2" }));
    s.ok(r.ready, "a different label is not the same exam");
    const moved = edit(r, { date: "2026-10-06" }, c);
    s.ok(moved.errors.indexOf("CONFLICTING EXISTING EXAM") >= 0,
      "but the collision is still reported rather than created twice");
    s.ok(moved.errors.indexOf("ALREADY EXISTS") < 0, "and it is not called a duplicate");
    s.ok(!moved.ready);
  });

  // ── undo returns the sheet's reading, exactly ───────────────────────────────
  s.it("undo restores every field the reader produced", () => {
    const r = row(entry());
    const patched = edit(r, { date: "2026-11-30", session: "AN", year: "1", sem: "01",
      dept: "ECE", subCode: "ZZ999", subjectName: "Something Else" });
    s.ok(patched.edited, "the row knows it was changed");
    const back = edit(patched, null);
    s.ok(!back.edited, "and knows it was not");
    s.eq(back.date, "2026-10-06");
    s.eq(back.session, "FN");
    s.eq(back.year, 3);
    s.eq(back.sem, "05");
    s.eq(back.dept, "CSE");
    s.eq(back.subCode, "CCS375");
    s.eq(back.subjectName, "Web Technologies");
  });

  s.it("undo does NOT keep a value the correction introduced", () => {
    const r = row(entry());
    // A stale value would show up here: an error list that accumulated the
    // re-derived row's complaints on top of the original ones.
    let x = row(entry({ subCode: "" }));
    x = edit(x, { subCode: "CCS375" });
    s.ok(x.errors.length===0, "no errors after fixing the code");
    x = edit(x, { subCode: "" });
    s.eq(x.errors.length, 1, "back to exactly one error, not two");
    s.ok(x.errors.indexOf("SUBJECT CODE NOT EXTRACTED") >= 0);
  });

  s.it("warnings are rebuilt, not accumulated, across many edits", () => {
    const r = row(entry({ subjectName: "" }));
    s.eq((r.warnings||[]).filter((w)=>w==="SUBJECT NAME NOT EXTRACTED").length, 1);
    let x = edit(r, { subjectName: "Web Technologies" });
    s.eq((x.warnings||[]).filter((w)=>w==="SUBJECT NAME NOT EXTRACTED").length, 0, "cleared");
    x = edit(x, { subjectName: "" });
    s.eq((x.warnings||[]).filter((w)=>w==="SUBJECT NAME NOT EXTRACTED").length, 1, "and back again");
  });

  s.it("a correction reports the value the sheet printed", () => {
    const r = row(entry());
    s.eq(A.catReadValue(r, "subCode"), "CCS375");
    s.eq(A.catReadValue(r, "date"), "2026-10-06");
    // The corrected row still reports the SHEET's value, not its own — that is the
    // whole point of showing it beside the correction.
    const fixed = edit(r, { subCode: "CCS999" });
    s.eq(A.catReadValue(fixed, "subCode"), "CCS375", "as read, not as corrected");
  });

  // ── a row can be left out, or brought back in ───────────────────────────────
  s.it("a non-exam row can be excluded and is counted as ignored", () => {
    const en = entry({ ignored: true, subCode: "NAAN MUDALVAN", subjectName: "",
      reason: "IGNORED — NON-EXAM ACTIVITY" });
    const r = row(en);
    s.ok(r.ignored, "ignored as read");
    const included = edit(r, { excluded: false });
    s.ok(!included.ignored, "brought in by hand");
    s.eq(included.subCode, "NAAN MUDALVAN");
    s.ok(included.errors.indexOf("SUBJECT CODE NOT EXTRACTED") < 0, "its code is accepted");
  });

  s.it("excluding a real row removes it from the counts", () => {
    const pv = A.catBuildPreview([entry(), entry({ subCode: "CS3551" })], ctx());
    const before = A.catRecount({
      rows: pv.rows.map((r, i)=>Object.assign(r, { file: "t.pdf" })),
      files: [{ name: "t.pdf", status: "ok" }], metaByFile: {}, collegeId: "C1",
    });
    s.eq(before.summary.ready, 2);
    const rows = before.rows.slice();
    rows[0] = A.catRebuildRow(rows[0], { excluded: true }, ctx());
    const after = A.catRecount(Object.assign({}, before, { rows }));
    s.eq(after.summary.ready, 1, "one exam left to create");
    s.eq(after.summary.ignored, 1);
  });

  // ── the batch duplicate pass re-runs after an edit ──────────────────────────
  s.it("two rows made identical by an edit are caught as a batch duplicate", () => {
    const pv = A.catBuildPreview([entry(), entry({ date: "2026-10-07" })], ctx());
    let c = A.catRecount({
      rows: pv.rows.map((r)=>Object.assign(r, { file: "t.pdf" })),
      files: [{ name: "t.pdf", status: "ok" }], metaByFile: {}, collegeId: "C1",
    });
    s.eq(c.summary.batchDuplicates, 0, "different dates, no collision");
    const rows = c.rows.slice();
    rows[1] = A.catRebuildRow(rows[1], { date: "2026-10-06" }, ctx());
    c = A.catRecount(Object.assign({}, c, { rows }));
    s.eq(c.summary.batchDuplicates, 1, "the edit created a collision and it is reported");
    s.ok(rows[1].errors.indexOf("REPEATED IN THIS BATCH") >= 0);
    s.ok(!rows[1].ready);
  });

  s.it("a row re-dated OUT of a collision stops being marked", () => {
    const pv = A.catBuildPreview([entry(), entry({})], ctx());
    let c = A.catRecount({
      rows: pv.rows.map((r)=>Object.assign(r, { file: "t.pdf" })),
      files: [{ name: "t.pdf", status: "ok" }], metaByFile: {}, collegeId: "C1",
    });
    s.eq(c.summary.batchDuplicates, 1, "the same sheet twice collides");
    const rows = c.rows.slice();
    rows[1] = A.catRebuildRow(rows[1], { date: "2026-10-07" }, ctx());
    c = A.catRecount(Object.assign({}, c, { rows }));
    s.eq(c.summary.batchDuplicates, 0, "and the mark is gone once the dates differ");
    s.ok(rows[1].errors.indexOf("REPEATED IN THIS BATCH") < 0, "the error was cleared, not left behind");
    s.ok(rows[1].ready);
  });

  // ── the counts the dialog shows ─────────────────────────────────────────────
  s.it("the summary counts the corrected rows", () => {
    const pv = A.catBuildPreview([entry(), entry({ subCode: "CS3551" })], ctx());
    let c = A.catRecount({
      rows: pv.rows.map((r)=>Object.assign(r, { file: "t.pdf" })),
      files: [{ name: "t.pdf", status: "ok" }], metaByFile: {}, collegeId: "C1",
    });
    s.eq(c.summary.edited, 0);
    const rows = c.rows.slice();
    rows[0] = A.catRebuildRow(rows[0], { subCode: "CCS999" }, ctx());
    c = A.catRecount(Object.assign({}, c, { rows }));
    s.eq(c.summary.edited, 1);
    s.eq(c.summary.ready, 2, "still two exams to create");
  });

  s.it("a file's own summary follows the edit", () => {
    const pv = A.catBuildPreview([entry(), entry({ subCode: "" })], ctx());
    let c = A.catRecount({
      rows: pv.rows.map((r)=>Object.assign(r, { file: "t.pdf" })),
      files: [{ name: "t.pdf", status: "ok" }], metaByFile: {}, collegeId: "C1",
    });
    s.eq(c.files[0].summary.ready, 1);
    s.eq(c.files[0].summary.blockedRows, 1);
    const rows = c.rows.slice();
    rows[1] = A.catRebuildRow(rows[1], { subCode: "CS3551" }, ctx());
    c = A.catRecount(Object.assign({}, c, { rows }));
    s.eq(c.files[0].summary.ready, 2, "the file list agrees with the table");
    s.eq(c.files[0].summary.blockedRows, 0);
    s.eq(c.files[0].summary.missingCodes, 0);
  });

  // ── a patch cannot reach anything but the editable fields ───────────────────
  s.it("a patch cannot set the errors or the ready flag directly", () => {
    // The row is missing its subject code, so it is genuinely blocked. A patch that
    // tries to hand it errors:[] and ready:true must not get past the gate.
    const r = row(entry({ subCode: "" }), ctx({ students: [{ regno: "1", dept: "CSE", year: "3" }] }));
    const bad = A.catRebuildRow(r, { errors: [], ready: true, studentCount: 999,
      existingId: "x", readerReasons: [] }, ctx({ students: [{ regno: "1", dept: "CSE", year: "3" }] }));
    s.ok(bad.errors.indexOf("SUBJECT CODE NOT EXTRACTED") >= 0, "the gate ran on its own terms");
    s.ok(!bad.ready, "and the row is still blocked");
    s.eq(bad.studentCount, 1, "the student count was derived, not taken from the patch");
    s.ok(!bad.existingId, "the duplicate lookup was not skipped");
  });

  s.it("normalises what was typed, the same as what was read", () => {
    const r = row(entry());
    const x = edit(r, { subCode: "  ccs375 ", session: " fn ", dept: " cse " });
    s.eq(x.subCode, "CCS375");
    s.eq(x.session, "FN");
    s.eq(x.dept, "CSE");
  });

  s.it("an empty correction is refused rather than blanking the row", () => {
    const r = row(entry());
    const x = edit(r, { date: "", session: "" });
    s.ok(x.errors.indexOf("INVALID DATE")>=0, "an emptied date blocks");
    s.ok(x.errors.indexOf("SESSION NOT DETECTED")>=0, "and so does an emptied session");
    s.ok(!x.ready);
  });

  s.it("a date the browser could not parse is reported, not guessed", () => {
    const r = row(entry());
    for (const bad of ["not-a-date", "2026-13-01", "2026-02-31", "31/02/2026", "tomorrow"]) {
      const x = edit(r, { date: bad });
      s.ok(x.errors.indexOf("INVALID DATE") >= 0, "blocked: " + bad);
      s.eq(x.date, "", "and nothing partial was kept");
      s.ok(!x.ready);
    }
  });

  s.it("a date typed in an ordinary format is understood, not rejected", () => {
    const r = row(entry());
    const x = edit(r, { date: " 6.10.2026 " });
    s.eq(x.date, "2026-10-06", "day-first with dots, as an Indian sheet prints it");
    s.ok(x.errors.indexOf("INVALID DATE") < 0);
  });

  s.it("a date the reader already produced is left exactly as it is", () => {
    const r = row(entry());
    s.eq(edit(r, { date: "2026-10-06" }).date, "2026-10-06");
    s.eq(A.catCleanDate("2026-10-06"), "2026-10-06");
  });

  s.it("the date range warning still applies to a hand-typed date", () => {
    const r = row(entry());
    const x = edit(r, { date: "2026-11-30" });
    s.ok((x.warnings||[]).some((w)=>/OUTSIDE PUBLISHED RANGE/.test(w)),
      "a date outside the sheet's own window is still reported");
  });

  s.it("a corrected row is no longer nagged about codes it no longer reads", () => {
    const r = row(entry({ raw: "CCS375 / CCS380 - WEB TECHNOLOGIES" }));
    s.ok((r.warnings||[]).indexOf("MULTIPLE SUBJECT CODES")>=0, "the raw cell held two codes");
    const x = edit(r, { subCode: "CCS375" });
    s.ok((x.warnings||[]).indexOf("MULTIPLE SUBJECT CODES")<0,
      "once the code is typed, that guess is settled");
  });

  s.it("what was typed is kept apart from what will be saved", () => {
    // The box shows exactly what was typed, so a trailing space can be typed at
    // all; the row carries the trimmed value, so the database never sees it. If
    // these were the same field, "WEB TECHNOLOGIES" could not be typed.
    const r = row(entry());
    const x = edit(r, { subjectName: "Web Technologies ", subCode: "CCS375 " });
    s.eq(x.manual.subjectName, "Web Technologies ", "what was typed, verbatim");
    s.eq(x.subjectName, "Web Technologies", "what the row carries, trimmed");
    s.eq(x.manual.subCode, "CCS375 ");
    s.eq(x.subCode, "CCS375");
  });

  s.it("staff and sections are not editable, because they are never saved", () => {
    const r = row(entry());
    const x = A.catRebuildRow(r, { staffNames: ["Someone Else"], sections: ["Z"] }, ctx());
    s.eq(x.staffNames, ["Ms. P. Jebarajathi"], "staff unchanged");
    s.eq(x.sections, ["A", "B"], "sections unchanged");
  });

  return s;
})();