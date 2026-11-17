import type { Request, Response } from "express";
import { parseOrderInput } from "../types/order";
import { createWorkflow, describeWorkflow } from "../workflow/engine";
import { orderWorkflow } from "../workflow/order-workflow";

/**
 * Saves the order and returns 202 straight away. A worker runs the steps in
 * the background, so a crash no longer takes the client's request down with it,
 * and the client checks progress with GET /orders/:id.
 */
export async function createOrder(req: Request, res: Response) {
  const parsed = parseOrderInput(req.body);
  if (!parsed.ok) return res.status(400).json({ error: "invalid_request", details: parsed.errors });

  const workflow = await createWorkflow(orderWorkflow, parsed.value);
  res
    .status(202)
    .location(`/orders/${workflow.id}`)
    .json({ id: workflow.id, status: workflow.status, links: { self: `/orders/${workflow.id}` } });
}

export async function getOrder(req: Request, res: Response) {
  const order = await describeWorkflow(String(req.params.id));
  if (!order) return res.status(404).json({ error: "not_found" });
  res.json(order);
}
