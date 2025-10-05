import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    setupFiles: ["tests/setup.js"],
    globals: true,
    exclude: [
      "tests/e2e/**",
      "playwright.config.*",
    ],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
    },
  },
});
