import type { StepContext, WorkflowDefinition } from "../types/workflow";
import * as repo from "../database/workflow.repository";

const log = (workflowId: string, msg: string) => console.log(`[wf ${workflowId.slice(0, 8)}] ${msg}`);

/**
 * Runs a workflow's remaining steps, saving state around every external call:
 *
 *   step pending ──markStepRunning──▶ running ──call──▶ succeeded / failed
 *
 * Steps that already succeeded are skipped, and their saved outputs are loaded
 * into the context. So this function can be called again for the same workflow
 * and it continues where it left off. Step 5 relies on that.
 */
export async function executeWorkflow<TInput>(definition: WorkflowDefinition<TInput>, workflowId: string) {
  const workflow = await repo.getWorkflow(workflowId);
  if (!workflow) throw new Error(`Workflow ${workflowId} not found`);
  if (workflow.status === "completed" || workflow.status === "failed") return;

  await repo.setWorkflowStatus(workflowId, "running");

  const ctx: StepContext<TInput> = { workflowId, input: workflow.input as TInput, results: {} };
  const steps = await repo.getSteps(workflowId);

  for (const [index, step] of definition.steps.entries()) {
    const saved = steps[index];
    if (saved.status === "succeeded") {
      ctx.results[step.name] = saved.output ?? {};
      continue;
    }

    await repo.markStepRunning(workflowId, index);
    log(workflowId, `${step.name}: started (attempt ${saved.attempts + 1})`);

    try {
      const output = await step.execute(ctx);
      await repo.markStepSucceeded(workflowId, index, output);
      ctx.results[step.name] = output;
      log(workflowId, `${step.name}: succeeded`);
    } catch (err) {
      const message = (err as Error).message;
      await repo.markStepFailed(workflowId, index, message);
      await repo.setWorkflowStatus(workflowId, "failed", `${step.name}: ${message}`);
      log(workflowId, `${step.name}: failed: ${message}`);
      return;
    }
  }

  await repo.setWorkflowStatus(workflowId, "completed");
  log(workflowId, "completed");
}
