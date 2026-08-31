import { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { applyMigrations, MIGRATION_LOCK_KEY } from "../src/migrate";

// Overridable so CI can point at its own service container — same pattern as
// apps/api/test/rig.ts.
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://pjokk:pjokk@127.0.0.1:55432/pjokk_test";

// applyMigrations resolves MIGRATIONS_DIR against the working directory
// (unset means "./migrations", correct only inside the built image). `bun
// test` here runs with apps/server as cwd, so point it at the real folder —
// the same override the root `migrate` script passes from the repo root.
process.env.MIGRATIONS_DIR = `${import.meta.dir}/../../api/migrations`;

describe("applyMigrations", () => {
  test("serialises with a concurrent holder of the same advisory lock", async () => {
    // A second, independent connection takes the lock first — standing in
    // for a sibling replica that won the race to migrate.
    const holder = new SQL(DATABASE_URL, { max: 1 });
    try {
      const [{ locked }] = await holder<{ locked: boolean }[]>`
          select pg_try_advisory_lock(${MIGRATION_LOCK_KEY}) as locked
        `;
      expect(locked).toBe(true);

      // applyMigrations' own client should now be genuinely blocked
      // acquiring the same lock, not racing past it. Kick it off and prove
      // that with Postgres's own bookkeeping (pg_stat_activity) rather than
      // a fixed sleep + "did it resolve yet" guess: poll until a backend
      // other than `holder` shows up waiting on a pg_advisory_lock call, or
      // give up after a generous bound. The assertion below is what makes
      // this deterministic — it fails loudly if that state is never
      // observed, rather than silently passing on a lucky timing window.
      const migrationDone = applyMigrations(DATABASE_URL);

      let sawWaiter = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const [{ n }] = await holder<{ n: number }[]>`
            select count(*)::int as n
            from pg_stat_activity
            where wait_event_type = 'Lock'
              and query ilike '%pg_advisory_lock%'
              and pid <> pg_backend_pid()
          `;
        if (n > 0) {
          sawWaiter = true;
          break;
        }
        await Bun.sleep(40);
      }
      expect(sawWaiter).toBe(true);

      // Release the lock; the blocked applyMigrations call should now
      // proceed (find nothing pending, since the test DB is already
      // migrated) and resolve without throwing.
      await holder`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
      await expect(migrationDone).resolves.toBeUndefined();
    } finally {
      await holder.end();
    }
  }, 15000);

  test("throws rather than exits on failure", async () => {
    // A syntactically valid connection string pointing at a database that
    // does not exist. process.exit inside this function would kill the test
    // runner instead of failing the assertion, so this is also a guard
    // against that regression.
    const badUrl =
      "postgres://pjokk:pjokk@127.0.0.1:55432/pjokk_does_not_exist";
    await expect(applyMigrations(badUrl)).rejects.toBeTruthy();
  });
});
