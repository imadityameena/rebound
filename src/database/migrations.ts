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
];
