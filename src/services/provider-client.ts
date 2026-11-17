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

export interface CallOptions {
  /** Makes repeating the call safe: the provider replays the first result. */
  idempotencyKey?: string;
  /** Abort the call if no response arrives in time. */
  timeoutMs?: number;
}

/** POSTs JSON to the provider and turns every failure into a ServiceError. */
export async function postJson<T>(path: string, body: unknown, opts: CallOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.fakesUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
      signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
    });
  } catch (err) {
    if ((err as Error).name === "TimeoutError") {
      // A timeout does NOT mean the operation failed. The provider may have
      // done the work and just been slow to reply. Treat the outcome as
      // unknown: retry with the same idempotency key and let the provider
      // tell us what happened.
      throw new ServiceError(`${path}: no response within ${opts.timeoutMs}ms (outcome unknown)`, "transient");
    }
    // The request never got a reply: refused, reset, or dropped mid-way.
    throw new ServiceError(`${path}: network error (${(err as Error).message})`, "transient");
  }

  let data: { error?: string } = {};
  try {
    const text = await res.text();
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new ServiceError(`${path}: unreadable response (HTTP ${res.status})`, "transient", res.status);
  }
  if (res.ok) return data as T;

  const kind: FailureKind = res.status >= 500 ? "transient" : "permanent";
  throw new ServiceError(`${path}: HTTP ${res.status} ${data.error ?? ""}`.trim(), kind, res.status);
}
