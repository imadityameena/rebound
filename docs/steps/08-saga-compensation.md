# Step 8: Saga compensation

## Why not one database transaction?

A transaction can roll back rows in our Postgres. It can't roll back a
payment at the payment provider or a reservation in someone else's inventory
system. Those are separate systems with their own databases.

A **saga** is a sequence of local steps, each with a **compensating action**
that semantically undoes it:

| Step | Compensation |
|---|---|
| reserve_inventory | release the reservation |
| charge_payment | refund the charge |
| confirm_order | none (it's the last step, and a sent email can't be unsent) |

If step N fails for good, steps N−1 … 0 are compensated **newest first**.

## What was built

- `compensate` on step definitions (`src/workflow/order-workflow.ts`). It
  receives the step's saved `output`, e.g. the `chargeId` to refund. That's
  why Step 4 persisted outputs: after a crash, memory is gone.
- `src/workflow/compensation.ts`: runs the undos in reverse, each with its
  own idempotency key `<workflowId>:<step>:compensate`, retries with
  backoff (at least 10 attempts), and progress tracked per step in
  `compensation_status` / `compensation_attempts`.
- New workflow states (migration `005`):

```
running ──▶ completed
   │
   └─ step fails for good ──▶ compensating ──▶ compensated   (everything undone; order cancelled cleanly)
                                   │
                                   └──────────▶ failed        (an undo gave up, or an outcome is unknown: needs a person)
```

- **One transaction** marks the step failed, switches the workflow to
  `compensating`, and queues the undo of each earlier step. If these were
  separate writes, a crash between them could leave a workflow "compensating"
  with nothing queued, and the stock and money would never be returned.
- The fake provider is now strict: a second refund returns
  `409 charge_already_refunded` and a second release returns
  `409 already_released`, like real systems. Only a repeat with the same
  idempotency key gets the original success back.

## Experiments

### A. Confirmation fails permanently (email provider rejects)

```
→ compensated
  reserve_inventory | succeeded | undo succeeded ×1
  charge_payment    | succeeded | undo succeeded ×1
  confirm_order     | failed    | -
provider: charges 1, refunds 1 (2500), activeReservations 0, stock 100
```

### B. Card declined

```
→ compensated
  reserve_inventory | succeeded | undo succeeded ×1
  charge_payment    | failed    | -            <- nothing to refund
provider: charges 0, refunds 0, stock 100
```

### C. Crash in the middle of the refund, then the refund's reply is dropped

```
Without a key, refunding twice:  200, then 409 charge_already_refunded

at crash:  compensating; charge undo = running ×1, reserve undo = pending
after restart:
  undo attempt 2 failed (network error: reply dropped); retrying in 119ms
  undo attempt 3 → undone
  reserve_inventory → undone
→ compensated
provider: refunds 1 (2500), activeReservations 0, stock 100
```

The refund was **attempted 3 times** (crash, dropped reply, success) and
**paid out once**. Without the idempotency key, attempts 2 and 3 would have
hit `409`, and the workflow would have wrongly ended as "undo failed".

### D. Payment never answers (outcome unknown)

```
→ failed
  charge_payment: gave up after 2 attempts: no response (outcome unknown);
  earlier steps were undone, but the outcome of charge_payment is unknown.
  Reconcile with the provider.
  reserve_inventory | succeeded | undo succeeded
  charge_payment    | failed    | outcome_unknown = true
```

We can't refund a charge whose ID we never received, and we can't claim it
didn't happen. The honest result is `failed` with a clear note, not
`compensated`.

## Limits of sagas

- **No isolation.** Between "charged" and "refunded", the outside world can
  see the intermediate state (a customer might see the charge on their card).
- **Compensation isn't always perfect.** A refund isn't the same as never
  charging (fees, statement lines). An email can't be unsent, which is why
  the order confirmation is the last step.
- **Undo can fail too.** After enough failed attempts we stop and flag it for
  a person rather than retrying forever.
