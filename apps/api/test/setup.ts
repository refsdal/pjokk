import { afterAll, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { resetDb, services } from "./rig";

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

// EVERY TEST starts from an empty database and an empty object store.
//
// It has to be beforeEach, and the reason is a genuine trap: a `beforeAll`
// registered in a PRELOAD file fires once for the whole run — only for the
// first test file — not once per file. So resetting there left every
// subsequent file inheriting whatever the previous ones had written, and the
// suite passed or failed purely on file order. CI found it: backup.test.ts
// expected the one feed it had created and saw nineteen.
//
// Hooks registered inside a test file ARE file-scoped, and a preload's
// beforeEach runs before the file's own — so fixtures built in a file-level
// beforeEach still land on a clean database.
//
// This also covers the rate-limit counters, which otherwise accumulate: the
// sign-in brake is 20 per 10 minutes and every test shares the "unknown"
// bucket for want of a peer address, so the suite would start 429-ing partway
// through. A test that wants to assert on a 429 still can — it accumulates
// its own hits within the test.
beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  // Bun keeps the process alive while the pool has open handles.
  await services.db.$client.end();
});
