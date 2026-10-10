import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 60000,
    // pg-boss/embedded-postgres tests spin up a real Postgres process; running
    // test files in parallel would mean multiple Postgres instances racing for
    // the same data directory / port defaults. Sequential is correct here, not
    // just safe.
    fileParallelism: false,
  },
});
