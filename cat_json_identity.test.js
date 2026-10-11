// Regression tests for the CAT Timetable JSON import CRASH and the section
// identity it exposed.
//
// The reported failure was:
//   Cannot read properties of undefined (reading
//   'all_departments_subjects_semester_codes_corrected (1).json · AIDS')
// raised the moment the administrator confirmed the import. catCombineResults
// built its per-section map (`metaByFile`) and passed it to the summary, but
// never returned it — so commit() read combined.metaByFile[r.file] off
// `undefined`, and a filename shared between two files made two sections collide
// on the same label-keyed entry.
//
// These cases pin the fix: the map is returned; every section has a stable,
// unique key; every ready row resolves its section; a section shared filename
// can no longer overwrite another; and a failed lookup is a validation message,
// never an exception. They also pin the second-opinion 405 handling.
const fs = require("fs");
const path = require("path");
const h = require("./harness.js");
const api = h.load();

const s = h.suite("cat_json_identity.test.js — section identity, counters, 405 handling");
const { it, ait, eq, ok } = s;

const RAW = fs.readFileSync(path.join(__dirname, "fixtures", "cat_timetable.json"), "utf8");
const DATA = JSON.parse(RAW);
const clone = (o) => JSON.parse(JSON.stringify(o));

// The exact filename from the reported crash: spaces, parentheses.
const NAME = "all_departments_subjects_semester_codes_corrected (1).json";

const BRANCHES = [
  { dept: "CSE", code: "101", name: "Computer Science and Engineering" },
  { dept: "ECE", code: "102", name: "Electronics and Communication Engineering" },
  { dept: "EEE", code: "103", name: "Electrical and Electronics Engineering" },
  { dept: "MECH", code: "104", name: "Mechanical Engineering" },
  { dept: "AIDS", code: "105", name: "Artificial Intelligence and Data Science" },
];
const STUDENTS = [
  { regno: "A1", dept: "AIDS", year: "2", gender: "male" },
  { regno: "C1", dept: "CSE", year: "3", gender: "male" },
];
const CTX = { exams: [], students: STUDENTS, subjects: [], branches: BRANCHES,
  college: { code: "SMTEC", name: "SMTEC" }, collegeId: "COL1" };
const fileOf = (name, text) => ({ name: name, size: String(text).length, text: () => Promise.resolve(text) });

const resultsFor = (doc, name) =>
  api.catJsonSectionsToResults(name, api.catJsonPlan(doc, CTX, {}), CTX);

// ── 1. the crash: metaByFile is present and keys every ready row ─────────────
it("catCombineResults returns metaByFile (the exact crash)", () => {
  const c = api.catCombineResults(resultsFor(DATA, NAME), "COL1");
  ok(c.metaByFile && typeof c.metaByFile === "object", "metaByFile is present");
  eq(Object.keys(c.metaByFile).length, 5, "one entry per department section");
  const ready = c.rows.filter((r) => r.ready);
  ok(ready.length > 0);
  // This is the lookup commit() used to perform unguarded. It must never be
  // undefined for a ready row.
  const missing = ready.filter((r) => !c.metaByFile[api.catSectionKeyOf(r)]);
  eq(missing.length, 0, "every ready row resolves its department section");
});

it("the reported filename with spaces and parentheses keys cleanly", () => {
  const c = api.catCombineResults(resultsFor(DATA, NAME), "COL1");
  eq(c.files.length, 5);
  c.files.forEach((f) => ok(f.id && f.id.indexOf(NAME) >= 0, "key carries the filename: " + f.id));
});

// ── 2. stable, unique section identity ───────────────────────────────────────
it("each section gets a unique key and every row carries it", () => {
  const c = api.catCombineResults(resultsFor(DATA, NAME), "COL1");
  const fileKeys = c.files.map((f) => f.id);
  eq(new Set(fileKeys).size, fileKeys.length, "file ids are unique");
  const rowKeys = new Set(c.rows.map((r) => api.catSectionKeyOf(r)));
  eq(rowKeys.size, 5, "the rows belong to exactly five distinct sections");
  c.rows.forEach((r) => ok(fileKeys.indexOf(api.catSectionKeyOf(r)) >= 0, "row key names a file"));
});

it("two files that share a filename no longer collide", () => {
  // Same filename, different content: a code changed so the two files are
  // genuinely different timetables. Before the fix both wrote into metaByFile
  // under the SAME label, so one section silently overwrote the other.
  const doc2 = clone(DATA);
  doc2.departments.CSE.semester_subjects["Semester III"][1].subject_code = "ZZ0001";
  const a = resultsFor(DATA, "dup.json");
  const b = resultsFor(doc2, "dup.json");
  const c = api.catCombineResults(a.concat(b), "COL1");
  eq(c.files.length, 10, "ten sections from two files");
  eq(new Set(c.files.map((f) => f.id)).size, 10, "ten distinct ids");
  eq(Object.keys(c.metaByFile).length, 10, "ten distinct section metas — no overwrite");
  eq(api.catMissingSectionRows(c, c.rows.filter((r) => r.ready)).length, 0);
});

// ── 3. the guard: a missing section is a message, not a crash ────────────────
it("catMissingSectionRows flags every ready row when the map is empty", () => {
  const c = api.catCombineResults(resultsFor(DATA, NAME), "COL1");
  const broken = Object.assign({}, c, { metaByFile: {} });
  const ready = broken.rows.filter((r) => r.ready);
  eq(api.catMissingSectionRows(broken, ready).length, ready.length);
});

it("catMissingSectionRows tolerates a combined object with no map at all", () => {
  const rows = [{ file: "x.json", key: "x.json#1", ready: true }];
  eq(api.catMissingSectionRows({}, rows).length, 1);
  eq(api.catMissingSectionRows(null, rows).length, 1);
  eq(api.catMissingSectionRows({ metaByFile: {} }, []).length, 0);
});

// ── 4. counters are mutually consistent ──────────────────────────────────────
it("valid = ready + blocked, and total = valid + ignored", () => {
  const c = api.catCombineResults(resultsFor(DATA, NAME), "COL1");
  const sum = c.summary;
  eq(sum.valid, sum.ready + sum.blockedRows, "no row is both ready and blocked");
  eq(sum.total, sum.valid + sum.ignored, "ignored rows are counted separately");
  eq(sum.ignored, 0, "the JSON reader marks no non-exam activity as ignored");
});

it("the counts match the checked-in reference timetable", () => {
  const c = api.catCombineResults(resultsFor(DATA, NAME), "COL1");
  eq(c.summary.ready, 75);
  eq(c.summary.blockedRows, 6);
  eq(c.summary.missingCodes, 6);
  eq(c.summary.total, 81);
});

// ── 5. the Naan Mudalvan rows are genuinely blocked, never substituted ───────
it("all six Naan Mudalvan rows are blocked with no code, none is dropped", () => {
  const c = api.catCombineResults(resultsFor(DATA, NAME), "COL1");
  const nm = c.rows.filter((r) => r.subjectName === "Naan Mudalvan");
  eq(nm.length, 6);
  nm.forEach((r) => {
    eq(r.subCode, "", "the code is empty — nothing was invented");
    ok((r.errors || []).indexOf("SUBJECT CODE NOT EXTRACTED") >= 0);
    eq(r.ready, false);
    eq(r.ignored, false, "blocked, not silently dropped");
  });
});

it("CCS375 is its own ready CSE row, not a substitute for a missing code", () => {
  const c = api.catCombineResults(resultsFor(DATA, NAME), "COL1");
  const ccs = c.rows.filter((r) => r.subCode === "CCS375");
  eq(ccs.length, 1);
  eq(ccs[0].subjectName, "WEB TECHNOLOGIES");
  eq(ccs[0].ready, true);
  // No blocked row was given the CCS375 code to force it through.
  const stolen = c.rows.filter((r) => r.subCode === "CCS375" && r.subjectName === "Naan Mudalvan");
  eq(stolen.length, 0);
});

it("typing a code into a blocked Naan Mudalvan row is what unblocks it", () => {
  const c = api.catCombineResults(resultsFor(DATA, NAME), "COL1");
  const i = c.rows.findIndex((r) => r.subjectName === "Naan Mudalvan");
  ok(i >= 0);
  const ctx = c.ctxByFile[api.catSectionKeyOf(c.rows[i])];
  const fixed = api.catRebuildRow(c.rows[i], { subCode: "AD3591" }, ctx);
  eq(fixed.ready, true, "an explicit correction clears the block");
  eq(fixed.subCode, "AD3591");
  eq(api.catSectionKeyOf(fixed), api.catSectionKeyOf(c.rows[i]), "identity survives the edit");
});

// ── 6. editing + re-counting never loses a section link ──────────────────────
it("a corrected row keeps its key, so metaByFile still resolves after recount", () => {
  const c = api.catCombineResults(resultsFor(DATA, NAME), "COL1");
  const i = c.rows.findIndex((r) => r.subCode === "AD3501");
  const key = api.catSectionKeyOf(c.rows[i]);
  const ctx = c.ctxByFile[key];
  const rows = c.rows.slice();
  rows[i] = api.catRebuildRow(rows[i], { subjectName: "Deep Learning II" }, ctx);
  eq(api.catSectionKeyOf(rows[i]), key, "catRebuildRow preserves the key");
  const c2 = api.catRecount(Object.assign({}, c, { rows: rows }));
  ok(c2.metaByFile[key], "the section meta still resolves after an edit");
  eq(api.catMissingSectionRows(c2, c2.rows.filter((r) => r.ready)).length, 0);
});

it("toggling a row of a second file does not resolve into the first", () => {
  const doc2 = clone(DATA);
  doc2.departments.CSE.semester_subjects["Semester III"][1].subject_code = "ZZ0001";
  const c = api.catCombineResults(resultsFor(DATA, "a.json").concat(resultsFor(doc2, "a.json")), "COL1");
  const rows = c.rows.slice();
  const i = rows.length - 1;
  const key = api.catSectionKeyOf(rows[i]);
  const ctx = c.ctxByFile[key];
  rows[i] = api.catRebuildRow(rows[i], { excluded: true }, ctx);
  const c2 = api.catRecount(Object.assign({}, c, { rows: rows }));
  ok(c2.metaByFile[key], "the second file's section is still keyed");
});

// ── 7. re-analysis / failed-write retry is idempotent, no duplicates ─────────
it("re-analysing the same file derives the same identities", () => {
  const once = api.catCombineResults(resultsFor(DATA, NAME), "COL1");
  const again = api.catCombineResults(resultsFor(DATA, NAME), "COL1");
  eq(again.summary.ready, once.summary.ready);
  eq(again.summary.batchDuplicates, once.summary.batchDuplicates);
  eq(again.files.length, once.files.length);
});

it("a retry after a failed write re-derives the same row identity", () => {
  const c = api.catCombineResults(resultsFor(DATA, NAME), "COL1");
  const a = c.rows.find((r) => r.subCode === "AD3501");
  const b = api.catCombineResults(resultsFor(DATA, NAME), "COL1").rows.find((r) => r.subCode === "AD3501");
  eq(api.catRowIdentityKey(a, "COL1"), api.catRowIdentityKey(b, "COL1"),
    "the same exam has the same identity on a retry — nothing is written twice");
});

// ── 8. second-opinion replies are classified, never thrown ───────────────────
it("a successful reply carries the suggestions", () => {
  const r = api.catLlmReply(200, { suggestions: [{ id: 0, subjectCode: "X1" }] });
  ok(r.ok); eq(r.suggestions.length, 1); eq(r.unavailable, false); eq(r.message, "");
});

it("405 and the other not-deployed codes are 'unavailable', not errors to clear", () => {
  [404, 405, 501, 503].forEach((status) => {
    const r = api.catLlmReply(status, {});
    ok(!r.ok);
    ok(r.unavailable, "HTTP " + status + " is unavailable");
    ok(/not available/i.test(r.message), r.message);
    ok(/cat-llm/.test(r.message), "names the function that is missing");
  });
});

it("a 500 is a real failure, distinct from 'not deployed here'", () => {
  const r = api.catLlmReply(500, { error: "upstream exploded" });
  ok(!r.ok); eq(r.unavailable, false);
  ok(/upstream exploded/.test(r.message), r.message);
});

it("429 asks the administrator to retry, and is not 'unavailable'", () => {
  const r = api.catLlmReply(429, {});
  ok(!r.ok); eq(r.unavailable, false);
  ok(/429/.test(r.message) && /moment/i.test(r.message), r.message);
});

it("a network failure is classified as unavailable, not thrown", () => {
  const r = api.catLlmReply(0, null, new Error("Failed to fetch"));
  ok(!r.ok); ok(r.unavailable);
  ok(/could not be reached/i.test(r.message), r.message);
});

it("catLlmReply never throws on malformed input", () => {
  [undefined, null, "", 0, NaN].forEach((v) => {
    const r = api.catLlmReply(v, null, null);
    ok(r && typeof r.message === "string" && Array.isArray(r.suggestions));
  });
  const weird = api.catLlmReply(200, null, null);
  eq(weird.suggestions.length, 0, "a 200 with no body yields no suggestions");
});

// ── 9. end-to-end: process -> combine -> guard, all green ────────────────────
ait("a real file end-to-end never produces an unlinked ready row", async () => {
  const res = await api.catProcessJsonFile(fileOf(NAME, RAW), CTX, function () {});
  const c = api.catCombineResults(res, "COL1");
  eq(c.files.length, 5);
  eq(api.catMissingSectionRows(c, c.rows.filter((r) => r.ready)).length, 0);
  eq(c.summary.ready, 75);
});

module.exports = s;
