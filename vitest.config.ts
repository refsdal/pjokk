import path from "node:path";
import { defineConfig } from "vitest/config";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import webpush from "web-push";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    path.join(import.meta.dirname, "migrations"),
  );
  const vapid = webpush.generateVAPIDKeys();
  return {
    resolve: {
      alias: {
        "@shared": path.resolve(import.meta.dirname, "src/shared"),
        "@": path.resolve(import.meta.dirname, "src/web"),
      },
    },
    plugins: [
      cloudflareTest({
        main: "./src/server/index.ts",
        miniflare: {
          compatibilityDate: "2026-08-04",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          kvNamespaces: ["KV"],
          r2Buckets: ["FILES"],
          bindings: {
            TEST_MIGRATIONS: migrations,
            BETTER_AUTH_SECRET: "test-secret-please-ignore",
            APP_URL: "http://localhost",
            // Landing-page switches. Declared here (rather than left
            // undefined) so test/landing.test.ts can flip them and restore.
            OPEN_SIGNUP: "0",
            INDEXABLE: "0",
            GOOGLE_CLIENT_ID: "test",
            GOOGLE_CLIENT_SECRET: "test",
            VAPID_PUBLIC_KEY: vapid.publicKey,
            VAPID_PRIVATE_KEY: vapid.privateKey,
            STRIPE_SECRET_KEY: "sk_test_fake",
            STRIPE_WEBHOOK_SECRET: "whsec_test_fake",
            STRIPE_PRICE_PREMIUM_MONTHLY: "price_test_monthly",
            STRIPE_PRICE_PREMIUM_YEARLY: "price_test_yearly",
            STRIPE_PRICE_PREMIUM_LIFETIME: "price_test_lifetime",
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
