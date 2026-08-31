import { z } from "zod";

// Configuration for the container. This replaces the Env interface that
// `wrangler types` used to generate from wrangler.jsonc + .dev.vars: off
// Workers there are no bindings, only environment variables, and the process
// owns its own configuration.
//
// Parsed ONCE at startup and validated with zod (the same source-of-truth
// rule the API routes follow). A malformed DATABASE_URL should kill the
// container on boot — where a crash-looping pod is loud and obvious — not
// surface as a 500 on the first request that happens to touch the database.

/** Cloudflare vars were strings, and "0"/"1" is how the existing code spells
 *  a flag (`String(env.OPEN_SIGNUP) === "1"`). Keeping that spelling means
 *  the call sites do not change. */
const flag = z.enum(["0", "1"]).default("0");

/** Credentials for an optional subsystem. Absent is legitimate: a self-hosted
 *  instance may run without Google sign-in, push or billing, and should boot
 *  and serve rather than crash-loop over a feature it never uses. */
const optionalSecret = z.string().default("");

export const EnvSchema = z.object({
  // --- Required: without these the process cannot serve a single request ---

  /** libpq connection string, e.g. postgres://pjokk:pw@db:5432/pjokk */
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  /** Public origin. better-auth signs cookies and builds OAuth callbacks from
   *  this, so a wrong value breaks sign-in in ways that look like anything
   *  but a config error. */
  APP_URL: z.url(),
  /** The public site on the apex. The app links out to its legal pages, which
   *  live there now rather than behind auth. */
  SITE_URL: z.url().default("https://pjokk.no"),
  /** openssl rand -base64 32. Short secrets weaken every session token. */
  BETTER_AUTH_SECRET: z.string().min(16, "BETTER_AUTH_SECRET is too short"),

  // --- Object storage (replaces the R2 binding) ---

  S3_BUCKET: z.string().min(1),
  /** Endpoint URL. MinIO in compose, or a real S3/R2 endpoint in production.
   *  Required rather than inferred: guessing an endpoint from a region is how
   *  data ends up in the wrong jurisdiction. */
  S3_ENDPOINT: z.url(),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_REGION: z.string().default("auto"),

  // --- Optional subsystems ---

  GOOGLE_CLIENT_ID: optionalSecret,
  GOOGLE_CLIENT_SECRET: optionalSecret,
  VAPID_PUBLIC_KEY: optionalSecret,
  VAPID_PRIVATE_KEY: optionalSecret,
  STRIPE_SECRET_KEY: optionalSecret,
  STRIPE_WEBHOOK_SECRET: optionalSecret,
  STRIPE_PRICE_PREMIUM_MONTHLY: optionalSecret,
  STRIPE_PRICE_PREMIUM_YEARLY: optionalSecret,
  STRIPE_PRICE_PREMIUM_LIFETIME: optionalSecret,

  // --- Behaviour switches ---

  /** Founder-bootstrap escape hatch; see CLAUDE.md. Also read by the landing
   *  build (apps/landing/build.ts) to choose the CTA copy — the container no
   *  longer has anything indexable to serve, but the deploy still sets this
   *  for the static site's build step. */
  OPEN_SIGNUP: flag,

  PORT: z.coerce.number().int().positive().default(3000),
  /** Directory holding the built SPA. */
  STATIC_DIR: z.string().default("dist/client"),

  /** How many reverse proxies sit in front of this process.
   *
   *  The rate limiter needs the real client IP, and on Workers it came from
   *  cf-connecting-ip, which Cloudflare guarantees. There is no such
   *  guarantee behind an arbitrary ingress: X-Forwarded-For is caller-supplied
   *  and trusting it blindly lets anyone forge a fresh bucket per request,
   *  which defeats the limiter completely.
   *
   *  So it is opt-in and counted from the RIGHT: with N trusted hops the
   *  client IP is the Nth entry from the end, the last address a trusted
   *  proxy actually observed. 0 (the default) means "no proxy" — trust the
   *  socket address and ignore the header entirely. Set it to the real number
   *  of proxies, never higher. */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
});

export type Env = z.infer<typeof EnvSchema>;

/** Subsystems that silently do nothing when their credentials are absent.
 *  Logged at startup so "push isn't working" is answered by the boot log
 *  rather than by an afternoon of debugging. */
export function disabledSubsystems(env: Env): string[] {
  const off: string[] = [];
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    off.push("Google sign-in");
  }
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) off.push("web push");
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) off.push("billing");
  return off;
}

/**
 * Parses and validates configuration. Throws an Error listing EVERY invalid
 * field — reporting them one per restart makes first-run setup miserable.
 */
export function loadEnv(source: Record<string, string | undefined>): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  return parsed.data;
}
