import { afterAll, beforeAll, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { rateLimit } from "../src/server/db/schema";
import { services, resetDb } from "./rig";

// Preloaded before every test file (see bunfig.toml).
//
// Replaces applyD1Migrations from @cloudflare/vitest-pool-workers: the schema
// is applied once against the test database, then every test starts from an
// empty one.

const MIGRATION = new URL("../migrations/0000_init.sql", import.meta.url);

async function schemaIsApplied(): Promise<boolean> {
  const rows = (await services.db.execute(
    sql`SELECT to_regclass('public.baby') AS present`,
  )) as unknown as { present: string | null }[];
  return Boolean(rows[0]?.present);
}

if (!(await schemaIsApplied())) {
  const ddl = await Bun.file(MIGRATION).text();
  // drizzle-kit separates statements with a breakpoint marker; Postgres can
  // take the whole file at once, so the marker is simply stripped.
  await services.db.execute(
    sql.raw(ddl.replaceAll("--> statement-breakpoint", "")),
  );
}

// Each test FILE starts from an empty database — matching the per-file
// isolation vitest-pool-workers gave each Worker. Not beforeEach: the suites
// were written against that model and set their fixtures up in beforeAll, so
// emptying between tests would delete the rows they are about to assert on.
beforeAll(async () => {
  await resetDb();
});

// Rate-limit counters are cleared between individual tests.
//
// They used to live in KV, which vitest-pool-workers gave each Worker its own
// copy of, so every file started with an empty limiter. One shared Postgres
// table does not reset by itself, and the sign-in brake (20 per 10 minutes,
// all tests sharing the "unknown" bucket for want of a peer address) would
// otherwise start 429-ing partway through the suite. Cleared per test, not
// per file, because a single file signs in far more than twenty times —
// while still letting one test accumulate hits and assert on the 429.
beforeEach(async () => {
  await services.db.delete(rateLimit);
});

afterAll(async () => {
  // Bun keeps the process alive while the pool has open handles.
  await services.db.$client.end();
});
