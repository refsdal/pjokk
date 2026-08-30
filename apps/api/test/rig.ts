import webpush from "web-push";
import { sql } from "drizzle-orm";
import { createApi } from "../src/app";
import type { Deps } from "../src/deps";
import {
  createAuth,
  createDb,
  createPushSender,
  createRateLimitStore,
  createStripe,
} from "../src/infrastructure";
import { createMemoryStorage } from "./memory-storage";

// The test rig: one Deps object, one Postgres database, one in-memory store.
//
// Replaces @cloudflare/vitest-pool-workers, which supplied `env` (with live
// D1/KV/R2 bindings) and `SELF` (a fetch into the Worker). Those came from
// the runtime; here they are built explicitly, which is a fair trade for
// being able to read what the tests actually depend on.
//
// This states Deps literally rather than parsing it from an Env object: this
// package must not depend on apps/server, and Deps — not Env — is the actual
// contract apps/api depends on.

const vapid = webpush.generateVAPIDKeys();

/** Overridable so CI can point at its own service container. */
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://pjokk:pjokk@127.0.0.1:55432/pjokk_test";

const db = createDb(DATABASE_URL);

// In-memory object storage — no S3 config is passed anywhere in this rig, so
// a test that bypassed this and reached for the network would fail loudly
// rather than quietly talking to a real bucket.
export const storage = createMemoryStorage();

// Built once and shared between better-auth's stripe plugin and deps.stripe,
// exactly as production shares one Deps object between every consumer. A
// client, not null: the secret below is "sk_test_fake", so
// createStripe() returns one and both the plugin and the billing/admin
// routes take their client-present branch. Passing null to either would
// silently flip tests onto the "not configured" path — a behaviour change
// wearing the costume of a simplification.
const stripeClient = createStripe("sk_test_fake");

export const deps: Deps = {
  db,
  auth: createAuth(
    {
      appUrl: "http://localhost",
      secret: "test-secret-please-ignore",
      googleClientId: "test",
      googleClientSecret: "test",
      stripeWebhookSecret: "whsec_test_fake",
      stripePriceMonthly: "price_test_monthly",
      stripePriceYearly: "price_test_yearly",
      openSignup: false,
    },
    db,
    stripeClient,
  ),
  storage,
  rateLimit: createRateLimitStore(db),
  push: createPushSender(db, {
    appUrl: "http://localhost",
    publicKey: vapid.publicKey,
    privateKey: vapid.privateKey,
  }),
  stripe: stripeClient,
  peerAddress: () => null, // no listening server in tests
  now: () => new Date(),
  appUrl: "http://localhost",
  vapidPublicKey: vapid.publicKey,
  stripePriceLifetime: "price_test_lifetime",
  trustedProxyHops: 0,
};

// Kept for the handful of test files that predate Deps and still say
// "services" — same object, so nothing about what they exercise changes.
export const services = deps;

export const app = createApi(deps);

/** Stands in for cloudflare:test's SELF — a fetch straight into the app. */
export const SELF = {
  async fetch(input: string | Request, init?: RequestInit): Promise<Response> {
    const request =
      typeof input === "string" ? new Request(input, init) : input;
    // Hono's fetch may answer synchronously; await normalizes both shapes.
    // There is no env to pass any more — every collaborator is already
    // closed over inside createApi(deps).
    return await app.fetch(request);
  },
};

/** Every table the schema creates, most-dependent first. */
async function tableNames(): Promise<string[]> {
  const rows = (await deps.db.execute(
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
  await deps.db.execute(sql.raw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`));
  storage.clear();
}
