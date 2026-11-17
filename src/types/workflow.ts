import type { RetryPolicy } from "../workflow/retry";

export type WorkflowStatus = "pending" | "running" | "completed" | "compensating" | "compensated" | "failed";
export type CompensationStatus = "pending" | "running" | "retry_scheduled" | "succeeded" | "failed";
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
  compensation_status: CompensationStatus | null;
  compensation_attempts: number;
  compensation_error: string | null;
  outcome_unknown: boolean;
}

export interface WorkflowEventRow {
  id: string;
  workflow_id: string;
  at: Date;
  type: string;
  step_index: number | null;
  step_name: string | null;
  detail: Record<string, unknown> | null;
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
  /**
   * Undoes this step after a later step fails for good. Receives what
   * `execute` returned (e.g. the chargeId to refund). Must be safe to run more
   * than once. Steps without it (e.g. sending an email) are not undone.
   */
  compensate?: (ctx: StepContext<TInput> & { output: Record<string, unknown> }) => Promise<void>;
}

export interface WorkflowDefinition<TInput> {
  type: string;
  steps: StepDefinition<TInput>[];
}
