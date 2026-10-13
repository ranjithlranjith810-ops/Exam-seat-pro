// Permanent student-data consistency regression tests.
//
// The root cause this suite pins: a register number is a MUTABLE key, but it is
// the ONLY link from a student to an exam's registerNumbers[] candidate list and
// to a saved seat slot. Nothing used to stop an edit (department/year change),
// a deletion, a duplicate import or a missed correction from silently breaking
// that link — after which the next generation simply dropped the student and the
// exam roster shrank without anyone noticing.
//
// The fix is ONE pure consistency layer (studentRegnoIndex, examEligibilityMatch,
// examCandidateAudit, studentExamDetachImpact, studentReferenceImpact) that the
// matcher, the generator, the CSV import and every mutation gate all share. These
// tests assert the layer directly AND assert (at the source level) that the app
// actually calls it, so a passing test can never be a stale copy.
const fs = require("fs");
const h = require("./harness.js");
const api = h.load();

const s = h.suite("student_data_consistency.test.js — mutations keep candidate lists, plans and notices consistent");
const { it, eq, ok } = s;

const html = fs.readFileSync(h.HTML, "utf8");

function stu(id, regno, dept, year, college) {
  return { id: id, regno: regno, name: "STU " + id, dept: dept, year: year, semester: "", gender: "male", college_id: college || "c1" };
}
function exam(id, o) {
  o = o || {};
  const regnos = o.regnos || [];
  return {
    id: id, date: o.date || "2026-10-14", session: o.session || "FN",
    college_id: o.college || "c1", subjectTitle: o.subject || "SUBJECT",
    groups: o.groups || [{ dept: "CSE", year: 2 }],
    registerNumbers: regnos.slice(), studentCount: regnos.length,
  };
}
function lookups(roster, exams, halls) { return api.bulkBuildLookups(roster, exams || [], halls || []); }

// ── S1. the regno index groups records and reports AMBIGUOUS identities ───────
it("S1: studentRegnoIndex groups by register number and flags duplicates", () => {
  const idx = api.studentRegnoIndex([
    stu(1, "953021104001", "CSE", 2),
    stu(2, "953021104001", "CSE", 2),
    stu(3, "953021104002", "CSE", 2),
  ]);
  eq(idx.byRegno.get("953021104001").length, 2, "both records indexed under the shared regno");
  eq(idx.byRegno.get("953021104002").length, 1, "the unique regno maps to one record");
  eq(idx.duplicates.map(function (d) { return d.regno; }), ["953021104001"], "only the shared regno is reported as a duplicate");
});

// ── S2. eligibility is the same dept+year predicate the matcher uses ──────────
it("S2: examEligibilityMatch folds dept aliases and never matches another year", () => {
  const e = exam("e", { groups: [{ dept: "CSE", year: 2 }] });
  ok(api.examEligibilityMatch(e, stu(1, "953021104001", "cse", 2)), "spelling/case folds to the same dept");
  ok(!api.examEligibilityMatch(e, stu(2, "953021104002", "CSE", 3)), "a different year is not eligible");
  ok(!api.examEligibilityMatch(e, stu(3, "953021104003", "ECE", 2)), "a different dept is not eligible");
});

// ── S3. a clean candidate list audits ok and returns the resolved roster ──────
it("S3: a clean candidate list audits ok and resolves every listed student", () => {
  const roster = [stu(1, "953021104001", "CSE", 2), stu(2, "953021104002", "CSE", 2)];
  const e = exam("e", { regnos: ["953021104001", "953021104002"] });
  const a = api.examCandidateAudit(e, roster, lookups(roster, [e]));
  ok(a.ok, "no problems");
  eq(a.listed, 2, "two candidates listed");
  eq(a.matched.map(function (x) { return x.id; }), [1, 2], "both resolve to the current roster");
  eq(a.problems, [], "no blocking problems");
});

// ── S4. a ghost candidate (no student record) is a BLOCKING problem ───────────
it("S4: an unresolved candidate register number blocks generation", () => {
  const roster = [stu(1, "953021104001", "CSE", 2)];
  const e = exam("e", { regnos: ["953021104001", "953021104099"] });
  const a = api.examCandidateAudit(e, roster, lookups(roster, [e]));
  ok(!a.ok, "the audit refuses");
  eq(a.unresolved, ["953021104099"], "the ghost is named");
  eq(a.problems[0].code, "unresolved", "categorised as unresolved");
  ok(a.problems[0].message.indexOf("953021104099") >= 0, "the message names the register number");
});

// ── S5. a listed student who no longer matches the groups is ineligible ───────
it("S5: a listed student who changed department becomes ineligible", () => {
  const roster = [stu(1, "953021104001", "EEE", 2)]; // was CSE when listed
  const e = exam("e", { regnos: ["953021104001"], groups: [{ dept: "CSE", year: 2 }] });
  const a = api.examCandidateAudit(e, roster, lookups(roster, [e]));
  ok(!a.ok, "the audit refuses");
  eq(a.ineligible.map(function (x) { return x.regno; }), ["953021104001"], "the detached student is named");
  eq(a.problems[0].code, "ineligible", "categorised as ineligible");
});

// ── S6. one register number held by two records is an AMBIGUOUS conflict ──────
it("S6: a duplicated register number is a conflict, never silently collapsed", () => {
  const roster = [stu(1, "953021104001", "CSE", 2), stu(2, "953021104001", "CSE", 2)];
  const e = exam("e", { regnos: ["953021104001"] });
  const a = api.examCandidateAudit(e, roster, lookups(roster, [e]));
  ok(!a.ok, "the audit refuses");
  eq(a.conflicts, ["953021104001"], "the ambiguous regno is reported");
  eq(a.problems[0].code, "conflict", "categorised as conflict");
});

// ── S6b. a listed student from another college is a conflict ──────────────────
it("S6b: a listed student owned by another college is a conflict", () => {
  const roster = [stu(1, "953021104001", "CSE", 2, "c2")]; // exam is c1
  const e = exam("e", { regnos: ["953021104001"], college: "c1" });
  const a = api.examCandidateAudit(e, roster, lookups(roster, [e]));
  ok(!a.ok, "the audit refuses");
  eq(a.conflicts, ["953021104001"], "the cross-college regno is reported");
});

// ── S7. a repeated register number in the list is merged, not a failure ───────
it("S7: a register number listed twice is merged with a warning, not blocked", () => {
  const roster = [stu(1, "953021104001", "CSE", 2)];
  const e = exam("e", { regnos: ["953021104001", "953021104001"] });
  const a = api.examCandidateAudit(e, roster, lookups(roster, [e]));
  ok(a.ok, "a within-list duplicate is safe to merge");
  eq(a.listed, 1, "the listed count is de-duplicated");
  eq(a.duplicates, ["953021104001"], "the merged duplicate is reported");
  eq(a.warnings.length, 1, "exactly one warning");
  eq(a.warnings[0].code, "duplicate_listed", "categorised as a merged duplicate");
});

// ── S8. the audit and the matcher agree on who is a candidate ─────────────────
it("S8: audit.matched is exactly what the matcher returns (one predicate)", () => {
  const roster = [
    stu(1, "953021104001", "CSE", 2),
    stu(2, "953021104002", "ECE", 2), // not an exam group dept
    stu(3, "953021104003", "CSE", 3), // wrong year
  ];
  const e = exam("e", { regnos: ["953021104001", "953021104002", "953021104003"] });
  const a = api.examCandidateAudit(e, roster, lookups(roster, [e]));
  eq(a.matched.map(function (x) { return x.id; }), api.bulkExamStudents(e, roster, lookups(roster, [e])).map(function (x) { return x.id; }), "audit and matcher never disagree");
  ok(!a.ok, "the two non-matching listed records are surfaced as ineligible");
});

// ── S9. detach impact is exactly the exams a change would silently shrink ─────
it("S9: studentExamDetachImpact reports only exams that would drop the student", () => {
  const e1 = exam("e1", { regnos: ["953021104001"], groups: [{ dept: "CSE", year: 2 }], subject: "DSA" });
  const e2 = exam("e2", { regnos: ["953021204001"], groups: [{ dept: "ECE", year: 2 }], subject: "EC" });
  const changed = stu(1, "953021104001", "EEE", 2); // moving out of CSE
  eq(api.studentExamDetachImpact(changed, [e1, e2]).map(function (x) { return x.examId; }), ["e1"], "only the exam that lists the student and no longer matches");
  const same = stu(1, "953021104001", "cse", 2); // still matches
  eq(api.studentExamDetachImpact(same, [e1, e2]), [], "no detach when the student still matches");
});

// ── S10. planHasRegno finds a register number in any seat slot ────────────────
it("S10: planHasRegno scans every hall's seat slots", () => {
  const plan = { h1: { seats: [{ regno: "953021104001", slot: 1 }, { regno: "953021104002", slot: 2 }] }, h2: { seats: [] } };
  ok(api.planHasRegno(plan, "953021104001"), "found in h1");
  ok(api.planHasRegno(plan, "953021104002"), "found in the second slot");
  ok(!api.planHasRegno(plan, "953021104099"), "an absent regno is not found");
  ok(!api.planHasRegno({}, "953021104001"), "an empty plan references nobody");
});

// ── S11. reference impact covers both candidate lists and saved plans ─────────
it("S11: studentReferenceImpact reports exam and plan references (and referenced flag)", () => {
  const e = exam("e1", { regnos: ["953021104001"], subject: "DSA" });
  const planDocs = [{ id: "p1", exam_id: "e1", plan: { h1: { seats: [{ regno: "953021104001" }] } } }];
  const imp = api.studentReferenceImpact(stu(1, "953021104001", "CSE", 2), [e], planDocs);
  ok(imp.referenced, "referenced");
  eq(imp.exams.map(function (x) { return x.examId; }), ["e1"], "the exam is listed");
  eq(imp.plans.map(function (x) { return x.planId; }), ["p1"], "the plan is listed");
  const none = api.studentReferenceImpact(stu(9, "953021104009", "CSE", 2), [e], planDocs);
  ok(!none.referenced, "an unreferenced student is safe");
  eq(none.exams, [], "no exam references");
  eq(none.plans, [], "no plan references");
});

// ── S12. the generator's candidate gate uses the SAME audit ───────────────────
it("S12: bulkGenerateOne refuses a bad candidate list before touching any hall", () => {
  const roster = [stu(1, "953021104001", "CSE", 2)];
  const bad = exam("bad", { regnos: ["953021104099"] }); // ghost
  const res = api.bulkGenerateOne(bad, roster, [], {}, [bad], {}, lookups(roster, [bad]));
  ok(!res.ok, "refused");
  eq(res.code, "candidate_mismatch", "categorised as a candidate mismatch");
  eq(res.category, "CANDIDATE_MISMATCH", "category surfaced to the runner");
  eq(res.problems.length, 1, "the blocking problem travels with the result");
});

// ── S12b. a clean list is NOT refused by the gate ─────────────────────────────
it("S12b: a clean candidate list passes the generator's candidate gate", () => {
  const roster = [stu(1, "953021104001", "CSE", 2)];
  const good = exam("good", { regnos: ["953021104001"] });
  const halls = [{ id: "h1", name: "h1", capacity: 30, numbenches: 1, studentsperbench: 30, layoutConfig: { columns: [{ seats: 30 }] } }];
  const res = api.bulkGenerateOne(good, roster, halls, {}, [good], {}, lookups(roster, [good], halls));
  ok(res.code !== "candidate_mismatch", "the candidate gate does not fire on a clean list (got " + res.code + ")");
});

// ── source guards: every mutation and generator path calls the shared layer ───
function sliceAt(marker, endMarker) {
  const start = html.indexOf(marker);
  ok(start >= 0, marker + " exists");
  const end = html.indexOf(endMarker, start + marker.length);
  ok(end >= 0, marker + " has a body terminator (" + endMarker + ")");
  return html.slice(start, end);
}

it("SR1: Store.updateStudent blocks a detach by default and honours both overrides", () => {
  const body = sliceAt("updateStudent: async", "\n  },");
  ok(body.indexOf("studentExamDetachImpact(merged, exams)") >= 0, "the pure detach check is used");
  ok(body.indexOf("options.skipDetachCheck") >= 0, "a pre-validated batch can skip the per-row read");
  ok(body.indexOf("options.allowDetach") >= 0, "an explicit acknowledgement can override");
  ok(body.indexOf("would detach") >= 0, "the refusal reason is explicit");
});

it("SR2: deleteStudent / bulkDeleteStudents refuse a referenced student unless forced", () => {
  const del = sliceAt("deleteStudent: async", "\n  },");
  ok(del.indexOf("studentReferenceImpact(current, exams, planDocs)") >= 0, "the single delete checks references");
  ok(del.indexOf("options.force") >= 0, "an explicit force is honoured");
  const bulk = sliceAt("bulkDeleteStudents: async", "\n  },");
  ok(bulk.indexOf("studentReferenceImpact(s, exams, planDocs)") >= 0, "the bulk delete checks each student");
  ok(bulk.indexOf("options.force") >= 0, "an explicit force is honoured");
});

it("SR3: bulkAddStudents refuses an in-batch duplicate register number", () => {
  ok(html.indexOf("studentRegnoIndex(list).duplicates") >= 0, "the batch is indexed with the shared helper");
  ok(html.indexOf("Import blocked: duplicate register number") >= 0, "the refusal is explicit");
});

it("SR4: bulkExamRows surfaces the audit (stale + ineligible + problems + warnings)", () => {
  const rows = sliceAt("function bulkExamRows(", "\nfunction bulkSelectHalls(");
  ok(rows.indexOf("examCandidateAudit(exam, students, lookups)") >= 0, "the row audit is the shared audit");
  ok(rows.indexOf("staleCandidates: audit.unresolved") >= 0, "stale candidates are surfaced");
  ok(rows.indexOf("ineligibleCandidates: audit.ineligible") >= 0, "ineligible candidates are surfaced");
  ok(rows.indexOf("candidateProblems: audit.problems") >= 0, "blocking problems are surfaced");
  ok(rows.indexOf("candidateWarnings: audit.warnings") >= 0, "merged-duplicate warnings are surfaced");
  ok(rows.indexOf("else if (!audit.ok)") >= 0, "a failed audit makes the exam ineligible");
});

it("SR5: the bulk and co-seated runners gate on the same audit", () => {
  ok(html.indexOf('code: "candidate_mismatch"') >= 0, "the per-exam gate has a candidate_mismatch code");
  ok(html.indexOf('category: "CANDIDATE_MISMATCH"') >= 0, "the per-exam gate carries a category");
  ok(html.indexOf("examCandidateAudit(e,students,lookups)") >= 0, "the co-seated runner audits each active exam");
  ok(html.indexOf('category:"INVALID_COMBINED_ROSTER"') >= 0, "a bad combined roster fails the whole step");
});

it("SR6: the single-exam generator gates on the audit before building groups", () => {
  ok(html.indexOf("examCandidateAudit(exam, students)") >= 0, "the single-exam path audits the candidate list");
  ok(html.indexOf('"Seating stopped — " + audit.problems[0].message') >= 0, "a bad audit stops generation visibly");
});

it("SR7: the CSV update path pre-validates the whole batch and writes all-or-nothing", () => {
  const cu = sliceAt("async function confirmUpload(", "\n  }");
  ok(cu.indexOf("studentExamDetachImpact(merged, collegeExams)") >= 0, "every change is pre-checked against the exams");
  ok(cu.indexOf("skipDetachCheck: true") >= 0, "the pre-validated batch skips the per-row detach read");
  ok(cu.indexOf("Upload stopped") >= 0, "the batch is refused as a whole before any write");
});

it("SR8: the UI surfaces the confirmations and retries with the override", () => {
  ok(html.indexOf("allowDetach: true") >= 0, "the edit form retries a detaching change with allowDetach");
  ok(html.indexOf("deleteStudent(s.id, { force: true })") >= 0, "the single-delete path retries with force");
  ok(html.indexOf("bulkDeleteStudents(ids, { force: true })") >= 0, "the bulk-delete path retries with force");
});

it("SR9: notices prefer the current roster name/department and warn on unresolved seats", () => {
  ok(html.indexOf("const deptRaw = (st && st.dept) || s.dept") >= 0, "the notice dept prefers the roster");
  ok(html.indexOf("name: (st && st.name) || s.name") >= 0, "the notice name prefers the roster");
  ok(html.indexOf("unresolvedSeatCount") >= 0, "unresolved seats are counted");
  ok(html.indexOf("name a register number with no student record") >= 0, "an unresolved seat produces a warning");
});

module.exports = s;
