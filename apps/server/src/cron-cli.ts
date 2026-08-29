import { loadEnv } from "@pjokk/api/config";
import { isJob, JOBS, runJob } from "@pjokk/api/cron";
import type { Deps } from "@pjokk/api/deps";
import {
  createAuth,
  createDb,
  createPushSender,
  createRateLimitStore,
  createStorage,
  createStripe,
} from "@pjokk/api/infrastructure";

// One-shot cron entrypoint: `bun run apps/server/src/cron-cli.ts <job>`.
//
// This is what a Kubernetes CronJob invokes. It runs the job once, then
// exits with a status the scheduler can act on — a failed backup should show
// up as a failed CronJob, not as a line in a log nobody reads.

const job = process.argv[2];

if (!job || !isJob(job)) {
  console.error(`usage: cron-cli <${JOBS.join("|")}>`);
  process.exit(2);
}

const env = loadEnv(process.env);
const db = createDb(env.DATABASE_URL);
const stripeClient = createStripe(env.STRIPE_SECRET_KEY);

// A one-shot process never listens, so there is no peer address to read and
// nothing here reads the rate limiter either way.
const deps: Deps = {
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
  stripe: stripeClient,
  peerAddress: () => null,
  now: () => new Date(),
  appUrl: env.APP_URL,
  vapidPublicKey: env.VAPID_PUBLIC_KEY,
  stripePriceLifetime: env.STRIPE_PRICE_PREMIUM_LIFETIME,
  trustedProxyHops: env.TRUSTED_PROXY_HOPS,
  openSignup: env.OPEN_SIGNUP === "1",
  indexable: env.INDEXABLE === "1",
};

try {
  await runJob(job, deps);
  process.exit(0);
} catch (error) {
  console.error(`cron: ${job} failed`, error);
  process.exit(1);
}
