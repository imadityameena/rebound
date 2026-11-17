# Step 2: Fake services

## What was built

A separate process (`npm run fakes`, port 4000) that stands in for three
outside companies:

| Service | Endpoints |
|---|---|
| Inventory | `POST /inventory/reservations`, `POST /inventory/reservations/:id/release` |
| Payment | `POST /payments/charges`, `POST /payments/charges/:id/refund` |
| Email | `POST /emails` |
| Admin | `GET /admin/state`, `PUT /admin/faults/:service`, `POST /admin/reset` |

The API talks to it only through the adapters in `src/services/`, the same way
it would talk to a real payment provider.

It is a separate process on purpose. When we kill the API later, the
provider keeps its records, just like a real payment company would. That is
what lets us count duplicate charges after a crash.

## Failure modes

Set per service at runtime with `PUT /admin/faults/:service`, or at startup
with env vars like `FAKE_PAYMENT_FAILURE_RATE=0.3`.

| Fault | Effect | Kind |
|---|---|---|
| `failureRate` | HTTP 503 | transient, a retry may work |
| `failNext` | the next N calls return 503 | transient, deterministic |
| `rejectRate` | HTTP 422 | permanent, a retry never works |
| `latencyMs` | slow response | |
| `hangRate` | never responds | only a client timeout ends it |
| `dropResponseRate` | does the work, then cuts the connection | ambiguous |

## Verification

```
normal:          201 in 0.012s
transient:       503 in 0.001s
permanent:       422 in 0.001s
slow (1.5s):     201 in 1.502s
hang (3s limit): 000 in 3.002s     <- curl gave up; the server never answered
drop response:   000 in 0.001s     <- caller saw an error...
provider recorded: charges: 3      <- ...but the charge happened
```

## What this shows

- A failed call does not mean nothing happened. In the "drop response" case the
  customer was charged, but the caller only saw a network error.
- A hang is worse than an error. Without a timeout, the caller waits forever.
- Errors need classifying. Retrying a 503 makes sense; retrying "card
  declined" does not. `src/services/provider-client.ts` labels every failure
  as `transient` or `permanent`.
- Fake services make real-world failures reproducible. Setting a rate to `1`
  makes a failure happen every time, which is what the tests rely on later.
