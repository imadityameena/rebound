import { postJson } from "./provider-client";

export async function reserveStock(sku: string, quantity: number): Promise<{ reservationId: string }> {
  return postJson("/inventory/reservations", { sku, quantity });
}

export async function releaseStock(reservationId: string): Promise<void> {
  await postJson(`/inventory/reservations/${reservationId}/release`, {});
}
