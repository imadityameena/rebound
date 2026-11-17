import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pool } from "../src/database/pool";
import { migrate } from "../src/database/migrate";
import * as repo from "../src/database/workflow.repository";
import { createFakeProviderApp, FakeProviderState } from "../src/fakes/app";
import { FaultRegistry, type FakeServiceName, type FaultConfig } from "../src/fakes/faults";
import { createWorkflow, getDefinition } from "../src/workflow/engine";
import { executeWorkflow } from "../src/workflow/executor";
import { orderWorkflow } from "../src/workflow/order-workflow";
import { createApp } from "../src/app";
import type { OrderInput } from "../src/types/order";

/** The fake providers run inside the test process, so tests can inspect them directly. */
export const fakes = { faults: new FaultRegistry(), state: new FakeProviderState() };
const servers: Server[] = [];

export const TEST_WORKER = "test-worker";

export const ORDER: OrderInput = {
  customerEmail: "ana@example.com",
  sku: "SKU-BOOK",
  quantity: 2,
  amountCents: 2500,
};

/** Migrates the test database and starts the fake providers on port 4100. */
export async function setUpSuite() {
  await migrate(pool);
  await listen(createFakeProviderApp(fakes.faults, fakes.state), 4100);
}

export async function tearDownSuite() {
  for (const server of servers) {
    server.closeAllConnections(); // hung requests would otherwise keep it open
    await new Promise((resolve) => server.close(resolve));
  }
  await pool.end();
}

/** Starts the real API on a random port and returns its base URL. */
export async function startApi(): Promise<string> {
  const server = await listen(createApp(), 0);
  return `http://localhost:${(server.address() as AddressInfo).port}`;
}

async function listen(app: ReturnType<typeof createApp>, port: number): Promise<Server> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(port, () => resolve(s));
  });
  servers.push(server);
  return server;
}

/** Each test starts with no workflows, full stock and no faults. */
export async function resetAll() {
  await waitFor(async () => fakes.faults.delayedRequests === 0);
  await new Promise((r) => setTimeout(r, 10)); // let a just-woken request finish its handler
  fakes.faults.reset();
  fakes.state.reset();
  await pool.query("TRUNCATE workflows CASCADE");
}

export function setFault(service: FakeServiceName, faults: Partial<FaultConfig>) {
  fakes.faults.update(service, faults);
}

export const provider = () => fakes.state.snapshot();

export async function newOrder(input: OrderInput = ORDER, key = `key-${Math.random()}`) {
  const { workflow } = await createWorkflow(orderWorkflow, input, key);
  return workflow.id;
}

/** Claims one runnable workflow and runs it as far as it gets. Returns false if nothing was runnable. */
export async function runOnce(workerId = TEST_WORKER): Promise<boolean> {
  const workflow = await repo.claimNextWorkflow(workerId, 10_000);
  if (!workflow) return false;
  await executeWorkflow(getDefinition(workflow.type), workflow, workerId);
  return true;
}

/**
 * Runs workflows until none are left unfinished. When the only remaining work
 * is waiting for a retry delay, it moves the clock forward (sets next_run_at
 * to now) instead of sleeping. Retries are tested deterministically, not by timing.
 */
export async function drain(workerId = TEST_WORKER, maxRounds = 200) {
  for (let i = 0; i < maxRounds; i++) {
    if (await runOnce(workerId)) continue;
    const { rowCount } = await pool.query(
      `UPDATE workflows SET next_run_at = now()
        WHERE status IN ('pending', 'running', 'compensating')
          AND next_run_at > now()
          AND (lease_expires_at IS NULL OR lease_expires_at < now())`,
    );
    if (rowCount === 0) return;
  }
  throw new Error("Workflows did not settle");
}

/** What a crashed worker leaves behind: a lease nobody will renew. Expire it now. */
export async function expireLease(workflowId: string) {
  await pool.query(`UPDATE workflows SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [workflowId]);
}

export async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timed out");
}

export const workflowRow = (id: string) => repo.getWorkflow(id).then((w) => w!);
export const stepsOf = (id: string) => repo.getSteps(id);
export const stepOf = async (id: string, name: string) => (await repo.getSteps(id)).find((s) => s.name === name)!;
export const eventTypes = async (id: string) => (await repo.getEvents(id)).map((e) => (e.step_name ? `${e.type}:${e.step_name}` : e.type));
