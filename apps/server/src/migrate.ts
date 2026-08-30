import { migrate } from "drizzle-orm/bun-sql/migrator";
import { createDb } from "@pjokk/api/infrastructure";
import { loadEnv } from "./env";

// Applies pending migrations, then exits.
//
// Uses drizzle-orm's migrator rather than the drizzle-kit CLI on purpose:
// drizzle-kit is a devDependency and has no place in a production image,
// while drizzle-orm is already there to run the app.
//
// Run this as a ONE-OFF — a compose `migrate` service, a Kubernetes Job, or
// an initContainer — never from the app's own startup path. Drizzle's
// migrator does not coordinate between processes, so N replicas booting
// together would race to apply the same DDL.

export async function runMigrate() {
  const env = loadEnv(process.env);
  const db = createDb(env.DATABASE_URL);

  // Resolved against the working directory. Inside the image that is /app, where
  // the Dockerfile copies the SQL to ./migrations, so the default is correct
  // there and the variable is left unset. From a source checkout the folder is
  // under apps/api, which is what the root `migrate` script passes.
  const migrationsFolder = process.env.MIGRATIONS_DIR ?? "./migrations";

  try {
    await migrate(db, { migrationsFolder });
    console.log("migrations applied");
    await db.$client.end();
    process.exit(0);
  } catch (error) {
    console.error("migration failed", error);
    await db.$client.end();
    process.exit(1);
  }
}
