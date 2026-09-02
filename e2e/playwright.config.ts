import { defineConfig, devices } from "@playwright/test";

// The E2E suite drives the REAL production artifact: the Go binary (or the
// container image) serving the embedded SPA against a real Postgres — never
// the vite dev server, so what passes here is what ships. Start the stack
// with `bash scripts/e2e-stack.sh up` (or let `mise run e2e` do everything).
//
// Workers = 1 on purpose: the specs share one database and one signup-open
// app instance; user isolation is per-spec via unique emails, but ordering
// noise (rate limits, invite counts) is not worth parallelism at this size.
export default defineConfig({
  testDir: ".",
  workers: 1,
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3300",
    trace: "retain-on-failure",
    ...devices["Pixel 7"], // Pjokk is mobile-first; Chromium mobile profile (one browser)
  },
});
