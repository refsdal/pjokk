import Stripe from "stripe";
import type { Env } from "./config";

// Built once with the auth instance (see services.ts) rather than per
// request, as it had to be on Workers. The fetch-based HTTP client and async
// webhook crypto are kept: they work on Bun too, and swapping them back to
// the Node defaults would be churn for no gain.
export function createStripe(env: Env): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2026-07-29.dahlia",
    httpClient: Stripe.createFetchHttpClient(),
  });
}
