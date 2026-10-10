// Reads a PDF exactly the way the browser will, so tests and the app agree.
//
// The point of this module is that NOTHING about the file is supplied by hand.
// The caller gets words and rules out of pdf.js and hands them to cat_core.js,
// exactly as index.html will. If a test needs a special font hint or a special
// viewport, that is a bug in the reader, not something to patch here.
const fs = require("fs");
const P = require("pdfjs-dist/legacy/build/pdf.js");
const C = require("./cat_core.js");

const DEPARTMENTS = [
  { code: "CSE", name: "Computer Science and Engineering", aliases: ["CSE", "CS"] },
  { code: "AI&DS", name: "Artificial Intelligence and Data Science", aliases: ["AI&DS", "AIDS", "AI DS", "AI"] },
  { code: "ECE", name: "Electronics and Communication Engineering", aliases: ["ECE", "EC"] },
  { code: "MECH", name: "Mechanical Engineering", aliases: ["MECH", "ME"] },
  { code: "CIVIL", name: "Civil Engineering", aliases: ["CIVIL", "CE"] },
];

// A flat one-line rendering of an exam, for comparing whole sheets at once.
function examKey(b) {
  const parts = [b.date, b.year, b.session || ""];
  const subs = b.subjects.filter((x) => !x.nonExam)
    .map((x) => (x.code ? x.code : "~" + (x.name || ""))).sort();
  const non = b.subjects.filter((x) => x.nonExam).map((x) => x.nonExam).sort();
  const staff = (b.staff || []).slice().sort();
  return parts.concat([subs.join(","), staff.join("&"), "NE:" + non.join("&")]).join("|");
}

async function readPdf(file, options) {
  const o = options || {};
  const doc = await P.getDocument({
    data: new Uint8Array(fs.readFileSync(file)),
    verbosity: 0,
  }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const toReading = (x, y) => P.Util.applyTransform([x, y], vp.transform);
    const tc = await page.getTextContent();
    // The operator list has to be fetched before the font objects resolve, and only
    // then does pdf.js admit what "g_d0_f3" is (bold? oblique?).
    const ops = await page.getOperatorList();
    const fontStyleOf = (name) => {
      try { return page.commonObjs.get(name); } catch (e) { return null; }
    };
    pages.push({
      page: n,
      words: C.wordsFromPdfPage(page, {
        page: n, textItems: tc.items, matrixFn: toReading, fontStyleFn: fontStyleOf,
      }),
      rules: C.rulesFromOperators(ops, n,
        { x0: 0, x1: vp.width, top: 0, bottom: vp.height }, P.OPS, { toReading }),
      box: { x0: 0, x1: vp.width, top: 0, bottom: vp.height },
    });
  }
  return C.analyse(pages, {
    departments: o.departments || DEPARTMENTS,
    nonExam: o.nonExam,
    sessions: o.sessions,
  });
}

module.exports = { readPdf, DEPARTMENTS, examKey };