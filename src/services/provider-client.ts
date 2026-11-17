import { config } from "../config/env";

/**
 * Whether retrying the same call could succeed.
 * - transient: 5xx, connection errors. Worth retrying.
 * - permanent: 4xx such as "card declined" or "out of stock". Retrying is pointless.
 */
export type FailureKind = "transient" | "permanent";

export class ServiceError extends Error {
  constructor(
    message: string,
    readonly kind: FailureKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

/**
 * POSTs JSON to the provider and turns every failure into a ServiceError.
 * With an idempotency key, repeating the call is safe: the provider returns
 * the saved result instead of doing the work again.
 */
export async function postJson<T>(path: string, body: unknown, idempotencyKey?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.fakesUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // The request never got a reply: refused, reset, or dropped mid-way.
    throw new ServiceError(`${path}: network error (${(err as Error).message})`, "transient");
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (res.ok) return data as T;

  const kind: FailureKind = res.status >= 500 ? "transient" : "permanent";
  throw new ServiceError(`${path}: HTTP ${res.status} ${data.error ?? ""}`.trim(), kind, res.status);
}
