// Repeatable bulk-seating benchmark with synthetic, deterministic data.
//
//   node bulk_bench.js index.html
//
// Measures prep (lookup maps + student matching), local seating computation and
// validation SEPARATELY, then a 25-exam batch. Persistence is simulated in
// memory because there is no Firebase in this environment; it is reported as
// such and must not be read as a network/Firebase figure.
//
// Data is generated from a fixed PRNG seed, so every run is identical. Each
// generated plan is validated with the same validatePlan/validateGenderSeparation
// helpers the app uses.
const h = require("./harness.js");
const api = h.load();

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEPTS = ["CSE", "ECE", "MECH", "EEE", "AIDS", "IT", "CIVIL"];
const GROUP_COMBOS = [
  { dept: "CSE", year: 1 }, { dept: "ECE", year: 2 }, { dept: "MECH", year: 1 },
  { dept: "EEE", year: 3 }, { dept: "AIDS", year: 1 }, { dept: "IT", year: 2 },
  { dept: "CIVIL", year: 4 },
];

function makeStudents(n, seed) {
  const rnd = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const combo = GROUP_COMBOS[i % GROUP_COMBOS.length];
    out.push({
      id: "s" + i,
      regno: "6" + String(1000000 + i),
      name: "Student " + i,
      dept: combo.dept,
      year: combo.year,
      gender: (rnd() < 0.5) ? "female" : "male",
    });
  }
  return out;
}

function makeHalls(totalCapacity) {
  const per = 90;
  const count = Math.ceil(totalCapacity / per) + 1;
  const halls = [];
  for (let i = 0; i < count; i++) {
    halls.push({
      id: "h" + i, name: "Hall " + i, hallType: "University",
      numbenches: 10, layoutConfig: { columns: [{ seats: 3 }, { seats: 3 }, { seats: 3 }] },
    });
  }
  return halls;
}

const RULES = { splitGender: true, noSameDept: false, noSameYear: false, benchAdjacency: false };

function ms(t0) { return Math.round((Date.now() - t0) * 100) / 100; }

function oneDataset(n) {
  const students = makeStudents(n, 1234 + n);
  const halls = makeHalls(n);
  const exam = {
    id: "bench" + n, subject: "University", subjectTitle: "Bench " + n,
    date: "2025-12-01", session: "FN", status: "scheduled",
    groups: GROUP_COMBOS,
  };

  let t = Date.now();
  const lookups = api.bulkBuildLookups(students, [exam], halls);
  const matched = api.bulkExamStudents(exam, students, lookups);
  const prep = ms(t);

  const groups = [{ label: "Bench", dept: "MIX", year: 1, students: matched, rules: RULES }];

  t = Date.now();
  const plan = api.generateSmartSeating(groups, halls, {});
  const compute = ms(t);

  t = Date.now();
  const problems = api.validatePlan(plan, RULES).concat(api.validateGenderSeparation(plan));
  const validate = ms(t);

  return { n: n, matched: matched.length, halls: halls.length, prep: prep, compute: compute, validate: validate, ok: problems.length === 0, problems: problems };
}

function batch25() {
  const students = [];
  for (let d = 0; d < 25; d++) {
    for (let i = 0; i < 40; i++) {
      students.push({ id: "d" + d + "_" + i, regno: "7" + String(d).padStart(2, "0") + String(i).padStart(4, "0"), name: "D" + d + " #" + i, dept: "D" + d, year: 1, gender: (i % 2) ? "female" : "male" });
    }
  }
  const halls = [];
  for (let i = 0; i < 8; i++) halls.push({ id: "bh" + i, name: "Hall " + i, hallType: "University", numbenches: 5, studentsperbench: 3 });
  const exams = [];
  for (let i = 0; i < 25; i++) {
    exams.push({
      id: "bx" + i, subject: "University", subjectTitle: "Exam " + i,
      date: "2025-12-" + String(1 + Math.floor(i / 2)).padStart(2, "0"),
      session: (i % 2) ? "AN" : "FN", status: "scheduled",
      groups: [{ dept: "D" + i, year: 1 }],
    });
  }

  const saveTimes = [];
  const started = Date.now();
  return api.runBulkSeating({
    exams: exams, allExams: exams, students: students, halls: halls, rules: RULES,
    savePlan: async function () { const t = Date.now(); saveTimes.push(ms(t)); },
  }).then(function (res) {
    const total = ms(started);
    return { res: res, total: total };
  });
}

(async function main() {
  console.log("Bulk seating benchmark — synthetic deterministic data");
  console.log("(persistence is in-memory/simulated: this environment has no Firebase)\n");
  console.log("SINGLE EXAM");
  console.log("students   matched  halls   prep_ms   compute_ms   validate_ms   valid");
  const results = [];
  for (const n of [100, 200, 500, 1000]) {
    const r = oneDataset(n);
    results.push(r);
    console.log(
      String(r.n).padEnd(10) + String(r.matched).padEnd(9) + String(r.halls).padEnd(8) +
      String(r.prep).padEnd(10) + String(r.compute).padEnd(13) + String(r.validate).padEnd(14) + (r.ok ? "yes" : "NO(" + r.problems.length + ")")
    );
  }

  console.log("\nBATCH OF 25 EXAMS (40 students each, disjoint groups, across dates/sessions)");
  const b = await batch25();
  const s = b.res.summary;
  console.log("  total wall time : " + b.total + " ms");
  console.log("  saved           : " + s.completed + " / " + s.total);
  console.log("  failed          : " + s.failed + "   save_failed: " + s.saveFailed + "   skipped: " + s.skipped);
  console.log("  students assigned: " + s.assigned + "   unplaced: " + s.unplaced);
  const avg = s.completed ? Math.round((s.elapsedMs / s.completed) * 100) / 100 : 0;
  console.log("  avg per exam (incl. compute+validate+save stub): " + avg + " ms");
  console.log("  largest tested dataset: 1000 students (single exam) + 25-exam batch");

  const allValid = results.every(function (r) { return r.ok; }) && s.failed === 0 && s.saveFailed === 0;
  console.log("\nAll generated plans satisfied the enabled rules: " + (allValid ? "YES" : "NO"));
  process.exit(allValid ? 0 : 1);
})();
