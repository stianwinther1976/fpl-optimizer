import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The app's own `@/…` imports have to resolve here too, or route handlers and
  // anything else outside `src/lib` stay untestable — which is exactly how the
  // demo API route came to be the one file in the chain nothing covered.
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
