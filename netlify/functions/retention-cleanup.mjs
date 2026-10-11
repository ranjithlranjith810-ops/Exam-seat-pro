// ─────────────────────────────────────────────────────────────────────────────
// retention-cleanup — the 48-hour exam retention job.
//
// Runs on Netlify's scheduled functions (@daily) and deletes exams that finished
// more than RETENTION_HOURS ago, together with their seating plans. It uses the
// Firebase Admin SDK, so it reads the same RTDB as the browser app but with
// server credentials.
//
// WARNINGS (read before enabling):
//   • Defaults to DRY RUN — set RETENTION_DRY_RUN=false ONLY after watching a
//     clean dry run in the function logs. There is no undo for this deletion.
//   • A college whose timezone is not IST must set RETENTION_TZ_OFFSET_MINUTES,
//     otherwise session ends are computed in UTC and exam end times skew.
//   • Exams whose date/session cannot be parsed are never deleted.
//
// ENV:
//   FIREBASE_PROJECT_ID           required
//   FIREBASE_CLIENT_EMAIL         required (service account)
//   FIREBASE_PRIVATE_KEY          required (service account; keep the quotes)
//   FIREBASE_DATABASE_URL         required, e.g. https://<project>-default-rtdb...
//   RETENTION_HOURS               optional, default 48
//   RETENTION_DRY_RUN             optional, default "true" (safe)
//   RETENTION_TZ_OFFSET_MINUTES   optional, default 330 (India +05:30)
//   RETENTION_MAX_PER_RUN         optional, default 500 paths per invocation
// ─────────────────────────────────────────────────────────────────────────────

import { initializeApp, cert } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { defaultRetentionConfig, runRetentionCleanup } from "../shared/retention_core.mjs";

export const config = { schedule: "@daily" };

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error("Missing required env var " + name + " — retention cleanup is NOT configured to run.");
  return v;
}

// One shared Admin app per warm instance. initializeApp is idempotent, and the
// Admin SDK keeps a singleton on the default app name, so this is cheap.
function adminApp() {
  return initializeApp({
    credential: cert({
      projectId: requiredEnv("FIREBASE_PROJECT_ID"),
      clientEmail: requiredEnv("FIREBASE_CLIENT_EMAIL"),
      privateKey: requiredEnv("FIREBASE_PRIVATE_KEY").replace(/\\n/g, "\n"),
    }),
    databaseURL: requiredEnv("FIREBASE_DATABASE_URL"),
  }, "retention-cleanup");
}

function snapshotArray(snap) {
  const v = snap.val();
  if (!v || typeof v !== "object") return [];
  return Object.keys(v).map((id) => Object.assign({ id: id }, v[id]));
}

export default async function handler() {
  const db = getDatabase(adminApp());
  const hours = Number(process.env.RETENTION_HOURS || 48);
  const tz = Number(process.env.RETENTION_TZ_OFFSET_MINUTES || 330);
  const dryRun = (process.env.RETENTION_DRY_RUN || "true").toLowerCase() !== "false";
  const maxPerRun = Number(process.env.RETENTION_MAX_PER_RUN || 500);

  const cfg = defaultRetentionConfig({
    retentionMs: hours * 3600 * 1000,
    tzOffsetMinutes: tz,
    dryRun: dryRun,
    maxDeletesPerRun: maxPerRun,
  });

  const deps = {
    getExams: async () => snapshotArray(await db.ref("exams").get()),
    getPlans: async () => snapshotArray(await db.ref("seating_plans").get()),
    examExists: async (id) => (await db.ref("exams/" + id).get()).exists(),
    write: async (updates) => { await db.ref("/").update(updates); },
    log: (msg) => console.log(msg),
  };

  const summary = await runRetentionCleanup(deps, cfg);
  console.log("[retention-cleanup] " + JSON.stringify(summary));
  return { statusCode: 200, body: JSON.stringify(summary) };
}