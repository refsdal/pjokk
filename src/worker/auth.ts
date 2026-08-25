import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, bearer, organization } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { stripe } from "@better-auth/stripe";
import type Stripe from "stripe";
import { and, eq } from "drizzle-orm";
import { createDb, schema } from "./db";
import { createStripe } from "./stripe";
import { applySubscriptionStatus, grantLifetime } from "./billing";

// D1 bindings only exist inside the request handler, so the better-auth
// instance is created per-request (stashed on Hono context in middleware).
// Never initialize this at module scope.
export function createAuth(env: Env) {
  const db = createDb(env.DB);
  const url = new URL(env.APP_URL);
  const stripeClient = createStripe(env);

  return betterAuth({
    baseURL: env.APP_URL,
    secret: env.BETTER_AUTH_SECRET,
    // workers.dev stays trusted so the app keeps working there during the
    // transition to app.pjokk.no (and as a fallback URL).
    trustedOrigins: [
      env.APP_URL,
      "https://pjokk.refsdal-holding-as.workers.dev",
    ],
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    // Open signup is DISABLED (closed alpha). Accounts are only created via
    // the invite redeem flow: /join/CODE calls social sign-in with
    // requestSignUp, everything else refuses new users.
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
    },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        // OPEN_SIGNUP=1 is the founder-bootstrap escape hatch: flip it on for
        // the very first account (no invite exists yet), then back off.
        disableImplicitSignUp: String(env.OPEN_SIGNUP) !== "1",
      },
    },
    databaseHooks: {
      session: {
        create: {
          // New sessions land in the user's first family automatically.
          before: async (session) => {
            const membership = await db
              .select({ organizationId: schema.member.organizationId })
              .from(schema.member)
              .where(eq(schema.member.userId, session.userId))
              .limit(1);
            return {
              data: {
                ...session,
                activeOrganizationId: membership[0]?.organizationId ?? null,
              },
            };
          },
        },
      },
    },
    plugins: [
      // An organization IS a family. Parents are admins. Creating families
      // is a sysadmin action (sec review H2): everyone else joins through an
      // invite code, so a signup-bypass account can't do anything.
      organization({
        creatorRole: "admin",
        allowUserToCreateOrganization: (user) =>
          (user as { role?: string | null }).role === "admin",
      }),
      passkey({
        rpID: url.hostname,
        rpName: "Pjokk",
        origin: env.APP_URL,
      }),
      // Cookies for web, bearer tokens for a future Capacitor shell.
      bearer(),
      // System-admin tooling (user.role === "admin"): list/ban users, revoke
      // sessions, set passwords, impersonate. Family roles are unrelated.
      admin(),
      // Billing (Phase 9): org-level subscriptions AND org-level Stripe
      // customers — the family owns both the entitlement and the customer.
      // organization.plan is the denormalized gate the app reads; these
      // hooks are the only writers besides the lifetime webhook + sysadmin
      // override.
      stripe({
        stripeClient,
        stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
        organization: { enabled: true },
        subscription: {
          enabled: true,
          plans: [
            {
              name: "premium",
              priceId: env.STRIPE_PRICE_PREMIUM_MONTHLY,
              annualDiscountPriceId: env.STRIPE_PRICE_PREMIUM_YEARLY,
            },
          ],
          // Only family admins may buy/cancel/restore/list for a family.
          authorizeReference: async ({ user, referenceId }) => {
            const rows = await db
              .select({ role: schema.member.role })
              .from(schema.member)
              .where(
                and(
                  eq(schema.member.organizationId, referenceId),
                  eq(schema.member.userId, user.id),
                ),
              )
              .limit(1);
            const role = rows[0]?.role;
            return role === "admin" || role === "owner";
          },
          onSubscriptionComplete: async ({ subscription }) => {
            await applySubscriptionStatus(
              db,
              subscription.referenceId,
              "active",
            );
          },
          onSubscriptionUpdate: async ({ subscription }) => {
            await applySubscriptionStatus(
              db,
              subscription.referenceId,
              subscription.status,
            );
          },
          onSubscriptionCancel: async ({ subscription }) => {
            // Fires when cancellation is SCHEDULED (cancel_at_period_end) as
            // well as when it lands; applySubscriptionStatus keys off
            // status, so a still-active-until-period-end sub stays premium.
            await applySubscriptionStatus(
              db,
              subscription.referenceId,
              subscription.status,
            );
          },
          onSubscriptionDeleted: async ({ subscription }) => {
            await applySubscriptionStatus(
              db,
              subscription.referenceId,
              "canceled",
            );
          },
          getCheckoutSessionParams: async () => ({
            params: { automatic_tax: { enabled: true } },
          }),
        },
        // Lifetime (one-time payment) rides the same webhook.
        onEvent: async (event) => {
          if (event.type !== "checkout.session.completed") return;
          const session = event.data.object as Stripe.Checkout.Session;
          if (
            session.mode === "payment" &&
            session.payment_status === "paid" &&
            session.metadata?.kind === "lifetime" &&
            session.metadata.familyId
          ) {
            await grantLifetime(db, session.metadata.familyId);
          }
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
