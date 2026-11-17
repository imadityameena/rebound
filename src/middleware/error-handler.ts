import type { Request, Response, NextFunction } from "express";

/** Last-resort handler: log the error and return a generic 500 instead of leaking details. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if ((err as { type?: string }).type === "entity.parse.failed") {
    return res.status(400).json({ error: "invalid_json" });
  }
  console.error("Unhandled request error:", err);
  res.status(500).json({ error: "internal_error" });
}
