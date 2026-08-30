// Used ONLY by `better-auth generate` to emit the drizzle schema for the
// auth tables. The real runtime instance is built once at startup in
// apps/api/src/infrastructure/auth.ts (see apps/server/src/deps.ts, the
// composition root that builds it).
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization, bearer } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";

export const auth = betterAuth({
  database: drizzleAdapter({} as never, { provider: "pg" }),
  emailAndPassword: { enabled: true },
  socialProviders: {
    google: { clientId: "x", clientSecret: "x" },
  },
  plugins: [organization(), passkey(), bearer()],
});
