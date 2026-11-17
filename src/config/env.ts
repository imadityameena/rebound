import "dotenv/config";
import { hostname } from "node:os";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  fakesUrl: process.env.FAKES_URL ?? "http://localhost:4000",
  worker: {
    // A restarted worker with the same ID reclaims its own unfinished workflows
    // immediately. Give each worker process a unique ID when running several.
    id: process.env.WORKER_ID ?? `worker-${hostname()}`,
    leaseMs: Number(process.env.WORKER_LEASE_MS ?? 10_000),
    pollMs: Number(process.env.WORKER_POLL_MS ?? 250),
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4),
  },
  /** Defaults for every step; a step definition can override any of them. */
  retry: {
    maxAttempts: Number(process.env.RETRY_MAX_ATTEMPTS ?? 5),
    baseDelayMs: Number(process.env.RETRY_BASE_DELAY_MS ?? 200),
    maxDelayMs: Number(process.env.RETRY_MAX_DELAY_MS ?? 10_000),
    timeoutMs: Number(process.env.STEP_TIMEOUT_MS ?? 3_000),
  },
  db: {
    host: required("DB_HOST"),
    port: Number(required("DB_PORT")),
    user: required("DB_USER"),
    password: required("DB_PASSWORD"),
    database: required("DB_NAME"),
  },
};
