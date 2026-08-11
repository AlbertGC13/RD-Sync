import { fileURLToPath } from "node:url";
import type { ViteUserConfig } from "vitest/config";

export const sharedVitestConfig = {
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
    },
    environment: "node",
    // Fail the run if any test uses .only — guards against accidentally
    // skipping the full suite during local development or in CI.
    allowOnly: false,
  },
} satisfies ViteUserConfig;
