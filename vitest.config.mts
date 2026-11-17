import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    // All test files share one database, so run them one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      DB_NAME: "rebound_test",
      FAKES_URL: "http://localhost:4100",
      WORKER_ID: "test-worker",
      WORKFLOW_LOGS: "off",
      // Fast, small numbers so failure scenarios finish in milliseconds.
      STEP_TIMEOUT_MS: "200",
      RETRY_MAX_ATTEMPTS: "4",
      RETRY_BASE_DELAY_MS: "1",
      RETRY_MAX_DELAY_MS: "5",
    },
  },
});
