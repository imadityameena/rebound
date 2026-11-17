import type { OrderInput } from "../types/order";
import type { WorkflowDefinition } from "../types/workflow";
import { releaseStock, reserveStock } from "../services/inventory.service";
import { chargePayment, refundPayment } from "../services/payment.service";
import { sendEmail } from "../services/email.service";

/**
 * The order workflow: the three steps, in order. Each returns what later steps
 * (and its own compensation) need. If a step fails for good, the steps before
 * it are undone newest first: refund the payment, then release the stock.
 * The confirmation is last and has no undo: a sent email can't be unsent. `ctx` carries the step's idempotency key and timeout, and is passed
 * straight through as the call options.
 */
export const orderWorkflow: WorkflowDefinition<OrderInput> = {
  type: "order",
  steps: [
    {
      name: "reserve_inventory",
      execute: async (ctx) => reserveStock(ctx.input.sku, ctx.input.quantity, ctx),
      compensate: async (ctx) => releaseStock(String(ctx.output.reservationId), ctx),
    },
    {
      name: "charge_payment",
      execute: async (ctx) => chargePayment(ctx.input.amountCents, ctx.input.customerEmail, ctx),
      compensate: async (ctx) => {
        await refundPayment(String(ctx.output.chargeId), ctx);
      },
    },
    {
      name: "confirm_order",
      // An email is cheap to retry and worth delivering, so allow more attempts.
      retry: { maxAttempts: 8 },
      execute: async (ctx) =>
        sendEmail(
          ctx.input.customerEmail,
          "Your order is confirmed",
          `Order ${ctx.workflowId}: ${ctx.input.quantity} x ${ctx.input.sku}.`,
          ctx,
        ),
    },
  ],
};
