# Step 4: Database schema and persisted state

## What was built

- **Migrations** (`src/database/migrations.ts`, `migrate.ts`): applied on
  startup, each in its own transaction, recorded in `schema_migrations`.
- **`workflows`**: one row per order, holding its type, status and the original
  input.
- **`workflow_steps`**: one row per step, holding its status, attempt count,
  output and error.
- **Executor** (`src/workflow/executor.ts`): runs the steps and writes state
  around every external call.

### Every column, and why it exists

| Column | Why |
|---|---|
| `workflows.type` | Picks the definition to run, so a workflow can be resumed knowing only its row |
| `workflows.input` | The original request. Without it, a workflow can't be rebuilt after a crash |
| `workflows.status` | `pending → running → completed / failed` |
| `workflows.error` | Why it failed, readable without searching logs |
| `workflow_steps.step_index` | Execution order, and part of the primary key |
| `workflow_steps.status` | `pending → running → succeeded / failed` |
| `workflow_steps.attempts` | Incremented each time execution starts. More than 1 means "this was tried again" |
| `workflow_steps.output` | e.g. `{"chargeId": ...}`. Later steps and compensation (Step 8) need it, and memory is gone after a crash |
| `started_at` / `completed_at` | Timing, and evidence for debugging |

Creating a workflow inserts the workflow row and all its step rows in **one
transaction**, so you can never end up with a workflow missing its steps.

## Experiment: watching rows change (700ms per provider call)

```
t=1: reserve_inventory=succeeded, charge_payment=running,   confirm_order=pending
t=2: reserve_inventory=succeeded, charge_payment=succeeded, confirm_order=running
t=3: reserve_inventory=succeeded, charge_payment=succeeded, confirm_order=succeeded
```

## Experiment: `kill -9` during payment

```
workflow        | running
reserve_inventory | succeeded | attempts 1
charge_payment    | running   | attempts 1     <- crashed here
confirm_order     | pending   | attempts 0
provider: charges: 1, capturedCents: 2500
after restart: GET /orders/:id → still there, status "running"
3s later: unchanged. Nothing resumes it yet.
```

Compared with Step 3, the order is no longer lost, and the database shows
exactly where it stopped.

## Why mark a step `running` before the external call?

There are two possible orders:

1. **Write `running`, call, write `succeeded`** (what we do). A crash between
   the call and the `succeeded` write leaves `running`. That row says "we
   may have charged the customer". The uncertainty is visible.
2. **Call, then write `succeeded`.** A crash after the call leaves `pending`,
   which says "we never tried", and that is false. The provider charged the
   card. Recovery would charge again with no hint that anything went wrong.

`running` doesn't tell us whether the charge happened. It tells us that we
don't know, which is the honest answer. Step 6 makes it safe to retry anyway.

## Still broken

- Workflows stuck in `running` stay stuck forever (fixed in Step 5).
- The order still runs inside the HTTP request, so a crash drops the client's
  connection (fixed in Step 5).
- A declined payment still leaves stock reserved (fixed in Step 8).
