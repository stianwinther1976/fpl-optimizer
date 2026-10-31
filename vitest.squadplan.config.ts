import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Runs the SHIPPED optimizer against one entry on the live FPL API from a
// runner, so the app's own recommendation can be read without a phone. The
// sandbox cannot reach fantasy.premierleague.com; a runner can.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["scripts/squadplan.test.ts"], environment: "node", testTimeout: 1800000 },
});
