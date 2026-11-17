import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eventTypes, fakes, provider, resetAll, setFault, setUpSuite, stepOf, tearDownSuite, waitFor, workflowRow, ORDER } from "./helpers";

/**
 * The real thing: the API runs as its own process and gets `kill -9`
 * (SIGKILL: no cleanup, no shutdown hooks, like a power cut) in the middle of
 * an external call. Then it is started again, and we check what the customer
 * and the provider ended up with.
 */

const API = "http://localhost:3100";
let api: ChildProcess | undefined;

function startApiProcess() {
  api = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: "3100", WORKER_ID: "e2e-worker", STEP_TIMEOUT_MS: "5000" },
    stdio: "ignore",
  });
  return waitFor(async () => {
    try {
      return (await fetch(`${API}/health`)).ok;
    } catch {
      return false;
    }
  });
}

async function killApiProcess() {
  if (!api || api.exitCode !== null || api.signalCode !== null) return;
  const exited = once(api, "exit");
  api.kill("SIGKILL");
  await exited;
}

async function postOrder() {
  const res = await fetch(`${API}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": `e2e-${Math.random()}` },
    body: JSON.stringify(ORDER),
  });
  return ((await res.json()) as { id: string }).id;
}

const settled = (id: string) => async () =>
  ["completed", "compensated", "failed"].includes((await workflowRow(id)).status);

beforeAll(setUpSuite);
afterAll(tearDownSuite);
beforeEach(resetAll);
afterEach(killApiProcess);

describe("kill -9 and restart", () => {
  it("killed during the charge: finishes after restart with exactly one charge", async () => {
    setFault("payment", { latencyMs: 1000 });
    await startApiProcess();
    const id = await postOrder();

    await waitFor(async () => (await stepOf(id, "charge_payment")).status === "running");
    await killApiProcess();
    expect((await workflowRow(id)).status).toBe("running"); // stranded, mid-charge

    setFault("payment", { latencyMs: 0 });
    const restartedAt = Date.now();
    await startApiProcess();
    await waitFor(settled(id));
    const recoveryMs = Date.now() - restartedAt;

    expect((await workflowRow(id)).status).toBe("completed");
    expect((await stepOf(id, "charge_payment")).attempts).toBe(2);
    // The request sent just before the crash is still in flight at the provider.
    // Wait for it to land, so a duplicate charge from it would be counted.
    await waitFor(async () => fakes.faults.delayedRequests === 0);
    expect(provider().totals).toMatchObject({ charges: 1, capturedCents: 2500, emails: 1 });
    expect(await eventTypes(id)).toContain("recovered_after_restart");
    console.log(`recovered in ${recoveryMs}ms (including process start)`);
  });

  it("killed during the refund: compensation finishes after restart, refunded once", async () => {
    setFault("email", { rejectRate: 1 });
    setFault("payment", { latencyMs: 600 }); // slows the charge and the refund
    await startApiProcess();
    const id = await postOrder();

    await waitFor(async () => (await stepOf(id, "charge_payment")).compensation_status === "running");
    await killApiProcess();
    expect((await workflowRow(id)).status).toBe("compensating");

    setFault("payment", { latencyMs: 0 });
    await startApiProcess();
    await waitFor(settled(id));
    await waitFor(async () => fakes.faults.delayedRequests === 0); // pre-crash refund lands

    expect((await workflowRow(id)).status).toBe("compensated");
    expect(provider().totals).toMatchObject({ charges: 1, refunds: 1, refundedCents: 2500, activeReservations: 0 });
    expect(provider().stock["SKU-BOOK"]).toBe(100);
  });
});
