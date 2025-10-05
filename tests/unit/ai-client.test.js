import { afterEach, describe, expect, it, vi } from "vitest";
import { createAIClient } from "../../ai.js";
import { createActivationError, createModelCtor } from "../ai-model-stubs.js";

const ENSURE_TYPE = "a11y-copy-helper:ensure-offscreen";

const originalActivation = {
  isActive: globalThis.navigator.userActivation.isActive,
  hasBeenActive: globalThis.navigator.userActivation.hasBeenActive,
};

afterEach(() => {
  // Restore user activation state between tests.
  globalThis.navigator.userActivation.isActive = originalActivation.isActive;
  globalThis.navigator.userActivation.hasBeenActive = originalActivation.hasBeenActive;
});

describe("AIClient ensureModel", () => {
  it("caches model instances after the first create call", async () => {
    const client = createAIClient();
    const { ctor, createMock, instances } = createModelCtor({
      availability: [{ status: "ready" }],
      createImplementation: () => ({ id: "model" }),
    });

    const first = await client.ensureModel("summarizer", ctor);
    const second = await client.ensureModel("summarizer", ctor);

    expect(first).toBe(second);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(1);
  });

  it("throws ActivationRequiredError when availability is downloadable without activation", async () => {
    const client = createAIClient();
    const { ctor } = createModelCtor({ availability: [{ status: "downloadable" }] });

    globalThis.navigator.userActivation.isActive = false;
    globalThis.navigator.userActivation.hasBeenActive = false;

    await expect(client.ensureModel("languageDetector", ctor)).rejects.toMatchObject({
      name: "ActivationRequiredError",
    });
  });

  it("maps activation errors from create() into ActivationRequiredError", async () => {
    const client = createAIClient();
    const activationError = createActivationError();
    const { ctor } = createModelCtor({
      availability: [{ status: "ready" }],
      createImplementation: () => {
        throw activationError;
      },
    });

    await expect(client.ensureModel("translator", ctor)).rejects.toMatchObject({
      name: "ActivationRequiredError",
    });
  });

  it("wires download progress monitors into model creation", async () => {
    const client = createAIClient();
    const progressSpy = vi.fn();
    client.onProgress(progressSpy);

    const { ctor, instances } = createModelCtor({
      availability: [{ status: "ready" }],
      createImplementation: (options) => {
        expect(typeof options.monitor).toBe("function");
        const monitor = {
          addEventListener(event, handler) {
            if (event === "downloadprogress") {
              handler({ loaded: 512, total: 1024 });
            }
          },
        };
        options.monitor(monitor);
        return { id: "monitored" };
      },
    });

    await client.ensureModel("writer", ctor);

    expect(instances).toHaveLength(1);
    expect(typeof instances[0].options.monitor).toBe("function");
    expect(progressSpy).toHaveBeenCalledWith({ kind: "writer", loaded: 512, total: 1024 });
  });
});

describe("AIClient offscreen host coordination", () => {
  it("requests the offscreen host when prepareOffscreenHost is awaited", async () => {
    const client = createAIClient();
    const { runtime } = globalThis.chrome;

    runtime.sendMessage.mockResolvedValueOnce({ ok: true, ready: true });

    const ready = await client.prepareOffscreenHost({ waitForReady: true });

    expect(ready).toBe(true);
    expect(runtime.sendMessage).toHaveBeenCalledWith({ type: ENSURE_TYPE });
  });

  it("routes offscreen tasks through chrome.runtime when host is ready", async () => {
    const client = createAIClient();
    const { runtime } = globalThis.chrome;

    runtime.sendMessage
      .mockResolvedValueOnce({ ok: true, ready: true })
      .mockResolvedValueOnce({ ok: true, text: "summary" });

    const result = await client.callOffscreenTask("a11y-copy-helper:ai-summarize", {
      text: "Hello world",
    });

    expect(runtime.sendMessage).toHaveBeenNthCalledWith(1, { type: ENSURE_TYPE });
    expect(runtime.sendMessage).toHaveBeenNthCalledWith(2, {
      type: "a11y-copy-helper:ai-summarize",
      text: "Hello world",
    });
    expect(result).toBe("summary");
  });
});
