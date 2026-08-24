import path from "node:path";
import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    resolve: {
      alias: {
        "@shared": path.resolve(__dirname, "src/shared"),
      },
    },
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          main: "./src/worker/index.ts",
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
              GOOGLE_CLIENT_ID: "test",
              GOOGLE_CLIENT_SECRET: "test",
            },
          },
        },
      },
    },
  };
});
