import { config } from "./config/env";
import { createApp } from "./app";
import { pool } from "./database/pool";
import { migrate } from "./database/migrate";
import { recoverOnStartup } from "./workflow/recovery";
import { Worker } from "./workflow/worker";

async function main() {
  const applied = await migrate(pool);
  if (applied.length) console.log(`Applied migrations: ${applied.join(", ")}`);

  // Recover before accepting new work, so unfinished workflows are first in line.
  await recoverOnStartup(config.worker.id);
  const worker = new Worker(config.worker);
  worker.start();
  console.log(`Worker ${worker.id} started (concurrency ${config.worker.concurrency})`);

  const server = createApp().listen(config.port, () => {
    console.log(`API listening on http://localhost:${config.port}`);
  });

  let stopping = false;
  async function shutdown(signal: string) {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received: finishing in-flight workflows, then exiting`);
    server.close();
    await worker.stop();
    await pool.end();
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});
