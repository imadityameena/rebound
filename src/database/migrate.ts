import type { Pool } from "pg";
import { migrations } from "./migrations";

/**
 * Applies any migrations that have not run yet. Each one runs in its own
 * transaction together with its schema_migrations row, so a migration is
 * either fully applied and recorded, or not at all.
 */
export async function migrate(pool: Pool): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const applied: string[] = [];
  for (const migration of migrations) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Serializes concurrent migrators (two processes starting at once).
      await client.query("SELECT pg_advisory_xact_lock(726354)");
      const done = await client.query("SELECT 1 FROM schema_migrations WHERE id = $1", [migration.id]);
      if (done.rowCount === 0) {
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [migration.id]);
        applied.push(migration.id);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${migration.id} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return applied;
}

// `npm run db:migrate`
if (typeof require !== "undefined" && require.main === module) {
  import("./pool").then(async ({ pool }) => {
    const applied = await migrate(pool);
    console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date");
    await pool.end();
  });
}
