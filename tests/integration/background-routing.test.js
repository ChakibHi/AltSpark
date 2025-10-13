import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../storage.js";

const chromeStub = globalThis.__chromeStub;

async function flushMicrotasks() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

let backgroundImported = false;

beforeAll(async () => {
  if (!backgroundImported) {
    await import("../../background.js");
    backgroundImported = true;
  }
});

beforeEach(() => {
  chromeStub.__resetMocks();
});

describe("background message routing", () => {
  it("sets badge to ellipsis while an audit is running", async () => {
    const sendResponse = vi.fn();

    chromeStub.runtime.onMessage.dispatch(
      {
        type: "a11y-copy-helper:state-update",
        state: { auditInProgress: true },
      },
      { tab: { id: 101 } },
      sendResponse,
    );

    await flushMicrotasks();

    expect(chromeStub.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ tabId: 101, color: "#f59e0b" });
    expect(chromeStub.action.setBadgeText).toHaveBeenCalledWith({ tabId: 101, text: "…" });
    expect(chromeStub.action.setTitle).toHaveBeenCalledWith({ tabId: 101, title: "AltSpark: audit running…" });
  });

  it("updates badge counts when issue totals arrive", async () => {
    const sendResponse = vi.fn();

    chromeStub.runtime.onMessage.dispatch(
      {
        type: "a11y-copy-helper:issue-counts",
        counts: { total: 10, pending: 5 },
        reason: "manual",
        auditId: "abc123",
      },
      { tab: { id: 202, url: "https://example.com" } },
      sendResponse,
    );

    await flushMicrotasks();

    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    expect(chromeStub.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ tabId: 202, color: "#4b5563" });
    expect(chromeStub.action.setBadgeText).toHaveBeenCalledWith({ tabId: 202, text: "5" });
  });

  it("relays popup audit requests to the content script", async () => {
    const sendResponse = vi.fn();

    chromeStub.tabs.sendMessage.mockResolvedValueOnce({ ok: true });

    chromeStub.runtime.onMessage.dispatch(
      {
        type: "a11y-copy-helper:popup-audit",
        tabId: 303,
        scope: "selection",
      },
      { tab: { id: 303 } },
      sendResponse,
    );

    await flushMicrotasks();

    expect(chromeStub.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 303 },
      files: ["content.js"],
    });
    expect(chromeStub.tabs.sendMessage).toHaveBeenCalledWith(303, {
      type: "a11y-copy-helper:audit",
      scope: "selection",
    });
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it("relays panel get-state requests to the content script", async () => {
    const sendResponse = vi.fn();

    chromeStub.tabs.sendMessage.mockResolvedValueOnce({ counts: {} });

    chromeStub.runtime.onMessage.dispatch(
      {
        type: "a11y-copy-helper:panel-get-state",
        tabId: 404,
      },
      { tab: { id: 404 } },
      sendResponse,
    );

    await flushMicrotasks();

    expect(chromeStub.scripting.executeScript).toHaveBeenLastCalledWith({
      target: { tabId: 404 },
      files: ["content.js"],
    });
    expect(chromeStub.tabs.sendMessage).toHaveBeenLastCalledWith(404, {
      type: "a11y-copy-helper:get-state",
    });
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, data: { counts: {} } });
  });

  it("passes through replaceText flag for panel apply issue", async () => {
    const sendResponse = vi.fn();

    chromeStub.tabs.sendMessage.mockResolvedValueOnce({ ok: true });

    chromeStub.runtime.onMessage.dispatch(
      {
        type: "a11y-copy-helper:panel-apply-issue",
        tabId: 505,
        issueId: "node-1",
        replaceText: true,
      },
      { tab: { id: 505 } },
      sendResponse,
    );

    await flushMicrotasks();

    expect(chromeStub.tabs.sendMessage).toHaveBeenLastCalledWith(505, {
      type: "a11y-copy-helper:apply-issue",
      issueId: "node-1",
      replaceText: true,
    });
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it("schedules auto-config when auto-apply is enabled", async () => {
    vi.useFakeTimers();
    try {
      const autoSettings = {
        ...DEFAULT_SETTINGS,
        autoModeEnabled: true,
        extensionPaused: false,
        autoApplyPaused: false,
        powerSaverMode: false,
      };

      chromeStub.tabs.query.mockResolvedValueOnce([]);

      chromeStub.storage.onChanged.dispatch(
        { a11yCopyHelperSettings: { newValue: autoSettings } },
        "sync",
      );

      chromeStub.tabs.sendMessage.mockResolvedValue({ ok: true });

      chromeStub.runtime.onMessage.dispatch(
        {
          type: "a11y-copy-helper:ready",
        },
        { tab: { id: 606, url: "https://example.com/article" } },
        vi.fn(),
      );

      await vi.advanceTimersByTimeAsync(801);
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
      await flushMicrotasks();

      expect(chromeStub.tabs.sendMessage).toHaveBeenCalledWith(606, {
        type: "a11y-copy-helper:auto-config",
        enabled: true,
        scope: "page",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("relays panel highlight commands", async () => {
    const sendResponse = vi.fn();

    chromeStub.tabs.sendMessage.mockResolvedValueOnce({ ok: true });

    chromeStub.runtime.onMessage.dispatch(
      {
        type: "a11y-copy-helper:panel-highlight",
        tabId: 707,
        issueId: "link-123",
        scroll: true,
        pulse: true,
      },
      { tab: { id: 707 } },
      sendResponse,
    );

    await flushMicrotasks();

    expect(chromeStub.tabs.sendMessage).toHaveBeenLastCalledWith(707, {
      type: "a11y-copy-helper:panel-highlight",
      issueId: "link-123",
      scroll: true,
      pulse: true,
    });
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it("returns a snapshot of site exclusions", async () => {
    chromeStub.tabs.query.mockResolvedValue([]);

    chromeStub.runtime.onMessage.dispatch(
      {
        type: "a11y-copy-helper:update-site-pref",
        hostname: "example.com",
        neverAuto: true,
      },
      { tab: { id: 808 } },
      vi.fn(),
    );

    await flushMicrotasks();

    const sendResponse = vi.fn();
    chromeStub.runtime.onMessage.dispatch(
      { type: "a11y-copy-helper:list-site-prefs" },
      {},
      sendResponse,
    );

    expect(sendResponse).toHaveBeenCalled();
    const payload = sendResponse.mock.calls.at(-1)?.[0];
    expect(payload?.ok).toBe(true);
    expect(Array.isArray(payload?.sites)).toBe(true);
    expect(payload.sites).toContainEqual({
      host: "example.com",
      paused: false,
      whitelisted: false,
      neverAuto: true,
    });
  });
});
