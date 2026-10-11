// Regression tests for the college-data load path — the screen that used to get
// stuck on "Loading <college> data…" forever.
//
// Cause: loadCollegeData() awaited its three RTDB reads with no bound, and the
// ONLY thing that ever cleared `dataLoading` was the `finally` of that promise.
// So a read that never settled (stalled socket / flaky connection) left the flag
// pinned true and the UI parked on the spinner with no way out. Compounding it,
// each read was `.catch(() => [])`, which turned a genuine failure into an
// empty-but-healthy-looking dashboard, and a failure reached while `dbOk` was
// true set `dataError` in a place no render branch could show.
//
// A follow-up bug was then found in the seating-plan pass: it read ONE node per
// exam and shared ONE 20s budget across every read, using the *remaining* budget
// as the next read's timeout. After a few slow reads the remainder was 0.2s, so
// a normal Firebase read was failed for lack of time — and a college with many
// exams paid N serial whole-node downloads before the dashboard appeared.
//
// The pass now reads the WHOLE /seating_plans node ONCE, concurrently with the
// three core reads (a bounded load, not 3 + N serial downloads), scopes the map
// to this college's own exams, floors the single read's timeout (never started
// with less than a minimum) and carries previous plans forward on a failed or
// skipped pass so a saved plan never looks deleted.
//
// Driven entirely with plain reader functions, so no browser/React/Firebase.
const fs = require("fs");
const h = require("./harness.js");
const api = h.load();

const s = h.suite("data_load_resilience.test.js — a load can never hang or fake success");
const { it, ait, eq, ok } = s;

const EMPTY = { getStudents: () => [], getHalls: () => [], getExams: () => [] };
const CORE = (coreTimeoutMs) => ({ coreTimeoutMs: coreTimeoutMs });

// ── empty collections are a valid success, not an error ──────────────────────
ait("empty collections load as success", async () => {
  const d = await api.loadCollegeDataSet(EMPTY, CORE(500));
  eq(d.students, [], "students");
  eq(d.halls, [], "halls");
  eq(d.exams, [], "exams");
  eq(d.plans, {}, "plans");
});

ait("real data passes through untouched, and only this college's exams get plans", async () => {
  const d = await api.loadCollegeDataSet({
    getStudents: () => [{ id: "s1" }, { id: "s2" }],
    getHalls: () => [{ id: "h1" }],
    getExams: () => [{ id: "e1", seatinggenerated: true }, { id: "e2" }],
    // One whole-node read. Other colleges' plans and duplicate exam docs must be
    // silently dropped — no other college's plan can leak into this dashboard.
    getAllSeatingPlans: () => Promise.resolve([
      { id: "p1", exam_id: "e1", plan: { id: "plan-e1" } },
      { id: "p2", exam_id: "e1", plan: { id: "plan-e1-dup" } },      // duplicate: first wins
      { id: "p3", exam_id: "other-college", plan: { id: "plan-other" } },
    ]),
  }, CORE(500));
  eq(d.students.length, 2, "students kept");
  eq(d.halls.length, 1, "halls kept");
  eq(d.exams.length, 2, "exams kept");
  eq(Object.keys(d.plans), ["e1"], "only this college's generated exams get a plan");
  eq(d.plans.e1, { id: "plan-e1" }, "plan content preserved, first plan wins");
  eq(d.plansIncomplete, false, "a healthy read reports no incompleteness");
});

// ── the hang, and the timeout never counting as success ──────────────────────
ait("a read that never settles rejects with a timeout (no infinite hang)", async () => {
  const never = () => new Promise(function () {});
  let resolved = false, err = null;
  try {
    await api.loadCollegeDataSet({ getStudents: never, getHalls: () => [], getExams: () => [] }, CORE(30));
    resolved = true;
  } catch (e) { err = e; }
  ok(!resolved, "must reject, never resolve");
  ok(err, "an error is produced");
  ok(/timed out/i.test(err.message), "message names the timeout: " + (err && err.message));
  ok(/college data/i.test(err.message), "message says which load failed: " + (err && err.message));
});

ait("withDataTimeout never resolves a pending promise as a fallback value", async () => {
  let out = "NOT_CALLED", err = null;
  try { out = await api.withDataTimeout(new Promise(function () {}), 30, "Loading college data"); }
  catch (e) { err = e; }
  ok(err && out === "NOT_CALLED", "rejected instead of resolving with a default");
});

ait("withDataTimeout resolves the value when it settles in time", async () => {
  eq(await api.withDataTimeout(Promise.resolve(42), 500, "x"), 42);
});

ait("withDataTimeout propagates the original failure verbatim", async () => {
  let err = null;
  try { await api.withDataTimeout(Promise.reject(new Error("PERMISSION_DENIED")), 500, "x"); }
  catch (e) { err = e; }
  ok(err && err.message === "PERMISSION_DENIED", "original message preserved: " + (err && err.message));
});

ait("a pending read plus a failing read still terminates the load", async () => {
  let resolved = false, err = null;
  try {
    await api.loadCollegeDataSet({
      getStudents: () => new Promise(function () {}),   // hangs forever
      getHalls: () => Promise.resolve([]),
      getExams: () => Promise.reject(new Error("exams unavailable")),
    }, CORE(30));
    resolved = true;
  } catch (e) { err = e; }
  ok(!resolved, "never resolves as success while a read is still pending");
  ok(err, "a failure is produced: " + (err && err.message));
});

// ── no failure masking: core read failures propagate ─────────────────────────
ait("a failed read fails the load (never treated as empty success)", async () => {
  let err = null;
  try {
    await api.loadCollegeDataSet({
      getStudents: () => Promise.reject(new Error("PERMISSION_DENIED")),
      getHalls: () => [],
      getExams: () => [],
    }, CORE(500));
  } catch (e) { err = e; }
  ok(err, "the load rejected");
  ok(/PERMISSION_DENIED/.test(err.message), "original failure surfaced: " + (err && err.message));
});

ait("a failed core read is not partially accepted as success", async () => {
  let resolved = false;
  try {
    await api.loadCollegeDataSet({
      getStudents: () => [{ id: "s1" }],
      getHalls: () => Promise.reject(new Error("halls unavailable")),
      getExams: () => [],
    }, CORE(500));
    resolved = true;
  } catch (e) { /* expected */ }
  ok(!resolved, "the whole load rejects when a core collection fails");
});

// ── seating plans: one bounded concurrent read, never a per-exam loop ────────
const PLAN = (over) => Object.assign({
  coreTimeoutMs: 500, planTimeoutMs: 400, planBudgetMs: 4000, minPlanReadMs: 100,
}, over || {});

ait("with a healthy budget every generated exam's plan is loaded in ONE read", async () => {
  const exams = [1, 2, 3, 4].map((i) => ({ id: "E" + i, seatinggenerated: true }));
  let reads = 0;
  const d = await api.loadCollegeDataSet({
    getStudents: () => [], getHalls: () => [], getExams: () => exams,
    getAllSeatingPlans: () => { reads++; return Promise.resolve(exams.map((e) => ({ id: "d" + e.id, exam_id: e.id, plan: { id: e.id } }))); },
  }, PLAN());
  eq(Object.keys(d.plans).sort(), ["E1", "E2", "E3", "E4"],
     "no plan read is starved while the budget is healthy");
  eq(reads, 1, "four generated exams cost ONE whole-node read, not four");
  eq(d.plansIncomplete, false, "a healthy read reports no incompleteness");
});

ait("the plan read is requested in the same tick as the core read, not after it", async () => {
  // The regression: plans were loaded after core data, one full /seating_plans
  // read per generated exam, serial. The new loader starts the single plans read
  // BEFORE it awaits the core read, so they run concurrently.
  const exams = Array.from({ length: 75 }, (_, i) => ({ id: "E" + i, seatinggenerated: true }));
  const events = [];
  const d = await api.loadCollegeDataSet({
    getStudents: () => { events.push("students"); return []; },
    getHalls: () => { events.push("halls"); return []; },
    getExams: () => { events.push("exams"); return exams; },
    getAllSeatingPlans: () => { events.push("plans"); return exams.map((e) => ({ id: "d" + e.id, exam_id: e.id, plan: { ok: true } })); },
  }, PLAN());
  eq(Object.keys(d.plans).length, 75, "all 75 exams get their saved plan");
  eq(d.plansIncomplete, false, "a healthy read reports no incompleteness");
  eq(events.filter((e) => e === "plans").length, 1, "75 exams cost exactly ONE plan read");
  ok(events.indexOf("plans") >= 0 && events.indexOf("students") >= 0, "core and plan reads both start");
  ok(events.indexOf("plans") < events.indexOf("exams"),
     "the plan read is requested before the core read is awaited — concurrent, not serial");
});

// The actual 0.2s regression: the old design passed the *remaining* budget as
// the next read's timeout. Now a read is simply never STARTED below the floor.
// Deterministic: no wall-clock assertion, just how many reads were attempted.
ait("a plan read is never attempted with less than the minimum time", async () => {
  let reads = 0;
  const d = await api.loadCollegeDataSet({
    getStudents: () => [], getHalls: () => [],
    getExams: () => [{ id: "E1", seatinggenerated: true }],
    getAllSeatingPlans: () => { reads++; return Promise.resolve([{ id: "d1", exam_id: "E1", plan: { ok: 1 } }]); },
  }, PLAN({ planBudgetMs: 100, minPlanReadMs: 5000 }));
  eq(reads, 0, "the pass is skipped instead of starting a read with 100ms/less of budget");
  eq(d.plans, {}, "no plan is loaded");
});

ait("budget exhaustion is surfaced explicitly with the IDs of unread plans", async () => {
  const exams = [{id:"E1",seatinggenerated:true},{id:"E2",seatinggenerated:true}];
  const d = await api.loadCollegeDataSet({
    getStudents:()=>[],getHalls:()=>[],getExams:()=>exams,
    getAllSeatingPlans:()=>Promise.resolve([{id:"d",exam_id:"E1",plan:{ok:true}}]),
  }, PLAN({planBudgetMs:100,minPlanReadMs:5000,previousPlans:{E2:{kept:true}}}));
  eq(d.plansIncomplete,true);
  ok(d.unreadPlanIds.indexOf("E1") >= 0 && d.unreadPlanIds.indexOf("E2") >= 0, "both unread IDs are reported");
  eq(d.plans.E2,{kept:true});
});

ait("a hanging seating-plan read is skipped; the load still completes", async () => {
  const d = await api.loadCollegeDataSet({
    getStudents: () => [], getHalls: () => [],
    getExams: () => [{ id: "E1", seatinggenerated: true }],
    getAllSeatingPlans: () => new Promise(function () {}),
  }, PLAN({ planTimeoutMs: 30, planBudgetMs: 1000, minPlanReadMs: 10 }));
  eq(d.plans, {}, "the hung plan is dropped, not awaited forever");
  eq(d.exams.length, 1, "core data still delivered");
});

ait("the seating-plan wait is ONE bounded read, so N exams cannot multiply the wait", async () => {
  const N = 30, BUDGET = 200;
  const exams = Array.from({ length: N }, (_, i) => ({ id: "E" + i, seatinggenerated: true }));
  let reads = 0;
  const t0 = Date.now();
  const d = await api.loadCollegeDataSet({
    getStudents: () => [], getHalls: () => [], getExams: () => exams,
    getAllSeatingPlans: () => { reads++; return new Promise(function () {}); },
  }, PLAN({ planTimeoutMs: 60, planBudgetMs: BUDGET, minPlanReadMs: 50 }));
  const elapsed = Date.now() - t0;
  eq(d.plans, {}, "no plan is accepted");
  eq(d.exams.length, N, "core data is still complete");
  eq(reads, 1, "only ONE read is ever attempted, whatever N is");
  ok(elapsed < N * BUDGET,
     "bounded by the single read's timeout, not N x budget (took " + elapsed + "ms, bound " + (N * BUDGET) + "ms)");
});

// ── a plan timeout must never look like a deletion ───────────────────────────
ait("a failed plan read carries the previous plan forward (never looks deleted)", async () => {
  const d = await api.loadCollegeDataSet({
    getStudents: () => [], getHalls: () => [],
    getExams: () => [{ id: "E1", seatinggenerated: true }],
    getAllSeatingPlans: () => Promise.reject(new Error("read failed")),
  }, PLAN({ previousPlans: { E1: { saved: true } } }));
  eq(d.plans.E1, { saved: true }, "the previously saved plan is kept");
});

ait("a timed-out plan read carries the previous plan forward", async () => {
  const d = await api.loadCollegeDataSet({
    getStudents: () => [], getHalls: () => [],
    getExams: () => [{ id: "E1", seatinggenerated: true }],
    getAllSeatingPlans: () => new Promise(function () {}),
  }, PLAN({ planTimeoutMs: 30, planBudgetMs: 1000, minPlanReadMs: 10,
            previousPlans: { E1: { saved: true } } }));
  eq(d.plans.E1, { saved: true }, "the hung read does not erase the saved plan");
});

ait("budget exhaustion preserves the previous plans it already held", async () => {
  const d = await api.loadCollegeDataSet({
    getStudents: () => [], getHalls: () => [],
    getExams: () => [{ id: "E1", seatinggenerated: true }, { id: "E2", seatinggenerated: true }],
    getAllSeatingPlans: () => new Promise(function () {}),
  }, PLAN({ planTimeoutMs: 40, planBudgetMs: 100, minPlanReadMs: 50,
            previousPlans: { E2: { kept: true } } }));
  eq(d.plans.E2, { kept: true }, "a skipped plan keeps its previous value");
  eq(d.plans.E1, undefined, "an attempt that failed with no previous value stays absent");
});

ait("a successful empty read drops a stale plan (truthful, not carried)", async () => {
  const d = await api.loadCollegeDataSet({
    getStudents: () => [], getHalls: () => [],
    getExams: () => [{ id: "E1", seatinggenerated: true }],
    getAllSeatingPlans: () => Promise.resolve([]),
  }, PLAN({ previousPlans: { E1: { stale: true } } }));
  eq(d.plans, {}, "a read that succeeds with no plan does not resurrect a stale one");
  eq(d.plansIncomplete, false, "a successful empty read is truthful, not a 'some plans unread' warning");
});

// ── App is actually wired to the bounded loader ──────────────────────────────
it("App delegates to the bounded loader and no longer masks read failures", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  const start = html.indexOf("async function loadCollegeData()");
  ok(start >= 0, "loadCollegeData exists");
  const body = html.slice(start, html.indexOf("function handleLogin(u)", start));
  ok(body.indexOf("loadCollegeDataSet") >= 0, "loadCollegeData delegates to the bounded loader");
  ok(!/\.catch\(\(\)\s*=>\s*\[\]\)/.test(body), "read failures are no longer swallowed into []");
  ok(body.indexOf("finally") >= 0, "the loading flag is cleared in finally");
  ok(body.indexOf("setDataError") >= 0, "a failure is recorded as dataError");
  ok(body.indexOf("previousPlans: seatingPlans") >= 0, "the previous plans are handed in so a failed read never clears one");
});

it("a data-phase failure has a renderable error screen with Retry", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  const start = html.indexOf("if (dataLoading) return (");
  ok(start >= 0, "the loading gate exists");
  const end = html.indexOf("if (!canAccessPage", start);
  const gate = html.slice(start, end > 0 ? end : start + 4000);
  ok(gate.indexOf("if (dataError) return (") >= 0, "after the spinner, a data error is shown instead of skipped");
  ok(gate.indexOf("onRetry") >= 0, "the error screen offers a retry action");
  ok(gate.indexOf("loadCollegeData()") >= 0, "retry re-runs the load");
});

it("the single seating-plan read is floored and bounded, never a per-exam loop", () => {
  const html = fs.readFileSync(h.HTML, "utf8");

  // The read itself is guarded inside loadSeatingPlanDataSet.
  const spStart = html.indexOf("async function loadSeatingPlanDataSet(");
  ok(spStart >= 0, "loadSeatingPlanDataSet exists");
  const spBody = html.slice(spStart, html.indexOf("\n}", spStart));
  ok(/Math\.max\(minRead,\s*Math\.min\(planMs,\s*budgetMs\)\)/.test(spBody),
     "the read timeout is floored at minRead and capped at the plan timeout");
  ok(/budgetMs\s*<\s*minRead/.test(spBody),
     "a read is never started when the budget is below the minimum read time");
  ok(spBody.indexOf("getAllSeatingPlans") >= 0, "the plan pass reads through getAllSeatingPlans");

  // The loader orchestrates a single concurrent whole-node read, not an N-exam loop.
  const ldStart = html.indexOf("async function loadCollegeDataSet(");
  ok(ldStart >= 0, "loadCollegeDataSet exists");
  const ldEnd = html.indexOf("function dbOnSnapshot(", ldStart);
  const ldBody = html.slice(ldStart, ldEnd > 0 ? ldEnd : ldStart + 6000);
  ok(ldBody.indexOf("loadSeatingPlanDataSet(readers, o)") >= 0, "the plan pass is started from the loader");
  ok(ldBody.indexOf("getSeatingPlan(") < 0, "no per-exam getSeatingPlan loop remains in the load path");
  ok(ldBody.indexOf("scopePlansByExams") >= 0, "the raw plan map is scoped to this college's exams");
  ok(ldBody.indexOf("carryForwardPlansFor") >= 0, "failed/skipped passes carry previous plans forward");

  ok(/const DATA_LOAD_TIMEOUT_MS\s*=\s*\d+/.test(html), "a core timeout constant is declared");
  ok(/const SEATING_PLAN_TIMEOUT_MS\s*=\s*\d+/.test(html), "a per-read timeout constant is declared");
  ok(/const MIN_SEATING_PLAN_READ_MS\s*=\s*\d+/.test(html), "a minimum-read constant is declared");
});

it("the data load is bounded and the loader keeps its timeout guard", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  ok(html.indexOf("withDataTimeout(") >= 0, "the load path applies the timeout");
});

// ── the seating-plan load warning reaches the Bulk Seating modal ──────────────
// Regression: the Round-6 load-warning state was declared in App and consumed by
// BulkSeatingModal, but the two middle components (AdminDashboard, ExamsPage)
// never threaded it. Clicking "Bulk Seating by Date" evaluated the undeclared
// identifier `seatingPlansLoadWarning` at render time, the error boundary took
// over and the page failed with "seatingPlansLoadWarning is not defined". A Node
// engine test cannot render React, so this pins the WHOLE wiring in the source:
// every hop must DECLARE the prop (so the identifier is in scope) and PASS it on
// under the same name (so a rename can never half-wire the chain).
it("the seating-plan load warning is wired App -> AdminDashboard -> ExamsPage -> BulkSeatingModal", () => {
  const html = fs.readFileSync(h.HTML, "utf8");

  // The state lives in App and is fed from the loader result.
  ok(/const \[seatingPlansLoadWarning,\s*setSeatingPlansLoadWarning\]\s*=\s*useState\(/.test(html),
     "App declares the seatingPlansLoadWarning state");
  ok(/setSeatingPlansLoadWarning\(/.test(html), "App sets the warning from the load result");

  // Every component that references the identifier must have it in scope …
  const declares = (name) =>
    new RegExp("function " + name + "\\(\\{[^}]*\\bseatingPlansLoadWarning\\b[^}]*\\}").test(html);
  ok(declares("AdminDashboard"), "AdminDashboard destructures the seatingPlansLoadWarning prop");
  ok(declares("ExamsPage"), "ExamsPage destructures the seatingPlansLoadWarning prop");
  ok(declares("BulkSeatingModal"), "BulkSeatingModal destructures the seatingPlansLoadWarning prop");

  // … and every hop must actually pass it along.
  const passes = (tag) => {
    const i = html.indexOf("<" + tag + " ");
    if (i < 0) return false;
    const end = html.indexOf("/>", i);
    return html.slice(i, end).indexOf("seatingPlansLoadWarning={seatingPlansLoadWarning}") >= 0;
  };
  ok(passes("AdminDashboard"), "App passes the warning into AdminDashboard");
  ok(passes("ExamsPage"), "AdminDashboard passes the warning into ExamsPage");
  ok(passes("BulkSeatingModal"), "ExamsPage passes the warning into BulkSeatingModal");
});

module.exports = s;