# Benchmarks

Measured with `npm run bench` on an 11th Gen Intel Core i5-11400H (12 threads),
Node 24, Postgres 16 in Docker on the same laptop. Numbers are for comparing
configurations on one machine, not absolute capacity claims.

Each order is 3 steps → 3 provider HTTP calls and about a dozen small
Postgres writes (claim, step started/succeeded ×3, events, finish).

## Throughput

| orders | provider latency | workers × concurrency | orders/s | p50 | p95 | p99 |
|---|---|---|---|---|---|---|
| 500 | 0ms | 1 × 1 | 40 | 22ms | 24ms | 27ms |
| 500 | 0ms | 1 × 8 | 217 | 31ms | 34ms | 39ms |
| 1000 | 0ms | 4 × 8 | 317 | 86ms | 95ms | 99ms |
| 500 | 20ms | 1 × 1 | 12 | 84ms | 86ms | 90ms |
| 1000 | 20ms | 1 × 8 | 85 | 90ms | 93ms | 95ms |
| 2000 | 20ms | 4 × 16 | 313 | 164ms | 176ms | 181ms |

p50/p95/p99 = time from a worker claiming the order to `workflow_completed`,
read from `workflow_events`. Every run ended with exactly one charge per order.

**Reading it:**

- With one order at a time, about 22ms per order is overhead: database round
  trips plus HTTP to the fake. That's roughly 11 writes, each a network
  round trip to Postgres in Docker.
- With a 20ms provider, one-at-a-time drops to 12/s (3 × 20ms of waiting per
  order). The worker is mostly **waiting**, so concurrency helps a lot:
  1×8 → 85/s, 4×16 → 313/s.
- At 4×16 the per-order time grows (164ms p50). The bottleneck has moved to
  Postgres (row locking for claims, many small writes). Next steps would be
  batching event inserts, or one transaction per step instead of several
  statements.

## Crash recovery

50 orders submitted, payment slowed to 2s, the API killed with `kill -9`
while 16 charges were in flight (the other 34 orders were still queued), then
restarted.

| restart as | lease | process up | all 50 settled | charges | duplicates |
|---|---|---|---|---|---|
| same worker ID | 10s | 319ms | 748ms | 50 | 0 |
| different worker (takeover) | 3s | 241ms | 3,276ms | 50 | 0 |

- **Same worker ID** (the usual case: a crashed process restarted by its
  supervisor): on startup it releases its own stale leases, so recovery
  doesn't wait for anything. About 0.3s is Node starting; the rest is running
  50 orders.
- **Different worker** (the crashed machine never comes back): the new worker
  can't take over until the dead worker's leases expire. Recovery time ≈ lease
  length. A shorter lease means faster takeover, but a worker that's only
  *slow* (GC pause, overloaded) is more likely to be wrongly declared dead.
  That's safe thanks to fenced writes, but it wastes work.
- **0 duplicate charges** in both: the 16 interrupted charges were repeated
  with the same idempotency keys and the provider replayed them.
