# ExamSeat Pro — Exam & Schedule, Seating, Notice, Hall Notice

**Complete technical reference for the four output domains of ExamSeat Pro v66 (secure).**

| | |
|---|---|
| **Source of truth** | `index.html` — single-file app, 13,416 lines |
| **Companion docs** | `PROJECT_DETAILS.md` (app-wide), `HALL_NOTICE_SPEC.md` (hall notice deep-dive) |
| **Line-number convention** | `index.html:<line>` refers to the current file. Lines shift on every edit — re-verify before acting. |
| **Scope of this doc** | §1 Exams & Schedule · §2 Seating · §3 Notices · §4 Hall Notice · §0 shared foundations · §5 invariants · §6 defect register · §7 verification |

> **Read §0 first.** Every rule in §1–§4 depends on the shared date/session semantics and the single bench-numbering formula defined there. Most "impossible" behaviour in seating and notices traces back to a violation of a §0 invariant.

---

## §0. Shared foundations

These apply to **all four** domains. They are the reason the domains interact at all.

### 0.1 Database collections (Firebase RTDB)

| Path | Owner | Key fields | Notes |
|---|---|---|---|
| `/colleges/{id}` | Developer | `name`, `centre_code`, `adminUid`, `adminPassword`, `exam_title`, `coe`, **`subjects[]`** | Subjects are an **array on the college doc**, not their own collection (`index.html:25`) |
| `/students/{id}` | College | `id`, `regno`, `name`, `dept`, `year`, `gender`, `password`, `college_id` | |
| `/halls/{id}` | College | `id`, `name`, `numbenches`, `studentsperbench`, `capacity`, `hallType`, `layoutConfig`, `patternId`, `customGrid` | |
| `/exams/{id}` | College | `id`, `subject`, `date`, `session`, `groups[]`, `hallids[]`, `status`, `seatinggenerated`, `college_id` | |
| `/seating_plans/{id}` | College | `id`, `exam_id`, `plan` | `plan` is the nested hall → seats structure |

Collection map comment: `index.html:25-27`. Store layer: `index.html:2360-2414`. RTDB validation for an exam requires only `id` + `subject` + `college_id` (`index.html:74`) — every other field is app-level only.

### 0.2 THE bench / seat numbering formula — do not change

This single formula is the contract between the seating engine, the attendance allocator, the hall layout editor, every viewer and every notice. It is implemented **6 times** and all copies must agree.

```
nRows      = hall.numbenches                       // bench rows, front to back
benchNo    = colIdx * nRows + rowIdx + 1           // COLUMN-FIRST
seatNo     = hallId + "-B" + benchNo + "S" + slot
seatLabel  = colLabel + (rowIdx + 1) + "." + slot   // e.g. A7.1
colLabel   = ALPHA_SEAT[colIdx] || chr(65 + colIdx)
```

| Implementation | Line | Traversal it enumerates |
|---|---|---|
| `placeStudentsInHalls` (engine) | `index.html:2555`, `:2558`, `:2608` | `ci → si → ri` (slot-major, column-first) |
| `attAllocHallSeatDefs` (attendance) | `index.html:11870-11873` | `ci → si → ri` — byte-identical |
| `buildPhysicalHall` (SeatingPage grid) | `index.html:8156-8170` | `ci → si → ri` |
| `ManualPlacementModal` free-seat picker | `index.html:4341-4353` | `ci → ri → si` — **offer order only**, seat identity identical |
| `hnRenderNoticePage` (hall notice grid) | `index.html:1930-1939` | `ri → ci` — **display order only**, bench numbering still column-first |
| `_buildSeatingExportHTML` (Proforma 1) | `index.html:702-706` | `ri → ci` — **display order only** |

`ALPHA_SEAT` has 10 entries (`index.html:2455`); overflow falls back to `chr(65+ci)`. Columns are capped at 6 (§2.4), so overflow is unreachable.

**A saved seat is addressable by FOUR independent keys** — this is what makes legacy plans readable:

```js
hnSeatKeys(s) => [ seatNo, seatLabel, "cr{colIdx}:{rowIdx}:{slot}", "B{bench}S{slot}" ]   // index.html:1426-1433
hnSeatLabel(s) => seatLabel | seatNo | chr+row.slot | "B#S#" | "?"                          // index.html:1416-1422
```

Both the renderer and the collision guard index by **all four** and look up by **all four**, so modern and legacy-only-`seatLabel` plans land in the same cell.

### 0.3 SESSION semantics — exactly two values

| Value | Meaning | Hard-coded display window |
|---|---|---|
| `FN` | Forenoon | 10:00 AM – 01:00 PM (`index.html:1018`) |
| `AN` | Afternoon | 02:00 PM – 05:00 PM (`index.html:1018`) |

- Manual UI offers only these two (`index.html:7936-7938`); default `FN` (`index.html:7756`).
- Schedule parser accepts only `FN`/`AN` after alias expansion — `schedValidSession` (`index.html:6325`), `schedSessionOf` (`index.html:6329`): `F.N|Forenoon|Morning → FN`, `A.N|Afternoon|Evening → AN`.
- Notice ordering ranks explicitly: `SESSION_RANK = { FN: 0, AN: 1 }`, everything else `2` then alphabetical (`index.html:1719-1722`).
- **FN and AN on the same date are legal and expected** — they are separate notices, separate sessions, reusable halls (`index.html:9143`).

**Session comparison is inconsistent across the app — this is a real defect (D6):**

| Strategy | Where | Effect |
|---|---|---|
| Raw `===` | `index.html:7763-7769`, `:12738` | `"fn"` is invisible to the exam hall-booking check |
| Canonical (trim + upper) | `hnCanonSession` `index.html:1405`; used by `findPlanHallSessionConflicts` `index.html:1530` and all notices | `"FN"`, `"FN "`, `"fn"` are the same |
| Alias-expanded | `schedSessionOf` `index.html:6329` | `"F.N"` → `FN` |

### 0.4 DATE semantics — the most dangerous area

**There is no single date format and no validation on manual entry.** `saveExam` only checks non-empty (`index.html:7784`).

| Format | Example | `hnFormatDate` (`index.html:1757`) | `fmtDate` in attendance PDF (`index.html:1017`) | `isExamEnded` (`index.html:2913`) |
|---|---|---|---|---|
| ISO | `2026-12-01` | `01.12.2026` ✅ | `01.12.2026` ✅ | lexicographic ✅ |
| `DD-MMM-YYYY` | `01-DEC-2026` | `01.12.2026` ✅ | **`2026.DEC.01`** ❌ | lexicographic ❌ |
| `DD/MM/YYYY` | `01/12/2026` | `01.12.2026` ✅ | **`01/12/2026.undefined.undefined`** ❌ | ❌ |

- `hnCanonDate` is `String(d).trim()` only (`index.html:1404`) — it **normalises whitespace, not format**.
- The **only** strict validator is the schedule parser: `schedIsoDate` (`index.html:6302`), `schedParseDate` (`index.html:6318`), which rejects impossible days.
- `isExamEnded` string-compares the stored date against `toISOString().slice(0,10)` — a non-ISO date sorts wrong forever.
- Date **ranges** in schedule PDFs are detected and skipped: `schedDateCount` (`index.html:6319`), `schedIsDateRange` (`index.html:6320`).

> **Consequence:** two exams on the *same physical date*, saved in *different formats*, are two different keys to every notice. See §4.9.

### 0.5 Department inference

```js
const BRANCH_CODE_TO_DEPT = { "104":"CSE","105":"EEE","106":"ECE","114":"MECH",
                              "119":"CIVIL","154":"IT","243":"AIDS","244":"AIDS" };  // index.html:10827-10830
function inferDeptFromRegno(regno) { /* slice(6,9) then slice(6,8) */ }             // index.html:10863-10879
```

Returns `""` (empty, **not** `"GEN"`) on failure; every caller re-maps with `|| "GEN"`. The engine enriches `"GEN"` depts at seat time (`index.html:2598-2599`); **manual placement does not** (`index.html:4394`).

> `PROJECT_DETAILS.md:228` lists a *different* table (EEE=103, IT=105, CIVIL=101). The code is authoritative.

### 0.6 Hall capacity — three different formulas coexist

| Site | Formula | Clamp to 4? | Line |
|---|---|---|---|
| `calcHallCapacity` | `numbenches × Σ clamp(col.seats,1,4)` | **Yes** | `index.html:2471-2480` |
| `placeStudentsInHalls` → `plan[hallId].capacity` | same | Yes | `index.html:2639` |
| `attAllocCapacity` | seat-definition count | Yes | `index.html:11881` |
| `HallsPage.saveHall` → persisted `hall.capacity` | `nRows × seatsPerRowFromLayout(ly)` | **No** | `index.html:5717` |
| `HallLayoutBuilder` live total | `benchRows × spr` | No | `index.html:5319` |

`seatsPerRowFromLayout` (`index.html:5232-5239`) has **no clamp**, so a 6-seat column inflates the persisted capacity while every engine silently seats 4. `fixHallCapacities` (`index.html:13109-13116`) only repairs a capacity that is **absent** or **more than 2× too large** — a 10–100% overstatement is never corrected. See defect D1.

### 0.7 Department colour palette (shared by every view and export)

`DEPT_COLORS` / `DEPT_HEX` — `index.html:2890-2904`. CSE blue · ECE purple · MECH orange · IT green · EEE yellow · CIVIL red · AIDS pink · GEN grey. `DEPTS = ["CSE","ECE","MECH","IT","EEE","CIVIL","AIDS"]` (`index.html:2905`).

---

## §1. Exams & Schedule

### 1.1 Subjects Master

Subjects live at `colleges/{collegeId}/subjects[]` — a **full-array overwrite on every write** (`Store.saveSubjects`, `index.html:2396`). There is no per-subject document and no merge, so two tabs editing concurrently clobber each other.

**Two producers write two different shapes:**

| Producer | Fields | Line |
|---|---|---|
| Manual CRUD (`saveSubject`) | `id, name, code, credit, year, dept` | `index.html:6752`, `:6758` |
| Curriculum PDF merge | `id, name, code, year, semester, dept, branches, credit` | `index.html:6266` |

Manual save requires **all five** of name/code/credit/year/dept (`index.html:6749`); because the check is falsiness-based, a credit of `0` is rejected. **No duplicate-code check** in the manual path — duplicates are only caught inside the PDF merge (`index.html:6250`).

Year ↔ semester bridge: `curriSemToYear` (`index.html:6032`) returns `String(n*2-1)` — 02→1, 04→2, 05→3, 07→4. `curriYearToSem` (`index.html:6037`) is the inverse, used when building exam groups (`index.html:11701`, `:12769`).

**Page:** `SubjectsPage` — `index.html:6685`. Nav `Subjects Master` — `index.html:4561`.

### 1.2 Curriculum PDF import (Subject Master → subjects)

**PDF only.** `parseCurriculumFile` rejects every other extension (`index.html:6208-6215`).

```
PDF text layer → per-line y-banding (transform[5]) → x-band column detection
  → code / name / semester / branches → normalise → validate → preview → merge → save
```

Pipeline comment: `index.html:5966-5969`. Entry: `parsePDFCurriculum` (`index.html:6126`). Returns `{ rows, source:"PDF" }` (`index.html:6236`).

| Helper | Line | Purpose |
|---|---|---|
| `curriClean` | `5982` | collapse tabs/newlines/spaces |
| `curriNormalize` | `5983` | lowercase, `&`→`and`, strip dots & non-alnum |
| `curriBranchCodes` | `5984` | degree text → dept codes (`B.Tech. AI&DS`→`AIDS`, `B.E.Aero Engg.`→`AERO`, `B.E.Auto Engg.`→`AUTO`) |
| `curriIsExamRow` | `6010` | **always** drop `Exam Date and Time :- … : FN/AN` |
| `curriIsNoiseRow` | `6018` | drop titles / page footers / college headers |
| `curriExtractCode` | `6028` | `CURRI_CODE_RE = /\b[A-Z]{1,6}\s?\d{2,4}[A-Z]?\d*\b/` (`index.html:6027`) |
| `curriHeaderKinds` | `6072` | header kinds → `["code","name","sem","branch","rg","qp"]` |
| `curriDeriveBands` | `6091` | column bands from **data** x-positions, not header x-positions |
| `isCurriculumRowReady` | `6058` | needs code + name + valid semester + ≥1 branch |

Deliberately **ignored**: dates, FN/AN, RG (registered) and QP (question-paper) counts (`index.html:5969`).

**Merge** — `mergeCurriculumSubjects(existing, rows)` (`index.html:6238-6272`):
- Not ready → `counts.review++` (`index.html:6244`).
- Match by lowercased **code** first (`index.html:6250`), else lowercased **name + year** (`index.html:6251`).
- Update **only fills empty fields**, never overwrites (`index.html:6256-6262`); `branches` are **unioned** (`index.html:6260`); `updated` vs `skipped` decided by a JSON snapshot diff (`index.html:6255`).
- `dept` = **first branch code only** (`index.html:6247`); `credit` is hard-coded `null` (`index.html:6266`) — **credits are never parsed from a PDF**.
- Returns `{ subjects, counts: {added, updated, skipped, review} }` (`index.html:6271`).
- Save: one full-array write (`index.html:6728-6735`).

**Absent:** CSV / XLSX / DOCX / OCR curriculum paths. `PROJECT_DETAILS.md` §19.3–19.7 describes them — **they do not exist**. Only the PDF branch is real.

### 1.3 Exam record — every field actually written

| Field | Type | Written by | Line |
|---|---|---|---|
| `id` | string | `uid()` | `6653`, `7758`, `7805`, `11801`, `12758` |
| `subject` | string | all paths | `7792`, `6653`, `7345`, `11802`, `12773` |
| `subjectTitle` | string | manual edit | `7794` |
| `category` / `examCategory` | string | manual / schedule import | `7795`, `7796`, `6653` |
| **`date`** | string, **any format** | all paths | `7792`, `6653`, `11802`, `12773` |
| **`session`** | `FN` \| `AN` | all paths | `7792`, `6653`, `11802`, `12773` |
| `status` | **always the literal `"scheduled"`** | all paths | `6653`, `7756`, `11802`, `12773` |
| `groups[]` | array | all paths | `7792`, `6654`, `11806`, `12773` |
| `hallids[]` | string[] | all paths | `7792`, `6653`, `11805`, `12773` |
| `seatinggenerated` | boolean | seating flows | `7805`, `6653`, `11805`, `12773` |
| `carryForward` | boolean | attendance import | `12755`, `12773` |
| `unallocatedSeats` | number | attendance import | `12755`, `12773` |
| `source` | `"UNIVERSITY_PDF_IMPORT"` | university import | `11803` |
| `examOrder` | number | university import | `11803` |
| `registerNumbers[]` | string[] | university import | `11804` |
| `studentCount` | number | university import | `11805` |
| `college_id` | string | **injected by `Store.addExam` only** | `2376` |

`status` is a **fixed constant** — there is no status picker, and `status` is never read for logic. "Ended vs upcoming" comes from `isExamEnded` (date+session, `index.html:2909-2918`); "Seat Assigned vs Pending" comes from `seatinggenerated` (`index.html:9061`).

### 1.4 `groups[]` — the subject-group schema

**There are two incompatible conventions and the field names lie.**

| Convention | `subjectName` holds | `count` | Example | Line |
|---|---|---|---|---|
| Manual / schedule | the **subject CODE** | **string** | `{dept:"CSE", sem:"01", subjectName:"CS3492", count:"30"}` | `index.html:7755`, `:6609` |
| Schedule import | the **subject NAME**, code in `subCode` | string | `{dept, sem, subjectName, subCode, count:"30"}` | `index.html:6609-6610` |
| Attendance import | the **subject NAME** | string | `{dept, sem, subjectName, count}` | `index.html:12769`, `:11701` |

Manual edit resolves the subject by `s.code === g.subjectName` (`index.html:2925`) — i.e. it assumes the code convention.

**Groups select students by SEMESTER, not by stored membership** (`index.html:2932-2934`): a group's `subjectName`/`subCode` + `sem` is matched against the Student Master at generation time. Individual rosters are not stored on the group — except the university-import path, which additionally stores flat `registerNumbers[]` + `studentCount` (`index.html:11804-11805`).

### 1.5 Exam CRUD (`ExamsPage`)

`ExamsPage` — `index.html:7747`. Nav `Exams & Schedule` — `index.html:4562`.

Defaults (`index.html:7756`):
```js
const [form,setForm]=useState({subject:"",date:"",session:"FN",hallids:[],groups:[{...blankGroup}],status:"scheduled"});
```

**Only three validations** (`index.html:7784`):
```js
if (!form.subject || !form.date || !form.groups.length) { showToast("Fill all required fields","error"); return; }
```
`session` and `status` are **not** validated, and a group with empty `dept`/`sem`/`count` still saves.

Save payload (`index.html:7792`): `{ subject, date, session, status, groups, hallids }`. Create adds `id` + `seatinggenerated:false` (`index.html:7805`). Edit preserves `registerNumbers`, `subjectCode`, `studentCount`, `source` (`index.html:7797-7800`).

Hall double-booking check (`index.html:7763-7789`) uses **raw** date + session equality — see §0.3.

### 1.6 University Exam Schedule PDF parser

> **The schedule parser has NO production UI.** `parsePDFExamSchedule` and `schedImport` exist only as definitions and inside the diagnostic suite (`index.html:11181+`). There is no `SchedulePDF` symbol and no "Upload Schedule PDF" button. The only live "Exam Schedule" feature is a **CSV export** (`index.html:9762`).

Section banner: `index.html:6275-6276`. Entry: `parsePDFExamSchedule` (`index.html:6483`). Returns records `{ examCategory, examDate, session, subCode, subjectName, semester, reviewRequired }`.

| Concern | Functions | Lines |
|---|---|---|
| Months / code regex | `SCHED_MONTHS`, `SCHED_CODE_RE` | `6284-6285` |
| Date normalisation | `schedMonthNum`, `schedFullYear`, `schedIsoDate`, `schedDateMatch`, `schedParseDate` | `6289-6317` |
| Range detection (skipped) | `schedDateCount`, `schedIsDateRange` | `6319-6321` |
| Session aliasing | `schedValidSession`, `schedSessionOf` | `6325-6334` |
| Code extraction | `schedExtractCode` | `6336` |
| Category bucketing | `schedCategoryOf`, `schedCategoryBucket` → `University`\|`CAT`\|`Lab`\|`Other` | `6352`, `6592` |
| Semester `1-8`/I-VIII → `"01".."08"` | `schedValidSem` | `6345-6350` |
| Line/column geometry | `schedLineColumns` | `6475` |
| Noise + header filters | `schedIsIgnoreLine`, `schedIsScheduleHeader` | `6375`, `6389` |
| Subject text split | `schedSplitSubjectText`, `isScheduleRecordReady`, `schedFinalize` | `6400`, `6410`, `6413` |
| Dedupe | `schedRecordKey`, `schedDedupe` | `6580`, `6583` |
| Dept from code | `schedDeptForCode` | `6599` |
| Group entry | `schedGroupEntry` | `6607` |
| Grouping by `bucket\|date\|session` | `schedBuildUnits` | `6612-6622` |
| Existing-key detection | `schedExistingKeySet` — key is `date\|session\|CODE` | `6623-6636` |
| Import | `schedImport(records, exams, subjectList, mode)` | `6637-6676` |
| Display | `schedPrettyDate` → `DD MON YYYY` | `6677-6682` |

Import modes: `"skip"` (default) / `"new"` (`index.html:6646`). New exam written at `index.html:6653` — note `subject` is set to the **category**, not the subject name. Existing exam updated at `index.html:6671`. Stats: `{created, updated, groupsAdded, groupsUpdated, skipped, review, units}` (`index.html:6643`).

Verified date behaviour: `02-DEC-25`→`2025-12-02`, `DECEMBER 2, 2025`→`2025-12-02`, `01.12.2025`→`2025-12-01`, `93.01.25`→**rejected** (`""`).

### 1.7 Attendance PDF → exams + seating plans (two independent flows)

#### 1.7a `AttendancePDFImportPage` — the wired page (`index.html:12490`)

Reached from `ExamsPage`. It auto-creates students **and** seating plans.

- Parser `parseAttendancePDF` (`index.html:10881`) → groups `{date, session, subjectCode, subjectName, dept, branchCode, branchName, students[]}` (`index.html:11040-11047`).
- Enrichment: branch-code map (`index.html:10827-10830`), name-based dept inference (`index.html:10834-10843`), **approximate** attendance-year estimate with an explicit caveat comment (`index.html:10846-10860`).
- **Session defaults to `AN`** here (`index.html:10910-10920`) — the opposite of every other path.
- **Honours anti-copying rules**: calls the standard `placeStudentsInHalls` directly (`index.html:12702`) with `effPdfRules = { noSameDept: sortedGroups.length > 1, noSameYear: false, splitGender: false }` (`index.html:12695-12697`).
- Per-group plan split by `_groupIdx` (`index.html:12711-12731`).
- Soft capacity check before writing: `capacityOk = totalHallCapacity >= totalSelected` (`index.html:12820-12824`).
- **Collision guard runs BEFORE any exam/plan write** (`index.html:12739-12751`) — but it is **inside the per-group loop**, so it is *not atomic across groups*: groups written before a clash stay saved. Stated in the alert at `index.html:12788-12789`.
- Existing-exam match uses **raw** equality against `e.subject` (`index.html:12738`) — normally fails to match, creating duplicates. See D7.
- Per-group plan writes `studentsperbench: 1` (`index.html:12723`) and `capacity: grpSeats.length` (`index.html:12726`) — inconsistent with every other writer.

#### 1.7b `UniversityPDFImportModal` — the robust Store-backed path (`index.html:7224`)

Opened from `ExamsPage` (`index.html:8025`).

Documented contract (`index.html:11720-11727`):
```
// dupMode ("replace" default): for a unit whose (date+session+subjectCode) maps to
// an existing exam — "replace" re-seats it from the roster, "update" refreshes the
// exam record but KEEPS the existing plan, "skip" leaves both untouched. New units
// are always created + seated. Everything (exams + plans + new students + persisted
// cursor) lands in ONE atomic multi-location update, so a failed import leaves no
// partial state.
```

- Preview: `parseAttendanceSheet(pages)` (`index.html:11456`) → `attBuildExamUnits(...)` (`index.html:11536`); row status `invalid | duplicate | existing | new | conflict` (`index.html:7180-7192`).
- **Student upsert gate** `attIsValidAU`: `/^9\d{11}$/` (`index.html:11572`). Existing student records are **never** modified (`index.html:11745-11762`).
- Import `attImport(opts)` (`index.html:11728-11839`).
- Exam record (`index.html:11802-11807`) — `college_id` injected explicitly because the write bypasses `Store.addExam`.
- **Plans land in the same atomic batch** (`index.html:11810-11811`), committed once via `dbAtomicUpdate` (`index.html:2290`, called `index.html:11836`). Persisted global cursor at `index.html:11832-11834`.
- **No `findPlanHallSessionConflicts` call here** — collision avoidance is structural, via a session-scoped seat cursor (`index.html:11608-11621`, `:11883-11904`).
- **Session defaults to `FN`** (`index.html:7345`), via `attSessionOf` (`index.html:11376`).

### 1.8 Validation summary — Exams & Schedule

| Check | Line | Enforced? |
|---|---|---|
| Exam: subject, date, groups non-empty | `7784` | yes |
| Exam: session / status valid | — | **no** |
| Exam: group rows internally valid | — | **no** |
| Exam: date format | — | **no** (manual path) |
| Subject: name+code+credit+year+dept all present | `6749` | yes (rejects credit `0`) |
| Subject: duplicate code | — | **no** (manual path) |
| Curriculum row: code+name+sem+branch | `6058-6060` | yes → flagged for review |
| Register number `^9\d{11}$` | `11572` | yes (university import) |
| Hall already booked (raw date+session) | `7763-7789` | yes |
| Physical seat clash (canonical date+session) | `12743-12751` | yes, per group, pre-write |
| Exam capacity sufficient | `3997-4011`, `12824` | **warn only** |
| Server-side exam rules | `74` | only `id`+`subject`+`college_id` |

---

## §2. Seating

> The seating engine has **materially diverged** from `PROJECT_DETAILS.md` §8/§18. Where they disagree, **this section and the code are authoritative** — see the defect register §6.

### 2.1 Engine overview

Entry point: `generateSmartSeating(groups, halls, hallUsedSeats)` — `index.html:2757`. Returns the `plan` object; side-channel `window.__lastSeatingResult = { plan, unplaced, report, rules }` (`index.html:2813`).

```
flatten groups → dedupe by (id || regno) → sort strictly byRegNo
  → if splitGender:  males+others from hall 0, females from lastUsedHallIdx+1
  → else:             one pass
  → placeStudentsInHalls(...)  →  { plan, unplaced, lastUsedHallIdx }
  → buildSeatingReport(...)
```

| Function | Line | Returns |
|---|---|---|
| `ALPHA_SEAT` | `2455` | `["A".."J"]` |
| `byRegNo(a,b)` | `2457-2464` | length-first then lexicographic comparator |
| `calcHallCapacity(hall)` | `2466-2480` | `numbenches × Σ clamp(seats,1,4)` |
| `placeStudentsInHalls(...)` | `2482-2662` | `{ plan, unplaced, lastUsedHallIdx }` |
| `validatePlan(plan, rules)` | `2664-2711` | `string[]` problems |
| `validateGenderSeparation(plan)` | `2713-2724` | `string[]` problems |
| `buildSeatingReport(...)` | `2726-2755` | stats object |
| `generateSmartSeating(...)` | `2757-2815` | `plan` |
| `inferDeptFromRegno(regno)` | `10863-10879` | dept or `""` |

`byRegNo` is **length-aware**, not truly numeric-aware: `if (ra.length !== rb.length) return ra.length - rb.length;` then lexicographic. It is the **only** reordering the engine permits (`index.html:2779`).

### 2.2 The traversal — slot-major, column-first

`index.html:2551-2554`:
```js
for (let ci = 0; ci < nCols && !stopHere; ci++) {        // COLUMN (A, B, C…) — outer
  for (let si = 0; si < nSlots && !stopHere; si++) {      // SLOT   (S1..S4)     — middle
    for (let ri = 0; ri < nRows && !stopHere; ri++) {     // ROW    (1..nRows)    — inner
```

For a 3-column hall with `seatsPerCol = [2,1,2]`, `nRows = 4` the physical fill order is:

```
col A, slot 1, all rows:  A1.1  A2.1  A3.1  A4.1      (B1S1 … B4S1)
col A, slot 2, all rows:  A1.2  A2.2  A3.2  A4.2      (B1S2 … B4S2)
col B, slot 1, all rows:  B1.1  B2.1  B3.1  B4.1      (B5S1 … B8S1)
col C, slot 1, all rows:  C1.1  C2.1  C3.1  C4.1      (B9S1 … B12S1)
col C, slot 2, all rows:  C1.2  C2.2  C3.2  C4.2      (B9S2 … B12S2)
```

Because column `ci-1` is fully traversed before column `ci` begins, the **left neighbour cell is always fully populated** when column `ci` is checked.

**Conflict handling is a FORWARD SEARCH, not a hard stop.** A violating seat is `continue`d and the *same* student is retried at the next physical seat (`index.html:2589-2594`); the comment at `index.html:2490-2491` states *"A violating seat is REJECTED and the scan moves to the NEXT physically valid seat for the SAME student (forward search) — the run never aborts."* This contradicts the documented hard-stop guarantee. See D5.

`stopHere` (the fix for the dropped-partially-filled-hall bug) is a flag, not a labelled `break`, so the current hall's accumulated seats are always written (`index.html:2632-2646`).

### 2.3 The three rules

State (`index.html:3827`): `{ splitGender: true, noSameDept: false, noSameYear: false }` — **gender split is ON by default**. `toggleRule` is wired at exactly three places (`index.html:4171`, `:4186`, `:4201`); there is no other rule UI.

| Rule | UI label | Placement gate | Validator gate |
|---|---|---|---|
| `splitGender` | "Split by Gender" (`:4177`) | `index.html:2785-2804` (hall allocation, not a seat rule) | `validateGenderSeparation` `:2715` |
| `noSameDept` | "No Same Department Side-by-Side" (`:4192`) | `index.html:2572-2582` | `index.html:2694-2702` |
| `noSameYear` | "No Same Year Side-by-Side" (`:4207`) | `index.html:2583-2585` | `index.html:2703-2705` |

**"Side by side" is exactly one cell:** the candidate `(ci, ri)` is compared only against **occupied** seats of `(ci-1, ri)` — directly left, same row. At `ci === 0` **no rule is evaluated at all**. Explicitly **not** constrained: same-bench siblings (`si' ≠ si`), vertical neighbours, the right-hand cell, aisle-separated columns, other halls, seats held by other exams. `aisleAfter` is **purely cosmetic**.

**`noSameDept` and the `deptBlock` exemption.** Under `noSameDept`, same-dept left-adjacency is **legal** when both students belong to the same maximal same-dept run in regno order:

```js
const deptBlockOf = rules.noSameDept ? /* index of each student's maximal same-dept run */ : null;  // :2510-2522
const sameBlock = prev && (prev.dept||"GEN").toUpperCase() === (st.dept||"GEN").toUpperCase()
              && deptBlockOf && deptBlockOf[cursor] === deptBlockOf[cursor-1];                    // :2577-2581
```

A dept block fills one bench column before advancing, so its members are naturally left-adjacent to each other; the exemption makes that legal, and a block that outgrows the hall spills into the next hall where `ci === 0` and nothing is checked. Scattered same-dept adjacency (a dept reappearing as a *second* block) is still rejected. Every seat carries `deptBlock` (`index.html:2602`); the validator honours the exemption only when **both** seats carry a non-null `deptBlock` and the ids match (`index.html:2699`).

`noSameYear` has **no** equivalent block exemption, and the engine never infers `year` — it is taken verbatim from the student record. For PDF-imported exams `noSameYear` is always `false` because `inferYear` is an estimate (`index.html:12697`).

### 2.4 Hall layout model

**`layoutConfig` shape** (authoritative comment `index.html:5207-5223`):
```js
hall.layoutConfig = { columns: [{seats:2},{seats:3},{seats:2}], aisleAfter: [true,true,false] };
hall.numbenches   = numRows;                        // bench rows, front to back
hall.studentsperbench = seatsPerRow;
hall.capacity     = numRows * seatsPerRow;
hall.patternId    = "custom";                       // index.html:5719
hall.customGrid   = layoutToIcon(ly);               // index.html:5720
```

`defaultLayout()` = `[{seats:2},{seats:1},{seats:2}]` (`index.html:5227-5230`) — a 5-seat bench row in a 2-1-2 pattern.

**Legal values:**

| Quantity | Min | Max | Enforced at |
|---|---|---|---|
| `columns.length` | 1 | 6 | `:5299`, `:5303`, `:5535` |
| `columns[i].seats` — **editor** | 1 | **6** | `:5309` |
| `columns[i].seats` — **engine** | 1 | **4** | `:2475`, `:2537`, `:4335`, `:4388`, `:8150`, `:11867`, `:12072`, `:1796` |
| `columns[i].seats` — no layout | 1 | 1 | 3 columns of 1 (`:2536`) |
| `numbenches` (rows) | 1 | 500 nominal | `:5345`, `:5348`, `:5951`; **not capped** at `+` (`:5350`) or in `saveHall` (`:5707`) |
| `aisleAfter[i]` | `false` | `true` | boolean, length == `columns.length` |
| `aisleSeats` | — | — | **read in 4 places, written by nobody**; `setSeats` clears it (`:5309`) — dead feature |

**The 6-vs-4 mismatch is defect D1** and the single highest-impact seating bug: the editor lets you configure 6 seats per column, the UI counts 6, and the engine seats 4.

Components: `HallsPage` `index.html:5663` (nav `index.html:4560`; `HALL_TYPES = ["University","CAT","Lab","Other"]` at `:5671`; duplicate name+type guard `:5699-5704`; `saveHall` payload `:5715-5722`), `HallLayoutBuilder` `index.html:5289`, `HallLayoutVisualiser` `index.html:5581`.

### 2.5 Manual placement

`ManualPlacementModal` — `index.html:4312-4553`, mounted `index.html:4640`.

`pendingGen` shape (`index.html:3832`): `{ exam, plan, unplaced, hallUsedSeats, rules, carryForward, unallocated }`.

**Unplaced entry shape is `{ student, reason, hallName }`** (`index.html:2657`). The modal unwraps both that and a legacy bare-student form (`index.html:4315-4320`) — the fix for the September-2026 blank-screen crash (`Cannot read properties of undefined (reading 'slice')`).

Flow:
1. Free-seat inventory per hall, `ci → ri → si`, excluding seats in `plan` ∪ `hallUsedSeats` (`index.html:4322-4357`).
2. Live rule check per candidate seat (`index.html:4359-4372`) — **note: `noSameDept` here has NO `sameBlock` exemption** (pre-`deptBlock` logic).
3. `placeHere(s)` (`index.html:4374-4410`) — a violating seat raises `window.confirm`; the seat is written with `manual:true` and **without `deptBlock`**, and **without `GEN`→dept enrichment** (`index.html:4393-4400`). Audit via `addAuditEntry` (`index.html:4406`).
4. `saveManualPlan()` (`index.html:4412-4452`) — one confirm listing up to 3 unresolved issues, then a **hard** `findPlanHallSessionConflicts` block-and-warn with **no override** (`index.html:4432-4440`), then `Store.setSeatingPlan` + `Store.updateExam`.
5. The Save button appears as soon as **all students are placed OR zero free seats remain** (`index.html:4539-4547`); an amber banner explains the zero-seat case (`index.html:4520-4524`); the header shows `{remaining} remaining · {n} seats free` (`index.html:4463-4465`).

`ValidationReportPanel` (§33) — `index.html:4244-4310`: 8 stat tiles, rule chips, problems list capped at 20.

### 2.6 Seat swap

`SeatSwapPage` — `index.html:9315-9447` (nav `index.html:4566`).

Searches two students inside **one** plan (`findSeat`, `index.html:9325-9333`, matches **regno OR seatNo**, case-insensitive, across all halls) and swaps **only student identity fields** between the two physical seats (`doSwap`, `index.html:9340-9380`).

**Exactly 6 fields move:** `regno, name, dept, year, gender, groupLabel` (`index.html:9348-9349`; `benches[].slots[]` moves only the first 5, `index.html:9357-9360`).

**Never touched:** every physical field — `seatNo`, `bench`, `slot`, `colIdx`, `rowIdx`, `colLabel`, `seatLabel`, `hall`, `hallId` — and the `benches[]` structure. **No rule re-validation, no undo, no cross-exam swap.** `deptBlock` is **not** swapped, so a post-swap plan can silently change its `noSameDept` outcome. A `_tmp` scratch key is persisted onto the seat object.

### 2.7 Conflict checker — dead code

`ConflictCheckerPage` — `index.html:9100-9276`. **The only occurrence of the identifier in all 13,416 lines is its own declaration.** It is absent from the nav (`index.html:4555-4569`) and the router (`index.html:4641-4653`). `ExamResultsPage` (`:9450`) and `AuditLogPage` (`:9586`) are likewise orphaned.

It would have detected: same-session duplicate `regno` across two plans (`:9112-9141`, by `regno` only, never by physical seat); FN+AN same day as **info, explicitly allowed** (`:9143-9165`); a global `date_session_regno` duplicate sweep (`:9168-9192`). It would **not** have detected physical seat collisions, over-capacity, rule violations or gender mixing.

### 2.8 The collision guards that ARE live

#### `findPlanHallSessionConflicts(examRef, plan, exams, seatingPlans, halls)` — `index.html:1530-1585`

Doc: `index.html:1520-1529`. The foundation of block-and-warn at save time.

- `examRef` accepts an exam **id** or `{id, date, session}` for an exam that does not exist yet.
- Compares only exams whose **canonical** date **and** session match (`index.html:1537`, `:1544`).
- Resolves the hall through `resolveHall` (`index.html:1440`).
- Seat identity is the 4-key set from `hnSeatKeys`, bucketed `hallId + "||" + key` (`index.html:1554`).
- Returns `{ hallId, hallName, seatLabel, newRegno, existingRegno, existingExamId, existingSubject, existingDate, existingSession }`, deduped by `hallId||label||regno` (`index.html:1575-1577`).
- Human-readable: `describePlanConflicts(conflicts, max = 3)` — `index.html:1588-1596`.

**Live call sites (all three roots, all before any write):**

| Root | Line | Behaviour on clash |
|---|---|---|
| Auto-generation | `index.html:4073-4082` | `window.alert` + **abort, nothing saved** |
| Manual placement | `index.html:4432-4440` | alert + **abort, no override** |
| PDF import | `index.html:12743-12751` | **whole group skipped**, one consolidated alert |

#### `resolveHall(halls, planKey, hp)` — `index.html:1440-1465`

Resolution order: exact id → exact name → normalized id/name. Then the snap:

```js
const k = hnNormHall(h.name);
if (k) {
  const first = halls.find(x => hnNormHall(x.name) === k);
  if (first && (first.layoutConfig || !h.layoutConfig)) h = first;   // index.html:1461
}
```

**This snap FAILS when the first record with that name has no `layoutConfig`** — the condition is false, `h` keeps its own id, and one physical hall becomes two canonical ids → two notices. This is defect **D2**, reproduced in §4.9. The snap should key on **name identity alone**, using the layout only as a tiebreak.

#### `auditHallNoticeCollisions(exams, seatingPlans, halls)` — `index.html:1601`

Read-only one-shot audit exported as `window.auditHallNoticeCollisions` (`index.html:2082`). Returns `{ sharedCombos, seatOverlaps, generatedAt }`. It **never** deletes or merges — it only reports pre-existing data that predates the save guard.

### 2.9 Attendance auto-allocation (a completely separate engine)

Banner: `index.html:11841-11856`.
```
// A completely separate allocation path for PDF-imported exams. It does NOT use
// generateSmartSeating / placeStudentsInHalls / validatePlan or any of the Smart
// Seating rules ...
//   • Roster order is the EXACT PDF order — never sorted by register number.
//   • Every (date + session) forms ONE continuous pool across all its subjects.
//   • No dept/year/gender rules exist here (no anti-copying constraints).
```

| # | Function | Line | Returns |
|---|---|---|---|
| 1 | `attAllocPoolKey(u)` | `11857-11859` | `date + "\|" + session` |
| 2 | `attAllocHallSeatDefs(hall)` | `11861-11879` | every physical seat of a hall (`ci → si → ri`, formula identical to §0.2) |
| 3 | `attAllocCapacity(hall)` | `11881` | seat-definition count |
| 4 | `attAllocStreamState(subjects, plansById)` | `11888-11904` | `{ used, seated, subjects }` seeded from every exam in the stream |
| 5 | `attAllocBenches(seats, nRows, seatsPerCol)` | `11906-11916` | bench grouping (same as the engine) |
| 6 | `attAllocBuildPools(subjects)` | `11925-11940` | **always exactly one pool** |
| 7 | `attAllocCreateCursor(halls)` | `11950-11952` | the monotonic seat cursor |
| 8 | `attAllocNextSeat(cursor, halls, defsCache, used)` | `11954-11973` | next free valid seat, or `null` |
| 9 | `generateAttendanceAutoAllocation(subjects, halls, exams, plansById)` | `11983-12105` | `{ allocations, pools, totalStudents, totalSeated, totalUnassigned, insufficient, hallsUsed }` |

Key behaviours:
- One **global monotonic cursor** across the whole stream (`:12029`), never reset — that is the resumability mechanism.
- `pending = pool.students.filter(s => !seated.has(regno))` (`:12030`) — PDF order preserved, re-runs are idempotent.
- Halls are consumed in **caller-supplied order** (`:12011`), never capacity-sorted — unlike the admin path (`:3971`).
- Seats written with 12 fields: **no `deptBlock`, no `groupLabel`, no `_groupIdx`** (`:12038-12040`).
- **Nothing is persisted** by this function (`:12182`).
- `attAllocStreamState` is **global across all dates and sessions**, contradicting its own doc comment at `index.html:11852-11853` ("FN and AN are independent… a hall used in FN is reusable in AN"). See D8.
- The `exams` parameter is accepted and never read (`:11983`).
- Live caller: `index.html:7386-7405`.

### 2.10 Saved-plan data contract — `seatingPlans[examId][hallId]`

**Envelope.** In memory `seatingPlans[examId] = { [hallId]: hallPlan }`. Persisted by `Store.setSeatingPlan` (`index.html:2407-2414`), which reuses the existing `seating_plans` row for that `exam_id` if one exists, else inserts.

**Per-hall object** — literal construction at `index.html:2634-2641`:
```js
plan[hall.id] = {
  hallName:         hall.name,
  numbenches:       nRows,                    // hall.numbenches || 15
  studentsperbench: totalSeatsPerRow,         // Σ clamp(col.seats,1,4)
  layoutConfig:     ly,                       // hall.layoutConfig verbatim
  nCols, nRows, capacity: nRows * totalSeatsPerRow,
  benches, seats,
};
```

**`benches[]`** — `index.html:2624-2628`:
```js
{ benchNo: parseInt(bn), slots: benchMap[bn].sort((a,b) => a.slot - b.slot), capacity: seatsPerCol[ci] || 1 }
```
`ci = Math.floor((parseInt(bn)-1) / nRows)` (`:2623`) — the inverse of the bench formula. **`slots[]` holds the same object references as `seats[]`**, not copies (`:2621`). Only **occupied** benches appear; `capacity` is the nominal slot count.

**`seats[]` — the critical record** — `index.html:2600-2609`:
```js
const enrichedDept = st.dept && st.dept !== "GEN" ? st.dept : (inferDeptFromRegno(st.regno) || st.dept || "GEN");
const slot = {
  ...st, dept: enrichedDept,
  deptBlock: deptBlockOf ? deptBlockOf[cursor] : null,
  seatNo, hall: hall.name, hallId: hall.id,
  bench: benchNo, slot: si + 1,
  colIdx: ci, rowIdx: ri,
  colLabel: ALPHA_SEAT[ci] || String.fromCharCode(65+ci),
  seatLabel: (ALPHA_SEAT[ci]||String.fromCharCode(65+ci)) + (ri+1) + "." + String(si+1),
};
```

| Field | Type | Line |
|---|---|---|
| *all student fields* | spread | `2601` |
| `groupLabel` | string (injected at `:2769`) | — |
| `dept` | `GEN` → inferred | `2598-2599` |
| `deptBlock` | number \| `null` | `2602` |
| `seatNo` | `hallId-B{bench}S{slot}` | `2558`, `2603` |
| `hall` | **name**, not id | `2604` |
| `hallId` | string | `2604` |
| `bench` | `ci*nRows + ri + 1` | `2555`, `2605` |
| `slot` | `si + 1` | `2605` |
| `colIdx` / `rowIdx` | number | `2606` |
| `colLabel` | `"A".."J"` else `chr(65+ci)` | `2607` |
| `seatLabel` | `A7.1` | `2608` |

**The four seat writers differ:**

| Field | Engine `:2600` | Manual `:4393` | attAlloc `:12038` | PDF per-group `:12720` |
|---|---|---|---|---|
| `dept` | `GEN`→inferred | **not inferred** | `st.dept\|\|"GEN"` | inferred |
| `deptBlock` | ✔ | **absent** | **absent** | **absent** |
| `groupLabel` | ✔ | from spread | **absent** | `subjectCode` |
| `_groupIdx` | — | — | — | ✔ |
| `manual` | — | `true` | — | — |
| `studentsperbench` | `Σ` | `Σ` | `Σ` | **hard-coded `1`** `:12723` |
| `capacity` | `rows × rowWidth` | same | same | **`grpSeats.length`** `:12726` |

**Exam fields written alongside the plan** (`Store.updateExam`):
- auto `index.html:4085` — `{ seatinggenerated:true, carryForward, unallocatedSeats }`
- manual `index.html:4443` — same
- PDF import `index.html:12755` — adds `hallids:selectedHallIds`

**The plan key is always `hall.id`** (`:2634`, `:4382`, `:12076`). `resolveHall` exists precisely because **legacy plans may be keyed by hall *name*.**

**Consumers:** `SeatingPage` `index.html:8033` · `buildPhysicalHall(hid, basePlan)` `index.html:8143-8203` (regenerates the full grid from the real layout in `ci→si→ri` order and overlays students from **every** exam sharing the hall, `:8176-8185`) · `Mixed View` `index.html:8110-8133` (hard-codes `spr = 3` at `:8116`) · `SeatSwapPage` · `AttendanceSheetPage` · `StudentDetailsPage` · `HallNoticePage` · `window.generateAttendancePDF` `index.html:1008` · `hallNoticesGroup` · `findPlanHallSessionConflicts`.

### 2.11 Diagnostics suite — 51 cases, 4 suites

`runSeatingDiagSuite` — `index.html:10460-10730`, exported `index.html:10731`. UI: `SeatingEngineDiagnosticsPage` `index.html:10733` (Developer Dashboard → Diagnostics, `index.html:10208-10210`).

`runAll()` concatenates all four (`index.html:10745`):

| Suite | Function | Lines | Ids | Count |
|---|---|---|---|---|
| Seating | `runSeatingDiagSuite` | `10460-10730` | T1–T17 | 17 |
| Curriculum | `runCurriculumDiagSuite` | `11051-11179` | NS1–NS11 | 11 |
| Schedule | `runScheduleDiagSuite` | `11182-11321` | NS12–NS21 | 10 |
| Attendance | `runAttendanceDiagSuite` | `12108-12367` | AS1–AS13 | 13 |
| | | | **TOTAL** | **51** |

Seating cases: T1 no-rules all placed · T2 strict regno order · T3 column-first numbering · T4 `calcHallCapacity` · T5/T6/T7 dept/year/both horizontal-only · **T8 dept block spills col A→B, all `deptBlock===0`, 0 unplaced** · T9 determinism · T10/T11 gender split (mid-hall and exact fill) · T12 multi-hall overflow · T13 `hallUsedSeats` skip · T14 `byRegNo` ordering · T15 `validatePlan` duplicates · T16 report stats · T17 unplaced entry shape.

**The pass count is computed at runtime only** (`index.html:10755-10756`); there is no hard-coded snapshot. The UI labels are wrong twice: `index.html:10765` says "T1–T29" and `index.html:10772` says "16 synthetic assertions" — actual is **51 cases across 4 suites** and **17** seating cases. `PROJECT_DETAILS.md:493` and `:535` ("16/16") are stale.

---

## §3. Notices

The app produces **six** distinct exports. Only the hall notice (§4) is a strict one-page-per-item document; the rest are print-window or CSV.

| # | Export | Trigger | Builder | Output | Page selector |
|---|---|---|---|---|---|
| 1 | **Hall Notice** (PROFORMA 1) | `HallNoticePage` `index.html:13909` | `buildHallNoticesPrintDocument` `index.html:2144` (combined FN+AN sheet, or full sheet for a single session) — legacy full-page builder `buildHallNoticesDocument` `index.html:2110` kept exported for tests | **real `.pdf`** via `downloadHTMLAsPDF` | `.pf-page` |
| 2 | **Seating Arrangement** (PROFORMA 1, per exam) | `SeatingPage` | `window._buildSeatingExportHTML` `index.html:631` | `.pdf` (`exportSeatingPDF` `:856`) or print window (`printSeatingPDF` `:862`) | `.hall-page` |
| 3 | **Attendance Sheet** (per exam) | `AttendanceSheetPage` `index.html:9279` → `generateAttendancePDF` `index.html:9283` | `window.generateAttendancePDF` `index.html:1008` | **print window only** — no `.pdf` | — |
| 4 | **Student CSV** | `SeatingPage` | `exportCSV` `index.html:8331` | CSV | — |
| 5 | **Exams CSV** | `BackupRestorePage` | `index.html:9762` | CSV | — |
| 6 | **Halls CSV** | `BackupRestorePage` | `index.html:9767` | CSV | — |

There is **no** admit card, no student-facing notice, no circular, and no exam-wise notice beyond #2.

### 3.1 Seating Arrangement — PROFORMA 1 (per exam)

`window._buildSeatingExportHTML(exam, plan, college, students)` — `index.html:631`. Per-**exam** and per-**hall**, unlike the hall notice.

- Grid is displayed **row-first** (`ri` outer, `ci` inner — `index.html:702-706`); bench numbering is still column-first.
- Rows with no occupant in any column are **skipped** (`index.html:704`) — an empty bench row is not drawn.
- Cell content: `seatLabel` · `annaRegno(seat)` (`:637`) · `resolveDept(seat)` (`:650`, `:3187`), with a `.sep` divider between slots of one bench.
- Subject summary built from `s.groupLabel`, with a code-extraction regex `([A-Z]{2,4}\d{3,4}[A-Z]?)` (`index.html:736`).
- Header at `index.html:744-749`.

> **Defect D3:** the title is literally `PR0F0RMA 1` — a **zero** instead of the letter O (`index.html:745`). It prints wrong on every Seating Arrangement PDF.

Helpers `annaRegno` and `resolveDept` are each defined **twice** (`index.html:637`/`:1100` and `:650`/`:3187`); the later definition wins. `ALPHA` is redefined locally at `index.html:8151`.

### 3.2 Attendance Sheet

`window.generateAttendancePDF(exam, seatingPlans, students, college)` — `index.html:1008`. Print window only (`:1011`).

Per hall block (`:1019-1056`): one `.hall-block` per `Object.values(plan)` entry, joined by `<div class="page-break">` (`:1056`). Columns: **S.No · Register No. · Student Name · Dept · Signature** (`:1023-1029`, header `:1046`) — **no seat column**, though the page copy at `index.html:9288` promises one. Footer: Total Present / Total Absent / Hall Superintendent signature (`:1050-1054`). Stylesheet `:1058-1074` (Times New Roman, `#1e40af` header band, zebra rows).

> **Defect D4:** `fmtDate` (`:1017`) is `d.split("-")` reordering only, so it mangles every non-ISO date (§0.4) without throwing — `01-DEC-2026` → **`2026.DEC.01`**.
> **Defect D5:** `sessionLabel` (`:1018`) is a blind binary — anything that is not exactly `"FN"` prints "Afternoon - 02:00 PM to 05:00 PM", including `""`, `null` and `"FN "`.

### 3.3 The PDF conversion layer

`window.downloadHTMLAsPDF(filename, styleCSS, bodyHTML, pageSelector)` — `index.html:807` (vanilla block, outside Babel).

Constants: `A4_W=210, A4_H=297, MARGIN=4` mm → `AVAIL 202 × 289` (`index.html:808-809`).

Guarantees, and how each is achieved:

| Guarantee | Mechanism | Line |
|---|---|---|
| exactly one PDF page per element | `addPage()` only **between** elements, never inside one | `index.html:842` |
| never tiled / never split | no tiling loop exists; a taller-than-A4 notice is clamped into the printable area as one finished image | `index.html:837-839` |
| no blank page | zero-size canvas is `continue`d; the file is written only if at least one page was added | `index.html:834`, `:845-846` |
| no double-transform | the element is deliberately **not** CSS-transformed — `getBoundingClientRect()` already includes a transform, so scaling would double-apply | `index.html:828-832` |
| holder always removed | `finally` block, including the alert and error paths | `index.html:850-852` |
| library-missing guard | explicit `alert` + cleanup | `index.html:814-818` |

The off-screen holder is `position:fixed; left:-99999px; width:1123px` (`index.html:811`); each `.pf-page` is captured by `html2canvas` at `scale: 2` and written as JPEG q0.95 (`index.html:833-843`).

Libraries are CDN globals `window.html2canvas` and `window.jspdf`, presence-checked at `index.html:814`.

### 3.4 CSV exports

`exportCSV` — `index.html:8331` (student/plan CSV). Exams CSV — `index.html:9762`: header `id,subject,date,session,status`. Halls CSV — `index.html:9767`: `id,name,numbenches,studentsperbench,capacity,…`.

---

## §4. Hall Notice

> Full deep-dive including the failure-mode history: **`HALL_NOTICE_SPEC.md`**. This section is the operational summary and adds the newly-found defect D2.

### 4.1 The core rule

> **ONE physical hall + ONE date + ONE session = ONE hall notice. A date + hall with BOTH FN & AN exports (preview = print = PDF, byte-identical) as ONE A4 portrait sheet with the FN notice on the top half and the AN notice on the bottom half; a single-session hall is one full A4 page.**

A hall notice is a **physical-hall document**, not a per-exam, per-department, per-subject, per-batch or per-year document. Department is **never** a grouping or split dimension. FN and AN stay separate **notices**; the combined sheet is a paper-saving composition of two complete notices and never mixes their content or seating. The legacy `buildHallNoticesDocument` (one complete notice per full A4 page) remains exported but is no longer the export path.

**Grouping key is exactly `date | session | hallId`** (`index.html:1692`) — batch, year, exam, subject, plan, department and gender are never added. The two key fields pass through `hnCanonDate` (trim) and `hnCanonSession` (trim + upper) (`index.html:1404-1405`).

### 4.2 Printed format

One fixed A4 box, `794 × 1123` px at 96 DPI, padding `26` (`HN_PAGE_W/H/PAD` — `index.html:1746-1748`), `overflow:hidden`, `page-break-after:always` (`index.html:1840-1843`):

1. `PROFORMA 1` (`.pf-proforma`, 1.7em, 900)
2. `ANNA UNIVERSITY EXAMINATIONS NOV/DEC <year>` — year derived from the exam date (`index.html:1921-1922`)
3. `SEATING ARRANGEMENT`
4. `Centre: <centre_code> - <name>`
5. `Hall No: <canonical name>` — `Session: <raw>` — `Date: <dd.mm.yyyy>`
6. Seating table — one `<th>` per physical column, one `<tr>` per bench row, each cell listing seat label / `REGISTER NO.` / `DEPT`
7. `SUBJECT SUMMARY` (informational only) and `TOTAL:` in a bordered flex row
8. Two signature boxes: *Name and sign of the Hall Superintendent* · *Chief Superintendent Signature with College seal*

All internals are **`em`-based**; the page's inline `font-size` is `12 * M.scale` px (`index.html:1952`), so the whole notice shrinks together. The budget is decided **before** rendering by `hnNoticeMetrics`, never discovered by the browser.

`hnNoticeMetrics(nRows, maxSeats)` — `index.html:1824-1832`:
```js
const head = 96, summary = 48, sign = 78, gap = 8;
const tableH = Math.max(120, HN_PAGE_H - 2*HN_PAGE_PAD - head - summary - sign - 3*gap);
const rowH   = tableH / Math.max(1, nRows);
let s = (rowH - 6) / (maxSeats * 30);          // cellBase = 30
s = Math.max(0.42, Math.min(1, s));            // floor 0.42, ceiling 1.0
```

`hnNoticeLayout(group)` — `index.html:1776-1818` derives the real grid: columns = `max(layoutConfig.columns.length, 1 + max saved colIdx)`, seats-per-column from `layoutConfig.columns[].seats` (widened if a saved seat uses more slots), rows = `max(numbenches, 1 + max saved rowIdx)`, aisles from `aisleAfter`. **Extents only ever grow, so a layout edited smaller can never drop an already-saved seat.**

### 4.3 Where it lives

| Item | Line |
|---|---|
| `downloadHTMLAsPDF` (vanilla block) | `807` |
| `hnNormHall` / `hnCanonDate` / `hnCanonSession` | `1397` / `1404` / `1405` |
| `hnBatchKey` / `hnSeatLabel` / `hnSeatKeys` | `1409` / `1416` / `1426` |
| `resolveHall` | `1440` |
| `hallNoticeOptions` / `hallOptionSeats` | `1471` / `1509` |
| `findPlanHallSessionConflicts` / `describePlanConflicts` | `1530` / `1588` |
| `auditHallNoticeCollisions` | `1601` |
| `hallNoticesGroup` | `1654` |
| `hnNoticeOrder` | `1709` |
| `HN_PAGE_W` / `HN_PAGE_H` / `HN_PAGE_PAD` | `1746-1748` |
| `hnEscapeHtml` / `hnFormatDate` | `1750` / `1757` |
| `hnNoticeLayout` | `1776` |
| `hnNoticeMetrics` | `1824` |
| `hnNoticeStylesheet` | `1834` |
| `hnRenderNoticePage` | `1877` |
| `buildHallNoticesDocument` | `1979` |
| `hnAuditNotices` | `2005` |
| `generateHallNoticesProforma` | `2027` |
| Window exports | `2073`, `2074`, `2077`, `2082` |
| `HallNoticePage` (nav `index.html:4564`) | `12383` |
| Dead legacy generators — `window.generateHallNotice`, `window.generateSingleHallNotice` | no call sites; do not resurrect |

The generator lives in the **Babel block** and is explicitly exported to `window.*` (the same pattern as `addAuditEntry`) because the vanilla block can be skipped by the browser under live-server injection. React handlers call it **only** via `window.X`.

### 4.4 Generation algorithm

1. `hallNoticesGroup` iterates **every** exam, reads `seatingPlans[exam.id]`, and for each hall key pushes one row per saved seat carrying `regno, dept, seatNo, seatLabel, bench, slot, colIdx, rowIdx, colLabel` plus the exam's `subjectCode` (summary only). Rows without a `regno` are skipped. Optional `date`/`session`/`hallId` filters; the hall filter accepts the canonical id, the raw plan key, or the resolved id (`index.html:1675`).
2. Rows are grouped by `hnCanonDate(date) + "|" + hnCanonSession(session) + "|" + hallId` (`index.html:1692`).
3. `hnNoticeOrder` sorts: explicit session rank (`FN`=0, `AN`=1, others=2 then alphabetical) → `halls` array index of the canonical hall → date → hall id (`index.html:1724-1734`).
4. `hnRenderNoticePage` applies **first-wins** survival twice: per **student** (`hallId|date|session|regno`) and per **seat-identity key** (`index.html:1884-1901`). Drops are logged, never silent.
5. Occupied seats are indexed by all four identity keys (`index.html:1904-1905`).
6. The subject summary is **rebuilt from the surviving rows**, so it always sums to `TOTAL`; `TOTAL = kept.length` (`index.html:1916`) — every occupied physical seat in the hall. A row with no `subjectCode` lands in an explicit `UNSPECIFIED` bucket and is logged.
7. The **full physical grid is always emitted** — `nRows × nCols × seats`, with unoccupied seats drawn as `<div class="cell empty">` carrying only their label (`index.html:1929-1950`). Gaps stay gaps; students are never shifted forward to fill one.
8. The printed `Hall No:` is the canonical `resolveHall` name, never a per-seat or per-plan field (`index.html:1920`).
9. `buildHallNoticesPrintDocument` composes the pages: FN + AN of the same date + physical hall → **ONE** A4 portrait sheet (`<div class="pf-page pf-combined">` with each half `hnRenderNoticePage(g, col, "half")`); a single-session hall → one **full** `hnRenderNoticePage(g, col, "full")` page. So for a date + hall with both sessions, `pages.length === halls-with-both-sessions`, not `notices.length`. The legacy `buildHallNoticesDocument` (one full page per notice, `pages.length === notices.length` always) is kept exported for determinism tests but is not the export path.
10. `hnAuditNotices` emits the per-notice and compose audit (`index.html:2005-2023`).

### 4.5 One hall = one sheet is structurally guaranteed

| Mechanism | Line |
|---|---|
| One group renders exactly one `<div class="pf-page">` (full mode) | `index.html:1991` |
| FN + AN of one date+hall render as EXACTLY ONE `<div class="pf-page pf-combined">` (two complete halves, 2px rule) | `index.html:2144-2181` |
| The page is a fixed `794×1123` box with `overflow:hidden` | `index.html:1884-1886` |
| Header, summary, `TOTAL` and signatures are **inside** that box | `index.html:1991-2106` |
| `page-break-after:always` + `break-inside:avoid` | `index.html:1886` |
| `pages = byKey.map(…)` — never a split of one notice | `index.html:2164-2181` |
| PDF adds exactly one page per `.pf-page`, never tiles | `index.html:842`, `:837-839` |

**Therefore: a "two-page notice" is two NOTICES (two different halls or two dates), never one long notice — and one hall with FN + AN on the same date renders as ONE combined sheet, FN top / AN bottom.**

### 4.6 Input contract

```js
opts = { exams, seatingPlans, halls, date?, session?, hallId?, download?, filename? }
college = { name, centre_code }
```

One saved seat (`seatingPlans[examId][hallId].seats[]`) is addressed by up to four keys — see §0.2. Legacy plans may store **only `seatLabel`** (e.g. `A1.1`) with no `seatNo`/indices; the grid still renders them at the matching physical label.

### 4.7 Entry point and file naming

`generateHallNoticesProforma(opts, college)` — `index.html:2222`.

- Always builds through `buildHallNoticesPrintDocument` (`index.html:2228`), so the on-screen preview, the print window and the downloaded PDF are the same combined document. The old `buildHallNoticesDocument` per-page path is no longer the export path (kept exported for determinism tests).
- `opts.download:true` → `downloadHTMLAsPDF(safe, css, bodyHTML, ".pf-page")` (`index.html:2056`), guarded at `:2052-2055`.
- Otherwise a print window with `window.print()`; the closing tags are **split** (`'<scr'+'ipt>'`, `'</'+'body></'+'html>'`) because live-server injects its reload script before the first literal `</body>` (`index.html:2062-2066`).
- Filename: `opts.filename` **always wins** (`index.html:2050`). The UI supplies `Hall-Notice_<hall name>` and `Hall-Notices_All` (`index.html:12429`, `:12436`), so the `picked` fallback at `index.html:2044-2049` is dead from the UI. Sanitiser: `[^A-Za-z0-9._-]+ → "_"` (`index.html:2051`) — can leave a trailing underscore.
- All-halls mode writes **one** `Hall-Notices_All.pdf` containing N pages — correct, not per-hall.

### 4.8 Debug instrumentation

`hnDebug(...)` (`index.html:1388`) shows unless `window.__HN_DEBUG__ === false`. Permanent anomaly tags — **each one means a saved-data anomaly was found and handled first-wins**:

| Tag | Meaning | Line |
|---|---|---|
| `[HN-DEBUG] seat-collision` | two saved rows resolved to the same physical seat; the later was dropped | `1895` |
| `[HN-DEBUG] duplicate-regno-in-hall` | one student held two seats in the same `hallId\|date\|session` | `1888` |
| `[HN-DEBUG] missing-subjectCode` | row landed in the `UNSPECIFIED` summary bucket | `1913` |
| `[HN-DEBUG] unresolved-hall` | `resolveHall` returned `null` for a plan key | `1677` |
| `[HN-DEBUG] summary-total-mismatch` | summary ≠ `TOTAL` guard | — |
| `[HN-DEBUG] notice` | per notice: `index, totalNotices, hallId, hallName, date, session, rows, grid, batches, subjectCodes, departments, fitScale, pagesForThisNotice:1` | `2014-2020` |
| `[HN-DEBUG] page-compose` | `{ notices, pages, mode }` | `2022` |

`hnBatchKey` = first 6 digits of the regno (`index.html:1409`) — used **only** for the audit log, never for grouping.

### 4.9 Why one hall can still produce two pages — verified

All five paths were reproduced against the real generator. Three are by design; two are defects.

| # | Cause | Pages | Status |
|---|---|---|---|
| 1 | LH-2 has **FN and AN** on the same date | 2 | **By design** (§4.1) |
| 2 | LH-2 has students on **two different dates** | 2 | **By design** |
| 3 | Same date saved in **two formats** (`2026-12-01` vs `01-DEC-2026`) | 2 | **Defect D6** — both pages print `Date: 01.12.2026`, so they look like exact duplicates |
| 4 | Duplicate hall records named `LH-2` where the **first record has no `layoutConfig`** | 2 | **Defect D2** — `resolveHall` `index.html:1461`; both pages print `Hall No: LH-2` |
| 5 | Same hall saved as `LH-2` **and** `LH 02` | 2 | **Data hygiene** — `hnNormHall` gives `lh2` vs `lh02` |

Cosmetic **session** variance (`AN` / `AN ` / `an`) is already handled — one page.

**Diagnosis procedure:** click **Generate Hall Notice**, read the `[HN-DEBUG] notice` lines. Two lines sharing `hallName`:
- different `session` → cause 1, expected
- different `date` → cause 2, expected
- same `date` and `session`, different `hallId` → cause 4 or 5
- same `date` text, yet both pages print the same `Date:` → cause 3

The UI also shows `"{notices} notice(s) · {pages} A4 page(s)"` (`index.html:12470`) — if `notices > 1` for one hall, the split is in the data, not the renderer.

---

## §5. Cross-cutting invariants

Check these on **every** change to any of the four domains.

1. **The §0.2 bench formula is identical in all 6 implementations.** A divergence silently moves every student.
2. **A seat's saved identity equals its rendered identity.** `hnSeatKeys` gives 4 aliases; index and look up by all 4.
3. **Never derive a seat's position from an array or filter index.** Only from `hallId, seatNo, seatLabel, bench, slot, colIdx, rowIdx, colLabel`.
4. **Positions that were not saved are never invented.** Grid extents only grow.
5. **A seat renders in exactly the cell its saved fields point to** — including legacy plans that store only `seatLabel`.
6. **Empty valid seats remain.** A gap mid-column stays a gap; students are never shifted forward.
7. **Notices are read-only projections.** They never allocate, re-run, re-order or re-place a seat.
8. **Preview, print and PDF render byte-identical documents** — one builder (`buildHallNoticesPrintDocument`), one stylesheet (`hnNoticeStylesheet`).
9. **Preview, print and PDF render byte-identical documents** — one builder (`buildHallNoticesPrintDocument`), one stylesheet (`hnNoticeStylesheet`). Composition: one sheet per (date, hall) — FN + AN stacked when both exist.
10. **Never add a dimension to a grouping key.** Notice: `date|session|hallId`. Nothing else.
11. **The save guard runs before any write**, in all three roots (§2.8).
12. **First-wins on every collision**, and every drop is logged — never silent.
13. **Deterministic output.** Identical input → byte-identical plan and notice. No RNG anywhere in the engine.

---

## §6. Defect register

Ordered by impact. Every one is reproducible against the current `index.html`.

| ID | Sev | Defect | Evidence |
|---|---|---|---|
| **D1** | High | The layout **editor allows 6 seats per column**; every consumer clamps to **4**. The UI counts 6, the engine seats 4 — silent capacity loss and a UI/engine disagreement. | `index.html:5309` vs `:2475`, `:2537`, `:4335`, `:4388`, `:8150`, `:11867`, `:12072`, `:1796` |
| **D2** | High | **`resolveHall`'s canonical snap fails** when the first hall record with a given name has no `layoutConfig`, so one physical hall resolves to two canonical ids → **two hall notices with identical `Hall No:`**. The snap should key on name identity alone, using the layout only as a tiebreak. | `index.html:1461`; reproduced §4.9 cause 4 |
| **D3** | High | The Seating Arrangement PROFORMA title prints **`PR0F0RMA 1`** — digit zero, not letter O — on every export. | `index.html:745` |
| **D4** | High | `seatsPerRowFromLayout` has **no clamp**, so the persisted `hall.capacity` and the editor total can exceed `calcHallCapacity`. `fixHallCapacities` repairs only absent or >2× values. | `index.html:5232-5239`, `:5717`, `:13109-13116` |
| **D5** | Med | The seating engine's documented **hard stop on rule conflict is gone** — it is now a forward search that never aborts. The guarantee in `PROJECT_DETAILS.md` §8/§18 no longer holds. | `index.html:2589-2594` vs `PROJECT_DETAILS.md:179`, `:462` |
| **D6** | Med | **No date-format validation anywhere on the manual exam path**, and `hnCanonDate` normalises whitespace but not format. Two formats of the same physical date = two grouping keys = two hall notices with identical printed dates. | `index.html:7784`, `:1404`, reproduced §4.9 cause 3 |
| **D7** | Med | **Three inconsistent session/date comparison strategies** coexist (raw `===`, canonical, alias-expanded) — §0.3. Data saved one way is invisible to a check running another way. | `index.html:7763-7769`, `:12738`, `:1405`, `:6329` |
| **D8** | Med | `attAllocStreamState` is **global across all dates and sessions**, directly contradicting its own doc comment ("a hall used in FN is reusable in AN"). | `index.html:11852-11853` vs `:11888-11904` |
| **D9** | Med | The attendance attendance-sheet `fmtDate` mangles every non-ISO date (`01-DEC-2026` → `2026.DEC.01`) without throwing, and `sessionLabel` is a blind binary that prints "Afternoon" for anything that is not exactly `"FN"`. | `index.html:1017`, `:1018` |
| **D10** | Med | `ConflictCheckerPage` is **177 lines of unreachable dead code** — absent from both nav and router. `ExamResultsPage` and `AuditLogPage` are likewise orphaned. | `index.html:9100`, nav `:4555-4569`, router `:4641-4653` |
| **D11** | Med | `SeatSwapPage` does **not** swap `deptBlock` and does **not** re-validate, so a post-swap plan can silently change its `noSameDept` outcome. A `_tmp` scratch key is persisted onto the seat. | `index.html:9348-9361` |
| **D12** | Med | The PDF-import existing-exam match compares `e.subject` (which holds a *name* or *category* on other paths) against `group.subjectCode`, so it normally fails and **creates duplicate exams**. | `index.html:12738` |
| **D13** | Med | `deptBlockOf` groups on **case-sensitive raw** `st.dept` while both the placement gate and the validator compare `.toUpperCase()` — mixed-case data desynchronises blocks from comparisons. | `index.html:2515` vs `:2579`, `:2694` |
| **D14** | Med | Manual placement uses the **pre-`deptBlock`** rule check (no `sameBlock` exemption) and does **not** enrich `"GEN"` depts, so manual seats diverge from engine seats. | `index.html:4366-4367`, `:4394` |
| **D15** | Low | `aisleSeats` is read in 4 places but **written by nobody**; `setSeats` actively clears it. The aisle-in-column feature is dead. | `index.html:5236`, `:5246`, `:5622`, `:5817`, `:5309` |
| **D16** | Low | `HallLayoutBuilder`'s preview labels benches **row-major** (`ri*cols+ci+1`) while the engine numbers column-first. Display-only, but misleading. | `index.html:5447` vs `:2555` |
| **D17** | Low | No upper clamp on `numbenches` via the `+` button or `saveHall`; `max="500"` is browser chrome only. | `index.html:5350`, `:5707`, `:5347` |
| **D18** | Low | The PDF-import collision guard runs **inside the per-group loop**, so it is not atomic across groups — groups saved before a clash stay saved. | `index.html:12708`, `:12788` |
| **D19** | Low | PDF import hard-codes `studentsperbench: 1` and `capacity: grpSeats.length`, inconsistent with every other writer's `rows × rowWidth`. | `index.html:12723`, `:12726` |
| **D20** | Low | `buildSeatingReport`'s `emptySeats` only counts halls present in `plan`, so it under-reports when generation stops early. | `index.html:2731` vs `:2632` |
| **D21** | Low | Diagnostics labels are wrong twice — "T1–T29" and "16 synthetic assertions"; actual is **51 cases / 4 suites** and **17** seating cases. | `index.html:10765`, `:10772` |
| **D22** | Low | Dead parameters: `buildSeatingReport` accepts and never reads `hallUsedSeats`; `generateAttendanceAutoAllocation` accepts and never reads `exams`. | `index.html:2727`, `:11983` |
| **D23** | Low | Quick layout presets carry no `recommended: true`, so the "✓ RECOMMENDED" ribbon is unreachable. | `index.html:5918-5921`, `:5929` |
| **D24** | Low | `annaRegno`, `resolveDept` and `ALPHA` are each defined more than once; the last definition silently wins. | `index.html:637`/`:1100`, `:650`/`:3187`, `:8151` |
| **D25** | Low | `generateHallNoticesProforma` guards `window.hallNoticesGroup` but then calls `buildHallNoticesDocument` **unguarded** — the guard protects nothing. | `index.html:2029-2033` |
| **D26** | Low | Documentation drift: `PROJECT_DETAILS.md` §9 describes a Hall Notice PDF that no longer exists, §19.3–19.7 describes CSV/XLSX/DOCX curriculum parsers that do not exist, and §8/§18's dept-code table contradicts `BRANCH_CODE_TO_DEPT`. | `PROJECT_DETAILS.md:221-224`, `:563-564`, `:228` |

---

## §7. Verification

### 7.1 In-app

Developer Dashboard → **Diagnostics** (`index.html:10208-10210`) runs all four suites and renders a pass/fail table (`index.html:10733`). Expect **51 cases**.

### 7.2 Out-of-app

Node harnesses live in `C:\Users\AKASH\AppData\Local\Temp\opencode`. They extract the needed functions from `index.html` with `@babel/parser` and evaluate them in a `vm` sandbox, so they test the **real** shipped code rather than a copy.

```
node extract_babel.js "D:\SEATING PROJECT\ExamSeatPro_v66_secure\index.html" babel_block.js
node parse_check.js babel_block.js
node <suite> babel_block.js
```

| Suite | Proves |
|---|---|
| `proforma_test.js` | Grouping, `TOTAL`, summary, one-hall filter, combined exams, legacy-label render |
| `proforma_edge_cases_test.js` | Seat collision (first-wins + log), layout shrunk below saved indices, missing `subjectCode` → `UNSPECIFIED`, duplicate regno, one hall keyed 3 ways → one notice |
| `proforma_batch_merge_test.js` | 3 batches + 2 subjects + 3 plans in one hall/date/session → **1 group, 1 page**; `findPlanHallSessionConflicts` allows disjoint seats; `auditHallNoticeCollisions` is non-mutating |
| `hall_onepage_test.js` | a date+hall with FN and AN exports as **ONE combined A4 sheet** (FN top / AN bottom, both complete); a 4×14×3 hall stays on one page; preview === print === PDF byte-identical |
| `hall_lh1_lh7_test.js` | 7 halls × 2 sessions = **14 notices, 7 combined sheets**, correct order, no foreign students, empty seats preserved |
| `hall_notice_pdf_test.js` | `opts.download:true` → `downloadHTMLAsPDF(..., ".pf-page")`, no print window, filename sanitised |
| `pdf_pagination_test.js` | The real `downloadHTMLAsPDF` against a stubbed DOM/jsPDF: one notice = one page, **never tiled**, clamped, zero-size canvas skipped, holder removed on every path |
| `hall_options_test.js` | Dropdown dedupes by normalized name; option id equals the notice's `hallId` |
| `attalloc_test.js`, `pdf_import_test.js`, `pdf_attendance_test.js`, `pdf_curriculum_test.js`, `pdf_schedule_test.js` | Attendance allocation + the three PDF parsers — must stay untouched and green |

### 7.3 Hall-notice regression protocol

1. Reproduce with the real saved data; read the `[HN-DEBUG]` console output after clicking **Generate**.
2. Per notice confirm: all hall students present, no foreign-hall students, combined exams on one page, seats in their saved positions, no duplicates, `pagesForThisNotice: 1`, and `page-compose` showing `combinedSheets` = number of (date, hall) pairs with both sessions and `pages` = sheets (single-session halls count 1 each).
3. If `pages` exceeds the expected count, the saved `date`/`session` values differ **cosmetically** — that is the split to look at, **not** batch or year.
4. If `TOTAL` is lower than the number of students placed, two plans claim the same physical seat: run `auditHallNoticeCollisions(exams, seatingPlans, halls)` and fix the reported overlap.
5. If the two pages look identical, apply the §4.9 diagnosis table.

### 7.4 Don't touch

When working on any of these four domains, do **not** modify: `placeStudentsInHalls`, `generateSmartSeating`, `validatePlan`, `validateGenderSeparation`, `deptBlockOf`, `attAllocHallSeatDefs`, `attAlloc*`, the Hall Layout Editor or its seat inventory, the manual seating modal, `Store.setSeatingPlan`, any Firebase structure, or `numbenches`/capacity calculations. Notices only *read* engine output; exams only *define* it.

---

*Generated against `index.html` @ 13,416 lines. Line numbers drift on every edit — re-verify before acting. The in-app Diagnostics suite and the Node harnesses are the authority on behaviour, not this document.*
