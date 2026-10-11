// Test harness for the CAT importer.
//
// The CAT functions are lifted straight out of index.html BY NAME at run time and
// evaluated in a sandbox. Nothing is copied into this harness, so a test can never
// pass against a stale copy of the code: if a function in index.html changes, these
// tests are testing the new version immediately, and if a function disappears they
// fail loudly rather than silently skipping.
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const { collectFrom, parseAll } = require("./cat_extract.js");

const HTML = process.argv[2] ||
  path.join("D:\\COMPLETED PROJECTS\\SEATING PROJECT\\ExamSeatPro_v66_secure", "index.html");

// Helpers defined outside the CAT block that the CAT functions call. The exact
// set is discovered from the AST rather than listed by hand: sched*/att*/curri*
// helpers are pulled in wholesale, so adding a call in index.html cannot leave the
// harness silently missing the definition it needs.
const PRELUDE = [];

// Seating-engine entry points the tests drive directly. Each name is a pure
// function over plain objects — none touches Firebase, the DOM, or React.
const SEATING_ENGINE = new Set([
  "placeStudentsInHalls",
  "generateSmartSeating",
  "validatePlan",
  "validateGenderSeparation",
  "calcHallCapacity",
  "buildSeatingReport",
  "benchAdjacencyActive",
  "sideBySideRulesActive",
  "benchFacingSeat",
  "byRegNo",
  "normRegno",
  "hallSeatInventory",
  "hallSeatSlotsPerRow",
  "hallPhysicalCapacity",
  "hallConfiguredCapacity",
  "hallUsableCapacity",
  "hallCapacityConfigError",
  "planIntegrityProblems",
  "adjacencyImpossibility",
  "manualRuleGate",
  "interleaveByDepartment",
]);

// The hall-notice integrity path. Pure functions over plain objects — nothing
// here touches Firebase, React or the DOM — so grouping, collision detection,
// canonical hall resolution and the rendered notice grid can be asserted.
const NOTICE_ENGINE = new Set([
  "resolveHall",
  "canonicalHallRecord",
  "hallNoticesGroup",
  "hnNoticeOrder",
  "hnNoticeLayout",
  "hnNoticeMetrics",
  "hnNoticeMetricsHalf",
  "hnNoticeStylesheet",
  "hnRenderNoticePage",
  "hnAuditNotices",
  "buildHallNoticesDocument",
  "buildHallNoticesPrintDocument",
  "auditHallNoticeCollisions",
  "findPlanHallSessionConflicts",
  "hnNormHall",
  "hnCanonDate",
  "hnCanonSession",
  "hnBatchKey",
  "hnSeatKeys",
  "hnSeatLabel",
  "hnNoticeDedupeRows",
  "hallNoticePerHall",
  "hallNoticeDateSessions",
  "hallNoticeOptions",
  "hallOptionSeats",
  "canonicalHallId",
  "hallUsedSeatKeys",
  "examReservationData",
  "hallMergedUniqueSeats",
  "seatingPlanDuplicateRows",
  "seatingGridIntegrityText",
  "hnEscapeHtml",
  "hnEsc",
  "hnFormatDate",
  "colLabelFromIdx",
  "hnDebug",
]);

// The college-data load path. `withDataTimeout` bounds a read that may never
// settle, and `loadCollegeDataSet` is the pure loader it drives, so the whole
// "a load always ends as real data or a retryable error, never an infinite
// spinner" guarantee can be asserted outside a browser. Listed explicitly by
// name for the same reason as SEATING_ENGINE: a prefix match would drag app
// wiring (setState, Firebase, React) into the sandbox.
const LOAD_ENGINE = new Set([
  "withDataTimeout",
  "loadCollegeDataSet",
]);

// The bulk-seating path. These are the pure helpers the Bulk Seating by Date
// feature drives, so date filtering, eligibility, hall selection, per-exam
// generation/validation and the batch orchestrator can all be asserted as plain
// functions over synthetic data — no browser, React or Firebase. The orchestrator
// runs sequentially and only touches the database through the injected
// loadPlan/savePlan callbacks, so a fake can record reads and writes.
const BULK_ENGINE = new Set([
  "bulkCanonDate",
  "bulkCanonSession",
  "hallByIdOrName",
  "examHallTypePool",
  "bulkBuildLookups",
  "bulkExamStudents",
  "bulkExamHallCapacity",
  "hallCapacityWarningsFor",
  "bulkExamRows",
  "bulkSelectHalls",
  "bulkBuildHallUsedSeats",
  "bulkGenerateOne",
  "runBulkSeatingCoSeated",
  "bulkYield",
  "bulkSummarize",
  "runBulkSeating",
]);

function load() {
  const src = fs.readFileSync(HTML, "utf8");
  const blocks = parseAll(src);
  const { fns, consts } = collectFrom(blocks);

  const all = Object.keys(fns);
  // Sliced from whichever script block actually declared them.
  const srcOf = (e) => e.text.slice(e.node.start, e.node.end);
  // A React component (or a constant holding one) returns JSX, which cannot be
  // evaluated as plain script. They are never called by these tests, so they are
  // simply left out.
  const looksJsx = (text) => /className\s*=|=>\s*\(?\s*<[A-Za-z]/.test(text);
  // `const DB = window.__firebaseDb` and friends evaluate at definition time and
  // need a real browser. They are never used by these tests.
  const touchesBrowser = (text) => /\b(window|document|localStorage|sessionStorage|navigator)\b/.test(text);
  const isJsx = (n) => looksJsx(srcOf(fns[n]));
  const catFns = all.filter((n) => /^cat[A-Za-z0-9_]*$/.test(n) && !isJsx(n));
  // Upper-snake CAT constants are lookup tables the CAT functions reference from
  // inside their bodies (CAT_SEATING_RULES), so they load eagerly like the other
  // plain constants.
  const catConsts = Object.keys(consts).filter((n) => /^CAT_[A-Z0-9_]+$/.test(n) && !looksJsx(srcOf(consts[n])) && !touchesBrowser(srcOf(consts[n])));
  const shared = all.filter((n) => /^(sched|att|curri|course|branch|examGroup)/i.test(n) && !isJsx(n));
  // The seating engine is reachable by name so its rule invariants can be
  // asserted outside a browser. Listed explicitly rather than by prefix: these
  // functions are pulled in as a set, and a prefix match would drag unrelated
  // app wiring (and browser-only globals) into the sandbox.
  const engine = all.filter((n) => SEATING_ENGINE.has(n) && !isJsx(n));
  const loadEngine = all.filter((n) => LOAD_ENGINE.has(n) && !isJsx(n));
  const bulkEngine = all.filter((n) => BULK_ENGINE.has(n) && !isJsx(n));
  const noticeEngine = all.filter((n) => NOTICE_ENGINE.has(n) && !isJsx(n));
  const names = [...new Set([...shared, ...catFns, ...engine, ...loadEngine, ...bulkEngine, ...noticeEngine])];
  const needed = names.filter((n) => !fns[n]);
  if (needed.length) throw new Error("could not extract: " + needed.join(", "));

// Upper-snake constants are plain lookup tables (CAT_*, SCHED_MONTHS, DEPT_CODE,
// ...). They are loaded eagerly because they are referenced from inside function
// BODIES, not at definition time, so a missing one only throws much later, when a
// test calls the function. The resolution loop below cannot see that, so anything
// called at test time has to be present from the start.
// Anything else a top-level declaration references - React, browser globals,
// unrelated app wiring - is stubbed as undefined. A stub can never satisfy a
// test: if a test genuinely needs that name it fails on its own assertion instead
// of silently measuring undefined.
const constNames = new Set([...catConsts, ...Object.keys(consts).filter((n) =>
    /^[A-Z][A-Z0-9_]*$/.test(n) && !looksJsx(srcOf(consts[n])) && !touchesBrowser(srcOf(consts[n])))]);
  const stubs = new Set();
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Math, JSON, Object, Array, String, Number, Boolean, isFinite, isNaN,
    Promise, Error, TypeError, RangeError, Set, Map, RegExp, Date, Symbol,
    parseInt, parseFloat, Infinity, NaN, undefined, Intl, URL,
    Uint8Array, Float32Array, Int32Array, Int8Array,
    setTimeout, clearTimeout, performance: { now: () => Date.now() },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // generateSmartSeating reports through window.__lastSeatingResult. A real
  // window is not needed — only somewhere to hang that object — so the sandbox
  // window simply points back at the sandbox context.
  sandbox.window = sandbox;

  const decls = (ns, cs, stub) => cs.map((n) => srcOf(consts[n])).join("\n")
    + "\n" + ns.map((n) => srcOf(fns[n])).join("\n")
    + (stub && stub.size ? "\n" + [...stub].map((n) => "const " + n + "=undefined;").join("\n") : "");
  const expose = (ns, cs, stub) => "(function(){\n" + decls(ns, cs, stub) + "\nconst __o={};\n"
    + ns.map((n) => "try{__o[" + JSON.stringify(n) + "]=" + n + ";}catch(e){}").join("\n") + "\n"
    + cs.map((n) => "try{__o[" + JSON.stringify(n) + "]=" + n + ";}catch(e){}").join("\n")
    + "\nreturn __o;})()";

  for (let attempt = 0; attempt < 40; attempt++) {
    let out;
    try {
      out = vm.runInContext(expose(names, [...constNames], stubs), sandbox);
    } catch (e) {
      const m = /(\w+) is not defined/.exec(e.message);
      if (!m) throw e;
      const nm = m[1];
      if (consts[nm] && !looksJsx(srcOf(consts[nm]))) constNames.add(nm);
      else stubs.add(nm);
      continue;
    }
    const api = Object.assign({}, out);
    api.__counts = { functions: names.length, consts: constNames.size, stubs: stubs.size };
    // generateSmartSeating stashes its report on window.__lastSeatingResult. Tests
    // run in Node, where `window` is not the sandbox, so the sandbox context is
    // handed back here as __win. Without it a test cannot see the unplaced list or
    // the validation report and ends up asserting against an empty object.
    api.__win = sandbox;
    return api;
  }
  throw new Error("could not resolve sandbox dependencies");
}

// ---- tiny assertion kit -----------------------------------------------------
// `it` runs a case immediately, so a synchronous suite is fully built by the time
// suite() returns. `ait` registers a promise instead, for the cases that have to
// open a real PDF before they can assert anything. Both land in the same list and
// are reported in declaration order, so a suite may mix the two freely.
function suite(name) {
  const items = [];
  const it = (label, fn) => { try { fn(); items.push({ label, ok: true }); }
    catch (e) { items.push({ label, ok: false, msg: e.message }); } };
  const ait = (label, fn) => { items.push({
    label,
    pending: Promise.resolve().then(fn)
      .then(() => ({ label, ok: true }))
      .catch((e) => ({ label, ok: false, msg: (e && e.message) || String(e) })),
  }); };
  const eq = (a, b, note) => {
    const A = JSON.stringify(a), B = JSON.stringify(b);
    if (A !== B) throw new Error((note ? note + ": " : "") + "expected " + B + " got " + A);
  };
  const ok = (v, note) => { if (!v) throw new Error((note || "assertion failed")); };
  return { name, it, ait, eq, ok, items };
}
function report(suites) {
  const done = [];
  for (const s of suites) for (const i of s.items) done.push(i.pending ? i.pending : Promise.resolve(i));
  return Promise.all(done).then((results) => {
    let pass = 0, fail = 0, idx = 0;
    for (const s of suites) {
      console.log("\n=== " + s.name + " ===");
      for (const _ of s.items) {
        const i = results[idx++];
        if (i.ok) { pass++; console.log("  PASS  " + i.label); }
        else { fail++; console.log("  FAIL  " + i.label + "\n        " + i.msg); }
      }
    }
    console.log("\n" + pass + " passed, " + fail + " failed");
    return fail;
  });
}

module.exports = { load, suite, report, HTML };