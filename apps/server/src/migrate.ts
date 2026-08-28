import { migrate } from "drizzle-orm/bun-sql/migrator";
import { loadEnv } from "@pjokk/api/config";
import { createDb, createPool } from "@pjokk/api/db";

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

const env = loadEnv(process.env);
const pool = createPool(env.DATABASE_URL);

// Resolved against the working directory. Inside the image that is /app, where
// the Dockerfile copies the SQL to ./migrations, so the default is correct
// there and the variable is left unset. From a source checkout the folder is
// under apps/api, which is what the root `migrate` script passes.
const migrationsFolder = process.env.MIGRATIONS_DIR ?? "./migrations";

try {
  await migrate(createDb(pool), { migrationsFolder });
  console.log("migrations applied");
  await pool.end();
  process.exit(0);
} catch (error) {
  console.error("migration failed", error);
  await pool.end();
  process.exit(1);
}
