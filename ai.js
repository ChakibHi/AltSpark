// Limits used when trimming the text we send to Chrome's on-device models
const DEFAULT_CHUNK_LIMIT = 9000;
const MIN_CHUNK_LIMIT = 1800;
const DEBUG_AI_LOGGING = false;
const ENABLE_EXTENDED_REWRITE_MODELS = false;
const MODEL_STATUS_TTL_MS = 15_000;

function getPrimaryLanguage() {
  try {
    const raw = typeof navigator?.language === "string" ? navigator.language : "en";
    const primary = raw.split(/[-_]/)[0];
    return primary || "en";
  } catch (_error) {
    return "en";
  }
}

function getSecondaryLanguage(primary) {
  try {
    const fallbackList = Array.isArray(navigator?.languages) && navigator.languages.length
      ? navigator.languages
      : [navigator?.language || 'en', 'en', 'es', 'fr'];
    for (const candidate of fallbackList) {
      if (typeof candidate !== 'string') {
        continue;
      }
      const normalized = candidate.split(/[-_]/)[0]?.trim();
      if (normalized && normalized !== primary) {
        return normalized;
      }
    }
  } catch (_error) {
    // ignore
  }
  return primary === 'en' ? 'es' : 'en';
}

const LOCAL_MODEL_SPECS = [
  {
    id: "summarizer",
    label: "Summarizer",
    required: true,
    ctor: () => (typeof self !== "undefined" ? self.Summarizer : undefined),
    options: () => ({
      type: "key-points",
      outputLanguage: getPrimaryLanguage(),
    }),
  },
  {
    id: "translator",
    label: "Translator",
    required: true,
    ctor: () => (typeof self !== "undefined" ? self.Translator : undefined),
    options: () => {
      const target = getPrimaryLanguage();
      const source = getSecondaryLanguage(target);
      return {
        sourceLanguage: source,
        targetLanguage: target,
      };
    },
  },
  {
    id: "writer",
    label: "Writer",
    required: false,
    ctor: () => (typeof self !== "undefined" ? self.Writer : undefined),
    options: () => ({
      tone: "neutral",
      format: "plain-text",
    }),
  },
  {
    id: "rewriter",
    label: "Rewriter",
    required: true,
    ctor: () => (typeof self !== "undefined" ? self.Rewriter : undefined),
    options: () => ({
      tone: "as-is",
      format: "plain-text",
      length: "as-is",
    }),
  },
  {
    id: "language-detector",
    label: "Language Detector",
    required: false,
    ctor: () => (typeof self !== "undefined" ? self.LanguageDetector : undefined),
    options: () => {
      try {
        const languages = Array.isArray(navigator?.languages) && navigator.languages.length
          ? navigator.languages
          : [navigator?.language || "en"];
        const normalized = [];
        for (const entry of languages) {
          if (typeof entry !== "string") {
            continue;
          }
          const primary = entry.split(/[-_]/)[0]?.trim();
          if (primary && !normalized.includes(primary) && normalized.length < 4) {
            normalized.push(primary);
          }
        }
        return normalized.length ? { expectedInputLanguages: normalized } : undefined;
      } catch (_error) {
        return undefined;
      }
    },
  },
  {
    id: "language-model",
    label: "Language Model",
    required: false,
    ctor: () => (typeof self !== "undefined" ? self.LanguageModel : undefined),
    options: () => ({
      expectedOutputs: [
        { type: "text", languages: [getPrimaryLanguage()] },
      ],
    }),
  },
];

const OFFSCREEN_MESSAGE_TYPES = {
  ensure: "a11y-copy-helper:ensure-offscreen",
  ready: "a11y-copy-helper:offscreen-ready",
  summarize: "a11y-copy-helper:ai-summarize",
  translate: "a11y-copy-helper:ai-translate",
  rewrite: "a11y-copy-helper:ai-rewrite",
  detectLanguage: "a11y-copy-helper:ai-detect-language",
  fetchImage: "a11y-copy-helper:ai-fetch-image",
};

// Lightweight pub/sub helper so UI surfaces can respond to model download progress
class ProgressEmitter {
  constructor() {
    this.listeners = new Set();
  }
  emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("[AltSpark] Progress listener error", error);
      }
    }
  }
  add(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

class ActivationRequiredError extends Error {
  constructor(message = "User interaction is required before using AI features.") {
    super(message);
    this.name = "ActivationRequiredError";
  }
}

// Wrap the availability call because it can throw in some Chrome builds
async function guardedAvailability(ctor, options) {
  if (!ctor || typeof ctor.availability !== "function") {
    return { status: "unknown" };
  }
  try {
    return normalizeAvailability(await ctor.availability(options));
  } catch (error) {
    const name = ctor?.name || "Model";
    console.warn(`[AltSpark] ${name} availability() failed`, error);
    return { status: "unknown" };
  }
}

function normalizeAvailability(result) {
  if (typeof result === "string") {
    return { status: result };
  }
  if (result && typeof result === "object" && typeof result.status === "string") {
    return { status: result.status };
  }
  return { status: "unknown" };
}

function isUnavailable(status) {
  return status === "unavailable" || status === "unsupported";
}

// Break long text into roughly equal parts so summarizer calls stay under token limits
const SUPPORTED_SUMMARIZER_TYPES = new Set(["key-points", "headline", "tldr"]);

function normalizeSummarizerType(value) {
  if (typeof value === "string" && SUPPORTED_SUMMARIZER_TYPES.has(value)) {
    return value;
  }
  return "key-points";
}

function chunkText(text, limit) {
  if (text.length <= limit) {
    return [text];
  }
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + limit, text.length);
    let slice = text.slice(start, end);
    if (end < text.length) {
      const breakIndex = slice.lastIndexOf("\n\n");
      if (breakIndex > 500) {
        slice = slice.slice(0, breakIndex);
        start += breakIndex;
      } else {
        start = end;
      }
    } else {
      start = end;
    }
    chunks.push(slice);
  }
  return chunks;
}

// Return the first string that looks useful when models give optional fields
function firstNonEmpty(...values) {
  for (const value of values) {
    if (value && typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function normalizeOutputLanguage(language) {
  const supported = new Set(["en", "es", "ja"]);
  if (!language || typeof language !== "string") {
    return "en";
  }
  const lower = language.trim().toLowerCase();
  if (!lower) {
    return "en";
  }
  const candidates = [lower, lower.split(/[-_]/)[0]];
  for (const candidate of candidates) {
    if (candidate && supported.has(candidate)) {
      return candidate;
    }
  }
  return "en";
}

function hasUserActivation() {
  if (typeof navigator === "undefined") {
    return true;
  }
  const activation = navigator.userActivation;
  if (!activation) {
    return true;
  }
  return Boolean(activation.isActive || activation.hasBeenActive);
}

function isActivationError(error) {
  if (!error) {
    return false;
  }
  if (error.name === "ActivationRequiredError") {
    return true;
  }
  const message = typeof error.message === "string" ? error.message.toLowerCase() : "";
  if (message.includes("activation") || message.includes("user gesture") || message.includes("user-activation") || message.includes("gesture")) {
    return true;
  }
  const name = typeof error.name === "string" ? error.name.toLowerCase() : "";
  return name.includes("activation");
}

function canUseRuntimeMessaging() {
  return typeof chrome !== "undefined" && typeof chrome.runtime?.sendMessage === "function";
}

function isReceivingEndMissing(error) {
  if (!error || typeof error.message !== "string") {
    return false;
  }
  return error.message.includes("Receiving end does not exist") || error.message.includes("No receiving end") || error.message.includes("The message port closed");
}

export class AIClient {
  constructor(options = {}) {
    const { bypassActivationCheck = false } = options || {};
    this.bypassActivationCheck = Boolean(bypassActivationCheck);
    this.progress = new ProgressEmitter();
    this.models = new Map();
    this.activationListeners = new ProgressEmitter();
    this.activationState = { required: false, lastRequestedAt: null };
    this.promptSessions = new Map();
    this.imageBlobCache = new Map();
    this.offscreenState = {
      supported: null,
      ready: false,
      preparing: null,
    };
    this.localModelStatus = null;
    this.localModelStatusFetchedAt = 0;
  }

  // Allow callers to subscribe to downloadprogress events from any model
  onProgress(listener) {
    return this.progress.add(listener);
  }

  onActivation(listener) {
    return this.activationListeners.add(listener);
  }

  createMonitor(kind) {
    return (monitor) => {
      if (!monitor?.addEventListener) {
        return;
      }
      monitor.addEventListener("downloadprogress", (event) => {
        const { loaded = 0, total = 0 } = event || {};
        this.progress.emit({ kind, loaded, total });
      });
    };
  }

  markOffscreenNotReady() {
    this.offscreenState.ready = false;
    if (!this.bypassActivationCheck) {
      this.offscreenState.preparing = null;
    }
  }

  prepareOffscreenHost({ waitForReady = false } = {}) {
    if (this.bypassActivationCheck) {
      return Promise.resolve(false);
    }
    const promise = this.ensureOffscreenHost();
    if (!waitForReady) {
      promise.catch(() => {});
    }
    return promise;
  }

  async ensureOffscreenHost() {
    if (this.bypassActivationCheck) {
      return false;
    }
    if (this.offscreenState.ready) {
      return true;
    }
    if (this.offscreenState.supported === false) {
      return false;
    }
    if (!canUseRuntimeMessaging()) {
      this.offscreenState.supported = false;
      return false;
    }
    if (!this.offscreenState.preparing) {
      this.offscreenState.preparing = (async () => {
        try {
          const response = await chrome.runtime.sendMessage({
            type: OFFSCREEN_MESSAGE_TYPES.ensure,
          });
          if (response?.ok && response.ready) {
            this.offscreenState.supported = true;
            this.offscreenState.ready = true;
            return true;
          }
          if (response?.error === "unsupported-offscreen" || response?.error === "unsupported") {
            this.offscreenState.supported = false;
            this.offscreenState.ready = false;
            return false;
          }
          if (response?.ok && response.pending) {
            this.offscreenState.supported = true;
            this.offscreenState.ready = false;
            return false;
          }
          this.offscreenState.ready = Boolean(response?.ready);
          return this.offscreenState.ready;
        } catch (error) {
          if (isReceivingEndMissing(error)) {
            this.markOffscreenNotReady();
            return false;
          }
          console.warn("[AltSpark] ensureOffscreenHost failed", error);
          this.markOffscreenNotReady();
          return false;
        } finally {
          if (!this.offscreenState.ready) {
            this.offscreenState.preparing = null;
          }
        }
      })();
    }
    return this.offscreenState.preparing;
  }

  async callOffscreenTask(type, payload, transform) {
    if (this.bypassActivationCheck) {
      return null;
    }
    if (!canUseRuntimeMessaging()) {
      this.offscreenState.supported = false;
      return null;
    }
    const ready = await this.ensureOffscreenHost();
    if (!ready) {
      return null;
    }
    try {
      const response = await chrome.runtime.sendMessage({ ...payload, type });
      if (response?.ok) {
        if (typeof transform === "function") {
          return transform(response);
        }
        if ("result" in (response || {})) {
          return response.result;
        }
        if (typeof response.text === "string") {
          return response.text;
        }
        return response.data ?? null;
      }
      if (response?.error === "offscreen-not-ready") {
        this.markOffscreenNotReady();
      }
    } catch (error) {
      if (isReceivingEndMissing(error)) {
        this.markOffscreenNotReady();
        return null;
      }
      console.warn(`[AltSpark] Offscreen task ${type} failed`, error);
      this.markOffscreenNotReady();
      return null;
    }
    return null;
  }

  async getLocalModelStatus(force = false) {
    const now = Date.now();
    if (!force && this.localModelStatus && now - this.localModelStatusFetchedAt < MODEL_STATUS_TTL_MS) {
      return this.localModelStatus;
    }
    const items = [];
    for (const spec of LOCAL_MODEL_SPECS) {
      try {
        const ctor = typeof spec.ctor === "function" ? spec.ctor() : spec.ctor;
        const options = typeof spec.options === "function" ? spec.options() : spec.options;
        const availability = await guardedAvailability(ctor, options);
        const status = availability?.status || "unknown";
        const available = !isUnavailable(status);
        items.push({
          id: spec.id,
          label: spec.label,
          status,
          available,
          required: spec.required !== false,
        });
      } catch (error) {
        console.warn(`[AltSpark] Model status check failed for ${spec.id}`, error);
        items.push({
          id: spec.id,
          label: spec.label,
          status: "unknown",
          available: false,
          required: spec.required !== false,
        });
      }
    }
    const ready = items
      .filter((item) => item.required !== false)
      .every((item) => item.available);
    const status = {
      ready,
      items,
      checkedAt: now,
    };
    this.localModelStatus = status;
    this.localModelStatusFetchedAt = now;
    return status;
  }

  async ensureModel(key, ctor, options = {}) {
    if (this.models.has(key)) {
      this.setActivationRequired(false);
      return this.models.get(key);
    }
    const availability = await guardedAvailability(ctor, options);
    const status = availability?.status || "unknown";
    const needsActivation = !this.bypassActivationCheck && status === "downloadable";
    if (needsActivation && !hasUserActivation()) {
      this.setActivationRequired(true);
      throw new ActivationRequiredError();
    }
    const createOptions = { ...options };
    if (!("monitor" in createOptions)) {
      createOptions.monitor = this.createMonitor(key);
    }
    try {
      const model = await ctor.create(createOptions);
      this.models.set(key, model);
      this.setActivationRequired(false);
      return model;
    } catch (error) {
      if (!this.bypassActivationCheck && (needsActivation || isActivationError(error))) {
        this.setActivationRequired(true);
        throw new ActivationRequiredError(error?.message || "User activation is required.");
      }
      throw error;
    }
  }

  // Quickly guess the language for the current selection to steer other prompts
  async detectLanguage(text) {
    const fallback = () => ({ language: navigator.language || "en", confidence: 0 });
    if (!text || !text.trim()) {
      return fallback();
    }
    const offscreenResult = await this.callOffscreenTask(
      OFFSCREEN_MESSAGE_TYPES.detectLanguage,
      { text: typeof text === "string" ? text.slice(0, 8000) : String(text || "") },
      (response) => response.result || response.data || null,
    );
    if (offscreenResult && typeof offscreenResult.language === "string") {
      return {
        language: offscreenResult.language,
        confidence: typeof offscreenResult.confidence === "number" ? offscreenResult.confidence : 0,
      };
    }
    const ctor = typeof self !== "undefined" ? self.LanguageDetector : undefined;
    if (!ctor) {
      return fallback();
    }
    const expectedLanguagesRaw = Array.isArray(navigator?.languages) && navigator.languages.length
      ? navigator.languages.slice(0, 4)
      : [navigator?.language || "en"];
    const expectedLanguages = expectedLanguagesRaw
      .map((lang) => (typeof lang === "string" ? lang.trim() : ""))
      .filter(Boolean);
    if (!expectedLanguages.length) {
      expectedLanguages.push("en");
    }
    const availability = await guardedAvailability(ctor, {
      expectedInputLanguages: expectedLanguages,
    });
    if (isUnavailable(availability.status)) {
      return fallback();
    }
    try {
      const detector = await this.ensureModel("languageDetector", ctor);
      const [primary] = await detector.detect(text.slice(0, 5000));
      if (!primary) {
        return fallback();
      }
      const detected = primary.detectedLanguage || primary.language;
      return {
        language: detected || fallback().language,
        confidence: primary.confidence ?? 0,
      };
    } catch (error) {
      if (error?.name === "ActivationRequiredError") {
        const result = fallback();
        result.activationRequired = true;
        return result;
      }
      console.warn("[AltSpark] detectLanguage fallback", error);
      return fallback();
    }
  }

  // Optional translation pass so the UI can show localized suggestions
  async translateText(text, targetLanguage, sourceLanguage) {
    if (!text || !text.trim() || !targetLanguage) {
      return text;
    }
    const offscreenResult = await this.callOffscreenTask(
      OFFSCREEN_MESSAGE_TYPES.translate,
      { text, targetLanguage, sourceLanguage },
      (response) => (typeof response.text === "string" ? response.text : response.result || null),
    );
    if (typeof offscreenResult === "string") {
      return offscreenResult;
    }
    const ctor = typeof self !== "undefined" ? self.Translator : undefined;
    if (!ctor) {
      return text;
    }
    const translatorOptions = {};
    if (sourceLanguage) {
      translatorOptions.sourceLanguage = sourceLanguage;
    }
    translatorOptions.targetLanguage = targetLanguage;
    const availability = await guardedAvailability(ctor, translatorOptions);
    if (isUnavailable(availability.status)) {
      return text;
    }
    const key = `translator:${sourceLanguage || "auto"}>${targetLanguage}`;
    try {
      const translator = await this.ensureModel(key, ctor, translatorOptions);
      return await translator.translate(text);
    } catch (error) {
      if (error?.name === "ActivationRequiredError") {
        return text;
      }
      console.warn("[AltSpark] Translation failed, returning original", error);
      return text;
    }
  }

  async describeImageWithPrompt(imageSource, { language } = {}) {
    if (!imageSource) {
      return null;
    }
    console.log("[AltSpark][describeImageWithPrompt] received", imageSource);
    if (typeof self === "undefined" || typeof self.LanguageModel?.create !== "function") {
      return null;
    }
    const outputLanguage = normalizeOutputLanguage(language || navigator?.language || "en");
    const sessionKey = `image:${outputLanguage}`;
    try {
      let sessionPromise = this.promptSessions.get(sessionKey);
      if (!sessionPromise) {
        sessionPromise = self.LanguageModel.create({
          expectedInputs: [
            { type: "image" },
            { type: "text", languages: [outputLanguage] },
          ],
          expectedOutputs: [
            { type: "text", languages: [outputLanguage] },
          ],
        });
        this.promptSessions.set(sessionKey, sessionPromise);
      }
      const session = await sessionPromise;
      if (!session?.prompt) {
        this.promptSessions.delete(sessionKey);
        return null;
      }
      let imageValue = imageSource;
      if (
        imageSource &&
        typeof imageSource === "object" &&
        typeof imageSource.tagName === "string" &&
        imageSource.tagName.toLowerCase() === "img"
      ) {
        const src = imageSource.currentSrc || imageSource.src || "";
        // console.log("[AltSpark][describeImageWithPrompt] img element src", src);
        if (src) {
          const cache = this.imageBlobCache;
          try {
            const resolvedUrl = new URL(src, location.href).toString();
            if (cache && cache.has(resolvedUrl)) {
              const cachedValue = cache.get(resolvedUrl);
              if (cachedValue) {
                imageValue = cachedValue;
              }
            } else {
              const isDataUrl = resolvedUrl.startsWith("data:");
              let blob = null;
              try {
                const directResponse = await fetch(resolvedUrl, { mode: "cors" });
                if (directResponse.ok && directResponse.type !== "opaque") {
                  blob = await directResponse.blob();
                }
              } catch (_directFetchError) {
                // ignore so we can fall back to offscreen fetch
              }
              if (!blob && !isDataUrl) {
                const offscreenBlob = await this.callOffscreenTask(
                  OFFSCREEN_MESSAGE_TYPES.fetchImage,
                  { url: resolvedUrl },
                  (response) => {
                    if (response?.blob instanceof Blob) {
                      return response.blob;
                    }
                    if (response?.data) {
                      try {
                        return new Blob([response.data], {
                          type: response.mimeType || "application/octet-stream",
                        });
                      } catch (_blobError) {
                        return null;
                      }
                    }
                    return null;
                  },
                );
                if (offscreenBlob) {
                  blob = offscreenBlob;
                }
              }
              if (!blob && isDataUrl) {
                try {
                  const dataResponse = await fetch(resolvedUrl);
                  if (dataResponse.ok) {
                    blob = await dataResponse.blob();
                  }
                } catch (_dataUrlError) {
                  // ignore
                }
              }
              if (blob instanceof Blob && blob.size) {
                imageValue = blob;
                if (cache) {
                  cache.set(resolvedUrl, blob);
                  if (cache.size > 60) {
                    const oldest = cache.keys().next().value;
                    cache.delete(oldest);
                  }
                }
              } else if (cache) {
                cache.set(resolvedUrl, null);
              }
            }
          } catch (_conversionError) {
            if (cache) {
              try {
                cache.set(src, null);
              } catch (_cacheError) {
                // ignore
              }
            }
            imageValue = imageSource;
          }
        }
      }
      const languageLabel = outputLanguage === "en"
        ? "English"
        : outputLanguage === "es"
          ? "Spanish"
          : outputLanguage === "ja"
            ? "Japanese"
            : outputLanguage;
      const languageHint = outputLanguage === "en"
        ? "Describe this image in under 125 characters."
        : `Describe this image in ${languageLabel} under 125 characters.`;
      const instructions = `${languageHint} Focus on what is clearly visible. Use plain, factual language, avoid metaphors, symbolism, or marketing language, and do not infer intent beyond the scene. Avoid starting with "Image of".`;
      // console.log("[AltSpark][describeImageWithPrompt] instructions", instructions);
      // console.log("[AltSpark][describeImageWithPrompt] sending value", imageValue);
      const response = await session.prompt(
        [
          {
            role: "user",
            content: [
              { type: "text", value: instructions },
              { type: "image", value: imageValue }
            ],
          },
        ],
        { outputLanguage }
      );
      if (DEBUG_AI_LOGGING) {
        console.log("[AltSpark][describeImageWithPrompt] response", response);
      }
      const rawOutput = firstNonEmpty(
        typeof response === "string" ? response : "",
        response?.output,
        response?.text,
        response?.result,
        typeof response?.message?.content === "string" ? response.message.content : "",
      );
      if (!rawOutput) {
        return null;
      }
      const trimmed = rawOutput.trim();
      return trimmed ? trimmed : null;
    } catch (error) {
      this.promptSessions.delete(sessionKey);
      if (DEBUG_AI_LOGGING) {
        console.warn("[AltSpark] Prompt API image describe failed", error);
      }
      return null;
    }
  }

  // Reduce long copy to a digestible summary, backing off when quotas are tight
  async summarizeText(text, options = {}) {
    const { limit = DEFAULT_CHUNK_LIMIT, type = "key-points", language } = options || {};
    if (!text || !text.trim()) {
      return "";
    }
    const summarizerType = normalizeSummarizerType(type);
    const outputLanguage = normalizeOutputLanguage(language || navigator?.language || "en");
    const offscreenResult = await this.callOffscreenTask(
      OFFSCREEN_MESSAGE_TYPES.summarize,
      {
        text,
        subtype: summarizerType,
        lang: outputLanguage,
        limit,
      },
      (response) => (typeof response.text === "string" ? response.text : response.result || null),
    );
    if (typeof offscreenResult === "string" && offscreenResult.trim()) {
      return offscreenResult;
    }
    const ctor = typeof self !== "undefined" ? self.Summarizer : undefined;
    const fallback = () => text.split("\n").slice(0, 3).join(" ").trim().slice(0, 400);
    if (!ctor) {
      return fallback();
    }
    const availability = await guardedAvailability(ctor, { type: summarizerType, outputLanguage });
    if (isUnavailable(availability.status)) {
      return fallback();
    }
    if (DEBUG_AI_LOGGING) {
      console.log("summarizerType:", summarizerType);
      console.log("outputLanguage:", outputLanguage);
      console.log("availability:", availability);
      console.log("limit:", limit);
    }
    let currentLimit = limit;
    while (currentLimit >= MIN_CHUNK_LIMIT) {
      try {
        const key = `summarizer:${summarizerType}:${outputLanguage}`;
        const model = await this.ensureModel(key, ctor, { type: summarizerType, outputLanguage });
        const chunks = chunkText(text, currentLimit);
        const summaries = [];
        for (const chunk of chunks) {
          const result = await model.summarize(chunk, { outputLanguage });
          if (DEBUG_AI_LOGGING) {
            console.log("summarized:", result);
          }
          summaries.push(firstNonEmpty(
            result?.summary,
            result?.result,
            typeof result === "string" ? result : "",
            fallback()
          ));
        }
        return summaries.join(" ");
      } catch (error) {
        if (DEBUG_AI_LOGGING) {
          console.log("summarizeText error:", error);
        }
        if (error?.name === "ActivationRequiredError") {
          return fallback();
        }
        if (error?.name === "QuotaExceededError") {
          currentLimit = Math.floor(currentLimit / 2);
          continue;
        }
        console.warn("[AltSpark] summarize fallback", error);
        return fallback();
      }
    }
    return fallback();
  }

  // Main helper for turning AI guidance into cleaner, accessible copy
  async rewriteText(original, instructions, { language, allowFallbackModels } = {}) {
    const fallback = () => {
      const trimmed = original?.trim();
      if (!trimmed) {
        return "";
      }
      if (!instructions) {
        return trimmed;
      }
      return trimmed
        .replace(/!{2,}/g, "!")
        .replace(/\s+/g, " ")
        .replace(/\bCLICK HERE\b/gi, "Click here")
        .trim();
    };

    const offscreenResult = await this.callOffscreenTask(
      OFFSCREEN_MESSAGE_TYPES.rewrite,
      {
        original,
        instructions,
        language,
        allowFallbackModels,
      },
      (response) => (typeof response.text === "string" ? response.text : response.result || null),
    );
    if (typeof offscreenResult === "string" && offscreenResult.trim()) {
      return offscreenResult;
    }

    const rewriterCtor = typeof self !== "undefined" ? self.Rewriter : undefined;
    const writerCtor = typeof self !== "undefined" ? self.Writer : undefined;
    const languageModelCtor = typeof self !== "undefined" ? self.LanguageModel : undefined;

    let activationBlocked = false;
    let writer = null;
    let rewriter = null;
    let languageSession = null;
    const extendedModelsAllowed = Boolean(
      allowFallbackModels ?? ENABLE_EXTENDED_REWRITE_MODELS,
    );

    if (writerCtor) {
      const availability = await guardedAvailability(writerCtor);
      if (!isUnavailable(availability.status)) {
        try {
          writer = await this.ensureModel("writer:neutral:plain-text", writerCtor, {
            tone: "neutral",
            format: "plain-text",
          });
        } catch (error) {
          if (error?.name === "ActivationRequiredError") {
            activationBlocked = true;
          } else {
            console.warn("[AltSpark] Writer.create failed", error);
          }
        }
      }
    }

    if (!writer && !activationBlocked && extendedModelsAllowed && rewriterCtor) {
      const availability = await guardedAvailability(rewriterCtor);
      if (!isUnavailable(availability.status)) {
        try {
          rewriter = await this.ensureModel("rewriter:as-is:plain-text", rewriterCtor, {
            tone: "as-is",
            format: "plain-text",
            length: "as-is",
          });
        } catch (error) {
          if (error?.name === "ActivationRequiredError") {
            activationBlocked = true;
          } else {
            console.warn("[AltSpark] Rewriter.create failed", error);
          }
        }
      }
    }

    if (!writer && !rewriter && !activationBlocked && extendedModelsAllowed && languageModelCtor) {
      const availability = await guardedAvailability(languageModelCtor);
      if (!isUnavailable(availability.status)) {
        try {
          const outputLanguage = normalizeOutputLanguage(language || navigator?.language || "en");
          languageSession = await this.ensureModel(
            `languageModel:${outputLanguage}`,
            languageModelCtor,
            {
              // Attest expected output language so the implementation can
              // provision any language-specific safety checks/downloads.
              expectedOutputs: [
                { type: "text", languages: [outputLanguage] },
              ],
            },
          );
        } catch (error) {
          if (error?.name === "ActivationRequiredError") {
            activationBlocked = true;
          } else {
            console.warn("[AltSpark] LanguageModel.create failed", error);
          }
        }
      }
    }

    if (activationBlocked && !writer && !rewriter && !languageSession) {
      return fallback();
    }

    const normalizedLanguage = (language || navigator?.language || "en").split(/[,;]/)[0]?.trim() || "en";
    const instructionText = instructions?.trim();

    if (writer && typeof writer.write === "function") {
      try {
        const promptLines = [
          instructionText || "Rewrite the following text for clarity.",
          "",
          `Original (${normalizedLanguage}):`,
          original || "",
        ];
        const prompt = promptLines.join("\n");
        const result = await writer.write(prompt, instructionText ? { context: instructionText } : undefined);
        return firstNonEmpty(
          typeof result === "string" ? result : "",
          result?.output,
          result?.writtenText,
          fallback()
        );
      } catch (error) {
        console.warn("[AltSpark] Writer write failed, falling back", error);
      }
    }

    if (rewriter && typeof rewriter.rewrite === "function") {
      try {
        const result = await rewriter.rewrite(
          original,
          instructionText ? { context: instructionText, tone: "as-is" } : { tone: "as-is" },
        );
        return firstNonEmpty(
          result?.rewrittenText,
          result?.revisedText,
          result?.result,
          typeof result === "string" ? result : "",
          fallback(),
        );
      } catch (error) {
        console.warn("[AltSpark] Rewriter rewrite failed, falling back", error);
      }
    }

    if (languageSession && typeof languageSession.prompt === "function") {
      try {
        const prompt = `${instructionText || "Rewrite the following text for clarity."}

Original (${normalizedLanguage}):
${original}

Improved:`;
        const response = await languageSession.prompt(prompt, {
          outputLanguage: normalizeOutputLanguage(normalizedLanguage),
        });
        return firstNonEmpty(
          typeof response === "string" ? response : "",
          response?.output,
          fallback()
        );
      } catch (error) {
        console.warn("[AltSpark] LanguageModel prompt failed, falling back", error);
      }
    }

    return fallback();
  }

  requiresActivation() {
    return Boolean(this.activationState.required);
  }

  getActivationState() {
    return { ...this.activationState };
  }

  requestActivation() {
    if (!this.activationState.required) {
      this.setActivationRequired(true);
    }
  }

  setActivationRequired(required) {
    const next = Boolean(required);
    if (this.activationState.required === next) {
      if (next) {
        this.activationListeners.emit({
          required: next,
          timestamp: this.activationState.lastRequestedAt,
        });
      }
      return;
    }
    this.activationState.required = next;
    this.activationState.lastRequestedAt = next ? Date.now() : null;
    this.activationListeners.emit({
      required: next,
      timestamp: this.activationState.lastRequestedAt,
    });
  }
}

// Factory used by the content script so we only expose the public surface
export function createAIClient(options) {
  return new AIClient(options);
}
