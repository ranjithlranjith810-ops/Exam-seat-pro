// Regression suite for the HALL NOTICE LAYOUT (ROUND 6, ISSUE B).
//
// Reported defect: the Hall Notice PDF for LH-1 / 14-10-2026 / FN reads uneven —
// inconsistent column widths/row heights, cramped register numbers, weak seat
// dividers, a summary line where "subject-12" reads like an unexplained number,
// and no guarantee that a long register number cannot clip.
//
// These tests pin the layout invariants WITHOUT a browser: every assertion is
// against the rendered notice markup, the metrics the type-scale is derived
// from, or the shared stylesheet — the exact strings preview, print and PDF all
// consume (§28 same document). Visual pixel fidelity still needs a browser; this
// suite locks the guarantees the layout itself must never violate:
//   L1  hnNoticeMetrics / hnNoticeMetricsHalf prove no expected layout clips a
//       12-digit register number (fit scales down to fit the narrowest slot)
//   L2  the shared stylesheet carries the layout rules (even row heights via a
//       full-height table, even shading, per-block dividers, tabular-num digits,
//       aligned summary/total) for BOTH preview and the exported PDF
//   L3  empty cells stay structurally empty (no digits, no placeholders) and
//       occupied cells print exactly one saved regno + dept each
//   L4  the subject summary reads "<CODE> — N student(s)", never a bare number
//   L5  preview/print/PDF share one deterministic document
const h = require("./harness.js");
const api = h.load();

const s = h.suite("hall_notice_layout.test.js — layout invariants shared by preview, print and PDF");
const { it, eq, ok } = s;

const FN = "2026-10-14";
const COLLEGE = { name: "Test College", centre_code: "TC01" };

// LH-1 CAT hall: 3 benches of 3 seats, 5 rows, usable 45.
function lh1() {
  return {
    id: "lh1", name: "LH-1", hallType: "CAT", numbenches: 5, studentsperbench: 9, capacity: 45,
    layoutConfig: { columns: [{ seats: 3 }, { seats: 3 }, { seats: 3 }] },
  };
}

// One real occupied seat row exactly as the engine saves it (column-first bench
// numbering: benchNo = ci * nRows + ri + 1).
function seatRow(ci, ri, si, regno, subj) {
  const bench = ci * 5 + ri + 1;
  return {
    regno: regno, name: "Student " + regno, dept: "CSE", subj: subj,
    seatNo: "lh1-B" + bench + "S" + si, seatLabel: String.fromCharCode(65 + ci) + (ri + 1) + "." + si,
    colIdx: ci, rowIdx: ri, slot: si, bench: bench,
  };
}

// 45 occupied rows across the real LH-1 layout, 4 subjects (7/24/7/7 — the exact
// 14-10-2026 FN mix) so the summary line has real variety.
function fullRows() {
  const rows = [];
  const mix = [["MC101", 7], ["MECH24", 24], ["IT7", 7], ["ECE7", 7]];
  const subjects = [];
  mix.forEach(function (pair) { for (let i = 0; i < pair[1]; i++) subjects.push(pair[0]); });
  let k = 0;
  for (let ci = 0; ci < 3; ci++) for (let ri = 0; ri < 5; ri++) for (let si = 1; si <= 3; si++) {
    rows.push(seatRow(ci, ri, si, "953022104" + String(k + 1).padStart(3, "0"), subjects[k]));
    k++;
  }
  return rows;
}

function fullPlan() {
  return { e1: { lh1: { hallName: "LH-1", numbenches: 5, studentsperbench: 9, layoutConfig: { columns: [{ seats: 3 }, { seats: 3 }, { seats: 3 }] }, capacity: 45, seats: fullRows() } } };
}
function fullDoc() {
  const exams = [{ id: "e1", subject: "MERGED", date: FN, session: "FN", seatinggenerated: true }];
  return api.buildHallNoticesPrintDocument(
    { exams: exams, seatingPlans: fullPlan(), halls: [lh1()], date: FN, session: "FN", hallId: "lh1" }, COLLEGE);
}

// ── L1. type scale always fits a 12-digit register number ─────────────────────
it("L1: hnNoticeMetrics fits a 12-digit regno on the LH-1 3x3x5 layout and on the narrowest real layouts", () => {
  const lh1m = api.hnNoticeMetrics(5, 3, 3);
  ok(lh1m.scale > 0 && lh1m.scale <= 1, "scale is a sane fraction (got " + lh1m.scale + ")");
  eq(lh1m.fitOk, true, "LH-1's slot is wide enough for 12 digits at the chosen scale (textW=" + lh1m.textW + ", regnoPx=" + lh1m.regnoPx + ")");
  ok(lh1m.textW >= 60, "LH-1 leaves a real text runway per slot (got " + lh1m.textW + "px)");

  // Worst realistic case: 4 seats per bench across 3 columns.
  const tight = api.hnNoticeMetrics(5, 4, 3);
  eq(tight.fitOk, true, "4-abreast benches still fit 12 digits (scale " + tight.scale + ")");

  // Two-seat benches across a single column (the original LH-1 2-seat layout).
  const twin = api.hnNoticeMetrics(40, 2, 1);
  eq(twin.fitOk, true, "2-seat single-column layout fits with room to spare (textW " + twin.textW + ")");

  // The HALF-sheet metrics used by the FN+AN combined sheet fit the same way.
  const half = api.hnNoticeMetricsHalf(5, 3, 3);
  eq(half.fitOk, true, "half-sheet metrics also fit 12 digits (scale " + half.scale + ")");
});

// ── L2. shared stylesheet carries every layout rule used by preview AND PDF ───
it("L2: the shared stylesheet carries the layout rules for preview and the exported PDF", () => {
  const css = api.hnNoticeStylesheet();
  ok(css.indexOf("table-layout:fixed") >= 0, "fixed table layout keeps column widths identical");
  ok(css.indexOf(".pf-table{width:100%;height:100%") >= 0, "the table fills its wrap so every row is even-height");
  ok(css.indexOf(".pf-tablewrap{flex:1 1 auto") >= 0, "the grid owns the free sheet height");
  ok(css.indexOf(".pf-table tbody tr:nth-child(even)") >= 0, "alternate rows are shaded so a bench line is easy to follow");
  ok(css.indexOf(".slotcell:last-child .cell{border-right:none;}") >= 0, "the bench-internal divider is suppressed only on the rightmost slot");
  ok(css.indexOf("border-bottom:1px dotted #94a3b8") >= 0, "every seat label has its own dotted divider beneath it");
  ok(css.indexOf("font-variant-numeric:tabular-nums") >= 0, "register numbers use tabular figures (no jitter in a column)");
  ok(css.indexOf(".pf-subjects{") >= 0 && /\.pf-subjects\{[^}]*flex:1 1 auto/.test(css), "SUBJECT SUMMARY owns the free width");
  ok(css.indexOf("border-left:1px solid #000;padding-left:10px;white-space:nowrap") >= 0, "TOTAL is pinned right of the same ruling");
  ok(css.indexOf(".cell.empty{min-height:0;}") >= 0, "unoccupied cells stay structurally empty");
  ok(css.indexOf("@page{size:A4 portrait;margin:0;}") >= 0, "print media rules fit the fixes A4 box");
});

// ── L3. empty cells print NOTHING; occupied cells print saved data once ───────
it("L3: on the LH-1 notice, empty seats print no digits and each occupied cell prints its saved regno + dept", () => {
  const page = fullDoc().pages[0];
  eq((page.match(/<div class="cell">/g) || []).length, 45, "exactly one occupied cell per surviving student");
  eq((page.match(/class="cell empty"/g) || []).length, 0, "a full hall has no empty cells");
  const vals = page.match(/<div class="val">([^<]*)<\/div>/g) || [];
  eq(vals.length, 90, "regno + dept for each of the 45 occupied cells");
  // A real register number is a full-length (9-12 char) code with digits and
  // letters; a placeholder is a SHORT bare integer like "1" or "12". Only the
  // short bare number is prohibited.
  ok(vals.every(function (v) { return !/^<div class="val">\d{1,3}<\/div>$/.test(v); }),
    "no cell value is a short bare-number placeholder");
  ok(page.indexOf("953022104001") >= 0 && page.indexOf("953022104045") >= 0, "saved register numbers are rendered verbatim");
  // An empty-slot fixture (reuse the 38/45 pool from hall_utilization R1's shape):
  // 38 occupied + 7 structurally-empty cells, and nothing printed inside the empties.
  const partial = [];
  for (let i = 0; i < 38; i++) {
    partial.push(seatRow(Math.floor(i / 15), i % 5, (i % 3) + 1, "9530" + String(i + 1).padStart(5, "0"), "SUB" + (i % 2)));
  }
  const exams = [{ id: "e1", subject: "P", date: FN, session: "FN", seatinggenerated: true }];
  const doc = api.buildHallNoticesPrintDocument(
    { exams: exams, seatingPlans: { e1: { lh1: { hallName: "LH-1", numbenches: 5, studentsperbench: 9, layoutConfig: { columns: [{ seats: 3 }, { seats: 3 }, { seats: 3 }] }, capacity: 45, seats: partial } } }, halls: [lh1()], date: FN, session: "FN", hallId: "lh1" }, COLLEGE);
  const p2 = doc.pages[0];
  eq((p2.match(/<div class="cell">/g) || []).length, 38, "38 occupied cells when 38 students are seated");
  eq((p2.match(/class="cell empty"/g) || []).length, 7, "the other 7 physical seats are structurally empty cells");
  const empties = p2.match(/class="cell empty"[^>]*>([^<]*)<\/div>/g) || [];
  ok(empties.every(function (e) { return !/\d/.test(e); }), "no empty cell carries any digit/placeholder");
});

// ── L4. the subject summary reads "<CODE> — N student(s)" and still sums to TOTAL ┐
it("L4: the multi-subject summary reads '<CODE> — N students' (never a bare number) and sums to TOTAL", () => {
  // The real 14-10-2026 FN LH-1 allocation: FOUR exams share the hall on disjoint
  // seats (7 / 24 / 7 / 7). The summary is aggregated per EXAM subject, so the
  // parsed screen must never show a mysterious "CS25C08-7" style fragment.
  const codes = [["CS25C08", 7], ["GE3791", 24], ["MA25C04", 7], ["CEC341", 7]];
  const rows = fullRows();
  const exams = [], plans = {};
  let start = 0;
  codes.forEach(function (pair) {
    const id = "e_" + pair[0];
    exams.push({ id: id, subject: pair[0] + " - SUBJECT", date: FN, session: "FN", seatinggenerated: true });
    plans[id] = { lh1: { hallName: "LH-1", numbenches: 5, studentsperbench: 9, capacity: 45,
      layoutConfig: { columns: [{ seats: 3 }, { seats: 3 }, { seats: 3 }] },
      seats: rows.slice(start, start + pair[1]) } };
    start += pair[1];
  });
  const doc = api.buildHallNoticesPrintDocument({ exams: exams, seatingPlans: plans, halls: [lh1()], date: FN, session: "FN", hallId: "lh1" }, COLLEGE);
  const page = doc.pages[0];
  ok(/SUBJECT SUMMARY/.test(page), "summary header present");
  ok(/CS25C08 — 7 students/.test(page), "a code reads as '<CODE> — N students' (got: " + (page.match(/<div class="pf-subjects">.*?<\/div>/) || [""])[0] + ")");
  ok(/GE3791 — 24 students/.test(page), "the largest subject reads with its explicit count");
  ok(!/CS25C08-7/.test(page), "no trimmed 'code-N' fragment survives");
  // Every '— N student(s)' unit must sum to TOTAL.
  const counts = [];
  page.replace(/— (\d+) student/g, function (_, n) { counts.push(parseInt(n, 10)); return ""; });
  eq(counts.reduce(function (a, b) { return a + b; }, 0), 45, "subject counts add up to TOTAL 45");
  ok(/TOTAL:<\/strong> 45/.test(page), "TOTAL format is preserved");
});

// ── L5. preview, print and PDF share ONE deterministic document ───────────────
it("L5: same options rebuild a byte-identical notice document (preview == print == PDF source)", () => {
  const a = fullDoc();
  const b = fullDoc();
  eq(a.pages, b.pages, "pages are byte-identical");
  eq(a.css, b.css, "stylesheet is byte-identical");
  eq(a.notices[0].rows, 45, "the notice's own seat count is 45");
  eq(a.groups.length, 1, "one (date, session, hall) group");
  eq(a.groups[0].total, 45, "group total is the surviving seat set");
  const HT = api.hnNoticeLayout(a.groups[0]);
  eq(HT.nCols, 3, "layout reads its 3 columns from the saved config");
  eq(HT.nRows, 5, "layout reads its 5 rows from the saved config");
  eq(HT.seats, [3, 3, 3], "no physical seat is dropped from the grid");
});

module.exports = s;