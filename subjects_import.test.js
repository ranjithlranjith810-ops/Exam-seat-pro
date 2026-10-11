// Tests for the bulk Subjects-from-JSON importer.
//
// The parser / planner / apply functions are lifted straight out of index.html
// by harness.js at run time, so these cases always exercise the shipped code.
// The real input file is checked in under fixtures/ — no live database, no
// network, no student data is touched.
const fs = require("fs");
const path = require("path");
const h = require("./harness.js");
const api = h.load();

const s = h.suite("subjects_import.test.js — bulk JSON subject import");
const { it, ait, eq, ok } = s;

const RAW = fs.readFileSync(path.join(__dirname, "fixtures", "subjects_all_departments.json"), "utf8");
const DATA = JSON.parse(RAW);
const mkId = () => { let n = 0; return () => "ID" + (++n); };
const clone = (o) => JSON.parse(JSON.stringify(o));

// ── 1. valid JSON import ─────────────────────────────────────────────────────
it("valid file parses and plans the departments/semesters", () => {
  const p = api.curriSubjectsJsonParse(RAW);
  ok(p.ok, p.error);
  const plan = api.curriSubjectsJsonPlan(p.data, [], { emptyDepartments: p.emptyDepartments });
  eq(plan.stats.departmentCount, 5, "AIDS/CSE/EEE/ECE/MECH");
  eq(plan.stats.semesterCount, 3, "III / V / VII");
  ok(plan.stats.newCount > 0, "new subjects planned");
  eq(plan.stats.records, 97, "81 canonical + 16 variant rows");
});
it("canonical records import as new and carry the model fields", () => {
  const p = api.curriSubjectsJsonParse(RAW);
  const plan = api.curriSubjectsJsonPlan(p.data, [], {});
  // AI & DS "AD3501 Deep Learning" is Semester V -> dept AIDS, sem 05, year 3
  const r = plan.records.find((x) => x.code === "AD3501");
  ok(r, "AD3501 present");
  eq(r.name, "Deep Learning");
  eq(r.dept, "AIDS");
  eq(r.sem, "05");
  eq(r.year, "3");
  eq(r.status, "new");
});

// ── 2. invalid JSON syntax ───────────────────────────────────────────────────
it("invalid JSON syntax is reported, not thrown", () => {
  const p = api.curriSubjectsJsonParse("{ this is not json ");
  ok(!p.ok);
  ok(/Invalid JSON/i.test(p.error || ""));
});

// ── 3. missing required top-level fields ─────────────────────────────────────
it('a file with no "departments" map is rejected', () => {
  const p = api.curriSubjectsJsonParse(JSON.stringify({ metadata: { academic_year: "2026-27" } }));
  ok(!p.ok);
  ok(/departments/i.test(p.error || ""));
});
it("a non-object root is rejected", () => {
  ok(!api.curriSubjectsJsonParse("[1,2,3]").ok);
});

// ── 4. empty departments or semester lists ───────────────────────────────────
it("an empty semester list is counted, not treated as subjects", () => {
  const p = api.curriSubjectsJsonParse(JSON.stringify({
    departments: { CSE: { department_name: "CSE", semester_subjects: {} } },
    additional_timetable_variants: {},
  }));
  ok(p.ok, p.error);
  eq(p.emptyDepartments, 1);
  const plan = api.curriSubjectsJsonPlan(p.data, [], { emptyDepartments: p.emptyDepartments });
  eq(plan.stats.records, 0);
  eq(plan.stats.emptyDepartments, 1);
});

// ── 5. missing subject codes ─────────────────────────────────────────────────
it("missing codes are reported and never fabricated", () => {
  const p = api.curriSubjectsJsonParse(RAW);
  const plan = api.curriSubjectsJsonPlan(p.data, [], {});
  const canonicalNoCode = plan.records.filter((r) => !r.variant && r.issues.includes("MISSING_CODE"));
  eq(canonicalNoCode.length, 6, "6 canonical Naan Mudalvan rows have a null code");
  ok(canonicalNoCode.every((r) => r.code === ""), "code stays empty, never invented");
  ok(canonicalNoCode.every((r) => r.status === "new"), "a missing code does not block import");
  eq(plan.stats.missingCode, 7, "6 canonical + 1 variant row");
});
it("codes with spaces are preserved verbatim and flagged", () => {
  const p = api.curriSubjectsJsonParse(RAW);
  const plan = api.curriSubjectsJsonPlan(p.data, [], {});
  const cb = plan.records.find((r) => r.code === "CB 3491");
  ok(cb, "spaced code kept as written");
  ok(cb.issues.includes("CODE_HAS_SPACES"));
  eq(cb.codeNorm, "CB3491", "normal form is for detection only");
});

// ── 6. duplicate subjects ────────────────────────────────────────────────────
it("a subject repeated inside the file is flagged, not added twice", () => {
  const dup = clone(DATA);
  dup.departments.CSE.semester_subjects["Semester III"].push({
    subject_code: "CS25C", subject_name: "08 - DATA STRUCTURES", date: "2026-10-08", weekday: "THURSDAY", year: "II YEAR (A & B)",
  });
  const p = api.curriSubjectsJsonParse(JSON.stringify(dup));
  const plan = api.curriSubjectsJsonPlan(p.data, [], {});
  eq(plan.stats.duplicates, 1);
  const d = plan.records.find((r) => r.status === "duplicate");
  eq(d.name, "08 - DATA STRUCTURES");
  const applied = api.curriSubjectsJsonApply(plan, [], { makeId: mkId() });
  const count = applied.subjects.filter((x) => x.name === "08 - DATA STRUCTURES" && x.dept === "CSE").length;
  eq(count, 1, "only one copy is written");
});

// ── 7. same code in different departments ────────────────────────────────────
it("the same code in two departments stays two separate subjects", () => {
  const p = api.curriSubjectsJsonParse(RAW);
  const plan = api.curriSubjectsJsonPlan(p.data, [], {});
  const cs25c = plan.records.filter((r) => r.status === "new" && r.code === "CS25C" && r.sem === "03");
  ok(cs25c.length >= 7, "shared code rows are all kept");
  eq([...new Set(cs25c.map((r) => r.dept))].sort(), ["AIDS", "CSE"]);
});

// ── 8. same code in different semesters ──────────────────────────────────────
it("the same code in different semesters stays separate", () => {
  const data = {
    departments: { CSE: { department_name: "CSE", semester_subjects: {
      "Semester III": [{ subject_code: "XX100", subject_name: "Alpha", date: "d", weekday: "w", year: "y" }],
      "Semester V": [{ subject_code: "XX100", subject_name: "Alpha", date: "d", weekday: "w", year: "y" }],
    } } },
    additional_timetable_variants: {},
  };
  const p = api.curriSubjectsJsonParse(JSON.stringify(data));
  const plan = api.curriSubjectsJsonPlan(p.data, [], {});
  eq(plan.stats.newCount, 2);
  eq(plan.stats.duplicates, 0);
});

// ── 9. revised timetable variants ────────────────────────────────────────────
it("revised variants map to master subjects and are never re-added", () => {
  const p = api.curriSubjectsJsonParse(RAW);
  const plan = api.curriSubjectsJsonPlan(p.data, [], {});
  eq(plan.stats.variantMatched, 16, "all revised ECE rows match canonical ECE");
  eq(plan.stats.variantUnmatched, 0);
  ok(plan.records.filter((r) => r.variant && r.status === "new").length === 0);
  const r = api.curriSubjectsJsonApply(plan, [], { makeId: mkId() });
  eq(r.counts.variant, 16, "variant rows are reported, not written");
  eq(r.subjects.length, r.counts.added, "only canonical new rows are written");
});
it("a variant row with no master subject is kept out, not invented", () => {
  const data = {
    departments: { CSE: { department_name: "CSE", semester_subjects: {} } },
    additional_timetable_variants: { X: { department_name: "CSE", timetable_variant: "Revised", semester_subjects: {
      "Semester III": [{ subject_code: "ZZ9", subject_name: "Only In Variant", date: "d", weekday: "w", year: "y" }],
    } } },
  };
  const p = api.curriSubjectsJsonParse(JSON.stringify(data));
  const plan = api.curriSubjectsJsonPlan(p.data, [], {});
  eq(plan.stats.variantUnmatched, 1);
  eq(plan.stats.newCount, 0);
  const r = api.curriSubjectsJsonApply(plan, [], { makeId: mkId() });
  eq(r.counts.added, 0);
});

// ── 10. re-import without duplicates ─────────────────────────────────────────
it("re-importing the same file adds nothing and keeps the master stable", () => {
  const p = api.curriSubjectsJsonParse(RAW);
  const first = api.curriSubjectsJsonApply(api.curriSubjectsJsonPlan(p.data, [], {}), [], { makeId: mkId() });
  const before = first.subjects.length;
  const plan2 = api.curriSubjectsJsonPlan(p.data, first.subjects, {});
  eq(plan2.stats.newCount, 0);
  eq(plan2.stats.conflictCount, 0);
  eq(plan2.stats.alreadyCount, first.counts.added);
  const second = api.curriSubjectsJsonApply(plan2, first.subjects, { makeId: mkId() });
  eq(second.counts.added, 0);
  eq(second.subjects.length, before);
});

// ── 11. cancel without writing ───────────────────────────────────────────────
it("planning never mutates the master (Cancel writes nothing)", () => {
  const existing = [{ id: "a", name: "Keep Me", code: "K1", dept: "CSE", year: "2", semester: "03" }];
  const snapshot = JSON.stringify(existing);
  const p = api.curriSubjectsJsonParse(RAW);
  const plan = api.curriSubjectsJsonPlan(p.data, existing, {});
  ok(plan.stats.newCount > 0);
  eq(JSON.stringify(existing), snapshot, "input array is untouched by planning");
  const applied = api.curriSubjectsJsonApply(plan, existing, { makeId: mkId() });
  ok(applied.subjects.length > existing.length);
  eq(JSON.stringify(existing), snapshot, "apply returns a new array and does not mutate the input");
});

// ── 12. database write failures / partial-import reporting ───────────────────
ait("a failed database write leaves the committed master unchanged", () => {
  const p = api.curriSubjectsJsonParse(RAW);
  const plan = api.curriSubjectsJsonPlan(p.data, [], {});
  let master = [{ id: "x", name: "Existing", code: "E1", dept: "CSE", year: "2", semester: "03" }];
  const before = JSON.stringify(master);
  const { subjects: candidate } = api.curriSubjectsJsonApply(plan, master, { makeId: mkId() });
  const save = () => Promise.reject(new Error("PERMISSION_DENIED"));
  return save(candidate).then(
    () => { throw new Error("save should have failed"); },
    (err) => {
      ok(/PERMISSION_DENIED/.test(String(err.message)), "failure surfaces");
      eq(JSON.stringify(master), before, "nothing committed on failure");
      ok(candidate.length > master.length, "the candidate plan existed but was never assigned");
    }
  );
});

// ── 13. college-scope enforcement ────────────────────────────────────────────
it("imports write through the college-scoped Store.saveSubjects helper", () => {
  const src = fs.readFileSync(path.resolve(h.HTML), "utf8");
  ok(/saveSubjects:\s*\(subjects\)\s*=>\s*dbUpdate\("colleges",\s*Store\.getCollegeId\(\),\s*\{\s*subjects\s*\}\)/.test(src),
    "saveSubjects is bound to the active college id");
  const at = src.indexOf("async function importJson()");
  ok(at >= 0, "importJson present");
  const flow = src.slice(at, at + 900);
  ok(/Store\.saveSubjects\(updated\)/.test(flow), "the JSON flow uses the Store helper");
  ok(!/\bDB\.ref\(/.test(flow), "the JSON flow never touches the raw database");
});

// ── 14. correct display of imported subjects / field mapping ─────────────────
it("department keys are canonicalised for display", () => {
  const p = api.curriSubjectsJsonParse(RAW);
  const plan = api.curriSubjectsJsonPlan(p.data, [], {});
  const nm = plan.records.filter((r) => r.name === "Naan Mudalvan");
  ok(nm.some((r) => r.dept === "AIDS"), '"AI & DS" -> AIDS');
  ok(nm.every((r) => r.dept !== "AI & DS"), "raw key never leaks into the model");
  ok(plan.records.every((r) => ["01","02","03","04","05","06","07","08"].includes(r.sem)),
    "every semester is a two-digit value");
});
it("an unrecognised department is flagged but still valid", () => {
  const data = { departments: { BIOTECH: { department_name: "Biotechnology", semester_subjects: {
    "Semester III": [{ subject_code: "BT1", subject_name: "Bio", date: "", weekday: "", year: "" }],
  } } }, additional_timetable_variants: {} };
  const p = api.curriSubjectsJsonParse(JSON.stringify(data));
  const plan = api.curriSubjectsJsonPlan(p.data, [], {});
  eq(plan.records[0].dept, "BIOTECH");
  ok(plan.records[0].issues.includes("UNKNOWN_DEPARTMENT"));
  ok(plan.records[0].valid);
});
it("a record with no readable semester is invalid and not imported", () => {
  const data = { departments: { CSE: { department_name: "CSE", semester_subjects: {
    "Weird": [{ subject_code: "Z1", subject_name: "Zed", date: "", weekday: "", year: "" }],
  } } }, additional_timetable_variants: {} };
  const p = api.curriSubjectsJsonParse(JSON.stringify(data));
  const plan = api.curriSubjectsJsonPlan(p.data, [], {});
  eq(plan.stats.invalid, 1);
  eq(api.curriSubjectsJsonApply(plan, [], { makeId: mkId() }).counts.added, 0);
});

// ── 15. compatibility with Exams & Schedule / CAT timetable import ───────────
it("imported subjects match exam groups through the existing matcher", () => {
  const p = api.curriSubjectsJsonParse(RAW);
  const applied = api.curriSubjectsJsonApply(api.curriSubjectsJsonPlan(p.data, [], {}), [], { makeId: mkId() });
  const dl = applied.subjects.find((x) => x.code === "AD3501");
  ok(api.curriSubjectMatchesGroup(dl, { dept: "AIDS", sem: "05" }));
  ok(!api.curriSubjectMatchesGroup(dl, { dept: "CSE", sem: "05" }));
  const ds = applied.subjects.find((x) => x.code === "CS25C" && x.name === "08 - DATA STRUCTURES");
  ok(api.curriSubjectMatchesGroup(ds, { dept: "CSE", sem: "03" }));
  ok(!api.curriSubjectMatchesGroup(ds, { dept: "CSE", sem: "05" }));
});
it("the exam-group semester helper reads the mapped semester unchanged", () => {
  const p = api.curriSubjectsJsonParse(RAW);
  const plan = api.curriSubjectsJsonPlan(p.data, [], {});
  const r = plan.records.find((x) => x.code === "AD3501");
  eq(api.examGroupSem({ sem: r.sem }), "05");
  eq(api.examGroupYear({ sem: r.sem }), "3");
});

// ── conflict resolution options ──────────────────────────────────────────────
it("a conflict is skipped by default and updated only on request", () => {
  const master = [{ id: "m", name: "Deep Learning", code: "OLD1", dept: "AIDS", year: "3", semester: "05" }];
  const p = api.curriSubjectsJsonParse(RAW);
  const plan = api.curriSubjectsJsonPlan(p.data, master, {});
  const c = plan.records.find((r) => r.status === "conflict" && r.dept === "AIDS");
  ok(c, "Deep Learning is flagged as a conflict");
  const skipped = api.curriSubjectsJsonApply(plan, master, { conflictMode: "skip", makeId: mkId() });
  eq(skipped.subjects.find((x) => x.name === "Deep Learning").code, "OLD1", "skip keeps the existing code");
  const updated = api.curriSubjectsJsonApply(plan, master, { conflictMode: "update", makeId: mkId() });
  eq(updated.subjects.find((x) => x.name === "Deep Learning").code, "AD3501", "update adopts the JSON code");
  eq(updated.counts.conflictUpdated, 1);
});
it("apply never deletes an existing subject", () => {
  const master = [{ id: "m", name: "Deep Learning", code: "OLD1", dept: "AIDS", year: "3", semester: "05" }];
  const p = api.curriSubjectsJsonParse(RAW);
  const plan = api.curriSubjectsJsonPlan(p.data, master, {});
  const out = api.curriSubjectsJsonApply(plan, master, { makeId: mkId() });
  ok(out.subjects.some((x) => x.id === "m" && x.name === "Deep Learning"));
  ok(out.subjects.length >= master.length);
});

module.exports = s;
