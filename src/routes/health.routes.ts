import { Router } from "express";
import { checkDatabase } from "../database/pool";

export const healthRouter = Router();

healthRouter.get("/health", async (_req, res) => {
  try {
    await checkDatabase();
    res.json({ status: "ok", database: "up" });
  } catch {
    res.status(503).json({ status: "error", database: "down" });
  }
});
