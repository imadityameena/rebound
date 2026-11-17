/**
 * Schema changes, applied in order and recorded in schema_migrations.
 * Never edit a migration that has already run; add a new one instead.
 */
export interface Migration {
  id: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: "001_workflows",
    sql: `
      CREATE TABLE workflows (
        id          uuid PRIMARY KEY,
        -- Which workflow definition to run, e.g. 'order'.
        type        text NOT NULL,
        status      text NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
        -- The original request, so the workflow can be rebuilt from the database alone.
        input       jsonb NOT NULL,
        error       text,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE workflow_steps (
        workflow_id   uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        -- Position in the workflow: 0 = reserve, 1 = charge, 2 = confirm.
        step_index    int  NOT NULL,
        name          text NOT NULL,
        -- 'running' means "we may have called the outside service". It is written
        -- BEFORE the call, so a crash leaves evidence of the uncertain call.
        status        text NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
        -- How many times execution of this step has started.
        attempts      int  NOT NULL DEFAULT 0,
        -- What the step returned, e.g. {"chargeId": "..."}. Later steps and
        -- compensation read it from here, not from memory.
        output        jsonb,
        error         text,
        started_at    timestamptz,
        completed_at  timestamptz,
        PRIMARY KEY (workflow_id, step_index),
        UNIQUE (workflow_id, name)
      );

      CREATE INDEX workflows_status_idx ON workflows (status);
    `,
  },
  {
    id: "002_worker_leases",
    sql: `
      -- Which worker is running this workflow, and until when its claim holds.
      -- A worker keeps extending lease_expires_at while it works. If it dies,
      -- the lease runs out and another worker may take over.
      ALTER TABLE workflows
        ADD COLUMN locked_by        text,
        ADD COLUMN lease_expires_at timestamptz,
        -- Earliest time a worker may pick this workflow up (used for retries in Step 7).
        ADD COLUMN next_run_at      timestamptz NOT NULL DEFAULT now();

      -- Makes "find the next runnable workflow" cheap, even with many finished rows.
      CREATE INDEX workflows_runnable_idx ON workflows (next_run_at)
        WHERE status IN ('pending', 'running');
    `,
  },
  {
    id: "003_request_idempotency",
    sql: `
      -- The client's Idempotency-Key for POST /orders, plus a hash of the request
      -- body, so a retry with the same key returns the same order instead of
      -- creating a second one, and a reused key with a different body is caught.
      ALTER TABLE workflows
        ADD COLUMN idempotency_key text,
        ADD COLUMN request_hash    text;

      -- The database, not application code, guarantees one workflow per key,
      -- even when two identical requests arrive at the same moment.
      CREATE UNIQUE INDEX workflows_idempotency_key_idx ON workflows (type, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `,
  },
  {
    id: "004_retry_scheduled",
    sql: `
      -- A step that failed transiently and is waiting for its next attempt.
      -- The wait itself is workflows.next_run_at, so it survives a crash.
      ALTER TABLE workflow_steps DROP CONSTRAINT workflow_steps_status_check;
      ALTER TABLE workflow_steps ADD CONSTRAINT workflow_steps_status_check
        CHECK (status IN ('pending', 'running', 'retry_scheduled', 'succeeded', 'failed'));
    `,
  },
];
