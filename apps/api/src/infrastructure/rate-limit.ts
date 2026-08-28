import { lt, sql } from "drizzle-orm";
import type { Db } from "../db";
import { rateLimit } from "../db/schema";
import type { RateLimitStore } from "../ports";

// Fixed-window rate-limit counters, replacing the KV namespace.
//
// KV was eventually consistent, so the old limiter read a value, compared it
// and wrote back — a race the comment there accepted as "a brake, not an
// invariant". Postgres removes the compromise: one statement increments and
// returns the new value atomically, so the limit is exact even when several
// replicas serve the same attacker concurrently.

export function createRateLimitStore(db: Db): RateLimitStore {
  return {
    async hit(key, windowSeconds) {
      // Kept generous: the row lives well past its window so a clock skew
      // between replicas cannot resurrect a bucket that should have expired.
      const expiresAt = new Date(
        Date.now() + Math.max(60, windowSeconds * 2) * 1000,
      );
      const rows = await db
        .insert(rateLimit)
        .values({ key, count: 1, expiresAt })
        .onConflictDoUpdate({
          target: rateLimit.key,
          set: { count: sql`${rateLimit.count} + 1` },
        })
        .returning({ count: rateLimit.count });
      return rows[0]?.count ?? 1;
    },

    async sweep(now = new Date()) {
      const rows = await db
        .delete(rateLimit)
        .where(lt(rateLimit.expiresAt, now))
        .returning({ key: rateLimit.key });
      return rows.length;
    },
  };
}
