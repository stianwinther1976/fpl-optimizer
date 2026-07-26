import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["scripts/ytcompare.test.ts"], testTimeout: 900000 } });
