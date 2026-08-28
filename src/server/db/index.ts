import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "./schema";

// Postgres through Bun's native SQL client.
//
// On Workers this module took a D1Database binding and had to be called
// per-request, because bindings only existed inside the request handler. A
// long-lived process has no such constraint: one pool is created at startup
// and shared, which is also what makes real transactions available (D1 had
// only batch(), and the multi-statement writes were shaped around that).

/** Bun's SQL client is itself a connection pool, so one per process is right.
 *  Kept separate from createDb so tests can share a pool across suites. */
export function createPool(url: string): SQL {
  return new SQL(url);
}

export function createDb(client: SQL) {
  return drizzle({ client, schema });
}

export type Db = ReturnType<typeof createDb>;
export { schema };
