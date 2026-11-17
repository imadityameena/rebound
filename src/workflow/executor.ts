import type { StepContext, WorkflowDefinition, WorkflowRow } from "../types/workflow";
import * as repo from "../database/workflow.repository";

export const log = (workflowId: string, msg: string) => console.log(`[wf ${workflowId.slice(0, 8)}] ${msg}`);

/**
 * Runs a workflow's remaining steps. The caller (the worker) must already hold
 * the lease. Every write is fenced on that lease.
 *
 *   step pending ──markStepRunning──▶ running ──call──▶ succeeded / failed
 *
 * Steps that already succeeded are skipped, and their saved outputs are loaded
 * back into the context. A step left 'running' by a crash is executed again:
 * we cannot know whether the earlier call took effect. Step 6 makes that safe.
 */
export async function executeWorkflow<TInput>(
  definition: WorkflowDefinition<TInput>,
  workflow: WorkflowRow,
  workerId: string,
) {
  const id = workflow.id;
  const ctx: StepContext<TInput> = { workflowId: id, input: workflow.input as TInput, results: {} };
  const steps = await repo.getSteps(id);

  for (const [index, step] of definition.steps.entries()) {
    const saved = steps[index];
    if (saved.status === "succeeded") {
      ctx.results[step.name] = saved.output ?? {};
      continue;
    }

    if (saved.status === "running") {
      log(id, `${step.name}: was in progress when the previous run stopped; outcome unknown, running it again`);
    }
    await repo.markStepRunning(id, workerId, index);
    log(id, `${step.name}: started (attempt ${saved.attempts + 1})`);

    let output: Record<string, unknown>;
    try {
      output = await step.execute(ctx);
    } catch (err) {
      const message = (err as Error).message;
      await repo.markStepFailed(id, workerId, index, message);
      await repo.finishWorkflow(id, workerId, "failed", `${step.name}: ${message}`);
      log(id, `${step.name}: failed: ${message}`);
      return;
    }

    await repo.markStepSucceeded(id, workerId, index, output);
    ctx.results[step.name] = output;
    log(id, `${step.name}: succeeded`);
  }

  await repo.finishWorkflow(id, workerId, "completed");
  log(id, "completed");
}
