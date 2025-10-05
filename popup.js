(async () => {
  const storage = await import(chrome.runtime.getURL("storage.js"));
  const { clampToNonNegativeInt, normalizeCountMap } = await import(chrome.runtime.getURL("counts.js"));

  const dom = {
    message: document.getElementById("status-message"),
    autopilotStatus: document.getElementById("autopilot-status"),
    auditDuration: document.getElementById("audit-duration"),
    findingsState: document.getElementById("findings-state"),
    primaryAction: document.getElementById("primary-action"),
    secondaryAction: document.getElementById("secondary-action"),
    openPanel: document.getElementById("open-panel"),
    toggleAutopilot: document.getElementById("toggle-autopilot"),
    // Site-level controls moved to side panel for a simpler popup.
    toggleSiteAuto: document.getElementById("toggle-site-auto"),
    toggleSitePause: document.getElementById("toggle-site-pause"),
    siteSection: document.getElementById("site-controls"),
    siteLabel: document.getElementById("site-label"),
    openSettings: document.getElementById("open-settings"),
    counters: {
      pending: document.getElementById("count-pending"),
      applied: document.getElementById("count-applied"),
    },
  };

  const DEFAULT_COUNTS = { total: 0, applied: 0, ignored: 0, autoApplied: 0, pending: 0 };
  const DEFAULT_METRICS = { lifetimeFindings: 0, lifetimeApplied: 0, lifetimeAutoApplied: 0, lifetimeIgnored: 0 };

  let lastStatus = null;
  let refreshing = false;

  attachEventListeners();
  await refreshStatus();

  function attachEventListeners() {
    dom.primaryAction?.addEventListener("click", handlePrimaryAction);
    dom.secondaryAction?.addEventListener("click", handleSecondaryAction);
    dom.openPanel?.addEventListener("click", () => {
      openSidePanel()
        .then(closeIfPossible)
        .catch((error) => {
          console.warn("[AltSpark] Failed to open side panel", error);
          setStatusMessage(error?.message || "Unable to open side panel", "error");
        });
    });

    dom.toggleAutopilot?.addEventListener("change", () => {
      if (!lastStatus) {
        dom.toggleAutopilot.checked = false;
        return;
      }
      const paused = dom.toggleAutopilot.checked;
      updateGlobalSetting({ autoApplyPaused: paused });
    });

    // Site-level toggles are handled in the side panel; popup keeps global basics only.

    dom.openSettings?.addEventListener("click", () => {
      openSidePanel({ focus: "settings" })
        .then(closeIfPossible)
        .catch((error) => {
          console.warn("[AltSpark] Failed to open settings", error);
          setStatusMessage(error?.message || "Unable to open settings", "error");
        });
    });
  }

  async function refreshStatus() {
    if (refreshing) {
      return;
    }
    refreshing = true;
    setStatusMessage("Loading...", "info");
    toggleInputs(true);
    try {
      const response = await chrome.runtime.sendMessage({ type: "a11y-copy-helper:popup-status" });
      if (!response?.ok) {
        throw new Error(response?.error || "Status unavailable");
      }
      const data = response.data || {};
      lastStatus = {
        tabId: typeof data.tabId === "number" ? data.tabId : null,
        host: typeof data.host === "string" ? data.host : null,
        url: typeof data.url === "string" ? data.url : null,
        counts: sanitizeCounts(data.counts),
        metrics: sanitizeMetrics(data.metrics),
        settings: data.settings || {},
        sitePreference: data.sitePreference || { paused: false, whitelisted: false, neverAuto: false },
        automationActive: Boolean(data.automationActive),
        automation: data.automation || { attempted: false, executed: false },
        auditDurationMs: Number(data.auditDurationMs),
      };
      updateStatusStrip();
      updateFindingsState();
      updateActions();
      updateCounters();
      // Site controls are intentionally hidden to keep popup minimal.
      updateMessage();
    } catch (error) {
      console.error("[AltSpark] Failed to load popup status", error);
      lastStatus = null;
      resetUiToDefaults();
      setStatusMessage(error?.message || "Unable to read active tab", "error");
    } finally {
      refreshing = false;
      toggleInputs(false);
      syncControls();
    }
  }

  function handlePrimaryAction() {
    handleAction(dom.primaryAction);
  }

  function handleSecondaryAction() {
    handleAction(dom.secondaryAction);
  }

  function handleAction(button) {
    if (!button) {
      return;
    }
    const action = button.dataset.action;
    if (action === "scan") {
      startScan(button);
    } else if (action === "quick-fix") {
      startQuickFix(button);
    }
  }

  async function startQuickFix(button) {
    if (!button || !lastStatus?.tabId) {
      return;
    }
    const previousLabel = button.textContent;
    button.dataset.loading = "true";
    button.disabled = true;
    setStatusMessage("Applying safe fixes…", "info");
    try {
      const applied = await applySafeWithAuditIfNeeded();
      if (applied) {
        setStatusMessage("Safe fixes applied. Review details in Side Panel.", "success");
        // Optionally bring up side panel for visibility.
        // await openSidePanel();
        // closeIfPossible();
      } else {
        setStatusMessage("No safe fixes to apply.", "info");
      }
    } catch (error) {
      console.error("[AltSpark] Quick fix failed", error);
      setStatusMessage(error?.message || "Quick fix failed", "error");
    } finally {
      delete button.dataset.loading;
      button.textContent = previousLabel;
      button.disabled = false;
      try { await refreshStatus(); } catch (_) {}
    }
  }

  async function applySafeWithAuditIfNeeded() {
    // Try to apply immediately.
    const okNow = await tryApplySafe();
    if (okNow.ok) {
      return okNow.applied;
    }
    // If we need an audit first, run it and wait for completion.
    await runAuditAndWaitForCompletion();
    const okAfter = await tryApplySafe();
    return okAfter.ok && okAfter.applied;
  }

  async function tryApplySafe() {
    if (!lastStatus?.tabId) {
      return { ok: false, applied: false };
    }
    try {
      const response = await chrome.runtime.sendMessage({
        type: "a11y-copy-helper:popup-apply-safe",
        tabId: lastStatus.tabId,
      });
      if (!response?.ok) {
        return { ok: false, applied: false, error: response?.error || "apply-safe failed" };
      }
      const applied = clampToNonNegativeInt(response?.state?.counts?.applied);
      return { ok: true, applied: applied > 0 };
    } catch (error) {
      return { ok: false, applied: false, error: error?.message };
    }
  }

  async function runAuditAndWaitForCompletion(timeoutMs = 15000) {
    if (!lastStatus?.tabId) {
      throw new Error("No active tab");
    }
    await chrome.runtime.sendMessage({
      type: "a11y-copy-helper:popup-audit",
      tabId: lastStatus.tabId,
      scope: "page",
    });
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const report = await chrome.runtime.sendMessage({
          type: "a11y-copy-helper:popup-report",
          tabId: lastStatus.tabId,
        });
        if (report?.ok && report.state) {
          const state = report.state;
          if (!state.auditInProgress && state.hasReport) {
            return true;
          }
        }
      } catch (_err) {
        // keep polling
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    // Timeout: surface a gentle warning but do not throw hard.
    throw new Error("Audit did not complete in time");
  }

  async function startScan(button) {
    if (!button || !lastStatus?.tabId) {
      return;
    }
    const previousLabel = button.textContent;
    button.dataset.loading = "true";
    button.disabled = true;
    button.textContent = "Scanning...";
    try {
      const response = await chrome.runtime.sendMessage({
        type: "a11y-copy-helper:popup-audit",
        tabId: lastStatus.tabId,
        scope: "page",
      });
      if (!response?.ok) {
        throw new Error(response?.error || "Scan failed");
      }
      closeIfPossible();
    } catch (error) {
      console.error("[AltSpark] Failed to launch scan", error);
      setStatusMessage(error?.message || "Unable to start scan", "error");
    } finally {
      button.dataset.loading = "false";
      button.textContent = previousLabel;
      button.disabled = false;
    }
  }

  function updateStatusStrip() {
    if (!dom.autopilotStatus || !dom.auditDuration) {
      return;
    }
    const settings = lastStatus?.settings || {};
    const autopilotState = determineAutopilotState(settings);
    dom.autopilotStatus.textContent = `Autopilot: ${autopilotState.label}`;
    dom.autopilotStatus.dataset.tone = autopilotState.tone;
    if (autopilotState.title) {
      dom.autopilotStatus.title = autopilotState.title;
    } else {
      dom.autopilotStatus.removeAttribute("title");
    }

    const ms = Number(lastStatus?.auditDurationMs);
    const durationText = Number.isFinite(ms) && ms > 0 ? `Last audit: ${formatDuration(ms)}` : "Last audit: --";
    dom.auditDuration.textContent = durationText;
  }

  function updateFindingsState() {
    if (!dom.findingsState) {
      return;
    }
    const counts = lastStatus?.counts || DEFAULT_COUNTS;
    const pending = computePendingCount();
    if (pending > 0) {
      dom.findingsState.textContent = `${formatNumber(pending)} new since load`;
      dom.findingsState.dataset.tone = "alert";
      return;
    }
    if (hasAuditResult(counts)) {
      dom.findingsState.textContent = "Up to date";
      dom.findingsState.dataset.tone = "success";
      return;
    }
    dom.findingsState.textContent = "Scan needed";
    dom.findingsState.dataset.tone = "neutral";
  }

  function updateActions() {
    // Keep popup actions simple and predictable.
    configureActionButton(dom.primaryAction, { action: "quick-fix", label: "Quick Fix" });
    configureActionButton(dom.secondaryAction, { action: "scan", label: "Scan" });
  }

  function updateCounters() {
    const counts = lastStatus?.counts || DEFAULT_COUNTS;
    const pending = computePendingCount();
    if (dom.counters?.pending) {
      dom.counters.pending.textContent = formatNumber(pending);
    }
    if (dom.counters?.applied) {
      const applied = clampToNonNegativeInt(Number(counts.applied));
      dom.counters.applied.textContent = formatNumber(applied);
    }
  }

  function updateMessage() {
    if (!dom.message) {
      return;
    }
    if (!lastStatus) {
      setStatusMessage("Open a tab to start.", "info");
      return;
    }
    const { settings = {}, sitePreference = {}, automationActive, automation = {} } = lastStatus;
    if (settings.extensionPaused) {
      setStatusMessage("Extension is paused. Resume Autopilot in Settings.", "warning");
      return;
    }
    if (settings.powerSaverMode) {
      setStatusMessage("Power saver is on. Scans run on significant changes.", "info");
      return;
    }
    if (!settings.autoApplySafe) {
      setStatusMessage("Autopilot is off in Settings.", "info");
      return;
    }
    if (settings.autoApplyPaused) {
      setStatusMessage("Autopilot is paused across all sites.", "info");
      return;
    }
    if (sitePreference.paused) {
      setStatusMessage("Paused on this site.", "info");
      return;
    }
    if (sitePreference.neverAuto) {
      setStatusMessage("Autopilot is disabled for this site.", "info");
      return;
    }
    if (automation.executed) {
      const appliedCount = clampToNonNegativeInt(lastStatus?.counts?.applied);
      const durationText = formatDuration(lastStatus?.auditDurationMs);
      const issueLabel = appliedCount === 1 ? "fix" : "fixes";
      const prefix = appliedCount > 0
        ? `Autopilot applied ${formatNumber(appliedCount)} ${issueLabel}`
        : "Autopilot applied safe fixes";
      const suffix = durationText !== "--" ? ` in ${durationText}` : "";
      setStatusMessage(`${prefix}${suffix}.`, "success");
      return;
    }
    if (settings.autoApplySafe && automation.attempted && !automation.executed) {
      setStatusMessage("Waiting for a page interaction to finish setup.", "info");
      return;
    }
    if (automationActive) {
      setStatusMessage("Autopilot is monitoring this tab.", "success");
      return;
    }
    setStatusMessage("Ready when you are.", "info");
  }

  function syncControls() {
    const hasStatus = Boolean(lastStatus);
    const settings = lastStatus?.settings || {};
    const sitePref = lastStatus?.sitePreference || {};

    if (dom.toggleAutopilot) {
      dom.toggleAutopilot.checked = Boolean(settings.autoApplyPaused);
      const enabled = Boolean(settings.autoApplySafe);
      const disabled = !hasStatus || !enabled || Boolean(settings.extensionPaused) || Boolean(settings.powerSaverMode);
      dom.toggleAutopilot.disabled = disabled;
    }

    // Site-level toggles are managed in the side panel now.

    syncActionButtonState(dom.primaryAction, settings);
    syncActionButtonState(dom.secondaryAction, settings);

    if (dom.openSettings) {
      dom.openSettings.disabled = !hasStatus;
    }
    if (dom.openPanel) {
      dom.openPanel.disabled = !hasStatus || !lastStatus?.tabId;
    }
  }

  function syncActionButtonState(button, settings) {
    if (!button) {
      return;
    }
    const action = button.dataset.action;
    const hasTab = Boolean(lastStatus?.tabId);
    if (action === "scan") {
      button.disabled = !hasTab || Boolean(settings.extensionPaused);
    } else if (action === "quick-fix") {
      button.disabled = !hasTab || Boolean(settings.extensionPaused);
    } else {
      button.disabled = !hasTab;
    }
  }

  function toggleInputs(disabled) {
    const controls = [
      dom.primaryAction,
      dom.secondaryAction,
      dom.toggleAutopilot,
      dom.toggleSiteAuto,
      dom.toggleSitePause,
      dom.openSettings,
      dom.openPanel,
    ];
    controls.forEach((element) => {
      if (element) {
        element.disabled = disabled;
      }
    });
  }

  function resetUiToDefaults() {
    if (dom.autopilotStatus) {
      dom.autopilotStatus.textContent = "Autopilot: --";
      dom.autopilotStatus.dataset.tone = "neutral";
      dom.autopilotStatus.removeAttribute("title");
    }
    if (dom.auditDuration) {
      dom.auditDuration.textContent = "Last audit: --";
    }
    if (dom.findingsState) {
      dom.findingsState.textContent = "Scan needed";
      dom.findingsState.dataset.tone = "neutral";
    }
    configureActionButton(dom.primaryAction, { action: "quick-fix", label: "Quick Fix" });
    configureActionButton(dom.secondaryAction, { action: "scan", label: "Scan" });
    if (dom.siteSection) {
      dom.siteSection.hidden = true;
    }
    if (dom.siteLabel) {
      dom.siteLabel.textContent = "";
    }
  }

  function configureActionButton(button, config) {
    if (!button || !config) {
      return;
    }
    button.dataset.action = config.action;
    button.textContent = config.label;
  }

  function determineAutopilotState(settings = {}) {
    if (settings.extensionPaused) {
      return { label: "Paused", tone: "warning", title: "Extension is paused." };
    }
    if (!settings.autoApplySafe) {
      return { label: "Off", tone: "neutral", title: "Enable Autopilot in Settings to auto-apply safe fixes." };
    }
    if (settings.autoApplyPaused) {
      return { label: "Paused", tone: "warning", title: "Autopilot is paused across all sites." };
    }
    if (settings.powerSaverMode) {
      return { label: "On (Power saver)", tone: "info", title: "Runs when this page changes significantly." };
    }
    return { label: "On", tone: "success" };
  }

  function computePendingCount() {
    const counts = lastStatus?.counts || DEFAULT_COUNTS;
    const pending = Number(counts.pending);
    if (Number.isFinite(pending) && pending >= 0) {
      return clampToNonNegativeInt(pending);
    }
    const total = Number(counts.total);
    if (Number.isFinite(total) && total >= 0) {
      return clampToNonNegativeInt(total);
    }
    return 0;
  }

  function hasAuditResult(counts = DEFAULT_COUNTS) {
    const total = clampToNonNegativeInt(Number(counts.total));
    const applied = clampToNonNegativeInt(Number(counts.applied));
    const ms = Number(lastStatus?.auditDurationMs);
    return total > 0 || applied > 0 || Number.isFinite(ms) || Boolean(lastStatus?.automation?.attempted);
  }

  function setStatusMessage(message, tone) {
    if (!dom.message) {
      return;
    }
    dom.message.textContent = message || "";
    dom.message.dataset.tone = tone || "info";
  }

  function sanitizeCounts(raw = {}) {
    return normalizeCountMap(raw);
  }

  function sanitizeMetrics(raw = {}) {
    return {
      lifetimeFindings: clampToNonNegativeInt(raw.lifetimeFindings),
      lifetimeApplied: clampToNonNegativeInt(raw.lifetimeApplied),
      lifetimeAutoApplied: clampToNonNegativeInt(raw.lifetimeAutoApplied),
      lifetimeIgnored: clampToNonNegativeInt(raw.lifetimeIgnored),
    };
  }

  function formatNumber(value) {
    try {
      return Number(value || 0).toLocaleString();
    } catch (_error) {
      return String(value || 0);
    }
  }

  function formatDuration(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value <= 0) {
      return "--";
    }
    if (value < 1000) {
      return `${Math.round(value)} ms`;
    }
    if (value < 10000) {
      return `${(value / 1000).toFixed(2)} s`;
    }
    return `${(value / 1000).toFixed(1)} s`;
  }

  async function updateGlobalSetting(partial) {
    try {
      await storage.setSettings(partial);
    } catch (error) {
      console.error("[AltSpark] Failed to update settings", error);
    } finally {
      await refreshStatus();
    }
  }

  async function updateSitePreference(updates) {
    if (!lastStatus?.tabId) {
      return;
    }
    try {
      const response = await chrome.runtime.sendMessage({
        type: "a11y-copy-helper:update-site-pref",
        tabId: lastStatus.tabId,
        ...updates,
      });
      if (!response?.ok) {
        throw new Error(response?.error || "Unable to update preference");
      }
      await refreshStatus();
    } catch (error) {
      console.error("[AltSpark] Failed to update site preference", error);
      setStatusMessage(error?.message || "Unable to update site preference", "error");
      throw error;
    }
  }

  async function openSidePanel({ focus } = {}) {
    if (!lastStatus?.tabId) {
      throw new Error("No active tab");
    }
    const messageType = focus === "settings"
      ? "a11y-copy-helper:open-side-panel-settings"
      : "a11y-copy-helper:open-side-panel";
    const response = await chrome.runtime.sendMessage({
      type: messageType,
      tabId: lastStatus.tabId,
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Unable to open side panel");
    }
  }

  function closeIfPossible() {
    if (typeof window.close === "function") {
      window.close();
    }
  }
})();
