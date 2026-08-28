import webpush from "web-push";
import { sql } from "drizzle-orm";
import { loadEnv } from "../src/server/config";
import type { Bindings } from "../src/server/context";
import { app } from "../src/server/index";
import { servicesFor } from "../src/server/services";
import { createMemoryStorage } from "./memory-storage";

// The test rig: one Env, one set of services, one Postgres database.
//
// Replaces @cloudflare/vitest-pool-workers, which supplied `env` (with live
// D1/KV/R2 bindings) and `SELF` (a fetch into the Worker). Those came from
// the runtime; here they are built explicitly, which is a fair trade for
// being able to read what the tests actually depend on.

const vapid = webpush.generateVAPIDKeys();

/** Overridable so CI can point at its own service container. */
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://pjokk:pjokk@127.0.0.1:55432/pjokk_test";

// ONE object for the whole test process — servicesFor memoizes on identity.
export const env: Bindings = loadEnv({
  DATABASE_URL,
  APP_URL: "http://localhost",
  BETTER_AUTH_SECRET: "test-secret-please-ignore",
  S3_BUCKET: "test-bucket",
  S3_ENDPOINT: "http://127.0.0.1:1",
  S3_ACCESS_KEY_ID: "test",
  S3_SECRET_ACCESS_KEY: "test",
  // Landing-page switches. Declared (rather than left undefined) so
  // landing.test.ts can flip them and restore.
  OPEN_SIGNUP: "0",
  INDEXABLE: "0",
  GOOGLE_CLIENT_ID: "test",
  GOOGLE_CLIENT_SECRET: "test",
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  STRIPE_SECRET_KEY: "sk_test_fake",
  STRIPE_WEBHOOK_SECRET: "whsec_test_fake",
  STRIPE_PRICE_PREMIUM_MONTHLY: "price_test_monthly",
  STRIPE_PRICE_PREMIUM_YEARLY: "price_test_yearly",
  STRIPE_PRICE_PREMIUM_LIFETIME: "price_test_lifetime",
});

// In-memory object storage — the S3_* values above point nowhere on purpose,
// so a test that bypassed this and reached for the network would fail loudly
// rather than quietly talking to a real bucket.
export const storage = createMemoryStorage();

export const services = servicesFor(env, { storage });

/** Stands in for cloudflare:test's SELF — a fetch straight into the app. */
export const SELF = {
  async fetch(input: string | Request, init?: RequestInit): Promise<Response> {
    const request =
      typeof input === "string" ? new Request(input, init) : input;
    // Hono's fetch may answer synchronously; await normalizes both shapes.
    return await app.fetch(request, env);
  },
};

/** Every table the schema creates, most-dependent first. */
async function tableNames(): Promise<string[]> {
  const rows = (await services.db.execute(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  )) as unknown as { tablename: string }[];
  return rows.map((r) => r.tablename);
}

/**
 * Empties every table.
 *
 * TRUNCATE … CASCADE in one statement, rather than deleting per table in
 * dependency order: the foreign keys make ordering fiddly and it would have
 * to be maintained by hand as tables are added.
 */
export async function resetDb(): Promise<void> {
  const tables = await tableNames();
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t}"`).join(", ");
  await services.db.execute(
    sql.raw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`),
  );
  storage.clear();
}
