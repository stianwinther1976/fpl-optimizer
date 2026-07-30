import { defineConfig } from "vitest/config";

// Pre-season minutes harness. Separate from `vitest.config.ts` because it reads
// the ../fpl-data archive, which is not present in CI, and takes minutes rather
// than seconds. See the header of scripts/preseasonBrier.test.ts.
export default defineConfig({
  test: { include: ["scripts/preseasonBrier.test.ts"], testTimeout: 900_000 },
});
