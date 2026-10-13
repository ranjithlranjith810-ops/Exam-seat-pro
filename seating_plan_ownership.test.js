// Regression tests for seating-plan ownership.
//
// THE HAZARD: a seating_plan document carries no college_id of its own, so a
// plan write used to be scoped only by exam id. Nothing verified that the exam
// belonged to the ACTIVE college, so a plan could be overwritten (or, in the
// restore flow, every college's plans could be deleted) across college borders.
//
// THE FIX: every plan write now goes through one ownership decision — a plan may
// only be written for an exam owned by the active college (or by a developer).
// If the active college OR the exam's ownership cannot be established, the write
// is REFUSED. Existing plans are never migrated or rewritten.
//
// The decision is a pure function, and the destructive restore sequence is a
// pure orchestrator with injected readers/writers — so the refusal cases AND the
// all-or-nothing delete ordering are exercised for real, not merely matched in
// the source. The thin live wrappers (DB/AUTH/Store) are checked at source level.
const fs = require("fs");
const h = require("./harness.js");
const api = h.load();

const s = h.suite("seating_plan_ownership.test.js — a plan is only written for an owned exam");
const { it, ait, eq, ok } = s;

const src = fs.readFileSync(h.HTML, "utf8");
const decide = (o) => api.seatingPlanOwnershipDecision(o);

function slice(text, start, end) {
  const i = text.indexOf(start);
  ok(i >= 0, "start marker not found: " + start);
  const j = text.indexOf(end, i + start.length);
  ok(j >= 0, "end marker not found: " + end);
  return text.slice(i, j);
}
const occurrences = (text, needle) => text.split(needle).length - 1;

// ── the pure decision ────────────────────────────────────────────────────────
it("P1 an exam owned by the active college is allowed", () => {
  const d = decide({ examId: "E1", collegeId: "col-A", examExists: true, examCollegeId: "col-A" });
  eq(d.ok, true);
  eq(d.code, "OWNED");
});

it("P2 a foreign-college exam is refused", () => {
  const d = decide({ examId: "E1", collegeId: "col-A", examExists: true, examCollegeId: "col-B" });
  eq(d.ok, false);
  eq(d.code, "FOREIGN");
  ok(/another college/.test(d.reason));
});

it("P3 an unresolved or default college is refused (cannot establish owner)", () => {
  eq(decide({ examId: "E1", collegeId: "default", examExists: true, examCollegeId: "col-A" }).code, "NO_COLLEGE");
  eq(decide({ examId: "E1", collegeId: "", examExists: true, examCollegeId: "col-A" }).code, "NO_COLLEGE");
  eq(decide({ examId: "E1", collegeId: null, examExists: true, examCollegeId: "col-A" }).code, "NO_COLLEGE");
});

it("P4 a missing exam is refused (ownership cannot be established)", () => {
  const d = decide({ examId: "E1", collegeId: "col-A", examExists: false, examCollegeId: null });
  eq(d.ok, false);
  eq(d.code, "NO_EXAM");
});

it("P5 an exam with no recorded college_id is refused", () => {
  const d = decide({ examId: "E1", collegeId: "col-A", examExists: true, examCollegeId: "" });
  eq(d.ok, false);
  eq(d.code, "NO_OWNER");
});

it("P6 a missing exam id is refused before anything else", () => {
  eq(decide({ collegeId: "col-A", examExists: true, examCollegeId: "col-A" }).code, "NO_EXAM_ID");
  eq(decide({ examId: "", collegeId: "col-A" }).code, "NO_EXAM_ID");
});

it("P7 a developer is exempt even with no college and a foreign/unknown exam", () => {
  const d = decide({ examId: "E1", collegeId: "", isDeveloper: true, examExists: false, examCollegeId: "col-B" });
  eq(d.ok, true);
  eq(d.code, "DEVELOPER");
});

it("P8 exam/college ids compare after String coercion (numeric vs string)", () => {
  eq(decide({ examId: 1, collegeId: 123, examExists: true, examCollegeId: "123" }).code, "OWNED");
  eq(decide({ examId: 1, collegeId: "123", examExists: true, examCollegeId: 123 }).code, "OWNED");
});

it("P9 every refusal carries a code and a non-empty reason", () => {
  const refusals = [
    { examId: "", collegeId: "A" },
    { examId: "E1", collegeId: "A", examExists: false },
    { examId: "E1", collegeId: "A", examExists: true, examCollegeId: "" },
    { examId: "E1", collegeId: "A", examExists: true, examCollegeId: "B" },
    { examId: "E1", collegeId: "default", examExists: true, examCollegeId: "A" },
  ];
  refusals.forEach((r) => {
    const d = decide(r);
    eq(d.ok, false);
    ok(d.code && d.code.length, "code present");
    ok(d.reason && d.reason.length, "reason present");
  });
});

// ── behavioural: the destructive restore sequence ────────────────────────────
// A recording fake lets us assert the exact ORDER of checks/delete/writes and
// the abort behaviour of the real orchestrator.
function restoreFixture(overrides) {
  const events = [];
  const existing = [
    { id: "p-own-1", exam_id: "E1", plan: {} },
    { id: "p-own-2", exam_id: "E2", plan: {} },
    { id: "p-foreign", exam_id: "F-OTHER-COLLEGE", plan: {} },
  ];
  const deps = {
    backupPlans: { E1: { h1: { seats: [] } }, E2: { h1: { seats: [] } } },
    currentExamIds: ["E1", "E2"],
    assertOwnership: async (id) => { events.push("assert:" + id); },
    getAllPlans: async () => { events.push("getAll"); return existing; },
    deletePlans: async (ids) => { events.push("delete:" + ids.slice().sort().join(",")); },
    writePlan: async (id) => { events.push("write:" + id); },
  };
  const out = Object.assign(deps, overrides || {});
  out._events = events;
  return out;
}

ait("R1 every target exam is ownership-checked BEFORE any delete or write", async () => {
  const d = restoreFixture();
  const res = await api.restoreSeatingPlans(d);
  eq(res.checked, 2);
  const firstDelete = d._events.indexOf("delete:p-own-1,p-own-2");
  const lastAssert = Math.max(d._events.indexOf("assert:E1"), d._events.indexOf("assert:E2"));
  ok(firstDelete >= 0, "delete happened");
  ok(lastAssert < firstDelete, "all asserts precede the delete");
  ok(d._events.indexOf("write:E1") > firstDelete, "writes happen after the delete");
});

ait("R2 one failed ownership check aborts the WHOLE step: no delete, no write, no plan read", async () => {
  const d = restoreFixture({
    assertOwnership: async (id) => {
      d._events.push("assert:" + id);
      if (id === "E2") throw new Error("Permission denied: exam E2 belongs to another college.");
    },
  });
  let threw = false;
  try { await api.restoreSeatingPlans(d); } catch (e) { threw = true; ok(/another college/.test(e.message)); }
  ok(threw, "restore rejects on the failed check");
  eq(d._events.filter((e) => e.startsWith("delete:")).length, 0, "no plan deleted");
  eq(d._events.filter((e) => e.startsWith("write:")).length, 0, "no plan written");
  eq(d._events.indexOf("getAll"), -1, "the plan read never ran");
});

ait("R3 deletion is scoped to owned exams — foreign-college plans are preserved", async () => {
  const d = restoreFixture();
  await api.restoreSeatingPlans(d);
  const del = d._events.find((e) => e.startsWith("delete:"));
  eq(del, "delete:p-own-1,p-own-2", "only the owned plans are deleted");
  ok(d._events.every((e) => !/p-foreign/.test(e)), "the foreign plan is never touched");
});

ait("R4 a current exam not present in the backup still protects its own plan", async () => {
  const d = restoreFixture({ backupPlans: { E1: {} }, currentExamIds: ["E1", "E2"] });
  await api.restoreSeatingPlans(d);
  eq(d._events.find((e) => e.startsWith("delete:")), "delete:p-own-1,p-own-2",
    "E2 is owned via currentExamIds even though the backup omits it");
  eq(d._events.filter((e) => e.startsWith("write:")).join(","), "write:E1");
});

ait("R5 every backup plan is written through the guarded writer", async () => {
  const d = restoreFixture();
  const res = await api.restoreSeatingPlans(d);
  eq(res.written, 2);
  eq(d._events.filter((e) => e.startsWith("write:")).sort().join(","), "write:E1,write:E2");
});

ait("R6 an empty backup checks nothing and writes nothing", async () => {
  const d = restoreFixture({ backupPlans: {}, currentExamIds: [] });
  const res = await api.restoreSeatingPlans(d);
  eq(res.checked, 0);
  eq(res.written, 0);
  eq(d._events.filter((e) => e.startsWith("assert")).length, 0, "no ownership check");
  eq(d._events.filter((e) => e.startsWith("write")).length, 0, "no plan written");
});

ait("R7 a failed plan read aborts before any delete or write", async () => {
  const d = restoreFixture({ getAllPlans: async () => { d._events.push("getAll"); throw new Error("read failed"); } });
  let threw = false;
  try { await api.restoreSeatingPlans(d); } catch (e) { threw = true; }
  ok(threw, "restore rejects on the read failure");
  eq(d._events.filter((e) => e.startsWith("delete:")).length, 0);
  eq(d._events.filter((e) => e.startsWith("write:")).length, 0);
});

ait("R8 a failed delete aborts before any write", async () => {
  const d = restoreFixture({ deletePlans: async () => { d._events.push("delete"); throw new Error("delete failed"); } });
  let threw = false;
  try { await api.restoreSeatingPlans(d); } catch (e) { threw = true; }
  ok(threw, "restore rejects on the delete failure");
  eq(d._events.filter((e) => e.startsWith("write:")).length, 0, "no plan written after a failed delete");
});

// ── behavioural: a rejected write is never reported as success ───────────────
function st(dept, year, n, prefix) {
  return Array.from({ length: n }, (_, i) => ({
    id: prefix + "-" + i, regno: prefix + String(i).padStart(4, "0"),
    name: dept + " " + i, dept: dept, year: year, gender: "male",
  }));
}
function hall(id, type, rows, seatsPerRow) {
  return { id: id, name: id, hallType: type || "CAT", numbenches: rows, studentsperbench: seatsPerRow || 9 };
}
function ex(id, dept, year) {
  return { id: id, subject: "CAT", subjectTitle: id, category: "CAT", date: "2026-10-14", session: "FN",
    status: "scheduled", groups: [{ dept: dept, year: year }], seatinggenerated: false };
}
const RULES = { splitGender: true, noSameDept: true, noSameYear: false, benchAdjacency: false };

ait("F1 a rejected plan write is reported save_failed, never completed", async () => {
  const students = st("AIDS", 2, 3, "A");
  const exams = [ex("A", "AIDS", 2)];
  const res = await api.runBulkSeating({
    exams: exams, allExams: exams, students: students, halls: [hall("LH-1", "CAT", 5, 9)],
    rules: RULES, coSeat: true, loadPlan: async () => null, confirmOverwrite: () => true,
    savePlan: async () => { throw new Error("Seating plan write blocked: active college could not be established."); },
  });
  eq(res.summary.completed, 0, "no false success");
  eq(res.summary.saveFailed, 1);
  eq(res.results[0].status, "save_failed");
});

// ── Store.setSeatingPlan is the single choke-point ───────────────────────────
const setPlan = slice(src, "async setSeatingPlan(examId, plan) {", "// One read of the whole /seating_plans node");

it("W1 setSeatingPlan enforces ownership BEFORE it reads-for-upsert or writes", () => {
  const gate = setPlan.indexOf("assertSeatingPlanOwnership(examId)");
  ok(gate >= 0, "ownership gate is called");
  const firstRead = setPlan.indexOf('dbGet("seating_plans"');
  const firstUpdate = setPlan.indexOf('dbUpdate("seating_plans"');
  const firstAdd = setPlan.indexOf('dbAdd("seating_plans"');
  ok(firstRead > gate, "the upsert read happens after the gate");
  ok(firstUpdate > gate, "the update happens after the gate");
  ok(firstAdd > gate, "the add happens after the gate");
});

it("W2 dbAdd/dbUpdate on seating_plans exist ONLY inside the guarded setSeatingPlan", () => {
  eq(occurrences(src, 'dbAdd("seating_plans"'), 1, "one guarded add");
  eq(occurrences(src, 'dbUpdate("seating_plans"'), 1, "one guarded update");
  ok(src.indexOf('dbAdd("seating_plans", { id: uid(), exam_id, plan })') < 0,
    "restore no longer writes plans with a raw dbAdd");
});

// ── the restore function's own ordering (source) ─────────────────────────────
const restoreFn = slice(src, "async function restoreSeatingPlans(deps) {", "// ── STORE");

it("S1 restoreSeatingPlans checks all, then deletes, then writes", () => {
  const check = restoreFn.indexOf("await assertOwnership(exam_id)");
  const del = restoreFn.indexOf("await deletePlans(ownedPlanIds)");
  const write = restoreFn.indexOf("await writePlan(exam_id");
  ok(check >= 0 && del > check, "delete follows the ownership check");
  ok(write > del, "writes follow the scoped delete");
});

it("S2 restoreSeatingPlans scopes the delete and never wipes the whole node", () => {
  ok(restoreFn.indexOf("ownedExamIds") >= 0, "computes the owned exam set");
  ok(restoreFn.indexOf("ownedPlanIds") >= 0, "deletes only owned plan ids");
  ok(restoreFn.indexOf("has(String(p.exam_id))") >= 0, "filters by owned exam id");
});

it("S3 the BackupRestorePage routes the plan step through restoreSeatingPlans + the guard", () => {
  const block = slice(src, "// Restore seating plans", 'addAuditEntry("Backup Restored"');
  ok(block.indexOf("if (sp && Object.keys(sp).length) {") >= 0, "only runs when the backup has plans");
  ok(block.indexOf("backupPlans: sp") >= 0, "passes the backup plans");
  ok(block.indexOf("currentExamIds: exams.map(x => x.id)") >= 0, "passes the owned exam ids");
  ok(block.indexOf("assertOwnership: (id) => assertSeatingPlanOwnership(id)") >= 0, "uses the ownership guard");
  ok(block.indexOf("deletePlans: (ids) => dbBatchDelete(\"seating_plans\", ids)") >= 0, "deletes through the scoped list");
  ok(block.indexOf("writePlan: (id, plan) => Store.setSeatingPlan(id, plan)") >= 0, "writes through the guarded setter");
});

// ── the atomic attendance import path ────────────────────────────────────────
const attImport = slice(src, "async function attImport(opts){", "// ── ATTENDANCE PDF AUTOMATIC");

it("A1 attImport writes each exam with the ACTIVE college_id in the same atomic update as its plan", () => {
  ok(occurrences(attImport, 'updates["seating_plans/') >= 1, "writes a seating plan doc");
  ok(attImport.indexOf("college_id:colId") >= 0, "stamps the active college on the exam");
  ok(attImport.indexOf("college_id:colId") !== attImport.lastIndexOf("college_id:colId"),
    "every exam write (new + reused prior) is stamped, not just one");
});

// ── the delete paths already verify exam ownership ───────────────────────────
it("D1 exam deletion only removes plans for exams proven owned", () => {
  const build = slice(src, "function buildBulkDeleteUpdate(examIds, examDocs, planDocs) {", "// Bulk update year field");
  ok(build.indexOf("owned.has(id)") >= 0, "filters to owned exam ids");
  ok(build.indexOf("planDeleteUpdatePaths(safe, planDocs)") >= 0, "plan paths built only from the safe set");
  ok(src.indexOf('exams/" + id + "/college_id"') >= 0, "deleteExam reads the exam's college_id first");
});

module.exports = s;
