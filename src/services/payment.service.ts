import { postJson, type CallOptions } from "./provider-client";

export async function chargePayment(
  amountCents: number,
  customerEmail: string,
  opts: CallOptions,
): Promise<{ chargeId: string }> {
  return postJson("/payments/charges", { amountCents, customerEmail }, opts);
}

export async function refundPayment(chargeId: string, opts: CallOptions): Promise<{ refundId: string }> {
  return postJson(`/payments/charges/${chargeId}/refund`, {}, opts);
}
