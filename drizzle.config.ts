import { defineConfig } from "drizzle-kit";

// The SQLite/D1 migrations that preceded this file are in git history, not
// here: the port to Postgres started from an empty database (no production
// data was carried over), so a single generated baseline is honest and a
// hand-translated migration chain would only be fiction.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/pjokk",
  },
});
