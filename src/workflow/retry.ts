import { ServiceError } from "../services/provider-client";

export interface RetryPolicy {
  /** Total tries, including the first. */
  maxAttempts: number;
  /** Delay cap for the first retry; doubles on each later one. */
  baseDelayMs: number;
  /** No single wait is longer than this. */
  maxDelayMs: number;
  /** How long one call may take before we give up waiting for it. */
  timeoutMs: number;
}

/**
 * Exponential backoff with "full jitter":
 *
 *   cap   = min(maxDelay, base * 2^(attempt - 1))
 *   delay = random between 0 and cap
 *
 * Exponential: each failure waits longer, giving a struggling service room to
 * recover instead of hammering it.
 * Jitter: if 1,000 workflows fail at the same moment (say the payment
 * provider blips), plain exponential backoff would retry all 1,000 at the same
 * moment again, and again. Randomizing spreads them out.
 *
 * `attempt` is the attempt that just failed (1 = the first try).
 */
export function backoffDelay(attempt: number, policy: RetryPolicy, random: () => number = Math.random): number {
  const cap = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * cap);
}

/**
 * Only transient failures are worth retrying: 5xx, network errors, timeouts.
 * A 4xx such as "card declined" will fail the same way every time. Unknown
 * errors (bugs) are treated as permanent so we don't retry them forever.
 */
export function isRetryable(err: unknown): boolean {
  return err instanceof ServiceError && err.kind === "transient";
}

export type RetryDecision =
  | { retry: true; delayMs: number }
  | { retry: false; reason: "permanent" | "exhausted" };

export function decideRetry(err: unknown, attempt: number, policy: RetryPolicy, random?: () => number): RetryDecision {
  if (!isRetryable(err)) return { retry: false, reason: "permanent" };
  if (attempt >= policy.maxAttempts) return { retry: false, reason: "exhausted" };
  return { retry: true, delayMs: backoffDelay(attempt, policy, random) };
}
