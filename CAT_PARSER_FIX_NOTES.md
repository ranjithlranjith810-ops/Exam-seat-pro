# CAT timetable PDF parser — root cause of each reported problem

Sheet used for verification: `fixtures/CAT-II_Timetable_CSE_2026-27_Digital.pdf`
(single page, real text layer, drawn cell borders).

**Result:** 15 exams, 2 `NAAN MUDALVAN` cells reported and ignored, 1 blank cell
skipped, 0 blocked rows, 0 date errors, staff on every exam.

---

## The one underlying cause

The old reader never looked at the page. It read the text layer, grouped items by
a **rounded `y`** value into "lines", and then guessed where the columns were from
where each line happened to start.

A printed timetable is not a list of lines. It is a **grid of rectangles**: every
cell has a border, a date cell is *merged* across two printed rows, a subject name
wraps onto a second line inside one cell, and the faculty name sits in the cell
below it. Rounding `y` to 4pt throws all of that away, so every symptom below is a
different way the same mistake showed up.

**Fix:** the drawn borders are now the source of truth. `catPageRulingLines` walks
pdf.js's operator list and keeps only *stroked* lines (the logo is filled, so it
never matches); `catGridFromRules` snaps them into a column/band grid;
`catTableFromGrid` reads each cell from its rectangle. The old line reader is kept
unchanged as the fallback for a sheet that draws no borders at all.

---

## 1. Preview listed 22 exams instead of 15

**Cause.** Row groups were counted by *text line*, not by cell. The sheet prints
**two lines per date** — subject line, faculty line — so 6 dates × 3 year columns
× 2 lines produced ~22 "rows". The header block above the table (`ACADEMIC YEAR
2026-27`, `ODD SEMESTER`, `TIME 9:30 AM TO 12:30 PM`) was also just more lines, and
became data.

**Fix.** A row group now starts where a **new date is printed** and ends where that
date's own cell stops, so the two printed lines of one date are one group. The
header band is located (the band whose first cell says `DATE` beside at least one
printed year marker) and is read for its labels only — it is never emitted.

## 2. Only 11 rows were "ready"; the rest blocked on `SUBJECT CODE NOT EXTRACTED`

**Cause.** Column buckets were built from the `x` of the first **year marker** on
each line, but cell content starts *left* of that marker (the year header is
centred, the subject text is not). Every cell then landed in its neighbour's bucket
or straddled two, so the code prefix was cut off or the subject text was pulled into
the wrong column.

**Fix.** Column boundaries are the **vertical ruling lines**, snapped to the nearest
observed text edge. Cells are read strictly inside their own rectangle, so a code can
no longer be cut in half by a guessed boundary.

## 3. Wrong exam dates (e.g. `2026-10-04`)

**Cause.** The date came from "whatever row number we are on", falling back to the
current date when a line held no parseable date. The line `TIME 9:30 AM TO 12:30 PM`
was being mined for a date, and `9:30` became `04`.

**Fix.** The date is read from the **merged date cell**, which physically spans both
printed rows of its date — so a date is attached to the cell that is inside its own
borders, and a row with no printed date can no longer inherit one. Every date is
validated as a real calendar date and converted to ISO.

## 4. Subject names truncated where they wrapped (`PRINCIPLES OF`)

**Cause.** A wrapped name is two text lines, and each became its own row. The second
line (`MANAGEMENT`) had no code, so it was dropped as a code-less fragment, and the
first line was kept as if it were the whole name.

**Fix.** Both lines are inside one cell rectangle, so both are collected and joined in
reading order. `CB 3491` and `CS 3551` are printed with a space by the printer; that
space is removed and **nothing else** is changed — codes and names are otherwise
exactly as printed, never substituted from the Subject Master.

## 5. No staff names on any exam

**Cause.** The text path (`catTextRowsForPage`) returns rows only, and `row.staff`
was **only ever set by the OCR path**. A text-layer PDF therefore had no faculty
line to read, and the preview showed none. Staff were also unreachable because
honorifics were stripped and the sheet prints them.

**Fix.** The faculty cell is the **second ruled cell of the date group**, below the
subject cell — identified by the horizontal rule between them, not by guessing a gap
in the text. Honorifics are now preserved (`Mrs.C. Durga Janani` is shown exactly as
printed, including the missing space). Staff are displayed in the preview and are
still never written to the saved exam record.

## 6. `NAAN MUDALVAN` reported as an invalid subject

**Cause.** A merged cell spanning both printed rows was read as *one cell with text
below the subject*, so the subject became `NAAN` and the rest was discarded. There
was no merged-cell concept at all, so the one thing that identifies a non-exam cell
was invisible.

**Fix.** A cell whose horizontal rule is **missing** across the group is recognised
as merged and its whole text is kept as one block, which is then classified as a
non-exam activity. It is reported in the preview as `IGNORED — NON-EXAM ACTIVITY`
and is never validated as an exam.

## 7. Department not resolved / header text appearing as data rows

**Cause.** Two separate problems. The header lines were parsed as table rows
(see 1). The department was resolved by asking the PDF for a code; this sheet prints
only the department **name**, so the lookup failed.

**Fix.** Header/meta lines are excluded by construction — only text inside a ruled
cell below the header band is ever read. The department **name** is taken from the
PDF and the **code** is read back from the existing master record (CSE → `104`); the
code is never taken from the document. If the name cannot be matched, the preview
still renders and the row is blocked with a reason instead of the import dying.

---

## Two latent bugs found while fixing this

Both were silent — no error, just wrong output — and both would have made the new
reader look broken for reasons unrelated to it:

- **`page.getViewport()` returns an object, not an array.** Reading the page box as
  `view[0]…view[3]` produced `[0,0,0,0]`, which made every ruling line look like it
  was "outside the page" and silently produced an empty grid. `catPageBox` now
  accepts all three shapes pdf.js exposes.
- **`\s` matches newlines.** In `SEM: III, V & VII`, the pattern
  `SEM(?:ESTER)?\s*[.:-]?\s*(...)` matched `SEMESTER` on the *previous* line, then let
  `\s*` cross the line break and captured `C` from `CONTINUOUS`. Semester detection
  silently returned nothing. All SEM patterns now stay on one line (`[ \t]*`).

A third problem was a plain typo that left the entire app script block syntactically
invalid — `CAT_CODE_RE` was missing its closing `/`, so **nothing** in the CAT block
parsed. Found with `cat_parse_check.js`.

---

## Also changed

- **Semester per column** comes from the printed `SEM: III, V & VII` list, matched to
  the year columns **left to right** (the only place the pairing is actually
  printed). Without it, `catSemForYear`'s odd/even rule applies as before.
- **Date range check.** The sheet's own title publishes its window
  (`06.10.2026 TO 16.10.2026`). A date outside it is surfaced as a
  `DATE OUTSIDE PUBLISHED RANGE` **warning** — never rewritten and never dropped,
  because a rescheduled exam is the administrator's judgement.
- **Nothing is saved before confirmation.** Unchanged: the preview renders first, and
  only the *Confirm Import* button calls the save path.

## Running the tests

```powershell
$env:NODE_PATH="C:\Temp\catdeps\node_modules"
node cat_parse_check.js index.html   # syntax gate for the app script block
node run.js                          # 147 tests, 0 failures
```

`cat_table_pdf.test.js` is the real-PDF suite: it opens the actual sheet, runs the
same code the browser runs, and asserts the exact 15 exams — code, name, year,
semester, sections and staff — plus the two ignored cells, the skipped blank, and a
preview of 15 ready / 0 blocked. `cat_pipeline.test.js` still covers the synthetic
and borderless shapes through the fallback reader.