export interface OrderInput {
  customerEmail: string;
  sku: string;
  quantity: number;
  amountCents: number;
}

/** Returns the parsed input, or a list of problems with the request body. */
export function parseOrderInput(body: unknown): { ok: true; value: OrderInput } | { ok: false; errors: string[] } {
  const b = (body ?? {}) as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof b.customerEmail !== "string" || !b.customerEmail.includes("@")) errors.push("customerEmail must be an email");
  if (typeof b.sku !== "string" || b.sku.length === 0) errors.push("sku is required");
  if (!Number.isInteger(b.quantity) || (b.quantity as number) <= 0) errors.push("quantity must be a positive integer");
  if (!Number.isInteger(b.amountCents) || (b.amountCents as number) <= 0) errors.push("amountCents must be a positive integer");

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      customerEmail: b.customerEmail as string,
      sku: b.sku as string,
      quantity: b.quantity as number,
      amountCents: b.amountCents as number,
    },
  };
}
