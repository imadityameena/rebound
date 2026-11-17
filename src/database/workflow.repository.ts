import { randomUUID } from "node:crypto";
import { pool } from "./pool";
import type { CompensationStatus, StepRow, WorkflowRow, WorkflowStatus } from "../types/workflow";

/** All SQL for workflows and steps lives here, so the engine reads like the state machine it is. */

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

// Appended to step/workflow updates: "...only if this worker still holds the lease".
const HOLDS_LEASE = `EXISTS (SELECT 1 FROM workflows w WHERE w.id = $1 AND w.locked_by = $2)`;

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
  const client = await pool.connect();
  try {
    // One transaction: never a workflow without its steps, or steps without a workflow.
    await client.query("BEGIN");
    const { rows } = await client.query<WorkflowRow>(
      `INSERT INTO workflows (id, type, status, input, idempotency_key, request_hash)
       VALUES ($1, $2, 'pending', $3, $4, $5)
       ON CONFLICT (type, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING *`,
      [randomUUID(), type, JSON.stringify(input), idempotencyKey, requestHash],
    );

    if (rows.length === 0) {
      // Same key seen before. If the first insert was still in flight, Postgres
      // waited for it to commit, so this SELECT sees it.
      await client.query("ROLLBACK");
      const existing = await pool.query<WorkflowRow>(
        `SELECT * FROM workflows WHERE type = $1 AND idempotency_key = $2`,
        [type, idempotencyKey],
      );
      return { workflow: existing.rows[0], created: false };
    }

    const workflow = rows[0];
    for (const [index, name] of stepNames.entries()) {
      await client.query(
        `INSERT INTO workflow_steps (workflow_id, step_index, name, status) VALUES ($1, $2, $3, 'pending')`,
        [workflow.id, index, name],
      );
    }
    await client.query("COMMIT");
    return { workflow, created: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
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

// ---------- Leases ----------

/**
 * Atomically picks one runnable workflow and takes the lease on it.
 * Runnable = unfinished, due, and not leased by a live worker.
 * FOR UPDATE SKIP LOCKED lets many workers run this at once without ever
 * picking the same row.
 */
export async function claimNextWorkflow(workerId: string, leaseMs: number): Promise<WorkflowRow | undefined> {
  const { rows } = await pool.query<WorkflowRow>(
    `UPDATE workflows
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
      RETURNING *`,
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
    `UPDATE workflows SET locked_by = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE locked_by = $1 AND status IN ('pending', 'running', 'compensating')
      RETURNING *`,
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

async function fencedUpdate(sql: string, params: unknown[], workflowId: string, workerId: string) {
  const { rowCount } = await pool.query(sql, params);
  if (rowCount === 0) throw new LeaseLostError(workflowId, workerId);
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
    workflowId,
    workerId,
  );
}

/** Written BEFORE the external call. */
export async function markStepRunning(workflowId: string, workerId: string, stepIndex: number) {
  await fencedUpdate(
    `UPDATE workflow_steps
        SET status = 'running', attempts = attempts + 1, started_at = now(), error = NULL
      WHERE workflow_id = $1 AND step_index = $3 AND ${HOLDS_LEASE}`,
    [workflowId, workerId, stepIndex],
    workflowId,
    workerId,
  );
}

/** Written AFTER the external call returned successfully. */
export async function markStepSucceeded(workflowId: string, workerId: string, stepIndex: number, output: unknown) {
  await fencedUpdate(
    `UPDATE workflow_steps
        SET status = 'succeeded', output = $4, completed_at = now()
      WHERE workflow_id = $1 AND step_index = $3 AND ${HOLDS_LEASE}`,
    [workflowId, workerId, stepIndex, JSON.stringify(output)],
    workflowId,
    workerId,
  );
}

/** A transient failure: record it and leave the step waiting for its next attempt. */
export async function markStepRetryScheduled(workflowId: string, workerId: string, stepIndex: number, error: string) {
  await fencedUpdate(
    `UPDATE workflow_steps
        SET status = 'retry_scheduled', error = $4
      WHERE workflow_id = $1 AND step_index = $3 AND ${HOLDS_LEASE}`,
    [workflowId, workerId, stepIndex, error],
    workflowId,
    workerId,
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
    workflowId,
    workerId,
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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
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
    await client.query(
      `UPDATE workflow_steps SET compensation_status = 'pending'
        WHERE workflow_id = $1 AND step_index = ANY($2::int[]) AND status = 'succeeded'`,
      [workflowId, compensateStepIndexes],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Updates a step's undo progress. `countAttempt` is set when an undo attempt starts. */
export async function setCompensationStatus(
  workflowId: string,
  workerId: string,
  stepIndex: number,
  status: CompensationStatus,
  error: string | null = null,
  countAttempt = false,
) {
  await fencedUpdate(
    `UPDATE workflow_steps
        SET compensation_status = $4,
            compensation_error = $5,
            compensation_attempts = compensation_attempts + $6
      WHERE workflow_id = $1 AND step_index = $3 AND ${HOLDS_LEASE}`,
    [workflowId, workerId, stepIndex, status, error, countAttempt ? 1 : 0],
    workflowId,
    workerId,
  );
}
