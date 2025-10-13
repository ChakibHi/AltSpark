const STORAGE_KEY = "a11yCopyHelperSettings";

export const DEFAULT_SETTINGS = {
  auditImages: true,
  auditLinks: true,
  auditHeadings: true,
  preferAriaLabel: true,
  offerTranslations: true,
  userLanguage: "auto",
  autoModeEnabled: false,
  extensionPaused: false,
  autoApplyPaused: false,
  powerSaverMode: false,
};

const schema = {
  auditImages: "boolean",
  auditLinks: "boolean",
  auditHeadings: "boolean",
  preferAriaLabel: "boolean",
  offerTranslations: "boolean",
  userLanguage: "string",
  autoModeEnabled: "boolean",
  extensionPaused: "boolean",
  autoApplyPaused: "boolean",
  powerSaverMode: "boolean",
};

const SITE_PREFS_KEY = "a11yCopyHelperSitePrefs";

const SITE_PREF_SCHEMA = {
  paused: "boolean",
  whitelisted: "boolean",
  neverAuto: "boolean",
};

export const DEFAULT_METRICS = {
  lifetimeFindings: 0,
  lifetimeApplied: 0,
  lifetimeAutoApplied: 0,
  lifetimeIgnored: 0,
};

const METRICS_KEY = "a11yCopyHelperMetrics";

function getArea() {
  if (chrome?.storage?.sync) {
    return chrome.storage.sync;
  }
  return chrome.storage.local;
}

function coerceSettings(raw) {
  const clean = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== "object") {
    return clean;
  }
  for (const key of Object.keys(schema)) {
    if (typeof raw[key] === schema[key]) {
      clean[key] = raw[key];
    }
  }
  if (clean.userLanguage !== "auto" && typeof clean.userLanguage === "string") {
    clean.userLanguage = clean.userLanguage.slice(0, 35);
  }
  if (typeof raw?.autoModeEnabled !== "boolean" && typeof raw?.autoApplySafe === "boolean") {
    clean.autoModeEnabled = Boolean(raw.autoApplySafe);
  }
  return clean;
}

export async function getSettings() {
  const area = getArea();
  try {
    const result = await area.get(STORAGE_KEY);
    return coerceSettings(result?.[STORAGE_KEY]);
  } catch (error) {
    console.warn("[AltSpark] Failed to read settings, using defaults", error);
    return { ...DEFAULT_SETTINGS };
  }
}

export async function setSettings(partial) {
  let payload = partial || {};
  if (payload && typeof payload === "object" && typeof payload.autoApplySafe === "boolean" && typeof payload.autoModeEnabled !== "boolean") {
    payload = { ...payload, autoModeEnabled: payload.autoApplySafe };
    delete payload.autoApplySafe;
  }
  const area = getArea();
  const current = await getSettings();
  const next = coerceSettings({ ...current, ...payload });
  try {
    await area.set({ [STORAGE_KEY]: next });
    return next;
  } catch (error) {
    console.warn("[AltSpark] Failed to save settings", error);
    throw error;
  }
}

export function watchSettings(callback) {
  const listener = (changes) => {
    if (changes[STORAGE_KEY]) {
      callback(coerceSettings(changes[STORAGE_KEY].newValue));
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

export function resolveUserLanguage(settings) {
  if (!settings || settings.userLanguage === "auto") {
    return navigator.language || "en";
  }
  return settings.userLanguage;
}

function coerceSitePreferences(raw) {
  const clean = {};
  if (!raw || typeof raw !== "object") {
    return clean;
  }
  for (const [host, prefs] of Object.entries(raw)) {
    if (typeof host !== "string" || !host) {
      continue;
    }
    const canonicalHost = host.slice(0, 255).toLowerCase();
    const entry = { paused: false, whitelisted: false };
    if (prefs && typeof prefs === "object") {
      for (const key of Object.keys(SITE_PREF_SCHEMA)) {
        if (typeof prefs[key] === SITE_PREF_SCHEMA[key]) {
          entry[key] = prefs[key];
        }
      }
    }
    clean[canonicalHost] = entry;
  }
  return clean;
}

export async function getSitePreferences() {
  const area = getArea();
  try {
    const result = await area.get(SITE_PREFS_KEY);
    return coerceSitePreferences(result?.[SITE_PREFS_KEY]);
  } catch (error) {
    console.warn("[AltSpark] Failed to read site preferences", error);
    return {};
  }
}

export async function getSitePreference(hostname) {
  if (!hostname) {
    return { paused: false, whitelisted: false, neverAuto: false };
  }
  const all = await getSitePreferences();
  return all[hostname.toLowerCase()] || { paused: false, whitelisted: false, neverAuto: false };
}

export async function setSitePreference(hostname, updates) {
  if (!hostname) {
    throw new Error("Missing hostname");
  }
  const canonicalHost = hostname.toLowerCase();
  const area = getArea();
  const all = await getSitePreferences();
  const current = all[canonicalHost] || { paused: false, whitelisted: false, neverAuto: false };
  const next = { ...current };
  if (typeof updates?.paused === "boolean") {
    next.paused = updates.paused;
  }
  if (typeof updates?.whitelisted === "boolean") {
    next.whitelisted = updates.whitelisted;
  }
  if (typeof updates?.neverAuto === "boolean") {
    next.neverAuto = updates.neverAuto;
  }
  const merged = { ...all };
  if (!next.paused && !next.whitelisted && !next.neverAuto) {
    delete merged[canonicalHost];
  } else {
    merged[canonicalHost] = next;
  }
  try {
    await area.set({ [SITE_PREFS_KEY]: merged });
    return next;
  } catch (error) {
    console.warn("[AltSpark] Failed to update site preference", error);
    throw error;
  }
}

export function watchSitePreferences(callback) {
  const listener = (changes) => {
    if (changes[SITE_PREFS_KEY]) {
      callback(coerceSitePreferences(changes[SITE_PREFS_KEY].newValue));
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

function coerceMetrics(raw) {
  const clean = { ...DEFAULT_METRICS };
  if (!raw || typeof raw !== "object") {
    return clean;
  }
  for (const key of Object.keys(clean)) {
    const value = Number(raw[key]);
    if (Number.isFinite(value) && value >= 0) {
      clean[key] = value;
    }
  }
  return clean;
}

export async function getMetrics() {
  const area = getArea();
  try {
    const result = await area.get(METRICS_KEY);
    return coerceMetrics(result?.[METRICS_KEY]);
  } catch (error) {
    console.warn("[AltSpark] Failed to read metrics, using defaults", error);
    return { ...DEFAULT_METRICS };
  }
}

export async function updateMetrics(updater) {
  const area = getArea();
  let current = await getMetrics();
  const nextState = typeof updater === "function" ? updater({ ...current }) : current;
  const next = coerceMetrics(nextState);
  try {
    await area.set({ [METRICS_KEY]: next });
    return next;
  } catch (error) {
    console.warn("[AltSpark] Failed to update metrics", error);
    throw error;
  }
}

export async function recordAuditMetrics(counts) {
  if (!counts || typeof counts !== "object") {
    return updateMetrics();
  }
  const totals = {
    total: Number(counts.total) || 0,
    applied: Number(counts.applied) || 0,
    autoApplied: Number(counts.autoApplied) || 0,
    ignored: Number(counts.ignored) || 0,
  };
  return updateMetrics((metrics) => {
    metrics.lifetimeFindings += Math.max(0, totals.total);
    metrics.lifetimeApplied += Math.max(0, totals.applied);
    metrics.lifetimeAutoApplied += Math.max(0, totals.autoApplied);
    metrics.lifetimeIgnored += Math.max(0, totals.ignored);
    return metrics;
  });
}
