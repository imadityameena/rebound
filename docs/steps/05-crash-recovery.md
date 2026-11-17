# Step 5: Crash recovery

## What was built

- **`POST /orders` returns `202 Accepted` right away.** It only saves the
  workflow. The client follows the `Location` header to check progress.
- **Worker** (`src/workflow/worker.ts`): polls Postgres for runnable workflows
  and runs up to `WORKER_CONCURRENCY` at once. The database is the queue; there
  is no separate message broker.
- **Leases**: a worker claims a workflow by setting `locked_by` and
  `lease_expires_at`. While it works, it renews the lease every
  `WORKER_LEASE_MS / 3`. If it dies, the lease expires and the workflow becomes
  claimable again.
- **Fenced writes**: every step and status update includes
  `AND locked_by = <me>`. A worker that lost its lease, for example after a
  long pause, cannot overwrite another worker's progress. The update matches 0
  rows and throws `LeaseLostError`.
- **Startup recovery** (`src/workflow/recovery.ts`): a restarted process
  releases the leases held under its own `WORKER_ID` (that was a previous run
  of this process, now dead) and logs each unfinished workflow and where it
  stopped.

### The claim query

```sql
UPDATE workflows SET status='running', locked_by=$1, lease_expires_at=now()+lease
 WHERE id = (SELECT id FROM workflows
              WHERE status IN ('pending','running') AND next_run_at <= now()
                AND (lease_expires_at IS NULL OR lease_expires_at < now())
              ORDER BY next_run_at, created_at
              FOR UPDATE SKIP LOCKED LIMIT 1)
RETURNING *;
```

`FOR UPDATE SKIP LOCKED` lets several workers run this at the same time
without ever picking the same row and without waiting on each other.

### The safe resume point

The executor skips steps that already `succeeded` and loads their saved
`output`. It re-runs the first step that didn't succeed. A step left
`running` was interrupted mid-call, and we can't tell whether its effect
happened, so it runs again (its `attempts` becomes 2).

## Experiment: `kill -9` during each step, then restart

```
kill during inventory: reserve_inventory=running → after restart: completed in 0.37s, reserve attempts=2
kill during payment:   charge_payment=running    → after restart: completed in 0.38s, charge attempts=2
kill during email:     confirm_order=running     → after restart: completed in 0.37s, confirm attempts=2

[recovery] 1 unfinished workflow(s); reclaimed 1 lease(s) from a previous run of worker-1
[recovery]   9e71653a running, stopped at: charge_payment (running)
```

The times include starting the Node process.

## Experiment: what a crash during payment costs the customer

```
workflow: completed
charge_payment | succeeded | attempts 2
provider: charges: 2, capturedCents: 5000
  charge d5f2585e 2500 captured     <- from the call that was in flight when we crashed
  charge 5792a275 2500 captured     <- from recovery re-running the step
```

**Recovery works, and it charged the customer twice.** The first call reached
the provider and succeeded, but the process died before saving the result.
Recovery saw `running`, couldn't know the outcome, and called again. The same
thing happened to inventory (two reservations) and email (two emails) in the
per-step runs.

At-least-once execution plus non-idempotent side effects means duplicates.
Step 6 fixes this with idempotency keys.

## Trade-offs and limits

- **Recovery delay:** a crashed worker that restarts with the same `WORKER_ID`
  recovers instantly. If it never comes back, its workflows wait for the lease
  to expire (10s by default). A shorter lease recovers faster but gives false
  takeovers when a worker is only slow.
- **Unique IDs:** two live processes must never share a `WORKER_ID`, or one
  would release the other's leases on startup.
- **Polling** adds up to `WORKER_POLL_MS` (250ms) of latency before a new
  workflow starts. `LISTEN/NOTIFY` could remove that delay.
