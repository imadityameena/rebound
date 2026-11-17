import type { StepContext, WorkflowDefinition, WorkflowRow } from "../types/workflow";
import * as repo from "../database/workflow.repository";
import { config } from "../config/env";
import { decideRetry, type RetryPolicy } from "./retry";
import { log } from "./log";

/**
 * Undoing must eventually succeed, or a person has to step in, so it gets
 * more patience than a forward step.
 */
export const compensationPolicy = (): RetryPolicy => ({
  ...config.retry,
  maxAttempts: Math.max(10, config.retry.maxAttempts),
});

/**
 * Saga compensation: undo every step that succeeded, newest first.
 *
 * A database transaction can't roll back a payment provider, so each step
 * that has an outside effect also defines how to undo it (refund the charge,
 * release the stock). Each undo:
 *
 * - is tracked in `compensation_status`, so after a crash we resume and don't
 *   start over;
 * - sends its own stable idempotency key, "<workflowId>:<step>:compensate",
 *   so a repeated refund is replayed by the provider, not paid out twice;
 * - is retried with backoff like a forward step.
 *
 * Finishes the workflow as:
 * - 'compensated' when everything was undone;
 * - 'failed' when an undo gave up, or when the step that failed has an
 *   unknown outcome (e.g. the charge timed out every time, so it may have gone
 *   through and we have no chargeId to refund). Both need a person to look.
 */
export async function compensateWorkflow<TInput>(
  definition: WorkflowDefinition<TInput>,
  workflow: WorkflowRow,
  workerId: string,
) {
  const id = workflow.id;
  const steps = await repo.getSteps(id);
  const policy = compensationPolicy();

  for (let index = definition.steps.length - 1; index >= 0; index--) {
    const step = definition.steps[index];
    const saved = steps[index];
    const status = saved.compensation_status;
    if (!step.compensate || !status || status === "succeeded" || status === "failed") continue;

    const attempt = saved.compensation_attempts + 1;
    const ctx: StepContext<TInput> & { output: Record<string, unknown> } = {
      workflowId: id,
      input: workflow.input as TInput,
      results: {},
      output: saved.output ?? {},
      idempotencyKey: `${id}:${step.name}:compensate`,
      timeoutMs: policy.timeoutMs,
    };

    await repo.setCompensationStatus(id, workerId, index, "running", null, true);
    log(id, `${step.name}: undo attempt ${attempt}/${policy.maxAttempts} started`);

    try {
      await step.compensate(ctx);
    } catch (err) {
      const message = (err as Error).message;
      const decision = decideRetry(err, attempt, policy);
      if (decision.retry) {
        await repo.setCompensationStatus(id, workerId, index, "retry_scheduled", message);
        await repo.rescheduleWorkflow(id, workerId, decision.delayMs);
        log(id, `${step.name}: undo attempt ${attempt} failed (${message}); retrying in ${decision.delayMs}ms`);
        return;
      }
      await repo.setCompensationStatus(id, workerId, index, "failed", message);
      await repo.finishWorkflow(
        id,
        workerId,
        "failed",
        `${workflow.error ?? "workflow failed"}; undo of ${step.name} failed (${message}). Manual intervention required.`,
      );
      log(id, `${step.name}: undo FAILED: ${message}. Manual intervention required`);
      return;
    }

    await repo.setCompensationStatus(id, workerId, index, "succeeded");
    log(id, `${step.name}: undone`);
  }

  const failedStep = steps.find((s) => s.status === "failed");
  if (failedStep?.outcome_unknown) {
    await repo.finishWorkflow(
      id,
      workerId,
      "failed",
      `${workflow.error}; earlier steps were undone, but the outcome of ${failedStep.name} is unknown. Reconcile with the provider.`,
    );
    log(id, `compensation done, but ${failedStep.name} has an unknown outcome: needs reconciliation`);
    return;
  }

  await repo.finishWorkflow(id, workerId, "compensated", workflow.error);
  log(id, "compensated: all completed steps were undone");
}
