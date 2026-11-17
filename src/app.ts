import express from "express";
import { healthRouter } from "./routes/health.routes";
import { ordersRouter } from "./routes/orders.routes";
import { errorHandler } from "./middleware/error-handler";

/** Builds the HTTP app without starting it, so tests can use it directly. */
export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(healthRouter);
  app.use(ordersRouter);
  app.use(errorHandler);
  return app;
}
