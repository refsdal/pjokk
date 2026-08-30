import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, bearer, organization } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { stripe } from "@better-auth/stripe";
import type Stripe from "stripe";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db";
import { schema } from "../db";
import { applySubscriptionStatus, grantLifetime } from "../billing";

export type AuthConfig = {
  appUrl: string;
  secret: string;
  googleClientId: string;
  googleClientSecret: string;
  stripeWebhookSecret: string;
  stripePriceMonthly: string;
  stripePriceYearly: string;
  /** Founder-bootstrap escape hatch; see CLAUDE.md. Flips off implicit
   *  Google sign-up once the very first account exists. */
  openSignup: boolean;
};

// Built ONCE at startup and shared (see services.ts). On Workers this had to
// run per-request, because D1 bindings only existed inside the request
// handler — which meant every request rebuilt a Stripe client and the entire
// plugin chain. The database is now passed in rather than constructed here,
// so the instance owns no connection lifecycle of its own.
export function createAuth(
  cfg: AuthConfig,
  db: Db,
  stripeClient: Stripe | null,
) {
  const url = new URL(cfg.appUrl);

  // Billing is optional: without Stripe keys the plugin is not registered
  // at all, so the /api/auth billing routes are absent rather than present
  // and failing on every call. createStripe returns null in that case —
  // the SDK throws from its constructor on an empty key.
  const billingPlugin = stripeClient
    ? stripe({
        stripeClient,
        stripeWebhookSecret: cfg.stripeWebhookSecret,
        organization: { enabled: true },
        subscription: {
          enabled: true,
          plans: [
            {
              name: "premium",
              priceId: cfg.stripePriceMonthly,
              annualDiscountPriceId: cfg.stripePriceYearly,
            },
          ],
          // Only family admins may buy/cancel/restore/list for a family.
          authorizeReference: async ({ user, referenceId, action }) => {
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
            if (role !== "admin" && role !== "owner") return false;
            // Lifetime/comp families already have Premium through a path the
            // subscription plugin knows nothing about — its own table would
            // happily start a paid subscription on top that grants nothing
            // extra (and would double-charge). Block it here rather than
            // relying on the plugin to notice. "premium" stays allowed: it's
            // how the plugin switches monthly<->yearly (upgrade-subscription
            // with an existing subscriptionId).
            if (action === "upgrade-subscription") {
              const orgRows = await db
                .select({ plan: schema.organization.plan })
                .from(schema.organization)
                .where(eq(schema.organization.id, referenceId))
                .limit(1);
              const plan = orgRows[0]?.plan;
              return plan === "free" || plan === "premium";
            }
            return true;
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
      })
    : null;

  return betterAuth({
    baseURL: cfg.appUrl,
    secret: cfg.secret,
    // Exactly one origin. The app now lives on the apex and workers.dev is
    // switched off, so any second trusted origin would only widen the surface
    // that can complete a sign-in.
    trustedOrigins: [cfg.appUrl],
    database: drizzleAdapter(db, { provider: "pg", schema }),
    // Open signup is DISABLED (closed alpha). Accounts are only created via
    // the invite redeem flow: /join/CODE calls social sign-in with
    // requestSignUp, everything else refuses new users.
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
    },
    socialProviders: {
      google: {
        clientId: cfg.googleClientId,
        clientSecret: cfg.googleClientSecret,
        // openSignup is the founder-bootstrap escape hatch: flip it on for
        // the very first account (no invite exists yet), then back off.
        disableImplicitSignUp: !cfg.openSignup,
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
      // An organization IS a family. Parents are admins. Anyone WITHOUT a
      // family may found one (self-serve onboarding through the Welcome
      // flow); existing members go through invites, and sysadmins may always
      // create. Accounts themselves remain invite-gated (OPEN_SIGNUP /
      // invite links), so this stays closed to strangers.
      organization({
        creatorRole: "admin",
        allowUserToCreateOrganization: async (user) => {
          if ((user as { role?: string | null }).role === "admin") return true;
          const membership = await db
            .select({ id: schema.member.id })
            .from(schema.member)
            .where(eq(schema.member.userId, user.id))
            .limit(1);
          return membership.length === 0;
        },
      }),
      passkey({
        rpID: url.hostname,
        rpName: "Pjokk",
        origin: cfg.appUrl,
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
      ...(billingPlugin ? [billingPlugin] : []),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
