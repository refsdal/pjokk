import { and, eq, gt, isNull, lt, max, ne, notExists, or } from "drizzle-orm";
import { createDb, schema } from "./db";
import { pushToUser } from "./push";
import { TOMBSTONE_ID } from "./db/tombstone";

// Orphan hygiene (sec review H2): accounts created past the invite flow have
// no membership and can't create one — sweep them after a week. Sysadmins
// and anyone with a membership are never touched; FK-protected users (e.g.
// with historical logs) are skipped.
export async function purgeOrphanUsers(env: Env, now = Date.now()) {
  const db = createDb(env.DB);
  const cutoff = new Date(now - 7 * 24 * 3600_000);
  const orphans = await db
    .select({ id: schema.user.id, email: schema.user.email })
    .from(schema.user)
    .where(
      and(
        // better-auth's admin plugin stamps role="user" on every account it
        // creates, so match that AND legacy NULLs — never admins.
        or(isNull(schema.user.role), eq(schema.user.role, "user")),
        ne(schema.user.id, TOMBSTONE_ID),
        lt(schema.user.createdAt, cutoff),
        notExists(
          db
            .select({ id: schema.member.id })
            .from(schema.member)
            .where(eq(schema.member.userId, schema.user.id)),
        ),
      ),
    );
  let purged = 0;
  for (const orphan of orphans) {
    try {
      await db.delete(schema.user).where(eq(schema.user.id, orphan.id));
      purged++;
      console.log(`purge: removed orphan account ${orphan.email}`);
    } catch {
      // FK references (historical data) — leave it alone.
    }
  }
  return purged;
}

// Feed reminders: one nudge per gap. A caretaker with feedReminderHours=N
// gets a push when the family hasn't logged a feed for N hours — once, until
// a new feed starts a new gap (lastRemindedAt < lastFeed gates re-sending).
export async function runReminders(env: Env, now = Date.now()) {
  const db = createDb(env.DB);
  const prefs = await db
    .select()
    .from(schema.pushPref)
    .where(gt(schema.pushPref.feedReminderHours, 0));

  let sent = 0;
  for (const pref of prefs) {
    const lastFeedRows = await db
      .select({ last: max(schema.feedLog.time) })
      .from(schema.feedLog)
      .where(eq(schema.feedLog.familyId, pref.familyId));
    const lastFeed = lastFeedRows[0]?.last;
    if (!lastFeed) continue;

    const gapMs = now - lastFeed.getTime();
    const threshold = pref.feedReminderHours * 3600_000;
    const alreadyReminded =
      pref.lastRemindedAt !== null && pref.lastRemindedAt >= lastFeed;
    if (gapMs < threshold || alreadyReminded) continue;

    const hours = Math.floor(gapMs / 3600_000);
    const delivered = await pushToUser(db, env, pref.userId, {
      title: "Pjokk",
      body: `No feed logged for ${hours} h`,
      url: "/",
    });
    sent += delivered;
    await db
      .update(schema.pushPref)
      .set({ lastRemindedAt: new Date(now) })
      .where(
        and(
          eq(schema.pushPref.userId, pref.userId),
          eq(schema.pushPref.familyId, pref.familyId),
        ),
      );
  }
  return sent;
}

// Nightly D1 → R2 backup: a JSON snapshot of every table, keyed by date.
// (D1 offers no dump API from inside a Worker; at family scale a row dump
// is plenty. Restores are manual by design.)
const BACKUP_TABLES = [
  "user",
  "session",
  "account",
  "verification",
  "organization",
  "member",
  "invitation",
  "passkey",
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
  "family_invite",
  "push_subscription",
  "push_pref",
  "api_key",
  "admin_audit",
];

export async function runBackup(env: Env, now = new Date()) {
  const dump: Record<string, unknown[]> = {};
  for (const table of BACKUP_TABLES) {
    const res = await env.DB.prepare(`SELECT * FROM "${table}"`).all();
    // Issue #4: keep credential material out of the snapshot. A restore
    // loses dev passwords (Google/passkey users are unaffected) — that's
    // the right trade.
    dump[table] =
      table === "account"
        ? res.results.map((row) => ({ ...row, password: null }))
        : res.results;
  }
  const key = `backups/${now.toISOString().slice(0, 10)}.json`;
  await env.FILES.put(
    key,
    JSON.stringify({ exportedAt: now.toISOString(), tables: dump }),
    { httpMetadata: { contentType: "application/json" } },
  );
  return key;
}
