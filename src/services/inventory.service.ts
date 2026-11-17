import { postJson, type CallOptions } from "./provider-client";

export async function reserveStock(sku: string, quantity: number, opts: CallOptions): Promise<{ reservationId: string }> {
  return postJson("/inventory/reservations", { sku, quantity }, opts);
}

export async function releaseStock(reservationId: string, opts: CallOptions): Promise<void> {
  await postJson(`/inventory/reservations/${reservationId}/release`, {}, opts);
}
