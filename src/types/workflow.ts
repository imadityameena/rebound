import type { RetryPolicy } from "../workflow/retry";

export type WorkflowStatus = "pending" | "running" | "completed" | "failed";
export type StepStatus = "pending" | "running" | "retry_scheduled" | "succeeded" | "failed";

export interface WorkflowRow {
  id: string;
  type: string;
  status: WorkflowStatus;
  input: unknown;
  error: string | null;
  idempotency_key: string | null;
  request_hash: string | null;
  locked_by: string | null;
  lease_expires_at: Date | null;
  next_run_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface StepRow {
  workflow_id: string;
  step_index: number;
  name: string;
  status: StepStatus;
  attempts: number;
  output: Record<string, unknown> | null;
  error: string | null;
  started_at: Date | null;
  completed_at: Date | null;
}

/** What a step can see: the workflow input and the outputs of earlier steps. */
export interface StepContext<TInput> {
  workflowId: string;
  /**
   * Stable for this workflow + step: "<workflowId>:<stepName>". Sent to the
   * provider so that re-running the step (after a crash or a retry) replays
   * the first result instead of repeating the side effect.
   */
  idempotencyKey: string;
  /** Per-call timeout for this step. */
  timeoutMs: number;
  input: TInput;
  results: Record<string, Record<string, unknown>>;
}

export interface StepDefinition<TInput> {
  name: string;
  /** Overrides the default retry policy for this step. */
  retry?: Partial<RetryPolicy>;
  execute: (ctx: StepContext<TInput>) => Promise<Record<string, unknown>>;
}

export interface WorkflowDefinition<TInput> {
  type: string;
  steps: StepDefinition<TInput>[];
}
