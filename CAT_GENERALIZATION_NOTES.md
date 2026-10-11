# CAT timetable reader — generalisation notes

What changed, why the new reader exists, and what is still deliberately not done.

---

## 1. Why there are two readers

`cat_core.js` is a layout-independent timetable reader. It does not know what a
CAT timetable looks like; it works out, from the page itself, where the tables
are, where the columns are, which row is a date and which is a subject.

The older reader inside `index.html` does know. It was written against one
college's one sheet, and it reads that sheet correctly. What it cannot do is
anything else:

| The sheet does this | Old reader |
|---|---|
| Prints two timetables on one page | merges them into one table |
| Continues a table onto page 2 | rejects the file, or restarts the table |
| Repeats its header on page 2 | cannot tell a header from a data row |
| Prints no rules at all | reports one column |
| Splits `CODE` / `NAME` / `STAFF` into separate columns | shuffles them together |
| Prints `SEM: III, V & VII` | reads the word "SEMESTER" from "ODD SEMESTER" |

Both readers are still in the app. The new one runs **first**; if it cannot read
a file — a scan with no text layer, or its own script not loaded — that file is
handed to the old one. The preview then states, per file, which reader produced
the answer and why the other stepped aside.

## 2. How the new reader works

Six stages, each of which can fail on its own without taking the others down:

1. **Words** — pdf.js text items become positioned words, with font style.
2. **Rules** — the operator list becomes straight, long, axis-aligned segments.
   Filled shapes are *not* rules (see §4).
3. **Grid** — rules are grouped into one grid per table. A gap between two
   vertically continuous rules is a table boundary, so one page may hold several
   tables.
4. **Cells** — every grid cell collects the words inside it. With no rules, the
   columns are taken from the printed header instead (§3).
5. **Reading** — the header is found, the orientation decided, and each cell
   classified as a date, a year label, a session, a subject or staff.
6. **Assembly** — cells become exams, exams become rows, rows are reconciled
   against every cell so nothing is dropped silently.

## 3. Borderless sheets

A sheet with no rules has no whitespace gutters between its year columns, so a
whitespace projection reports one column and every paper lands in the same cell.

The header, however, always knows: `DATE | II YEAR | III YEAR` prints each
column's name centred over that column. The gaps *between* those names are the
column boundaries. Words are then assigned to a column by their **left edge**,
not their middle — a long subject name runs out of its own column, and its
middle would land in the neighbour, moving the whole paper to the wrong year.

## 4. Filled shapes are not borders

A college logo, a shaded header band and a highlighted cell are all drawn as
*filled* outlines. Every one of their four edges is a straight line long enough
to pass the "is this a border" test, so reading them as rules puts a phantom grid
over the sheet. A pdf.js operator list describes a path and then paints it, so
segments are held until the paint arrives: only a stroke publishes a rule.

## 5. Correcting a row by hand

The reader is good enough that the usual complaint is no longer "this sheet is
unreadable" but "this one cell is wrong" — a code that read as `CCS3 75`, a date
column merged onto the wrong day, a year heading read as 11 instead of III. Every
row in the confirmation table can therefore be corrected in place, without editing
the PDF and uploading it again. Editing is off until it is switched on, so the
table is a reading of the sheet by default.

Editable: **date, session, year, semester, department, subject code, subject
name**, plus a tick box to leave a row out or bring a non-exam row in.
Deliberately not editable: **staff names and sections** — neither is ever written
to the database, so an edit there would only look as though it mattered.

Three rules keep a correction as trustworthy as a reading:

1. **A row is rebuilt, never patched.** It is reconstructed from the reader's
   entry plus the administrator's correction, so a stale value cannot survive
   half-way through, and *undo* returns exactly what the sheet printed.
2. **Every correction is re-derived by the same gate that ran the original read.**
   Re-dating a row re-runs the duplicate check against the exams that exist;
   changing its department or year re-runs the student match and the row's student
   count moves with it. A correction that turns into a duplicate, a conflict or a
   batch collision is blocked again rather than saved.
3. **What was typed and what will be saved are kept apart.** The box shows exactly
   what was typed so a trailing space can be typed at all; the row carries the
   trimmed value so the database never sees it.

Two checks exist because the fields are now typed by hand:

- **A date is validated, not trusted.** An ISO date the reader produced is kept
  untouched. Anything else goes through the app's own date reader, so `6.10.2026`
  is understood; what that reader cannot make sense of — `2026-02-31`, `tomorrow` —
  blocks the row. A date is compared as a string against existing exams and written
  straight to the database, so an unreadable one would create a real exam on an
  unusable date. The result is checked field by field, because the app's date reader
  accepts any 1–31 day and turns `31/02/2026` into `2026-02-31`.
- **Year and semester are one fact in two boxes.** `examGroupYear` derives the
  year *from* the semester whenever the semester is a real one, so a row corrected
  to "2nd year" while still carrying semester 05 would be saved as 2nd year and
  seated with 3rd-year students. Moving the year moves the semester with it, and a
  pair that disagrees is reported as `YEAR AND SEMESTER DISAGREE` rather than
  resolved by guesswork.

The 3-digit department code shown in the table is the code that will be written:
a row whose department was corrected is looked up again for the **new** department,
rather than keeping the code of the department its sheet was read as.

`cat_edit.test.js` covers all of this against the shipped code, and
`probe_bridge.js` runs both real sheets through the gate so a regression that
starts blocking genuine timetables is visible.

## 6. What it will not do

These are deliberate, and each one has a test:

- **Invent nothing.** A value the sheet did not print is left blank and listed as
  missing. No academic year, no semester, no department, no session.
- **Never silently rewrite a date.** An ambiguous `03.04.2026` stays flagged
  unless the sheet's own date range settles it.
- **Never turn a header into an exam.** A repeated header on page 2 is a header.
- **Never carry a date across a structural boundary.** The first date is not
  silently reused for rows that follow.
- **Never suppress a duplicate.** Two identical rows are reported.
- **Never auto-apply a model suggestion** (§7).
- **Never save a hand-typed date it could not read** (§5).

## 7. The optional second opinion

`netlify/functions/cat-llm.mjs` can re-read cells the reader was unsure about.
It exists for three reasons and no others:

- The API key stays on the server. A key in the browser is a key anybody can
  spend.
- Only the printed text of one cell is sent — never register numbers, student
  names or halls. The request is size-capped, row-capped and rate-limited.
- It can only **suggest**. A suggestion appears beside the printed reading with
  its reasoning, and changes nothing until a person presses "Use this". The
  applied value then goes through the same readiness gate as everything else, so
  a suggestion that fixes nothing leaves the row blocked.

Configure `ANTHROPIC_API_KEY` (and optionally `CAT_LLM_ORIGIN`, `CAT_LLM_MODEL`)
on the deployment. Without a key the function answers "not configured" and the
app is unaffected — the timetable is read either way.

## 8. Running the checks

```powershell
$env:NODE_PATH="C:\Temp\catdeps\node_modules"
node run.js                    # everything
node probe_full.js             # the two real college sheets, in detail
node probe_bridge.js           # the browser bridge + the confirmation gate, on those sheets
node probe_syntax.js           # every script on the page still parses
node cat_make_fixtures.js --check   # the 17 generated layouts match their specs
node cat_parse_check.js index.html # the app block still parses
```

New layouts are added in two places and nowhere else: a **spec** (which states
what the sheet prints, and is the source of the golden file) and, only if the
reader genuinely cannot read that shape, a change to `cat_core.js`. Goldens are
generated from specs — never from the reader's own output, or the tests would
only prove the reader agrees with itself.

## 9. Still open

- `semesterLine` reports the label; `semesterValue` now carries the printed
  semesters, but a semester list printed somewhere other than beside `SEM:` is
  not yet found.
- A department matched only by similarity is held back for confirmation. The
  picker that lets a person choose from the candidates is not built yet.
- Staff names are split on `&`, `,`, `/` and `and`. A list printed one per line
  inside a single cell is read as one person.
- OCR still belongs to the old reader. A scanned sheet therefore never reaches
  the new reader, and the multi-page and borderless handling do not apply to it.
- Manual correction covers the fields that are saved. It does not yet let an
  administrator type a register-number list for one exam, choose the halls, or
  change the assessment label — a row whose assessment label is wrong is reported
  as a conflict rather than being relabelled.
- The correction UI is checked by tests against the shipped logic and by parsing,
  but has not yet been driven in a live browser.