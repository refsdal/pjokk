// Used ONLY by `better-auth generate` to emit the drizzle schema for the
// auth tables. The real runtime instance is created per-request in
// src/worker/auth.ts (D1 bindings are request-scoped on Workers).
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization, bearer } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";

export const auth = betterAuth({
  database: drizzleAdapter({} as never, { provider: "sqlite" }),
  emailAndPassword: { enabled: true },
  socialProviders: {
    google: { clientId: "x", clientSecret: "x" },
  },
  plugins: [organization(), passkey(), bearer()],
});
