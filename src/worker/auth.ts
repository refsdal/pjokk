import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, organization } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { eq } from "drizzle-orm";
import { createDb, schema } from "./db";

// D1 bindings only exist inside the request handler, so the better-auth
// instance is created per-request (stashed on Hono context in middleware).
// Never initialize this at module scope.
export function createAuth(env: Env) {
  const db = createDb(env.DB);
  const url = new URL(env.APP_URL);

  return betterAuth({
    baseURL: env.APP_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.APP_URL],
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
      // An organization IS a family. Parents are admins.
      organization({ creatorRole: "admin" }),
      passkey({
        rpID: url.hostname,
        rpName: "Pjokk",
        origin: env.APP_URL,
      }),
      // Cookies for web, bearer tokens for a future Capacitor shell.
      bearer(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
