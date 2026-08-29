import { and, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { schema } from "../db";
import type { Deps } from "../deps";

// Calendar reminders: push when now enters [start − lead, start]. remindedAt
// is the idempotency latch (same idea as feed reminders' lastRemindedAt);
// editing an event's time or lead resets it (see routes/calendar.ts). Events
// whose start is >60 min past are latched WITHOUT sending — after downtime a
// late reminder is worse than none.
// A container's TZ is UTC unless told otherwise, so without an explicit zone
// a 14:00 CEST appointment would push as "12:00" (repo convention: Norwegian
// defaults, quietly — see CLAUDE.md). Exported so tests can assert Oslo-local
// formatting directly; the pushed body itself is unobservable through the
// test fetch stub (web-push encrypts the payload before the HTTP call).
export const clockFmt = new Intl.DateTimeFormat("nb-NO", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Europe/Oslo",
});

export async function runCalendarReminders(
  deps: Deps,
  now = deps.now().getTime(),
) {
  const { db, push } = deps;
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
        // "the reminder is due": start_time minus the lead time is in the
        // past. This was epoch-millisecond arithmetic when both sides were
        // integers in SQLite; on a timestamptz the lead time has to be a real
        // interval, because `timestamptz - integer` is not an operator
        // Postgres defines.
        sql`${schema.calendarEvent.startTime} - (${schema.calendarEvent.remindMinutesBefore} * interval '1 minute') <= ${new Date(now)}`,
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
      sent += await push.toUser(userId, {
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
