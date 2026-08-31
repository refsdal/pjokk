import { pruneBackups, runBackup } from "@pjokk/api/jobs/backup";
import { runCalendarReminders } from "@pjokk/api/jobs/calendar-reminders";
import { purgeOrphanUsers, reconcilePlans } from "@pjokk/api/jobs/plans";
import { runReminders } from "@pjokk/api/jobs/reminders";
import type { Deps } from "@pjokk/api/deps";

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
// scheduler runs only under the default single-container dispatch mode or
// the dedicated `worker` mode — never under `server`, which is what
// replicas run.

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

export const SCHEDULES = {
  nightly: "15 3 * * *",
  frequent: "*/15 * * * *",
} as const;

/**
 * In-process scheduler for the default single-container dispatch mode and
 * the dedicated `worker` mode.
 *
 * Bun.cron is a builtin as of Bun 1.4, which retires this file's previous
 * hand-rolled 15-minute tick — and with it two real defects: the nightly job
 * fired at whichever tick first landed past 03:15 (so its actual time
 * depended on when the process started), and setInterval would start a
 * second nightly run if the first outlived the interval, which matters for a
 * job that reads every table and writes a snapshot to object storage.
 *
 * tz is UTC explicitly. The default is the system zone, and the image does
 * not set TZ — so it is UTC by accident, not by contract, while the 30-day
 * backup retention window is a privacy-policy commitment stated in UTC.
 * "15 3 * * *" resolves to 03:15Z under UTC and 01:15Z under Europe/Oslo.
 *
 * The try/catch is load-bearing. Bun.cron matches setTimeout's error
 * semantics: a rejected promise emits unhandledRejection and, with no
 * listener, exits the process with code 1. The job reschedules itself after
 * an error, so catching here turns a transient database blip into a logged
 * line instead of a pod restart loop.
 *
 * NOTE: this fires once per replica, exactly as setInterval did. With more
 * than one replica, drive the jobs from Kubernetes CronJobs (or a single
 * dedicated `worker` replica) instead of running `server` mode with this
 * started too.
 */
export function startScheduler(deps: Deps): () => void {
  const jobs = (Object.keys(SCHEDULES) as Job[]).map((job) =>
    Bun.cron(
      SCHEDULES[job],
      async () => {
        try {
          await runJob(job, deps);
        } catch (error) {
          console.error(`cron: ${job} failed`, error);
        }
      },
      { tz: "UTC" },
    ),
  );
  return () => {
    for (const job of jobs) job.stop();
  };
}
