# Step 9: History and tests

## History: `GET /orders/:id/history`

Migration `006` adds `workflow_events`, an append-only log. Each state change
inserts its event **in the same SQL statement or transaction as the change**,
for example:

```sql
WITH updated AS (UPDATE workflow_steps SET status = 'succeeded' ... RETURNING 1)
INSERT INTO workflow_events (...) SELECT ... FROM updated;
```

So the history can never disagree with the state: no event without its
change, no change without its event, even across a crash.

Real output for an order that hit a 503, survived a crash, then had its
confirmation rejected:

```
workflow_created
claimed                                       {"worker": "worker-1"}
step_started            reserve_inventory     {"attempt": 1}
step_retry_scheduled    reserve_inventory     {"error": "HTTP 503", "delayMs": 189}
released_until_retry                          {"delayMs": 189}
claimed                                       {"worker": "worker-1"}
step_started            reserve_inventory     {"attempt": 2}
step_succeeded          reserve_inventory     {"output": {"reservationId": "f1b5…"}}
step_started            charge_payment        {"attempt": 1}
step_succeeded          charge_payment        {"output": {"chargeId": "6f23…"}}
step_started            confirm_order         {"attempt": 1}
recovered_after_restart                       {"worker": "worker-1"}     <- kill -9 here
claimed                                       {"worker": "worker-1"}
step_started            confirm_order         {"attempt": 2}
step_failed             confirm_order         {"error": "HTTP 422 rejected"}
compensation_started                          {"undo": [1, 0]}
undo_started            charge_payment        {"attempt": 1}
undo_succeeded          charge_payment
undo_started            reserve_inventory     {"attempt": 1}
undo_succeeded          reserve_inventory
workflow_compensated
```

## Tests

```
npm test        # 23 tests, ~7s. Needs Postgres running (npm run db:up)
```

- A fresh `rebound_test` database is created for each run, so development
  data is never touched.
- The fake providers run inside the test process, so tests can set faults and
  read the provider's records directly.
- `drain()` runs workflows until they settle. When the only remaining work is a
  scheduled retry, it moves `next_run_at` to now instead of sleeping. Retry
  tests don't depend on timing.
- **Every test checks both** the final state in our database **and** the side
  effects at the provider (charges, refunds, stock, emails).

| Test | Failure it simulates | Asserts |
|---|---|---|
| happy path | none | 3 steps × 1 attempt; 1 charge, 1 email; exact event order |
| 20 identical requests | client retries / double-click | one 202, nineteen 200s, 1 workflow, 1 charge |
| reused / missing key | client bug | 422 / 400 |
| transient 503s | provider blip | 3 attempts, 1 charge |
| timed-out charge that went through | slow provider, ambiguous timeout | 2 attempts, **1 charge** |
| dropped response | work done, reply lost | 1 reservation, stock 98 |
| worker dies mid-charge | crash; zombie worker wakes later | completed, 2 attempts, 1 charge, zombie's write **rejected** (`LeaseLostError`) |
| restarted worker | crash + restart with same ID | leases reclaimed immediately, `recovered_after_restart` event |
| two workers, 20 orders | concurrency | 20 completed, 20 charges, every step 1 attempt |
| confirmation rejected | permanent failure late in the saga | compensated; 1 refund; stock back to 100; refund before release |
| card declined | permanent failure mid-saga | compensated; release only; 0 refunds |
| refund reply dropped | ambiguous undo | 2 undo attempts, **1 refund** |
| worker dies mid-refund | crash during compensation | compensated, 1 refund, zombie rejected |
| undo refused | compensation can't succeed | `failed`, "Manual intervention required" |
| charge never answers | outcome unknown | `failed`, `outcome_unknown = true`, stock still released |
| **kill -9 mid-charge** (real process) | power-cut crash | completed after restart, 1 charge |
| **kill -9 mid-refund** (real process) | power-cut crash during undo | compensated after restart, 1 refund |
| backoff / decideRetry (unit) | n/a | caps double up to max, jitter spreads, permanent never retried |

## Bugs the tests caught

1. **Leaking requests between tests.** A slow request from one test (300ms
   provider delay) was still in flight when the next test reset the provider.
   It landed afterwards and showed up as a 21st charge. The engine was fine;
   the test wasn't isolated. Fix: the fake counts delayed requests, and
   `resetAll()` waits for them to finish.
2. **Wrong expectation about replays.** A test expected a refund whose reply
   was dropped to need 3 attempts. It needed 2: the provider had **saved** the
   first result, so attempt 2 was a replay, and replays aren't dropped. The
   test was wrong; the behaviour is what we want.
3. **Latency longer than the timeout.** A "slow" fault of 300ms against a
   200ms test timeout turned a crash test into a timeout test. Kept under the
   timeout so each test simulates one thing.
