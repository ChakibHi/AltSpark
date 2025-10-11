import {
  getSettings,
  watchSettings,
  getSitePreferences,
  setSitePreference,
  watchSitePreferences,
  getMetrics,
  recordAuditMetrics,
  DEFAULT_METRICS,
} from "./storage.js";

import { normalizeCountMap } from "./counts.js";

const MENU_SELECTION = "a11y-copy-helper-selection";
const MENU_PAGE = "a11y-copy-helper-page";
const readyTabs = new Set();
const runningTabs = new Set();
const tabIssueCounts = new Map();
const tabAutomationState = new Map();
const tabAuditDurations = new Map();
const tabLocalModels = new Map();
const autoTabs = new Map();
const autoRetryTimers = new Map();
const AUDIT_COMPLETION_REASONS = new Set(["manual", "auto"]);
const ENABLE_TELEMETRY = false;
const TELEMETRY_WINDOW_MS = 5000;
const telemetryState = ENABLE_TELEMETRY
  ? { messageCounts: new Map(), audits: new Map(), logTimer: null }
  : null;

const offscreenState = {
  creating: null,
  ready: false,
  readyPromise: null,
  resolveReady: null,
};

let cachedSettings = null;
let cachedSitePrefs = {};
let cachedMetrics = { ...DEFAULT_METRICS };
let initializationPromise = null;

function ensureTelemetryLogger() {
  if (!ENABLE_TELEMETRY || !telemetryState) {
    return;
  }
  if (telemetryState.logTimer) {
    return;
  }
  telemetryState.logTimer = setInterval(() => {
    if (!telemetryState.messageCounts.size) {
      return;
    }
    const snapshot = Array.from(telemetryState.messageCounts.entries())
      .map(([key, value]) => `${key}:${value}`)
      .join(", ");
    console.debug(`[Telemetry] messages/${TELEMETRY_WINDOW_MS / 1000}s -> ${snapshot}`);
    telemetryState.messageCounts.clear();
  }, TELEMETRY_WINDOW_MS);
}

function recordTelemetryMessage(type) {
  if (!ENABLE_TELEMETRY || !telemetryState) {
    return;
  }
  ensureTelemetryLogger();
  const next = (telemetryState.messageCounts.get(type) || 0) + 1;
  telemetryState.messageCounts.set(type, next);
}

function recordAuditTelemetry(tabId, state, reason) {
  if (!ENABLE_TELEMETRY || !telemetryState || tabId == null) {
    return;
  }
  if (state?.auditInProgress) {
    telemetryState.audits.set(tabId, { startedAt: Date.now(), reason: reason || "unknown" });
    return;
  }
  const entry = telemetryState.audits.get(tabId);
  if (!entry || !entry.startedAt) {
    return;
  }
  const duration = Date.now() - entry.startedAt;
  telemetryState.audits.delete(tabId);
  console.debug(
    `[Telemetry] audit tab ${tabId} duration=${duration}ms reason=${entry.reason}`,
    state?.counts || {}
  );
}

function resolveOffscreenReady() {
  if (offscreenState.resolveReady) {
    offscreenState.resolveReady(true);
    offscreenState.resolveReady = null;
  }
  if (!offscreenState.readyPromise) {
    offscreenState.readyPromise = Promise.resolve(true);
  }
}

function markOffscreenReady() {
  offscreenState.ready = true;
  resolveOffscreenReady();
}

function ensureOffscreenReadyPromise() {
  if (offscreenState.readyPromise) {
    return offscreenState.readyPromise;
  }
  offscreenState.readyPromise = new Promise((resolve) => {
    offscreenState.resolveReady = resolve;
  });
  return offscreenState.readyPromise;
}

async function ensureOffscreenDocument() {
  if (offscreenState.ready) {
    return true;
  }
  if (!chrome.offscreen?.createDocument) {
    throw new Error("unsupported-offscreen");
  }
  ensureOffscreenReadyPromise();
  if (!offscreenState.creating) {
    offscreenState.creating = (async () => {
      try {
        if (chrome.offscreen.hasDocument) {
          const hasDoc = await chrome.offscreen.hasDocument();
          if (hasDoc) {
            if (!offscreenState.ready) {
              try {
                const response = await chrome.runtime.sendMessage({
                  type: "a11y-copy-helper:offscreen-ping",
                });
                if (response?.ok && response.ready) {
                  markOffscreenReady();
                }
              } catch (pingError) {
                console.warn("[AltSpark] Offscreen ping failed", pingError);
              }
            }
            return;
          }
        }
        await chrome.offscreen.createDocument({
          url: "offscreen.html",
          reasons: ["DOM_PARSER"],
          justification: "Host hidden document for model preparation",
        });
      } catch (error) {
        offscreenState.creating = null;
        throw error;
      }
    })();
  }
  try {
    await offscreenState.creating;
  } catch (error) {
    throw error;
  }
  return ensureOffscreenReadyPromise();
}

chrome.action.setBadgeBackgroundColor({ color: "#2563eb" }).catch(() => {});
if (chrome.action.setBadgeTextColor) {
  chrome.action.setBadgeTextColor({ color: "#ffffff" }).catch(() => {});
}
if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_SELECTION,
    title: "AltSpark: Audit selection",
    contexts: ["selection"],
  });
  chrome.contextMenus.create({
    id: MENU_PAGE,
    title: "AltSpark: Audit page",
    contexts: ["page"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) {
    return;
  }
  if (info.menuItemId === MENU_SELECTION) {
    triggerAudit(tab.id, "selection").catch((error) => {
      console.warn("[AltSpark] Context menu audit failed", error);
    });
  } else if (info.menuItemId === MENU_PAGE) {
    triggerAudit(tab.id, "page").catch((error) => {
      console.warn("[AltSpark] Context menu audit failed", error);
    });
  }
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (!tab?.id) {
    return;
  }
  if (command === "audit-page") {
    triggerAudit(tab.id, "page").catch((error) => {
      console.warn("[AltSpark] Command audit failed", error);
    });
  }
});

function isGlobalAutoEnabled(settings) {
  if (!settings || !settings.autoApplySafe) {
    return false;
  }
  if (settings.extensionPaused || settings.autoApplyPaused || settings.powerSaverMode) {
    return false;
  }
  return true;
}

async function sendActivationNudgeToActiveTab() {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab?.id || !shouldAutoApply(activeTab.url)) {
      return;
    }
    await forwardToContent(activeTab.id, { type: "a11y-copy-helper:activation-nudge" });
  } catch (error) {
    console.warn("[AltSpark] Failed to prompt for activation", error);
  }
}

watchSettings((settings) => {
  const previous = cachedSettings;
  cachedSettings = settings;
  if (previous && !isGlobalAutoEnabled(previous) && isGlobalAutoEnabled(settings)) {
    sendActivationNudgeToActiveTab().catch(() => {});
  }
  syncAutoModeAcrossTabs().catch((error) => {
    console.warn("[AltSpark] Failed to sync auto mode after settings change", error);
  });
});

watchSitePreferences((prefs) => {
  cachedSitePrefs = prefs;
  syncAutoModeAcrossTabs().catch((error) => {
    console.warn("[AltSpark] Failed to sync auto mode after site pref change", error);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading") {
    readyTabs.delete(tabId);
    autoTabs.delete(tabId);
    clearAutoRetry(tabId);
    clearTabState(tabId);
  }
  if (changeInfo.status === "complete" && tab) {
    evaluateTabAutoMode(tab).catch((error) => {
      console.warn("[AltSpark] Failed to evaluate tab for automation", error);
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  readyTabs.delete(tabId);
  autoTabs.delete(tabId);
  clearAutoRetry(tabId);
  tabIssueCounts.delete(tabId);
  tabAutomationState.delete(tabId);
  tabAuditDurations.delete(tabId);
  tabLocalModels.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  recordTelemetryMessage(message?.type || "unknown");
  if (!message || typeof message !== "object") {
    return false;
  }
  if (message.type === "a11y-copy-helper:offscreen-ready") {
    markOffscreenReady();
    sendResponse?.({ ok: true });
    return false;
  }
  if (message.type === "a11y-copy-helper:ensure-offscreen") {
    ensureOffscreenDocument()
      .then(() => sendResponse?.({ ok: true, ready: true }))
      .catch((error) => {
        const code = error?.message === "unsupported-offscreen" ? "unsupported-offscreen" : "offscreen-create-failed";
        sendResponse?.({ ok: false, error: code });
      });
    return true;
  }
  if (message.type === "a11y-copy-helper:state-update" && sender.tab?.id != null) {
    const tabId = sender.tab.id;
    const inProgress = Boolean(message.state?.auditInProgress);
    if (inProgress) {
      runningTabs.add(tabId);
    } else {
      runningTabs.delete(tabId);
    }
    if (message.state?.automation) {
      tabAutomationState.set(tabId, {
        attempted: Boolean(message.state.automation.attempted),
        executed: Boolean(message.state.automation.executed),
        updatedAt: Date.now(),
      });
    } else {
      tabAutomationState.delete(tabId);
    }
    if (Number.isFinite(message.state?.lastAuditDuration)) {
      tabAuditDurations.set(tabId, Number(message.state.lastAuditDuration));
    } else {
      tabAuditDurations.delete(tabId);
    }
    if (message.state?.localModels) {
      tabLocalModels.set(tabId, message.state.localModels);
    } else {
      tabLocalModels.delete(tabId);
    }
    recordAuditTelemetry(tabId, message.state, message.reason);
    updateBadge(tabId);
    if (inProgress) {
      chrome.action.setTitle({ tabId, title: "AltSpark: audit running…" }).catch(() => {});
    } else {
      chrome.action.setTitle({ tabId, title: "AltSpark" }).catch(() => {});
    }
    return false;
  }
  if (message.type === "a11y-copy-helper:ready" && sender.tab?.id != null) {
    readyTabs.add(sender.tab.id);
    if (sender.tab.url && shouldAutoApply(sender.tab.url)) {
      scheduleAutoEnable(sender.tab.id, sender.tab.url);
    }
    return false;
  }
  if (message.type === "a11y-copy-helper:popup-audit") {
    const { tabId, scope = "page" } = message;
    if (typeof tabId === "number") {
      triggerAudit(tabId, scope)
        .then(() => sendResponse?.({ ok: true }))
        .catch((error) => sendResponse?.({ ok: false, error: error?.message }));
      return true;
    }
    sendResponse?.({ ok: false, error: "Missing tabId" });
    return false;
  }
  if (message.type === "a11y-copy-helper:issue-counts" && sender.tab?.id != null) {
    handleIssueCountsMessage(message, sender.tab).catch((error) => {
      console.warn("[AltSpark] Failed to process issue counts", error);
    });
    sendResponse?.({ ok: true });
    return false;
  }
  if (message.type === "a11y-copy-helper:popup-status") {
    handlePopupStatus(message, sendResponse);
    return true;
  }
  if (message.type === "a11y-copy-helper:popup-report") {
    relayPopupCommand(message, sendResponse, () => ({ type: "a11y-copy-helper:get-state" }));
    return true;
  }
  if (message.type === "a11y-copy-helper:popup-apply-issue") {
    relayPopupCommand(message, sendResponse, (msg) => ({
      type: "a11y-copy-helper:apply-issue",
      issueId: msg.issueId,
      replaceText: Boolean(msg.replaceText),
    }));
    return true;
  }
  if (message.type === "a11y-copy-helper:popup-ignore-issue") {
    relayPopupCommand(message, sendResponse, (msg) => ({
      type: "a11y-copy-helper:ignore-issue",
      issueId: msg.issueId,
    }));
    return true;
  }
  if (message.type === "a11y-copy-helper:popup-apply-safe") {
    relayPopupCommand(message, sendResponse, () => ({ type: "a11y-copy-helper:apply-safe" }));
    return true;
  }
  if (message.type === "a11y-copy-helper:popup-revert-all") {
    relayPopupCommand(message, sendResponse, () => ({ type: "a11y-copy-helper:revert-all" }));
    return true;
  }
  if (message.type === "a11y-copy-helper:test-run-audit") {
    const { tabId, scope = "page" } = message;
    if (typeof tabId !== "number") {
      sendResponse?.({ ok: false, error: "Missing tabId" });
      return false;
    }
    triggerAudit(tabId, scope)
      .then(() => forwardToContent(tabId, { type: "a11y-copy-helper:get-state" }))
      .then((state) => sendResponse?.({ ok: true, state }))
      .catch((error) => sendResponse?.({ ok: false, error: error?.message || "test audit failed" }));
    return true;
  }
  if (message.type === "a11y-copy-helper:test-run-audit-current") {
    const tabId = sender.tab?.id ?? null;
    const scope = typeof message.scope === "string" ? message.scope : "page";
    if (tabId == null) {
      sendResponse?.({ ok: false, error: "Missing tab context" });
      return false;
    }
    triggerAudit(tabId, scope)
      .then(() => forwardToContent(tabId, { type: "a11y-copy-helper:get-state" }))
      .then((state) => sendResponse?.({ ok: true, state }))
      .catch((error) => sendResponse?.({ ok: false, error: error?.message || "test audit failed" }));
    return true;
  }
  if (message.type === "a11y-copy-helper:popup-open-overlay") {
    const tabId = typeof message.tabId === "number" ? message.tabId : sender.tab?.id ?? null;
    if (tabId == null) {
      sendResponse?.({ ok: false, error: "Missing tabId" });
      return false;
    }
    openSidePanel(tabId)
      .then(() => sendResponse?.({ ok: true }))
      .catch((error) => sendResponse?.({ ok: false, error: error?.message || "Unable to open panel" }));
    return true;
  }
  if (message.type === "a11y-copy-helper:open-side-panel") {
    const tabId = typeof message.tabId === "number" ? message.tabId : sender.tab?.id ?? null;
    if (tabId == null) {
      sendResponse?.({ ok: false, error: "Missing tabId" });
      return false;
    }
    openSidePanel(tabId)
      .then(() => sendResponse?.({ ok: true }))
      .catch((error) => sendResponse?.({ ok: false, error: error?.message || "Unable to open panel" }));
    return true;
  }
  if (message.type === "a11y-copy-helper:open-side-panel-settings") {
    const tabId = typeof message.tabId === "number" ? message.tabId : sender.tab?.id ?? null;
    if (tabId == null) {
      sendResponse?.({ ok: false, error: "Missing tabId" });
      return false;
    }
    openSidePanel(tabId)
      .then(() => focusSidePanelView(tabId, "settings"))
      .then(() => sendResponse?.({ ok: true }))
      .catch((error) => sendResponse?.({ ok: false, error: error?.message || "Unable to open settings" }));
    return true;
  }
  if (message.type === "a11y-copy-helper:panel-get-state") {
    relayPanelCommand(message, sender, sendResponse, () => ({ type: "a11y-copy-helper:get-state" }));
    return true;
  }
  if (message.type === "a11y-copy-helper:panel-apply-issue") {
    relayPanelCommand(message, sender, sendResponse, (msg) => ({
      type: "a11y-copy-helper:apply-issue",
      issueId: msg.issueId,
      replaceText: Boolean(msg.replaceText),
    }));
    return true;
  }
  if (message.type === "a11y-copy-helper:panel-ignore-issue") {
    relayPanelCommand(message, sender, sendResponse, (msg) => ({
      type: "a11y-copy-helper:ignore-issue",
      issueId: msg.issueId,
    }));
    return true;
  }
  if (message.type === "a11y-copy-helper:panel-apply-safe") {
    relayPanelCommand(message, sender, sendResponse, () => ({ type: "a11y-copy-helper:apply-safe" }));
    return true;
  }
  if (message.type === "a11y-copy-helper:panel-revert-all") {
    relayPanelCommand(message, sender, sendResponse, () => ({ type: "a11y-copy-helper:revert-all" }));
    return true;
  }
  if (message.type === "a11y-copy-helper:panel-highlight") {
    relayPanelCommand(message, sender, sendResponse, (msg) => ({
      type: "a11y-copy-helper:panel-highlight",
      issueId: msg.issueId,
      scroll: Boolean(msg.scroll),
      pulse: Boolean(msg.pulse),
    }));
    return true;
  }
  if (message.type === "a11y-copy-helper:panel-clear-highlight") {
    relayPanelCommand(message, sender, sendResponse, () => ({ type: "a11y-copy-helper:panel-clear-highlight" }));
    return true;
  }
  if (message.type === "a11y-copy-helper:panel-visibility") {
    relayPanelCommand(message, sender, sendResponse, (msg) => ({
      type: "a11y-copy-helper:panel-visibility",
      visible: Boolean(msg.visible),
    }));
    return true;
  }
  if (message.type === "a11y-copy-helper:update-site-pref") {
    handleSitePreferenceUpdate(message, sendResponse);
    return true;
  }
  return false;
});

async function handlePopupStatus(message, sendResponse) {
  try {
    await ensureInitialized();
    let tab = null;
    if (typeof message.tabId === "number") {
      tab = await chrome.tabs.get(message.tabId);
    } else {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tab = activeTab || null;
    }
    const tabId = tab?.id ?? null;
    const url = tab?.url || null;
    const host = getHost(url);
    const countsEntry = tabId != null ? tabIssueCounts.get(tabId) : null;
    const counts = normalizeCountMap(countsEntry);
    const automationInfo = tabId != null ? tabAutomationState.get(tabId) : null;
    const duration = tabId != null ? tabAuditDurations.get(tabId) : null;
    const sitePreference = host ? getSitePreferenceSync(host) : { paused: false, whitelisted: false, neverAuto: false };
    const automationActive = Boolean(tab && url && shouldAutoApply(url));
    const metrics = cachedMetrics ? { ...DEFAULT_METRICS, ...cachedMetrics } : { ...DEFAULT_METRICS };
    sendResponse({
      ok: true,
      data: {
        tabId,
        host,
        url,
        counts,
        metrics,
        settings: {
          autoApplySafe: Boolean(cachedSettings?.autoApplySafe),
          extensionPaused: Boolean(cachedSettings?.extensionPaused),
          autoApplyPaused: Boolean(cachedSettings?.autoApplyPaused),
          powerSaverMode: Boolean(cachedSettings?.powerSaverMode),
        },
        sitePreference,
        automationActive,
        automation: {
          attempted: Boolean(automationInfo?.attempted),
          executed: Boolean(automationInfo?.executed),
        },
        auditDurationMs: Number.isFinite(duration) ? duration : null,
        localModels: tabLocalModels.get(tabId) || null,
      },
    });
  } catch (error) {
    sendResponse({ ok: false, error: error?.message || "Failed to read popup status" });
  }
}

async function handleSitePreferenceUpdate(message, sendResponse) {
  try {
    await ensureInitialized();
    let host = typeof message.hostname === "string" ? message.hostname : null;
    if (!host && typeof message.url === "string") {
      host = getHost(message.url);
    }
    if (!host && typeof message.tabId === "number") {
      const tab = await chrome.tabs.get(message.tabId);
      host = getHost(tab?.url);
    }
    if (!host) {
      throw new Error("No hostname available");
    }
    const normalizedHost = host.toLowerCase();
    const updates = {};
    if (typeof message.paused === "boolean") {
      updates.paused = message.paused;
    }
    if (typeof message.whitelisted === "boolean") {
      updates.whitelisted = message.whitelisted;
    }
    if (typeof message.neverAuto === "boolean") {
      updates.neverAuto = message.neverAuto;
    }
    const preference = await setSitePreference(normalizedHost, updates);
    cachedSitePrefs = await getSitePreferences();
    await evaluateTabsForHost(normalizedHost);
    sendResponse({ ok: true, host: normalizedHost, preference });
  } catch (error) {
    console.warn("[AltSpark] Failed to update site preference", error);
    sendResponse({ ok: false, error: error?.message || "Failed to update site preference" });
  }
}

async function handleIssueCountsMessage(message, tab) {
  if (!tab?.id) {
    return;
  }
  const tabId = tab.id;
  const url = tab.url || message.pageUrl || null;
  const host = getHost(url);
  const counts = normalizeCountMap(message.counts);
  const reason = typeof message.reason === "string" ? message.reason : null;
  const auditId = message.auditId != null ? String(message.auditId) : null;
  const signature = buildCountSignature(counts);
  const entry = { ...counts, host, url, updatedAt: Date.now(), auditId, signature };
  const previous = tabIssueCounts.get(tabId);
  tabIssueCounts.set(tabId, entry);
  updateBadge(tabId);
  if (shouldRecordLifetime(previous, entry, reason)) {
    try {
      cachedMetrics = await recordAuditMetrics(counts);
    } catch (error) {
      console.warn('[AltSpark] Failed to persist lifetime metrics', error);
    }
  }
}

function shouldRecordLifetime(previous, entry, reason) {
  if (!isAuditCompletionReason(reason)) {
    return false;
  }
  if (entry.auditId && entry.auditId !== previous?.auditId) {
    return true;
  }
  if (!previous) {
    return true;
  }
  if (!entry.auditId && previous?.auditId && previous.auditId !== entry.auditId) {
    return true;
  }
  if (!entry.auditId && !previous?.auditId && entry.signature !== previous.signature) {
    return true;
  }
  return false;
}

function isAuditCompletionReason(reason) {
  return typeof reason === 'string' && AUDIT_COMPLETION_REASONS.has(reason);
}

function buildCountSignature(counts = {}) {
  return [counts.total, counts.applied, counts.ignored, counts.autoApplied, counts.pending]
    .map((value) => (Number.isFinite(value) ? value : 0))
    .join('|');
}

function updateBadge(tabId) {
  if (runningTabs.has(tabId)) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#f59e0b" }).catch(() => {}); // amber
    chrome.action.setBadgeText({ tabId, text: "…" }).catch(() => {});
    return;
  }
  const counts = tabIssueCounts.get(tabId);
  const pending = counts?.pending || 0;
  const text = pending > 0 ? String(Math.min(pending, 9999)) : "";
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
}

function clearTabState(tabId) {
  tabIssueCounts.delete(tabId);
  tabAutomationState.delete(tabId);
  tabAuditDurations.delete(tabId);
  tabLocalModels.delete(tabId);
  updateBadge(tabId);
}

function getHost(url) {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) {
      return null;
    }
    return parsed.hostname.toLowerCase();
  } catch (_error) {
    return null;
  }
}

function getSitePreferenceSync(host) {
  if (!host) {
    return { paused: false, whitelisted: false, neverAuto: false };
  }
  return cachedSitePrefs[host] || { paused: false, whitelisted: false, neverAuto: false };
}

async function triggerAudit(tabId, scope) {
  await ensureInitialized();
  if (cachedSettings?.extensionPaused) {
    throw new Error('Extension is paused');
  }
  await ensureContent(tabId);
  try {
    await chrome.tabs.sendMessage(tabId, { type: "a11y-copy-helper:audit", scope });
  } catch (error) {
    console.warn("[AltSpark] audit send failed, retrying", error);
    readyTabs.delete(tabId);
    await ensureContent(tabId);
    await chrome.tabs.sendMessage(tabId, { type: "a11y-copy-helper:audit", scope });
  }
}

async function ensureContent(tabId) {
  if (readyTabs.has(tabId)) {
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  } catch (error) {
    console.warn("[AltSpark] failed to inject content script", error);
  }
}

function shouldAutoApply(url) {
  if (cachedSettings?.extensionPaused) {
    return false;
  }
  if (!cachedSettings?.autoApplySafe) {
    return false;
  }
  if (cachedSettings?.autoApplyPaused) {
    return false;
  }
  if (cachedSettings?.powerSaverMode) {
    return false;
  }
  const host = getHost(url);
  if (!host) {
    return false;
  }
  const preference = cachedSitePrefs[host];
  if (preference?.whitelisted || preference?.paused || preference?.neverAuto) {
    return false;
  }
  return true;
}

function clearAutoRetry(tabId) {
  const timer = autoRetryTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
    autoRetryTimers.delete(tabId);
  }
}

function scheduleAutoEnable(tabId, url) {
  if (!shouldAutoApply(url)) {
    return;
  }
  clearAutoRetry(tabId);
  const timer = setTimeout(() => {
    autoRetryTimers.delete(tabId);
    enableAutoForTab(tabId, url).catch((error) => {
      console.warn("[AltSpark] Failed to enable auto mode", error);
    });
  }, 800);
  autoRetryTimers.set(tabId, timer);
}

async function enableAutoForTab(tabId, url) {
  if (!shouldAutoApply(url)) {
    await disableAutoForTab(tabId);
    return;
  }
  await ensureContent(tabId);
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "a11y-copy-helper:auto-config",
      enabled: true,
      scope: "page",
    });
    autoTabs.set(tabId, true);
  } catch (error) {
    readyTabs.delete(tabId);
    autoTabs.delete(tabId);
    scheduleAutoEnable(tabId, url);
    console.warn("[AltSpark] Failed to enable auto mode", error);
  }
}

async function disableAutoForTab(tabId) {
  clearAutoRetry(tabId);
  if (!autoTabs.has(tabId)) {
    return;
  }
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "a11y-copy-helper:auto-config",
      enabled: false,
    });
  } catch (_error) {
    // ignore
  } finally {
    autoTabs.delete(tabId);
  }
}

async function evaluateTabAutoMode(tab) {
  if (!tab?.id) {
    return;
  }
  if (!tab.url || !shouldAutoApply(tab.url)) {
    await disableAutoForTab(tab.id);
    const host = getHost(tab.url);
    const pref = host ? getSitePreferenceSync(host) : null;
    if (pref?.paused || pref?.whitelisted) {
      clearTabState(tab.id);
    }
    return;
  }
  await enableAutoForTab(tab.id, tab.url);
}

async function evaluateTabsForHost(host) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab?.id || !tab.url) {
      continue;
    }
    if (getHost(tab.url) === host) {
      await evaluateTabAutoMode(tab);
    }
  }
}

async function syncAutoModeAcrossTabs() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    await evaluateTabAutoMode(tab);
  }
}

function ensureInitialized() {
  if (!initializationPromise) {
    initializationPromise = initializeState();
  }
  return initializationPromise;
}

const CONNECTION_ERROR_FRAGMENT = "receiving end does not exist";

function isMissingReceiverError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return message.includes(CONNECTION_ERROR_FRAGMENT);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openSidePanel(tabId) {
  if (!Number.isInteger(tabId)) {
    throw new Error("Missing tab id");
  }
  if (!chrome.sidePanel?.open) {
    throw new Error("Side panel API unavailable");
  }
  return chrome.sidePanel.open({ tabId });
}

async function focusSidePanelView(tabId, view, attempt = 0) {
  try {
    await chrome.runtime.sendMessage({ type: 'a11y-copy-helper:panel-focus-view', tabId, view });
  } catch (error) {
    if (isMissingReceiverError(error) && attempt < 3) {
      await delay(160 * (attempt + 1));
      return focusSidePanelView(tabId, view, attempt + 1);
    }
    throw error;
  }
}

function resolveCommandTabId(message, sender) {
  if (typeof message?.tabId === "number") {
    return message.tabId;
  }
  if (sender?.tab?.id != null) {
    return sender.tab.id;
  }
  return null;
}

function relayPanelCommand(message, sender, sendResponse, buildPayload) {
  const tabId = resolveCommandTabId(message, sender);
  if (tabId == null) {
    sendResponse?.({ ok: false, error: "Missing tabId" });
    return false;
  }
  forwardToContent(tabId, buildPayload(message))
    .then((result) => {
      if (result && typeof result === "object" && "ok" in result) {
        sendResponse?.(result);
      } else {
        sendResponse?.({ ok: true, data: result });
      }
    })
    .catch((error) => {
      console.warn("[AltSpark] Panel relay failed", error);
      sendResponse?.({ ok: false, error: error?.message || "Unable to reach page" });
    });
  return true;
}

function relayPopupCommand(message, sendResponse, buildPayload) {
  const tabId = typeof message.tabId === "number" ? message.tabId : null;
  if (tabId == null) {
    sendResponse({ ok: false, error: "Missing tabId" });
    return;
  }
  forwardToContent(tabId, buildPayload(message))
    .then((result) => {
      if (result && typeof result === "object" && "ok" in result) {
        sendResponse(result);
      } else {
        sendResponse({ ok: true, data: result });
      }
    })
    .catch((error) => {
      console.warn("[AltSpark] Popup relay failed", error);
      sendResponse({ ok: false, error: error?.message || "Unable to reach page" });
    });
}

async function forwardToContent(tabId, payload, attempt = 0) {
  await ensureInitialized();
  await ensureContent(tabId);
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch (error) {
    if (isMissingReceiverError(error)) {
      readyTabs.delete(tabId);
      if (attempt < 2) {
        await delay(120 * (attempt + 1));
        return forwardToContent(tabId, payload, attempt + 1);
      }
      throw new Error("Content script unavailable. Try reloading the page.");
    }
    throw error;
  }
}

async function initializeState() {
  try {
    cachedSettings = await getSettings();
  } catch (error) {
    console.warn("[AltSpark] Failed to load initial settings", error);
    cachedSettings = cachedSettings && typeof cachedSettings === "object"
      ? cachedSettings
      : { autoApplySafe: false };
  }
  try {
    cachedSitePrefs = await getSitePreferences();
  } catch (error) {
    console.warn("[AltSpark] Failed to load site preferences", error);
    cachedSitePrefs = cachedSitePrefs && typeof cachedSitePrefs === "object"
      ? cachedSitePrefs
      : {};
  }
  try {
    cachedMetrics = await getMetrics();
  } catch (error) {
    console.warn("[AltSpark] Failed to load metrics", error);
    cachedMetrics = { ...DEFAULT_METRICS };
  }
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      await evaluateTabAutoMode(tab);
    }
  } catch (error) {
    console.warn("[AltSpark] Failed to initialize auto mode", error);
  }
  ensureOffscreenDocument().catch(() => {});
}

ensureInitialized();

try {
  if (typeof globalThis !== "undefined") {
    globalThis.__A11Y_TEST_TRIGGER_AUDIT__ = triggerAudit;
    globalThis.__A11Y_TEST_GET_STATE__ = async (tabId) =>
      forwardToContent(tabId, { type: "a11y-copy-helper:get-state" });
  }
} catch (error) {
  console.warn("[AltSpark] Test harness hooks unavailable", error);
}
