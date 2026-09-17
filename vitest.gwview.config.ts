import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Runs the SHIPPED projection against the live FPL API on a runner, so the
// app's own answer for a gameweek can be read and compared with what the press
// is saying. The sandbox cannot reach fantasy.premierleague.com; a runner can.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["scripts/gwview.test.ts"], environment: "node", testTimeout: 900000 },
});
