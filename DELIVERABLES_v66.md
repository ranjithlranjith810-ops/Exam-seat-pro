# ExamSeatPro v66 — Login, Bulk Delete & Retention Deliverables

Date: 2026-10-11. Branch context: working tree on top of `a2cb3ed`.
Everything below is **implemented and covered by the regression suite** — the
final run is **626 passed, 0 failed** (`node run.js index.html`), and
`node cat_parse_check.js index.html` reports `PASS: app block parses cleanly`.

---

## 1. Root causes found (phase 1 audit)

### 1.1 Login was serial — one plan read per exam
`App._load_exam_data` fetched **each exam's seating plan individually**
(`Store.getSeatingPlan(examId)`). Two properties of the dataset turned that into
a full-node read every time:

- seating plans carry no `college_id`, and
- the RTDB rules declare **no index** that could serve `orderByChild("exam_id")`.

So a query meant to be "one plan for exam X" actually downloaded the **entire
`/seating_plans` node** for **every** exam, sequentially. At reality scale
(75 exams, 649 students, 33 halls, 67 seating plans) login was

```
login round-trip ≈ 3 core reads + N full-node plan reads (serial, N = exams)
```

### 1.2 Bulk delete was N reads + N writes
`Store.bulkDeleteExams` removed exams one by one. Each removal:

1. read the seating plan of that exam (again a full-node read), then
2. issued a **separate `update()` per exam** (and per plan).

So a 75-exam bulk delete was ~75 full-node reads + up to 150 writes, with no
ownership/college boundary enforced.

### 1.3 Single delete orphaned plans
When a **single** exam was deleted, its seating-plan document was left behind
under `/seating_plans/<pid>`. Re-reading old exams before genuine fixes, the
app could then surface plans for exams that no longer exist.

### 1.4 Security findings (report only — rules were NOT changed)
Inspection of `firebase-rtdb-rules.json` (source of truth, not modified):

- `students`, `halls`, `exams`, `seating_plans` allow `.write: auth != null` —
  any signed-in user can write to the whole DB. There is **no server-side
  ownership check** at the rule layer.
- College admin credentials are stored in the RTDB itself (`colleges`), and
  `colleges` is readable by **every authenticated user**.
- No `.indexOn` exists for `seating_plans/exam_id` (or for other query keys),
  which is the structural cause of the full-node reads in 1.1/1.2.

**Fix priority recommendation:** add `.indexOn` and lock `.write` rules down (a
server function with Admin SDK credentials should be the only writer). Adding an
`auth != null` "read" on `seating_plans` for college admins properly scoped by a
`college_id` on the doc would also let the client query instead of full-read.
These are operational actions for the operator and were deliberately not applied
in code.

---

## 2. Fix I — login: one concurrent plan load (index.html, harness, tests)

- `App.loadCollegeData` still fires its three core reads concurrently, and now
  also fires **one** whole-`/seating_plans` read at the same time
  (`Store.getAllSeatingPlans`, one `dbGet("seating_plans", [])`).
- The loader scopes that list client-side to **this college's exams**
  (`scopePlansByExams`), takes the **first plan per exam** (the app's existing
  rule), and **silently carries forward the previous plan set** on any failure
  or skip — matching the app's "keep what we had" resilience contract.
- A successful **empty** plan read is treated as truthfully empty (stale plans
  no longer linger after the last exam is removed).
- Step-1 reachability changed to a cheap probe
  `DB.ref("colleges").limitToFirst(1).get()`, so the loader no longer pulls a
  full node just to check connectivity.

New login cost:

```
login round-trip ≈ ~4 parallel reads (colleges core + students + halls + plans)
                  + 1 light reachability probe  — independent of N
```

Tested by `login_optimization.test.js` (5 cases) and the rewritten
`data_load_resilience.test.js` (loader contract, plan reader injection,
carry-forward, empty-read truth).

---

## 3. Fix II — atomic, ownership-checked bulk delete (index.html, store, UI)

- New pure helpers (right after `dbBatchDelete`):
  - `planDeleteUpdatePaths(examIds, planDocs)` — builds `{ exams/<id>: null }`
    + `{ seating_plans/<pid>: null }` only for plans whose `exam_id` is in the
    target set (guards `p.id && p.exam_id`).
  - `buildBulkDeleteUpdate(...)` — one multi-location updates object for a set
    of exams.
- `Store.deleteExam` (single delete) now:
  1. verifies **ownership** — `DB.ref("exams/<id>/college_id").get()` must match
     the session college, returns `{deleted:false}` otherwise;
  2. reads the plan list **once** (`getAllSeatingPlans`), not once per exam;
  3. performs **one** atomic `update()` deleting the exam **and** its plan —
     no more orphans;
  4. returns `{ deleted, plansDeleted }`.
- `Store.bulkDeleteExams` does the same in bulk: one college-scoped read
  (`orderByChild("college_id")` on `/exams`), one plan list read, and **one**
  atomic update; rejects with `Permission denied: … belong to another college.`
  if **any** requested id is not owned by the college. Returns
  `{ deleted, plansDeleted }`.
- `ExamsPage` delete flows now carry a `deleting` busy flag (buttons disabled +
  `Ic.Spin`), clear their `seatingPlans` state for removed exams, and report a
  truthful `plansDeleted` count in the toast.

75-exam bulk delete is now **one** write, and single delete can never orphan a
plan. Tested by `bulk_delete.test.js` (9 cases: pure path builders, ownership
exclusion, 75-exam atomic update contents, Store wiring, UI wiring).

---

## 4. Fix III — 48-hour server-side retention (netlify/, package.json)

See `RETENTION_48H.md` for the full deployment walkthrough. Summary:

- `netlify/shared/retention_core.mjs` — **zero-dependency** pure logic
  (date parsing for ISO / printed day-first / named-month forms, session-end
  timestamps in the college timezone, retention verdicts, target selection,
  atomic update building, bounded run with verify-before-delete).
- `netlify/functions/retention-cleanup.mjs` — scheduled `@daily` function using
  the **Firebase Admin SDK** (server credentials, never the browser). Reads
  `RETENTION_*` env vars; missing credentials fail closed.
- Defaults exactly track the app: FN ends **13:00**, AN ends **17:00** (the
  printed attendance labels + `isExamEnded` values), timezone offset **330**
  (IST), retention **48h**, **dry run = true**.
- Deletion is atomic (exam + its seating plan in one update), chunked to 200
  paths, budgeted **in exam units** so a capped run never orphans a plan, and
  every candidate is re-verified to still exist immediately before writing.
- Exams with unparseable dates are **never** auto-deleted.

**Status: NOT DEPLOYED / NOT ACTIVE.** Inert until the env vars in
`RETENTION_48H.md` are seeded and the function is deployed; even then it only
logs until `RETENTION_DRY_RUN` is deliberately set to `false`.

Tested by `retention_cleanup.test.js` (25 cases, dynamically importing the real
.mjs — no firebase-admin installed locally).

---

## 5. Verification

```
$env:NODE_PATH="C:\Temp\catdeps\node_modules"

node cat_parse_check.js index.html    → PASS: app block parses cleanly
node --check harness.js
node --check data_load_resilience.test.js
node --check bulk_delete.test.js
node --check login_optimization.test.js
node --check retention_cleanup.test.js
node --check netlify/shared/retention_core.mjs
node --check netlify/functions/retention-cleanup.mjs
node run.js index.html                → 626 passed, 0 failed
```

### Regression suites present
`cat*`, seating/attendance integrity, `bulk_seating`, `bulk_capacity_fix`,
`bulk_co_seat`, `seating_grid_consistency`, `seating_integrity`,
`seating_rule_violations`, `subjects_import`, `hall_utilization`,
`hall_notice_*`, `bulk_delete`, `login_optimization`, `data_load_resilience`,
`retention_cleanup`.

---

## 6. NOT done / remaining operator steps (deliberate)

1. **Live performance measurement** on the production Firebase (the fix is
   verified structurally and by unit tests, not against the live DB).
2. **Rules hardening** — `.indexOn` and server-side write locks. Reported in
   §1.4; requires careful auth redesign, not a code-only change.
3. **Deploy + first dry run** of the retention function, then flip
   `RETENTION_DRY_RUN=false` after a clean run (§4 / `RETENTION_48H.md`).
4. Nothing in this deliverable touches production data; all changes are inert
   until deployed.

---

## 7. Files changed / added

Modified: `index.html`, `harness.js`, `run.js`, `data_load_resilience.test.js`.
Added: `bulk_delete.test.js`, `login_optimization.test.js`,
`retention_cleanup.test.js`, `netlify/shared/retention_core.mjs`,
`netlify/functions/retention-cleanup.mjs`, `package.json`,
`RETENTION_48H.md`, `DELIVERABLES_v66.md` (this file).