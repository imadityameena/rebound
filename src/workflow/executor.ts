import type { StepContext, WorkflowDefinition, WorkflowRow } from "../types/workflow";
import * as repo from "../database/workflow.repository";
import { config } from "../config/env";
import { ServiceError } from "../services/provider-client";
import { decideRetry, type RetryPolicy } from "./retry";
import { compensateWorkflow } from "./compensation";
import { log } from "./log";

export { log };

/**
 * Runs a workflow's remaining steps. The caller (the worker) must already hold
 * the lease. Every write is fenced on that lease.
 *
 *   pending ──▶ running ──▶ succeeded
 *                  │
 *                  ├── transient error, attempts left ──▶ retry_scheduled ──(after backoff)──▶ running
 *                  └── permanent error / out of attempts ──▶ failed ──▶ compensate earlier steps
 *
 * Steps that already succeeded are skipped, and their saved outputs are loaded
 * back into the context. A step left 'running' by a crash is executed again:
 * we cannot know whether the earlier call took effect, so the step is
 * repeated with the same idempotency key and the provider replays the result.
 *
 * A retry does not sleep here. The workflow is rescheduled in the database
 * and the lease released; a worker picks it up again once the delay has passed.
 */
export async function executeWorkflow<TInput>(
  definition: WorkflowDefinition<TInput>,
  workflow: WorkflowRow,
  workerId: string,
) {
  const id = workflow.id;
  if (workflow.status === "compensating") {
    return compensateWorkflow(definition, workflow, workerId);
  }

  const ctx: StepContext<TInput> = {
    workflowId: id,
    input: workflow.input as TInput,
    results: {},
    idempotencyKey: "",
    timeoutMs: config.retry.timeoutMs,
  };
  const steps = await repo.getSteps(id);

  for (const [index, step] of definition.steps.entries()) {
    const saved = steps[index];
    if (saved.status === "succeeded") {
      ctx.results[step.name] = saved.output ?? {};
      continue;
    }

    const policy: RetryPolicy = { ...config.retry, ...step.retry };
    const attempt = saved.attempts + 1;
    ctx.idempotencyKey = `${id}:${step.name}`;
    ctx.timeoutMs = policy.timeoutMs;

    if (saved.status === "running") {
      log(id, `${step.name}: was in progress when the previous run stopped; outcome unknown, repeating it with the same idempotency key`);
    }
    await repo.markStepRunning(id, workerId, index);
    log(id, `${step.name}: attempt ${attempt}/${policy.maxAttempts} started`);

    let output: Record<string, unknown>;
    try {
      output = await step.execute(ctx);
    } catch (err) {
      const message = (err as Error).message;
      const decision = decideRetry(err, attempt, policy);

      if (decision.retry) {
        await repo.markStepRetryScheduled(id, workerId, index, message);
        await repo.rescheduleWorkflow(id, workerId, decision.delayMs);
        log(id, `${step.name}: attempt ${attempt} failed (${message}); retrying in ${decision.delayMs}ms`);
        return;
      }

      const why = decision.reason === "exhausted" ? `gave up after ${attempt} attempts` : "permanent failure";
      const reason = `${step.name}: ${why}: ${message}`;
      log(id, `${reason}; undoing earlier steps`);
      await repo.failStepAndBeginCompensation({
        workflowId: id,
        workerId,
        stepIndex: index,
        error: message,
        outcomeUnknown: err instanceof ServiceError && err.outcomeUnknown,
        reason,
        compensateStepIndexes: definition.steps.slice(0, index).map((_, i) => i),
      });
      return compensateWorkflow(definition, { ...workflow, status: "compensating", error: reason }, workerId);
    }

    await repo.markStepSucceeded(id, workerId, index, output);
    ctx.results[step.name] = output;
    log(id, `${step.name}: succeeded on attempt ${attempt}`);
  }

  await repo.finishWorkflow(id, workerId, "completed");
  log(id, "completed");
}
