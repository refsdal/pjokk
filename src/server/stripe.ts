import Stripe from "stripe";
import type { Env } from "./config";

// Built once with the auth instance (see services.ts) rather than per
// request, as it had to be on Workers. The fetch-based HTTP client and async
// webhook crypto are kept: they work on Bun too, and swapping them back to
// the Node defaults would be churn for no gain.
/**
 * The Stripe client, or null when billing is not configured.
 *
 * Nullable because a self-hosted instance legitimately runs without billing,
 * and the SDK throws from its CONSTRUCTOR on an empty key — so building it
 * unconditionally turns "no Stripe keys" into a crash loop at startup rather
 * than a feature that is simply off. On Workers the key was always present,
 * so this state was never reachable.
 */
export function createStripe(env: Env): Stripe | null {
  if (!env.STRIPE_SECRET_KEY) return null;
  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2026-07-29.dahlia",
    httpClient: Stripe.createFetchHttpClient(),
  });
}
