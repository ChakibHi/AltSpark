import { createAIClient as createBaseAIClient } from "./ai.js";

const DEFAULT_IDLE_MS = 5 * 60 * 1000;
const SUPPORTED_OUTPUT_LANGUAGES = new Set(["en", "es", "ja"]);

function normalizeOutputLanguage(language) {
  if (!language || typeof language !== "string") {
    return "en";
  }
  const trimmed = language.trim().toLowerCase();
  if (!trimmed) {
    return "en";
  }
  if (SUPPORTED_OUTPUT_LANGUAGES.has(trimmed)) {
    return trimmed;
  }
  const primary = trimmed.split(/[-_]/)[0];
  return SUPPORTED_OUTPUT_LANGUAGES.has(primary) ? primary : "en";
}

function toPromise(value) {
  if (value && typeof value.then === "function") {
    return value;
  }
  return Promise.resolve(value);
}

async function releaseInstance(instance) {
  if (!instance) {
    return;
  }
  try {
    if (typeof instance.destroy === "function") {
      await toPromise(instance.destroy());
      return;
    }
    if (typeof instance.close === "function") {
      await toPromise(instance.close());
      return;
    }
    if (typeof instance.release === "function") {
      await toPromise(instance.release());
      return;
    }
    if (typeof instance.dispose === "function") {
      await toPromise(instance.dispose());
      return;
    }
    if (typeof instance[Symbol.dispose] === "function") {
      await toPromise(instance[Symbol.dispose]());
    }
  } catch (error) {
    console.warn("[AltSpark] Model release failed", error);
  }
}

export function createAIClient(options = {}) {
  const client = createBaseAIClient(options);
  const idleMs =
    Number.isFinite(options?.modelIdleMs) && options.modelIdleMs > 0
      ? options.modelIdleMs
      : DEFAULT_IDLE_MS;

  const modelMeta = new Map();
  const promptMeta = new Map();
  let cleanupTimer = null;

  const originalEnsureModel =
    typeof client.ensureModel === "function" ? client.ensureModel.bind(client) : null;

  if (originalEnsureModel) {
    client.ensureModel = async (key, ctor, ctorOptions = {}) => {
      const model = await originalEnsureModel(key, ctor, ctorOptions);
      if (model) {
        modelMeta.set(key, { model, lastUsedAt: Date.now() });
        scheduleCleanup();
      }
      return model;
    };
  }

  const originalDescribe =
    typeof client.describeImageWithPrompt === "function"
      ? client.describeImageWithPrompt.bind(client)
      : null;

  if (originalDescribe) {
    client.describeImageWithPrompt = async (imageSource, opts = {}) => {
      const outputLanguage = normalizeOutputLanguage(opts?.language || navigator?.language || "en");
      const sessionKey = `image:${outputLanguage}`;
      const result = await originalDescribe(imageSource, opts);
      const stored = client.promptSessions?.get?.(sessionKey);

      if (stored) {
        promptMeta.set(sessionKey, {
          lastUsedAt: Date.now(),
          releaseFn: async () => {
            try {
              const session = await stored;
              await releaseInstance(session);
            } finally {
              client.promptSessions?.delete?.(sessionKey);
            }
          },
        });
        scheduleCleanup();
      } else {
        promptMeta.delete(sessionKey);
      }
      return result;
    };
  }

  client.flushModelCache = async () => {
    if (cleanupTimer) {
      clearTimeout(cleanupTimer);
      cleanupTimer = null;
    }
    await runCleanup();
  };

  function scheduleCleanup() {
    if (cleanupTimer) {
      return;
    }
    cleanupTimer = setTimeout(() => {
      cleanupTimer = null;
      runCleanup().catch((error) => {
        console.warn("[AltSpark] Model cleanup failed", error);
      });
    }, idleMs);
  }

  async function runCleanup() {
    const now = Date.now();
    let nextDelay = null;

    for (const [key, entry] of Array.from(modelMeta.entries())) {
      const idle = now - (entry.lastUsedAt || 0);
      if (idle >= idleMs) {
        await releaseInstance(entry.model);
        modelMeta.delete(key);
        client.models?.delete?.(key);
      } else {
        const remaining = idleMs - idle;
        if (nextDelay === null || remaining < nextDelay) {
          nextDelay = remaining;
        }
      }
    }

    for (const [key, entry] of Array.from(promptMeta.entries())) {
      const idle = now - (entry.lastUsedAt || 0);
      if (idle >= idleMs) {
        try {
          await entry.releaseFn?.();
        } catch (error) {
          console.warn("[AltSpark] Failed to release prompt session", error);
        }
        promptMeta.delete(key);
      } else {
        const remaining = idleMs - idle;
        if (nextDelay === null || remaining < nextDelay) {
          nextDelay = remaining;
        }
      }
    }

    if (nextDelay != null && Number.isFinite(nextDelay)) {
      cleanupTimer = setTimeout(() => {
        cleanupTimer = null;
        runCleanup().catch((error) => {
          console.warn("[AltSpark] Model cleanup failed", error);
        });
      }, Math.max(1000, nextDelay));
    }
  }

  return client;
}
