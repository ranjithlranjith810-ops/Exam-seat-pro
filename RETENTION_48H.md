# 48-Hour Exam Retention — status & deployment

This document describes the scheduled cleanup that removes exams (and their
seating plans) 48 hours after the exam's session ends, so old hall/ticket state
does not accumulate forever.

## Status

**NOT DEPLOYED / NOT ACTIVE.** Nothing is deleted automatically yet. The feature
is written, dry-run by default, and untested against a live database. Do not
claim automatic cleanup is running until you have deployed it, seeded the env
vars and watched at least one clean DRY RUN in the function logs.

## What it does

A Netlify scheduled function (`netlify/functions/retention-cleanup.mjs`) runs
daily and asks the Firebase Admin SDK (server credentials, not the browser) to:

1. Read the whole `/exams` node.
2. For each exam compute its end instant = **session end on the printed date, in
   the college's local time** — FN ends 13:00, AN ends 17:00 (the same values
   the attendance sheets print and the app's `isExamEnded` uses). Netlify
   functions run in UTC, so the timezone offset is configurable
   (`RETENTION_TZ_OFFSET_MINUTES`, default 330 = India +05:30).
3. Only an exam whose end is more than `RETENTION_HOURS` (default 48) in the past
   is a candidate. Recent exams are never touched.
4. **Verify-before-delete**: each candidate is re-checked to still exist in the
   DB right before deletion, so a concurrent change cannot accidentally delete a
   different exam or guess at a plan path.
5. Delete the exam **and** its seating-plan doc in one atomic multi-location
   write (chunked to 200 paths per request).

Pure decision logic lives in `netlify/shared/retention_core.mjs` with **zero
dependencies**, so the unit tests exercise the real code (a test can never pass
against a stale copy).

### Date formats understood

`2026-10-14` (ISO), the college's printed day-first forms `14.10.2026` /
`14-10-2026` / `14/10/2026`, and the CAT reader's named-month `06-Oct-2026`.
Non-ISO forms are read **day-first**, exactly as the app displays them. A
mis-read day↔month can only keep an exam longer, never delete it early.

### Safety rails

- `RETENTION_DRY_RUN` defaults to `"true"` — the function logs what it *would*
  delete and writes nothing. Flip it to `"false"` only after a clean dry run.
- Exams with an unparseable date/session are never auto-deleted.
- Deletion is bounded per run (`RETENTION_MAX_PER_RUN`, default 500). The budget
  is applied in **exam units**, so a capped run deletes whole exam+plan pairs,
  never an exam without its plan (no orphans).
- No seeded config below; the function is inert until env vars are set.

## Why server-side?

The browser already offers manual delete, but automatic retention must not
depend on an admin's browser being open, and the client cannot delete without
the user being signed in. A scheduled function runs unattended with its own
credentials. (See the security findings in the optimization report: the RTDB
rules were *not* changed.)

## Deploy steps

1. Add the `firebase-admin` dependency (already declared in root
   `package.json`). Netlify installs it at build time.
2. Create the service account:
   - Firebase Console → Project Settings → Service accounts → *Generate new
     private key*. Keep the JSON safe; you need three of its fields.
3. Set the function environment variables in Netlify (Site → Environment
   variables), **initially with dry-run on**:

   | Variable | Value |
   |---|---|
   | `FIREBASE_PROJECT_ID` | your Firebase project id |
   | `FIREBASE_CLIENT_EMAIL` | `...@...iam.gserviceaccount.com` |
   | `FIREBASE_PRIVATE_KEY` | the whole `-----BEGIN PRIVATE KEY-----…` value, with `\n` escapes kept as-is |
   | `FIREBASE_DATABASE_URL` | `https://<project>-default-rtdb.firebaseio.com` |
   | `RETENTION_HOURS` | `48` (optional) |
   | `RETENTION_DRY_RUN` | `true` (default; keep it until verified) |
   | `RETENTION_TZ_OFFSET_MINUTES` | `330` for IST (optional) |

4. Deploy. In Netlify UI the scheduled function appears under **Functions**
   with a cron badge (`@daily`). You can also trigger it manually in the
   function's **Trigger** tab — that is the fastest way to see the dry run.
5. Watch **Logs**: expect `[retention] DRY RUN …` lines listing the count of
   candidates and no writes.
6. Only when the dry run shows exactly the exams you expect, set
   `RETENTION_DRY_RUN=false` and redeploy. Watch one run delete exactly that
   set, with `deleted`/`plansDeleted` matching `candidates`.

## Manual checks after enabling

- Delete one finished (>) 48h exam by hand in the dashboard; the next run must
  not resurrect it (`verify-before-delete` reports it only as a skip).
- Create a dummy future exam; it must appear as `not_ended` and be untouched.
- Confirm plan count drops with exam count (no orphaned `seating_plans`).

## Files

- `netlify/shared/retention_core.mjs` — pure logic (tested).
- `netlify/functions/retention-cleanup.mjs` — scheduled function + env wrapper.
- `package.json` — declares `firebase-admin` for Netlify's build.
- `retention_cleanup.test.js` — unit suite for the core module.