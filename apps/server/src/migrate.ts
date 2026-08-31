import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import * as schema from "@pjokk/api/db/schema";
import { loadEnv } from "./env";

// Applies pending migrations, guarded by a Postgres advisory lock so that N
// replicas — or the default dispatch mode racing a one-off `migrate` job —
// booting at the same moment serialise instead of racing to apply the same
// DDL: the first to acquire the lock migrates, the rest block until it
// releases, then find nothing pending and return immediately.
//
// Uses drizzle-orm's migrator rather than the drizzle-kit CLI on purpose:
// drizzle-kit is a devDependency and has no place in a production image,
// while drizzle-orm is already there to run the app.

/**
 * Fixed advisory-lock key for the migration step. Any distinct int64 works —
 * the only requirement is that it MUST NEVER CHANGE. pg_advisory_lock
 * contends by key: renumbering this later means an old and a new binary
 * running side by side (mid-rollout) would use different keys, stop
 * contending with each other, and the whole point of this lock — serialising
 * concurrent migrators — silently stops working with no error anywhere.
 */
export const MIGRATION_LOCK_KEY = 7245_0001;

/**
 * Runs the migration under the advisory lock and THROWS on failure — it does
 * not call process.exit, so it is safe to call from the default dispatch
 * mode (which continues on to start the server) as well as from the one-off
 * `migrate` mode (whose thin wrapper below owns the exit code).
 *
 * Bun's `SQL` client is itself a connection pool, and pg_advisory_lock is
 * per-SESSION (i.e. per physical connection) — but drizzle's migrator issues
 * several independent statements through the session (CREATE SCHEMA, CREATE
 * TABLE IF NOT EXISTS, a SELECT, then a transaction for the actual DDL), and
 * a pooled client would be free to hand each of those a different physical
 * connection. That would silently defeat the lock: the CREATE/SELECT/
 * transaction could run on a connection nobody holds the lock on, and the
 * unlock at the end could target a connection that never held it either. So
 * this uses a DEDICATED client with `max: 1` for the whole migrate step
 * (never the pooled client from `createDb`) — with only one physical
 * connection in the pool, every borrow-and-return from the lock, the
 * migration, and the unlock resolves to that same connection, which is the
 * same-session guarantee pg_advisory_lock needs. Verified in
 * `test/migrate.test.ts` by observing a second, independent connection
 * genuinely block on `pg_advisory_lock` while this one holds it, using
 * `pg_stat_activity` as ground truth rather than a fixed sleep.
 */
export async function applyMigrations(url: string): Promise<void> {
  const client = new SQL(url, { max: 1 });
  try {
    await client`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    try {
      const db = drizzle({ client, schema });
      // Resolved against the working directory. Inside the image that is
      // /app, where the Dockerfile copies the SQL to ./migrations, so the
      // default is correct there and the variable is left unset. From a
      // source checkout the folder is under apps/api, which is what the root
      // `migrate` script passes.
      const migrationsFolder = process.env.MIGRATIONS_DIR ?? "./migrations";
      await migrate(db, { migrationsFolder });
    } finally {
      await client`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    }
  } finally {
    await client.end();
  }
}

/**
 * Thin wrapper for the `migrate`/`migrations` dispatch mode: loads env,
 * calls applyMigrations, and keeps the one-off job's existing exit codes and
 * log messages.
 */
export async function runMigrate() {
  const env = loadEnv(process.env);
  try {
    await applyMigrations(env.DATABASE_URL);
    console.log("migrations applied");
    process.exit(0);
  } catch (error) {
    console.error("migration failed", error);
    process.exit(1);
  }
}
