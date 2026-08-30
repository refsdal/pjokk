import { runCron } from "./cron-cli";
import { runMigrate } from "./migrate";
import { runServer } from "./main";

// One binary, four modes. The imports are STATIC on purpose: selecting a
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
} else if (mode === "migrate") {
  await runMigrate();
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
} else {
  await runServer();
}
