/** One log line per workflow event. Set WORKFLOW_LOGS=off to silence (the tests do). */
export const log = (workflowId: string, msg: string) => {
  if (process.env.WORKFLOW_LOGS === "off") return;
  console.log(`[wf ${workflowId.slice(0, 8)}] ${msg}`);
};
