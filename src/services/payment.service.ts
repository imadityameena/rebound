import { postJson } from "./provider-client";

export async function chargePayment(
  amountCents: number,
  customerEmail: string,
  idempotencyKey: string,
): Promise<{ chargeId: string }> {
  return postJson("/payments/charges", { amountCents, customerEmail }, idempotencyKey);
}

export async function refundPayment(chargeId: string, idempotencyKey: string): Promise<void> {
  await postJson(`/payments/charges/${chargeId}/refund`, {}, idempotencyKey);
}
