import { describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { deps } from "./rig";
import { BACKUP_TABLES } from "../src/jobs/backup";

// This tests list *completeness* against the live schema — a different
// concern from backup.test.ts, which tests backup *behaviour*.
//
// Every table the schema creates must be either backed up or deliberately
// excluded — a table in neither set is silent data loss on restore.
const DELIBERATELY_EXCLUDED = [
  // Fixed-window rate-limit counters: ephemeral by design, and a restore
  // that resurrected week-old counters would only confuse the limiter.
  "rate_limit",
];

async function publicTables(): Promise<string[]> {
  const rows = (await deps.db.execute(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  )) as unknown as { tablename: string }[];
  return rows.map((r) => r.tablename);
}

describe("BACKUP_TABLES vs. the live schema", () => {
  it("backs up (or deliberately excludes) every table in the schema", async () => {
    const covered = new Set([...BACKUP_TABLES, ...DELIBERATELY_EXCLUDED]);
    const tables = await publicTables();
    const uncovered = tables.filter((t) => !covered.has(t));
    expect(uncovered).toEqual([]);
  });

  it("has no stale entry for a table that no longer exists in the schema", async () => {
    const tables = new Set(await publicTables());
    const stale = BACKUP_TABLES.filter((t) => !tables.has(t));
    expect(stale).toEqual([]);
  });
});
