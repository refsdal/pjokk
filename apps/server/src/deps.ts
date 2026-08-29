import {
  createAuth,
  createDb,
  createPushSender,
  createRateLimitStore,
  createStorage,
  createStripe,
} from "@pjokk/api/infrastructure";
import type { Deps } from "@pjokk/api/deps";
import type { Env } from "./env";

/**
 * Builds every collaborator the API needs. The ONLY place in the codebase
 * that constructs one.
 *
 * `peerAddress` is a closure over a mutable reference because Bun's server
 * handle does not exist until Bun.serve() has returned, and the rate limiter
 * needs it on the first request. main.ts fills the reference in immediately
 * after serve() resolves.
 */
export type PeerAddressSource = {
  requestIP(request: Request): { address: string } | null;
};

export function createDeps(
  env: Env,
  serverRef: { current: PeerAddressSource | undefined },
): Deps {
  const db = createDb(env.DATABASE_URL);
  const stripeClient = createStripe(env.STRIPE_SECRET_KEY);

  return {
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
    storage: createStorage({
      bucket: env.S3_BUCKET,
      endpoint: env.S3_ENDPOINT,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      region: env.S3_REGION,
    }),
    rateLimit: createRateLimitStore(db),
    push: createPushSender(db, {
      appUrl: env.APP_URL,
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
    }),
    // The SAME client the auth plugin got — built once, shared. Two routes
    // used to call createStripe() per request before Task 3.
    stripe: stripeClient,
    peerAddress: (request) =>
      serverRef.current?.requestIP(request)?.address ?? null,
    now: () => new Date(),
    appUrl: env.APP_URL,
    vapidPublicKey: env.VAPID_PUBLIC_KEY,
    stripePriceLifetime: env.STRIPE_PRICE_PREMIUM_LIFETIME,
    trustedProxyHops: env.TRUSTED_PROXY_HOPS,
    openSignup: env.OPEN_SIGNUP === "1",
    indexable: env.INDEXABLE === "1",
  };
}
