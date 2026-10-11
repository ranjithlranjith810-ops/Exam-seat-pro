# ExamSeat Pro - Project Details

## 1. Project Overview

**ExamSeat Pro** is a **College Examination Seating Management System** — a full-featured web application designed to automate and manage exam seating arrangements for educational institutions. It handles everything from student and hall management to intelligent anti-copying seat allocation and official PDF export in Anna University proforma formats.

**Version:** v66 (Secure edition with multi-college isolation)

**Target Users:**
- **Developers** — Full system control, college management, global oversight
- **College Admins** — Manage students, halls, exams, seating plans for their college
- **Students** — View their assigned seat, hall, and exam details

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| **Frontend Framework** | React 18.2.0 (via CDN, UMD build) |
| **Transpiler** | Babel Standalone 7.23.5 (in-browser JSX) |
| **Styling** | Tailwind CSS (via CDN `cdn.tailwindcss.com`) |
| **Fonts** | Google Fonts — Sora (UI), Space Mono (monospace) |
| **Database** | Firebase Realtime Database (RTDB) — compat SDK 10.12.2 |
| **Authentication** | Firebase Anonymous Auth + Email/Password |
| **Analytics** | Firebase Analytics |
| **PDF Rendering** | pdf.js 3.11.174 (loaded), browser-native print |
| **Deployment** | Netlify (SPA redirect rules in `netlify.toml`) |
| **PWA** | Web App Manifest (`manifest.json`) with standalone display |
| **Architecture** | Single-page application — all logic in one `index.html` (8,243 lines) |

---

## 3. Architecture

```
Single index.html
├── <head>
│   ├── Firebase config (JSON block)
│   ├── Firebase SDK scripts (compat)
│   ├── React 18 + ReactDOM + Babel
│   ├── Tailwind CSS
│   ├── Google Fonts
│   └── CSS themes + animations
├── <body>
│   ├── Splash screen (auto-hide)
│   ├── #root (React mount point)
│   ├── Plain JS functions (PDF export)
│   └── <script type="text/babel"> (React app)
│       ├── Firebase DB wrapper (RTDB client)
│       ├── Store layer (CRUD abstraction)
│       ├── Smart Seating Engine (algorithm — strict regno, §8)
│       ├── UI atoms (Toast, Modal, Btn, Input, Select)
│       ├── SVG Icon library (Ic.*)
│       ├── BenchLayout component (visual seat map)
│       ├── LoginScreen / RegisterScreen
│       ├── DevDashboard (developer panel)
│       ├── AdminDashboard (college admin panel)
│       ├── StudentDashboard (student view)
│       ├── ExamSeatingPage (seat generation wizard)
│       ├── HallsPage (hall management)
│       ├── HallLayoutEditor (visual layout builder)
│       ├── SeatSwapPage (swap two students)
│       ├── AttendancePage (mark attendance)
│       ├── ExamResultsPage (results/attendance tracking)
│       ├── AuditLogPage (activity log viewer)
│       └── App (root component, routing, data loading)
```

**Data Flow:**
1. App mounts → checks Firebase connectivity → shows splash
2. User logs in (Developer / Admin / Student)
3. College-scoped data loaded from RTDB (students, halls, exams, seating plans)
4. User interacts with dashboard → mutations go through `Store` → RTDB
5. PDF exports open a new browser window with formatted HTML + print dialog

---

## 4. Authentication Model

### Three Roles

| Role | Login Method | Access |
|---|---|---|
| **Developer** | Email/Password (Firebase Auth) | Full system access. Manages colleges, sees all data. Write access enforced via RTDB security rules by UID `1MLSxLJ30JR6GSIuB3dRL6OahP33` |
| **Admin** | College-specific admin password (app-level check, SHA-256 hashed) | Manages students, halls, exams, and seating for their own college only. College_id scoped via RTDB rules using `adminUid` field on the college record |
| **Student** | Registration number + password (last 6 chars of regno, SHA-256 hashed) | Read-only: views their exam schedule, seat assignment, and hall details |

### Anonymous Auth
- Firebase anonymous auth is used as a baseline to satisfy RTDB security rules (`auth != null`)
- All real privilege checks happen at the app level (admin/student passwords) and RTDB security rules (UID-based)

---

## 5. Database Schema (Firebase Realtime Database)

### Collections

| Path | Fields | Scope | Index |
|---|---|---|---|
| `/colleges/{id}` | `id`, `name`, `centre_code`, `address`, `adminUid`, `adminPassword`, `exam_title`, `coe`, `subjects[]` | Global (developer-managed) | — |
| `/students/{id}` | `id`, `regno`, `name`, `dept`, `year`, `gender`, `password`, `college_id` | Per-college | `college_id` |
| `/halls/{id}` | `id`, `name`, `college_id`, `numbenches`, `studentsperbench`, `capacity`, `hallType`, `layoutConfig`, `patternId`, `customGrid` | Per-college | `college_id` |
| `/exams/{id}` | `id`, `subject`, `date`, `session` (FN/AN), `college_id`, `groups[]`, `seatinggenerated`, `status` | Per-college | `college_id` |
| `/seating_plans/{id}` | `id`, `exam_id`, `plan` (nested hall → seats structure) | Per-college (via exam) | `exam_id`, `college_id` |

### Relationships
```
college_id ──→ colleges.id    (students, halls, exams all reference their college)
exam_id    ──→ exams.id       (seating_plans reference their exam)
```

### Subjects
- Stored as an array on the college record: `colleges/{id}.subjects[]`
- Each subject: `{ code, name }` (extended in v66.3 to the full `{ id, name, code, dept, year, credit }` record described in §19)

---

## 6. Security Model

### RTDB Security Rules (`firebase-rtdb-rules.json`)

- **Write access** restricted to:
  - Developer UID: `1MLSxLJ30JR6GSIuB3dRL6OahP33` (hardcoded in rules)
  - College admin: verified via `root.child('colleges/{college_id}/adminUid') === auth.uid`
- **Read access** restricted to:
  - Authenticated users (`auth != null`)
  - College admins can only read their own college's data
  - Students can read their own record (`auth.uid === $studentId`)
- **Validation rules** enforce required fields, string types, and minimum lengths
- **`$other` rule** blocks access to any unlisted paths (catch-all deny)

### Application-Level Security
- Admin passwords stored per-college (SHA-256 hashed)
- Student passwords are last 6 chars of registration number (SHA-256 hashed)
- College data isolation enforced in `dbUpdate`/`dbDelete` — checks `college_id` matches before any write
- Password hashing uses `crypto.subtle.digest("SHA-256")` with djb2 fallback for insecure origins

---

## 7. Core Features

### Developer Dashboard
- **College Management** — Create, edit, delete colleges (name, centre code, admin credentials, exam title, COE name)
- **Global Student/Hall/Exam View** — Browse all colleges' data
- **Orphan Data Migration** — Detect and reassign legacy records (pre-multi-college) to the correct college
- **System-wide settings** management

### Admin Dashboard
- **Student Management** — Add/edit/delete students, bulk import via CSV, bulk year update
- **Hall Management** — Create halls with custom bench layouts (columns, seats per bench, aisle gaps), hall types (University, CAT, Lab, Other)
- **Exam Management** — Create exams with date, session (FN/AN), subject groups with department/subject mapping
- **Exam Seating Generation** — Smart algorithmic seat allocation with anti-copying rules
- **Seat Swap** — Search and swap two students' seat assignments
- **PDF Export** — Generate 4 types of official PDFs
- **Attendance Tracking** — Mark present/absent per student per exam
- **Exam Results** — Track and export attendance/results as CSV
- **Audit Log** — Track all significant actions with timestamps
- **College Settings** — Edit college name, centre code, exam title, COE name

### Student Dashboard
- View assigned exam, seat number, hall, and date/session
- View college and exam details

---

## 8. Smart Seating Engine (Algorithm)

### Overview
The seating engine produces a **deterministic, strict registration-number-order** plan. Students are processed ONLY in ascending register order and are never silently reordered or rule-relaxed. Placement fills each hall vertically (column-first), and the user-selectable rules (Gender Based, No Same Year Side-by-Side, No Same Department Side-by-Side) are enforced against the seat directly to the left (adjacent column, same row).

### Algorithm Steps

1. **Collect & dedupe** — Exam students, deduplicated by id/regno
2. **Strict regno sort** — `byRegNo` (numeric-aware: `...010` sorts after `...009`)
3. **Gender grouping (optional)** — Males (+ unmarked) first in a contiguous block of halls; any leftover seats in the last male hall stay EMPTY; females start in the next completely unused hall
4. **Vertical, slot-major placement** — Within each hall, for each bench column fill slot 1 down ALL rows (A1.1, A2.1, A3.1…), then slot 2 (A1.2, A2.2…), then slot 3, then move to the next bench column. `benchNo = colIdx * nRows + rowIdx + 1`
5. **Horizontal constraint check** — Compare the candidate against the occupants of the previous column, same row; multiple selected rules must all pass
6. **Hard stop on conflict** — If no legal seat exists, auto-generation stops and every remaining student is collected for **manual placement**; the rule is never silently violated and never auto-disabled
7. **Validate → save** — `validatePlan` + `validateGenderSeparation` run before anything is persisted

### Key Functions
- `byRegNo(a,b)` — Strict numeric-aware registration-order comparator
- `placeStudentsInHalls(students, halls, startIdx, hallUsedSeats, rules)` — Vertical column-first placement with horizontal-only rule checking; returns `{ plan, unplaced, lastUsedHallIdx }`
- `validatePlan(plan, rules)` — Duplicate-student/seat + horizontal adjacency audit
- `validateGenderSeparation(plan)` — Hall-level male/female separation check
- `buildSeatingReport(plan, allStudents, rules, unplaced, hallUsedSeats)` — §33 summary report
- `generateSmartSeating(groups, halls, hallUsedSeats)` — Main orchestrator (dedupe → regno sort → gender split → place → report); exposes `window.__lastSeatingResult`
- `calcHallCapacity(hall)` — Computes total capacity from layout config

> **Note:** The legacy bucket/interleave engine (`smartSort`, `enforceGridAdjacency`) was removed in v66.1 — see §18 for the full development report.

### Hall Layout Model
- **Columns (A, B, C, D, E...)** — Physical columns of benches in the hall
- **Rows** — Front-to-back bench rows (= `numbenches`)
- **Seats per Column** — Configurable per column (1-4 seats per bench slot)
- **Aisles** — Configurable gaps between columns
- **Seat Numbering**: `hallId-B{benchNo}S{slotNo}` — column-first: benchNo = colIdx * nRows + rowIdx + 1

---

## 9. PDF Export

Four PDF types, all rendered as HTML in a new browser window with print-to-PDF capability:

### 1. Seating Arrangement (Proforma 1)
- **Format**: Anna University official proforma
- **Content**: Column headers (A, B, C...), row numbers (1, 2, 3...), each cell = seat label + registration number + department
- **Department color coding**: CSE (blue), ECE (purple), MECH (orange), EEE (amber), IT (green), CIVIL (red), AIDS (pink)
- **Includes**: Hall superintendent signature, COE signature line, subject summary, total count

### 2. Hall Allocation PDF
- **Format**: Summary table per hall
- **Content**: Hall name, subject code, department, registration numbers (abbreviated), count per group, grand total

### 3. Attendance Sheet PDF
- **Format**: Per-hall attendance register
- **Content**: Serial number, register number, student name, department, signature column
- **Includes**: Present/Absent count fields, Hall Superintendent signature

### 4. Hall Notice PDF
- **Format**: Examination hall notice board poster
- **Content**: Exam details, student list sorted by regno, department-wise strength summary
- **Signature blocks**: Hall Superintendent, Chief Invigilator, Controller of Examinations

### Anna University Registration Number Format
The system generates Anna University format regnos: `9530{year_code}{dept_code}{sequence}`
- Dept codes: CSE=104, ECE=106, MECH=102, EEE=103, IT=105, CIVIL=101, AIDS=243

---

## 10. UI/UX

### Themes (7 color palettes)
| Theme | Primary | Accent |
|---|---|---|
| **Default (Indigo)** | `#0f172a` | `#2563eb` |
| **Ocean** | `#0a1628` | `#0ea5e9` |
| **Aquamarine** | `#002e29` | `#00c9a7` |
| **Night Kiwi** | `#181818` | `#89e900` |
| **Imperial** | `#000f08` | `#fb3640` |
| **Plum** | `#1a0d1e` | `#c084fc` |
| **Arctic** | `#e8f0ef` | `#114c5a` |

### Dark Mode
- Full dark mode support via `body.dark-mode` class
- Overrides all Tailwind utility backgrounds, text colors, borders, and input styles
- Preserves palette themes on top of dark mode

### Responsive Design
- Mobile-first with `max-width` constraints
- Grid layouts adapt from 1-column (mobile) to 2-3 columns (desktop)
- Splash screen with animated loading bar
- Touch-friendly buttons and inputs

### Animations
- `logoPulse` — Glow animation on logo
- `fadeSlideIn` — Slide-in animation for modals
- `slideIn` — Toast notification entrance
- Theme pill hover/active states
- Loading spinner (SVG animated)

### Splash Screen
- Displays on initial load with animated progress bar
- Auto-hides after 8 seconds (or 20s timeout with error fallback)
- Error state shows retry button if React/Babel fails to load

---

## 11. Data Import / CSV Parsing

### CSV Import Features
- **Auto-delimiter detection**: comma, tab, or semicolon
- **Header normalization**: Maps variations like `registernumber`, `rollno`, `register` → `regno`
- **Supported columns**: `regno`, `name`, `dept`/`department`/`branch`, `year`/`semester`, `gender`/`sex`
- **Auto-generated passwords**: Last 6 characters of registration number, SHA-256 hashed
- **Bulk import**: Batch writes to RTDB (chunks of 200 records per multi-location update)

### Subject Group Import (Exam Seating)
- Import subject groups from structured data (CSV/text)
- Auto-detect subject code, department, date, session, student list
- Select specific groups for seating generation
- Live hall layout preview during import

---

## 12. Store Layer (Data Persistence)

### RTDB Wrapper Functions
| Function | Description |
|---|---|
| `dbGet(collection, filters)` | Fetch all records with optional `==`/`!=` filters. Uses `orderByChild` for college-scoped queries |
| `dbGetOne(collection, id)` | Fetch single record by ID |
| `dbAdd(collection, data)` | Add/overwrite record with auto-generated ID |
| `dbUpdate(collection, id, data)` | Update specific fields with college ownership verification |
| `dbDelete(collection, id)` | Delete record with college ownership verification |
| `dbBatchAdd(collection, items)` | Bulk add via RTDB multi-location update (200 per chunk) |
| `dbBatchDelete(collection, ids)` | Bulk delete with ownership check |
| `dbBatchUpdateYear(updates)` | Bulk update year field across multiple students |

### Store API
```javascript
Store.getStudents()          // College-scoped
Store.addStudent(s)
Store.bulkAddStudents(arr)
Store.updateStudent(id, data)
Store.deleteStudent(id)
Store.getHalls()
Store.addHall(h)
Store.updateHall(id, data)
Store.deleteHall(id)
Store.getExams()
Store.addExam(e)
Store.updateExam(id, data)
Store.deleteExam(id)
Store.getColleges()          // Global (developer only)
Store.addCollege(c)
Store.getSeatingPlan(examId)
Store.setSeatingPlan(examId, plan)
Store.saveSubjects(subjects)
```

---

## 13. Key Components

| Component | Location (approx. line) | Purpose |
|---|---|---|
| `App` | 7974 | Root component — login state, data loading, routing |
| `LoginScreen` | — | Admin/Developer login with college selection |
| `RegisterScreen` | — | Student self-registration |
| `DevDashboard` | — | Developer panel with college management |
| `AdminDashboard` | — | Admin panel with tabbed navigation |
| `StudentDashboard` | — | Student view of exam and seat |
| `ExamSeatingPage` | — | Smart seating generation wizard |
| `HallsPage` | 4122 | Hall CRUD with layout preview |
| `HallLayoutEditor` | ~3900 | Visual bench layout builder |
| `HallLayoutBuilder` | — | Interactive layout configuration UI |
| `HallLayoutVisualiser` | — | Visual representation of hall layout |
| `BenchLayout` | 1854 | Interactive seat map with hover/popover |
| `SeatSwapPage` | 6022 | Search and swap student seats |
| `AttendancePage` | — | Mark attendance per exam |
| `ExamResultsPage` | 6156 | Results tracking and CSV export |
| `AuditLogPage` | — | Activity log viewer |
| `BenchLayoutPreview` | — | Mini layout preview for hall cards |
| `Toast` | 1712 | Animated notification popup |
| `Modal` | 1792 | Reusable modal dialog |
| `Btn` | 1806 | Themed button with variants |
| `Input` | 1753 | Form input with password toggle |
| `Select` | 1780 | Dropdown select |
| `QRCode` | 1822 | Simple hash-based QR code SVG generator |

---

## 14. External Dependencies (CDN)

| Library | Version | URL |
|---|---|---|
| React | 18.2.0 | `cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js` |
| ReactDOM | 18.2.0 | `cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js` |
| Babel Standalone | 7.23.5 | `unpkg.com/@babel/standalone@7.23.5/babel.min.js` |
| Tailwind CSS | latest | `cdn.tailwindcss.com` |
| Firebase App (compat) | 10.12.2 | `gstatic.com/firebasejs/10.12.2/firebase-app-compat.js` |
| Firebase Auth (compat) | 10.12.2 | `gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js` |
| Firebase Database (compat) | 10.12.2 | `gstatic.com/firebasejs/10.12.2/firebase-database-compat.js` |
| Firebase Analytics (compat) | 10.12.2 | `gstatic.com/firebasejs/10.12.2/firebase-analytics-compat.js` |
| pdf.js | 3.11.174 | `cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js` |
| Google Fonts | — | Sora (400-800), Space Mono (400,700) |

---

## 15. Deployment & Configuration

### Netlify Deployment
- `netlify.toml`: SPA redirect rule — all routes → `/index.html` (status 200)
- Deploy the entire folder as-is to Netlify

### Firebase Setup
1. Create Firebase project (existing: `seat-pro-b00a2`)
2. Enable Anonymous Auth + Email/Password Auth
3. Create Realtime Database (Asia Southeast region)
4. Copy `firebase-rtdb-rules.json` to RTDB Rules tab
5. Add web app, copy config to `<script id="firebase-config">`

### PWA Support
- `manifest.json` configured for standalone display
- Portrait orientation, dark theme color (`#1e3a8a`)
- SVG emoji icon (no bitmap assets needed)

---

## 16. File Structure

```
ExamSeatPro_v66_secure/
├── index.html              # Entire application (8,243 lines)
├── firebase-rtdb-rules.json # RTDB security rules (119 lines)
├── manifest.json           # PWA web app manifest
└── netlify.toml            # Netlify SPA redirect config
```

**Total codebase**: ~8,400 lines across 4 files. Single HTML file contains all React components, CSS, JavaScript, PDF generation, Firebase integration, and the seating algorithm.

---

## 17. Notable Implementation Details

- **No build step** — Entire app runs in-browser via Babel transpilation (development-mode overhead, but zero deployment complexity)
- **Multi-location RTDB writes** — Bulk operations use `DB.ref("/").update()` with chunked paths for atomicity and performance
- **Orphan data migration** — Built-in UI for detecting legacy records with `college_id="default"` and reassigning them to the correct college
- **Hall capacity calculation** — Unified helper `calcHallCapacity()` ensures warnings and actual seat counts always match
- **Dept inference** — Students with `dept=GEN` can have their department inferred from registration number patterns
- **Gender inference** — Indian name-based gender inference from a comprehensive list of ~200+ male and ~100+ female names
- **Client-side filtering** — RTDB doesn't support multi-field queries; college-scoped queries use `orderByChild("college_id").equalTo()`, other filters applied client-side

---

## 18. Development Report — Seating Engine Replacement (v66.1)

### 18.1 Files Modified

| File | Change |
|---|---|
| `index.html` | Seating engine (legacy `smartSort` / `enforceGridAdjacency` / `generateSmartSeating` block) replaced with the new strict-registration-order engine; `confirmAndGenerate` rewritten; `AttendancePDFImportPage` inline generation rewritten; Manual Placement modal + Validation Report panel added. |
| `PROJECT_DETAILS.md` | Engine documentation (§8) updated and this report (§18) appended. |
| `firebase-rtdb-rules.json` | **Unchanged** (per requirement "do not change security"). |
| `manifest.json`, `netlify.toml` | **Unchanged**. |

### 18.2 Functions Removed (Old Algorithm)

These legacy functions were **deleted entirely** from `index.html`:

- `smartSort(students, rules)` — bucket/interleave pre-sorter
- `enforceGridAdjacency(pool, nCols, rules)` — 2D grid (left+up adjacency) filler that could silently reorder students and auto-relax rules via a "least-conflict fallback"

The old pipeline sorted by buckets, interleaved to beat the grid constraints, then filled the grid row-major checking left + top neighbours. It violated the new requirements (silent reordering, silent rule relaxation, non-deterministic tie handling, "GEN" dept short-circuit).

### 18.3 Functions Modified or Added

Modified:

- `calcHallCapacity(hall)` — kept byte-for-byte as the single capacity source of truth.

Added (index.html, at the engine block, ~line 1214):

| Function | Purpose |
|---|---|
| `byRegNo(a, b)` | Numeric-aware strict ascending registration-number comparator (length first, then lexicographic). Never reshuffles by dept/year/gender. |
| `placeStudentsInHalls(students, halls, startIdx, hallUsedSeats, rules)` | Fills halls **vertically / column-first** (`ci` outer, `ri` middle, `si` inner). Only the OCCUPIED previous-column same-row seats are checked against the selected rules. Returns `{ plan, unplaced, lastUsedHallIdx }`. |
| `validatePlan(plan, rules)` | Post-generation audit: duplicate students, duplicate seats, and every horizontal (previous-column same-row) adjacency against the selected rules. |
| `validateGenderSeparation(plan)` | When `splitGender` is ON, asserts no hall contains both male and female students. |
| `buildSeatingReport(plan, allStudents, rules, unplaced, hallUsedSeats)` | §33 summary: total/assigned/unassigned, male/female, halls used, empty seats, selected rules, validation problems. |
| `generateSmartSeating(groups, halls, hallUsedSeats)` | New entry point — same signature and compat `plan` return. Normalizes + dedupes, sorts strictly by regno, applies gender grouping (males first → females in a brand-new hall), then calls `placeStudentsInHalls`. Exposes `window.__lastSeatingResult = { plan, unplaced, report, rules }`. |

### 18.4 New Algorithm Explanation

1. **Collect & filter** students for the exam (existing group matching).
2. **Deduplicate** and **sort STRICTLY by registration number** (`byRegNo`) — the ONLY permitted reordering. Depts of `"GEN"` are enriched from the register-number pattern at seat time (`inferDeptFromRegno`).
3. **Gender grouping (if enabled):** males + unmarked students placed first in register order starting at hall 0; if they end mid-hall, the remaining seats in that hall stay EMPTY; females are then placed in the **next completely unused hall** (`lastUsedHallIdx + 1`).
4. **Vertical traversal per hall:** for each column `ci` (A, B, C…) → each row `ri` (1..N) → each slot `si`, compute `benchNo = ci*nRows + ri + 1`, `seatNo = hallId-B{benchNo}S{si+1}`. Skip `seatNo`s already used by another same-session exam (`hallUsedSeats`).
5. **Constraint check (horizontal only):** compare the candidate against occupants of the previous column, same row. Only user-selected rules are active; multiple rules must ALL pass.
6. **If no legal seat exists:** auto-generation **STOPS immediately**, the violating student and EVERY remaining student are collected in `unplaced` with the reason. No rule is silently relaxed, no student is reordered.
7. **Output** is fully deterministic: identical input → identical plan.

### 18.5 Side-by-side Definition

"Side-by-side" = cells in **adjacent columns, same row** only (the cell directly to the left). Seats in the same bench cell (S1/S2 slots), seats directly ahead/behind (vertical), and the aisle gaps between columns are NOT constrained. This was confirmed by the user during planning.

### 18.6 Applied to Both Generation Paths

- **AdminDashboard "Generate Seating"** (`confirmAndGenerate`) — full rule set from the checkbox UI (`splitGender`, `noSameDept`, `noSameYear`).
- **AttendancePDFImportPage** — same vertical engine, fixed behaviour: `noSameDept` horizontal anti-mixing rule only when 2+ subject groups are selected, `splitGender:false`, `noSameYear:false`. Per-group plans are still produced by filtering the shared plan by `_groupIdx`.

### 18.7 Manual Placement (New)

When `unplaced.length > 0`, the plan is **NOT saved**. A Manual Placement modal opens listing each unplaced student (with the reason) and a free-seat picker across all selected halls. Each candidate seat runs the same rule check; a conflicting seat shows "⚠ This seat violates: …" and requires explicit admin override. Every placement is written to the audit log. After all students are placed, validation runs again and only a passing plan is saved via `Store.setSeatingPlan` + `Store.updateExam`.

### 18.8 Validation Before Save

Both auto and manual paths run `validatePlan` (+ `validateGenderSeparation` when split) before persisting. A violating plan is never saved — the user sees the Validation Report panel (§33) with the concrete problems.

### 18.9 Compatibility

Saved plan structure is **identical** to before:
`plan[hallId] = { hallName, numbenches, nCols, nRows, capacity, layoutConfig, benches:[{benchNo,slots,capacity}], seats:[{...student, seatNo, hall, hallId, bench, slot, colIdx, rowIdx, colLabel, seatLabel}] }`.

All consumers (BenchLayout previews, SeatingPage, SeatSwapPage, Student Dashboard, the 4 PDF exporters, hall capacity count) work unchanged.

### 18.10 Tests Performed

- **Syntax validation:** the full `<script type="text/babel">` block was extracted and parsed with `@babel/parser` (JSX + all in-use plugins) → **PARSE OK**.
- **Reference audit:** `grep` confirms no remaining references to `smartSort` or `enforceGridAdjacency` anywhere in `index.html`.
- **Automated self-test suite (in-browser Diagnostics):** a 16-case assertion harness (`runSeatingDiagSuite`, §18.12) was added to the Developer Dashboard as a dev-only "Diagnostics" button. All 16 cases (T1–T16) now **pass** — verified both in the browser harness and headlessly via the Node test rig that extracts the engine functions and executes them.

**Bug fixes (September 2026):**
- **"Cancel" on the seating-generation dialog blanked the whole app — root cause found.** All Cancel / backdrop actions in `AdminDashboard` funnel through one `closeAllDialogs()` helper that clears every overlay state (`confirmExam`, `regenDiff`, `pendingGen`, `validationReport`, `manualIdx`, `manualSel`). The underlying crash was in `ManualPlacementModal`: the new engine emits unplaced entries as `{ student, reason, hallName }`, but the modal treated `unplaced[i]` as a bare student object → `student.regno` was `undefined` → `student.regno.slice(-4)` threw → the entire app unmounted to a blank white/black screen. The modal now unwraps both shapes and every student-field access is null-guarded (`(student.regno||"").slice(-4)`).
- **Manual Placement could never finish.** `placeHere` allowed rule overrides (with a confirm), but `saveManualPlan` then hard-blocked on any remaining validation problem — so a plan containing an overridden seat could never be saved and the flow ended in a "Plan still invalid" error loop with no way to generate the seating. Save now asks ONE confirm listing the unresolved issues (accepting the manual override, same authority as the per-seat confirm) and saves on agreement; the final button is labelled "Save & Generate Seating", and DB failures surface as an error toast instead of failing silently.
- **Manual Placement had no way to finish when seats ran out.** The final "Save & Generate Seating" button only appeared once every original unplaced student was placed — so if the assigned halls had fewer free seats than remaining students (e.g. 14 unplaced, 7 free), the modal was stuck with a disabled Place button forever. Now a "N seats free" counter shows in the header, an amber banner appears when zero seats remain ("student(s) will stay unallocated — Save to finish"), and the Save button becomes available as soon as all students are placed **or** no free seats remain; `unallocatedSeats` records how many students could not be seated.
- **Seat filling order is now slot-major / column-first.** Previously each bench-position filled its slots first (`A1.1, A1.2, A1.3, A2.1...`). The traversal is now per bench column: fill slot 1 down **all** rows (`A1.1, A2.1, A3.1, A4.1, A5.1`), then slot 2 down all rows (`A1.2...A5.2`), then slot 3 (`A1.3...A5.3`), then move to bench B and repeat. Seat-ID format, strict registration-number order, and all rule checks are unchanged; benches are grouped from the resulting seat list (slots sorted by slot index). Verified with a 5-row × 3-slot hall and a 3-row × 2-slot hall.
- **Seating views now read VERTICALLY (column-first).** (Applied then **reverted** — the transposed grid rendered collapsed.) The on-screen grid (BenchLayout), Proforma 1 export, and Hall Notice listing were temporarily changed to read down bench A (A1, A2, A3...) then bench B (rows = benches, columns = positions). This was rolled back on 2026-09-10; the app now displays the original row-first chart (benches across the top row, R1..RN down) and the Hall Notice still sorts by register number. Engine placement remains column-first; this was a display experiment only.
- **Root error boundary added.** Any uncaught React render error now shows an inline, recoverable error card (real error message + Retry / Reload) instead of unmounting the entire app to a blank white/black screen. The error is logged to the console, so if anything re-triggers it surfaces the exact cause instead of a silent blank screen.
- **Determinism:** engine sorts once by `byRegNo`; placement has no randomness, so repeated runs produce identical plans (verified by T9).
- **Gender separation:** verified hall splitting logic starts females at `lastUsedHallIdx + 1` and leaves leftover male-hall seats empty.
- **Rule-stop behaviour:** verified that on a conflict the engine pushes the whole remaining tail to `unplaced` rather than dropping it silently.

### 18.11 Limitations

- **Strict-regno hard stops:** because order is never reordered, dense same-dept register runs (e.g. `9530..104/001..060` contiguous) under `No Same Department Side-by-Side` will frequently force a stop → manual placement is required. This is the intended trade-off of the new rules (never reorder, never relax).
- The Manual Placement modal and Validation Report panel are browser-confirm based (no React-based sub-validation dialog for the override) and reuse the app's existing toast/audit infrastructure.
- Line numbers in the file have shifted (file grew); this document's component locations are approximate.
- The Node harness executes the extracted engine + suite functions in a VM sandbox (with `inferDeptFromRegno` stubbed); it doesn't exercise React rendering — that's covered by the in-browser Diagnostics page.

### 18.12 Diagnostics Self-Test (Developer Dashboard)

A Dev-only "Diagnostics" button (Developer Dashboard header) opens `SeatingEngineDiagnosticsPage` — a modal that runs `runSeatingDiagSuite()` and renders a pass/fail table. It is **pure client-side**, needs no database, and verifies:

| Case | Asserts |
|---|---|
| T1 | No rules → all students placed |
| T2 | Strict regno order preserved in the compacted seat sequence |
| T3 | Column-first numbering (`benchNo = colIdx*nRows+rowIdx+1`, `seatNo=hallId-B{n}S{slot}`) |
| T4 | `calcHallCapacity` = rows × seats-per-row (layout + legacy fallback) |
| T5/T6 | no-same-dept / no-same-year horizontal-only (vertical & same-bench allowed) |
| T7 | Dept + year rules combined |
| T8 | Rule conflict → stop; ALL remaining collected for manual placement |
| T9 | Determinism (two identical runs → identical plan) |
| T10/T11 | Gender split: mid-hall male end → empty seats + females in a brand-new hall; exact male fill → females in next hall |
| T12 | Multi-hall contiguous overflow |
| T13 | `hallUsedSeats` skipping (pre-selected seat not re-used) |
| T14 | `byRegNo` numeric-aware ordering (`…009` before `…0010`) |
| T15 | `validatePlan` catches duplicate regno + duplicate seat |
| T16 | `buildSeatingReport` stats match the run |
| T17 | Unplaced entries expose `{ student, reason, hallName }` — the shape `ManualPlacementModal` unwraps (regression for the "`Cannot read properties of undefined (reading 'slice')`" crash) |

**Bugs the suite caught and fixed (all verified with 16/16 passing):**

1. **Partially-filled hall dropped** — the engine used `break outer` when the student list was exhausted mid-hall, which jumped past the `plan[hall.id] = …` write. Any hall that ended mid-column (or any hall where a rule conflict stopped generation) lost ALL of its placed seats from the plan. Fixed by replacing the labelled break with a `stopHere` flag so the current hall's accumulated seats are always written before stopping.
2. **Capacity-overflow students silently dropped** — students beyond the total hall capacity were neither placed nor reported as unplaced. They are now pushed to `unplaced` with `"Hall capacity exhausted"` so they surface in the Manual Placement/workflow instead of vanishing.
3. **SeatSwapPage broken JSX** — a pre-existing malformed closing sequence (an unclosed fragment plus two extra `</div>`s) was fixed while wiring up the harness, restoring that page's parse correctness.

---

## 19. Curriculum File Upload & Subject Extraction (v66.3)

### 19.1 What it does
Adds an **"Upload Curriculum"** button on the Subjects Master page (`SubjectsPage`). A college admin uploads a PDF / Excel (`.xlsx`/`.xls`) / CSV / Word (`.docx`) curriculum or syllabus file and the app intelligently extracts the subject list, shows an editable preview, and imports it into the existing subject master. **No new database, no new pages, no build step** — the feature lives inside `index.html` and reuses the existing `colleges/{id}.subjects[]` array and `Store.saveSubjects()` persistence (RTDB college-admin rules unchanged). Imported subjects automatically appear in the Exam → subject-group dropdown (matched by `code`).

### 19.2 Subject record model
Extended from `{ code, name }` to:
```
{ id, name, code, dept, year, credit }
```
- `dept` = 2–4 letter dept code (CSE / ECE / MECH / IT / EEE / CIVIL / AIDS / AIML) inferred from the programme line; unknown → empty + "Requires Review".
- `year` = `"1"…"4"` mapped from semester context (I/II→1, III/IV→2, V/VI→3, VII/VIII→4); explicit semester/year column wins; never guessed.
- `credit` = number parsed **only** from the Credits/Credit column — never from LIT, L-T-P, Total Periods, or contact hours.
- Backward compatible: old `{code,name}` records keep working; import only fills missing fields.

### 19.3 Parsing pipeline (all in the Babel block of `index.html`)
- `parseCurriculumFile(file)` — dispatcher by extension, validation, normalization, in-file duplicate dedupe, error messages.
- `parseCSVCurriculum(text)` — quote-aware split; delimiter detection (comma / tab / semicolon) + extended header-synonym map.
- `parseXLSXCurriculum(ab)` — SheetJS `XLSX.read` → every sheet → `sheet_to_json(header:1)` matrix.
- `parseDOCXCurriculum(ab)` — mammoth → HTML (detached element, never mounted) → tables + surrounding paragraph context (dept/semester headings).
- `parsePDFCurriculum(ab)` — pdf.js text extraction; per-line grouping by `transform[5]` y-position (with a same-y fallback for emitters that don't apply `T*`); programme/semester heading detection; `Code [Name] <numbers>` row heuristic; skips headings/units/objectives/reference lines.
- `scanCurriculumMatrix(matrix)` — shared 2D scanner for CSV/XLSX/DOCX: dynamic header detection (2+ of code/name/credit synonyms), column roles, context rows, single-column merged-cell fallback.
- Helpers: `curricHeaderKey`, `curricSemToYear`, `curricDeptFromText` (alias map incl. `&`→"and", degree-noise strip; conservative — returns `""` when unknown), `curricParseCredit`, `curricExtractCode`, `curricNamesFromLine`, `isCurriculumRowReady`, `mergeCurriculumSubjects`.

### 19.4 Spec-driven rules
- **Credentials/credit column only** — rows without a credit column get `credit:null` and are flagged rather than guessed.
- **Requires Review** — any row missing name/code/credit/dept/year is amber-flagged; inline editing of all 5 fields; a row stays "Review" until complete; `Import` imports only Ready rows and reports the review count.
- **Duplicate handling** — primary key = normalized `subjectCode`; fallback = name+dept+year; existing subjects get missing fields filled (never overwritten); identical rows counted as skipped.
- **Cancel = no writes** — Cancel discards the staged preview; only `Import Subjects` calls `Store.saveSubjects`.
- **Permissions** — feature sits inside `SubjectsPage`, which only admins see; no rule changes.
- **Security** — file never executed; DOCX HTML only parsed; all text sanitized (whitespace-collapsed) before display; no deletions.

### 19.5 UI flow (in `SubjectsPage`)
1. **Upload Curriculum** button → wide modal, file picker (`accept=".pdf,.xlsx,.xls,.csv,.docx"`, ≤10 MB).
2. **Extract Subjects** → busy state ("Reading… / extracting"), spinner.
3. **Import Preview** table — Status (Ready/Requires Review), Name, Code, Dept, Year, Credit inline-editable + per-row remove.
4. **Import Subjects** → `mergeCurriculumSubjects` → `Store.saveSubjects` → summary card (Added/Updated/Skipped/Need Review) + toast.

### 19.6 Verification
- Diagnostics suite extended to **29/29 passing**: T18–T29 cover CSV parsing (context, synonym/reordered headers, semicolon, quotes), credit-vs-contact-hours separation, semester→year mapping, dept inference, credit rejection rules, review flagging, merge counts, header synonyms, PDF line heuristic, and single-column matrices.
- Fixture files tested end-to-end in a Node harness with the real libraries (SheetJS for XLSX, pdf.js for PDF): CSV 6/6, XLSX 4/4, PDF 4/4 rows with correct dept/year/credit. DOCX fixture archives and tables validated by ZIP + mammoth parse (browser run).
- Fixtures live in `C:\Users\AKASH\AppData\Local\Temp\opencode\curriculum-fixtures\` (`curriculum_sample.{csv,xlsx,docx,pdf}`) for in-browser verification.

### 19.7 New CDN dependencies (match the existing CDN-only pattern)
```
https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js
https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.8.0/mammoth.browser.min.js
```

### 19.8 Known limitations
- PDF extraction reads the **text layer**; image-only or scanned PDFs without text export nothing (→ "No subject data found…").
- Department inference is conservative (known-alias + programme headings); unrecognized depts are left empty and flagged for review rather than mis-inferred.
- DOCX/XLSX rely on header-synonym detection — a table with no recognizable header row yields no rows.
- Line numbers shifted again; component locations in this doc remain approximate.
