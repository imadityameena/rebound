import type { Request, Response, NextFunction } from "express";

export type FakeServiceName = "inventory" | "payment" | "email";
export const FAKE_SERVICES: FakeServiceName[] = ["inventory", "payment", "email"];

/**
 * How a fake service should misbehave. Rates are probabilities from 0 to 1.
 * A rate of 1 makes the fault deterministic, which is what the tests use.
 */
export interface FaultConfig {
  /** Extra delay before every response. */
  latencyMs: number;
  /** Chance of a transient failure (HTTP 503). Retrying may succeed. */
  failureRate: number;
  /** Chance of a permanent failure (HTTP 422). Retrying never helps. */
  rejectRate: number;
  /** Chance of never responding at all. Only a client timeout ends the call. */
  hangRate: number;
  /**
   * Chance of performing the operation and then dropping the connection
   * before replying. The caller cannot tell whether the operation happened.
   */
  dropResponseRate: number;
  /** Fail exactly the next N calls with 503, then behave normally. */
  failNext: number;
}

const NO_FAULTS: FaultConfig = {
  latencyMs: 0,
  failureRate: 0,
  rejectRate: 0,
  hangRate: 0,
  dropResponseRate: 0,
  failNext: 0,
};

export class FaultRegistry {
  private configs = new Map<FakeServiceName, FaultConfig>();

  constructor(initial: Partial<Record<FakeServiceName, Partial<FaultConfig>>> = {}) {
    this.reset();
    for (const service of FAKE_SERVICES) {
      if (initial[service]) this.update(service, initial[service]);
    }
  }

  get(service: FakeServiceName): FaultConfig {
    return this.configs.get(service)!;
  }

  update(service: FakeServiceName, changes: Partial<FaultConfig>): FaultConfig {
    const next = { ...this.get(service), ...pickNumbers(changes) };
    this.configs.set(service, next);
    return next;
  }

  reset(): void {
    for (const service of FAKE_SERVICES) this.configs.set(service, { ...NO_FAULTS });
  }

  all(): Record<FakeServiceName, FaultConfig> {
    return Object.fromEntries(this.configs) as Record<FakeServiceName, FaultConfig>;
  }
}

function pickNumbers(changes: Partial<FaultConfig>): Partial<FaultConfig> {
  const out: Partial<FaultConfig> = {};
  for (const key of Object.keys(NO_FAULTS) as (keyof FaultConfig)[]) {
    const value = changes[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
      throw new Error(`Fault "${key}" must be a non-negative number`);
    }
    out[key] = value;
  }
  return out;
}

/** Reads initial faults from env, e.g. FAKE_PAYMENT_FAILURE_RATE=0.3 */
export function faultsFromEnv(env: NodeJS.ProcessEnv): Partial<Record<FakeServiceName, Partial<FaultConfig>>> {
  const fields: Record<string, keyof FaultConfig> = {
    LATENCY_MS: "latencyMs",
    FAILURE_RATE: "failureRate",
    REJECT_RATE: "rejectRate",
    HANG_RATE: "hangRate",
    DROP_RESPONSE_RATE: "dropResponseRate",
  };
  const result: Partial<Record<FakeServiceName, Partial<FaultConfig>>> = {};
  for (const service of FAKE_SERVICES) {
    for (const [suffix, field] of Object.entries(fields)) {
      const raw = env[`FAKE_${service.toUpperCase()}_${suffix}`];
      if (raw === undefined || raw === "") continue;
      (result[service] ??= {})[field] = Number(raw);
    }
  }
  return result;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Express middleware that applies the configured faults before the real handler runs.
 * "dropResponseRate" is handled after the handler by `maybeDropResponse`.
 */
export function injectFaults(registry: FaultRegistry, service: FakeServiceName) {
  return async (_req: Request, res: Response, next: NextFunction) => {
    const faults = registry.get(service);

    if (faults.latencyMs > 0) await sleep(faults.latencyMs);

    if (Math.random() < faults.hangRate) {
      // Never call next() or send anything: the request just hangs.
      return;
    }

    if (faults.failNext > 0) {
      registry.update(service, { failNext: faults.failNext - 1 });
      res.status(503).json({ error: "service_unavailable", detail: "injected (failNext)" });
      return;
    }

    if (Math.random() < faults.failureRate) {
      res.status(503).json({ error: "service_unavailable", detail: "injected transient failure" });
      return;
    }

    if (Math.random() < faults.rejectRate) {
      res.status(422).json({ error: "rejected", detail: "injected permanent failure" });
      return;
    }

    next();
  };
}

/**
 * Call after the side effect has been applied. Returns true if the response was
 * dropped, in which case the handler must not send anything.
 */
export function maybeDropResponse(registry: FaultRegistry, service: FakeServiceName, res: Response): boolean {
  if (Math.random() < registry.get(service).dropResponseRate) {
    res.socket?.destroy();
    return true;
  }
  return false;
}
