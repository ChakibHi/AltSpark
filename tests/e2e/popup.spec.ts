import { test, expect } from "./fixtures";

const TEST_PAGE = "https://example.com";
const AI_FIXTURE_HTML = `
  <main>
    <section>
      <h1>ACCESSIBILITY UPDATE</h1>
      <p>Our city alerts dashboard needs clearer copy. The sentences below are intentionally vague so tests can verify AI rewrites.</p>
      <p>These alerts provide updates for everyone. Some important info is missing.</p>
      <a href="#">Click here</a>
      <img src="https://via.placeholder.com/120x80" alt="" />
    </section>
  </main>
`;

async function installAIStubs(context) {
  let [worker] = context.serviceWorkers();
  if (!worker) {
    worker = await context.waitForEvent("serviceworker", { timeout: 45000 });
  }
  await worker.evaluate(() => {
    if (globalThis.__A11Y_TEST_AI_STUBS_INSTALLED__) {
      return;
    }
    globalThis.__A11Y_TEST_AI_STUBS_INSTALLED__ = true;
    const handler = (message, _sender, sendResponse) => {
      if (!message || typeof message !== "object") {
        return false;
      }
      if (message.type === "a11y-copy-helper:ai-detect-language") {
        sendResponse({ ok: true, result: { language: "en", confidence: 1 } });
        return true;
      }
      if (message.type === "a11y-copy-helper:ai-summarize") {
        sendResponse({ ok: true, text: "[stub-summary:key-points]" });
        return true;
      }
      if (message.type === "a11y-copy-helper:ai-rewrite") {
        sendResponse({ ok: true, text: "[stub-writer:neutral]" });
        return true;
      }
      return false;
    };
    globalThis.__A11Y_TEST_AI_STUB_HANDLER__ = handler;
    chrome.runtime.onMessage.addListener(handler);
  });
  return worker;
}

test.describe("Extension smoke", () => {
  test("renders popup UI", async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(page.locator("#popup-title")).toContainText("AltSpark");
    await expect(page.locator("#count-pending")).toHaveText("0");
  });

  test("injects content script on a regular page", async ({ context }) => {
    const page = await context.newPage();
    await page.goto(TEST_PAGE, { waitUntil: "domcontentloaded" });
    const hasChromeAPI = await page.evaluate(() => typeof chrome !== "undefined");
    expect(hasChromeAPI).toBe(true);
  });
});

test.describe("AI integration", () => {
  test("uses stubbed AI responses for summary and rewrite", async ({ context }) => {
    const worker = await installAIStubs(context);

    const page = await context.newPage();
    await page.goto(TEST_PAGE, { waitUntil: "domcontentloaded" });
    await page.evaluate((html) => {
      document.documentElement.lang = "en";
      document.body.innerHTML = html;
    }, AI_FIXTURE_HTML);
    await page.bringToFront();

    const state = await worker.evaluate(async (targetUrl) => {
      const tabs = await chrome.tabs.query({});
      const targetTab = tabs.find((tab) => typeof tab?.url === "string" && tab.url.startsWith(targetUrl));
      if (!targetTab?.id) {
        throw new Error("Target tab unavailable");
      }
      const auditResponse = await chrome.tabs.sendMessage(targetTab.id, {
        type: "a11y-copy-helper:audit",
        scope: "page",
      });
      if (!auditResponse?.ok) {
        const details = auditResponse?.error || "Audit failed";
        throw new Error(`Audit failed: ${details}`);
      }
      const stateResponse = await chrome.tabs.sendMessage(targetTab.id, {
        type: "a11y-copy-helper:get-state",
      });
      if (!stateResponse?.ok || !stateResponse.state) {
        const details = stateResponse?.error || "State retrieval failed";
        throw new Error(`State retrieval failed: ${details}`);
      }
      return stateResponse.state;
    }, TEST_PAGE);

    expect(state.summary).toContain("[stub-summary:");
    const stubbedSuggestion = state.issues.find(
      (issue) => typeof issue?.suggestion === "string" && issue.suggestion.includes("[stub-writer:"),
    );
    expect(stubbedSuggestion).toBeTruthy();
  });
});
