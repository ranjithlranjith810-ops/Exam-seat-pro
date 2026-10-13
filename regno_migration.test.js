// Register-number migration regression tests.
//
// Root cause pinned here: a student's register number is DENORMALISED — it is
// copied into every exam's registerNumbers[] candidate list and into every saved
// seat slot. Correcting it used to update ONLY students/{id}, so registerNumbers
// and the saved slots kept the old value: the next regeneration silently dropped
// the corrected student (and every candidate with no student record), shrinking a
// 500-seat plan to 498.
//
// The fix computes the whole migration (student record + candidate lists + seat
// slots) as ONE flat update map, so the applier can send it as a single atomic
// RTDB multi-location write. These tests drive the pure builders directly and
// simulate the all-or-nothing apply; a couple of source guards seal the wiring.
const fs = require("fs");
const h = require("./harness.js");
const api = h.load();

const s = h.suite("regno_migration.test.js — a register-number change migrates every linked reference");
const { it, eq, ok } = s;

const R1 = "953021243001", R2 = "953021243002", R3 = "953021243003", R4 = "953021243004";
const R_NEW = "953021243011";
const R_GHOST = "953021243099";

function student(id, regno, name, gender) {
  return { id: id, regno: regno, name: name, dept: "CSE", year: 2, semester: 3, gender: gender || "male", batch: regno.slice(4, 6), college_id: "c1", section: "A" };
}
function seat(regno, examId, seatLabel, bench, slot, name, gender) {
  return {
    regno: regno, name: name, gender: gender || "male", dept: "CSE", year: 2, semester: 3,
    batch: regno.slice(4, 6), college_id: "c1", section: "A",
    examId: examId, hallId: "lh1", hall: "LH-1", seatLabel: seatLabel, seatNo: "lh1-B" + bench + "S" + slot,
    bench: bench, slot: slot, rowIdx: bench, colIdx: slot, id: "seat-" + seatLabel, groupLabel: "CSE 2",
  };
}
function planDoc(id, examId, plan) { return { id: id, exam_id: examId, plan: plan }; }

// One config shared by the behaviour tests, rebuilt fresh for each so a test
// can never observe another test's mutation.
function fixture() {
  const students = [
    student("st1", R1, "ALPHA", "male"),
    student("st2", R2, "BETA", "female"),
    student("st3", R3, "GAMMA", "male"),
  ];
  const exams = [
    { id: "exA", date: "2026-10-14", session: "FN", subjectTitle: "EXAM A", groups: [{ dept: "CSE", year: 2 }], registerNumbers: [R1, R2, R_GHOST], studentCount: 3 },
    { id: "exB", date: "2026-10-14", session: "FN", subjectTitle: "EXAM B", groups: [{ dept: "CSE", year: 2 }], registerNumbers: [R2, R3], studentCount: 2 },
  ];
  const planDocs = [
    planDoc("plA", "exA", { lh1: { benches: [{ benchNo: 1, capacity: 2, slots: [seat(R1, "exA", "A1.1", 1, 1, "ALPHA"), seat(R2, "exA", "A1.2", 1, 2, "BETA", "female")] }], seats: [seat(R1, "exA", "A1.1", 1, 1, "ALPHA"), seat(R2, "exA", "A1.2", 1, 2, "BETA", "female")] } }),
    planDoc("plB", "exB", { lh1: { benches: [{ benchNo: 1, capacity: 1, slots: [seat(R3, "exB", "A2.1", 1, 1, "GAMMA")] }], seats: [seat(R3, "exB", "A2.1", 1, 1, "GAMMA")] } }),
  ];
  const halls = [{ id: "lh1", name: "LH-1", hallType: "University", numbenches: 5, studentsperbench: 3, capacity: 15, layoutConfig: { columns: [{ seats: 3 }] } }];
  return { students: students, exams: exams, planDocs: planDocs, halls: halls };
}

// Apply a flat RTDB-style update map atomically: EITHER every path is written or
// none is. Mirrors DB.ref("/").update(part) — the applier is all-or-nothing, so a
// throw during the write leaves the original state untouched.
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

// ── T1. correcting a register number updates EVERY affected exam candidate list ─
it("T1: the corrected regno replaces the old one in each exam that lists it", () => {
  const f = fixture();
  const mig = api.regnoMigrationUpdates({ student: f.students[0], newStudent: Object.assign({}, f.students[0], { regno: R_NEW }), exams: f.exams, planDocs: f.planDocs });
  eq(mig.updates["exams/exA/registerNumbers"], [R_NEW, R2, R_GHOST], "exA candidate list swaps 3001→3011 and keeps the ghost");
  ok(!Object.prototype.hasOwnProperty.call(mig.updates, "exams/exB/registerNumbers"), "exB (does not list 3001) is untouched");
  eq(mig.examIds, ["exA"], "only exA is reported as migrated");
});

it("T1b: duplicate old entries collapse to a single new value (no duplicate kept)", () => {
  const f = fixture();
  // A candidate list that (defensively) lists the old regno twice must not end up
  // with the new regno twice after migration.
  f.exams[0].registerNumbers = [R1, R1, R2];
  const mig = api.regnoMigrationUpdates({ student: f.students[0], newStudent: Object.assign({}, f.students[0], { regno: R_NEW }), exams: f.exams, planDocs: [] });
  eq(mig.updates["exams/exA/registerNumbers"], [R_NEW, R2], "duplicate old entries collapse to one new value");
});

// ── T2. a saved slot keeps the same hall and seat after correction ────────────
it("T2: the migrated seat keeps its hall, seat label, bench and slot", () => {
  const f = fixture();
  const mig = api.regnoMigrationUpdates({ student: f.students[0], newStudent: Object.assign({}, f.students[0], { regno: R_NEW, name: "ALPHA RENAMED" }), exams: f.exams, planDocs: f.planDocs });
  const plan = mig.updates["seating_plans/plA/plan"];
  const benched = plan.lh1.benches[0].slots.find(function (x) { return x.regno === R_NEW; });
  ok(!!benched, "the seat now carries the new register number");
  eq([benched.hall, benched.seatLabel, benched.bench, benched.slot], ["LH-1", "A1.1", 1, 1], "hall/seatLabel/bench/slot are byte-for-byte preserved");
  eq(benched.examId, "exA", "the exam assignment is preserved");
  eq(benched.name, "ALPHA RENAMED", "the student-derived name is refreshed");
  const flat = plan.lh1.seats.find(function (x) { return x.regno === R_NEW; });
  ok(!!flat, "the parallel seats[] view is migrated too (structure-agnostic)");
  eq([flat.hall, flat.seatLabel, flat.bench, flat.slot], ["LH-1", "A1.1", 1, 1], "seats[] geometry preserved");
});

// ── T3. the corrected student remains allocated exactly once ──────────────────
it("T3: the corrected student appears in exactly one slot across all plans", () => {
  const f = fixture();
  const mig = api.regnoMigrationUpdates({ student: f.students[0], newStudent: Object.assign({}, f.students[0], { regno: R_NEW }), exams: f.exams, planDocs: f.planDocs });
  eq(mig.seatsMigrated, 2, "both plan views (benches[].slots[] and seats[]) re-keyed once");
  const newPlan = mig.updates["seating_plans/plA/plan"];
  const hits = [];
  JSON.stringify(newPlan).replace(/"(regno)":"([^"]+)"/g, function (_, k, v) { if (v === R_NEW) hits.push(v); return _; });
  eq(hits.length, 2, "the new regno occupies exactly the two views of the ONE original seat (never a second seat)");
  const oldHits = [];
  JSON.stringify(newPlan).replace(/"(regno)":"([^"]+)"/g, function (_, k, v) { if (v === R1) oldHits.push(v); return _; });
  eq(oldHits.length, 0, "no stale reference to the old regno remains");
});

// ── T4. an unrelated student's allocation is not changed ──────────────────────
it("T4: another student's seat (and another exam's plan) is untouched", () => {
  const f = fixture();
  const mig = api.regnoMigrationUpdates({ student: f.students[0], newStudent: Object.assign({}, f.students[0], { regno: R_NEW }), exams: f.exams, planDocs: f.planDocs });
  ok(!Object.prototype.hasOwnProperty.call(mig.updates, "seating_plans/plB/plan"), "plan B (unrelated) is not rewritten");
  const planA = mig.updates["seating_plans/plA/plan"];
  const beta = planA.lh1.benches[0].slots.find(function (x) { return x.regno === R2; });
  eq([beta.hall, beta.seatLabel, beta.regno, beta.name], ["LH-1", "A1.2", R2, "BETA"], "the other student keeps their seat verbatim");
});

// ── T5. duplicate register numbers are rejected without modifying any data ────
it("T5: a register number already held by another student is a conflict", () => {
  const f = fixture();
  const conflict = api.regnoChangeConflict(R2, f.students, "st1");
  ok(!!conflict, "the conflict guard returns the other holder");
  eq(conflict.id, "st2", "the conflict names the real owner");
  eq(api.regnoChangeConflict(R_NEW, f.students, "st1"), null, "a free register number has no conflict");
  eq(api.regnoChangeConflict(R1, f.students, "st1"), null, "a student never conflicts with itself (exceptId)");
});

it("T5b: refusal happens before any update map is built (data unchanged)", () => {
  const f = fixture();
  const before = JSON.stringify(f);
  const conflict = api.regnoChangeConflict(R2, f.students, "st1");
  const mig = conflict ? null : api.regnoMigrationUpdates({ student: f.students[0], newStudent: Object.assign({}, f.students[0], { regno: R2 }), exams: f.exams, planDocs: f.planDocs });
  eq(mig, null, "no migration is produced when the new regno belongs to another student");
  eq(JSON.stringify(f), before, "the fixture (proxy for the database) is not mutated");
});

// ── T6. an unmatched / invalid register number leaves all data unchanged ──────
it("T6: a student whose old regno links to nothing migrates only the student record", () => {
  const f = fixture();
  const orphan = student("stX", "953021243077", "ORPHAN", "male"); // appears in no exam/plan
  const mig = api.regnoMigrationUpdates({ student: orphan, newStudent: Object.assign({}, orphan, { regno: R4 }), exams: f.exams, planDocs: f.planDocs });
  eq(Object.keys(mig.updates), ["students/stX"], "no exam or plan path is touched");
  eq(mig.examIds, [], "no exam migrated");
  eq(mig.planIds, [], "no plan migrated");
  eq(mig.seatsMigrated, 0, "no seat migrated");
});

it("T6b: an invalid register number is rejected by the rule before any migration", () => {
  ok(api.regnoError("12345").length > 0, "too-short regno is invalid");
  ok(api.regnoError("95302124301A").length > 0, "a letter makes it invalid");
  ok(api.regnoError(R_NEW) === "", "a valid 12-digit regno passes");
});

// ── T7. stale candidate references are reported before regeneration ───────────
it("T7: registerNumbers with no student record are reported, never silently dropped", () => {
  const f = fixture();
  eq(api.examStaleRegisterNumbers(f.exams[0], f.students), [R_GHOST], "exA's ghost candidate is reported");
  const rep = api.staleRegisterNumberReport(f.exams, f.students);
  eq(rep.length, 1, "one exam has stale candidates");
  eq(rep[0].examId, "exA", "the report names the exam");
  eq(rep[0].count, 1, "and the count");
  const rows = api.bulkExamRows(f.exams, "2026-10-14", f.students, f.halls, {}, "FN");
  const rowA = rows.filter(function (r) { return r.id === "exA"; })[0];
  eq(rowA.staleCandidates, [R_GHOST], "the pre-regeneration row carries the stale list (surfaced in the UI)");
  const rowB = rows.filter(function (r) { return r.id === "exB"; })[0];
  eq(rowB.staleCandidates, [], "a clean exam reports no stale candidates");
});

// ── T8. failure of the atomic operation does not produce a partial state ──────
it("T8: the migration is a single map that applies all-or-nothing", () => {
  const f = fixture();
  const mig = api.regnoMigrationUpdates({ student: f.students[0], newStudent: Object.assign({}, f.students[0], { regno: R_NEW }), exams: f.exams, planDocs: f.planDocs });
  const paths = Object.keys(mig.updates);
  ok(paths.length <= 200, "the whole migration fits in ONE atomic update() call (" + paths.length + " paths, chunk is 200)");
  ok(paths.indexOf("students/st1") >= 0 && paths.indexOf("exams/exA/registerNumbers") >= 0 && paths.indexOf("seating_plans/plA/plan") >= 0,
     "student, candidate list and plan are all in the SAME map (no sequential partial writes)");
});

it("T8b: a failed write leaves every location exactly as it was", () => {
  const f = fixture();
  const db = { students: { st1: JSON.parse(JSON.stringify(f.students[0])) }, exams: { exA: JSON.parse(JSON.stringify(f.exams[0])) }, seating_plans: { plA: { id: "plA", exam_id: "exA", plan: JSON.parse(JSON.stringify(f.planDocs[0].plan)) } } };
  const before = JSON.stringify(db);
  const mig = api.regnoMigrationUpdates({ student: f.students[0], newStudent: Object.assign({}, f.students[0], { regno: R_NEW }), exams: f.exams, planDocs: f.planDocs });
  let threw = false;
  try { applyAtomic(db, mig.updates, true); } catch (e) { threw = true; }
  ok(threw, "the simulated write rejects");
  eq(JSON.stringify(db), before, "nothing was written: no student with the new regno and no orphaned old reference");
});

it("T8c: a successful write lands the whole migration together", () => {
  const f = fixture();
  const db = { students: { st1: JSON.parse(JSON.stringify(f.students[0])) }, exams: { exA: JSON.parse(JSON.stringify(f.exams[0])) }, seating_plans: { plA: { id: "plA", exam_id: "exA", plan: JSON.parse(JSON.stringify(f.planDocs[0].plan)) } } };
  const mig = api.regnoMigrationUpdates({ student: f.students[0], newStudent: Object.assign({}, f.students[0], { regno: R_NEW }), exams: f.exams, planDocs: f.planDocs });
  applyAtomic(db, mig.updates, false);
  eq(db.students.st1.regno, R_NEW, "student record updated");
  eq(db.exams.exA.registerNumbers, [R_NEW, R2, R_GHOST], "candidate list updated");
  const seats = db.seating_plans.plA.plan.lh1.benches[0].slots;
  eq(seats[0].regno, R_NEW, "seat updated");
  eq(seats[0].seatLabel, "A1.1", "seat geometry intact after the write");
});

// ── source guards: the async wiring actually uses the atomic abstraction ──────
function sliceAt(html, marker, endMarker) {
  const start = html.indexOf(marker);
  ok(start >= 0, marker + " exists");
  const end = html.indexOf(endMarker, start + marker.length);
  ok(end >= 0, marker + " has a body terminator (" + endMarker + ")");
  return html.slice(start, end);
}

it("SR1: Store.updateStudentRegno builds one update map and writes it atomically", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  const body = sliceAt(html, "updateStudentRegno: async", "\n  },");
  ok(body.indexOf("regnoMigrationUpdates({") >= 0, "it builds the migration from the pure helper");
  ok(body.indexOf("dbAtomicUpdate(mig.updates)") >= 0, "it applies the WHOLE map with ONE dbAtomicUpdate");
  ok(body.indexOf("> 200") >= 0 && body.indexOf("cannot be written atomically") >= 0,
     "an oversized (non-atomic) migration is refused before any write");
  ok(!/dbUpdate\("students", id, \{ \.\.\.data, college_id: rr\.collegeId \}\);\s*;\s*return \{ id: id, regno/.test(body),
     "no partial sequential student write substitutes for the atomic migration");
});

it("SR2: saveStudent rejects a duplicate before migrating and preserves the no-change path", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  const body = sliceAt(html, "async function saveStudent(", "\n  }");
  ok(body.indexOf("regnoChangeConflict(upd.regno, students, editS.id)") >= 0, "the duplicate/swap guard runs on a regno change");
  ok(body.indexOf("Store.updateStudentRegno(editS.id, upd)") >= 0, "a valid change migrates linked references");
  ok(/delete upd\.regno;[\s\S]*Store\.updateStudent\(editS\.id, upd\)/.test(body),
     "an unchanged regno still uses the plain updateStudent path");
});

it("SR3: the plain updateStudent refuses a genuine register-number change (no backdoor)", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  const body = sliceAt(html, "updateStudent: async", "\n  },");
  ok(body.indexOf("updateStudentRegno so linked exam candidate lists and seating slots migrate") >= 0,
     "a real change is redirected to the migration path");
  ok(body.indexOf("normRegno(current.regno) !== normRegno(data.regno)") >= 0,
     "the guard only fires when the regno actually differs");
});

module.exports = s;
