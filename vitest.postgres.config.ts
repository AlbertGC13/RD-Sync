import { defineConfig } from "vitest/config";
import { sharedVitestConfig } from "./vitest.shared";

export default defineConfig({
  ...sharedVitestConfig,
  test: {
    ...sharedVitestConfig.test,
    include: ["**/*.postgres.test.ts", "src/modules/persistence/prisma-contracts.test.ts"],
    fileParallelism: false,
  },
});
