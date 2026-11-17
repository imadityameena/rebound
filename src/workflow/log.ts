export const log = (workflowId: string, msg: string) => console.log(`[wf ${workflowId.slice(0, 8)}] ${msg}`);
