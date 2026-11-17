import express from "express";
import { config } from "./config/env";
import { healthRouter } from "./routes/health.routes";
import { ordersRouter } from "./routes/orders.routes";
import { errorHandler } from "./middleware/error-handler";
import { pool } from "./database/pool";
import { migrate } from "./database/migrate";

async function main() {
  const applied = await migrate(pool);
  if (applied.length) console.log(`Applied migrations: ${applied.join(", ")}`);

  const app = express();
  app.use(express.json());
  app.use(healthRouter);
  app.use(ordersRouter);
  app.use(errorHandler);

  const server = app.listen(config.port, () => {
    console.log(`API listening on http://localhost:${config.port}`);
  });

  async function shutdown(signal: string) {
    console.log(`${signal} received, shutting down`);
    server.close();
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
