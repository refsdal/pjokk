import type { Env } from "./config";
import type { Db } from "./db";
import {
  createAuth,
  createDb,
  createRateLimitStore,
  createStorage,
  createStripe,
} from "./infrastructure";
import type { Auth } from "./infrastructure/auth";
import type { RateLimitStore, Storage } from "./ports";

// The long-lived collaborators: one database pool, one better-auth instance,
// one storage client, one rate-limit store.
//
// On Workers all of these had to be built PER REQUEST, because D1 and R2
// bindings only existed inside the request handler. That is why auth.ts
// carried a "never initialize this at module scope" warning — and why every
// single request paid to construct a Stripe client and the whole better-auth
// plugin chain. A long-lived process has no such constraint, so the cost is
// paid once at startup instead.

export type Services = {
  env: Env;
  db: Db;
  auth: Auth;
  storage: Storage;
  rateLimit: RateLimitStore;
};

// Keyed on the Env object rather than held in a mutable module-level global.
// In production exactly one Env exists, so this builds one set of services;
// in tests each suite brings its own Env and gets its own, with no boot-order
// coupling and nothing to reset between runs. WeakMap so a discarded test env
// takes its services with it.
const perEnv = new WeakMap<Env, Services>();

/**
 * The services for an Env, building them on first use.
 *
 * `overrides` is honoured only when the set is first built — tests call this
 * before the app does, to substitute an in-memory Storage — and is ignored
 * afterwards, so a request handler can never accidentally swap a collaborator
 * out from under the process.
 */
export function servicesFor(
  env: Env,
  overrides: Partial<Services> = {},
): Services {
  const existing = perEnv.get(env);
  if (existing) return existing;

  const db = overrides.db ?? createDb(env.DATABASE_URL);
  const services: Services = {
    env,
    db,
    auth:
      overrides.auth ??
      createAuth(
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
        createStripe(env.STRIPE_SECRET_KEY),
      ),
    storage:
      overrides.storage ??
      createStorage({
        bucket: env.S3_BUCKET,
        endpoint: env.S3_ENDPOINT,
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        region: env.S3_REGION,
      }),
    rateLimit: overrides.rateLimit ?? createRateLimitStore(db),
  };
  perEnv.set(env, services);
  return services;
}
