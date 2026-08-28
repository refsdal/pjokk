import Stripe from "stripe";

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
export function createStripe(secretKey: string): Stripe | null {
  if (!secretKey) return null;
  return new Stripe(secretKey, {
    // Pinned together with the SDK (22.5.0 in package.json). The SDK pins the
    // API version it is built against, so upgrading stripe forces this to
    // 2026-08-26.dahlia — a behavioural change against live billing that the
    // test suite cannot catch, because it runs with fake keys. Bump both
    // together, with the test-mode pass in SMOKE-TEST.md section 8.
    apiVersion: "2026-07-29.dahlia",
    httpClient: Stripe.createFetchHttpClient(),
  });
}
