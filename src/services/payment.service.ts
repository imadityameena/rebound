import { postJson } from "./provider-client";

export async function chargePayment(amountCents: number, customerEmail: string): Promise<{ chargeId: string }> {
  return postJson("/payments/charges", { amountCents, customerEmail });
}

export async function refundPayment(chargeId: string): Promise<void> {
  await postJson(`/payments/charges/${chargeId}/refund`, {});
}
