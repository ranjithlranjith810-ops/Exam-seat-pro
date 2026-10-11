// Regression suite for SEATING PLANS GRID / SUMMARY CONSISTENCY (ROUND 6, ISSUE B).
//
// Reported defect (LH-10, 14-10-2026 FN, Seating Plans page): the per-hall
// summary shows 45 students while the Hall View grid renders only 25 occupied
// cells. The Global Notice correctly shows 45.
//
// Root cause: two hall records share the name "LH-10" — a University copy with a
// 25-seat layout ([2,1,2] x 5) and a CAT copy with a 45-seat layout ([3,3,3] x 5).
// All saved plans are generated against the 45-seat record, but resolveHall's
// same-name snap chose the FIRST record carrying a layout, which was the 25-seat
// record. The summary then counted every saved row (45) while the Hall View built
// its physical grid from the 25-seat record and could only paint the seats that
// happened to land on that smaller grid (25).
//
// The fix makes the shared canonical-record rule pick the record whose PHYSICAL
// INVENTORY is the LARGEST among same-name records (a real hall is the biggest
// grid its plans fill; smaller copies are truncated/stale). One rule in resolveHall
// (used by the summary, the grid, conflict detection and notices) plus hallNoticeOptions.
//
// This suite pins that contract, plus the surviving legacy collapse rules.
const h = require("./harness.js");
const api = h.load();

const s = h.suite("seating_grid_consistency.test.js — conflicting same-name hall records resolve to the largest physical layout");
const { it, eq, ok, ait } = s;

const ALPHA = "ABCDEFGHIJ";

// Two records for ONE physical "LH-10": the 25-seat University copy FIRST in the
// array (the old snap chose THIS one and broke the grid), the 45-seat CAT copy
// after it. Plans are written under the 45-seat record's id, exactly like the
// real dataset.
function conflictHalls() {
  const low = { id: "LH10LOW", name: "LH-10", hallType: "University", numbenches: 5, studentsperbench: 5, capacity: 25, layoutConfig: { columns: [{ seats: 2 }, { seats: 1 }, { seats: 2 }] } };
  const high = { id: "LH10HIGH", name: "LH-10", hallType: "CAT", numbenches: 5, studentsperbench: 9, capacity: 45, layoutConfig: { columns: [{ seats: 3 }, { seats: 3 }, { seats: 3 }] } };
  return [low, high];
}

// Identical-layout duplicates (the per-department import case): two records with
// the SAME 45-seat layout. The old rule kept the first; the new rule must too (tie).
function twinHalls() {
  const a = { id: "TWIN_A", name: "TW-1", hallType: "CAT", numbenches: 5, studentsperbench: 9, capacity: 45, layoutConfig: { columns: [{ seats: 3 }, { seats: 3 }, { seats: 3 }] } };
  const b = { id: "TWIN_B", name: "TW-1", hallType: "CAT", numbenches: 5, studentsperbench: 9, capacity: 45, layoutConfig: { columns: [{ seats: 3 }, { seats: 3 }, { seats: 3 }] } };
  return [a, b];
}

// One real (45-seat) record plus a layout-less booking stub with the same name.
function stubHalls() {
  const real = { id: "ST_REAL", name: "ST-1", hallType: "CAT", numbenches: 5, studentsperbench: 9, capacity: 45, layoutConfig: { columns: [{ seats: 3 }, { seats: 3 }, { seats: 3 }] } };
  const stub = { id: "ST_STUB", name: "ST 1", hallType: "University" };
  return [stub, real];
}

// A saved seat on the [3,3,3] 5-row grid — the exact shape the allocator writes.
function seat(regno, ci, ri, si, hid) {
  const bench = ci * 5 + ri + 1;
  return {
    regno: regno, colIdx: ci, rowIdx: ri, slot: si, bench: bench,
    seatNo: hid + "-B" + bench + "S" + si,
    seatLabel: ALPHA[ci] + (ri + 1) + "." + si,
  };
}

// Every (ci, ri, si) triple on the 45 grid, in column-first/slot-major order.
function all45(hid) {
  const rows = [];
  for (let ci = 0; ci < 3; ci++) for (let si = 1; si <= 3; si++) for (let ri = 0; ri < 5; ri++)
    rows.push([ci, ri, si]);
  return rows;
}

function exam(id, subject, date, session) { return { id: id, subject: subject, date: date, session: session }; }
function examWith(id, subject, date, session, hallids) { const e = exam(id, subject, date, session); if (hallids) e.hallids = hallids; return e; }

// Hall View overlay — replicates buildPhysicalHall's seat-identity matching so the
// test asserts the SAME mechanism the grid uses: every saved seat lands on exactly
// one physical cell of the resolved canonical record's inventory.
function overlayOccupied(halls, canonicalId, mergedSeats) {
  const hall = halls.find(function (x) { return x.id === canonicalId; });
  const inv = api.hallSeatInventory(hall);
  const phys = [];
  inv.columns.forEach(function (c, ci) {
    for (let si = 1; si <= c.seats; si++) for (let ri = 0; ri < inv.nRows; ri++) {
      const bench = ci * inv.nRows + ri + 1;
      phys.push({ seatNo: hall.id + "-B" + bench + "S" + si, seatLabel: ALPHA[ci] + (ri + 1) + "." + si, cr: "cr" + ci + ":" + ri + ":" + si, bs: "B" + bench + "S" + si, regno: null });
    }
  });
  const bySlot = {};
  phys.forEach(function (p) { [p.seatNo, p.cr, p.bs, p.seatLabel].forEach(function (k) { if (!bySlot[k]) bySlot[k] = p; }); });
  let filled = 0;
  mergedSeats.forEach(function (seatRow) {
    let target = null;
    api.hnSeatKeys(seatRow).forEach(function (k) { if (!target && bySlot[k]) target = bySlot[k]; });
    if (!target || target.regno) return;
    target.regno = seatRow.regno;
    filled++;
  });
  return { filled: filled, cells: phys.length };
}

// ── S1: resolveHall picks the LARGEST layout among conflicting same-name records ─
it("S1 resolveHall returns the 45-seat record when a 25-seat copy is FIRST in the array (keyed by id)", () => {
  const halls = conflictHalls();
  const r = api.resolveHall(halls, "LH10HIGH", { hallName: "LH-10" });
  eq(r.id, "LH10HIGH");
  eq(api.hallPhysicalCapacity(r), 45);
});

it("S1b resolveHall returns the same 45-seat record when the plan is keyed by the SMALLER record id", () => {
  const r = api.resolveHall(conflictHalls(), "LH10LOW", { hallName: "LH-10" });
  eq(r.id, "LH10HIGH", "canonical id does not move with the alias key");
});

it("S1c resolveHall returns the 45-seat record when the plan is keyed by the display NAME only", () => {
  const r = api.resolveHall(conflictHalls(), "lh-10", {});
  eq(r.id, "LH10HIGH");
});

it("S1d canonicalHallId collapses both alias ids and the name to the same canonical id", () => {
  const halls = conflictHalls();
  eq(api.canonicalHallId(halls, "LH10LOW", {}), "LH10HIGH");
  eq(api.canonicalHallId(halls, "LH10HIGH", {}), "LH10HIGH");
  eq(api.canonicalHallId(halls, "LH-10", {}), "LH10HIGH");
});

// ── S2: legacy collapse rules survive ───────────────────────────────────────────
it("S2a a layout-bearing record beats a layout-less stub of the same name", () => {
  const r = api.resolveHall(stubHalls(), "ST_STUB", { hallName: "ST-1" });
  eq(r.id, "ST_REAL");
});

it("S2b no sibling has a layout → the FIRST record of the name is canonical", () => {
  const halls = [{ id: "c", name: "NC-1" }, { id: "d", name: "NC 1" }];
  eq(api.resolveHall(halls, "c", { hallName: "NC-1" }).id, "c");
});

it("S2c identical-layout duplicates stay on the FIRST record (tie unchanged)", () => {
  const r = api.resolveHall(twinHalls(), "TWIN_B", {});
  eq(r.id, "TWIN_A", "first-in-array wins the tie, preserving prior behaviour");
});

it("S2d exact id is preferred before an exact name", () => {
  const halls = [{ id: "alpha", name: "One" }, { id: "beta", name: "Two" }];
  eq(api.resolveHall(halls, "beta", {}).id, "beta");
  eq(api.resolveHall(halls, "nope", { hallName: "One" }).id, "alpha");
});

// ── S3/S4/S5: summary, merged seats and rendered grid agree at 45 ──────────────
it("S3+S4 the merged summary counts all co-seated rows (45) even with the conflicting pair present", () => {
  const halls = conflictHalls();
  const plans = {
    e1: { LH10HIGH: { hallName: "LH-10", seats: all45("LH10HIGH").slice(0, 12).map(function (t, i) { return seat("R" + (100 + i), t[0], t[1], t[2], "LH10HIGH"); }) } },
    e2: { LH10HIGH: { hallName: "LH-10", seats: all45("LH10HIGH").slice(12).map(function (t, i) { return seat("R" + (200 + i), t[0], t[1], t[2], "LH10HIGH"); }) } },
  };
  const exams = [exam("e1", "A", "2026-10-14", "FN"), exam("e2", "B", "2026-10-14", "FN")];
  const merged = api.hallMergedUniqueSeats(exams, plans, halls, "LH10HIGH", "2026-10-14", "FN");
  eq(merged.length, 45, "the summary (merged) keeps its 45 — the fix must not change it");
});

it("S5 every one of the 45 merged seats lands on a physical cell of the resolved 45-seat layout — no orphans, grid == summary", () => {
  const halls = conflictHalls();
  const plans = {
    e1: { LH10HIGH: { hallName: "LH-10", seats: all45("LH10HIGH").slice(0, 12).map(function (t, i) { return seat("R" + (100 + i), t[0], t[1], t[2], "LH10HIGH"); }) } },
    e2: { LH10HIGH: { hallName: "LH-10", seats: all45("LH10HIGH").slice(12).map(function (t, i) { return seat("R" + (200 + i), t[0], t[1], t[2], "LH10HIGH"); }) } },
  };
  const exams = [exam("e1", "A", "2026-10-14", "FN"), exam("e2", "B", "2026-10-14", "FN")];
  const canon = api.resolveHall(halls, "LH10LOW", { hallName: "LH-10" });
  const merged = api.hallMergedUniqueSeats(exams, plans, halls, canon.id, "2026-10-14", "FN");
  const ov = overlayOccupied(halls, canon.id, merged);
  eq(ov.cells, 45, "the Hall View grid holds every physical seat of the resolved record");
  eq(ov.filled, merged.length, "rendered occupied cells == merged summary (45 == 45)");
});

it("S5b the OLD (broken) 25-seat grid would have dropped 20 seats — the invariant this suite removes", () => {
  const halls = conflictHalls();
  const plans = {
    e1: { LH10HIGH: { hallName: "LH-10", seats: all45("LH10HIGH").slice(0, 12).map(function (t, i) { return seat("R" + (100 + i), t[0], t[1], t[2], "LH10HIGH"); }) } },
    e2: { LH10HIGH: { hallName: "LH-10", seats: all45("LH10HIGH").slice(12).map(function (t, i) { return seat("R" + (200 + i), t[0], t[1], t[2], "LH10HIGH"); }) } },
  };
  const exams = [exam("e1", "A", "2026-10-14", "FN"), exam("e2", "B", "2026-10-14", "FN")];
  const merged = api.hallMergedUniqueSeats(exams, plans, halls, "LH10HIGH", "2026-10-14", "FN");
  const low = overlayOccupied(halls, "LH10LOW", merged);
  ok(low.filled < merged.length, "rendering on the truncated 25-seat copy under-paints (this is the reported defect)");
  eq(low.cells, 25);
});

// ── S6: the Hall Notice dropdown resolves to the same canonical record ─────────
it("S6 hallNoticeOptions addresses the largest-layout record and keeps the full 45 count", () => {
  const halls = conflictHalls();
  const opt = api.hallNoticeOptions(halls, { LH10HIGH: { hallId: "LH10HIGH", hallName: "LH-10", seats: new Array(45).fill({ regno: "x" }) } }, {});
  eq(opt.length, 1);
  eq(opt[0].id, "LH10HIGH", "dropdown canonical id is the 45-seat record");
  eq(opt[0].count, 45, "dropdown count aggregates the full co-seated set");
});

it("S6b hallOptionSeats returns the surviving rows for the canonical option", () => {
  const halls = conflictHalls();
  const seats = new Array(4).fill({ regno: "R100" });
  const opt = api.hallNoticeOptions(halls, { LH10HIGH: { hallId: "LH10HIGH", hallName: "LH-10", seats: seats } }, {});
  eq(api.hallOptionSeats({ LH10HIGH: { hallId: "LH10HIGH", hallName: "LH-10", seats: seats } }, opt[0]).length, 4);
});

// ── S7: name-keyed plans and reservation data agree with the id-keyed ones ──────
ait("S7 examReservationData marks the canonical (45) hall id busy, not the truncated copy", () => {
  const halls = conflictHalls();
  const plans = {
    other: { LH10HIGH: { hallName: "LH-10", seats: [seat("R1", 0, 0, 1, "LH10HIGH")] } },
  };
  // The other exam reserves the hall via the ALIAS (25-seat copy) id — the busy
  // set must still land on the canonical 45-seat record.
  const other = examWith("other", "A", "2026-10-14", "FN", ["LH10LOW"]);
  const exams = [other, examWith("me", "B", "2026-10-14", "FN", [])];
  return api.examReservationData(exams[1], exams, halls, plans, null).then(function (res) {
    eq(res.error, null);
    eq(res.busyHallIds.has("LH10HIGH"), true, "canonical 45-seat id is the busy hall");
    eq(res.busyHallIds.has("LH10LOW"), false, "the truncated copy is NOT a separate busy hall");
    ok(res.hallUsedSeats["LH10HIGH"] && res.hallUsedSeats["LH10HIGH"].size > 0, "occupied seats are tracked on the canonical record");
  });
});

// ── S8: integrity warning surfaces a genuine orphan set, stays silent when clean ─
it("S8 seatingGridIntegrityText stays NULL when the grid rendered every saved seat", () => {
  eq(api.seatingGridIntegrityText(45, 45), null);
  eq(api.seatingGridIntegrityText(45, 50), null, "more cells than students is healthy (sparse hall)");
  eq(api.seatingGridIntegrityText(null, 0), null);
  eq(api.seatingGridIntegrityText(0, 0), null);
});

it("S8b seatingGridIntegrityText reports a real under-paint (25 rendered vs 45 saved)", () => {
  const t = api.seatingGridIntegrityText(45, 25);
  ok(t !== null && t.indexOf("45") >= 0 && t.indexOf("25") >= 0, "warning names both counts");
});

// ── S9/S10: real-dataset shape via the harness (no backup file dependency) ─────
it("S9 a plan generated on the 45 grid but keyed under the 25-seat record id still canonicalizes to the 45 record", () => {
  const halls = conflictHalls();
  const hp = { hallName: "LH-10", seats: [seat("R1", 2, 4, 3, "LH10HIGH")] };
  const canon = api.resolveHall(halls, "LH10LOW", hp);
  eq(canon.id, "LH10HIGH");
  const merged = api.hallMergedUniqueSeats([exam("e", "A", "2026-10-14", "FN")], { e: { LH10LOW: hp } }, halls, canon.id, "2026-10-14", "FN");
  eq(merged.length, 1);
  const ov = overlayOccupied(halls, canon.id, merged);
  eq(ov.filled, 1, "the C-last seat of a 45-layout plan lands on the 45 grid");
});

it("S10 hallNoticePerHall groups the co-seated rows under the canonical 45 id", () => {
  const halls = conflictHalls();
  const plans = {
    e1: { LH10HIGH: { hallName: "LH-10", seats: all45("LH10HIGH").slice(0, 12).map(function (t, i) { return seat("R" + (100 + i), t[0], t[1], t[2], "LH10HIGH"); }) } },
    e2: { LH10HIGH: { hallName: "LH-10", seats: all45("LH10HIGH").slice(12).map(function (t, i) { return seat("R" + (200 + i), t[0], t[1], t[2], "LH10HIGH"); }) } },
  };
  const exams = [exam("e1", "A", "2026-10-14", "FN"), exam("e2", "B", "2026-10-14", "FN")];
  const ph = api.hallNoticePerHall(exams, plans, halls, "2026-10-14", "FN");
  ok(ph.perHall["LH10HIGH"] && ph.perHall["LH10HIGH"].seats.length === 45, "grouped under the canonical 45 id");
  eq(ph.hallDates["LH10HIGH"], { "2026-10-14": true });
});

module.exports = s;