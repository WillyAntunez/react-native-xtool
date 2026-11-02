import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // GitHub-hosted runners and a loaded machine are slower than vitest's 5 s default.
    testTimeout: 20_000,
  },
});
