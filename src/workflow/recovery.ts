import * as repo from "../database/workflow.repository";

/**
 * Runs once at startup, before the worker starts polling.
 *
 * 1. Releases leases still held under our own worker ID. They belong to a
 *    previous run of this process that crashed, so nobody is working on them,
 *    and waiting for them to expire would only delay recovery.
 * 2. Logs every unfinished workflow and where it stopped.
 *
 * The worker then picks these workflows up like any other runnable work and
 * continues from the first step that has not succeeded.
 */
export async function recoverOnStartup(workerId: string) {
  const released = await repo.releaseLeasesHeldBy(workerId);
  const unfinished = await repo.listUnfinished();

  if (unfinished.length === 0) {
    console.log("[recovery] no unfinished workflows");
    return { released: released.length, unfinished: 0 };
  }

  console.log(
    `[recovery] ${unfinished.length} unfinished workflow(s); reclaimed ${released.length} lease(s) from a previous run of ${workerId}`,
  );
  for (const wf of unfinished) {
    console.log(`[recovery]   ${wf.id.slice(0, 8)} ${wf.status}, stopped at: ${wf.current_step ?? "start"}`);
  }
  return { released: released.length, unfinished: unfinished.length };
}
