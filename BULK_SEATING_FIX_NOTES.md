# Bulk Seating by Date — targeted fix

## What changed

- Bulk hall selection now treats `hallids` as preferred candidate halls, not reservations before an actual seating plan exists.
- Existing plans for another exam in the same date/session reserve their halls; ungenerated exams do not block the whole candidate pool just because they list the same halls.
- If a selected/preferred hall is insufficient for a rule such as split-gender seating, the bulk generator expands to other free halls of the same hall type.
- Course titles are not treated as hall types. If the exam's `subject` is not one of `University`, `CAT`, `Lab`, or `Other`, bulk selection falls back to `exam.hallType` or `University`.
- When `No Same Department Side-by-Side` or CAT bench adjacency is enabled for an exam containing only one department, the impossible rule is explicitly disabled for that exam and shown as a warning in the per-exam result. The app no longer silently labels the rule as applied in this case.
- Added regression tests for course-title hall selection, a 31-student split-gender single-department exam with one preferred hall, and ungenerated exams sharing candidate hall IDs.

## Verification

- Targeted Node smoke test against the extracted current functions: PASS — 31 students placed across two separate gender halls; course-title exam resolves to University halls.
- `node --check` passed for the edited test and harness JavaScript files.
- Full `node run.js index.html` suite could not be run in this environment because `@babel/parser` is not installed. The project intentionally keeps that test-only dependency out of the deployed app. Use the project's documented `NODE_PATH` setup to run the complete suite on the development machine.
- Authenticated Firebase/browser save workflow still needs a manual check in the user's local environment.

---

## Follow-up fix (2026-10-10): No Same Department physical side-by-side + authoritative save guard

### Reported bug
In Bulk Seating by Date with ONLY *No Same Department Side-by-Side* on (CAT Bench
Adjacency **not** toggled), a saved LH-1 plan dated 2026-10-14 FN still seated
"ARTS & SCIENCE / AID S" students next to each other. Dept column: BSMS, branch
AID S, result "UNIVERSITY EXAM".

### Root cause
With only `noSameDept` on, `benchAdjacency` stayed false, so the old engine ran a
**legacy** University path that:
1. never inspected the same-bench slot immediately to the left (`slot-1`) —
   same-bench neighbours like `A1.1`/`A1.2` were invisible to it; and
2. exempted a same-department **column spill** via the `deptBlock` same-block
   carve-out, so department blocks could legitimately start (and run) directly
   beside themselves in the physical grid.

Repeated on the fixture (16x "AID S" + 1 MECH on LH-1's 6 rows x three 2-seat
benches), the legacy allocator seated all 17 but with **five** same-dept
side-by-side pairs (`A1.1/A1.2`, `A2.1/A2.2`, `A3.1/A3.2`, `A5.1/A5.2`,
`A6.1/A6.2`) while the old validator reported **0** violations.

### Fix (index.html)
- New gate `sideBySideRulesActive(students, rules)`: the single authoritative
  on/off for every side-by-side rule. Active iff any of `benchAdjacency |
  noSameDept | noSameYear` is set **and** the student pool can actually satisfy
  it (>= 2 distinct normalised departments for dept rules, >= 2 distinct years
  for the year rule). Departments normalise via `String(...).trim().toUpperCase()
  || "GEN"`.
- `placeStudentsInHalls`: now uses ONE physical facing-seat model for every
  side-by-side rule — a seat is constrained only by the slot immediately to its
  left in the SAME bench and, for a bench's leftmost slot, the rightmost filled
  seat of the previous bench in the same row. Rows are never compared. The
  legacy whole-previous-bench branch and the `deptBlock` column-spill exemption
  are **removed**, so `A4.1 (MECH)` now sits with `A4.2 (AID S)` and the AID S
  block is interleaved instead of side-by-side.
- `validatePlan`: replaced with the same physical model; the gate uses the
  **whole plan's** student pool, so a plan that is provably satisfiable is
  validated, a plan that is not (a saved adjacency) is refused with
  "Department adjacency violation" and blocks saving.
- `seatViolations` (manual placement warning): uses the same gate + physical
  model, so hall admins are warned against exactly what the allocator enforces
  and the validator refuses.
- In-browser `runSeatingDiagSuite` T5/T6/T7 comments updated to the physical
  model; T8 no longer asserts `deptBlock`, only the contiguous A→B single-dept
  block with rule self-off.
- CAT behavior is unchanged; `cat_bench_adjacency.test.js` T9 was updated to pin
  the corrected noSameDept-alone semantics (two departments keep a same-bench
  neighbour but the engine interleaves).

### Tests (`seating_rule_violations.test.js`, 20 cases, registered in run.js)
- S1: LH-1 fixture (16x "AID S" + 1 MECH) under `noSameDept` only — 17 placed, 0
  unplaced, 0 physical same-dept pairs, MECH physically interleaved, validator clean.
- S2: same roster, rules off — same-dept neighbours allowed (control).
- S3: bulk flow (`bulkGenerateOne`) with noSameDept only — clean plan, no
  "only one department" exception warning.
- S4/S5: validator flags same-bench and bench-boundary adjacency, ignores non-facing.
- S6: manual placement cannot bypass the rule (structural integrity stays clean).
- S7: duplicate regnos/records/seats refused after normalisation.
- S8/S9: capacity overflow and aisle/beyond-slot seats are structural blockers.
- S10: same hall + same date/session is a `hall_conflict`, never silent sharing.
- S11: FN and AN plans on one date are separate objects.
- S12: insufficient capacity fails the exam (unplaced reported, nothing saved).
- S13: retry upserts the same exam id once, never duplicates.
- S14: hall notice lists exactly the 17 seated students once each.
- G1-G6: `sideBySideRulesActive` boundary cases (single-department auto-off,
  two departments on, trim/case collapse, "AID S" vs "AIDS" are distinct stored
  values, one-year rule off, empty/no-rules off).
- `cat_bench_adjacency.test.js` T9 now demonstrates same-bench prevention
  without benchAdjacency (A1.1 CSE, A1.2 empty, A1.3 CSE, B1.1 ECE).

### Verification
- `node --check` on `index.html`-adjacent JS, `harness.js`, `run.js` and the new
  test file: PASS.
- Full `node run.js index.html`: **508 passed, 0 failed** (baseline 488 before
  this task; the 20 new cases all pass, existing CAT/bulk/integrity/notice
  suites unchanged and green).
- Reproduction of the legacy bug was confirmed by code trace and fixture
  simulation (the old branch is what the new tests assert against); the new S1 +
  T9 would fail on the pre-fix engine.
- Browser verification remains **not performed**: no Playwright/Puppeteer
  tooling or Firebase credentials exist in the project tree (only
  `firebase-rtdb-rules.json`, which is rules, not a key). Headless Chrome exists
  at `C:\Program Files\Google\Chrome\Application\chrome.exe` but the app needs an
  authenticated Firebase session. A manual in-app check of Bulk Seating by Date
  -> LH-1 (2026-10-14 FN, AID S + MECH) is still required in the user's
  environment.

---

## Follow-up fix (2026-10-10): declared capacity respected + truthful unplaced reasons

### Reported bug
Bulk Seating by Date on **14-10-2026 FN** saved **13 of 14** exams and **failed
1**: 61 students (16x AID S + 45x MECH) against LH-1's **declared capacity 45**,
16 unplaced — but the failed exam's reason blamed **No Same Department
Side-by-Side**, not capacity. Separately, seat counts disagreed across screens
(selector/preview/hall cards vs the saved plan) because different paths used
different capacities for the physical halls.

### Root causes (from code, no live data needed)
1. **Two competing hall capacities.** The allocator computed capacity from the
   hall *layout* only: `calcHallCapacity = hallPhysicalCapacity = nRows x slots`
   (`hallSeatSlotsPerRow(hall)`), so LH-1 could physically seat `6 rows x 9
   slots = 54`, while the persisted `hall.capacity` = **45** was treated as the
   hall's declared/authoritative count on some display screens. Every surface
   (bulk totals, sort order, plan builder, previews, hall cards) read a
   different number depending on which helper it called.
2. **Reason misattribution.** `placeStudentsInHalls` picked the unplaced reason
   purely from `rules.noSameDept || rules.noSameYear`, unconditionally blaming
   "No legal seat satisfies the active rules" even when no rule had ever
   rejected any seat. A pure capacity overflow in a rule-enabled exam was
   therefore misreported — exactly what 14-10-2026 showed.

### Fix (index.html)
- **One authoritative capacity.** `hallConfiguredCapacity` = validated
  `hall.capacity` (finite number ≥ 0, else null). `hallUsableCapacity(hall)`
  = `min(configured ?? +Infinity, physical)`, falling back to physical when no
  capacity is declared. `calcHallCapacity` now returns `hallUsableCapacity`, so
  every current and future caller reads the same number. `hallCapacityConfigError`
  reports `declared > physical` (bounded to physical and surfaced as a warning
  in hall cards and the bulk rows/preview/modal).
- **Allocator honours the declared bound.** `placeStudentsInHalls` tracks a
  per-hall counter against `hallUsableCapacity`, fills the first eligible hall
  to its exact declared count before moving on (first-hall-first stays
  deterministic), and writes `hp.capacity = hallUsableCapacity(hall)`. The
  unplaced reason is now truthful: `anyRuleRejected` records whether an *active*
  rule ever rejected a seat (rule off/disabled, e.g. a single-department exam,
  cannot trigger the rule message), otherwise the reason is "Hall capacity
  exhausted (eligible halls have no remaining seat for this student)".
- **Guardrails.** `planIntegrityProblems` bound = `min(valid hp.capacity,
  physical)` and validates the plan against the physical grid, so an over-45
  save is structurally impossible. Manual placement `placeHere` refuses a drop
  once the hall's usable capacity is reached and records the same hp.capacity.
- **Bulk flow and UI.** `bulkGenerateOne` unplaced reason now includes the
  first unplaced student's real reason; `hallCapacityWarningsFor(exam, halls)`
  (explicit `exam.hallids` only) threads `capacityWarnings` through
  `bulkGenerateOne`/`runBulkSeating` into the bulk modal rows, preview and done
  report. Dashboard/halls-page counts and the exam-hall picker now read
  `hallUsableCapacity`.

### Tests (`bulk_capacity_fix.test.js`, 13 cases, registered in run.js)
- usables: declared ≤ physical kept; declared > physical bounded **and** flagged
  as a config error; legacy halls (no capacity) bounded by layout; invalid
  capacity values ignored; identical value across all surfaces.
- integrity: exactly the declared 45 passes, 46 overflows; a generated plan that
  respects the bound passes `planIntegrityProblems`.
- allocator: a declared-45 hall seats exactly 45 of 50; two halls fill
  first-hall-first (45 then 9); each plan entry's `capacity` == usable.
- reasons: the **16 AID S + 45 MECH on single-column LH-1 (54 physical/45
  declared)** repro reports 16 unplaced with a **capacity** reason, never the
  rule; a genuinely adjacency-stranded roster (single row `[2,2]`, 2 CSE + 4
  MECH) still reports 3 strandings with the **rule** reason (rule message is not
  lost, only no longer fabricated).
- bulk: `bulkExamRows` marks the over-declared hall; the full **14-10-2026 batch
  repro** (13 small exams pinned to lh2–lh14, big exam pinned to LH-1) yields
  **13 saved, 1 failed, 16 unplaced**, a capacity reason, and the failed exam is
  never saved.

### Verification
- `node --check` on `bulk_capacity_fix.test.js`, `harness.js`, `run.js`: PASS.
- Full `node run.js index.html`: **521 passed, 0 failed** (508 before this
  round; the 13 new cases pass, all existing suites unchanged and green —
  including the hall-notice/hall-integrity tests that still rely on
  layout-derived capacity without a declared `capacity` field, and the 20
  seating-rule cases).
- The 14-10-2026 failure shape is reproduced deterministically by the batch
  repro test with sanitised data: **13 saved / 1 failed / 16 unplaced** / truthful
  capacity reason / nothing saved for the failed exam.
- LH-1's `14-10-2026 FN` saved plan is read-only in the repo; neither the fix
  nor the tests modify or re-save it. To apply the fix to that date the user
  must re-run Bulk Seating by Date in the browser (declared 45 will now be
  enforced, the second selected hall will absorb the remainder, and the failure
  reason will be truthful if any remainder is really unplaceable).
- Browser verification remains **not performed** for the same reasons as above
  (no Playwright/Puppeteer tooling, no Firebase credentials in the tree). A
  manual in-app re-run of Bulk Seating by Date on 14-10-2026 FN is still
  required.

---

## ROUND 3 — CAT capacity / side-by-side / retry truthfulness (10-2026)

### Problem A — CAT exam under-use (14-10-2026 FN "Foundations of Robotics": 17 eligible, 0 assigned, all 17 "unplaced", reason "Hall capacity exhausted"; retry repeats)
Root causes found in `index.html` and fixed:
- Single-exam auto-pick compared `(h.hallType||"University") === exam.subject` — a course TITLE was matched against hall TYPES, so a CAT exam with no hallids got zero halls and totalCap 0. Now: `examHallTypePool(exam).indexOf((h.hallType||"University")) >= 0`.
- `bulkSelectHalls` type fallback `exam.hallType || (knownTypes.has(subject)?subject:"University")` had the same course-title problem. Now falls back through `examHallTypePool`.
- `bulkExamHallCapacity`/`hallCapacityWarningsFor` matched `exam.hallids` literally against `h.id`, so hallids keyed by name/alias reported capacity 0. Now resolved via `hallByIdOrName`.
- `runBulkSeating` swallowed `loadPlan` throws as `null`, so a plan that FAILED to load looked free. Now: `loadPlan` throw → result `{status:"failed",code:"data_load_failed",category:"DATA_LOAD_FAILED"}`, a sentinel reservation from `exam.hallids`, and the exam is never silently regenerated.
- Immediate fix for the 14-10-2026 date still requires re-running bulk seating in the browser (engine is fixed and proven by tests against a sanitised replica).

### Problem B — same-dept side-by-side under No Same Department Side-by-Side (CAT layout)
- Bonus validator: `adjacencyImpossibility(roster, rules)` — a single-department roster makes `noSameDept` impossible; it is now SURFACED (`unsatisfiableRules`) instead of `sideBySideRulesActive` auto-disabling silently.
- `bulkGenerateOne` keeps producing for single-dept rosters but reports `unsatisfiableRules:["noSameDept"]`.
- Manual placement and manual save are now hard-gated by `manualRuleGate` when an enabled rule is violated (the old `window.confirm` override was removed).

### Problem C — failed regen hides the old plan
- `runBulkSeating`: a failed regeneration over a prior plan returns `keptExisting:true`, keeps `plansById[exam.id]` untouched, and the summary counts it under `preserved`.
- Single-exam flow: `lastSeatingGenFailure` is set on every failure path where an older saved plan exists and cleared on save; the Seating Plans header shows a stale banner, the manual-placement header says the previous plan is preserved, and batch result rows render `Previous plan preserved — it was NOT replaced by this failed run.` plus `unsatisfiableRules`/`ruleWarnings`/`capacityWarnings`.

### Tests
- New `cat_seating_repair.test.js` (registered in run.js): A1/A1b/A2/A3/A4/A5 (capacity + type pool), B1/B1b/B2/B3/B4 (adjacency + gates), C1 (retry truthfulness). All 9 defect cases failed on the pre-fix code (run showed 524 passed / 9 failed) and pass after the fixes.
- Full `node run.js index.html`: **533 passed, 0 failed** (521 baseline preserved + 12 new).
- Independent harness audit `verify_catrepair.js`: **23/23 passed**.
- `node --check` on `cat_seating_repair.test.js`, `run.js`, `harness.js`: PASS; `cat_extract.parseAll` parses index.html cleanly (6 blocks).

### Not verified (unchanged constraints)
- No Playwright/Puppeteer and no Firebase credentials → live browser/database runs are still the user's final acceptance step: back up `examSeatPro_backup_*.json` first, then re-run the 14-10-2026 FN bulk seating (use per-exam Retry with overwrite for the failed exam).

---

## ROUND 5 — CAT bulk co-seating: LH-1 fills 45 department-interleaved, split-save, one hall owner (10-2026)

### Reported bug
With CAT rules `splitGender + No Same Department Side-by-Side` active, a CAT import
generated each exam ALONE on its own disjoint hall slice, so LH-1 (45 usable
seats) seated only the 17 eligible AIDS Year-II males while 28 eligible males
from the other departments of the same slot were pushed to LH-2. Proven by probe:
a combined 45-male pool fed to `generateSmartSeating` over [lh1, lh2] placed only
40/45 with LH-1 = 20 even after interleaved ordering alone.

### Root causes found in `index.html`
1. **Caller** — `commit()` looped each exam through `catAllocateHalls` +
   `generateSmartSeating` per exam, so every exam got its own hall slice and was
   generated alone. The 17-student AIDS exam took LH-1; the 28 others went to LH-2.
2. **Engine** — strict `byRegNo` order delivers departments in RUNS (AIDS-AIDS-
   AIDS) and the forward-scan rejected a seat and left it EMPTY (the same
   stranded-student gap that halved LH-1's occupancy). Interleaving the dept
   order alone still stranded 5/45 because the forward-scan never back-filled.
3. **Latent defect found while debugging** — `sideBySideRulesActive`'s coarse
   switch enabled the No Same Year sub-rule for ANY >=2-department pool, so a
   SINGLE-year cohort under `noSameYear` compared every neighbour as equal and
   mass-stranded the hall (44-/20-seat collapse). Each side-by-side SUB-rule is
   now auto-disabled independently (years < 2 → year rule off; depts < 2 →
   department rule off), with exact parity across the allocator, `validatePlan`
   and the manual-placement guard `seatViolations`.

### Fix (index.html)
- `interleaveByDepartment(students, rules)`: balanced round-robin over the
  regno-sorted roster (one student per department per round), with the surplus of
  an over-represented department (e.g. 17 AIDS vs 14 MECH vs 14 CSE) sprinkled at
  evenly spaced positions ACROSS the whole rotation — so no window of the queue
  is ever 3 of the same department, and the last 3-slot bench can always be
  filled (a `[AMC]×14 + AAA` tail was the 44/45 culprit). Deterministic: same
  roster → same hall assignment.
- `generateSmartSeating`: sorts by regno then interleaves when a department rule
  is active with >=2 departments.
- `placeStudentsInHalls`: seat loop replaced the forward-scan reject-leaves-empty
  with a `legalAt(cand)` predicate + EARLIEST-legal-remaining-candidate backfill
  (chosen student swapped into the cursor head). A hall now fills to its usable
  capacity before the next hall; a seat is left empty only when physically
  occupied or no remaining student is legal; `anyRuleRejected` still drives the
  truthful NO_LEGAL_SEAT vs HALL_CAPACITY_EXHAUSTED reason.
- `catCoSeatSlot(rows, halls, busyHallIds)` + `catSubPlanFor`: build ONE complete
  eligible pool per slot tagged with `examId`, size it by gender partitions via
  `catAllocateHalls`, generate ONE plan over the union of the slot's halls, then
  SPLIT back per exam on save (split-save, one hall owner: the shared hall's
  `hallids` stay on the first exam that occupies it; other exams share
  plan-based). Each exam's saved plan holds only its own students.
- `commit()` rewired: recs start with `hallids: []`; per-slot co-seat loop with
  awaited `Store.setSeatingPlan` / `Store.updateExam({seatinggenerated:true,
  hallids})`; `needAttention` on unplaced / plan-integrity / whole-slot errors;
  unplaced reasons "Adjacency-limited: N student(s) had no legal seat" and
  "Capacity-limited: ...".

### Tests
- New `cat_hall_fill_interleave.test.js` (registered in run.js), M1–M7: M1 one
  45-male pool (17 AIDS + 14 MECH + 14 CSE) fills LH-1 to 45 with 0 spill/0
  unplaced/0 adjacency pairs/validator clean; M2 46 males overflow exactly 1;
  M3 gender separation + male-first hall fill; M4 single-department truthfulness;
  M5 reservations honoured (occupied seats stay empty, all 45 still seated); M6
  caller-level combined generation + split-save (17 + 28 share LH-1's 45 seats,
  disjoint keys, per-exam identity); M7 `catCoSeatSlot` co-seats the slot (E1 owns
  hallids [lh1], E2 plan-based, plans reconstruct the merged 45). Pre-fix run: 1
  passed / 6 failed (M4 only).
- Updated pinned expectations (approved): `cat_bench_adjacency.test.js` T2/T3/T9/
  T11 — seats the old forward-scan left EMPTY are now back-filled with the next
  legal student while proving the same physical rules (a 2nd same-dept neighbour
  is still refused, a bench-separated same-dept pair is still legal, validator
  stays clean); `cat_seating_repair.test.js` B1b regex now matches the real
  validator message "Department adjacency violation: ..."; `bulk_capacity_fix
  .test.js` "genuine adjacency block" moved to a `[2,3]` + 2CSE/3ECE single-row
  fixture that truly strands the last ECE (the old `[2,2]` fixture now back-fills
  fully); `cat_live_repair.test.js` T3 uses a genuine NO_LEGAL_SEAT fixture
  (5-seat `[2,3]` hall, 5 students, 1 stranded by rule) beside a pure-capacity
  case.

### Verification
- Full `node run.js index.html`: **552 passed, 0 failed** (545 baseline preserved
  + 7 new M-cases; all updated pinned expectations pass).
- Independent audit `verify_hall_fill.js`: **21/21 passed** (re-plays the exact
  17 AIDS Y2 + 28 other males / LH-1 scenario through the app's own helpers).
- `diag_m6.js` harness cross-check: direct `generateSmartSeating` and
  `catCoSeatSlot` produce the SAME 45-seat LH-1 plan (45 placed / 0 unplaced,
  disjoint seat keys, per-exam identity kept) on the 17+28 fixture.
- `node --check` on `cat_hall_fill_interleave.test.js`, `cat_bench_adjacency
  .test.js`, `bulk_capacity_fix.test.js`, `cat_seating_repair.test.js`,
  `cat_live_repair.test.js`, `harness.js`, `run.js`: PASS; `cat_extract.parseAll`
  parses index.html cleanly.
- Not verified (unchanged constraints): live browser/Firebase + the real
  14-10-2026 data remain a manual step — regenerate the affected CAT date/slot in
  the browser and confirm LH-1 now seats the full 45 per gender block before the
  next hall is used.

---

## ROUND 4 - CAT Seating LIVE-FAILURE REPAIR (10-2026)

### Reported live failures (14-10-2026 FN)
- "Hall conflict: LH-18, LH-19 already assigned to another FN exam" toast stopped CAT regeneration even though both halls only needed seat-slot sharing.
- Reservations stored under a hall NAME/alias key did not block the same seats at generation time.
- Seating Plans showed 17 in a hall where the Hall Notice rendered 11 (same hall/date/session): the two views used different dedupe rules.
- A failed Retry did not clearly keep the old plan.

### Root causes found in `index.html` and fixed
- Busy-hall set for a single-exam regeneration collapsed every saved plan key to a HARD hall block, and compared raw date/session strings and raw hall ids. Now:
  * `canonicalHallId(halls, planKey, hp)` - every plan key (id/name/alias/legacy) collapses to the id `resolveHall` uses.
  * `hallUsedSeatKeys(hall, seat)` - a seat carries its canonical `hallId-B<bench>S<slot>` key even when the saved row only has `seatNo` or `bench`/`slot`.
  * `examReservationData(exam, exams, halls, seatingPlans, loadOtherPlan)` - returns `{ error, busyHallIds, hallUsedSeats }`. Plan-based usage SHARES a hall (seat-level set in `hallUsedSeats`); only an explicit other-exam `hallids` list is an exclusive `busyHallIds` hall block. The exam's OWN plan is never an external reservation. A plan load throw returns `error` so the exam stops (DATA_LOAD_FAILED) instead of generating into unknown occupancy.
  * `confirmAndGenerate` uses it: a genuine exclusive-hall pinch still shows the original "Hall conflict: ... already assigned to another {session} exam on {date}." toast; a shared hall with occupied seats is filled AROUND those seats.
- `bulkSelectHalls` now keys its busy set canonically (`canonicalHallId`), so an alias-keyed other-exam plan cannot look like a free hall in a batch.
- `bulkBuildHallUsedSeats` seeds both the raw `seatNo` and the canonical generator form, so alias-keyed plans skip real seats.
- The 17-vs-11 divergence: the Seating Plans grid deduped ONLY by seat keys while the notice also deduped by normalised regno. Fix:
  * `hallMergedUniqueSeats(exams, seatingPlans, halls, hallId, date, session)` - first-wins over seat keys AND regno, exactly matching `hnNoticeDedupeRows`; the Seating Plans Picker and its merge grid now use it.
  * `seatingPlanDuplicateRows(plan)` - duplicate-student/duplicate-seat rows in saved data are surfaced, and the hall-view modal shows a rose "stale/duplicated saved data" badge so a mismatch is never silently tolerated.
- The success-path duplicate scan that swallowed its plan read now pushes a `dupeWarnings` entry instead of silently ignoring the error; the removed `sameSessionExams` loop also deleted a colliding `const hallUsedSeats` redeclaration (potential syntax error).

### Regression tests
- New `cat_live_repair.test.js` (registered in run.js), 12 tests: T1 exact usable-capacity fill (min(declared, physical)); T2 first-hall-first spillover; T3 NO_LEGAL_SEAT vs HALL_CAPACITY_EXHAUSTED distinguished truthfully; T4 name/alias-keyed reservations honoured + hallids exclusive + sharing; T5 own plan never a conflict during regeneration; T6 DATA_LOAD_FAILED on unreadable plans, nothing saved; T7 department adjacency in generation and validation; T8 year adjacency in generation and validation; T9 manual gate + overflow cannot be bypassed; T10 failed retry keeps/flags previous plan; T11 Seating Plans merged count === Hall Notice total/picker count on one canonical hall; T12 successful retry persists and survives a reload.
- Full `node run.js index.html`: **545 passed, 0 failed** (533 baseline preserved + 12 new).
- Independent audit `verify_live_repair.js`: **12/12 passed** (re-plays the LH-18/LH-19 alias-keyed scenario, 17-vs-11 equivalence, DATA_LOAD_FAILED, preserved retry).
- `node --check` on `cat_live_repair.test.js`, `run.js`, `harness.js`: PASS.

### Not verified (unchanged constraints)
- No live DB/browser access: real 14-10-2026 data was never available, so counts above come from the harness + independent audit against equivalent fixtures. Final acceptance stays manual: back up `examSeatPro_backup_*.json`, regenerate the affected CAT exam in the browser (and re-run its bulk seat batch), confirm the Seating Plans Picker/Hall Notice totals agree, and confirm a failed Retry shows "Previous plan preserved".


---

## ROUND 6 — Bulk Seating cross-exam co-seating (implementation in uploaded working copy)

### Defect addressed
The tested bulk entry point previously called `bulkGenerateOne()` once per exam. `bulkSelectHalls()` then excluded a hall as soon as another same-date/session exam had any saved plan in that hall, even if most seats were unused. This kept the Bulk Seating by Date workflow separate from the CAT importer’s combined-pool helper.

### Changes made in this working copy
- Added `runBulkSeatingCoSeated(cfg)` and wired the Bulk Seating by Date modal to opt into it (`coSeat: true`). The original per-exam path remains available to existing unit tests/debug callers via the default path.
- Groups selected exams by normalized date, session, and resolved hall-type pool.
- Loads all saved plans for compatible same-slot exams before allocating. A failed read returns `DATA_LOAD_FAILED` for the group and writes no plans.
- Treats seats in saved plans outside the active overwrite group as occupied seat keys rather than hard-blocking every remaining seat in the physical hall.
- Tags each student with the source exam ID, generates one combined plan using the selected gender/department/year rules, then splits the result into per-exam plans.
- Assigns each used physical hall to the first exam occupying it; the bulk save callback persists `hallids` ownership and clears non-owner `hallids`.
- Adds `plansIncomplete`, `unreadPlanIds`, and `planLoadErrors` to the bounded initial loader result, and displays a warning in Bulk Seating when startup plan loading was incomplete.
- Added `bulk_co_seat.test.js` with synthetic acceptance tests for 17 AIDS males + 28 MECH males filling 45 seats, disjoint per-exam seat sets, hall ownership, no-same-department validation, incomplete-read no-write behavior, and FN/AN separation.
- Registered the new test in `run.js`; updated `harness.js` to include the new orchestrator.

### Validation status
- `node --check run.js harness.js bulk_co_seat.test.js data_load_resilience.test.js`: PASS.
- Acorn syntax parsing of the edited `runBulkSeatingCoSeated`, `runBulkSeating`, and `loadCollegeDataSet` function bodies: PASS.
- Full `node run.js index.html`: NOT RUN successfully in this environment because `@babel/parser` is not installed; the project’s test harness explicitly requires it. An attempt to install it timed out.
- Live browser/Firebase verification: NOT performed. No production data was changed by this code edit.

### Before live use
Review the new tests and run the full suite in the project’s configured environment with `@babel/parser` available. Do not overwrite the 14-10-2026 FN plans until the full suite and the real-browser acceptance checks pass.
