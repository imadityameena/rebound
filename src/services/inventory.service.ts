import { postJson } from "./provider-client";

export async function reserveStock(sku: string, quantity: number, idempotencyKey: string): Promise<{ reservationId: string }> {
  return postJson("/inventory/reservations", { sku, quantity }, idempotencyKey);
}

export async function releaseStock(reservationId: string, idempotencyKey: string): Promise<void> {
  await postJson(`/inventory/reservations/${reservationId}/release`, {}, idempotencyKey);
}
