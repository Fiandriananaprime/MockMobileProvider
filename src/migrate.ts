import "dotenv/config";
import { Pool } from "pg";
import { runDatabaseMigrations } from "./migrations.js";

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  throw new Error("DATABASE_URL must be configured before running migrations");
}

const pool = new Pool({ connectionString });

try {
  const applied = await runDatabaseMigrations(pool);
  if (applied.length === 0) {
    console.log("Database is up to date");
  } else {
    console.log(`Applied database migrations: ${applied.join(", ")}`);
  }
} catch (error) {
  console.error("Database migration failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}