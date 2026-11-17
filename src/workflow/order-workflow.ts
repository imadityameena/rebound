import type { OrderInput } from "../types/order";
import type { WorkflowDefinition } from "../types/workflow";
import { reserveStock } from "../services/inventory.service";
import { chargePayment } from "../services/payment.service";
import { sendEmail } from "../services/email.service";

/** The order workflow: the three steps, in order. Each returns what later steps need. */
export const orderWorkflow: WorkflowDefinition<OrderInput> = {
  type: "order",
  steps: [
    {
      name: "reserve_inventory",
      execute: async ({ input, idempotencyKey }) => reserveStock(input.sku, input.quantity, idempotencyKey),
    },
    {
      name: "charge_payment",
      execute: async ({ input, idempotencyKey }) =>
        chargePayment(input.amountCents, input.customerEmail, idempotencyKey),
    },
    {
      name: "confirm_order",
      execute: async ({ workflowId, input, idempotencyKey }) =>
        sendEmail(
          input.customerEmail,
          "Your order is confirmed",
          `Order ${workflowId}: ${input.quantity} x ${input.sku}.`,
          idempotencyKey,
        ),
    },
  ],
};
