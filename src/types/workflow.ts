export type WorkflowStatus = "pending" | "running" | "completed" | "failed";
export type StepStatus = "pending" | "running" | "succeeded" | "failed";

export interface WorkflowRow {
  id: string;
  type: string;
  status: WorkflowStatus;
  input: unknown;
  error: string | null;
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
  input: TInput;
  results: Record<string, Record<string, unknown>>;
}

export interface StepDefinition<TInput> {
  name: string;
  execute: (ctx: StepContext<TInput>) => Promise<Record<string, unknown>>;
}

export interface WorkflowDefinition<TInput> {
  type: string;
  steps: StepDefinition<TInput>[];
}
