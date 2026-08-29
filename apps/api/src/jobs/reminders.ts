import { and, eq, gt, max } from "drizzle-orm";
import { schema } from "../db";
import type { Deps } from "../deps";

// Feed reminders: one nudge per gap. A caretaker with feedReminderHours=N
// gets a push when the family hasn't logged a feed for N hours — once, until
// a new feed starts a new gap (lastRemindedAt < lastFeed gates re-sending).
export async function runReminders(deps: Deps, now = deps.now().getTime()) {
  const { db, push } = deps;
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
    const delivered = await push.toUser(pref.userId, {
      title: "Pjokk",
      body: `No feed logged for ${hours} h`,
      url: "/home",
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
