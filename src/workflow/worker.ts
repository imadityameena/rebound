import * as repo from "../database/workflow.repository";
import type { WorkflowRow } from "../types/workflow";
import { getDefinition } from "./engine";
import { executeWorkflow, log } from "./executor";

export interface WorkerOptions {
  id: string;
  leaseMs: number;
  pollMs: number;
  concurrency: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls Postgres for runnable workflows and runs up to `concurrency` at once.
 *
 * The database is the queue: there is no separate message broker. A workflow
 * is "in the queue" when its row is unfinished, due, and has no live lease.
 */
export class Worker {
  private running = false;
  private inFlight = new Set<Promise<void>>();
  private loop?: Promise<void>;

  constructor(private readonly opts: WorkerOptions) {}

  get id() {
    return this.opts.id;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loop = this.pollLoop();
  }

  /** Stops claiming new work and waits for in-flight workflows to finish. */
  async stop() {
    this.running = false;
    await this.loop;
    await Promise.allSettled(this.inFlight);
  }

  private async pollLoop() {
    while (this.running) {
      if (this.inFlight.size >= this.opts.concurrency) {
        await Promise.race(this.inFlight);
        continue;
      }

      let workflow: WorkflowRow | undefined;
      try {
        workflow = await repo.claimNextWorkflow(this.opts.id, this.opts.leaseMs);
      } catch (err) {
        console.error(`[worker ${this.opts.id}] claim failed: ${(err as Error).message}`);
      }

      if (!workflow) {
        await sleep(this.opts.pollMs);
        continue;
      }

      const task = this.run(workflow).finally(() => this.inFlight.delete(task));
      this.inFlight.add(task);
    }
  }

  private async run(workflow: WorkflowRow) {
    // Keep the lease alive while we work. If renewal fails, another worker may
    // take over; our fenced writes will then be rejected.
    const heartbeat = setInterval(() => {
      repo.renewLease(workflow.id, this.opts.id, this.opts.leaseMs).then(
        (held) => !held && log(workflow.id, "lease lost"),
        (err) => log(workflow.id, `lease renewal failed: ${(err as Error).message}`),
      );
    }, this.opts.leaseMs / 3);

    try {
      await executeWorkflow(getDefinition(workflow.type), workflow, this.opts.id);
    } catch (err) {
      // E.g. the database went away mid-run, or the lease was lost. We leave
      // the row as it is; once the lease expires the workflow is picked up again.
      log(workflow.id, `execution interrupted: ${(err as Error).message}`);
    } finally {
      clearInterval(heartbeat);
    }
  }
}
