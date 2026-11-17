import type { Request, Response } from "express";
import { parseOrderInput } from "../types/order";
import { createWorkflow, describeWorkflow, IdempotencyConflictError } from "../workflow/engine";
import { orderWorkflow } from "../workflow/order-workflow";

/**
 * Saves the order and returns 202 straight away. A worker runs the steps in
 * the background, and the client checks progress with GET /orders/:id.
 *
 * Requires an Idempotency-Key header (any unique string, e.g. a UUID the client
 * generates once per order). If the client never sees our response, because of
 * a timeout or a dropped connection, it can safely send the same request again
 * with the same key and gets the same order back.
 */
export async function createOrder(req: Request, res: Response) {
  const key = req.header("idempotency-key");
  if (!key || key.length > 255) {
    return res.status(400).json({ error: "idempotency_key_required", detail: "Send an Idempotency-Key header (max 255 chars)" });
  }

  const parsed = parseOrderInput(req.body);
  if (!parsed.ok) return res.status(400).json({ error: "invalid_request", details: parsed.errors });

  try {
    const { workflow, created } = await createWorkflow(orderWorkflow, parsed.value, key);
    if (!created) res.setHeader("Idempotent-Replayed", "true");
    res
      .status(created ? 202 : 200)
      .location(`/orders/${workflow.id}`)
      .json({ id: workflow.id, status: workflow.status, links: { self: `/orders/${workflow.id}` } });
  } catch (err) {
    if (err instanceof IdempotencyConflictError) {
      return res.status(422).json({ error: "idempotency_key_reused", detail: err.message });
    }
    throw err;
  }
}

export async function getOrder(req: Request, res: Response) {
  const order = await describeWorkflow(String(req.params.id));
  if (!order) return res.status(404).json({ error: "not_found" });
  res.json(order);
}
