import { loadEnv } from "@pjokk/api/config";
import { isJob, JOBS, runJob } from "@pjokk/api/cron";
import { servicesFor } from "@pjokk/api/services";

// One-shot cron entrypoint: `bun run src/server/cron-cli.ts <job>`.
//
// This is what a Kubernetes CronJob invokes. It runs the job once, then
// exits with a status the scheduler can act on — a failed backup should show
// up as a failed CronJob, not as a line in a log nobody reads.

const job = process.argv[2];

if (!job || !isJob(job)) {
  console.error(`usage: cron-cli <${JOBS.join("|")}>`);
  process.exit(2);
}

const services = servicesFor(loadEnv(process.env));

try {
  await runJob(job, services);
  process.exit(0);
} catch (error) {
  console.error(`cron: ${job} failed`, error);
  process.exit(1);
}
