# Step 7: Retries and timeouts

## What was built

- **Timeouts** (`src/services/provider-client.ts`): every call has
  `AbortSignal.timeout(timeoutMs)`. A hang now ends after 3s by default
  instead of blocking forever.
- **Classification**: 5xx, network errors and timeouts are **transient**;
  4xx are **permanent**; unknown errors (bugs) are treated as permanent.
- **Retry policy** (`src/workflow/retry.ts`): `maxAttempts`, `baseDelayMs`,
  `maxDelayMs`, `timeoutMs`. Defaults come from env, and each step can override
  them (`confirm_order` allows 8 attempts).
- **Persisted retries**: on a transient failure the step becomes
  `retry_scheduled`, the workflow's `next_run_at` moves into the future, and
  the lease is released. No process sleeps while waiting.

```
pending ──▶ running ──▶ succeeded
               │
               ├── transient, attempts left ──▶ retry_scheduled ──(backoff)──▶ running
               └── permanent / exhausted ─────▶ failed
```

## Backoff with full jitter

```
cap   = min(maxDelay, base × 2^(attempt − 1))      200, 400, 800, 1600, ... ≤ 10s
delay = random(0, cap)
```

**Why exponential:** a service that is failing is often overloaded. Retrying
fast adds load exactly when it hurts most. Doubling the wait gives it room to
recover.

**Why jitter:** picture 1,000 orders hitting a payment blip at the same moment.
Without jitter they all retry at +200ms, all fail again, all retry at
+400ms... Each retry is a synchronized spike. Randomizing the delay spreads
them evenly over the window, so the provider sees a smooth trickle.

## Why a timeout is ambiguous

When a call times out, we know we didn't get an answer. We don't know
whether the provider:

1. never received the request,
2. received it and is still working on it, or
3. finished it, but the reply was slow or lost.

So a timeout is **not** a failure of the operation. The only safe moves are to
retry **with the same idempotency key** (the provider tells us what actually
happened) or to ask the provider for the status. Treating a timeout as "failed"
and compensating could refund a charge that went through, or cancel an order
the customer was charged for.

## Experiments

```
A. payment fails 60% (503):
   attempt 1 failed (HTTP 503); retrying in 50ms
   succeeded on attempt 2                                          → completed

B. payment hangs on the first call:
   attempt 1 failed (no response within 3000ms (outcome unknown)); retrying in 184ms
   succeeded on attempt 2                                          → completed

C. payment always 503:
   retrying in 94ms, 39ms, 487ms, 667ms                            (caps 200, 400, 800, 1600)
   gave up after 5 attempts                                        → failed

D. card declined (422):
   permanent failure, no retry                                     → failed

E. crash while a retry is waiting (base delay 6s):
   before crash:  charge_payment = retry_scheduled, next_run_at in 2.85s
   after restart: completed, charge attempts = 2, provider charges = 1
```

Across A–D the provider recorded **1 charge**: only the orders whose payment
eventually succeeded were charged.

## Still broken

C and D left their stock reserved (`activeReservations: 3`). A failed
workflow doesn't undo the steps that already succeeded. That's Step 8.
