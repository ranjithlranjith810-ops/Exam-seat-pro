// Login-latency regression tests — the dashboard used to load each generated
// exam's seating plan with its OWN full /seating_plans read, in a serial loop.
// A college with 75 generated exams paid ~3 + 75 serial whole-node downloads
// before the dashboard appeared. The load path now issues ONE whole-node plans
// read CONCURRENTLY with the three core reads (≈4 parallel bounded requests),
// and scopes the result to the college's own exams.
//
// The behavioural guarantees (single concurrent read, bounds, carry-forward,
// truthful success) live in data_load_resilience.test.js; this suite pins the
// App wiring that actually delivers those guarantees, so the browser path can
// never regress into the old loop without this suite failing.
const fs = require("fs");
const h = require("./harness.js");
const api = h.load();

const s = h.suite("login_optimization.test.js — the dashboard is ~4 parallel reads, not 3 + N");
const { it, ait, eq, ok } = s;

it("Store.getAllSeatingPlans is one whole-node read of /seating_plans", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  const idx = html.indexOf("getAllSeatingPlans:");
  ok(idx >= 0, "Store exposes getAllSeatingPlans");
  const decl = html.slice(idx, idx + 120);
  ok(decl.indexOf('dbGet("seating_plans", [])') >= 0,
     "it reads the whole node exactly once, unfiltered");
});

it("App hands the concurrent loader a getAllSeatingPlans reader, not a per-exam one", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  const start = html.indexOf("async function loadCollegeData()");
  ok(start >= 0, "loadCollegeData exists");
  const body = html.slice(start, html.indexOf("function handleLogin(u)", start));
  ok(body.indexOf("getAllSeatingPlans: () => Store.getAllSeatingPlans()") >= 0,
     "the whole-node reader is wired into the loader");
  ok(body.indexOf("getSeatingPlan:(examId)") < 0,
     "the old per-exam plan reader is no longer passed to the loader");
  ok(body.indexOf("loadCollegeDataSet({") >= 0, "the load still goes through the bounded loader");
});

it("the Step-1 reachability check is a light read, not a full /colleges download", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  const lit = html.indexOf('DB.ref("colleges").limitToFirst(1).get()');
  ok(lit >= 0, "reachability reads ONE child, so the splash never waits on the whole node");
  const around = html.slice(lit - 300, lit + 220);
  ok(around.indexOf("setDbOk") >= 0 && html.lastIndexOf("booting", lit) > lit - 800,
     "the light read IS the Step-1 splash/reachability gate");
  const full = html.indexOf('dbGet("colleges",[])');
  ok(full >= 0, "a full colleges-list read still exists for the admin college picker");
  ok(html.slice(full, full + 120).indexOf("setColleges") >= 0,
     "and that full read feeds the picker, never the login/splash gate");
});

it("the whole-node plan read instance is fetched through Store, exactly once per load", async () => {
  let calls = 0;
  const d = await api.loadCollegeDataSet({
    getStudents: () => [], getHalls: () => [], getExams: () => [],
    getAllSeatingPlans: () => { calls++; return Promise.resolve([]); },
  }, {});
  eq(calls, 1, "one plans read per load call");
  eq(Object.keys(d.plans).length, 0, "a college with no exams gets an empty plan map");
});

it("legacy per-exam plan helpers stay for bulk/seating flows, so nothing else regresses", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  ok(/async getSeatingPlan\(examId\)/.test(html), "Store.getSeatingPlan still exists (bulk/generate use it)");
  ok(/async setSeatingPlan\(examId, plan\)/.test(html), "Store.setSeatingPlan still exists");
});

module.exports = s;