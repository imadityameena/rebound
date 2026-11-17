# Step 3: Naive in-memory workflow

## What was built

`POST /orders` runs the three steps one after another inside the HTTP request,
keeping the order in an in-memory `Map` (`src/workflow/naive.ts`):

1. reserve stock
2. charge payment
3. send the confirmation email and mark the order confirmed

There is no database, no retry and no compensation. This version exists to be
broken on purpose.

## Experiment A: happy path

```
POST /orders → 201 {"status":"confirmed", reservationId, chargeId, messageId}
```

## Experiment B: `kill -9` during payment

Payment latency was set to 2s, an order was started, and the API was killed
1s later, while the payment call was in flight.

```
client saw:          HTTP 000 (connection dropped)
API log:             started → stock reserved → (nothing)
after restart:       GET /orders/:id → 404 not_found
provider totals:     charges: 2, activeReservations: 2, emails: 1
```

The second charge belongs to the crashed order. **The customer was charged,
the stock is held, no email was sent, and our system has no record that the
order ever existed.** Nothing will ever finish it or undo it.

## Experiment C: payment permanently declined

```
POST /orders → 502 {"status":"failed", "error":"HTTP 422 rejected", reservationId: ...}
provider:      activeReservations went from 2 to 3, stock dropped from 96 to 94
```

The order failed, but the stock it reserved is never released. Each declined
card permanently removes stock from sale.

## What was lost or left uncertain

| Lost | Why |
|---|---|
| The order itself | It lived only in process memory |
| Which steps had completed | Same reason |
| Whether the payment went through | The process died while waiting for the reply |
| Reserved stock after a failure | Nothing undoes earlier steps |
| The client's answer | The HTTP request died with the process |

## What the next steps fix

- Step 4: save workflow and step state in Postgres before and after each step
- Step 5: on startup, find unfinished workflows and continue them
- Step 6: idempotency keys, so repeating a step can't charge twice
- Step 8: compensation, so a failure undoes the earlier steps
