import { createRoute } from "@hono/zod-openapi";
import { CheckoutUrlSchema, ErrorSchema } from "@pjokk/shared";
import type { FamEnv } from "../context";
import { createApp, jsonContent } from "../lib";

// The lifetime plan is a one-time payment, which the better-auth stripe
// plugin doesn't model — this route creates the Checkout Session itself and
// the plugin's onEvent handler (auth.ts) grants the plan when the session
// completes. Subscriptions never touch this route.
const lifetimeCheckout = createRoute({
  method: "post",
  path: "/api/billing/lifetime",
  tags: ["billing"],
  description:
    "Create a Stripe Checkout session for the one-time lifetime Premium purchase. Admin only. Redirect the browser to the returned url.",
  responses: {
    200: jsonContent(CheckoutUrlSchema, "Checkout session created"),
    409: jsonContent(ErrorSchema, "Family already has Premium"),
    503: jsonContent(ErrorSchema, "Billing is not configured on this instance"),
  },
});

export const billingApp = createApp<FamEnv>().openapi(
  lifetimeCheckout,
  async (c) => {
    if (c.var.plan !== "free") {
      return c.json(
        { error: "Family already has Premium", code: "ALREADY_PREMIUM" },
        409,
      );
    }
    const stripe = c.var.deps.stripe;
    if (!stripe) {
      // Self-hosted instances run without billing configured; the route
      // exists but cannot do anything, so say that rather than 500.
      return c.json(
        { error: "Billing is not configured", code: "BILLING_DISABLED" },
        503,
      );
    }
    const stripeCustomerId = await c.var.fam.stripeCustomerId();
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: c.var.deps.stripePriceLifetime, quantity: 1 }],
      client_reference_id: c.var.familyId,
      metadata: { kind: "lifetime", familyId: c.var.familyId },
      ...(stripeCustomerId
        ? { customer: stripeCustomerId }
        : { customer_email: c.var.sessionData.user.email }),
      automatic_tax: { enabled: true },
      success_url: `${c.var.deps.appUrl}/settings?billing=success`,
      cancel_url: `${c.var.deps.appUrl}/settings?billing=canceled`,
    });
    if (!session.url) {
      return c.json(
        { error: "Stripe did not return a checkout URL", code: "STRIPE_ERROR" },
        409,
      );
    }
    return c.json({ url: session.url }, 200);
  },
);
