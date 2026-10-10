# Hall-Wise Hall Notice — Specification & Source of Truth

This document defines the **required behaviour** of the Hall Notice feature in ExamSeat Pro. The feature repeatedly drifted (per-exam notices, split departments, blank pages, notices spilling onto a second page), so treat this as the single reference when debugging or changing it.

---

## 1. The Core Rule

> ONE PHYSICAL HALL + ONE DATE + ONE SESSION = ONE HALL NOTICE. Preview, print and PDF render the SAME document: a date + hall with BOTH sessions = **ONE A4 portrait sheet** (FN notice on the TOP half, AN notice on the BOTTOM half); a single-session hall = **one full A4 page**.

A Hall Notice is a **physical-hall document**, not a per-exam, per-department, per-subject, per-batch or per-year document. Every student physically seated in that hall on that date and session appears on that notice, in their **exact saved seat positions**, with a combined subject summary and a `TOTAL` that counts every occupied physical seat in the hall.

**Department is never a grouping dimension and never a split dimension.** CSE + ECE + MECH + CIVIL students seated in the same hall on the same date/session appear on **one** notice with **one** `TOTAL`.

**FN and AN are separate notices, rendered side by side on one sheet.** The combined sheet is a paper-saving composition of two **complete** notices — each half carries its own header, seating grid, subject summary, `TOTAL` and signature blocks. Their content never mixes (both sessions reuse the same physical seats, but each session is drawn in its own half, so no grid collision is possible). One hall on one date with both sessions therefore produces **1 combined sheet**; the legacy full-page export `buildHallNoticesDocument` (FN and AN each on their own A4 page) remains exported but is no longer the preview/print/PDF path.

**Grouping key is exactly** `date | session | hallId` — batch, year, exam, subject, plan, department and gender are **never** added. The two key fields are compared **canonically** so cosmetic differences in saved data cannot split one physical notice: `hnCanonDate` (trim) and `hnCanonSession` (trim + uppercase). Saved sessions `"AN"`, `"AN "` and `"an"` are the **same** session and therefore the **same** notice. Batch/year prefixes are read **only** for the `[HN-DEBUG]` audit log (§6.7).

### Examples

| Scenario | Hall | Date | Session | Notices | Pages | TOTAL |
|---|---|---|---|---|---|---|
| One exam (CS3492, 17 students) in LH-2 | LH-2 | 01-DEC | FN | 1 | 1 | 17 |
| Two exams (CS3492 13 + EC3451 12) in LH-2 | LH-2 | 01-DEC | FN | **1** | **1** | **25** |
| CSE + ECE + MECH in LH-2 (duplicate hall records) | LH-2 | 01-DEC | FN | **1** | **1** | all rows |
| LH-2 with **both** sessions on one date | LH-2 | 01-DEC | FN + AN | **2** | **1 combined sheet** | 17 / 8 |
| Same hall, two different dates | LH-2 | 01-DEC FN + 02-DEC AN | — | **2** | **2** | 13 / 12 |
| LH-1..LH-7 with both sessions | all 7 | 01-DEC | FN + AN | **14** | **7 combined sheets** | per hall |
| Student seated in LH-2 **and** LH-7 | both | 01-DEC | FN | 2 | 2 | appears once on each |

### Output order (deterministic)

1. **Session pass** — `FN` first, then `AN` (any other label follows alphabetically, ranked after both).
2. **Project hall order** — the order of the `halls` array, not alphabetical.
3. **Date**, then hall id as a final stable tiebreak.

So LH-1..LH-7 with both sessions emits one combined sheet per hall, hall order preserved: `LH-1 (FN + AN), LH-2 (FN + AN), … LH-7 (FN + AN)`. The legacy full-page builder emits `LH-1 FN, LH-2 FN, … LH-7 FN, LH-1 AN, … LH-7 AN`.

---

## 2. Printed Format (Anna University PROFORMA 1)

Each notice is one fixed A4 box (794 × 1123 px at 96 DPI) laid out top to bottom:

1. **PROFORMA 1** (title band)
2. **ANNA UNIVERSITY EXAMINATIONS NOV/DEC `<YEAR>`** (year derived from the exam date)
3. **SEATING ARRANGEMENT**
4. **Centre:** `<centre code> - <centre name>`
5. **Hall No:** `<hall name>` — **Session:** `<FN/AN>` — **Date:** `<dd.mm.yyyy>`
6. **Seating table.** One column per physical column in the hall (COLUMN A / COLUMN B / …). Rows are the benches. Each occupied cell shows the seat label (`A1.1` style), `REGISTER NO.` + register number, and `DEPT`. Empty valid seats stay drawn in place; never compress or renumber.
7. **SUBJECT SUMMARY** (informational only — never controls placement or grouping): `CS3492-13, EC3451-12`
8. **TOTAL:** `<count of all occupied physical seats in the hall for that date+session>`
9. Signature blocks: **Name and sign of the Hall Superintendent** and **Chief Superintendent Signature with College seal**.

The page is `overflow:hidden` and its internals are `em`-based with a font size computed at build time, so the content budget is decided **before** rendering rather than discovered by the browser.

---

## 3. Required Behaviour (checked on every fix)

1. **Grouping key is DATE + SESSION + HALL ID only.** Never `exam.id`, `subjectCode`, department, batch, year or plan.
2. **One group = exactly one A4 page.** Not two, not zero. `doc.notices.length === doc.pages.length` always.
3. **FN and AN are never merged** into one page, grid, table or summary.
4. **Read the existing saved allocation unchanged.** Never re-run, re-order, regenerate or re-place seats. The notice is a read-only projection of what is already saved.
5. **Physical seat is the source of truth**: `hallId`, `seatNo`, `seatLabel`, `bench`, `slot`, `colIdx`, `rowIdx`, `colLabel`. A seat renders in exactly the cell its saved fields point to.
6. **Never derive a seat's position from its array/filter index.** Positions that were not saved must never be invented.
7. **One physical layout per hall.** Rows = `hall.numbenches`, columns/seats = `hall.layoutConfig.columns[].seats` and `aisleAfter`. The layout is never recomputed from seat indices; grid extents grow to `max(layout, 1 + max saved colIdx/rowIdx)` so a layout edited smaller can never drop already-saved seats.
8. **Saved seat identity must equal rendered identity**: a seat saved as `C3.1` renders at cell `C3.1`.
9. **Empty valid seats remain** (there is no "disabled seat" feature in this app). A gap in the middle of a column stays a gap.
10. **Subject summary is informational**: it never filters or splits the notice, and always sums to `TOTAL`.
11. **TOTAL = occupied physical seats in that hall** for the group (not a per-exam or per-department count).
12. **No duplicates**: a student appears once per notice. First occurrence of `hallId|date|session|regno` wins; a student cannot occupy two physical seats in one hall/date/session.
13. **No foreign hall**: a notice for hall X contains only students physically seated in hall X.
14. **Preview, print and PDF render the identical document** — one shared builder, one stylesheet, byte-identical page HTML.
15. **No tiling, no splitting, no blank pages** in the PDF: exactly one PDF page per notice.

---

## 4. Data Contract

### Input to generation

```js
opts = {
  exams:        [ { id, date, session, subject, subjectCode, ... } ],
  seatingPlans: { [examId]: { [hallId]: { hallName, seats: [ ... ] } } },
  halls:        [ { id, name, numbenches, layoutConfig } ],
  date?:    "",   // optional filter
  session?: "",   // optional filter
  hallId?:  "",   // optional filter
  download?: bool // true -> save a real .pdf instead of opening a print window
}
college = { name, centre_code }
```

### One saved seat (`seatingPlans[examId][hallId].seats[]`)

| Field | Meaning | Example |
|---|---|---|
| `regno` | Student register number | `953021205012` |
| `name` | Student name | `SELVARAJ K` |
| `dept` | Department | `CSE` |
| `hallId` | Hall id | `LH09` |
| `hall` / `hallName` | Hall display name | `LH - 09` |
| `seatNo` | Fully qualified seat code | `LH09-B7S1` |
| `seatLabel` | Readable physical label | `A7.1` |
| `bench` | Bench number (1-based physical) | `7` |
| `slot` | Slot within bench (1-based) | `1` |
| `colIdx` | Column index (0-based) | `0` |
| `rowIdx` | Row / bench-line index (0-based) | `6` |
| `colLabel` | Column letter | `A` |

Legacy plans may store **only `seatLabel`** (e.g. `A1.1`) with no `seatNo`/indices — the grid must still render those seats at the matching physical label.

### Benchmark numbering (all engines agree — DO NOT change)

```
bench     = colIdx * nRows + rowIdx + 1        // 1-based, column-first
seatNo    = hallId + "-B" + bench + "S" + slot
seatLabel = colLabel + (rowIdx+1) + "." + slot // e.g. A7.1
```

This formula exists in `attAllocHallSeatDefs` (attendance engine) and the smart/manual inventory builder. The renderer indexes by **all four** keys (`seatNo`, `seatLabel`, `cr<col>:<row>:<slot>`, `B<bench>S<slot>`) and each cell looks itself up the same way, so modern and legacy seats both land in the right cell.

---

## 5. Where It Lives

All in `index.html` (single-file app). The generator lives in the **babel block** so it survives every page load; only `downloadHTMLAsPDF` is in the vanilla block.

| Item | Location |
|---|---|
| `downloadHTMLAsPDF(filename, css, body, pageSelector)` | vanilla block — DOM → PDF via html2canvas + jsPDF; notices pass `".pf-page"` |
| `HN_PAGE_W` / `HN_PAGE_H` / `HN_PAGE_PAD` | babel block — 794 / 1123 / 26 (A4 @ 96 DPI) |
| `hnEscapeHtml`, `hnFormatDate` | babel block |
| `hnNoticeLayout(group)` | babel block — columns, seats/column, rows, aisles from the real hall layout |
| `hnNoticeMetrics(nRows, maxSeats)` | babel block — content budget + fit scale for one A4 page |
| `hnNoticeStylesheet()` | babel block — the single `@page`/print stylesheet |
| `hnRenderNoticePage(group, college)` | babel block — renders one group's single A4 page |
| `buildHallNoticesPrintDocument(opts, college)` | babel block — **the ONE builder behind preview, print and PDF**: a date + hall with both FN & AN = ONE A4 sheet (FN top half, AN bottom half); a single-session hall = its own full A4 sheet |
| `buildHallNoticesDocument(opts, college)` | babel block — the legacy full-page builder, one COMPLETE notice per A4 page. Kept exported for determinism tests; no longer used by preview, print or PDF |
| `hnNoticeOrder(groups, halls)` | babel block — FN/AN → project hall order → date |
| `hnAuditNotices(doc)` | babel block — per-notice + compose audit |
| `hallNoticesGroup(...)` | babel block — groups saved seats by `date\|session\|hallId` |
| `generateHallNoticesProforma(opts, college)` | babel block — entry point. Always builds via `buildHallNoticesPrintDocument`; `opts.download` saves the PDF (byte-identical to preview/print) |
| Window exports | `window.hallNoticesGroup`, `window.generateHallNoticesProforma`, `window.buildHallNoticesDocument`, `window.buildHallNoticesPrintDocument` |
| `HallNoticePage` ("Hall Notice" menu) | babel block — preview calls `buildHallNoticesPrintDocument` |
| Dead legacy per-exam generators (no call sites — do not resurrect) | `window.generateHallNotice`, `window.generateSingleHallNotice` |

**Why the babel export pattern matters:** the vanilla block can be skipped in the browser due to historical syntax/live-server issues. The generators are top-level declarations in the babel block and are explicitly exported to `window.*` (the same pattern as `addAuditEntry`). React handlers call them only via `window.X`.

---

## 6. Generation Algorithm (as implemented — read-only)

1. `hallNoticesGroup` iterates **every exam**, reads `seatingPlans[exam.id]`, and for each hall key pushes a row per saved seat carrying `regno`, `dept`, `seatNo`, `seatLabel`, `colIdx`, `rowIdx`, `colLabel`, `bench`, `slot`, plus the exam's `subjectCode` (for the summary only). Optional `date` / `session` / `hallId` filters; rows without a `regno` are skipped.
2. Rows are grouped with key `date + "|" + session + "|" + hallId` → one group per (date, session, hall). The key fields pass through `hnCanonDate` / `hnCanonSession`, so `"AN"` / `"AN "` / `"an"` and padded dates form the **same** key. No other dimension is ever added.
3. `hnNoticeOrder` sorts groups: explicit session rank (`FN` = 0, `AN` = 1, others = 2 then alphabetical), then the `halls` array index of the canonical hall, then date, then hall id.
4. `hnNoticeLayout` derives the real grid: **columns** = `max(layoutConfig.columns.length, 1 + max saved colIdx)`, **seats per column** = `layoutConfig.columns[].seats` (falling back to the widest saved `slot`), **rows** = `max(numbenches, 1 + max saved rowIdx)`, **aisles** = `aisleAfter`. The old hardcoded "3 columns × 1 seat" fallback is gone.
5. `hnNoticeMetrics(nRows, maxSeats)` budgets the page: it reserves fixed heights for the header, summary and signature blocks and gives the remainder to the table, deriving a `scale` (1.0 for a standard 3 × 5 × 2 hall, reduced for larger halls) that becomes the page's inline `font-size` — i.e. the whole notice shrinks together, since all internals are `em`-based.
6. `hnRenderNoticePage` renders the group:
   - occupied seats are indexed by 4 identity keys, so every saved seat (modern or legacy) lands in its exact cell;
   - **row survival is first-wins**: only the first claimant of a seat-identity key and the first occurrence of a student (`hallId|date|session|regno`) survive. Later collisions are dropped and logged (`[HN-DEBUG] seat-collision`, `[HN-DEBUG] duplicate-regno-in-hall`). The grid, summary and `TOTAL` all use the surviving rows, so `TOTAL` always equals the number of rendered cells;
   - the **full physical grid is always emitted** — `nRows` rows × every column × every seat, with unoccupied seats drawn as `<div class="cell empty">` carrying only their label;
   - the printed `Hall No:` is the canonical name resolved by `resolveHall` (never a per-seat field); column letters come only from `colLabelFromIdx`;
   - the subject summary is rebuilt from surviving rows and always sums to `TOTAL`. A row with no `subjectCode` and no parseable subject prefix lands in an explicit **`UNSPECIFIED`** bucket and is logged (`[HN-DEBUG] missing-subjectCode`).
7. `buildHallNoticesPrintDocument` returns `{ css, pages, notices, groups }`. A date + physical hall's FN and AN groups are composed onto ONE A4 portrait sheet (each rendered by `hnRenderNoticePage(..., "half")`, FN top / AN bottom, split by a 2px rule); a single-session hall renders as one full page (`hnRenderNoticePage(..., "full")`). This single object feeds the live preview, the print window and the PDF — all three are byte-identical.
8. `hnAuditNotices` then logs one `[HN-DEBUG] notice` per group (`hallId`, `hallName`, `date`, `session`, `rows`, the **grid shape**, the **batch prefixes** via `hnBatchKey` = first 6 digits of `regno`, `subjectCodes`, `departments`, `fitScale`, `pagesForThisNotice: 1`) plus one `[HN-DEBUG] page-compose` (`notices`, `pages`, `mode`).

### PDF generation (`downloadHTMLAsPDF`)

- The body is mounted in an off-screen holder, then **exactly one PDF page is added per `.pf-page` element**. `addPage` is called between notices, never inside one.
- Zero-size canvases are `continue`d, so an empty element can never create a blank page.
- If nothing printable exists, the user is alerted and **no file is written**.
- A notice that is somehow taller than A4 is **clamped into the printable area** as a finished image — it is **never tiled across pages**. The element is deliberately *not* CSS-transformed: `getBoundingClientRect()` already includes a transform, so scaling-and-re-measuring would double-apply it. Fit is decided at build time by `hnNoticeMetrics`; the image clamp is only the last-resort safety net.
- The holder is removed in a `finally`, including on the alert and error paths.

---

## 7. Known Failure Modes & History

| Symptom | Cause | Resolution |
|---|---|---|
| Browser `Unexpected token 'in'` on load | live-server injects its reload script before the first literal `</body>`; the print string contained a literal `</body></html>` | Split closing tags in the print string: `'<scr'+'ipt>window.print();</'+'script></'+'body></'+'html>'` |
| Notice opens but **cells are empty** | Grid matched occupied seats only by constructed `seatNo`; legacy plans store only `seatLabel` | Multi-key index + multi-key lookup (all 4 keys) |
| One notice per exam instead of one per hall | Grouping by exam/subject | Group strictly by `date\|session\|hallId`; old per-exam generators removed |
| **One notice PER DEPARTMENT** in the same hall | The hall is stored as **several records with the same name but different ids** (one per department during import: `H1`, `d_cse`, `d_ece`, `d_mech`, all named `LH-5`); `resolveHall` returned the exact id match, so each record kept its own `hallId` | `resolveHall` **snaps to the first record with that normalized name**, so all copies resolve to ONE id/name/layout; `hallNoticeOptions` uses the same `hallCanonId` rule so a dropdown can never address a different id than the notice it generates |
| Dashboard shows the **same hall twice** (one with a count, one `(0 seated)`) | Dropdown iterated raw `halls` while counts are keyed by canonical `hallId` | `hallNoticeOptions` dedupes by `hnNormHall(name)` and aggregates count + dates across aliases; `hallOptionSeats` resolves by canonical id or alias name |
| One hall printed as **several notices — "one page per batch/year"** | Not batch/year: the *key fields* were compared byte-for-byte, so `"AN"`, `"AN "`, `"an"` formed different keys | `hnCanonDate` (trim) + `hnCanonSession` (trim + uppercase). The key is still exactly `date\|session\|hallId` |
| **A notice spilling onto a second page / header at the bottom of a page** | Notice height was left to the browser; content was laid out with fixed pixel blocks that could exceed A4 | The notice is a fixed 794 × 1123 A4 box with an `em`-based internal budget; `hnNoticeMetrics` computes the font scale at build time so the table, summary and signatures always fit inside one page |
| **A blank / trailing PDF page** | A page was added before checking whether the element had rendered any content | Add a page only when a canvas was actually produced; `continue` on zero-size canvases; write the file only if at least one page was added |
| Generate freezes and no PDF appears | The tiling loop `while (imgH - pos > pageH - 8) { pos -= (pageH - 8); }` never terminates — decreasing `pos` makes `imgH - pos` grow | No tiling at all: one image per notice, clamped into the printable area. One notice is always one PDF page |
| Two students in one cell / a row silently overwritten | Two saved rows resolve to the same seat-identity key | First-wins seat index; drop + log (`[HN-DEBUG] seat-collision`) |
| Same student printed twice in one hall | Duplicate `regno` under two seats in the same `hallId+date+session` | First-wins per `hallId\|date\|session\|regno`; drop + log |
| A saved seat vanishes after the hall layout was edited smaller | Grid built only from `numbenches` / `layoutConfig.columns` | Grid extents = `max(layout, 1 + max saved colIdx/rowIdx)` |
| `TOTAL` ≠ sum of subject summary | Summary built from a different row set than the grid | Summary rebuilt from surviving rows; `UNSPECIFIED` bucket + `[HN-DEBUG] summary-total-mismatch` guard |
| `Hall No:` shows a stale/wrong name | Printed a per-plan/per-seat hall name | Print the canonical `resolveHall` name |
| **Generate** opened a print window instead of saving a file | The generator always wrote to `window.open` + `window.print()` | `opts.download:true` renders the same pages and saves a real `.pdf` via `downloadHTMLAsPDF(..., ".pf-page")`; the print path is kept for `opts.download` unset |
| Two plans cover the same hall+date+session and **some students disappear** | The plans independently placed students into the **same physical seats**; the renderer is first-wins so the later plan's rows were dropped. Multiple plans sharing a hall/date/session is **legitimate** — only a **physical-seat collision** is a defect | **Block-and-warn at save time:** `findPlanHallSessionConflicts(examRef, plan, exams, seatingPlans, halls)` checks the candidate's seat identities against every *other* plan for the same hall/date/session (4-key identity + `hnSeatLabel` for a stable one-report-per-seat label). `examRef` accepts an exam **id** or `{id,date,session}`. On any clash the plan is **not saved** and a blocking alert names hall/seat/regno/owning plan; nothing already stored is modified. Called before `Store.setSeatingPlan` in **all three roots**: auto-generation, manual placement, and PDF import |
| A PDF import **partially applied** an exam while skipping its plan | The exam upsert ran before the clash check | The import guard runs **before any exam/plan write**; a conflicting group is skipped whole, and one consolidated alert lists every skipped subject |
| Existing saved data already contains duplicate hall+date+session plans | Added after the fact; the save guard cannot retro-fit old data | **Read-only audit:** `window.auditHallNoticeCollisions(exams, seatingPlans, halls)` returns `{ sharedCombos, seatOverlaps, generatedAt }`. It never deletes or auto-merges |

### Debug protocol (when a regression is reported)

1. Reproduce with the real saved data. The generator emits **permanent targeted `[HN-DEBUG]` logs** (`hnDebug(...)`, shown unless `window.__HN_DEBUG__ === false`): `seat-collision`, `duplicate-regno-in-hall`, `missing-subjectCode`, `unresolved-hall`, `summary-total-mismatch`, plus the per-notice `notice` and `page-compose` audit. Read the console after clicking **Generate Hall Notice**; each tag means a saved-data anomaly was found and handled first-wins.
2. Verify per notice: all hall students present, no foreign-hall students, combined exams in one page, seats in their saved positions, no duplicates, and `notice` shows `pagesForThisNotice: 1` while `page-compose` shows `pages` equal to the expected sheet count (one per date+hall with both sessions, one per single-session hall) and `combinedSheets` matching the FN+AN pairs. If `pages` is higher than expected, the date/session/hall-name values differ cosmetically in the saved data — that is the split to look at, not batch/year.
3. If groups/rows are correct, the renderer is proven by the regression suite below.
4. If `TOTAL` is lower than the number of students placed, two plans claim the same physical seat: run `auditHallNoticeCollisions` and fix the reported overlap. New plans can no longer create this.
5. Run the regression suite (§8). The `[HN-DEBUG]` tags stay permanently; they are the anomaly detector.

---

## 8. Regression Coverage

Run from `C:\Users\AKASH\AppData\Local\Temp\opencode`. Re-extract first, then pass the file path as the first argument (`pdf_curriculum_test.js` also takes the fixtures dir; `pdf_pagination_test.js` reads `index.html` directly):

```
node extract_babel.js "D:\SEATING PROJECT\ExamSeatPro_v66_secure\index.html" babel_block.js
node parse_check.js babel_block.js
node <suite> babel_block.js
```

| Suite | What it proves |
|---|---|
| `proforma_test.js` | Grouping + TOTAL + summary + one-hall filter + combined exams + legacy-label render |
| `proforma_edge_cases_test.js` | Seat-identity collision (first-wins + log), layout edited smaller than saved indices, missing `subjectCode` → `UNSPECIFIED` + log, duplicate `regno` in one hall, same physical hall keyed differently (`LH-5` / `LH5` / `lh 5`) → ONE notice |
| `proforma_batch_merge_test.js` | 3 batches + 2 subjects + 3 plans in one hall/date/session → **1 group, 1 page**, both subjects in the summary and all 3 batch prefixes in the audit; session/date cosmetic variance → still 1 group/1 page; `findPlanHallSessionConflicts` flags real clashes but allows disjoint seats, other sessions and re-saving the same exam (incl. the not-yet-created exam case); `auditHallNoticeCollisions` reports shared combos without mutating input; 3 departments each with their own duplicate `LH-5` record → **one** group, one page, one `Hall No:`, all 3 departments, `TOTAL: 3` |
| `hall_onepage_test.js` | **One combined sheet per hall+date**: FN on the top half and AN on the bottom half, **each a complete notice** with its own summary, `TOTAL`, signature block, FN before AN, and a seat reused across sessions showing the correct student on each half. Also: `notices === pages` (combined sheets `pages.length === halls-with-both-sessions`), fixed-A4 page roots, `@page`/break CSS, preview === print === PDF byte-identical, and a large 4 × 14 × 3 hall staying on **one** page with every student present (a standard 3 × 5 × 2 hall is not shrunk) |
| `hall_lh1_lh7_test.js` | The full scenario: **7 halls × 2 sessions = 14 notices = 7 combined sheets**; order within each sheet is FN then AN; every sheet contains precisely its own hall's students with no foreign students; multiple departments land on one sheet; occupied + empty cells exactly fill the real grid so **genuinely empty seats are preserved**; every half has a summary and a signature block; no sheet is blank; the PDF body equals the preview pages and the build is byte-deterministic; a single-hall filter still yields FN + AN on one combined sheet |
| `hall_notice_pdf_test.js` | `opts.download:true` routes to `window.downloadHTMLAsPDF(..., ".pf-page")` (no print window), filename sanitized and names the hall, all-halls mode still one converter call, default print path unchanged |
| `pdf_pagination_test.js` | Runs the **real** `downloadHTMLAsPDF` against a stubbed DOM/jsPDF: **one notice = one PDF page, never tiled**. A taller-than-A4 notice yields 0 extra `addPage` calls, 1 image, clamped to the printable area with aspect preserved; a wider-than-A4 notice is clamped by width; two notices give exactly 1 `addPage` and 2 images; a zero-size canvas is skipped; no printable content alerts and writes no file; the holder is removed on every path including the early exit |
| `hall_options_test.js` | Dashboard dropdown/cards dedupe by normalized hall name, counts aggregated across aliases, `hallOptionSeats` resolution, and the option id equals the `hallId` the notice will use |
| `dbg_legacy.js`, `dbg_layout.js` | Legacy seat with only `seatLabel` renders; real 3-column layout renders R01@A1.1, R03@B1.1, R05@C1.1 |
| `sim_hallnotice.js`, `sim_dashboard.js`, `sim_real.js` | End-to-end PROFORMA page from real engine output; `HallNoticePage` one-hall and all-halls modes; live-server injection no longer splits the babel block |
| `attalloc_test.js`, `pdf_import_test.js`, `pdf_attendance_test.js`, `diag_test.js`, `pdf_schedule_test.js`, `pdf_curriculum_test.js` | Attendance allocation + PDF import engines — must stay untouched and green |

**Current status: 532 assertions passing, 0 failing.**

---

## 9. Don't-Touch List

When working on Hall Notice, do **not** modify: `generateAttendanceAutoAllocation`, `attAlloc*`, `attAllocHallSeatDefs`, `placeStudentsInHalls`, `generateSmartSeating`, the Hall Layout Editor and its seat inventory, attendance PDF extraction, Student extraction, the manual seating modal, any Firebase structure, or `numbenches`/capacity calculations. The notice only *reads* their output.
