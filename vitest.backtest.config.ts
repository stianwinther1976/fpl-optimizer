import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/backtest.test.ts"],
    testTimeout: 600_000,
  },
});
