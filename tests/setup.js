import { afterEach, beforeAll, vi } from "vitest";
import { createChromeStub } from "./chrome-shim.js";

const chromeStub = createChromeStub();

if (!globalThis.window) {
  globalThis.window = globalThis;
}

if (!globalThis.document) {
  throw new Error("happy-dom environment is required for the tests");
}

Object.defineProperty(globalThis, "navigator", {
  value: {
    userAgent: "vitest",
    language: "en-US",
    languages: ["en-US"],
    userActivation: { isActive: true, hasBeenActive: true },
  },
  writable: false,
  configurable: true,
});

globalThis.chrome = chromeStub;
globalThis.__chromeStub = chromeStub;

beforeAll(() => {
  // Ensure fetch exists for modules that expect a browser-like environment.
  if (typeof globalThis.fetch !== "function") {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      text: async () => "",
      json: async () => ({}),
    }));
  }
});

afterEach(() => {
  if (typeof chromeStub.__resetMocks === "function") {
    chromeStub.__resetMocks();
  }
  if (typeof chromeStub.__clearStorage === "function") {
    chromeStub.__clearStorage();
  }
  vi.restoreAllMocks();
});
