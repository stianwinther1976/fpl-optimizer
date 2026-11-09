import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Measures what the Model-accuracy card's "average miss" could be at best,
// from the live FPL API on a runner. The sandbox cannot reach
// fantasy.premierleague.com; a runner can.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["scripts/maefloor.test.ts"], environment: "node", testTimeout: 900000 },
});
