import type { SQL } from "bun";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import * as schema from "./schema";

// Postgres through Bun's native SQL client.
//
// On Workers this module took a D1Database binding and had to be called
// per-request, because bindings only existed inside the request handler. A
// long-lived process has no such constraint: one pool is created at startup
// and shared, which is also what makes real transactions available (D1 had
// only batch(), and the multi-statement writes were shaped around that).
//
// Construction lives in ./infrastructure/db.ts now — this file is type-only
// so ports/services code can depend on the shape of Db without pulling in
// the composition root's construction logic.

/**
 * `& { $client: SQL }` is required, not decorative: drizzle() is declared as
 * returning `BunSQLDatabase<TSchema> & { $client: TClient }`, so the bare
 * class annotation drops $client — and the test suite calls db.$client.end()
 * in afterAll, because Bun keeps the process alive while the pool holds
 * handles.
 */
export type Db = BunSQLDatabase<typeof schema> & { $client: SQL };

export { schema };
