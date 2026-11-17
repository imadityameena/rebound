# Rebound: a crash-proof workflow engine

An order workflow (**reserve stock → charge payment → confirm order**) that
survives process crashes, resumes unfinished work, retries transient failures,
avoids duplicate side effects, and undoes completed steps when a later one
fails for good.

Built with Node.js, TypeScript, Express and PostgreSQL, step by step, breaking
each version on purpose before fixing it. The notes for each step are in
[`docs/steps/`](docs/steps/).

```
kill -9 during the payment, then restart:

  charge_payment   succeeded   attempts=2
  provider:        charges: 1   captured: $25.00
```

---

## Contents

- [Quick start](#quick-start)
- [API](#api)
- [Architecture](#architecture)
- [How each failure is handled](#how-each-failure-is-handled)
- [Measurements](#measurements)
- [Trade-offs](#trade-offs)
- [Limitations](#limitations)
- [Comparison with Temporal](#comparison-with-temporal)
- [Project structure](#project-structure)
- [Configuration](#configuration)
- [Build log](#build-log)
- [What I learned](#what-i-learned)

---

## Quick start

Requirements: Node.js 20+, Docker with Compose.

```bash
npm install
cp .env.example .env
npm run db:up            # Postgres 16 in Docker

npm run fakes            # terminal 1: fake inventory/payment/email providers on :4000
npm run dev              # terminal 2: API + worker on :3000 (migrations run on startup)
```

Place an order:

```bash
curl -i -X POST localhost:3000/orders \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: my-first-order' \
  -d '{"customerEmail":"ana@example.com","sku":"SKU-BOOK","quantity":2,"amountCents":2500}'

curl localhost:3000/orders/<id>
curl localhost:3000/orders/<id>/history
```

Break things:

```bash
# Make payments fail 50% of the time, or hang, or get declined
curl -X PUT localhost:4000/admin/faults/payment -H 'content-type: application/json' -d '{"failureRate":0.5}'
curl -X PUT localhost:4000/admin/faults/payment -H 'content-type: application/json' -d '{"hangRate":1}'
curl -X PUT localhost:4000/admin/faults/email   -H 'content-type: application/json' -d '{"rejectRate":1}'
curl localhost:4000/admin/state     # what the "outside world" recorded
```

Other commands:

| Command | What it does |
|---|---|
| `npm test` | 23 tests, including real `kill -9` crash tests (~7s) |
| `npm run demo` | Narrated crash-recovery demo |
| `npm run bench` | Throughput and recovery-time measurements |
| `npm run db:psql` | Open `psql` on the dev database |
| `npm run typecheck` | Type-check source, tests and scripts |

---

## API

| Method | Path | Notes |
|---|---|---|
| `POST` | `/orders` | **Requires `Idempotency-Key`.** Returns `202` with the order id; a repeat with the same key returns `200` and the same order; same key + different body → `422` |
| `GET` | `/orders/:id` | Current status, every step's status, attempts, output and compensation |
| `GET` | `/orders/:id/history` | Every state change in order: attempts, retry delays, crash recoveries, undos |
| `GET` | `/health` | `200` if Postgres answers, `503` if not |

Order statuses: `pending` → `running` → `completed`, or
`running` → `compensating` → `compensated` (cleanly cancelled), or `failed`
(needs a person: an undo failed, or an outcome is unknown).

---

## Architecture

```
            POST /orders                               GET /orders/:id(/history)
                 │                                                ▲
                 ▼                                                │
  ┌──────────────────────────┐   INSERT workflow + steps   ┌─────────────────────────┐
  │ API (Express)            │ ──────── (one tx) ────────▶ │ PostgreSQL              │
  │  idempotency on the key  │                             │                         │
  └──────────────────────────┘                             │  workflows       (state,│
                                                           │    lease, next_run_at)  │
  ┌──────────────────────────┐   claim: UPDATE … WHERE id  │  workflow_steps  (status│
  │ Worker (same process)    │ ◀── (SELECT … FOR UPDATE ── │    attempts, output,    │
  │  ├ executor   (forward)  │       SKIP LOCKED)          │    compensation)        │
  │  ├ retry      (backoff)  │                             │  workflow_events (append│
  │  ├ compensation (undo)   │ ── fenced writes + event ─▶ │    -only history)       │
  │  └ recovery   (startup)  │      (same statement)       └─────────────────────────┘
  └──────────────────────────┘
               │  HTTP + Idempotency-Key + timeout
               ▼
  ┌──────────────────────────────────────────────────┐
  │ Fake providers (separate process)                │
  │  inventory · payment · email                     │
  │  injectable faults: 503, 422, latency, hang,     │
  │  "do the work, then drop the reply"              │
  └──────────────────────────────────────────────────┘
```

### Components

| Component | File | Job |
|---|---|---|
| API | `src/app.ts`, `src/controllers/` | Validate, enforce `Idempotency-Key`, save the workflow, return `202` |
| Engine | `src/workflow/engine.ts` | Workflow definitions, create, describe, history |
| Worker | `src/workflow/worker.ts` | Poll Postgres, claim with a lease, renew it, run up to N workflows at once |
| Executor | `src/workflow/executor.ts` | Run remaining steps; persist before and after every call; decide retry or compensate |
| Retry | `src/workflow/retry.ts` | Classify errors; exponential backoff with full jitter |
| Compensation | `src/workflow/compensation.ts` | Undo succeeded steps newest first, idempotently, with retries |
| Recovery | `src/workflow/recovery.ts` | On startup, reclaim this worker's stale leases and report unfinished work |
| Repository | `src/database/workflow.repository.ts` | All SQL; lease fencing; history written with each change |
| Adapters | `src/services/` | HTTP to providers with timeouts and idempotency keys; transient/permanent classification |

### The step state machine

```
pending ──▶ running ──▶ succeeded ─────────────────────────────▶ (undo if a later step fails)
               │                                                   pending → running → succeeded
               ├── transient error, attempts left ──▶ retry_scheduled ──(backoff)──▶ running
               └── permanent / exhausted ──▶ failed ──▶ workflow: compensating
```

### The rules that make it crash-proof

1. **Save the intent before acting.** A workflow and all its steps are saved
   (one transaction) before anything external happens.
2. **Mark a step `running` before calling out, `succeeded` after.** A crash
   in between leaves `running`, which honestly means "outcome unknown".
3. **Repeat unknown steps with the same idempotency key.** The key
   `<workflowId>:<step>` makes a repeated charge a replay, not a second charge.
4. **Keep everything needed to continue in the database.** Input, step
   outputs (the `chargeId` to refund later), retry times. Memory is gone after
   a crash.
5. **Leases with fencing.** One worker per workflow at a time; every write
   checks `locked_by = me`, so a worker that was presumed dead and wakes up
   can't overwrite anything.
6. **History in the same statement as the change.** The event log can't
   drift from the state.

---

## How each failure is handled

| Failure | What happens | Verified by |
|---|---|---|
| Process killed mid-step | Step left `running`; on restart it's repeated with the same key; provider replays | `crash.e2e.test.ts`, `npm run demo` |
| Worker paused, lease expired, another took over | Old worker's late writes rejected (`LeaseLostError`) | `workflow.test.ts` › crash recovery |
| Provider 503 / network error | Retried with backoff + jitter, same key | › retries |
| Provider hangs | Call times out (default 3s); retried | › unknown outcome |
| Timeout but the provider did the work | Retry with same key returns the original result; one charge | › timed-out charge |
| Reply dropped after the work was done | Same as above | › dropped response |
| Client retries `POST /orders` | Unique `(type, idempotency_key)` → same order | › 20 identical requests |
| Card declined / email rejected | Undo earlier steps newest first → `compensated` | › saga compensation |
| Crash during compensation | Undo progress is persisted per step; resumes; one refund | › dies mid-refund, e2e |
| Undo itself refused | Stop and mark `failed`: "Manual intervention required" | › undo refused |
| Step outcome never known | Undo the rest, mark `failed` with `outcome_unknown`, ask for reconciliation | › charge never answers |
| Postgres down | `/health` → 503; claims fail and are retried; nothing is lost | Step 1 |

---

## Measurements

Full results and method: [`docs/benchmarks.md`](docs/benchmarks.md).
Intel i5-11400H laptop, Postgres in Docker.

| Scenario | Result |
|---|---|
| Throughput, 1 worker, 1 at a time, instant providers | 40 orders/s (≈22ms each, mostly DB round trips) |
| Throughput, 4 workers × 16, providers at 20ms | 313 orders/s |
| Recovery after `kill -9`, same worker restarts | all 50 in-flight orders settled 748ms after restart (319ms of it is Node starting) |
| Recovery when a different worker takes over | 3.3s (lease 3s) |
| Duplicate charges across all runs | 0 |

---

## Trade-offs

| Decision | Gain | Cost |
|---|---|---|
| Postgres is the queue (no broker) | State and queue change in one transaction; one less system to run | Polling adds up to 250ms of latency; Postgres caps throughput |
| Write `running` before every call | Crashes leave visible evidence of the uncertain call | One extra write per step |
| Retries persisted (`next_run_at`), no in-process sleep | Survive crashes; worker slots stay free while waiting | Extra writes, plus a re-claim per retry |
| Leases instead of "the worker that started it finishes it" | Any worker can take over a dead one's work | Must choose a lease length: short = fast takeover but more false takeovers |
| Same-ID restart releases its own leases immediately | Sub-second recovery for the common case | Two live processes must never share a `WORKER_ID` |
| `202 Accepted` + polling | A crash never takes a client's request with it | Clients must poll (or you add webhooks) |
| Require `Idempotency-Key` | Retrying clients can't create duplicate orders | Slightly more work for API clients |
| Event row in the same statement as each change | History is always consistent with state | About twice as many rows written |
| Sagas, not distributed transactions | Works across systems that know nothing of each other | No isolation; undo is "semantic", not perfect (a refund isn't the same as never charging) |

---

## Limitations

- **Effectively-once, not exactly-once.** Steps run *at least once*; the
  *effect* happens once only because providers honour idempotency keys. A
  provider without them, or one that forgets keys too soon (Stripe keeps them
  24h), breaks that guarantee.
- **Fencing protects our database, not the outside world.** A worker that
  lost its lease can still be mid-HTTP-call. That's safe only because the
  same idempotency key makes the duplicate call harmless.
- **Linear workflows only.** No branches, parallel steps, loops, timers or
  waiting for external signals.
- **No workflow versioning.** Steps are matched by position. Changing a
  definition while workflows are in flight could resume them at the wrong step.
- **`failed` needs a person, and there's no tooling.** No admin endpoint to
  retry, skip or mark resolved.
- **Single Postgres.** It's the single point of failure. The design scales to a
  few workers; beyond that, claim contention and write volume become limits.
- **History grows forever.** No archiving or retention for `workflow_events`.
- **Unknown outcomes aren't reconciled automatically.** We flag them; a real
  system would query the provider ("is there a charge for this key?").
- **The fake providers keep state in memory.** Restarting them forgets
  everything, including idempotency keys.
- **Not production-hardened.** No authentication, rate limiting, metrics or
  tracing.

---

## Comparison with Temporal

[Temporal](https://temporal.io) is a production durable-execution platform.
This project solves a small slice of the same problem by hand.

| | Rebound | Temporal |
|---|---|---|
| **Model** | Fixed list of steps; current state stored per step | Workflow is ordinary code; an event history is replayed to rebuild its state |
| **How it resumes** | Skip `succeeded` steps, reload their outputs, repeat the uncertain one | Replay the history deterministically up to the last recorded event, then continue |
| **Code constraints** | None: steps are plain async functions | Workflow code must be deterministic (no direct I/O, time or randomness; use SDK APIs) |
| **Control flow** | Linear only | Branches, loops, parallel activities, child workflows, timers, signals, queries |
| **Side effects** | Steps call providers directly | Activities, with retry policies and several timeout kinds (start-to-close, schedule-to-close, heartbeat) |
| **Retries / timeouts** | Per-step policy, full-jitter backoff | Per-activity policy, built in |
| **Worker liveness** | Leases renewed by heartbeat; fenced writes | Activity heartbeats and timeouts; task tokens |
| **Compensation** | Built into the engine (`compensate` per step) | You write it in workflow code (try/catch, run undo activities) |
| **Idempotency of side effects** | Your responsibility (keys sent to providers) | **Still your responsibility.** Activities can run more than once too |
| **Queue** | Postgres rows + `FOR UPDATE SKIP LOCKED` polling | Task queues served by the Temporal server; workers long-poll |
| **Versioning** | None | Built-in patching / worker versioning |
| **Visibility** | `GET /orders/:id/history`, SQL | Web UI, search by attributes, full history per workflow |
| **Operations** | Your app + Postgres | A Temporal cluster (or Temporal Cloud) plus its database |
| **Scale** | A few workers on one Postgres | Built to shard to very large numbers of workflows |

**When to use which:** for a couple of fixed, linear processes in a system
that already runs Postgres, a small engine like this is easy to reason about
and has no extra infrastructure. Once you need branching, long waits
(days), signals from people, many workflow types, versioning, or real scale,
Temporal (or a similar engine) is the better choice, and the hard parts
it handles are exactly the ones listed under [Limitations](#limitations).

Both share one lesson: **the engine can make execution durable, but only
idempotent side effects make it safe.**

---

## Project structure

```
src/
  app.ts, server.ts          HTTP app; startup: migrate → recover → start worker → listen
  config/env.ts              all settings, validated at startup
  controllers/, routes/      orders + health endpoints
  database/
    migrations.ts            schema, applied in order (001–006)
    migrate.ts               migration runner (advisory-locked)
    workflow.repository.ts   all SQL: claims, leases, fenced writes, history
    pool.ts
  workflow/
    engine.ts                definitions, create, describe, history
    order-workflow.ts        the 3 steps and their undo actions
    worker.ts                polling, leases, concurrency
    executor.ts              forward execution
    retry.ts                 backoff + classification
    compensation.ts          saga undo
    recovery.ts              startup recovery
  services/                  provider adapters (timeouts, idempotency keys)
  fakes/                     fake providers with fault injection
tests/                       integration + kill -9 end-to-end tests
scripts/                     bench.ts, demo-crash.sh
docs/                        per-step notes, benchmarks
```

---

## Configuration

All settings come from environment variables (see `.env.example`).

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | API port |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | required | Postgres connection |
| `FAKES_PORT`, `FAKES_URL` | 4000 | Fake provider server |
| `WORKER_ID` | `worker-<hostname>` | Must be unique per running process |
| `WORKER_LEASE_MS` | 10000 | How long a claim lasts without renewal |
| `WORKER_POLL_MS` | 250 | Idle polling interval |
| `WORKER_CONCURRENCY` | 4 | Workflows run at once per process |
| `RETRY_MAX_ATTEMPTS` | 5 | Default attempts per step (undos get at least 10) |
| `RETRY_BASE_DELAY_MS`, `RETRY_MAX_DELAY_MS` | 200, 10000 | Backoff range |
| `STEP_TIMEOUT_MS` | 3000 | Per-call timeout |
| `FAKE_<SERVICE>_<FAULT>` | 0 | Initial faults, e.g. `FAKE_PAYMENT_FAILURE_RATE=0.3` |

---

## Build log

| Step | What changed | Notes |
|---|---|---|
| 1 | Project setup, Postgres in Docker, `/health` | |
| 2 | Fake providers with fault injection | [02](docs/steps/02-fake-services.md) |
| 3 | Naive in-memory workflow, broken on purpose | [03](docs/steps/03-naive-workflow.md) |
| 4 | Persisted workflow and step state | [04](docs/steps/04-persisted-state.md) |
| 5 | Worker, leases, crash recovery | [05](docs/steps/05-crash-recovery.md) |
| 6 | Idempotency keys (providers and API) | [06](docs/steps/06-idempotency.md) |
| 7 | Retries, backoff with jitter, timeouts | [07](docs/steps/07-retries-and-timeouts.md) |
| 8 | Saga compensation | [08](docs/steps/08-saga-compensation.md) |
| 9 | History endpoint and automated tests | [09](docs/steps/09-history-and-tests.md) |
| 10 | Measurements and this README | [benchmarks](docs/benchmarks.md) |

---

## What I learned

<!-- Write this section yourself. -->
