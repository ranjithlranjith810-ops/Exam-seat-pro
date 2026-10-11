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
// A follow-up bug was then found in the seating-plan pass: it shared ONE 20s
// budget across every plan and used the *remaining* budget as the read's
// timeout. After a few slow (but successful) reads the remainder was 0.2s, so a
// perfectly normal Firebase read was failed for lack of time rather than
// because it was stuck. The pass now gives each read its own realistic bound
// and never starts one with less than a floor.
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

ait("real data passes through untouched, including seating plans", async () => {
  const d = await api.loadCollegeDataSet({
    getStudents: () => [{ id: "s1" }, { id: "s2" }],
    getHalls: () => [{ id: "h1" }],
    getExams: () => [{ id: "e1", seatinggenerated: true }, { id: "e2" }],
    getSeatingPlan: (id) => Promise.resolve({ id: "plan-" + id }),
  }, CORE(500));
  eq(d.students.length, 2, "students kept");
  eq(d.halls.length, 1, "halls kept");
  eq(d.exams.length, 2, "exams kept");
  eq(Object.keys(d.plans), ["e1"], "only generated exams get a plan read");
  eq(d.plans.e1, { id: "plan-e1" }, "plan content preserved");
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

// ── seating plans: bounded, but never failed for lack of time ────────────────
const PLAN = (over) => Object.assign({
  coreTimeoutMs: 500, planTimeoutMs: 400, planBudgetMs: 4000, minPlanReadMs: 100,
}, over || {});

ait("with a healthy budget every generated exam's plan is loaded", async () => {
  const exams = [1, 2, 3, 4].map((i) => ({ id: "E" + i, seatinggenerated: true }));
  const d = await api.loadCollegeDataSet({
    getStudents: () => [], getHalls: () => [], getExams: () => exams,
    getSeatingPlan: (id) => Promise.resolve({ id: id }),
  }, PLAN());
  eq(Object.keys(d.plans).sort(), ["E1", "E2", "E3", "E4"],
     "no plan read is starved while the budget is healthy");
});

// The actual 0.2s regression: the old design passed the *remaining* budget as
// the read's timeout, so a normal Firebase read was failed once the budget had
// been whittled down. Now a read is simply never STARTED below the floor.
// Deterministic: no wall-clock assertion, just how many reads were attempted.
ait("a plan read is never attempted with less than the minimum time", async () => {
  let reads = 0;
  const d = await api.loadCollegeDataSet({
    getStudents: () => [], getHalls: () => [],
    getExams: () => [{ id: "E1", seatinggenerated: true }],
    getSeatingPlan: () => { reads++; return Promise.resolve({ ok: 1 }); },
  }, PLAN({ planBudgetMs: 100, minPlanReadMs: 5000 }));
  eq(reads, 0, "the loop stops instead of starting a read with 100ms/less of budget");
  eq(d.plans, {}, "no plan is loaded");
});


ait("budget exhaustion is surfaced explicitly with the IDs of unread plans", async () => {
  const exams = [{id:"E1",seatinggenerated:true},{id:"E2",seatinggenerated:true}];
  const d = await api.loadCollegeDataSet({
    getStudents:()=>[],getHalls:()=>[],getExams:()=>exams,
    getSeatingPlan:()=>Promise.resolve({ok:true}),
  }, PLAN({planBudgetMs:100,minPlanReadMs:5000,previousPlans:{E2:{kept:true}}}));
  eq(d.plansIncomplete,true);
  eq(d.unreadPlanIds,["E1","E2"]);
  eq(d.plans.E2,{kept:true});
});

ait("a hanging seating-plan read is skipped; the load still completes", async () => {
  const d = await api.loadCollegeDataSet({
    getStudents: () => [], getHalls: () => [],
    getExams: () => [{ id: "E1", seatinggenerated: true }],
    getSeatingPlan: () => new Promise(function () {}),
  }, PLAN({ planTimeoutMs: 30, planBudgetMs: 1000, minPlanReadMs: 10 }));
  eq(d.plans, {}, "the hung plan is dropped, not awaited forever");
  eq(d.exams.length, 1, "core data still delivered");
});

ait("the seating-plan pass shares one budget, so N plans cannot multiply the wait", async () => {
  const N = 30, BUDGET = 200;
  const exams = Array.from({ length: N }, (_, i) => ({ id: "E" + i, seatinggenerated: true }));
  let reads = 0;
  const t0 = Date.now();
  const d = await api.loadCollegeDataSet({
    getStudents: () => [], getHalls: () => [], getExams: () => exams,
    getSeatingPlan: () => { reads++; return new Promise(function () {}); },
  }, PLAN({ planTimeoutMs: 60, planBudgetMs: BUDGET, minPlanReadMs: 50 }));
  const elapsed = Date.now() - t0;
  eq(d.plans, {}, "no plan is accepted");
  eq(d.exams.length, N, "core data is still complete");
  ok(reads < N, "the budget stops further reads: only " + reads + "/" + N + " attempted");
  ok(elapsed < N * BUDGET,
     "bounded by the shared budget, not N x budget (took " + elapsed + "ms, bound " + (N * BUDGET) + "ms)");
});

// ── a plan timeout must never look like a deletion ───────────────────────────
ait("a failed plan read carries the previous plan forward (never looks deleted)", async () => {
  const d = await api.loadCollegeDataSet({
    getStudents: () => [], getHalls: () => [],
    getExams: () => [{ id: "E1", seatinggenerated: true }],
    getSeatingPlan: () => Promise.reject(new Error("read failed")),
  }, PLAN({ previousPlans: { E1: { saved: true } } }));
  eq(d.plans.E1, { saved: true }, "the previously saved plan is kept");
});

ait("a timed-out plan read carries the previous plan forward", async () => {
  const d = await api.loadCollegeDataSet({
    getStudents: () => [], getHalls: () => [],
    getExams: () => [{ id: "E1", seatinggenerated: true }],
    getSeatingPlan: () => new Promise(function () {}),
  }, PLAN({ planTimeoutMs: 30, planBudgetMs: 1000, minPlanReadMs: 10,
            previousPlans: { E1: { saved: true } } }));
  eq(d.plans.E1, { saved: true }, "the hung read does not erase the saved plan");
});

ait("budget exhaustion preserves the previous plans it already held", async () => {
  const d = await api.loadCollegeDataSet({
    getStudents: () => [], getHalls: () => [],
    getExams: () => [{ id: "E1", seatinggenerated: true }, { id: "E2", seatinggenerated: true }],
    getSeatingPlan: () => new Promise(function () {}),
  }, PLAN({ planTimeoutMs: 40, planBudgetMs: 100, minPlanReadMs: 50,
            previousPlans: { E2: { kept: true } } }));
  eq(d.plans.E2, { kept: true }, "a skipped plan keeps its previous value");
  eq(d.plans.E1, undefined, "an attempt that failed with no previous value stays absent");
});

ait("a successful empty read drops a stale plan (truthful, not carried)", async () => {
  const d = await api.loadCollegeDataSet({
    getStudents: () => [], getHalls: () => [],
    getExams: () => [{ id: "E1", seatinggenerated: true }],
    getSeatingPlan: () => Promise.resolve(null),
  }, PLAN({ previousPlans: { E1: { stale: true } } }));
  eq(d.plans, {}, "a read that succeeds with no plan does not resurrect a stale one");
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

it("the seating-plan read is floored, not given the bare leftover budget", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  const start = html.indexOf("async function loadCollegeDataSet(");
  ok(start >= 0, "loadCollegeDataSet exists");
  const body = html.slice(start, html.indexOf("\n}", start));
  ok(body.indexOf("Math.min(planMs, left)") >= 0,
     "the per-read timeout is capped by a realistic plan timeout constant");
  ok(/left\s*<\s*minRead/.test(body),
     "the loop stops when the remaining budget is below the minimum read time");
  ok(!/getSeatingPlan\(exam\.id\),\s*left\b/.test(body),
     "the bare leftover budget is NEVER used as the read timeout (the 0.2s bug)");
  ok(/const DATA_LOAD_TIMEOUT_MS\s*=\s*\d+/.test(html), "a core timeout constant is declared");
  ok(/const SEATING_PLAN_TIMEOUT_MS\s*=\s*\d+/.test(html), "a per-plan timeout constant is declared");
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
