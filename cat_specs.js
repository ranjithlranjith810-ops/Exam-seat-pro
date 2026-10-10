// Structural archetypes for CAT timetable testing.
//
// THESE ARE NOT REAL TIMETABLES. Nothing here is modelled on, copied from, or a
// guess at any real college sheet. Every value is either:
//   - a structural parameter (column count, year labels, row count), or
//   - a spec token defined by the importer's own contract
//     (I/II/III/IV, A/B sections, EXAM / EMPTY / NAAN MUDALVAN), or
//   - an obviously-synthetic placeholder that cannot be mistaken for real data
//     (ZZ### subject codes, SUBJECT ALPHA/BRAVO, STAFF ONE/TWO).
//
// The point is to exercise the PARSER's structure handling, not to guess at any
// department's real subjects, dates or codes. If you have a genuine CAT PDF,
// feed it to the importer directly - do not add it here.
const SAMPLE = {
  college: "SAMPLE COLLEGE",
  department: "DEPARTMENT OF SAMPLE",
  academicYear: "2024-2025",
  semesterLine: "SEM: III, V & VII",
  examTime: "10:00 AM - 01:00 PM",
  assessment: "CONTINUOUS ASSESSMENT TEST - III",
};

function exam(code, name, staff) {
  const c = { code, name: name || "" };
  if (staff) c.staff = staff;
  return c;
}
const EMPTY = { state: "EMPTY" };
const NAAN = { state: "NAAN MUDALVAN" };

module.exports = {
  SAMPLE,
  archetypes: [
    // ---- column-count coverage: the parser must handle 1..4 year columns ----
    {
      name: "cols1", expect: "ok", columns: [{ year: "II" }],
      rows: 6, cell: () => exam("ZZ101", "SUBJECT ALPHA"),
    },
    {
      name: "cols2", expect: "ok", columns: [{ year: "II" }, { year: "III" }],
      rows: 6, cell: (i, c) => exam("ZZ" + (101 + c), "SUBJECT " + ["ALPHA", "BRAVO", "CHARLIE", "DELTA", "ECHO", "FOXTROT"][i % 6]),
    },
    {
      name: "cols3", expect: "ok", columns: [{ year: "II" }, { year: "III" }, { year: "IV" }],
      rows: 6, cell: (i, c) => exam("ZZ" + (201 + c * 10 + i), "SUBJECT " + "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[i % 26]),
    },
    {
      name: "cols4", expect: "ok",
      columns: [{ year: "I" }, { year: "II" }, { year: "III" }, { year: "IV" }],
      rows: 5, cell: (i, c) => exam("ZZ" + (301 + c * 10 + i), "SUBJECT W" + c),
    },

    // ---- sectioned year header: must yield N exams, NOT 2N (spec 5/14) ----
    {
      name: "cols_sections", expect: "ok",
      columns: [{ year: "II", sections: ["A", "B"] }, { year: "III" }],
      rows: 6, cell: (i, c) => exam("ZZ" + (401 + c), "SUBJECT SEC" + c),
    },

    // ---- cell states: EXAM / EMPTY / NAAN (spec 8) ----
    {
      name: "cells_mixed", expect: "ok",
      columns: [{ year: "II" }, { year: "III" }],
      rows: 6,
      // column 0 rotates through the three legal states; column 1 always EXAM
      cell: (i, c) => (c === 0
        ? [exam("ZZ501", "SUBJECT MIX"), EMPTY, NAAN][i % 3]
        : exam("ZZ60" + (1 + i), "SUBJECT REF")),
    },

    // ---- subject name wrapping onto a second printed line (spec 11) ----
    {
      name: "cell_wrapped", expect: "ok",
      columns: [{ year: "II" }],
      rows: 5, wrapName: true,
      cell: (i) => exam("ZZ70" + (1 + i), "SUBJECT WITH A VERY LONG NAME THAT WRAPS ACROSS PRINTED LINES " + (i + 1)),
    },

    // ---- staff printed below a divider inside the cell (spec 9/12) ----
    {
      name: "cell_divider", expect: "ok", divider: "line",
      columns: [{ year: "II" }],
      rows: 5,
      cell: (i) => exam("ZZ80" + (1 + i), "SUBJECT DIV", ["STAFF ONE", "STAFF TWO"]),
    },
    {
      name: "cell_divider_gap", expect: "ok", divider: "gap",
      columns: [{ year: "II" }],
      rows: 5,
      cell: (i) => exam("ZZ90" + (1 + i), "SUBJECT GAP", ["STAFF ONE"]),
    },

    // ---- low render scale: must fall back to a higher scale (spec 31) ----
    { name: "low_dpi", expect: "ok", scale: 1.6, rowH: 22,
      columns: [{ year: "II" }, { year: "III" }],
      rows: 6, cell: (i, c) => exam("ZZ" + (c ? 12 : 11) + (0 + i), "SUBJECT LOW " + i) },

    // ---- negative fixture: must be REJECTED with zero exams, zero writes ----
    {
      name: "two_page", expect: "REJECT", rejectReason: "SINGLE_PAGE_ONLY",
      columns: [{ year: "II" }, { year: "III" }],
      pages: 2, rows: 4,
      cell: (i, c) => exam("ZZ" + (c ? 32 : 31) + (0 + i), "SUBJECT MULTI" + i),
    },
  ],
};