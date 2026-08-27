import {
  and,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  max,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { createDb, schema } from "./db";
import { pushToUser } from "./push";
import { TOMBSTONE_ID } from "./db/tombstone";
import { PREMIUM_STATUSES, applySubscriptionStatus } from "./billing";

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
      // Id, never the email: Workers logs are outside our retention control,
      // and an address there is personal data we cannot later erase.
      console.log(`purge: removed orphan account ${orphan.id}`);
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

// Calendar reminders: push when now enters [start − lead, start]. remindedAt
// is the idempotency latch (same idea as feed reminders' lastRemindedAt);
// editing an event's time or lead resets it (see routes/calendar.ts). Events
// whose start is >60 min past are latched WITHOUT sending — after downtime a
// late reminder is worse than none.
// workerd's default TZ is UTC, so without an explicit zone a 14:00 CEST
// appointment would push as "12:00" (repo convention: Norwegian defaults,
// quietly — see CLAUDE.md). Exported so tests can assert Oslo-local
// formatting directly; the pushed body itself is unobservable through the
// test fetch stub (web-push encrypts the payload before the HTTP call).
export const clockFmt = new Intl.DateTimeFormat("nb-NO", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Europe/Oslo",
});

export async function runCalendarReminders(env: Env, now = Date.now()) {
  const db = createDb(env.DB);
  const pending = and(
    isNotNull(schema.calendarEvent.remindMinutesBefore),
    isNull(schema.calendarEvent.remindedAt),
  );

  // Grace window: latch long-past events so they never fire late.
  await db
    .update(schema.calendarEvent)
    .set({ remindedAt: new Date(now) })
    .where(
      and(
        pending,
        lt(schema.calendarEvent.startTime, new Date(now - 3600_000)),
      ),
    );

  const due = await db
    .select({
      id: schema.calendarEvent.id,
      familyId: schema.calendarEvent.familyId,
      title: schema.calendarEvent.title,
      startTime: schema.calendarEvent.startTime,
      allDay: schema.calendarEvent.allDay,
    })
    .from(schema.calendarEvent)
    .where(
      and(
        pending,
        gte(schema.calendarEvent.startTime, new Date(now - 3600_000)),
        // start_time and now are both ms epochs in SQLite.
        sql`${schema.calendarEvent.startTime} - ${schema.calendarEvent.remindMinutesBefore} * 60000 <= ${now}`,
      ),
    );

  let sent = 0;
  for (const event of due) {
    const assignees = await db
      .select({ userId: schema.calendarAssignee.userId })
      .from(schema.calendarAssignee)
      .where(eq(schema.calendarAssignee.eventId, event.id));
    const targets =
      assignees.length > 0
        ? assignees.map((a) => a.userId)
        : (
            await db
              .select({ userId: schema.member.userId })
              .from(schema.member)
              .where(eq(schema.member.organizationId, event.familyId))
          ).map((m) => m.userId);

    const body = event.allDay
      ? event.title
      : `${event.title} · ${clockFmt.format(event.startTime)}`;
    for (const userId of targets) {
      sent += await pushToUser(db, env, userId, {
        title: "Pjokk",
        body,
        url: "/calendar",
      });
    }
    // Latch even when every delivery failed — retrying each cron tick would
    // hammer dead subscriptions for no benefit.
    await db
      .update(schema.calendarEvent)
      .set({ remindedAt: new Date(now) })
      .where(eq(schema.calendarEvent.id, event.id));
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

// Compensating control for the plugin's fire-and-forget webhook hooks (see
// DECISIONS.md Phase 9): onSubscriptionComplete/Update/Cancel/Deleted swallow
// errors internally so Stripe always sees a 200, which means a failed
// applySubscriptionStatus D1 write is never retried by Stripe. A paying
// family could sit on plan "free" indefinitely. This nightly sweep finds
// that mismatch and repairs it — one-directional only (free -> premium),
// never a downgrade, so it can never race a subscription webhook the wrong
// way: at worst it repeats work applySubscriptionStatus already did.
export async function reconcilePlans(env: Env) {
  const db = createDb(env.DB);
  const stuck = await db
    .select({
      id: schema.organization.id,
      status: schema.subscription.status,
    })
    .from(schema.organization)
    .innerJoin(
      schema.subscription,
      eq(schema.subscription.referenceId, schema.organization.id),
    )
    .where(
      and(
        eq(schema.organization.plan, "free"),
        inArray(schema.subscription.status, [...PREMIUM_STATUSES]),
      ),
    );
  const seen = new Set<string>();
  let flipped = 0;
  for (const fam of stuck) {
    if (seen.has(fam.id)) continue;
    seen.add(fam.id);
    await applySubscriptionStatus(db, fam.id, fam.status);
    flipped++;
  }
  return flipped;
}

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

// Backups hold every table, health data included, so keeping them forever
// would both breach storage limitation and quietly defeat erasure: a
// deleted family would live on in every older snapshot. Thirty days is the
// window the privacy policy commits to for a deletion to fully take effect.
export const BACKUP_RETENTION_DAYS = 30;

/** Deletes backup snapshots older than the retention window. Returns the
 *  keys removed, so the cron can log a count. */
export async function pruneBackups(env: Env, now = new Date()) {
  const cutoff = new Date(
    now.getTime() - BACKUP_RETENTION_DAYS * 24 * 3600_000,
  );
  const removed: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.FILES.list({ prefix: "backups/", cursor });
    const stale = page.objects.filter((o) => {
      // Prefer the date in the key (stable, and what names the snapshot);
      // fall back to R2's upload time for anything unexpected.
      const match = /^backups\/(\d{4}-\d{2}-\d{2})\.json$/.exec(o.key);
      const stamp = match ? new Date(`${match[1]}T00:00:00Z`) : o.uploaded;
      return stamp.getTime() < cutoff.getTime();
    });
    if (stale.length > 0) {
      await env.FILES.delete(stale.map((o) => o.key));
      removed.push(...stale.map((o) => o.key));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return removed;
}
