import { randomUUID } from "node:crypto";
import { pool } from "./pool";
import type { StepRow, WorkflowRow } from "../types/workflow";

/** All SQL for workflows and steps lives here, so the engine reads like the state machine it is. */

export async function createWorkflow(type: string, input: unknown, stepNames: string[]): Promise<WorkflowRow> {
  const client = await pool.connect();
  try {
    // One transaction: never a workflow without its steps, or steps without a workflow.
    await client.query("BEGIN");
    const { rows } = await client.query<WorkflowRow>(
      `INSERT INTO workflows (id, type, status, input) VALUES ($1, $2, 'pending', $3) RETURNING *`,
      [randomUUID(), type, JSON.stringify(input)],
    );
    const workflow = rows[0];
    for (const [index, name] of stepNames.entries()) {
      await client.query(
        `INSERT INTO workflow_steps (workflow_id, step_index, name, status) VALUES ($1, $2, $3, 'pending')`,
        [workflow.id, index, name],
      );
    }
    await client.query("COMMIT");
    return workflow;
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

export async function setWorkflowStatus(id: string, status: WorkflowRow["status"], error: string | null = null) {
  await pool.query(`UPDATE workflows SET status = $2, error = $3, updated_at = now() WHERE id = $1`, [id, status, error]);
}

/** Written BEFORE the external call. */
export async function markStepRunning(workflowId: string, stepIndex: number) {
  await pool.query(
    `UPDATE workflow_steps
        SET status = 'running', attempts = attempts + 1, started_at = now(), error = NULL
      WHERE workflow_id = $1 AND step_index = $2`,
    [workflowId, stepIndex],
  );
}

/** Written AFTER the external call returned successfully. */
export async function markStepSucceeded(workflowId: string, stepIndex: number, output: unknown) {
  await pool.query(
    `UPDATE workflow_steps
        SET status = 'succeeded', output = $3, completed_at = now()
      WHERE workflow_id = $1 AND step_index = $2`,
    [workflowId, stepIndex, JSON.stringify(output)],
  );
}

export async function markStepFailed(workflowId: string, stepIndex: number, error: string) {
  await pool.query(
    `UPDATE workflow_steps
        SET status = 'failed', error = $3, completed_at = now()
      WHERE workflow_id = $1 AND step_index = $2`,
    [workflowId, stepIndex, error],
  );
}
