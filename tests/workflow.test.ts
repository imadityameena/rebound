import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/database/pool";
import * as repo from "../src/database/workflow.repository";
import { getDefinition } from "../src/workflow/engine";
import { executeWorkflow } from "../src/workflow/executor";
import {
  ORDER,
  TEST_WORKER,
  drain,
  eventTypes,
  expireLease,
  newOrder,
  provider,
  resetAll,
  runOnce,
  setFault,
  setUpSuite,
  startApi,
  stepOf,
  stepsOf,
  tearDownSuite,
  waitFor,
  workflowRow,
} from "./helpers";

/**
 * Every test names the failure it simulates, and checks two things:
 *   1. the final state in our database, and
 *   2. the side effects in the outside world (charges, refunds, stock, emails).
 * A workflow marked "completed" proves nothing if the customer was charged twice.
 */

beforeAll(setUpSuite);
afterAll(tearDownSuite);
beforeEach(resetAll);

describe("happy path", () => {
  it("runs all three steps once and records the history in order", async () => {
    const id = await newOrder();
    await drain();

    expect((await workflowRow(id)).status).toBe("completed");
    expect((await stepsOf(id)).map((s) => [s.name, s.status, s.attempts])).toEqual([
      ["reserve_inventory", "succeeded", 1],
      ["charge_payment", "succeeded", 1],
      ["confirm_order", "succeeded", 1],
    ]);

    const p = provider();
    expect(p.totals).toMatchObject({ activeReservations: 1, charges: 1, capturedCents: 2500, refunds: 0, emails: 1 });
    expect(p.stock["SKU-BOOK"]).toBe(98);

    expect(await eventTypes(id)).toEqual([
      "workflow_created",
      "claimed",
      "step_started:reserve_inventory",
      "step_succeeded:reserve_inventory",
      "step_started:charge_payment",
      "step_succeeded:charge_payment",
      "step_started:confirm_order",
      "step_succeeded:confirm_order",
      "workflow_completed",
    ]);
  });
});

describe("duplicate requests (POST /orders idempotency)", () => {
  it("20 identical requests at the same moment create exactly one order", async () => {
    const api = await startApi();
    const send = () =>
      fetch(`${api}/orders`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "same-key" },
        body: JSON.stringify(ORDER),
      });

    const responses = await Promise.all(Array.from({ length: 20 }, send));
    const bodies = await Promise.all(responses.map((r) => r.json()));

    expect(responses.map((r) => r.status).sort()).toEqual([...Array(19).fill(200), 202]);
    expect(new Set(bodies.map((b) => b.id)).size).toBe(1);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM workflows`);
    expect(rows[0].n).toBe(1);

    await drain();
    expect(provider().totals).toMatchObject({ charges: 1, emails: 1 });
  });

  it("rejects a reused key with a different body, and a missing key", async () => {
    const api = await startApi();
    const post = (key: string | null, body: unknown) =>
      fetch(`${api}/orders`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
        body: JSON.stringify(body),
      });

    expect((await post("k1", ORDER)).status).toBe(202);
    expect((await post("k1", { ...ORDER, amountCents: 1 })).status).toBe(422);
    expect((await post(null, ORDER)).status).toBe(400);
  });
});

describe("retries and timeouts", () => {
  it("transient 503s are retried with the same key; the customer is charged once", async () => {
    setFault("payment", { failNext: 2 });
    const id = await newOrder();
    await drain();

    expect((await workflowRow(id)).status).toBe("completed");
    expect((await stepOf(id, "charge_payment")).attempts).toBe(3);
    expect(provider().totals).toMatchObject({ charges: 1, capturedCents: 2500 });
    expect(await eventTypes(id)).toContain("step_retry_scheduled:charge_payment");
  });

  it("a timed-out charge that actually went through is not charged again", async () => {
    // The provider takes 400ms; we give up after 200ms. The charge still happens.
    setFault("payment", { latencyMs: 400 });
    const id = await newOrder();
    await runOnce();

    const charge = await stepOf(id, "charge_payment");
    expect(charge.status).toBe("retry_scheduled");
    expect(charge.error).toContain("outcome unknown");

    // Let the slow request land at the provider, then recover.
    await waitFor(async () => provider().totals.charges === 1);
    setFault("payment", { latencyMs: 0 });
    await drain();

    expect((await workflowRow(id)).status).toBe("completed");
    expect((await stepOf(id, "charge_payment")).attempts).toBe(2);
    expect(provider().totals).toMatchObject({ charges: 1, capturedCents: 2500 });
  });

  it("a dropped response (work done, reply lost) is recovered by retrying", async () => {
    setFault("inventory", { dropResponseRate: 1 });
    const id = await newOrder();
    await runOnce();
    setFault("inventory", { dropResponseRate: 0 });
    await drain();

    expect((await workflowRow(id)).status).toBe("completed");
    expect(provider().totals.reservations).toBe(1);
    expect(provider().stock["SKU-BOOK"]).toBe(98);
  });
});

describe("crash recovery", () => {
  it("a worker that dies mid-charge is replaced; its late write is rejected; one charge", async () => {
    // Simulate a crash: worker "dead" starts the charge (slow provider, but
    // within the 200ms timeout), then stops renewing its lease. We expire the
    // lease as if time had passed.
    setFault("payment", { latencyMs: 150 });
    const id = await newOrder();
    const dead = await repo.claimNextWorkflow("dead-worker", 10_000);
    const deadRun = executeWorkflow(getDefinition(dead!.type), dead!, "dead-worker");

    await waitFor(async () => (await stepOf(id, "charge_payment")).status === "running");
    await expireLease(id);
    setFault("payment", { latencyMs: 0 });

    // A healthy worker takes over and repeats the uncertain step with the same key.
    await drain();

    // The dead worker wakes up and tries to record its result: rejected.
    await expect(deadRun).rejects.toBeInstanceOf(repo.LeaseLostError);

    expect((await workflowRow(id)).status).toBe("completed");
    expect((await stepOf(id, "charge_payment")).attempts).toBe(2);
    expect(provider().totals).toMatchObject({ charges: 1, capturedCents: 2500, emails: 1 });
  });

  it("a restarted worker immediately reclaims the workflows it held", async () => {
    const id = await newOrder();
    await repo.claimNextWorkflow(TEST_WORKER, 60_000); // claimed, then the process "died"

    expect(await repo.claimNextWorkflow("other", 60_000)).toBeUndefined(); // still leased
    const released = await repo.releaseLeasesHeldBy(TEST_WORKER); // what recovery does on startup
    expect(released.map((w) => w.id)).toEqual([id]);

    await drain();
    expect((await workflowRow(id)).status).toBe("completed");
    expect(await eventTypes(id)).toContain("recovered_after_restart");
  });

  it("two workers never run the same workflow; 20 orders, 20 charges", async () => {
    const ids = await Promise.all(Array.from({ length: 20 }, () => newOrder()));
    await Promise.all([drain("worker-a"), drain("worker-b")]);

    const { rows } = await pool.query(`SELECT status, count(*)::int AS n FROM workflows GROUP BY status`);
    expect(rows).toEqual([{ status: "completed", n: 20 }]);
    expect(provider().totals).toMatchObject({ charges: 20, emails: 20 });
    for (const id of ids) {
      expect((await stepsOf(id)).every((s) => s.attempts === 1)).toBe(true);
    }
  });
});

describe("saga compensation", () => {
  it("confirmation fails permanently: refund and release happen exactly once, newest first", async () => {
    setFault("email", { rejectRate: 1 });
    const id = await newOrder();
    await drain();

    const wf = await workflowRow(id);
    expect(wf.status).toBe("compensated");
    expect(wf.error).toContain("confirm_order: permanent failure");

    const p = provider();
    expect(p.totals).toMatchObject({ charges: 1, refunds: 1, refundedCents: 2500, activeReservations: 0, emails: 0 });
    expect(p.stock["SKU-BOOK"]).toBe(100);

    const events = await eventTypes(id);
    expect(events.indexOf("undo_succeeded:charge_payment")).toBeLessThan(events.indexOf("undo_succeeded:reserve_inventory"));
  });

  it("card declined: only the stock is released; nothing to refund", async () => {
    setFault("payment", { rejectRate: 1 });
    const id = await newOrder();
    await drain();

    expect((await workflowRow(id)).status).toBe("compensated");
    expect((await stepOf(id, "charge_payment")).compensation_status).toBeNull();
    expect(provider().totals).toMatchObject({ charges: 0, refunds: 0, activeReservations: 0 });
    expect(provider().stock["SKU-BOOK"]).toBe(100);
  });

  it("refund reply dropped: the retry gets the saved refund back; refunded once", async () => {
    setFault("email", { failNext: 1 });
    const id = await newOrder();
    await runOnce(); // reserve and charge succeed; confirm hits a 503 and waits to retry

    // Now the confirmation fails for good, and the refund's reply gets dropped.
    setFault("email", { rejectRate: 1 });
    setFault("payment", { dropResponseRate: 1 });
    await pool.query(`UPDATE workflows SET next_run_at = now() WHERE id = $1`, [id]);
    await runOnce(); // confirm fails → compensation → refund done at the provider, reply lost

    expect((await stepOf(id, "charge_payment")).compensation_status).toBe("retry_scheduled");
    expect(provider().totals.refunds).toBe(1); // it DID happen, we just weren't told

    await drain(); // retry with the same key: the provider replays the saved refund

    expect((await workflowRow(id)).status).toBe("compensated");
    expect((await stepOf(id, "charge_payment")).compensation_attempts).toBe(2);
    expect(provider().totals).toMatchObject({ refunds: 1, refundedCents: 2500, activeReservations: 0 });
  });

  it("a worker that dies mid-refund is replaced; the refund is paid once", async () => {
    setFault("email", { rejectRate: 1 });
    setFault("payment", { latencyMs: 150 }); // slows the charge and the refund (under the 200ms timeout)
    const id = await newOrder();
    const dead = await repo.claimNextWorkflow("dead-worker", 10_000);
    const deadRun = executeWorkflow(getDefinition(dead!.type), dead!, "dead-worker");

    await waitFor(async () => (await stepOf(id, "charge_payment")).compensation_status === "running");
    await expireLease(id);
    setFault("payment", { latencyMs: 0 });
    await drain();
    await expect(deadRun).rejects.toBeInstanceOf(repo.LeaseLostError);

    expect((await workflowRow(id)).status).toBe("compensated");
    expect(provider().totals).toMatchObject({ charges: 1, refunds: 1, refundedCents: 2500, activeReservations: 0 });
  });

  it("an undo that fails for good stops and asks for a person", async () => {
    setFault("email", { failNext: 1 }); // confirm is retried later; charge already done
    const id = await newOrder();
    await runOnce();
    setFault("email", { rejectRate: 1 });
    setFault("payment", { rejectRate: 1 }); // the refund will be refused
    await drain();

    const wf = await workflowRow(id);
    expect(wf.status).toBe("failed");
    expect(wf.error).toContain("Manual intervention required");
    expect((await stepOf(id, "charge_payment")).compensation_status).toBe("failed");
    // Stock is still held: we stopped instead of guessing.
    expect(provider().totals).toMatchObject({ charges: 1, refunds: 0 });
  });

  it("a charge whose outcome stays unknown is flagged, not called compensated", async () => {
    setFault("payment", { hangRate: 1 });
    const id = await newOrder();
    await drain();

    const wf = await workflowRow(id);
    expect(wf.status).toBe("failed");
    expect(wf.error).toContain("outcome of charge_payment is unknown");
    expect((await stepOf(id, "charge_payment")).outcome_unknown).toBe(true);
    expect(provider().totals.activeReservations).toBe(0); // stock was still released
  });
});
