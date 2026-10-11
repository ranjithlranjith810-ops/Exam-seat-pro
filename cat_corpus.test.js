// End-to-end tests for the new reader (cat_core.js) against the two REAL college
// sheets in corpus/.
//
// These assert the things that used to be hardcoded: which dates exist, which
// years exist, which subject belongs to which date and year, and which member of
// staff teaches it. Nothing here is a guess about a third sheet - the point is that
// the reader derives all of it from the file's own geometry and text.
//
// The subject names below are abbreviated where the sheet is long; the codes,
// dates, years and counts are exact.
const fs = require("fs");
const path = require("path");
const h = require("./harness.js");
const C = require("./cat_core.js");
const P = require("pdfjs-dist/legacy/build/pdf.js");
const s = h.suite("cat_corpus.test.js \u2014 real sheets, end to end");
const { ait, eq, ok } = s;

const CORPUS = path.join(__dirname, "corpus");
const DEPARTMENTS = [
  { code: "CSE", name: "Computer Science and Engineering", aliases: ["CSE", "CS"] },
  { code: "AI&DS", name: "Artificial Intelligence and Data Science", aliases: ["AI&DS", "AIDS", "AI DS", "AI"] },
  { code: "ECE", name: "Electronics and Communication Engineering", aliases: ["ECE", "EC"] },
  { code: "MECH", name: "Mechanical Engineering", aliases: ["MECH", "ME"] },
  { code: "CIVIL", name: "Civil Engineering", aliases: ["CIVIL", "CE"] },
];

// Read a sheet the same way the browser will: pdf.js supplies the words and the
// operator list, and nothing else. The transform is passed in so that rules land
// in the same reading space as the words.
async function read(file) {
  const doc = await P.getDocument({
    data: new Uint8Array(fs.readFileSync(file)), verbosity: 0,
  }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const matrixFn = (x, y) => P.Util.applyTransform([x, y], vp.transform);
    const tc = await page.getTextContent();
    // The operator list has to be fetched before the font objects resolve, and
    // only then does pdf.js admit what "g_d0_f3" actually is.
    const ops = await page.getOperatorList();
    pages.push({
      page: n,
      words: C.wordsFromPdfPage(page, {
        page: n, textItems: tc.items, matrixFn,
        fontStyleFn: (name) => { try { return page.commonObjs.get(name); } catch (e) { return null; } },
      }),
      rules: C.rulesFromOperators(ops, n,
        { x0: 0, x1: vp.width, top: 0, bottom: vp.height }, P.OPS, { toReading: matrixFn }),
      box: { x0: 0, x1: vp.width, top: 0, bottom: vp.height },
    });
  }
  return C.analyse(pages, { departments: DEPARTMENTS });
}

// date -> year -> [codes], for compact comparison.
function index(r) {
  const out = {};
  r.tables.forEach((t) => t.exams.forEach((b) => {
    const k = b.date + "/" + b.year;
    out[k] = (out[k] || []).concat(b.subjects.map((x) => x.code || "[" + (x.nonExam || "?") + "]"));
  }));
  return out;
}

const CSE_DATES = ["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-14", "2026-10-15"];
const AIDS_DATES = CSE_DATES;

// ---- CSE: three year columns, sections, one non-exam slot -------------------
ait("CSE: reads the printed metadata", async () => {
  const r = await read(path.join(CORPUS, "cse.pdf"));
  eq(r.meta.fields.academicYear, "2026-27");
  eq(r.meta.fields.term, "odd");
  eq(r.meta.fields.assessment, "continuous assessment test 2");
  eq(r.meta.fields.dateRange, { from: "2026-10-06", to: "2026-10-16" });
  eq(r.meta.fields.timeRange, "9:30 AM TO 12:30 PM");
  eq(r.meta.fields.sessionFromTime, "FN");
  ok(/Mother Theresa/.test(r.meta.fields.college || ""), "college line");
});
ait("CSE: finds the grid, the header and the orientation", async () => {
  const r = await read(path.join(CORPUS, "cse.pdf"));
  eq(r.tables.length, 1);
  const t = r.tables[0];
  eq(t.method, "ruled grid");
  eq(t.rows, 13);
  eq(t.cols, 4, "DATE + three year columns");
  ok(t.header, "a header band was found");
  ok(t.header.hits.indexOf("DATE") >= 0, "DATE is in the header: " + t.header.hits.join(","));
  eq(t.orient.mode, "years-across", "year labels sit across the header");
});
ait("CSE: gets every date, with no invented ones", async () => {
  const r = await read(path.join(CORPUS, "cse.pdf"));
  const got = [];
  r.tables[0].exams.forEach((b) => { if (got.indexOf(b.date) < 0) got.push(b.date); });
  eq(got.slice().sort(), CSE_DATES.slice().sort());
  // 16.10 is inside the printed range but no row exists for it: not invented.
  r.tables[0].exams.forEach((b) => ok(b.date <= "2026-10-16", b.date + " is inside the printed range"));
});
ait("CSE: reads all three years and the sections", async () => {
  const r = await read(path.join(CORPUS, "cse.pdf"));
  const t = r.tables[0];
  eq(t.sections.sections, ["A", "B"], "sections come from the header's (A & B)");
  eq(t.sections.needsConfirmation, false);
  const yrs = {};
  t.exams.forEach((b) => { yrs[b.year] = 1; });
  eq(Object.keys(yrs).sort(), ["2", "3", "4"]);
});
ait("CSE: puts each subject on the right date and year", async () => {
  const ix = index(await read(path.join(CORPUS, "cse.pdf")));
  eq(ix["2026-10-07/3"], ["CS3591"]);
  eq(ix["2026-10-07/4"], ["CME365"]);
  eq(ix["2026-10-08/2"], ["CS25C08"]);
  eq(ix["2026-10-09/3"], ["CS3501"]);
  eq(ix["2026-10-14/2"], ["MA25C08"]);
  eq(ix["2026-10-15/3"], ["CS3551"]);
});
ait("CSE: reads a code the printer split across two words", async () => {
  const ix = index(await read(path.join(CORPUS, "cse.pdf")));
  eq(ix["2026-10-14/3"], ["CB3491"], "printed as \"CB 3491-\"");
});
ait("CSE: reads the non-exam activity instead of inventing a subject", async () => {
  const ix = index(await read(path.join(CORPUS, "cse.pdf")));
  eq(ix["2026-10-09/4"], ["[NAAN MUDALVAN]"]);
});
ait("CSE: attaches each member of staff to the exam they teach", async () => {
  const r = await read(path.join(CORPUS, "cse.pdf"));
  const byKey = {};
  r.tables[0].exams.forEach((b) => { byKey[b.date + "/" + b.year] = b; });
  eq(byKey["2026-10-07/3"].staff, ["Mr. A. Michael & Mrs. S. Jeyam Jacquline"]);
  eq(byKey["2026-10-07/4"].staff, ["Dr. Faustina Adline & Dr. Vanthana & Dr. Karthikeyan"]);
  eq(byKey["2026-10-09/2"].staff, ["Mrs. S. Jeyam Jacquline & Ms. V. Pavitha"]);
  // The staff list must not be the whole sheet repeated on every row.
  const all = new Set();
  r.tables[0].exams.forEach((b) => b.staff.forEach((x) => all.add(x)));
  ok(all.size > 6, "different exams have different staff, got " + all.size + " distinct");
});
ait("CSE: resolves the department without being told the answer", async () => {
  const r = await read(path.join(CORPUS, "cse.pdf"));
  eq(r.tables[0].dept.department.code, "CSE");
  ok(r.tables[0].dept.route === "exact" || r.tables[0].dept.route === "fuzzy",
     "route was " + r.tables[0].dept.route);
});
ait("CSE: accounts for every cell it read", async () => {
  const r = await read(path.join(CORPUS, "cse.pdf"));
  eq(r.recon.leftovers.length, 0, "unaccounted: " + JSON.stringify(r.recon.leftovers));
  eq(r.recon.warnings.length, 0, "warnings: " + JSON.stringify(r.recon.warnings));
  eq(r.recon.summary.exams, 17);
});

// ---- AI&DS: two years, no sections, title-case names, one cell has no staff --
ait("AI&DS: reads the printed metadata", async () => {
  const r = await read(path.join(CORPUS, "ai-ds.pdf"));
  eq(r.meta.fields.academicYear, "2026-27");
  eq(r.meta.fields.term, "odd");
  eq(r.meta.fields.dateRange, { from: "2026-10-06", to: "2026-10-16" });
});
ait("AI&DS: finds two year columns, not three", async () => {
  const t = (await read(path.join(CORPUS, "ai-ds.pdf"))).tables[0];
  eq(t.method, "ruled grid");
  eq(t.cols, 3, "DATE + two year columns");
  eq(t.orient.mode, "years-across");
  const yrs = {};
  t.exams.forEach((b) => { yrs[b.year] = 1; });
  eq(Object.keys(yrs).sort(), ["2", "3"]);
});
ait("AI&DS: reports no sections because none are printed", async () => {
  const t = (await read(path.join(CORPUS, "ai-ds.pdf"))).tables[0];
  eq(t.sections.sections, [], "this sheet prints no section letters at all");
  eq(t.sections.printed, null);
});
ait("AI&DS: gets every date", async () => {
  const t = (await read(path.join(CORPUS, "ai-ds.pdf"))).tables[0];
  const got = [];
  t.exams.forEach((b) => { if (got.indexOf(b.date) < 0) got.push(b.date); });
  eq(got.slice().sort(), AIDS_DATES.slice().sort());
});
ait("AI&DS: puts each subject on the right date and year", async () => {
  const ix = index(await read(path.join(CORPUS, "ai-ds.pdf")));
  eq(ix["2026-10-06/3"], ["CS3551"]);
  eq(ix["2026-10-07/2"], ["CS25C09"]);
  eq(ix["2026-10-07/3"], ["CW3551"]);
  eq(ix["2026-10-08/2"], ["AD25C01"]);
  eq(ix["2026-10-08/3"], ["AD3501"]);
  eq(ix["2026-10-09/3"], ["CCS364"]);
  eq(ix["2026-10-14/3"], ["CCS334"]);
  eq(ix["2026-10-15/2"], ["MA25C08"]);
});
ait("AI&DS: keeps subject names in the case the sheet printed", async () => {
  const r = await read(path.join(CORPUS, "ai-ds.pdf"));
  let found = null;
  r.tables[0].exams.forEach((b) => b.subjects.forEach((x) => {
    if (x.code === "AD3501") found = x.name;
  }));
  eq(found, "Deep Learning", "title case is preserved, not upper-cased");
});
ait("AI&DS: reads a single member of staff where the sheet prints one", async () => {
  const r = await read(path.join(CORPUS, "ai-ds.pdf"));
  const byKey = {};
  r.tables[0].exams.forEach((b) => { byKey[b.date + "/" + b.year] = b; });
  eq(byKey["2026-10-06/3"].staff, ["Ms. V. Pavitha"]);
  eq(byKey["2026-10-08/2"].staff, ["Ms. T. Roselin Mary"]);
});
ait("AI&DS: flags the day with a non-exam activity and no staff", async () => {
  const r = await read(path.join(CORPUS, "ai-ds.pdf"));
  const b = r.tables[0].exams.filter((x) => x.date === "2026-10-06" && x.year === 2)[0];
  ok(b, "there is an entry for 06.10 year 2");
  eq(b.subjectCount, 0);
  eq(b.nonExamCount, 1);
  eq(b.ready, false, "a day with no subject is not silently marked ready");
  ok(b.reasons.length >= 2, "it says why: " + b.reasons.join("; "));
});
ait("AI&DS: accounts for every cell it read", async () => {
  const r = await read(path.join(CORPUS, "ai-ds.pdf"));
  eq(r.recon.leftovers.length, 0, "unaccounted: " + JSON.stringify(r.recon.leftovers));
  eq(r.recon.warnings.length, 0, "warnings: " + JSON.stringify(r.recon.warnings));
});

// ---- the reader must not depend on which sheet it is reading ---------------
ait("the two sheets are read by different geometry, not by sheet identity", async () => {
  const a = await read(path.join(CORPUS, "cse.pdf"));
  const b = await read(path.join(CORPUS, "ai-ds.pdf"));
  ok(a.tables[0].cols !== b.tables[0].cols, "3 year columns vs 2");
  ok(a.tables[0].exams.length !== b.tables[0].exams.length, "17 exams vs 12");
  ok(a.meta.fields.college === b.meta.fields.college, "same college, both read from the file");
});

module.exports = s;