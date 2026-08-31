import { sql } from "drizzle-orm";
import type { Deps } from "../deps";

// Nightly database → object-storage backup: a JSON snapshot of every table,
// keyed by date. At family scale a row dump is plenty, and it stays portable
// across whatever runs the database. Restores are manual by design.
//
// (A row dump rather than pg_dump on purpose: the app should not need a
// Postgres client binary in its image to back itself up.)
export const BACKUP_TABLES = [
  "user",
  "session",
  "account",
  "verification",
  "organization",
  "member",
  "invitation",
  "passkey",
  "subscription",
  "baby",
  "feed_log",
  "diaper_log",
  "sleep_log",
  "medicine_log",
  "bath_log",
  "note_log",
  "milestone_log",
  "measurement_log",
  "pump_log",
  "play_log",
  "vaccine_log",
  "vaccine_document",
  "vaccine_dismissal",
  "family_invite",
  "sleep_location",
  "contact",
  "contact_baby",
  "calendar_event",
  "calendar_event_baby",
  "calendar_assignee",
  "push_subscription",
  "push_pref",
  "api_key",
  "admin_audit",
];

export async function runBackup(deps: Deps, now = deps.now()) {
  const { db, storage } = deps;
  const dump: Record<string, unknown[]> = {};
  for (const table of BACKUP_TABLES) {
    // BACKUP_TABLES is a hard-coded list in this file, never user input, so
    // interpolating the identifier is safe — but it is quoted all the same,
    // because "user" is a reserved word in Postgres and an unquoted SELECT
    // * FROM user would silently mean the current_user function.
    // Bun's driver returns the rows directly rather than a { rows } wrapper.
    const rows = (await db.execute(
      sql.raw(`SELECT * FROM "${table}"`),
    )) as unknown as Record<string, unknown>[];
    // Issue #4: keep credential material out of the snapshot. A restore
    // loses dev passwords (Google/passkey users are unaffected) — that's
    // the right trade.
    dump[table] =
      table === "account"
        ? rows.map((row) => ({ ...row, password: null }))
        : rows;
  }
  const key = `backups/${now.toISOString().slice(0, 10)}.json`;
  await storage.put(
    key,
    JSON.stringify({ exportedAt: now.toISOString(), tables: dump }),
    "application/json",
  );
  return key;
}

// Backups hold every table, health data included, so keeping them forever
// would both breach storage limitation and quietly defeat erasure: a
// deleted family would live on in every older snapshot. Thirty days is the
// window the privacy policy commits to for a deletion to fully take effect.
export const BACKUP_RETENTION_DAYS = 30;

/** Deletes backup snapshots older than the retention window. Returns the
 *  keys removed, so the cron can log a count. */
export async function pruneBackups(deps: Deps, now = deps.now()) {
  const cutoff = new Date(
    now.getTime() - BACKUP_RETENTION_DAYS * 24 * 3600_000,
  );
  // Pagination now happens inside storage.list(); the cursor loop that used
  // to live here was R2 API detail leaking into a retention policy.
  const objects = await deps.storage.list("backups/");
  const stale = objects.filter((o) => {
    // Prefer the date in the key (stable, and what names the snapshot); fall
    // back to the object's upload time for anything unexpected.
    const match = /^backups\/(\d{4}-\d{2}-\d{2})\.json$/.exec(o.key);
    const stamp = match ? new Date(`${match[1]}T00:00:00Z`) : o.uploadedAt;
    return stamp.getTime() < cutoff.getTime();
  });
  if (stale.length > 0) {
    await deps.storage.delete(stale.map((o) => o.key));
  }
  return stale.map((o) => o.key);
}
