import { isJob, JOBS, runJob } from "./cron";
import { loadEnv } from "./env";
import { createDeps } from "./deps";

// One-shot cron entrypoint: `bun run apps/server/src/cron-cli.ts <job>`.
//
// This is what a Kubernetes CronJob invokes. It runs the job once, then
// exits with a status the scheduler can act on — a failed backup should show
// up as a failed CronJob, not as a line in a log nobody reads.

export async function runCron(job: string) {
  if (!job || !isJob(job)) {
    console.error(`usage: cron-cli <${JOBS.join("|")}>`);
    process.exit(2);
  }

  // A one-shot process never listens, so there is no peer address to read and
  // nothing here reads the rate limiter either way.
  const deps = createDeps(loadEnv(process.env), { current: undefined });

  try {
    await runJob(job, deps);
    process.exit(0);
  } catch (error) {
    console.error(`cron: ${job} failed`, error);
    process.exit(1);
  }
}
