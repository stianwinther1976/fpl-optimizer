import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["scripts/simulate.test.ts"], testTimeout: 900000 } });
