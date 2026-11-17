import type { OrderInput } from "../types/order";
import type { WorkflowDefinition } from "../types/workflow";
import { reserveStock } from "../services/inventory.service";
import { chargePayment } from "../services/payment.service";
import { sendEmail } from "../services/email.service";

/**
 * The order workflow: the three steps, in order. Each returns what later steps
 * need. `ctx` carries the step's idempotency key and timeout, and is passed
 * straight through as the call options.
 */
export const orderWorkflow: WorkflowDefinition<OrderInput> = {
  type: "order",
  steps: [
    {
      name: "reserve_inventory",
      execute: async (ctx) => reserveStock(ctx.input.sku, ctx.input.quantity, ctx),
    },
    {
      name: "charge_payment",
      execute: async (ctx) => chargePayment(ctx.input.amountCents, ctx.input.customerEmail, ctx),
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
