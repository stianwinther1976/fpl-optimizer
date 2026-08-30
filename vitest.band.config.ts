import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Runs the app's REAL scoring against the live FPL API, on a runner. The
// sandbox this repo is developed from cannot reach fantasy.premierleague.com,
// and reimplementing `liveEntryScore` in a probe script is how a probe ends up
// proving its own arithmetic against itself — so the code under test is
// imported, not copied.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["scripts/bandscore.test.ts"], environment: "node", testTimeout: 300000 },
});
