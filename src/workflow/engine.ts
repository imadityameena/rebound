import type { WorkflowDefinition } from "../types/workflow";
import * as repo from "../database/workflow.repository";
import { executeWorkflow } from "./executor";
import { orderWorkflow } from "./order-workflow";

/** Every workflow type the engine knows how to run, looked up by the `type` column. */
const definitions = new Map<string, WorkflowDefinition<any>>([[orderWorkflow.type, orderWorkflow]]);

export function getDefinition(type: string): WorkflowDefinition<unknown> {
  const definition = definitions.get(type);
  if (!definition) throw new Error(`Unknown workflow type: ${type}`);
  return definition;
}

/** Saves a new workflow and all its steps as 'pending'. Nothing external happens yet. */
export async function createWorkflow<TInput>(definition: WorkflowDefinition<TInput>, input: TInput) {
  return repo.createWorkflow(definition.type, input, definition.steps.map((s) => s.name));
}

export async function runWorkflow(workflowId: string) {
  const workflow = await repo.getWorkflow(workflowId);
  if (!workflow) throw new Error(`Workflow ${workflowId} not found`);
  await executeWorkflow(getDefinition(workflow.type), workflowId);
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
    })),
  };
}
