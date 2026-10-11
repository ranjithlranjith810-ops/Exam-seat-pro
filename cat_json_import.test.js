// Tests for the CAT Timetable JSON importer.
//
// The parser / planner / section-builder functions are lifted straight out of
// index.html by harness.js at run time, so these cases always exercise the code
// that actually ships. The real input file is checked in under fixtures/ — no
// database, no network and no student data is touched.
//
// The importer reuses the SAME preview / validation / duplicate / conflict
// pipeline the PDF readers use (catBuildPreview, catValidateRows, catFindExisting,
// catMarkBatchDuplicates, catCombineResults), so these tests assert both the JSON
// mapping AND that a JSON row behaves exactly like a PDF row downstream.
const fs = require("fs");
const path = require("path");
const h = require("./harness.js");
const api = h.load();

const s = h.suite("cat_json_import.test.js — CAT timetable JSON import");
const { it, ait, eq, ok } = s;

const RAW = fs.readFileSync(path.join(__dirname, "fixtures", "cat_timetable.json"), "utf8");
const DATA = JSON.parse(RAW);
const clone = (o) => JSON.parse(JSON.stringify(o));

// The live masters the modal hands the reader. The department codes are the
// existing Department/Branch Master numbers the exam record carries.
const BRANCHES = [
  { dept: "CSE", code: "101", name: "Computer Science and Engineering" },
  { dept: "ECE", code: "102", name: "Electronics and Communication Engineering" },
  { dept: "EEE", code: "103", name: "Electrical and Electronics Engineering" },
  { dept: "MECH", code: "104", name: "Mechanical Engineering" },
  { dept: "AIDS", code: "105", name: "Artificial Intelligence and Data Science" },
];
const STUDENTS = [
  { regno: "A1", dept: "AIDS", year: "2", gender: "male" },
  { regno: "A2", dept: "AIDS", year: "2", gender: "female" },
  { regno: "C1", dept: "CSE", year: "3", gender: "male" },
];
const COLLEGE = { code: "SMTEC", name: "St. Mother Theresa Engineering College" };
const CTX = { exams: [], students: STUDENTS, subjects: [], branches: BRANCHES, college: COLLEGE, collegeId: "COL1" };
const fileOf = (name, text) => ({ name: name, size: String(text).length, text: () => Promise.resolve(text) });

// ── 1. valid JSON parses ─────────────────────────────────────────────────────
it("valid timetable JSON parses with its metadata", () => {
  const p = api.catJsonParse(RAW);
  ok(p.ok, p.error);
  eq(p.data.metadata.academic_year, "2026-27");
  eq(p.data.metadata.assessment, "Continuous Assessment Test-II");
});

// ── 2. invalid JSON syntax ───────────────────────────────────────────────────
it("invalid JSON syntax is reported, not thrown", () => {
  const p = api.catJsonParse("{ this is not json ");
  ok(!p.ok);
  ok(/Invalid JSON/i.test(p.error || ""), p.error);
});

// ── 3. missing / malformed required sections ─────────────────────────────────
it("a non-object root is rejected", () => {
  ok(!api.catJsonParse("[1,2,3]").ok);
});
it('a file with no "departments" map is rejected', () => {
  const p = api.catJsonParse(JSON.stringify({ metadata: { academic_year: "2026-27" } }));
  ok(!p.ok);
  ok(/departments/i.test(p.error || ""), p.error);
});
it("an empty departments map is rejected", () => {
  ok(!api.catJsonParse(JSON.stringify({ departments: {} })).ok);
});
it("a department without a semester_subjects object is rejected", () => {
  const p = api.catJsonParse(JSON.stringify({ departments: { CSE: { department_name: "CSE" } } }));
  ok(!p.ok);
  ok(/semester_subjects/i.test(p.error || ""), p.error);
});

// ── 4. planning the whole file (multiple departments & semesters) ─────────────
it("plans one section per department and flattens every semester", () => {
  const plan = api.catJsonPlan(DATA, CTX, {});
  eq(plan.sections.length, 5, "AI&DS/CSE/EEE/ECE/MECH");
  const all = plan.sections.reduce((a, sec) => a.concat(sec.entries), []);
  eq(all.length, 81, "6+6 + 6+6+5 + 5+6+7 + 5+6+5 + 6+5+7");
  eq(all.filter((e) => !e.subCode).length, 6, "the Naan Mudalvan rows have no code");
});
it("a department with an empty semester list yields a section with no rows", () => {
  const doc = { departments: { CSE: { department_name: "Computer Science and Engineering", semester_subjects: {} } } };
  const plan = api.catJsonPlan(doc, CTX, {});
  eq(plan.sections.length, 1);
  eq(plan.sections[0].entries.length, 0);
});

// ── 5. department resolution ─────────────────────────────────────────────────
it('resolves "AI & DS" to the AIDS department via the alias map', () => {
  const plan = api.catJsonPlan(DATA, CTX, {});
  const aids = plan.sections.find((x) => x.key === "AI & DS");
  ok(aids, "AI & DS section present");
  eq(aids.deptResolved.dept, "AIDS");
  eq(aids.deptResolved.code, "105", "the existing branch code");
  eq(aids.deptResolved.via, "alias");
});
it("resolves the other departments to their branch codes", () => {
  const plan = api.catJsonPlan(DATA, CTX, {});
  const byKey = {};
  plan.sections.forEach((x) => { byKey[x.key] = x.deptResolved; });
  eq(byKey.CSE.dept, "CSE"); eq(byKey.CSE.code, "101");
  eq(byKey.ECE.dept, "ECE"); eq(byKey.ECE.code, "102");
  eq(byKey.EEE.dept, "EEE"); eq(byKey.EEE.code, "103");
  eq(byKey.MECH.dept, "MECH"); eq(byKey.MECH.code, "104");
});
it("resolves a known department even when no Branch Master is loaded", () => {
  // The app can run before a branch master is fetched; the alias map still
  // yields the canonical department, just without a numeric code.
  const bare = { ...CTX, branches: [] };
  const plan = api.catJsonPlan(DATA, bare, {});
  const aids = plan.sections.find((x) => x.key === "AI & DS");
  eq(aids.deptResolved.dept, "AIDS");
  eq(aids.deptResolved.code, "");
});
it("an unknown department is not invented and its section is blocked", () => {
  const doc = { departments: { XYZ: { department_name: "Made Up Studies",
    semester_subjects: { "Semester III": [{ subject_code: "XX101", subject_name: "Ghost", date: "2026-10-06", weekday: "TUESDAY", year: "II YEAR" }] } } } };
  const plan = api.catJsonPlan(doc, CTX, {});
  eq(plan.sections[0].deptResolved.ok, false);
  const res = api.catJsonSectionsToResults("x.json", plan, CTX);
  eq(res.length, 1);
  eq(res[0].status, "blocked");
  ok(/DEPARTMENT NOT FOUND/.test(res[0].error), res[0].error);
});

// ── 6. field mapping: date, semester, year, session, label, bucket ───────────
it("maps semester labels and study years to the app's semester/year", () => {
  const plan = api.catJsonPlan(DATA, CTX, {});
  const aids = plan.sections.find((x) => x.key === "AI & DS");
  const java = aids.entries.find((e) => e.subCode === "CS25C09");
  eq(java.sem, "03"); eq(java.year, "2"); eq(java.subjectName, "Java Programming");
  const dl = aids.entries.find((e) => e.subCode === "AD3501");
  eq(dl.sem, "05"); eq(dl.year, "3"); eq(dl.subjectName, "Deep Learning");
  const cse = plan.sections.find((x) => x.key === "CSE");
  const pm = cse.entries.find((e) => e.subCode === "GE3751");
  eq(pm.sem, "07"); eq(pm.year, "4");
});
it('reads "II YEAR (A & B)" as study year 2', () => {
  const plan = api.catJsonPlan(DATA, CTX, {});
  const cse = plan.sections.find((x) => x.key === "CSE");
  const row = cse.entries.find((e) => e.subCode === "CS25C10");
  eq(row.year, "2");
});
it("takes the session, assessment label and category bucket from metadata", () => {
  const plan = api.catJsonPlan(DATA, CTX, {});
  const e = plan.sections[0].entries.find((x) => x.subCode === "AD3501");
  eq(e.session, "FN", "9:30 AM -> forenoon");
  eq(e.label, "Continuous Assessment Test-II 2026-27");
  eq(e.bucket, "CAT");
  eq(e.assessment, "Continuous Assessment Test-II");
});
it("keeps every supplied date exactly as printed", () => {
  const plan = api.catJsonPlan(DATA, CTX, {});
  const eee = plan.sections.find((x) => x.key === "EEE");
  const last = eee.entries.find((e) => e.subCode === "EE3701");
  eq(last.date, "2026-10-16");
});

// ── 7. weekday validation (reported, never rewriting the date) ───────────────
it("the real file's weekdays all agree with their dates", () => {
  const plan = api.catJsonPlan(DATA, CTX, {});
  const all = plan.sections.reduce((a, sec) => a.concat(sec.entries), []);
  eq(all.filter((e) => (e.readerReasons || []).some((x) => x.indexOf("WEEKDAY MISMATCH") >= 0)).length, 0);
});
it("a wrong weekday is reported and the supplied date is kept", () => {
  const doc = { metadata: { academic_year: "2026-27" },
    departments: { CSE: { department_name: "Computer Science and Engineering",
      semester_subjects: { "Semester III": [{ subject_code: "CS25C08", subject_name: "DATA STRUCTURES", date: "2026-10-08", weekday: "MONDAY", year: "II YEAR" }] } } } };
  const plan = api.catJsonPlan(doc, CTX, {});
  const e = plan.sections[0].entries[0];
  eq(e.date, "2026-10-08", "date is the authority");
  ok(e.readerReasons.some((x) => x.indexOf("WEEKDAY MISMATCH") >= 0), e.readerReasons.join(" | "));
  ok(/THURSDAY/.test(e.readerReasons.join(" ")), "names the true weekday");
});

// ── 8. subject-master matching (review signal only) ──────────────────────────
it("matches a row to the Subject Master by code and semester", () => {
  const m = api.catJsonMatchSubject({ dept: "AIDS", sem: "05", subCode: "AD3501", subjectName: "Deep Learning" },
    [{ dept: "AIDS", semester: "05", code: "AD3501", name: "Deep Learning" }]);
  eq(m.status, "matched");
});
it("reports a row with no Subject Master match", () => {
  const m = api.catJsonMatchSubject({ dept: "AIDS", sem: "05", subCode: "AD3501", subjectName: "Deep Learning" },
    [{ dept: "AIDS", semester: "05", code: "ZZ9999", name: "Something Else" }]);
  eq(m.status, "unmatched");
});
it("reports a code that matches several subjects as ambiguous", () => {
  const m = api.catJsonMatchSubject({ dept: "AIDS", sem: "05", subCode: "AD3501", subjectName: "Deep Learning" },
    [{ dept: "AIDS", semester: "05", code: "AD3501", name: "Alpha" },
     { dept: "AIDS", semester: "05", code: "AD3501", name: "Beta" }]);
  eq(m.status, "ambiguous");
  eq(m.count, 2);
});
it("scopes subject matching to the row's own department", () => {
  const m = api.catJsonMatchSubject({ dept: "CSE", sem: "05", subCode: "AD3501", subjectName: "Deep Learning" },
    [{ dept: "AIDS", semester: "05", code: "AD3501", name: "Deep Learning" }]);
  eq(m.status, "unmatched");
});

// ── 9. null subject codes are shown blocked, never dropped ───────────────────
it("a row without a subject code is blocked and visible in the preview", () => {
  const plan = api.catJsonPlan(DATA, CTX, {});
  const res = api.catJsonSectionsToResults("t.json", plan, CTX);
  const aids = res.find((r) => r.name.indexOf("AIDS") >= 0);
  const nm = aids.preview.rows.find((r) => r.subjectName === "Naan Mudalvan");
  ok(nm, "the Naan Mudalvan row is in the preview");
  ok((nm.errors || []).indexOf("SUBJECT CODE NOT EXTRACTED") >= 0, nm.errors);
  eq(nm.ready, false);
  eq(aids.preview.summary.missingCodes, 1);
});

// ── 10. sections -> results: one result per department, same pipeline ────────
it("produces one JSON result per department, all ok, all through catBuildPreview", () => {
  const plan = api.catJsonPlan(DATA, CTX, {});
  const res = api.catJsonSectionsToResults("t.json", plan, CTX);
  eq(res.length, 5);
  res.forEach((r) => { eq(r.engine, "json"); eq(r.status, "ok"); ok(r.preview, r.name); });
});
it("a ready row carries exactly the fields the exam record is built from", () => {
  // These are the values commit() reads: subject/subjectTitle <- subjectName,
  // category <- bucket, examCategory <- label, subjectCode <- subCode,
  // departmentCode <- meta.departmentCode, plus date/session/sem/year.
  const plan = api.catJsonPlan(DATA, CTX, {});
  const res = api.catJsonSectionsToResults("t.json", plan, CTX);
  const aids = res.find((r) => r.name.indexOf("AIDS") >= 0);
  const row = aids.preview.rows.find((r) => r.subCode === "AD3501");
  eq(row.subjectName, "Deep Learning");
  eq(row.bucket, "CAT");
  eq(row.label, "Continuous Assessment Test-II 2026-27");
  eq(row.subCode, "AD3501");
  eq(row.dept, "AIDS");
  eq(row.sem, "05");
  eq(row.year, "3");
  eq(row.date, "2026-10-08");
  eq(row.session, "FN");
  eq(aids.meta.departmentCode, "105");
  eq(row.ready, true);
});

// ── 11. duplicate / re-import handling ───────────────────────────────────────
it("the same timetable twice in one batch is flagged, not created twice", () => {
  const plan = api.catJsonPlan(DATA, CTX, {});
  const once = api.catJsonSectionsToResults("t.json", plan, CTX);
  const twice = api.catCombineResults(once.concat(clone(once)), "COL1");
  eq(twice.summary.batchDuplicates, 75, "every coded row of the second copy");
  const repeated = twice.rows.filter((r) => !r.ignored && (r.errors || []).indexOf("REPEATED IN THIS BATCH") >= 0);
  eq(repeated.length, 75);
});
it("re-importing a timetable that already exists is flagged as ALREADY EXISTS", () => {
  const existing = {
    id: "E1", college_id: "COL1", date: "2026-10-08", session: "FN", subjectCode: "AD3501",
    category: "CAT", examCategory: "Continuous Assessment Test-II 2026-27",
    groups: [{ dept: "AIDS", sem: "05", year: "3" }],
  };
  const ctx = { ...CTX, exams: [existing] };
  const plan = api.catJsonPlan(DATA, ctx, {});
  const res = api.catJsonSectionsToResults("t.json", plan, ctx);
  const aids = res.find((r) => r.name.indexOf("AIDS") >= 0);
  const row = aids.preview.rows.find((r) => r.subCode === "AD3501");
  ok((row.errors || []).indexOf("ALREADY EXISTS") >= 0, row.errors);
  eq(row.ready, false);
  eq(aids.preview.summary.duplicates, 1);
});

// ── 12. revised / versioned timetable (additional_timetable_variants) ────────
const VARIANT_DOC = {
  metadata: { academic_year: "2026-27", assessment: "Continuous Assessment Test-II", exam_time: "9:30 AM to 12:30 PM" },
  departments: { ECE: { department_name: "Electronics and Communication Engineering",
    semester_subjects: { "Semester V": [
      { subject_code: "EC3551", subject_name: "Transmission Lines and RF Systems", date: "2026-10-09", weekday: "FRIDAY", year: "III YEAR" },
      { subject_code: "EC3501", subject_name: "Wireless Communication", date: "2026-10-08", weekday: "THURSDAY", year: "III YEAR" },
    ] } } },
  additional_timetable_variants: { ECE_revised: {
    department_name: "Electronics and Communication Engineering", timetable_variant: "ECE_revised",
    semester_subjects: { "Semester V": [
      { subject_code: "EC3551", subject_name: "Transmission Lines and RF Systems", date: "2026-10-09", weekday: "FRIDAY", year: "III YEAR" },
      { subject_code: "EC3501", subject_name: "Wireless Communication", date: "2026-10-10", weekday: "SATURDAY", year: "III YEAR" },
      { subject_code: "ZZ9999", subject_name: "Ghost Paper", date: "2026-10-11", weekday: "SUNDAY", year: "III YEAR" },
    ] } } },
};
it("plans the canonical department and the revised variant as separate sections", () => {
  const plan = api.catJsonPlan(VARIANT_DOC, CTX, {});
  eq(plan.sections.length, 2);
  const canon = plan.sections.find((x) => x.variant === "");
  const variant = plan.sections.find((x) => x.variant === "ECE_revised");
  eq(canon.entries.length, 2);
  eq(variant.entries.length, 3);
});
it("classifies revised rows as matched / changed / unmatched", () => {
  const plan = api.catJsonPlan(VARIANT_DOC, CTX, {});
  const variant = plan.sections.find((x) => x.variant === "ECE_revised");
  eq(variant.stats.matched, 1, "EC3551 same date");
  eq(variant.stats.changed, 1, "EC3501 moved");
  eq(variant.stats.unmatched, 1, "ZZ9999 has nothing published");
});
it("a revised row with the same date is set aside; a changed one blocks for review", () => {
  const plan = api.catJsonPlan(VARIANT_DOC, CTX, {});
  const variant = plan.sections.find((x) => x.variant === "ECE_revised");
  const same = variant.entries.find((e) => e.subCode === "EC3551");
  ok(same.ignored, "same date -> kept out");
  ok(/SAME DATE AS PUBLISHED/.test(same.reason), same.reason);
  const moved = variant.entries.find((e) => e.subCode === "EC3501");
  eq(moved.ignored, false);
  ok(moved.blockingReasons.some((x) => /DIFFERS FROM PUBLISHED/.test(x)), moved.blockingReasons.join(" | "));
  const ghost = variant.entries.find((e) => e.subCode === "ZZ9999");
  ok(ghost.ignored, "nothing to revise -> kept out");
});
it("a changed revision is surfaced on the canonical subject too", () => {
  const plan = api.catJsonPlan(VARIANT_DOC, CTX, {});
  const canon = plan.sections.find((x) => x.variant === "");
  const ec3501 = canon.entries.find((e) => e.subCode === "EC3501");
  ok(ec3501.readerReasons.some((x) => /A REVISED TIMETABLE EXISTS/.test(x)), ec3501.readerReasons.join(" | "));
});

// ── 13. tolerating extra / unknown keys ──────────────────────────────────────
it("ignores unknown top-level and per-subject keys without failing", () => {
  const doc = clone(DATA);
  doc.extra_top_level = { anything: true };
  doc.departments.CSE.semester_subjects["Semester III"][1].extra = "ignored";
  const p = api.catJsonParse(JSON.stringify(doc));
  ok(p.ok, p.error);
  const plan = api.catJsonPlan(p.data, CTX, {});
  eq(plan.sections.length, 5);
});

// ── 14. end-to-end file processing (catProcessJsonFile) ──────────────────────
ait("catProcessJsonFile turns a real file into per-department results", async () => {
  const res = await api.catProcessJsonFile(fileOf("cat.json", RAW), CTX, function () {});
  eq(res.length, 5);
  ok(res.every((r) => r.engine === "json"), "all JSON results");
  const combined = api.catCombineResults(res, "COL1");
  eq(combined.summary.jsonFiles, 5);
  eq(combined.summary.jsonSections, 5);
  eq(combined.summary.ready > 0, true);
});
ait("catProcessJsonFile reports invalid JSON as a blocked file", async () => {
  const res = await api.catProcessJsonFile(fileOf("bad.json", "{ nope "), CTX, function () {});
  eq(res.length, 1);
  eq(res[0].status, "blocked");
  eq(res[0].reason, "INVALID_JSON");
});
ait("catProcessJsonFile reports an empty file as blocked", async () => {
  const res = await api.catProcessJsonFile(fileOf("empty.json", ""), CTX, function () {});
  eq(res.length, 1);
  eq(res[0].status, "blocked");
  eq(res[0].reason, "EMPTY_FILE");
});

// ── 15. the combined preview read-out the modal shows ────────────────────────
ait("the combined summary counts JSON files, sections and subject matches", async () => {
  const ctx = { ...CTX, subjects: [
    { dept: "AIDS", semester: "05", code: "AD3501", name: "Deep Learning" },
    { dept: "CSE", semester: "05", code: "CCS375", name: "WEB TECHNOLOGIES" },
  ] };
  const res = await api.catProcessJsonFile(fileOf("cat.json", RAW), ctx, function () {});
  const c = api.catCombineResults(res, "COL1");
  eq(c.summary.jsonFiles, 5);
  eq(c.summary.subjectsMatched, 2, "AD3501 and CCS375");
  ok(c.summary.subjectsUnmatched > 60, "the rest have no master match");
  eq(c.summary.weekdayMismatch, 0);
});

// ── 16. an unreadable row (bad date / unknown year) blocks, not crashes ──────
it("a row with an unusable date is blocked by the shared validation gate", () => {
  const doc = { metadata: { academic_year: "2026-27" },
    departments: { CSE: { department_name: "Computer Science and Engineering",
      semester_subjects: { "Semester III": [{ subject_code: "CS25C08", subject_name: "DATA STRUCTURES", date: "not-a-date", weekday: "THURSDAY", year: "II YEAR" }] } } } };
  const plan = api.catJsonPlan(doc, CTX, {});
  const res = api.catJsonSectionsToResults("t.json", plan, CTX);
  const row = res[0].preview.rows[0];
  ok((row.errors || []).indexOf("INVALID DATE") >= 0, row.errors);
  eq(row.ready, false);
});

module.exports = s;
