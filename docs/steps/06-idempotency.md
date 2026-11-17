# Step 6: Idempotency

Step 5 showed that recovery re-runs a step whose outcome is unknown, and that
this charged a customer twice. Idempotency makes repeating a step harmless.

## Two layers

### 1. Between the engine and the providers

Every step call carries an `Idempotency-Key` of `<workflowId>:<stepName>`.
The key is **stable**: the original attempt, a retry and a post-crash re-run
all send the same one.

The fake providers (`src/fakes/idempotency.ts`) behave like Stripe:

| Request | Response |
|---|---|
| New key | Processed; response saved |
| Same key, same body | Saved response replayed, `Idempotent-Replayed: true`, no new side effect |
| Same key, different body | `422 idempotency_key_reused` |
| Same key after a 5xx | Processed again, because 5xx results are not saved |

Order in the provider pipeline: network faults → **idempotency check** →
service faults → handler. The response is saved **before** a fault can drop
the connection, so a caller that never saw the reply can recover it by retrying.

```
key k1 first:      201 {"chargeId":"116a…"}
key k1 again:      201 Idempotent-Replayed: true {"chargeId":"116a…"}   <- same charge
key k1, new body:  422 idempotency_key_reused
key k2 hits 503:   503
key k2 retried:    201 {"chargeId":"edc0…"}                            <- 503 wasn't saved
key k3 dropped:    (no response, but charged)
key k3 retried:    201 Idempotent-Replayed: true {"chargeId":"1bbf…"}   <- recovered
provider: charges: 3 for 3 keys
```

### 2. Between the client and our API

`POST /orders` requires an `Idempotency-Key` header. Migration `003` adds
`idempotency_key` and `request_hash` to `workflows`, plus a **unique index** on
`(type, idempotency_key)`.

The insert uses `ON CONFLICT ... DO NOTHING`. If a row with that key exists, we
return it instead. Uniqueness is enforced by Postgres, not by a
"SELECT then INSERT" in application code, which would race.

```
10 identical requests at the same moment → 1 × 202, 9 × 200
workflows with key order-abc: 1 (completed)
same key, different body → 422 idempotency_key_reused
no key                   → 400 idempotency_key_required
replay after completion  → 200 Idempotent-Replayed: true, same id
```

## Verification: crash during each step, again

| Crash during | Step attempts | Provider afterwards |
|---|---|---|
| inventory | reserve = 2 | 1 reservation, 1 charge, 1 email |
| payment | charge = 2 | 1 reservation, **1 charge**, 1 email |
| email | confirm = 2 | 1 reservation, 1 charge, 1 email |

In Step 5 the payment row showed **2 charges**. Now there is one.

## "Exactly once"? Not quite

The engine still **executes** steps at least once. A step can run twice.
Idempotency makes the **effect** happen once: the provider deduplicates.
This is often called *effectively-once*. It holds only if:

- the provider honours idempotency keys (real Stripe does; many APIs don't),
- the provider keeps keys long enough (Stripe keeps them for 24 hours; a
  workflow stuck longer than that could double-charge),
- the step always sends the same key and the same body for the same work.

For a provider without idempotency keys, the alternative is to **check before
acting**: look up whether a charge for this order already exists, then decide.
That needs a query API from the provider and has its own race window.
