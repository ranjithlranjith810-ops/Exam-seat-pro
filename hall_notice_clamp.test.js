// Regression suite for the HALL NOTICE SEAT-SLOT CLAMP.
//
// Reported defect (read-only audit): hnNoticeLayout clamped the layout's
// per-bench slot count to 1..4, while the allocation engine (hallSeatInventory)
// supports 1..6. A hall declaring 5 or 6 seats per bench therefore rendered a
// narrower grid than the saved layout — empty high-numbered slots (5, 6) were
// never drawn, and a seat placed above slot 4 without a colIdx (legacy/hand-built
// rows) could be counted in TOTAL but omitted from the grid.
//
// These tests pin the fix: the renderer reads the DECLARED slot count up to 6
// (exactly as the allocator does) and the rendered grid agrees cell-for-cell with
// the saved plan — seat labels, department labels, occupied cells, empty cells
// and the TOTAL all match. Presentation only: nothing here touches allocation,
// seating plans, ownership or backup/restore.
const h = require("./harness.js");
const api = h.load();

const s = h.suite("hall_notice_clamp.test.js — renderer honours 1..6 slots per bench (matches the allocator)");
const { it, eq, ok } = s;

const FN = "2026-10-14";
const COLLEGE = { name: "Test College", centre_code: "TC01" };

// A hall whose layout declares the given per-column seat widths.
function hall(id, seatsArr, numbenches) {
  const columns = seatsArr.map(function (n) { return { seats: n }; });
  const perRow = seatsArr.reduce(function (a, b) { return a + b; }, 0);
  return {
    id: id, name: id.toUpperCase(), hallType: "University",
    numbenches: numbenches, studentsperbench: perRow,
    capacity: perRow * numbenches, layoutConfig: { columns: columns },
  };
}

// One saved seat row exactly as the engine writes it (benchNo = ci*nRows + ri + 1).
function seat(H, ci, ri, si, regno, dept) {
  const bench = ci * H.numbenches + ri + 1;
  const L = String.fromCharCode(65 + ci);
  return {
    regno: regno, name: "Student " + regno, dept: dept || "CSE",
    seatNo: H.id + "-B" + bench + "S" + si, seatLabel: L + (ri + 1) + "." + si,
    colIdx: ci, rowIdx: ri, slot: si, bench: bench,
  };
}

function render(H, seats) {
  const exams = [{ id: "e1", subject: "MERGED", date: FN, session: "FN", seatinggenerated: true }];
  const plans = { e1: { [H.id]: { hallName: H.name, numbenches: H.numbenches, studentsperbench: H.studentsperbench, capacity: H.capacity, layoutConfig: H.layoutConfig, seats: seats } } };
  return api.buildHallNoticesPrintDocument(
    { exams: exams, seatingPlans: plans, halls: [H], date: FN, session: "FN", hallId: H.id }, COLLEGE);
}

// Parse the rendered page into its occupied cells + empty-cell count + TOTAL.
function parse(page) {
  const occ = [];
  const re = /class="cell"><div class="seat">([^<]+)<\/div>[\s\S]*?class="lab">DEPT<\/div><div class="val">([^<]*)<\/div>/g;
  let m;
  while ((m = re.exec(page)) !== null) occ.push({ label: m[1], dept: m[2] });
  const empty = (page.match(/class="cell empty"/g) || []).length;
  const tm = page.match(/TOTAL:<\/strong> ([0-9]+)/);
  return { occ: occ, empty: empty, total: tm ? parseInt(tm[1], 10) : null };
}

function declaredCapacity(L) {
  return L.nRows * L.seats.reduce(function (a, b) { return a + b; }, 0);
}

// The set of "<seatLabel>|<dept>" a plan's seats represent.
function planPairs(seats) {
  return seats.map(function (r) { return (r.seatLabel || (String.fromCharCode(65 + r.colIdx) + (r.rowIdx + 1) + "." + r.slot)) + "|" + (r.dept || "GEN"); }).sort();
}
function gridPairs(occ) {
  return occ.map(function (c) { return c.label + "|" + c.dept; }).sort();
}

// ── C1/C2. declared 5- and 6-slot layouts render their full width ─────────────
it("C1: a 5-slot layout renders 5 slot-cells per bench (declared width honoured)", () => {
  const H = hall("h5", [5], 3);
  const rows = [];
  for (let ri = 0; ri < 3; ri++) for (let si = 1; si <= 5; si++) rows.push(seat(H, 0, ri, si, "A" + ri + "_" + si));
  const doc = render(H, rows);
  const L = api.hnNoticeLayout(doc.groups[0]);
  eq(L.seats, [5], "renderer reads the declared 5 slots per bench");
  const p = parse(doc.pages[0]);
  eq(p.occ.length, 15, "all 15 declared slots render (occupied)");
  eq(p.empty, 0, "a full 5-slot hall has no empty cells");
  eq(p.total, 15, "TOTAL equals the occupied cells");
  eq(declaredCapacity(L), 15, "grid width matches the declared capacity");
  eq(gridPairs(p.occ), planPairs(rows), "every seat label + dept agrees with the saved plan");
});

it("C2: a 6-slot layout renders 6 slot-cells per bench, including occupied slots 5 and 6", () => {
  const H = hall("h6", [6], 3);
  const rows = [];
  for (let ri = 0; ri < 3; ri++) for (let si = 1; si <= 6; si++) rows.push(seat(H, 0, ri, si, "B" + ri + "_" + si));
  const doc = render(H, rows);
  const L = api.hnNoticeLayout(doc.groups[0]);
  eq(L.seats, [6], "renderer reads the declared 6 slots per bench");
  const p = parse(doc.pages[0]);
  eq(p.occ.length, 18, "all 18 declared slots render (occupied)");
  eq(p.empty, 0, "a full 6-slot hall has no empty cells");
  eq(p.total, 18, "TOTAL equals the occupied cells");
  eq(gridPairs(p.occ), planPairs(rows), "seat labels + depts agree with the saved plan");
  ok(p.occ.some(function (c) { return c.label === "A1.5"; }) && p.occ.some(function (c) { return c.label === "A1.6"; }),
    "slots 5 and 6 of bench A1 are rendered");
});

// ── C3. empty high-numbered slots keep their place in the grid ────────────────
it("C3: empty high slots (5,6) are still drawn, so a 6-slot bench never renders 4-wide", () => {
  const H = hall("h6", [6], 3);
  // Only slots 1..4 of row 0 are occupied; slots 5 and 6 are empty.
  const rows = [seat(H, 0, 0, 1, "P1"), seat(H, 0, 0, 2, "P2"), seat(H, 0, 0, 3, "P3"), seat(H, 0, 0, 4, "P4")];
  const doc = render(H, rows);
  const L = api.hnNoticeLayout(doc.groups[0]);
  eq(L.seats, [6], "the declared width is 6 even though slots 5-6 are empty (the defect was 4)");
  const p = parse(doc.pages[0]);
  eq(p.occ.length, 4, "the 4 occupied seats render");
  eq(p.empty, 14, "the 14 declared empty slots render as empty cells");
  eq(p.occ.length + p.empty, declaredCapacity(L), "occupied + empty cells fill the whole declared grid");
  eq(declaredCapacity(L), 18, "the grid is 18 cells (3 rows x 6), not 12");
  eq(p.total, 4, "TOTAL counts only the occupied seats");
  eq(gridPairs(p.occ), planPairs(rows), "labels + depts agree with the saved plan");
});

// ── C4. occupied slots above 4 ────────────────────────────────────────────────
it("C4: seats occupying only slots 5 and 6 render at their exact positions", () => {
  const H = hall("h6", [6], 3);
  const rows = [seat(H, 0, 0, 5, "Q5"), seat(H, 0, 0, 6, "Q6")];
  const doc = render(H, rows);
  const L = api.hnNoticeLayout(doc.groups[0]);
  eq(L.seats, [6], "declared width is 6");
  const p = parse(doc.pages[0]);
  eq(p.occ.length, 2, "both high-slot seats render");
  eq(p.total, 2, "TOTAL equals the rendered occupied cells");
  eq(p.empty, 16, "the other 16 declared slots are empty");
  eq(p.occ.map(function (c) { return c.label; }).sort(), ["A1.5", "A1.6"], "rendered at slots 5 and 6 (not shifted)");
});

// ── C5. a slot above 4 WITHOUT colIdx is not omitted ──────────────────────────
it("C5: a saved seat above slot 4 without colIdx still appears on the grid (TOTAL === rendered cells)", () => {
  const H = hall("h6", [6], 3);
  const rows = [
    seat(H, 0, 0, 1, "S1"),                       // normal, with colIdx
    { regno: "S6", name: "Student S6", dept: "ECE", seatNo: "h6-B1S6", bench: 1, slot: 6 }, // legacy: slot 6, no colIdx
  ];
  const doc = render(H, rows);
  const L = api.hnNoticeLayout(doc.groups[0]);
  eq(L.seats, [6], "declared width is 6");
  const p = parse(doc.pages[0]);
  eq(p.occ.length, 2, "both students render (the colIdx-less high slot is not dropped)");
  eq(p.total, 2, "TOTAL equals the rendered occupied cells (no counted-but-missing seat)");
  ok(p.occ.some(function (c) { return c.dept === "ECE"; }), "the colIdx-less student's dept is printed");
});

// ── C6. mixed column widths [6,2] ─────────────────────────────────────────────
it("C6: a [6,2] mixed layout renders 6 and 2 slot-cells in their columns", () => {
  const H = hall("h62", [6, 2], 3);
  const rows = [seat(H, 0, 0, 1, "M1", "CSE"), seat(H, 1, 0, 1, "M2", "ECE")];
  const doc = render(H, rows);
  const L = api.hnNoticeLayout(doc.groups[0]);
  eq(L.seats, [6, 2], "each column keeps its own declared width");
  const p = parse(doc.pages[0]);
  eq(declaredCapacity(L), 24, "grid is 3 rows x (6+2) = 24 cells");
  eq(p.occ.length, 2, "both occupied seats render");
  eq(p.empty, 22, "22 empty cells complete the grid");
  eq(p.total, 2, "TOTAL equals the rendered occupied cells");
  eq(gridPairs(p.occ), planPairs(rows), "labels + depts agree with the saved plan");
});

// ── C7. exact agreement for an allocator-produced plan ────────────────────────
it("C7: an allocator-produced 6-slot plan renders with exact label/dept/cell/total agreement", () => {
  const H = hall("h6", [6], 3);
  const pool = [];
  for (let i = 0; i < 18; i++) pool.push({ id: "z" + i, regno: "Z" + String(1000 + i), name: "z" + i, dept: "CSE", year: 1, gender: "male" });
  const res = api.placeStudentsInHalls(pool, [H], 0, {}, {});
  const planSeats = res.plan.h6.seats;
  eq(res.unplaced.length, 0, "the allocator places all 18 students");
  eq(planSeats.length, 18, "18 seats saved");
  const doc = render(H, planSeats);
  const L = api.hnNoticeLayout(doc.groups[0]);
  eq(L.seats, [6], "declared width is 6");
  const p = parse(doc.pages[0]);
  eq(p.occ.length, planSeats.length, "occupied cells === saved seats");
  eq(p.total, planSeats.length, "TOTAL === saved seats");
  eq(p.occ.length + p.empty, declaredCapacity(L), "occupied + empty === declared capacity");
  eq(gridPairs(p.occ), planPairs(planSeats), "every saved seat label + dept appears exactly once on the grid");
  eq(new Set(p.occ.map(function (c) { return c.label; })).size, p.occ.length, "no seat label is rendered twice");
});

module.exports = s;
