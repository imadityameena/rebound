import { createHash } from "node:crypto";
import type { WorkflowDefinition } from "../types/workflow";
import * as repo from "../database/workflow.repository";
import { orderWorkflow } from "./order-workflow";

/** Every workflow type the engine knows how to run, looked up by the `type` column. */
const definitions = new Map<string, WorkflowDefinition<any>>([[orderWorkflow.type, orderWorkflow]]);

export function getDefinition(type: string): WorkflowDefinition<unknown> {
  const definition = definitions.get(type);
  if (!definition) throw new Error(`Unknown workflow type: ${type}`);
  return definition;
}

export class IdempotencyConflictError extends Error {
  constructor(readonly existingWorkflowId: string) {
    super("This Idempotency-Key was already used with a different request body");
    this.name = "IdempotencyConflictError";
  }
}

/**
 * Saves a new workflow and all its steps as 'pending'. Nothing external happens
 * here: a worker picks it up from the database and runs it.
 *
 * With an idempotency key, a repeated request returns the original workflow
 * (`created: false`) instead of starting a second one.
 */
export async function createWorkflow<TInput>(
  definition: WorkflowDefinition<TInput>,
  input: TInput,
  idempotencyKey?: string,
) {
  const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const result = await repo.createWorkflow({
    type: definition.type,
    input,
    stepNames: definition.steps.map((s) => s.name),
    idempotencyKey,
    requestHash,
  });
  if (!result.created && result.workflow.request_hash !== requestHash) {
    throw new IdempotencyConflictError(result.workflow.id);
  }
  return result;
}

/** Every recorded state change for one workflow, oldest first. */
export async function workflowHistory(workflowId: string) {
  const workflow = await repo.getWorkflow(workflowId);
  if (!workflow) return undefined;
  const events = await repo.getEvents(workflowId);
  return {
    id: workflow.id,
    status: workflow.status,
    events: events.map((e) => ({
      at: e.at,
      type: e.type,
      step: e.step_name,
      ...(e.detail ? { detail: e.detail } : {}),
    })),
  };
}

/** Workflow + steps, shaped for API responses. */
export async function describeWorkflow(workflowId: string) {
  const workflow = await repo.getWorkflow(workflowId);
  if (!workflow) return undefined;
  const steps = await repo.getSteps(workflowId);
  return {
    id: workflow.id,
    type: workflow.type,
    status: workflow.status,
    input: workflow.input,
    error: workflow.error,
    createdAt: workflow.created_at,
    updatedAt: workflow.updated_at,
    steps: steps.map((s) => ({
      name: s.name,
      status: s.status,
      attempts: s.attempts,
      output: s.output,
      error: s.error,
      startedAt: s.started_at,
      completedAt: s.completed_at,
      outcomeUnknown: s.outcome_unknown,
      compensation: s.compensation_status
        ? { status: s.compensation_status, attempts: s.compensation_attempts, error: s.compensation_error }
        : null,
    })),
  };
}
