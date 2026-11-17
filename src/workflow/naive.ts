import { randomUUID } from "node:crypto";
import type { OrderInput } from "../types/order";
import { reserveStock } from "../services/inventory.service";
import { chargePayment } from "../services/payment.service";
import { sendEmail } from "../services/email.service";

/**
 * Step 3: the naive version, kept deliberately broken.
 *
 * Everything lives in this Map. If the process dies, the Map dies with it,
 * along with any record of what was already done in the outside world.
 */
export interface NaiveOrder {
  id: string;
  input: OrderInput;
  status: "running" | "confirmed" | "failed";
  reservationId?: string;
  chargeId?: string;
  messageId?: string;
  error?: string;
}

const orders = new Map<string, NaiveOrder>();

export function getNaiveOrder(id: string): NaiveOrder | undefined {
  return orders.get(id);
}

export async function runNaiveOrder(input: OrderInput): Promise<NaiveOrder> {
  const order: NaiveOrder = { id: randomUUID(), input, status: "running" };
  orders.set(order.id, order);
  console.log(`[order ${order.id}] started`);

  try {
    const { reservationId } = await reserveStock(input.sku, input.quantity);
    order.reservationId = reservationId;
    console.log(`[order ${order.id}] stock reserved`);

    const { chargeId } = await chargePayment(input.amountCents, input.customerEmail);
    order.chargeId = chargeId;
    console.log(`[order ${order.id}] payment charged`);

    const { messageId } = await sendEmail(input.customerEmail, "Order confirmed", `Order ${order.id} is confirmed.`);
    order.messageId = messageId;
    order.status = "confirmed";
    console.log(`[order ${order.id}] confirmed`);
  } catch (err) {
    // No compensation: whatever already happened (reserved stock, a charge) stays.
    order.status = "failed";
    order.error = (err as Error).message;
    console.log(`[order ${order.id}] failed: ${order.error}`);
  }

  return order;
}
