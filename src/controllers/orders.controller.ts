import type { Request, Response } from "express";
import { parseOrderInput } from "../types/order";
import { getNaiveOrder, runNaiveOrder } from "../workflow/naive";

export async function createOrder(req: Request, res: Response) {
  const parsed = parseOrderInput(req.body);
  if (!parsed.ok) return res.status(400).json({ error: "invalid_request", details: parsed.errors });

  // The request waits for all three steps to finish.
  const order = await runNaiveOrder(parsed.value);
  res.status(order.status === "confirmed" ? 201 : 502).json(order);
}

export function getOrder(req: Request, res: Response) {
  const order = getNaiveOrder(String(req.params.id));
  if (!order) return res.status(404).json({ error: "not_found" });
  res.json(order);
}
