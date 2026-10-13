// Exam candidate-list correction regression tests.
//
// Companion to regno_migration.test.js. When a register-number correction was
// MISSED at the time (or a ghost candidate was imported), the exam's
// registerNumbers[] candidate list still holds a register number with no student
// record. bulkExamStudents intersects the candidate list with real students, so
// that ghost is silently dropped at seating time and the affected student is never
// seated. This suite pins the pure correction builder and the wiring that applies
// it as ONE ownership-checked atomic write.
const fs = require("fs");
const h = require("./harness.js");
const api = h.load();

const s = h.suite("exam_candidate_fix.test.js — a stale exam candidate is corrected atomically");
const { it, eq, ok } = s;

const EXAM = "MV6F3124A69519B9";
const R_GHOST = "953025105006";   // in the exam's candidate list, no student record
const R_REAL = "953025105009";    // the real student (currently absent from the list)
const R_OTHER = "953025105010";   // a different, real student already listed
const R_FOREIGN = "953024106022"; // a real student but in ANOTHER college

function stu(id, regno, name, college, dept) {
  return { id: id, regno: regno, name: name, dept: dept || "EEE", year: 2, semester: 3, gender: "male", college_id: college || "c1" };
}
function exam(registerNumbers, college) {
  return { id: EXAM, date: "2026-10-14", session: "FN", subjectTitle: "MATRICES FOR ENGINEERS", college_id: college || "c1", groups: [{ dept: "EEE", year: 2 }], registerNumbers: registerNumbers.slice(), studentCount: registerNumbers.length };
}

function students() {
  return [
    stu("st-real", R_REAL, "MASANA KUMAR M", "c1", "EEE"),
    stu("st-other", R_OTHER, "PON RAHUL P", "c1", "EEE"),
    stu("st-foreign", R_FOREIGN, "MUTHUSELVI V", "c2", "ECE"),
  ];
}

// Apply a flat RTDB-style update map all-or-nothing (mirrors DB.ref("/").update).
function applyAtomic(root, updates, fail) {
  if (fail) throw new Error("simulated write failure");
  Object.keys(updates).forEach(function (p) {
    const parts = p.split("/");
    let n = root;
    for (let i = 0; i < parts.length - 1; i++) { if (!n[parts[i]] || typeof n[parts[i]] !== "object") n[parts[i]] = {}; n = n[parts[i]]; }
    n[parts[parts.length - 1]] = updates[p];
  });
  return root;
}

// ── T1. the ghost is replaced by the real student's regno; the count is intact ──
it("T1: replaces the ghost, keeps the candidate count, and names the student", () => {
  const e = exam([R_REAL.replace(R_REAL, R_GHOST), R_OTHER, "953025105001"]);
  const res = api.examCandidateCorrection(e, R_GHOST, R_REAL, students());
  ok(res.ok, "correction succeeds: " + res.error);
  eq(res.updates["exams/" + EXAM + "/registerNumbers"], [R_REAL, R_OTHER, "953025105001"], "ghost replaced in place, order preserved");
  eq(res.updates["exams/" + EXAM + "/studentCount"], 3, "studentCount tracks the corrected list");
  eq(res.registerNumbers, [R_REAL, R_OTHER, "953025105001"], "the corrected list is returned for the UI");
  eq(res.replaced, 1, "exactly one candidate replaced");
  eq(res.student && res.student.id, "st-real", "the resolved student is returned");
});

// ── T1b. if the replacement is already listed, the ghost is dropped (no dup) ────
it("T1b: a replacement already present elsewhere drops the duplicate ghost entry", () => {
  const e = exam([R_GHOST, R_OTHER, R_REAL]); // R_REAL already present
  const res = api.examCandidateCorrection(e, R_GHOST, R_REAL, students());
  ok(res.ok, "correction succeeds");
  eq(res.updates["exams/" + EXAM + "/registerNumbers"], [R_REAL, R_OTHER], "the ghost is removed, not duplicated");
  eq(res.updates["exams/" + EXAM + "/studentCount"], 2, "count drops with the removed duplicate");
});

// ── T2. an old regno that is not a candidate is refused, nothing written ────────
it("T2: refusing an old regno that is not in the list produces no update", () => {
  const e = exam([R_OTHER, "953025105001"]);
  const before = JSON.stringify(e);
  const res = api.examCandidateCorrection(e, R_GHOST, R_REAL, students());
  ok(!res.ok, "refused");
  ok(res.error.indexOf("not in this exam") >= 0, "the reason names the candidate list");
  eq(Object.keys(res.updates), [], "no update map is produced");
  eq(JSON.stringify(e), before, "the exam (proxy for the database) is not mutated");
});

// ── T3. an invalid replacement is refused by the register-number rule ───────────
it("T3: an invalid replacement register number is refused", () => {
  const e = exam([R_GHOST, R_OTHER]);
  ok(api.regnoError("12345").length > 0, "sanity: a short regno is invalid");
  const res = api.examCandidateCorrection(e, R_GHOST, "12345", students());
  ok(!res.ok, "refused");
  ok(res.error.indexOf("exactly 12 digits") >= 0, "the rule's message is surfaced");
});

// ── T3b. the same register number is not a correction ──────────────────────────
it("T3b: replacing a candidate with itself is refused", () => {
  const e = exam([R_GHOST, R_OTHER]);
  const res = api.examCandidateCorrection(e, R_GHOST, R_GHOST, students());
  ok(!res.ok, "refused");
  ok(res.error.indexOf("same register number") >= 0, "reason is explicit");
});

// ── T4. a replacement with no student record is refused (never ghost-for-ghost) ─
it("T4: a replacement that resolves to no student is refused", () => {
  const e = exam([R_GHOST, R_OTHER]);
  const res = api.examCandidateCorrection(e, R_GHOST, "953025105099", students());
  ok(!res.ok, "refused");
  ok(res.error.indexOf("No student record") >= 0, "reason names the missing record");
});

// ── T5. a replacement belonging to another college is refused ──────────────────
it("T5: a replacement held by a student of another college is refused", () => {
  const e = exam([R_GHOST, R_OTHER]); // exam college c1
  const res = api.examCandidateCorrection(e, R_GHOST, R_FOREIGN, students());
  ok(!res.ok, "refused");
  ok(res.error.indexOf("another college") >= 0, "reason names the college boundary");
});

// ── T6. malformed inputs are refused, not crashed ──────────────────────────────
it("T6: a missing exam / a list-less exam are refused cleanly", () => {
  ok(!api.examCandidateCorrection(null, R_GHOST, R_REAL, []).ok, "null exam refused");
  const noList = { id: EXAM, college_id: "c1" };
  const res = api.examCandidateCorrection(noList, R_GHOST, R_REAL, students());
  ok(!res.ok && res.error.indexOf("no candidate") >= 0, "an exam without a candidate list is refused");
});

// ── T7. after correction the exam is no longer stale ───────────────────────────
it("T7: the corrected list clears the stale-candidate report", () => {
  const e = exam([R_GHOST, R_OTHER]);
  eq(api.examStaleRegisterNumbers(e, students()), [R_GHOST], "the ghost is reported before correction");
  const res = api.examCandidateCorrection(e, R_GHOST, R_REAL, students());
  const corrected = Object.assign({}, e, { registerNumbers: res.registerNumbers });
  eq(api.examStaleRegisterNumbers(corrected, students()), [], "no stale candidates remain after correction");
});

// ── T8. the correction is one atomic map; failure leaves no partial state ───────
it("T8: the correction is a single map that applies all-or-nothing", () => {
  const e = exam([R_GHOST, R_OTHER]);
  const db = { exams: { [EXAM]: JSON.parse(JSON.stringify(e)) } };
  const res = api.examCandidateCorrection(e, R_GHOST, R_REAL, students());
  eq(Object.keys(res.updates).sort(), ["exams/" + EXAM + "/registerNumbers", "exams/" + EXAM + "/studentCount"], "list and count travel together");
  const before = JSON.stringify(db);
  let threw = false;
  try { applyAtomic(db, res.updates, true); } catch (err) { threw = true; }
  ok(threw, "the write rejects");
  eq(JSON.stringify(db), before, "a failed write leaves the exam untouched");
  applyAtomic(db, res.updates, false);
  eq(db.exams[EXAM].registerNumbers, [R_REAL, R_OTHER], "a successful write lands the whole correction");
  eq(db.exams[EXAM].studentCount, 2, "the count lands with the list");
});

// ── source guards: the async wiring and the UI actually use the builder ────────
function sliceAt(html, marker, endMarker) {
  const start = html.indexOf(marker);
  ok(start >= 0, marker + " exists");
  const end = html.indexOf(endMarker, start + marker.length);
  ok(end >= 0, marker + " has a body terminator (" + endMarker + ")");
  return html.slice(start, end);
}

it("SR1: Store.replaceExamCandidate builds one map and writes it atomically", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  const body = sliceAt(html, "replaceExamCandidate: async", "\n  },");
  ok(body.indexOf("examCandidateCorrection(exam,") >= 0, "it builds the correction from the pure helper");
  ok(body.indexOf("dbAtomicUpdate(res.updates)") >= 0, "it applies the WHOLE map with ONE dbAtomicUpdate");
  ok(body.indexOf("Permission denied: record belongs to another college") >= 0, "ownership is checked before writing");
  ok(body.indexOf("throw new Error(res.error)") >= 0, "the helper's refusal reason is surfaced as a thrown error");
});

it("SR2: the exam row surfaces stale candidates and the UI applies the correction", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  ok(html.indexOf("examStaleRegisterNumbers(exam, students)") >= 0, "the row computes the stale list");
  ok(html.indexOf("openFixCandidate(exam)") >= 0, "the row offers a Fix action");
  ok(html.indexOf("Store.replaceExamCandidate(fixCand.id, fixOld, fixNew)") >= 0, "the modal calls the atomic correction");
  ok(html.indexOf("examCandidateCorrection(fixCand, fixOld, fixNew, students)") >= 0, "the modal previews/validates with the pure helper");
});

module.exports = s;
