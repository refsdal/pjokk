import { runCron } from "./cron-cli";
import { loadEnv } from "./env";
import { applyMigrations, runMigrate } from "./migrate";
import { runServer } from "./main";
import { runWorker } from "./worker";

// One binary, several modes. The imports are STATIC on purpose: selecting a
// branch with `await import()` makes Bun's bundler split it into a lazily
// initialised chunk, which breaks module-initialisation ordering inside a
// compiled binary and crashes with "tsyringe requires a reflect polyfill" —
// tsyringe arrives via better-auth's passkey support through
// @peculiar/x509, and its decorators need reflect-metadata to have run
// first. Verified during the spike; do not "optimise" this into a dynamic
// import.

const mode = process.argv[2];

if (mode === "cron") {
  await runCron(process.argv[3] ?? "");
} else if (mode === "migrate" || mode === "migrations") {
  await runMigrate();
} else if (mode === "server") {
  // HTTP only — no startup migration, no in-process scheduler. What
  // replicas run: migration is owned by the default mode's advisory-locked
  // step (or an explicit one-off `migrate`), and the scheduler is owned by
  // exactly one `worker` process (or Kubernetes CronJobs), never by every
  // HTTP replica at once.
  await runServer({ scheduler: false });
} else if (mode === "worker") {
  // Scheduler only, plus a minimal /healthz — see worker.ts for why.
  await runWorker();
} else if (mode === "healthcheck") {
  // distroless has no shell, so Docker's HEALTHCHECK runs this instead of
  // the old `bun -e "fetch(...)"` one-liner.
  //
  // Reads process.env.PORT directly rather than through loadEnv() on
  // purpose: a liveness probe should not fail just because DATABASE_URL or
  // the S3 vars are unset or wrong — those belong to /readyz, not here.
  const port = process.env.PORT ?? "3000";
  const res = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null);
  process.exit(res?.ok ? 0 : 1);
} else if (!mode) {
  // No subcommand: migrate under an advisory lock (safe even if several
  // containers boot at once — see migrate.ts), then start the web server
  // with its in-process scheduler. The default, and what a plain
  // `docker run` (or the container's own ENTRYPOINT with no args) exercises
  // for a single-container deployment.
  await applyMigrations(loadEnv(process.env).DATABASE_URL);
  await runServer({ scheduler: true });
} else {
  // An unrecognised subcommand must NOT fall through to the server: a
  // typo'd `dispatch migrationz` in a Kubernetes Job would otherwise
  // silently become a pod that starts a web server and never completes,
  // instead of failing loudly.
  console.error(
    `Unknown dispatch mode: "${mode}". Expected one of: server, worker, migrate (or migrations), cron, healthcheck, or no argument to migrate-then-serve.`,
  );
  process.exit(2);
}
