import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";

const MIGRATION_LOCK_KEY = "mock-mobile-money-schema-migrations";

export async function runDatabaseMigrations(pool: Pool): Promise<string[]> {
  const migrationDirectory = path.resolve(process.cwd(), "database", "migrations");
  const migrationFiles = (await readdir(migrationDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const client = await pool.connect();
  const appliedMigrations: string[] = [];

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const appliedResult = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const appliedNames = new Set(appliedResult.rows.map((row) => row.name));

    for (const file of migrationFiles) {
      if (appliedNames.has(file)) continue;
      const sql = await readFile(path.join(migrationDirectory, file), "utf8");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      } catch (error) {
        throw new Error(`Database migration ${file} failed`, { cause: error });
      }
      appliedMigrations.push(file);
    }

    await client.query("COMMIT");
    return appliedMigrations;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}