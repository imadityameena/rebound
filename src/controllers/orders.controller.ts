import type { Request, Response } from "express";
import { parseOrderInput } from "../types/order";
import { createWorkflow, describeWorkflow, runWorkflow } from "../workflow/engine";
import { orderWorkflow } from "../workflow/order-workflow";

export async function createOrder(req: Request, res: Response) {
  const parsed = parseOrderInput(req.body);
  if (!parsed.ok) return res.status(400).json({ error: "invalid_request", details: parsed.errors });

  // Saved first, so the order exists in the database before anything external happens.
  const workflow = await createWorkflow(orderWorkflow, parsed.value);
  await runWorkflow(workflow.id);

  const order = await describeWorkflow(workflow.id);
  res.status(order?.status === "completed" ? 201 : 502).json(order);
}

export async function getOrder(req: Request, res: Response) {
  const order = await describeWorkflow(String(req.params.id));
  if (!order) return res.status(404).json({ error: "not_found" });
  res.json(order);
}
