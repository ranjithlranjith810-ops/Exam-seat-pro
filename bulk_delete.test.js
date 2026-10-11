// Regression tests for exam deletion — bulk delete used to issue ONE full
// /seating_plans read per exam, in a serial loop, before a single write. A
// college with 75 exams paid 75 whole-node downloads plus one atomic update, and
// a single delete removed the exam record but ORPHANED its seating plans.
//
// The delete path now:
//   • builds all delete paths from ONE whole-node plans read (pure helpers),
//   • scopes everything to exams the caller has already verified it owns,
//   • applies the whole removal as ONE atomic multi-location write, and
//   • Store.deleteExam removes the exam AND its plans together.
const fs = require("fs");
const h = require("./harness.js");
const api = h.load();

const s = h.suite("bulk_delete.test.js — one atomic write, however many exams");
const { it, ait, eq, ok } = s;

// ── pure path builders ───────────────────────────────────────────────────────
it("planDeleteUpdatePaths maps each owned exam's plans to null", () => {
  const paths = api.planDeleteUpdatePaths(["E1", "E2"], [
    { id: "p1", exam_id: "E1" },
    { id: "p2", exam_id: "E2" },
    { id: "p3", exam_id: "E3" },
    { id: "px", exam_id: "other" },
  ]);
  eq(paths["seating_plans/p1"], null);
  eq(paths["seating_plans/p2"], null);
  eq(Object.keys(paths).sort(), ["seating_plans/p1", "seating_plans/p2"],
     "only the selected exams' plans are included");
});

it("planDeleteUpdatePaths tolerates empty, null and malformed docs", () => {
  eq(api.planDeleteUpdatePaths([], []), {}, "empty inputs give an empty update");
  eq(api.planDeleteUpdatePaths(["E1"], null), {}, "a null docs list gives an empty update");
  const paths = api.planDeleteUpdatePaths(["E1"], [
    null,
    { id: "p1", plan: {} },            // no exam_id
    { exam_id: "E1" },                 // no id — cannot be addressed
    { id: "p2", exam_id: "E1" },
  ]);
  eq(Object.keys(paths), ["seating_plans/p2"], "only addressable matching docs are removed");
});

it("buildBulkDeleteUpdate removes owned exams and their plans atomically", () => {
  const built = api.buildBulkDeleteUpdate(
    ["E1", "E2", "FOREIGN"],
    [{ id: "E1" }, { id: "E2" }],
    [{ id: "p1", exam_id: "E1" }, { id: "p2", exam_id: "E2" }, { id: "px", exam_id: "FOREIGN" }],
  );
  eq(built.updates["exams/E1"], null);
  eq(built.updates["exams/E2"], null);
  eq(built.updates["exams/FOREIGN"], undefined, "a foreign exam is never deleted");
  eq(built.updates["seating_plans/p1"], null);
  eq(built.updates["seating_plans/p2"], null);
  eq(built.updates["seating_plans/px"], undefined, "a foreign exam's plan is never deleted");
  eq(built.exams, 2, "counts the exams that will actually be deleted");
  eq(built.plans, 2, "counts the plans that will actually be deleted");
});

it("buildBulkDeleteUpdate is one update with every path present, whatever the size", () => {
  const N = 75;
  const ids = Array.from({ length: N }, (_, i) => "E" + i);
  const docs = ids.map((id, i) => ({ id: "p" + i, exam_id: id }));
  const built = api.buildBulkDeleteUpdate(ids, ids.map((id) => ({ id })), docs);
  eq(built.exams, N, "all 75 exams are counted");
  eq(built.plans, N, "all 75 plans are counted");
  eq(Object.keys(built.updates).length, 2 * N, "2N paths, not N reads + a write");
  ok(Object.keys(built.updates).every((k) => built.updates[k] === null), "every path is a delete");
});

// ── ownership cannot be bypassed ─────────────────────────────────────────────
it("buildBulkDeleteUpdate silently excludes the unproven ids the caller provides", () => {
  const built = api.buildBulkDeleteUpdate(
    ["MINE", "OTHER"],
    [{ id: "MINE" }],
    [{ id: "p1", exam_id: "MINE" }, { id: "p2", exam_id: "OTHER" }],
  );
  eq(built.exams, 1, "only the owned exam is counted");
  eq(built.updates["seating_plans/p2"], undefined, "the foreign exam's plan is protected");
});

// ── Store wiring — the loop is gone, one read + one update remain ────────────
it("Store.bulkDeleteExams issues one plans read + one atomic update (no per-exam loop)", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  const start = html.indexOf("async bulkDeleteExams(");
  ok(start >= 0, "bulkDeleteExams exists");
  const body = html.slice(start, html.indexOf("\n  },", start));
  ok(body.indexOf('dbGet("exams"') >= 0, "one ownership-scoped exams read");
  ok(body.indexOf("getAllSeatingPlans") >= 0, "one whole-node plans read");
  ok(body.indexOf("buildBulkDeleteUpdate") >= 0, "paths come from the pure builder");
  ok(body.indexOf("dbAtomicUpdate") >= 0, "one atomic write");
  ok(body.indexOf('dbGet("seating_plans"') < 0 && !/for \(const id of ids\)/.test(body),
     "no per-exam plans read loop remains");
  ok(/belong to another college/i.test(body), "foreign exams are rejected loudly");
});

it("Store.deleteExam removes the exam and its plans together", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  const start = html.indexOf("async deleteExam(");
  ok(start >= 0, "deleteExam exists");
  const body = html.slice(start, html.indexOf("\n  },", start));
  ok(body.indexOf("college_id") >= 0, "ownership is verified before deleting");
  ok(body.indexOf("getAllSeatingPlans") >= 0, "plans come from the whole-node read");
  ok(body.indexOf("buildBulkDeleteUpdate") >= 0, "exam + plans are removed through the same builder");
  ok(body.indexOf("dbAtomicUpdate") >= 0, "the removal is one atomic write");
  ok(body.indexOf("plansDeleted") >= 0, "the caller learns how many plans went with it");
});

// ── ExamsPage UI — busy state, plan-state cleanup, truthful toasts ───────────
it("removeExam cleans the in-memory seating plan and reports plan count", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  const start = html.indexOf("async function removeExam(");
  ok(start >= 0, "removeExam exists");
  const body = html.slice(start, html.indexOf("\n  }", start));
  ok(body.indexOf("setSeatingPlans") >= 0, "the removed exam's plan is dropped from state");
  ok(body.indexOf("delete sp[e.id]") >= 0, "cancelled per-exam plan never lingers");
  ok(body.indexOf("plansDeleted") >= 0, "the toast states how many plans were removed");
  ok(body.indexOf("deleting") >= 0, "a busy flag protects against double-deletes");
});

it("bulkRemoveExams updates both exams and seating plans in state", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  const start = html.indexOf("async function bulkRemoveExams(");
  ok(start >= 0, "bulkRemoveExams exists");
  const body = html.slice(start, html.indexOf("\n  }", start));
  ok(body.indexOf("setExams(prev=>prev.filter(x=>!ids.includes(x.id)))") >= 0, "deleted exams leave the list");
  ok(body.indexOf("ids.forEach(id=>{ delete sp[id]; })") >= 0, "deleted exams' plans leave the map");
  ok(body.indexOf("setSelExams(new Set())") >= 0, "the selection is cleared");
  ok(body.indexOf("plansDeleted") >= 0, "the success toast is truthful about plans");
});

module.exports = s;