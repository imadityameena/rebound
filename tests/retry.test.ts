import { describe, expect, it } from "vitest";
import { backoffDelay, decideRetry, type RetryPolicy } from "../src/workflow/retry";
import { ServiceError } from "../src/services/provider-client";

const policy: RetryPolicy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000, timeoutMs: 1000 };

describe("backoffDelay", () => {
  it("doubles the cap on each attempt, up to maxDelayMs", () => {
    const top = () => 0.999999; // the largest delay jitter can produce
    expect([1, 2, 3, 4, 5, 6].map((a) => backoffDelay(a, policy, top))).toEqual([99, 199, 399, 799, 999, 999]);
  });

  it("jitters between 0 and the cap, so simultaneous failures spread out", () => {
    const delays = Array.from({ length: 1000 }, () => backoffDelay(4, policy));
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...delays)).toBeLessThan(800);
    // Not all the same: that's the point of jitter.
    expect(new Set(delays).size).toBeGreaterThan(100);
  });
});

describe("decideRetry", () => {
  const transient = new ServiceError("503", "transient", 503);
  const permanent = new ServiceError("422", "permanent", 422);

  it("retries transient failures while attempts remain", () => {
    expect(decideRetry(transient, 1, policy, () => 0.5)).toEqual({ retry: true, delayMs: 50 });
  });

  it("stops after maxAttempts", () => {
    expect(decideRetry(transient, 5, policy)).toEqual({ retry: false, reason: "exhausted" });
  });

  it("never retries permanent failures", () => {
    expect(decideRetry(permanent, 1, policy)).toEqual({ retry: false, reason: "permanent" });
  });

  it("treats unknown errors (bugs) as permanent", () => {
    expect(decideRetry(new TypeError("x is undefined"), 1, policy)).toEqual({ retry: false, reason: "permanent" });
  });
});
