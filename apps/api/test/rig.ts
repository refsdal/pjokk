import webpush from "web-push";
import { sql } from "drizzle-orm";
import { createApi } from "../src/app";
import { loadEnv } from "../src/config";
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

const vapid = webpush.generateVAPIDKeys();

/** Overridable so CI can point at its own service container. */
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://pjokk:pjokk@127.0.0.1:55432/pjokk_test";

// loadEnv still parses the handful of values Deps is built from below. It
// moves to apps/server in a later task, once apps/api no longer needs it at
// all — Deps, not Env, is the contract this package depends on.
const env = loadEnv({
  DATABASE_URL,
  APP_URL: "http://localhost",
  BETTER_AUTH_SECRET: "test-secret-please-ignore",
  S3_BUCKET: "test-bucket",
  S3_ENDPOINT: "http://127.0.0.1:1",
  S3_ACCESS_KEY_ID: "test",
  S3_SECRET_ACCESS_KEY: "test",
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

const db = createDb(env.DATABASE_URL);

// In-memory object storage — the S3_* values above point nowhere on purpose,
// so a test that bypassed this and reached for the network would fail loudly
// rather than quietly talking to a real bucket.
export const storage = createMemoryStorage();

// Built once and shared between better-auth's stripe plugin and deps.stripe,
// exactly as production shares one Deps object between every consumer. A
// client, not null: STRIPE_SECRET_KEY above is "sk_test_fake", so
// createStripe() returns one and both the plugin and the billing/admin
// routes take their client-present branch. Passing null to either would
// silently flip tests onto the "not configured" path — a behaviour change
// wearing the costume of a simplification.
const stripeClient = createStripe("sk_test_fake");

export const deps: Deps = {
  db,
  auth: createAuth(
    {
      appUrl: env.APP_URL,
      secret: env.BETTER_AUTH_SECRET,
      googleClientId: env.GOOGLE_CLIENT_ID,
      googleClientSecret: env.GOOGLE_CLIENT_SECRET,
      stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
      stripePriceMonthly: env.STRIPE_PRICE_PREMIUM_MONTHLY,
      stripePriceYearly: env.STRIPE_PRICE_PREMIUM_YEARLY,
      openSignup: env.OPEN_SIGNUP === "1",
    },
    db,
    stripeClient,
  ),
  storage,
  rateLimit: createRateLimitStore(db),
  push: createPushSender(db, {
    appUrl: env.APP_URL,
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
  openSignup: false,
  indexable: false,
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
