/**
 * Measures throughput and crash-recovery time.
 *
 *   npm run bench
 *
 * Uses its own database (rebound_bench) and its own fake providers on port
 * 4200, so it doesn't disturb development data. Requires Postgres (npm run db:up).
 */
import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import { Client } from "pg";

process.env.DB_NAME = "rebound_bench";
process.env.FAKES_URL = "http://localhost:4200";
process.env.WORKFLOW_LOGS = "off";

const API_PORT = 3200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function recreateDatabase() {
  const admin = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: "postgres",
  });
  await admin.connect();
  await admin.query("DROP DATABASE IF EXISTS rebound_bench WITH (FORCE)");
  await admin.query("CREATE DATABASE rebound_bench");
  await admin.end();
}

async function main() {
  await recreateDatabase();

  // Imported after the env is set, because config is read at import time.
  const { pool } = await import("../src/database/pool");
  const { migrate } = await import("../src/database/migrate");
  const { createFakeProviderApp, FakeProviderState } = await import("../src/fakes/app");
  const { FaultRegistry, FAKE_SERVICES } = await import("../src/fakes/faults");
  const { createWorkflow } = await import("../src/workflow/engine");
  const { orderWorkflow } = await import("../src/workflow/order-workflow");
  const { Worker } = await import("../src/workflow/worker");

  await migrate(pool);
  const faults = new FaultRegistry();
  const state = new FakeProviderState();
  const fakeServer = createFakeProviderApp(faults, state).listen(4200);
  await once(fakeServer, "listening");

  const order = { customerEmail: "bench@example.com", sku: "SKU-BOOK", quantity: 1, amountCents: 1000 };

  async function reset(latencyMs: number) {
    await pool.query("TRUNCATE workflows CASCADE");
    faults.reset();
    state.reset();
    state.stock.set("SKU-BOOK", 1_000_000);
    for (const s of FAKE_SERVICES) faults.update(s, { latencyMs });
  }

  async function createOrders(n: number) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push((await createWorkflow(orderWorkflow, order, `bench-${i}`)).workflow.id);
    return ids;
  }

  async function countByStatus() {
    const { rows } = await pool.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM workflows GROUP BY status`,
    );
    return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number>;
  }

  async function waitUntilSettled(n: number, timeoutMs = 120_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const c = await countByStatus();
      if ((c.completed ?? 0) + (c.compensated ?? 0) + (c.failed ?? 0) >= n) return;
      await sleep(20);
    }
    throw new Error("timed out waiting for workflows to settle");
  }

  /** Per-workflow time from first claim to completion, from the event log. */
  async function executionPercentiles() {
    const { rows } = await pool.query<{ ms: number }>(
      `SELECT extract(epoch FROM max(at) FILTER (WHERE type = 'workflow_completed')
                             - min(at) FILTER (WHERE type = 'claimed')) * 1000 AS ms
         FROM workflow_events GROUP BY workflow_id`,
    );
    const ms = rows.map((r) => Number(r.ms)).sort((a, b) => a - b);
    const pct = (p: number) => ms[Math.min(ms.length - 1, Math.floor((p / 100) * ms.length))];
    return { p50: pct(50), p95: pct(95), p99: pct(99) };
  }

  // ---------- Throughput ----------
  console.log(`\nMachine: ${os.cpus()[0]?.model} × ${os.cpus().length}, Node ${process.version}\n`);
  console.log("THROUGHPUT (3 steps per order, workers in one process)");
  console.log("| orders | provider latency | workers × concurrency | orders/s | p50 | p95 | p99 | charges |");
  console.log("|---|---|---|---|---|---|---|---|");

  const scenarios = [
    { n: 500, latencyMs: 0, workers: 1, concurrency: 1 },
    { n: 500, latencyMs: 0, workers: 1, concurrency: 8 },
    { n: 1000, latencyMs: 0, workers: 4, concurrency: 8 },
    { n: 500, latencyMs: 20, workers: 1, concurrency: 1 },
    { n: 1000, latencyMs: 20, workers: 1, concurrency: 8 },
    { n: 2000, latencyMs: 20, workers: 4, concurrency: 16 },
  ];

  for (const sc of scenarios) {
    await reset(sc.latencyMs);
    await createOrders(sc.n);
    const workers = Array.from(
      { length: sc.workers },
      (_, i) => new Worker({ id: `bench-${i}`, leaseMs: 10_000, pollMs: 50, concurrency: sc.concurrency }),
    );
    const t0 = performance.now();
    workers.forEach((w) => w.start());
    await waitUntilSettled(sc.n);
    const seconds = (performance.now() - t0) / 1000;
    await Promise.all(workers.map((w) => w.stop()));

    const p = await executionPercentiles();
    const counts = await countByStatus();
    if (counts.completed !== sc.n) throw new Error(`expected ${sc.n} completed, got ${JSON.stringify(counts)}`);
    console.log(
      `| ${sc.n} | ${sc.latencyMs}ms | ${sc.workers} × ${sc.concurrency} | ${(sc.n / seconds).toFixed(0)} | ` +
        `${p.p50.toFixed(0)}ms | ${p.p95.toFixed(0)}ms | ${p.p99.toFixed(0)}ms | ${state.snapshot().totals.charges} |`,
    );
  }

  // ---------- Crash recovery ----------
  let api: ChildProcess | undefined;
  async function startApi(workerId: string, leaseMs: number) {
    api = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      env: {
        ...process.env,
        PORT: String(API_PORT),
        WORKER_ID: workerId,
        WORKER_LEASE_MS: String(leaseMs),
        WORKER_CONCURRENCY: "16",
        STEP_TIMEOUT_MS: "10000",
      },
      stdio: "ignore",
    });
    for (;;) {
      try {
        if ((await fetch(`http://localhost:${API_PORT}/health`)).ok) return;
      } catch {
        /* not up yet */
      }
      await sleep(10);
    }
  }
  async function killApi() {
    if (!api || api.exitCode !== null) return;
    const exited = once(api, "exit");
    api.kill("SIGKILL");
    await exited;
  }

  console.log("\nCRASH RECOVERY (50 orders in flight, payment slowed to 2s, then kill -9)");
  console.log("| restart as | lease | process up | all 50 settled | charges | duplicate charges |");
  console.log("|---|---|---|---|---|---|");

  const recoveryScenarios = [
    { label: "same worker ID", sameId: true, leaseMs: 10_000 },
    { label: "different worker (takeover)", sameId: false, leaseMs: 3_000 },
  ];
  for (const sc of recoveryScenarios) {
    await reset(0);
    faults.update("payment", { latencyMs: 2000 });
    await startApi("crashy-worker", sc.leaseMs);
    for (let i = 0; i < 50; i++) {
      await fetch(`http://localhost:${API_PORT}/orders`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `crash-${i}` },
        body: JSON.stringify(order),
      });
    }
    // Wait until charges are in flight, then pull the plug.
    for (;;) {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM workflow_steps WHERE name = 'charge_payment' AND status = 'running'`,
      );
      if (rows[0].n >= 16) break;
      await sleep(10);
    }
    await killApi();
    const stranded = (await countByStatus()).running ?? 0;
    faults.update("payment", { latencyMs: 0 });

    const t0 = performance.now();
    await startApi(sc.sameId ? "crashy-worker" : "rescue-worker", sc.leaseMs);
    const up = performance.now() - t0;
    await waitUntilSettled(50);
    const settled = performance.now() - t0;
    while (faults.delayedRequests > 0) await sleep(20); // pre-crash requests land
    await killApi();

    const charges = state.snapshot().totals.charges;
    console.log(
      `| ${sc.label} (${stranded} stranded) | ${sc.leaseMs / 1000}s | ${up.toFixed(0)}ms | ${settled.toFixed(0)}ms | ` +
        `${charges} | ${charges - 50} |`,
    );
  }

  fakeServer.closeAllConnections();
  fakeServer.close();
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
