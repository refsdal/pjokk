import {
  pruneBackups,
  purgeOrphanUsers,
  reconcilePlans,
  runBackup,
  runCalendarReminders,
  runReminders,
} from "./scheduled";
import type { Deps } from "./deps";

// The scheduled work that Cloudflare's cron triggers used to drive.
//
// Two jobs, matching the two cron expressions in the old wrangler config:
//   nightly  — 15 3 * * *   backup, prune, orphan purge, plan reconcile
//   frequent — */15 * * * *  feed + calendar reminders
//
// Cloudflare guaranteed exactly one invocation per schedule no matter how
// many isolates were warm. NOTHING guarantees that here: with several
// replicas, an in-process timer in each pod would send every reminder once
// per pod. That is why these are exposed as one-shot functions a Kubernetes
// CronJob can invoke (`bun run cron <job>`), and why the in-process
// scheduler is opt-in via SCHEDULER=1 for single-container deployments.

export const JOBS = ["nightly", "frequent"] as const;
export type Job = (typeof JOBS)[number];

export function isJob(value: string): value is Job {
  return (JOBS as readonly string[]).includes(value);
}

export async function runJob(job: Job, deps: Deps): Promise<void> {
  if (job === "nightly") {
    const key = await runBackup(deps);
    console.log(`cron: backup written to ${key}`);
    const pruned = await pruneBackups(deps);
    if (pruned.length > 0) {
      console.log(`cron: pruned ${pruned.length} expired backup(s)`);
    }
    const purged = await purgeOrphanUsers(deps);
    if (purged > 0) console.log(`cron: purged ${purged} orphan account(s)`);
    const reconciled = await reconcilePlans(deps);
    if (reconciled > 0) {
      console.log(`cron: reconciled ${reconciled} family plan(s) to premium`);
    }
    // KV expired rate-limit entries by itself; the Postgres table does not.
    const swept = await deps.rateLimit.sweep();
    if (swept > 0) console.log(`cron: swept ${swept} rate-limit counter(s)`);
    return;
  }

  const sent = await runReminders(deps);
  if (sent > 0) console.log(`cron: ${sent} reminder(s) sent`);
  const calendarSent = await runCalendarReminders(deps);
  if (calendarSent > 0) {
    console.log(`cron: ${calendarSent} calendar reminder(s) sent`);
  }
}

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

/**
 * In-process scheduler for single-container deployments (SCHEDULER=1).
 *
 * Deliberately simple: a 15-minute tick for the frequent job, and the nightly
 * job when the tick first lands at or after 03:15 UTC on a new day. No cron
 * parser, because there are exactly two schedules and a dependency to express
 * them would earn its keep only if there were more.
 *
 * Returns a stop function so tests and shutdown can clear the timer.
 */
export function startScheduler(deps: Deps): () => void {
  let lastNightlyRun = "";
  const tick = async () => {
    try {
      await runJob("frequent", deps);
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      const past0315 =
        now.getUTCHours() > 3 ||
        (now.getUTCHours() === 3 && now.getUTCMinutes() >= 15);
      if (past0315 && lastNightlyRun !== day) {
        lastNightlyRun = day;
        await runJob("nightly", deps);
      }
    } catch (error) {
      // A failed tick must never kill the timer, or one transient database
      // blip would silently end all scheduled work until the next restart.
      console.error("cron: tick failed", error);
    }
  };
  const timer = setInterval(tick, FIFTEEN_MINUTES_MS);
  return () => clearInterval(timer);
}
