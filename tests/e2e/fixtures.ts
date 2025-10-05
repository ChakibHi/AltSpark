import { test as base, chromium } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";

const extensionPath = path.resolve(process.cwd());
const userDataDir = path.join(process.cwd(), "tmp", "playwright-user-data");

export const test = base.extend<{ extensionId: string }>({
  context: async ({}, use, testInfo) => {
    if (testInfo.project.use?.headless) {
      testInfo.skip("Chrome extensions require headless=false.");
      return;
    }
    await fs.mkdir(userDataDir, { recursive: true });
    const args = [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--no-default-browser-check",
      "--no-first-run",
    ];
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      channel: "chromium",
      args,
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) {
      worker = await context.waitForEvent("serviceworker", { timeout: 45_000 });
    }
    const url = worker.url();
    const extensionId = new URL(url).host;
    await use(extensionId);
  },
});

export const expect = base.expect;
