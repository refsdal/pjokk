import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import type { Db } from "../db";
import * as schema from "../db/schema";

// Postgres through Bun's native SQL client. Bun's SQL client is itself a
// connection pool, so one per process is right — and now that apps/server is
// the only caller, the old createPool/createDb split has nothing left to buy.
export const createDb = (url: string): Db =>
  drizzle({ client: new SQL(url), schema });
