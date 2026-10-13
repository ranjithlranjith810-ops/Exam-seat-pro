// Regression tests for the CSV student-import path. Store.bulkAddStudents used
// to await resolveCollegeFromRegisterNumber ONCE PER STUDENT — dbGet("colleges")
// fetches the whole node and filters client-side, so that was a sequential loop
// of one full-node network read per student: a 649-student upload made 649 reads
// (minutes, no writes) and the UI stayed at "0/649 · Adding new students…".
//
// The loop now memoises college lookups by 4-digit centre code — the same
// per-centre-code trick the backup Restore path uses — so a single-centre upload
// makes exactly ONE colleges read, and the write remains one chunked atomic
// update (dbAtomicUpdate splits at 200 paths per update() call).
//
// The Store/DB layer cannot run in the sandbox (DB/AUTH/Store are browser-global
// Firebase wiring), so these are source-level guards on the exact functions that
// changed, in the same style as bulk_delete.test.js. If bulkAddStudents is ever
// refactored, the assertion that the guarded read and the single atomic write
// survive will keep this guarantee honest.
const fs = require("fs");
const h = require("./harness.js");
h.load();

const s = h.suite("csv_upload_perf.test.js — one colleges read per centre code");
const { it, ok } = s;

function sliceAt(html, marker, endMarker) {
  const start = html.indexOf(marker);
  ok(start >= 0, marker + " exists");
  const end = html.indexOf(endMarker, start + marker.length);
  ok(end >= 0, marker + " has a body terminator (" + endMarker + ")");
  return html.slice(start, end);
}

it("bulkAddStudents reads colleges once per 4-digit centre code, not per student", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  const body = sliceAt(html, "bulkAddStudents: async", "\n  },");
  ok(body.indexOf("const collegeByCode = {}") >= 0, "a per-centre-code cache exists");
  ok(body.indexOf("rr = collegeByCode[code]") >= 0, "the cache is consulted before any read");
  ok(/const code = studentRegnoClean\(s && s\.regno\)\.slice\(0, 4\)/.test(body),
     "the cache key is the 4-digit register-number code");
  ok(/if \(!rr \|\| !rr\.collegeId\) \{/.test(body)
     && body.indexOf("rr = await resolveCollegeFromRegisterNumber(s && s.regno)") >= 0,
     "the whole-node colleges read fires only on a cache miss");
  ok(body.indexOf("if (rr && rr.collegeId) collegeByCode[code] = rr") >= 0,
     "only successful lookups are cached");
  ok(body.indexOf('if (!rr.college) throw new Error("Import blocked: " + rr.error + " (Register Number " + (s && s.regno) + ")")') >= 0,
     "a failed resolution still fails loudly with the per-student register number");
  ok(body.indexOf('dbBatchAdd("students", stamped)') >= 0, "the write is still one dbBatchAdd call");
  ok(!/for \(const s of \(arr \|\| \[\]\)\) \{\s*const rr = await resolveCollegeFromRegisterNumber/.test(body),
     "no unguarded per-student colleges read remains");
});

it("bulkAddStudents reports progress and a PII-free diagnostic", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  const body = sliceAt(html, "bulkAddStudents: async", "\n  },");
  ok(/if \(onProgress\) onProgress\(\{ phase: "Resolving", done: i \+ 1, total \}\)/.test(body),
     "progress is reported per student handled");
  ok(body.indexOf('[CSVUpload] stamped " + stamped.length') >= 0,
     "a console diagnostic reports counts only");
  ok(/Object\.keys\(collegeByCode\)\.length \+ " college read\(s\)/.test(body)
     && /Object\.keys\(written \|\| \{\}\)\.length \+ " paths\./.test(body),
     "the diagnostic reports the number of college reads and written paths, never names or register numbers");
});

it("csv_upload_perf.test.js passes the progress callback from confirmUpload", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  const body = sliceAt(html, "async function confirmUpload(", "\n  }");
  ok(body.indexOf("Store.bulkAddStudents(toAdd") >= 0, "confirmUpload drives bulkAddStudents");
  ok(/Store\.bulkAddStudents\(toAdd, \(p\) => \{/.test(body),
     "the add path passes a progress callback so the bar moves instead of freezing at 0/649");
});

it("dbAtomicUpdate still writes atomically in 200-path chunks", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  const body = sliceAt(html, "async function dbAtomicUpdate(", "\n  }");
  ok(body.indexOf("const CHUNK = 200") >= 0, "the write is chunked at 200 paths");
  ok(body.indexOf("DB.ref(\"/\").update(part)") >= 0, "each chunk is a single atomic update");
});

module.exports = s;