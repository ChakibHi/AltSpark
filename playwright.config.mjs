import { defineConfig } from "@playwright/test";

const isCI = Boolean(process.env.CI);
const forceHeadless = process.env.PW_HEADLESS === "1" || process.env.HEADLESS === "1";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  timeout: 60_000,
  retries: isCI ? 1 : 0,
  reporter: [["list"]],
  use: {
    headless: forceHeadless ? true : false,
    screenshot: "only-on-failure",
    video: "off",
    trace: "retain-on-failure",
  },
});
