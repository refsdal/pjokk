import Stripe from "stripe";

// Request-scoped like everything else on Workers. The fetch-based HTTP
// client + async webhook crypto are what make the SDK work here.
export function createStripe(env: Env): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2026-07-29.dahlia",
    httpClient: Stripe.createFetchHttpClient(),
  });
}
