# Hall-first Bulk Seating + root-safe routing — change notes

## 1. Root cause of the URL / refresh problem

The router was **path-only**. In-app navigation used
`history.pushState(null, "", "/seating/hall-notice?date=…")`, so the address bar
held a nested path. That is fine on a server with an SPA fallback (Netlify
rewrites `/* -> /index.html`), but on a plain static server — VS Code Live
Server, `http.server`, GitHub Pages project sites — a refresh or a direct open of
`/seating/hall-notice` is sent to the server, which has no such file, so the
browser shows **`Cannot GET /seating/hall-notice`**. A client-side fix cannot
configure that server. The same failure hit `/seating/global-notice/fn` and any
other nested URL.

## 2. What changed

### Routing (root-safe hash routes)
- New pure `routeFromLocation(pathname, search, hash, depth)` resolves the route
  from **either** the path **or** the hash into one descriptor, and `buildRoute`
  now delegates to it. `readQueryParam` reads the location through it too, so a
  `?date=`/`?session=` on a hash route is read correctly.
- New pure `canonicalInternalHref(to, origin)` turns every internal target
  (path form, hash form, or `/`) into a canonical **root + hash** URL
  (`#/seating/hall-notice?date=…`), leaving external URLs for the caller to
  leave via. `resolveTarget` delegates to it; `navigate` writes that href and
  `safeNextPath` matches the bare `routePart`.
- The address bar path now stays `/`, and a refresh loads `http://host/` (always
  served) with the route in the hash, so it works on **any** static host.
  Pathname routes are still accepted on load, so an existing Netlify bookmark
  keeps working. A `hashchange` listener re-syncs the rendered page, and
  `normalizePath` maps a dev server's `/index.html` onto `/`.

### Bulk Seating is now hall-first
- The modal adds a **session** selector (FN/AN); date + session identify the
  sitting, and a hall is only ever shared inside one sitting.
- After choosing exams, a new **hall-selection step** lists every hall with its
  physical seats, usable capacity (declared bounded by physical), seats already
  occupied by *other* applicable plans for that date/session, remaining seats,
  and an **estimated** eligible head-count, plus a clear selectable/unselectable
  state and a reason. It offers Select all / Clear and a live summary
  (combined capacity, occupied, remaining, can-be-accommodated, estimated
  shortfall, spare seats) with a **Sufficient / Insufficient** status.
- **Continue is blocked** when no exam or no hall is selected, when demand
  exceeds the remaining seats in the chosen halls, or when the seating-plan read
  was incomplete. Generation is **confined to the halls the operator picked**.
- The done report shows halls selected, de-duplicated demand, free seats in the
  selection, students assigned, and any unplaced students.

### Capacity / eligibility maths (single source, pure)
New pure helpers, all reused by the modal and unit-tested:
`bulkSessionExams`, `bulkDedupeRoster` (a student in two selected exams is
counted once; duplicates are surfaced), `bulkHallOccupancy` (seats from other
plans for the same date/session, excluding the exams being regenerated),
`bulkRoomsEligible` (per-hall-type estimate), and `bulkHallSelectionData`
(the whole per-hall + totals + validation picture). Capacity comes from the
existing single helper `calcHallCapacity`; occupancy uses the same canonical
seat-key logic as allocation, so selection and generation can never disagree.
`bulkExamRows` gained an **optional** session filter; existing date-only callers
are unchanged.

## 3. Files changed

- `index.html` — router primitives + hash-aware wrappers; `bulkExamRows` session
  filter; new pure hall-first helpers; `runBulkSeatingCoSeated` honours
  `cfg.selectedHallIds`; `BulkSeatingModal` session + hall-selection step +
  report additions.
- `harness.js` — exposes the new pure helpers via `BULK_ENGINE` and the router
  primitives via a new `ROUTER_ENGINE`.
- `run.js` — registers the two new suites.
- `nav_routing.test.js` (new) — 20 cases.
- `hall_selection.test.js` (new) — 21 cases.

## 4. Verification

- Full suite: **667 passed, 0 failed** (626 prior + 41 new).
- `node cat_parse_check.js index.html` → **PASS: app block parses cleanly**.
- `node --check` clean on `harness.js`, `run.js`, and both new test files.
- Harness sandbox loads with **0 unresolved stubs**.

### Manual browser checks
- Outstanding: signed-in Firebase save flow and the actual refresh of
  `/#/seating/hall-notice` and `/#/seating/global-notice/fn` in a real browser
  still need a manual pass in the user's local environment. The pure route
  resolution and the source-level wiring are covered by the new suites.

## 5. Commit

- Commit hash and push status are recorded in the final task summary (this repo
  is committed/pushed from the working machine).

## 6. Remaining limitations

- Per-hall "eligible" is an **estimate** (a student eligible for several halls
  is counted in each), labelled as such; the aggregate demand is de-duplicated.
- A student admitted to two exams of the same date/session is still refused by
  the co-seated generator (`INVALID_COMBINED_ROSTER`); the hall step now warns
  about it up front rather than failing silently after a write.
- Deep links are normalized to hash form only on the **next** in-app navigation;
  a path-form URL loaded on a fallback host keeps its path until then (refresh
  still works there).
