import { Pool } from "pg";
import { config } from "../config/env";

export const pool = new Pool({
  ...config.db,
  // Give up on a new connection after 2s instead of waiting forever.
  connectionTimeoutMillis: 2000,
});

// If Postgres drops an idle connection (restart, crash, network blip), the pool
// emits "error". Without a listener, Node treats it as unhandled and kills the
// process. Log it instead; the pool discards that client and opens a fresh one later.
pool.on("error", (err) => {
  console.error("Idle Postgres client error:", err.message);
});

export async function checkDatabase(): Promise<void> {
  await pool.query("SELECT 1");
}
