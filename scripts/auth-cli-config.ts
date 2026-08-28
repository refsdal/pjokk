// Used ONLY by `better-auth generate` to emit the drizzle schema for the
// auth tables. The real runtime instance is built once at startup in
// src/server/auth.ts (see services.ts).
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
