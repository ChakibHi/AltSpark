import { createAIClient } from "./ai.js";

const UNAVAILABLE_STATUSES = new Set(["unavailable", "unsupported"]);
const DEFAULT_SUMMARIZER_TYPES = ["key-points", "tldr"];

const aiClient = createAIClient({ bypassActivationCheck: true });

function normalizeAvailabilityStatus(value) {
  if (!value) {
    return "unknown";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value.status === "string") {
    return value.status;
  }
  return "unknown";
}

function getPreferredLanguages() {
  const base = new Set(["en"]);
  const candidates = Array.isArray(navigator?.languages) && navigator.languages.length
    ? navigator.languages
    : [navigator?.language];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim().toLowerCase();
    if (!trimmed) {
      continue;
    }
    const parts = trimmed.split(/[-_]/);
    const primary = parts[0];
    if (primary === "en" || primary === "es" || primary === "ja") {
      base.add(primary);
    }
  }
  if (!base.size) {
    base.add("en");
  }
  return Array.from(base);
}

async function prepareModel(key, ctor, options = {}) {
  if (!ctor || typeof ctor.create !== "function") {
    return;
  }
  try {
    let status = "unknown";
    if (typeof ctor.availability === "function") {
      status = normalizeAvailabilityStatus(await ctor.availability(options));
    }
    if (UNAVAILABLE_STATUSES.has(status)) {
      return;
    }
    await aiClient.ensureModel(key, ctor, options);
  } catch (error) {
    // console.warn(`[AltSpark] Offscreen preload ${key} failed`, error);
  }
}

async function prepareModels() {
  const languages = getPreferredLanguages();
  const tasks = [];
  if (typeof self.LanguageDetector?.create === "function") {
    const detectorOptions = languages.length ? { expectedInputLanguages: languages.slice(0, 4) } : {};
    tasks.push(prepareModel("languageDetector", self.LanguageDetector, detectorOptions));
  }
  if (typeof self.Summarizer?.create === "function") {
    for (const lang of languages) {
      for (const type of DEFAULT_SUMMARIZER_TYPES) {
        tasks.push(
          prepareModel(`summarizer:${type}:${lang}`, self.Summarizer, {
            type,
            outputLanguage: lang,
          }),
        );
      }
    }
  }
  if (typeof self.Translator?.create === "function") {
    for (const lang of languages) {
      tasks.push(
        prepareModel(`translator:auto>${lang}`, self.Translator, {
          targetLanguage: lang,
        }),
      );
    }
  }
  if (typeof self.Writer?.create === "function") {
    tasks.push(
      prepareModel("writer:neutral:plain-text", self.Writer, {
        tone: "neutral",
        format: "plain-text",
      }),
    );
  }
  if (typeof self.Rewriter?.create === "function") {
    tasks.push(
      prepareModel("rewriter:as-is:plain-text", self.Rewriter, {
        tone: "as-is",
        format: "plain-text",
        length: "as-is",
      }),
    );
  }
  if (typeof self.LanguageModel?.create === "function") {
    // LanguageModel sessions now require an explicit expected output language
    // for safety. Preload a small set based on the user's preferences.
    const preloadLangs = languages.length ? languages.slice(0, 3) : ["en"];
    for (const lang of preloadLangs) {
      tasks.push(
        prepareModel(`languageModel:${lang}`, self.LanguageModel, {
          expectedOutputs: [
            { type: "text", languages: [lang] },
          ],
        }),
      );
    }
  }
  await Promise.all(tasks);
}

const modelPreparation = (async () => {
  try {
    await prepareModels();
  } catch (error) {
    console.warn("[AltSpark] Offscreen model preparation failed", error);
  } finally {
    chrome.runtime
      .sendMessage({ type: "a11y-copy-helper:offscreen-ready" })
      .catch(() => {});
  }
})();

function sanitizeLimit(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return false;
  }
  if (message.type === "a11y-copy-helper:ai-summarize") {
    (async () => {
      await modelPreparation.catch(() => {});
      try {
        const summary = await aiClient.summarizeText(message.text || "", {
          type: typeof message.subtype === "string" ? message.subtype : undefined,
          language: typeof message.lang === "string" ? message.lang : undefined,
          limit: sanitizeLimit(message.limit),
        });
        sendResponse({ ok: true, text: summary });
      } catch (error) {
        console.warn("[AltSpark] Offscreen summarize failed", error);
        sendResponse({ ok: false, error: error?.message || "summarize failed" });
      }
    })();
    return true;
  }
  if (message.type === "a11y-copy-helper:ai-translate") {
    (async () => {
      await modelPreparation.catch(() => {});
      try {
        const translated = await aiClient.translateText(
          message.text || "",
          typeof message.targetLanguage === "string" ? message.targetLanguage : undefined,
          typeof message.sourceLanguage === "string" ? message.sourceLanguage : undefined,
        );
        sendResponse({ ok: true, text: translated });
      } catch (error) {
        console.warn("[AltSpark] Offscreen translate failed", error);
        sendResponse({ ok: false, error: error?.message || "translate failed" });
      }
    })();
    return true;
  }
  if (message.type === "a11y-copy-helper:ai-fetch-image") {
    (async () => {
      await modelPreparation.catch(() => {});
      try {
        const url = typeof message.url === "string" ? message.url : null;
        if (!url) {
          throw new Error("Missing image url");
        }
        const response = await fetch(url, { mode: "cors", credentials: "include" });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const blob = await response.blob();
        const buffer = await blob.arrayBuffer();
        sendResponse({
          ok: true,
          data: buffer,
          mimeType: blob.type || null,
          size: blob.size || 0,
        });
      } catch (error) {
        console.warn("[AltSpark] Offscreen fetch-image failed", error);
        sendResponse({ ok: false, error: error?.message || "fetch-image failed" });
      }
    })();
    return true;
  }
  if (message.type === "a11y-copy-helper:ai-rewrite") {
    (async () => {
      await modelPreparation.catch(() => {});
      try {
        const rewritten = await aiClient.rewriteText(message.original || "", message.instructions || "", {
          language: typeof message.language === "string" ? message.language : undefined,
          allowFallbackModels: Boolean(message.allowFallbackModels),
        });
        sendResponse({ ok: true, text: rewritten });
      } catch (error) {
        console.warn("[AltSpark] Offscreen rewrite failed", error);
        sendResponse({ ok: false, error: error?.message || "rewrite failed" });
      }
    })();
    return true;
  }
  if (message.type === "a11y-copy-helper:ai-detect-language") {
    (async () => {
      await modelPreparation.catch(() => {});
      try {
        const result = await aiClient.detectLanguage(message.text || "");
        sendResponse({ ok: true, result });
      } catch (error) {
        console.warn("[AltSpark] Offscreen detect-language failed", error);
        sendResponse({ ok: false, error: error?.message || "detect-language failed" });
      }
    })();
    return true;
  }
  if (message.type === "a11y-copy-helper:offscreen-ping") {
    (async () => {
      await modelPreparation.catch(() => {});
      sendResponse({ ok: true, ready: true });
    })();
    return true;
  }
  return false;
});
