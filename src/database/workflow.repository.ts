import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "./pool";
import type { CompensationStatus, StepRow, WorkflowEventRow, WorkflowRow, WorkflowStatus } from "../types/workflow";

/**
 * All SQL for workflows, steps and their history lives here, so the engine
 * reads like the state machine it is.
 *
 * Every state change also appends a row to workflow_events, in the SAME
 * statement or transaction as the change. A crash can never leave a change
 * without its history entry, or a history entry for a change that didn't happen.
 */

/**
 * Thrown when a worker tries to write to a workflow it no longer holds the
 * lease on, for example after a long pause let the lease expire and another
 * worker took over. The write is rejected, so two workers can never both
 * record results for the same workflow.
 */
export class LeaseLostError extends Error {
  constructor(workflowId: string, workerId: string) {
    super(`Worker ${workerId} no longer holds the lease on workflow ${workflowId}`);
    this.name = "LeaseLostError";
  }
}

export interface EventInput {
  type: string;
  stepIndex?: number | null;
  detail?: Record<string, unknown> | null;
}

// Appended to step updates: "...only if this worker still holds the lease".
const HOLDS_LEASE = `EXISTS (SELECT 1 FROM workflows w WHERE w.id = $1 AND w.locked_by = $2)`;

async function insertEvent(client: PoolClient, workflowId: string, event: EventInput) {
  await client.query(
    `INSERT INTO workflow_events (workflow_id, type, step_index, detail) VALUES ($1, $2, $3, $4)`,
    [workflowId, event.type, event.stepIndex ?? null, event.detail ? JSON.stringify(event.detail) : null],
  );
}

async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------- Creating and reading ----------

export interface CreateWorkflowParams {
  type: string;
  input: unknown;
  stepNames: string[];
  idempotencyKey?: string;
  requestHash?: string;
}

/**
 * Inserts a workflow and its steps, or returns the existing workflow if one
 * with the same (type, idempotency key) already exists.
 */
export async function createWorkflow(params: CreateWorkflowParams): Promise<{ workflow: WorkflowRow; created: boolean }> {
  const { type, input, stepNames, idempotencyKey = null, requestHash = null } = params;

  // One transaction: never a workflow without its steps, or steps without a workflow.
  const workflow = await inTransaction(async (client) => {
    const { rows } = await client.query<WorkflowRow>(
      `INSERT INTO workflows (id, type, status, input, idempotency_key, request_hash)
       VALUES ($1, $2, 'pending', $3, $4, $5)
       ON CONFLICT (type, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING *`,
      [randomUUID(), type, JSON.stringify(input), idempotencyKey, requestHash],
    );
    if (rows.length === 0) return undefined;

    const created = rows[0];
    for (const [index, name] of stepNames.entries()) {
      await client.query(
        `INSERT INTO workflow_steps (workflow_id, step_index, name, status) VALUES ($1, $2, $3, 'pending')`,
        [created.id, index, name],
      );
    }
    await insertEvent(client, created.id, { type: "workflow_created", detail: { idempotencyKey } });
    return created;
  });

  if (workflow) return { workflow, created: true };

  // Same key seen before. If the first insert was still in flight, Postgres
  // waited for it to commit, so this SELECT sees it.
  const existing = await pool.query<WorkflowRow>(`SELECT * FROM workflows WHERE type = $1 AND idempotency_key = $2`, [
    type,
    idempotencyKey,
  ]);
  return { workflow: existing.rows[0], created: false };
}

export async function getWorkflow(id: string): Promise<WorkflowRow | undefined> {
  const { rows } = await pool.query<WorkflowRow>(`SELECT * FROM workflows WHERE id = $1`, [id]);
  return rows[0];
}

export async function getSteps(workflowId: string): Promise<StepRow[]> {
  const { rows } = await pool.query<StepRow>(
    `SELECT * FROM workflow_steps WHERE workflow_id = $1 ORDER BY step_index`,
    [workflowId],
  );
  return rows;
}

/** The full history, oldest first, with step names filled in. */
export async function getEvents(workflowId: string): Promise<WorkflowEventRow[]> {
  const { rows } = await pool.query<WorkflowEventRow>(
    `SELECT e.id, e.workflow_id, e.at, e.type, e.step_index, s.name AS step_name, e.detail
       FROM workflow_events e
       LEFT JOIN workflow_steps s ON s.workflow_id = e.workflow_id AND s.step_index = e.step_index
      WHERE e.workflow_id = $1
      ORDER BY e.id`,
    [workflowId],
  );
  return rows;
}

// ---------- Leases ----------

/**
 * Atomically picks one runnable workflow and takes the lease on it.
 * Runnable = unfinished, due, and not leased by a live worker.
 * FOR UPDATE SKIP LOCKED lets many workers run this at once without ever
 * picking the same row.
 */
export async function claimNextWorkflow(workerId: string, leaseMs: number): Promise<WorkflowRow | undefined> {
  const { rows } = await pool.query<WorkflowRow>(
    `WITH claimed AS (
       UPDATE workflows
          -- A pending workflow starts running; a compensating one keeps compensating.
          SET status = CASE WHEN status = 'pending' THEN 'running' ELSE status END,
              locked_by = $1,
              lease_expires_at = now() + make_interval(secs => $2 / 1000.0),
              updated_at = now()
        WHERE id = (
          SELECT id FROM workflows
           WHERE status IN ('pending', 'running', 'compensating')
             AND next_run_at <= now()
             AND (lease_expires_at IS NULL OR lease_expires_at < now())
           ORDER BY next_run_at, created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
        RETURNING *
     ), event AS (
       INSERT INTO workflow_events (workflow_id, type, detail)
       SELECT id, 'claimed', jsonb_build_object('worker', $1::text) FROM claimed
     )
     SELECT * FROM claimed`,
    [workerId, leaseMs],
  );
  return rows[0];
}

/** Extends the lease. Returns false if this worker has lost it. */
export async function renewLease(workflowId: string, workerId: string, leaseMs: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE workflows
        SET lease_expires_at = now() + make_interval(secs => $3 / 1000.0)
      WHERE id = $1 AND locked_by = $2`,
    [workflowId, workerId, leaseMs],
  );
  return rowCount === 1;
}

/**
 * Releases every lease this worker ID holds. Only safe at startup: if a worker
 * with our ID held leases, it was a previous run of this same process, which
 * is now dead.
 */
export async function releaseLeasesHeldBy(workerId: string): Promise<WorkflowRow[]> {
  const { rows } = await pool.query<WorkflowRow>(
    `WITH released AS (
       UPDATE workflows SET locked_by = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE locked_by = $1 AND status IN ('pending', 'running', 'compensating')
        RETURNING *
     ), event AS (
       INSERT INTO workflow_events (workflow_id, type, detail)
       SELECT id, 'recovered_after_restart', jsonb_build_object('worker', $1::text) FROM released
     )
     SELECT * FROM released`,
    [workerId],
  );
  return rows;
}

export async function listUnfinished(): Promise<(WorkflowRow & { current_step: string | null })[]> {
  const { rows } = await pool.query(
    `SELECT w.*,
            (SELECT s.name || ' (' || s.status || ')' FROM workflow_steps s
              WHERE s.workflow_id = w.id AND s.status <> 'succeeded'
              ORDER BY s.step_index LIMIT 1) AS current_step
       FROM workflows w
      WHERE w.status IN ('pending', 'running', 'compensating')
      ORDER BY w.created_at`,
  );
  return rows;
}

// ---------- Writes made while holding the lease ----------

/**
 * Runs an UPDATE (whose first two params are workflowId and workerId) and,
 * in the same statement, appends its event. 0 rows updated means we no longer
 * hold the lease.
 */
async function fencedUpdate(updateSql: string, params: unknown[], event: EventInput) {
  const n = params.length;
  const { rowCount } = await pool.query(
    `WITH updated AS (${updateSql} RETURNING 1)
     INSERT INTO workflow_events (workflow_id, type, step_index, detail)
     SELECT $1, $${n + 1}, $${n + 2}::int, $${n + 3}::jsonb FROM updated`,
    [...params, event.type, event.stepIndex ?? null, event.detail ? JSON.stringify(event.detail) : null],
  );
  if (rowCount === 0) throw new LeaseLostError(String(params[0]), String(params[1]));
}

/** Sets a final status and gives up the lease. */
export async function finishWorkflow(
  workflowId: string,
  workerId: string,
  status: Extract<WorkflowStatus, "completed" | "compensated" | "failed">,
  error: string | null = null,
) {
  await fencedUpdate(
    `UPDATE workflows
        SET status = $3, error = $4, locked_by = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE id = $1 AND locked_by = $2`,
    [workflowId, workerId, status, error],
    { type: `workflow_${status}`, detail: error ? { error } : null },
  );
}

/** Written BEFORE the external call. */
export async function markStepRunning(workflowId: string, workerId: string, stepIndex: number, attempt: number) {
  await fencedUpdate(
    `UPDATE workflow_steps
        SET status = 'running', attempts = attempts + 1, started_at = now(), error = NULL
      WHERE workflow_id = $1 AND step_index = $3 AND ${HOLDS_LEASE}`,
    [workflowId, workerId, stepIndex],
    { type: "step_started", stepIndex, detail: { attempt } },
  );
}

/** Written AFTER the external call returned successfully. */
export async function markStepSucceeded(workflowId: string, workerId: string, stepIndex: number, output: unknown) {
  await fencedUpdate(
    `UPDATE workflow_steps
        SET status = 'succeeded', output = $4, completed_at = now()
      WHERE workflow_id = $1 AND step_index = $3 AND ${HOLDS_LEASE}`,
    [workflowId, workerId, stepIndex, JSON.stringify(output)],
    { type: "step_succeeded", stepIndex, detail: { output } },
  );
}

/** A transient failure: record it and leave the step waiting for its next attempt. */
export async function markStepRetryScheduled(
  workflowId: string,
  workerId: string,
  stepIndex: number,
  error: string,
  delayMs: number,
) {
  await fencedUpdate(
    `UPDATE workflow_steps
        SET status = 'retry_scheduled', error = $4
      WHERE workflow_id = $1 AND step_index = $3 AND ${HOLDS_LEASE}`,
    [workflowId, workerId, stepIndex, error],
    { type: "step_retry_scheduled", stepIndex, detail: { error, delayMs } },
  );
}

/**
 * Gives up the lease and makes the workflow due again after `delayMs`.
 * The wait lives in the database, not in a sleeping process, so a crash
 * during the wait loses nothing and the worker slot is free meanwhile.
 */
export async function rescheduleWorkflow(workflowId: string, workerId: string, delayMs: number) {
  await fencedUpdate(
    `UPDATE workflows
        SET next_run_at = now() + make_interval(secs => $3 / 1000.0),
            locked_by = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE id = $1 AND locked_by = $2`,
    [workflowId, workerId, delayMs],
    { type: "released_until_retry", detail: { delayMs } },
  );
}

/**
 * A step failed for good. In ONE transaction: mark the step failed, switch the
 * workflow to 'compensating', and queue the undo of each earlier succeeded step.
 * If these were separate writes, a crash between them could leave a
 * compensating workflow with nothing queued to undo, and stock or money
 * would stay taken.
 */
export async function failStepAndBeginCompensation(params: {
  workflowId: string;
  workerId: string;
  stepIndex: number;
  error: string;
  outcomeUnknown: boolean;
  reason: string;
  compensateStepIndexes: number[];
}) {
  const { workflowId, workerId, stepIndex, error, outcomeUnknown, reason, compensateStepIndexes } = params;
  await inTransaction(async (client) => {
    const wf = await client.query(
      `UPDATE workflows SET status = 'compensating', error = $3, updated_at = now()
        WHERE id = $1 AND locked_by = $2`,
      [workflowId, workerId, reason],
    );
    if (wf.rowCount === 0) throw new LeaseLostError(workflowId, workerId);

    await client.query(
      `UPDATE workflow_steps SET status = 'failed', error = $3, outcome_unknown = $4, completed_at = now()
        WHERE workflow_id = $1 AND step_index = $2`,
      [workflowId, stepIndex, error, outcomeUnknown],
    );
    const queued = await client.query<{ step_index: number }>(
      `UPDATE workflow_steps SET compensation_status = 'pending'
        WHERE workflow_id = $1 AND step_index = ANY($2::int[]) AND status = 'succeeded'
        RETURNING step_index`,
      [workflowId, compensateStepIndexes],
    );

    await insertEvent(client, workflowId, { type: "step_failed", stepIndex, detail: { error, outcomeUnknown } });
    await insertEvent(client, workflowId, {
      type: "compensation_started",
      detail: { reason, undo: queued.rows.map((r) => r.step_index).sort((a, b) => b - a) },
    });
  });
}

const UNDO_EVENT: Record<CompensationStatus, string> = {
  pending: "undo_queued",
  running: "undo_started",
  retry_scheduled: "undo_retry_scheduled",
  succeeded: "undo_succeeded",
  failed: "undo_failed",
};

/** Updates a step's undo progress. `attempt` is passed when an undo attempt starts. */
export async function setCompensationStatus(
  workflowId: string,
  workerId: string,
  stepIndex: number,
  status: CompensationStatus,
  opts: { error?: string; attempt?: number; delayMs?: number } = {},
) {
  await fencedUpdate(
    `UPDATE workflow_steps
        SET compensation_status = $4,
            compensation_error = $5,
            compensation_attempts = compensation_attempts + $6
      WHERE workflow_id = $1 AND step_index = $3 AND ${HOLDS_LEASE}`,
    [workflowId, workerId, stepIndex, status, opts.error ?? null, status === "running" ? 1 : 0],
    { type: UNDO_EVENT[status], stepIndex, detail: Object.keys(opts).length ? opts : null },
  );
}
