if (globalThis.__ALTSPARK_CONTENT_LOADED__) {
  console.warn('[AltSpark] content script already initialized');
} else {

  globalThis.__ALTSPARK_CONTENT_LOADED__ = true;

  var modulesLoaded = null;
  var aiClient;
  var storageModule;
  var highlighterModule;
  var domUtils = null;
  var auditorInstance;
  var currentReport = null;
  var currentSettings = null;
  var issueStates = new Map();
  var panelVisible = false;
  var autoRunner = null;
  var auditInProgress = false;
  var lastPublishedCounts = null;
  var lastPublishedCountsAuditId = null;
  var issueLookup = new Map();
  var lastAuditAt = null;
  var lastProgressEvent = null;
  var localModelStatus = null;
  var localModelStatusPromise = null;
  var auditSequence = 0;
  var currentAuditId = null;
  var activationMonitorInstalled = false;
  var auditStartedAt = null;
  var lastAuditDuration = null;
  var activationPromptElement = null;
  var activationPromptVisible = false;
  var activationPromptHideTimer = null;
  var activationStyleInjected = false;

  const AUTO_AUDIT_MIN_INTERVAL_MS = 60_000;
  const ISSUE_COUNT_DEBOUNCE_MS = 200;
  const PANEL_STATE_THROTTLE_MS = 200;
  const AUTO_MUTATION_BUDGET = 80;
  const MAX_MUTATION_HINTS = 120;
  const MAX_HINT_EXPANSION = 40;
  const RELEVANT_MUTATION_SELECTOR = "img,a[href],h1,h2,h3,h4,h5,h6";

  let issueCountsTimer = null;
  let pendingCountsMessage = null;
  let panelStateTimer = null;
  let pendingPanelStateReason = null;
  let lastPanelStateSignature = null;

  function isAuditRelevantElement(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }
    const tag = element.tagName;
    if (!tag) {
      return false;
    }
    if (tag === "IMG") {
      return true;
    }
    if (tag === "A") {
      return element.hasAttribute("href");
    }
    return /^H[1-6]$/.test(tag);
  }

  function collectRelevantMutationTargets(root, limit = MAX_HINT_EXPANSION) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) {
      return [];
    }
    const results = [];
    const push = (element) => {
      if (!isAuditRelevantElement(element)) {
        return;
      }
      results.push(element);
    };
    push(root);
    if (results.length >= limit) {
      return results;
    }
    try {
      const descendants = root.querySelectorAll(RELEVANT_MUTATION_SELECTOR);
      for (const descendant of descendants) {
        push(descendant);
        if (results.length >= limit) {
          break;
        }
      }
    } catch (_error) {
      // ignore selector failures
    }
    return results;
  }

  function normalizeHintNodeList(nodes) {
    if (domUtils?.normalizeElementList) {
      return domUtils.normalizeElementList(nodes);
    }
    if (!nodes) {
      return null;
    }
    const source = Array.isArray(nodes) ? nodes : [...nodes];
    if (!source.length) {
      return null;
    }
    const seen = new Set();
    const normalized = [];
    for (const entry of source) {
      if (!entry || entry.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }
      if (!entry.isConnected || seen.has(entry)) {
        continue;
      }
      seen.add(entry);
      normalized.push(entry);
    }
    return normalized.length ? normalized : null;
  }

  async function loadModules() {
    if (modulesLoaded) {
      return modulesLoaded;
    }
    modulesLoaded = Promise.all([
      import(chrome.runtime.getURL("ai.js")),
      import(chrome.runtime.getURL("storage.js")),
      import(chrome.runtime.getURL("auditor.js")),
      import(chrome.runtime.getURL("highlighter.js")),
      import(chrome.runtime.getURL("dom-utils.js")),
    ])
      .then(([ai, storage, auditor, highlighter, dom]) => {
        aiClient = ai.createAIClient();
        storageModule = storage;
        highlighterModule = highlighter;
        domUtils = dom;
        aiClient.onProgress((event) => {
          lastProgressEvent = event || null;
          if (panelVisible) {
            notifyPanelState("progress");
          }
          refreshLocalModelStatus(true).catch(() => {});
        });
        aiClient.onActivation(() => {
          notifyPanelState("activation");
        });
        ensureActivationMonitor();
        refreshLocalModelStatus(true).catch(() => {});
        return { aiClient, storageModule, highlighterModule, Auditor: auditor.Auditor };
      })
      .catch((error) => {
        modulesLoaded = null;
        throw error;
      });
    return modulesLoaded;
  }

  async function ensureSettings() {
    try {
      await loadModules();
      currentSettings = await storageModule.getSettings();
      return currentSettings;
    } catch (error) {
      if (isExtensionContextInvalid(error)) {
        modulesLoaded = null;
        storageModule = null;
        await loadModules();
        try {
          currentSettings = await storageModule.getSettings();
        } catch (innerError) {
          console.warn("[AltSpark] Falling back to defaults after storage failure", innerError);
          const defaults = storageModule?.DEFAULT_SETTINGS || {};
          currentSettings = { ...defaults };
        }
        return currentSettings;
      }
      throw error;
    }
  }

  // Wait for an explicit user gesture in the page so Chrome's on-device
  // AI model creation (create()) can proceed without falling back.
  async function awaitUserActivation(timeoutMs = 15000) {
    try {
      // If we already have an active gesture for this task, we're good.
      if (navigator?.userActivation?.isActive) {
        return true;
      }
    } catch (_e) {
      // If the API isn't available, don't block ... treat as activated.
      return true;
    }

    // Let UIs know we are waiting for a gesture.
    try {
      aiClient?.requestActivation?.();
    } catch (_e) {}
    notifyPanelState("activation-required");
    showActivationPrompt();

    // Install a one-shot listener for the next gesture.
    let activated = false;
    await new Promise((resolve, reject) => {
      let done = false;
      let timerId = null;
      const cleanup = () => {
        window.removeEventListener("pointerdown", onActivate, true);
        window.removeEventListener("keydown", onActivate, true);
        if (timerId) {
          clearTimeout(timerId);
          timerId = null;
        }
      };
      const onActivate = () => {
        if (done) return;
        done = true;
        cleanup();
        activated = true;
        // Defer to the next microtask so userActivation flips first.
        queueMicrotask(() => resolve(true));
      };
      window.addEventListener("pointerdown", onActivate, true);
      window.addEventListener("keydown", onActivate, true);
      timerId = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error("User activation required: click inside the page and try again."));
      }, Math.max(1000, timeoutMs | 0));
    });
    if (activated) {
      hideActivationPrompt(400);
    }
    return true;
  }

  function readUserActivationState() {
    if (typeof navigator === "undefined") {
      return { isActive: false, hasBeenActive: true };
    }
    const activation = navigator.userActivation;
    if (!activation) {
      return { isActive: false, hasBeenActive: true };
    }
    return {
      isActive: Boolean(activation.isActive),
      hasBeenActive: Boolean(activation.hasBeenActive),
    };
  }

  function pageHasUserActivation() {
    const state = readUserActivationState();
    return state.isActive || state.hasBeenActive;
  }

  function ensureActivationPromptStyle() {
    if (activationStyleInjected || typeof document === "undefined") {
      return;
    }
    const style = document.createElement("style");
    style.dataset.altsparkActivation = "true";
    style.textContent = `
.altspark-activation-prompt { position: fixed; inset: auto 16px 16px 16px; display: flex; justify-content: center; pointer-events: none; opacity: 0; transform: translateY(12px); transition: opacity 160ms ease, transform 160ms ease; z-index: 2147483646; font-family: "Segoe UI", system-ui, sans-serif; }
.altspark-activation-prompt.is-visible { opacity: 1; transform: translateY(0); pointer-events: auto; }
.altspark-activation-prompt__inner { max-width: 420px; padding: 16px 20px; border-radius: 14px; background: rgba(17, 24, 39, 0.92); color: #f8fafc; box-shadow: 0 18px 40px rgba(15, 23, 42, 0.55); border: 1px solid rgba(148, 163, 184, 0.35); display: flex; flex-direction: column; gap: 8px; }
.altspark-activation-prompt__title { font-size: 15px; font-weight: 600; margin: 0; }
.altspark-activation-prompt__body { margin: 0; font-size: 13px; line-height: 1.45; color: rgba(226, 232, 240, 0.9); }
.altspark-activation-prompt__dismiss { align-self: flex-start; margin-top: 6px; padding: 6px 14px; border-radius: 999px; border: 1px solid rgba(148, 163, 184, 0.6); background: transparent; color: inherit; font-size: 12px; font-weight: 600; cursor: pointer; transition: background 120ms ease, color 120ms ease, border-color 120ms ease; }
.altspark-activation-prompt__dismiss:hover { background: rgba(59, 130, 246, 0.16); border-color: rgba(59, 130, 246, 0.6); color: #bfdbfe; }
@media (prefers-reduced-motion: reduce) {
  .altspark-activation-prompt { transition: none; transform: none; }
}
`;  
    (document.head || document.documentElement).appendChild(style);
    activationStyleInjected = true;
  }

  function resetActivationPrompt() {
    if (activationPromptElement && activationPromptElement.parentNode) {
      activationPromptElement.parentNode.removeChild(activationPromptElement);
    }
    activationPromptElement = null;
  }

  function ensureActivationPromptElement() {
    if (typeof document === "undefined") {
      return null;
    }
    if (activationPromptElement && activationPromptElement.isConnected) {
      return activationPromptElement;
    }
    resetActivationPrompt();
    ensureActivationPromptStyle();
    const container = document.createElement("div");
    container.className = "altspark-activation-prompt";
    container.setAttribute("role", "status");
    container.setAttribute("aria-live", "assertive");
    container.hidden = true;
    const inner = document.createElement("div");
    inner.className = "altspark-activation-prompt__inner";
    const title = document.createElement("p");
    title.className = "altspark-activation-prompt__title";
    title.textContent = "Auto-mode needs a quick click";
    const body = document.createElement("p");
    body.className = "altspark-activation-prompt__body";
    body.textContent = "Click anywhere on this page once to finish enabling automatic fixes.";
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "altspark-activation-prompt__dismiss";
    dismiss.textContent = "Got it";
    dismiss.addEventListener("click", () => {
      hideActivationPrompt();
    });
    inner.append(title, body, dismiss);
    container.appendChild(inner);
    document.documentElement.appendChild(container);
    activationPromptElement = container;
    return activationPromptElement;
  }

  function showActivationPrompt() {
    if (pageHasUserActivation()) {
      hideActivationPrompt();
      return;
    }
    const element = ensureActivationPromptElement();
    if (!element) {
      return;
    }
    if (activationPromptHideTimer) {
      clearTimeout(activationPromptHideTimer);
      activationPromptHideTimer = null;
    }
    element.hidden = false;
    requestAnimationFrame(() => {
      if (!element) {
        return;
      }
      element.classList.add("is-visible");
    });
    activationPromptVisible = true;
  }

  function hideActivationPrompt(delay = 0) {
    const element = activationPromptElement;
    if (!element || (!activationPromptVisible && !element.classList.contains("is-visible"))) {
      return;
    }
    const applyHide = () => {
      if (!activationPromptElement) {
        return;
      }
      activationPromptElement.classList.remove("is-visible");
      activationPromptVisible = false;
      activationPromptElement.hidden = true;
    };
    if (delay > 0) {
      if (activationPromptHideTimer) {
        clearTimeout(activationPromptHideTimer);
      }
      activationPromptHideTimer = setTimeout(() => {
        activationPromptHideTimer = null;
        applyHide();
      }, delay);
    } else {
      if (activationPromptHideTimer) {
        clearTimeout(activationPromptHideTimer);
        activationPromptHideTimer = null;
      }
      applyHide();
    }
  }

  function ensureActivationMonitor() {
    if (activationMonitorInstalled || typeof window === "undefined") {
      return;
    }
    const notifyIfNeeded = () => {
      hideActivationPrompt(300);
      if (aiClient?.requiresActivation?.()) {
        notifyPanelState("activation-gesture");
      }
    };
    window.addEventListener("pointerdown", notifyIfNeeded, true);
    window.addEventListener("keydown", notifyIfNeeded, true);
    activationMonitorInstalled = true;
  }

  function captureSelectionRange() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }
    try {
      const range = selection.getRangeAt(0).cloneRange();
      return range;
    } catch (_error) {
      return null;
    }
  }

  function resetIssueStates(report) {
    lastPublishedCounts = null;
    issueStates = new Map();
    issueLookup = new Map();
    if (!report) {
      return;
    }
    const groups = [
      ["images", report.images],
      ["links", report.links],
      ["headings", report.headings],
    ];
    for (const [section, issues] of groups) {
      if (!issues) {
        continue;
      }
      for (const issue of issues) {
        if (!issue?.id) {
          continue;
        }
        issue.section = section;
        issueStates.set(issue.id, { status: "pending", autoApplied: false });
        issueLookup.set(issue.id, issue);
      }
    }
  }

  function resetStatesToPending() {
    issueStates.forEach((entry, key) => {
      if (!entry) {
        issueStates.set(key, { status: "pending", autoApplied: false });
      } else {
        entry.status = "pending";
        entry.autoApplied = false;
      }
    });
  }

  function markIssueStatus(issue, status, options = {}) {
    if (!issue?.id) {
      return;
    }
    const entry = issueStates.get(issue.id) || { status: "pending", autoApplied: false };
    entry.status = status;
    if (status === "applied") {
      entry.autoApplied = Boolean(options.autoApplied);
    } else {
      entry.autoApplied = false;
    }
    issueStates.set(issue.id, entry);
    if (options.notify !== false) {
      publishIssueCounts(options.reason);
    }
  }

  function computeIssueCounts() {
    let total = 0;
    let applied = 0;
    let ignored = 0;
    let autoApplied = 0;
    issueStates.forEach((entry) => {
      if (!entry) {
        return;
      }
      total += 1;
      if (entry.status === "applied") {
        applied += 1;
        if (entry.autoApplied) {
          autoApplied += 1;
        }
      } else if (entry.status === "ignored") {
        ignored += 1;
      }
    });
    const pending = Math.max(0, total - applied - ignored);
    return { total, applied, ignored, autoApplied, pending };
  }

  function queueIssueCounts(reason, counts) {
    pendingCountsMessage = {
      type: "a11y-copy-helper:issue-counts",
      counts,
      pageUrl: location.href,
      reason,
      auditId: currentAuditId,
    };
    if (issueCountsTimer) {
      return;
    }
    const delay = currentSettings?.powerSaverMode ? ISSUE_COUNT_DEBOUNCE_MS * 2 : ISSUE_COUNT_DEBOUNCE_MS;
    issueCountsTimer = setTimeout(flushIssueCounts, delay);
  }

  function sendMessageSafe(message) {
    if (!chrome?.runtime?.sendMessage) {
      return;
    }
    try {
      const response = chrome.runtime.sendMessage(message);
      if (response && typeof response.then === "function") {
        response.catch((error) => {
          if (!isExtensionContextInvalid(error)) {
            console.warn("[AltSpark] Message send failed", error);
          }
        });
      }
    } catch (error) {
      if (!isExtensionContextInvalid(error)) {
        console.warn("[AltSpark] Message send failed", error);
      }
    }
  }

  function flushIssueCounts() {
    issueCountsTimer = null;
    const payload = pendingCountsMessage;
    pendingCountsMessage = null;
    if (!payload) {
      return;
    }
    sendMessageSafe(payload);
  }

  function publishIssueCounts(reason = "manual") {
    const counts = computeIssueCounts();
    const previous = lastPublishedCounts;
    const countsChanged = !(
      previous &&
      previous.total === counts.total &&
      previous.applied === counts.applied &&
      previous.ignored === counts.ignored &&
      previous.autoApplied === counts.autoApplied &&
      previous.pending === counts.pending
    );
    const isNewAudit = Boolean(currentAuditId && currentAuditId !== lastPublishedCountsAuditId);
    if (countsChanged || isNewAudit || reason !== "progress") {
      lastPublishedCounts = { ...counts };
      lastPublishedCountsAuditId = currentAuditId || null;
      queueIssueCounts(reason, counts);
    } else if (pendingCountsMessage) {
      pendingCountsMessage.reason = reason;
    }
    notifyPanelState(reason);
  }

  function notifyPanelState(reason = "update", options = {}) {
    const { immediate = false } = options || {};
    pendingPanelStateReason = reason;
    if (immediate) {
      if (panelStateTimer) {
        clearTimeout(panelStateTimer);
        panelStateTimer = null;
      }
      flushPanelState();
      return;
    }
    if (panelStateTimer) {
      return;
    }
    const delay = currentSettings?.powerSaverMode ? PANEL_STATE_THROTTLE_MS * 2 : PANEL_STATE_THROTTLE_MS;
    panelStateTimer = setTimeout(flushPanelState, delay);
  }

  function refreshLocalModelStatus(force = false) {
    if (!aiClient?.getLocalModelStatus) {
      return Promise.resolve(localModelStatus);
    }
    if (!force && localModelStatus && Number.isFinite(localModelStatus?.checkedAt) && Date.now() - localModelStatus.checkedAt < 12_000) {
      return Promise.resolve(localModelStatus);
    }
    if (localModelStatusPromise) {
      return localModelStatusPromise;
    }
    localModelStatusPromise = aiClient
      .getLocalModelStatus(force)
      .then((status) => {
        localModelStatus = status;
        localModelStatusPromise = null;
        notifyPanelState('model-status');
        return status;
      })
      .catch((error) => {
        console.warn('[AltSpark] Failed to refresh model status', error);
        localModelStatusPromise = null;
        return localModelStatus;
      });
    return localModelStatusPromise;
  }

  function flushPanelState() {
    if (panelStateTimer) {
      clearTimeout(panelStateTimer);
      panelStateTimer = null;
    }
    const reason = pendingPanelStateReason || "update";
    pendingPanelStateReason = null;
    if (reason === "progress" && !panelVisible) {
      return;
    }
    try {
      const state = buildPanelState();
      const signatureSource = {
        counts: state.counts,
        pendingSafeCount: state.pendingSafeCount,
        totalSafeCount: state.totalSafeCount,
        auditInProgress: state.auditInProgress,
        progress: state.progress,
        hasReport: state.hasReport,
        panelVisible: state.panelVisible,
        lastAuditAt: state.lastAuditAt,
        lastAuditDuration: state.lastAuditDuration,
        automationAttempted: state.automation?.attempted,
        automationExecuted: state.automation?.executed,
        modelSignature: state.localModels && Array.isArray(state.localModels.items)
          ? state.localModels.items.map((item) => `${item.id}:${item.status}`).join('|')
          : null,
        reason,
      };
      const signature = JSON.stringify(signatureSource);
      if (signature === lastPanelStateSignature && reason === "progress") {
        return;
      }
      lastPanelStateSignature = signature;
      sendMessageSafe({
        type: "a11y-copy-helper:state-update",
        state,
        reason,
        pageUrl: location.href,
      });
    } catch (error) {
      console.warn("[AltSpark] Failed to publish panel state", error);
    }
  }

  function applySafeIssues({ autoApplied = false, notify = true } = {}) {
    if (!currentReport) {
      return 0;
    }
    let appliedCount = 0;
    const batches = [currentReport.images, currentReport.links, currentReport.headings];
    for (const group of batches) {
      if (!group) {
        continue;
      }
      for (const issue of group) {
        if (!issue?.safe) {
          continue;
        }
        try {
          issue.apply?.({ replaceText: false });
          appliedCount += 1;
          markIssueStatus(issue, "applied", { autoApplied, notify: false });
        } catch (error) {
          console.warn("[AltSpark] apply-safe skipped", error);
        }
      }
    }
    if (notify) {
      publishIssueCounts(autoApplied ? "auto-apply" : "manual-apply-all");
    }
    return appliedCount;
  }

  async function runAudit({ scope, silent = false, autoApply = false, reason = "manual", hintNodes = null, budget } = {}) {
    const { Auditor } = await loadModules();
    const settings = await ensureSettings();
    if (settings?.extensionPaused) {
      throw new Error("Extension is paused");
    }
    if (aiClient?.prepareOffscreenHost) {
      aiClient.prepareOffscreenHost({ waitForReady: false }).catch(() => {});
    }
    auditSequence += 1;
    currentAuditId = typeof crypto?.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${auditSequence}`;
    const range = scope === "selection" ? captureSelectionRange() : null;
    const effectiveScope = range ? "selection" : "page";
    const normalizedHints = normalizeHintNodeList(hintNodes);
    let effectiveBudget;
    if (typeof budget === "number" && Number.isFinite(budget)) {
      const normalizedBudget = Math.max(0, Math.floor(budget));
      effectiveBudget = settings?.powerSaverMode
        ? Math.max(10, Math.floor(normalizedBudget / 2))
        : normalizedBudget;
    } else if (normalizedHints && normalizedHints.length) {
      effectiveBudget = settings?.powerSaverMode
        ? Math.max(20, Math.min(60, AUTO_MUTATION_BUDGET))
        : AUTO_MUTATION_BUDGET;
    } else {
      effectiveBudget = Infinity;
    }
    auditStartedAt = null;
    auditInProgress = true;
    lastProgressEvent = null;
    notifyPanelState("audit-start", { immediate: true });
    const auditOptions = {
      scope: effectiveScope,
      range,
      hintNodes: normalizedHints,
      budget: effectiveBudget,
    };
    let finalReport = null;
    let finalAuditor = null;
    let activationRetried = false;
    let lastActivationError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const candidateAuditor = new Auditor(aiClient, settings);
      try {
        if (auditStartedAt == null) {
          auditStartedAt = Date.now();
        }
        const report = await candidateAuditor.audit(auditOptions);
        const activationRequired = aiClient?.requiresActivation?.();
        let shouldRetry = false;
        if (!activationRetried && activationRequired) {
          if (!pageHasUserActivation()) {
            aiClient?.requestActivation?.();
            try {
              await awaitUserActivation();
              shouldRetry = true;
            } catch (activationError) {
              lastActivationError = activationError;
            }
          } else {
            shouldRetry = true;
          }
        }
        if (shouldRetry) {
          activationRetried = true;
          continue;
        }
        finalReport = report;
        finalAuditor = candidateAuditor;
        break;
      } catch (error) {
        if (isExtensionContextInvalid(error)) {
          modulesLoaded = null;
        }
        console.error("[AltSpark] audit failed", error);
        issueStates = new Map();
        lastPublishedCounts = null;
        lastPublishedCountsAuditId = null;
        publishIssueCounts("audit-error");
        notifyPanelState("audit-error", { immediate: true });
        auditInProgress = false;
        auditStartedAt = null;
        lastAuditDuration = null;
        throw error;
      }
    }
    if (!finalReport) {
      if (!silent) {
        finalReport = {
          summary: "Audit failed. Please try again.",
          summaryAlt: null,
          images: [],
          links: [],
          headings: [],
          language: navigator.language || "en",
        };
      } else if (lastActivationError) {
        auditInProgress = false;
        auditStartedAt = null;
        lastAuditDuration = null;
        throw lastActivationError;
      }
    }
    auditorInstance = finalAuditor || null;
    if (auditStartedAt != null) {
      lastAuditDuration = Math.max(0, Date.now() - auditStartedAt);
    } else {
      lastAuditDuration = null;
    }
    auditStartedAt = null;
    currentReport = finalReport;
    let canAutoApply = autoApply && !aiClient?.requiresActivation?.();
    if (currentReport) {
      currentReport.activation = buildActivationState();
      const meta = currentReport.meta && typeof currentReport.meta === "object" ? { ...currentReport.meta } : {};
      meta.autoApplyAttempted = Boolean(autoApply);
      canAutoApply = canAutoApply && Boolean(currentReport);
      meta.autoApplyExecuted = Boolean(canAutoApply);
      currentReport.meta = meta;
    }
    resetIssueStates(currentReport);
    if (canAutoApply && currentReport) {
      applySafeIssues({ autoApplied: true, notify: false });
    }
    const finalReason = autoApply ? "auto" : reason;
    publishIssueCounts(finalReason);
    lastAuditAt = Date.now();
    auditInProgress = false;
    refreshLocalModelStatus().catch(() => {});
    notifyPanelState(finalReason, { immediate: true });
    return currentReport;
  }
  function handleApply(issue, options) {
    try {
      issue.apply?.(options);
      markIssueStatus(issue, "applied", { reason: "manual-apply" });
    } catch (error) {
      console.error("[AltSpark] failed to apply issue", error);
    }
  }

  function handleApplyAllSafe() {
    applySafeIssues({ notify: false });
    publishIssueCounts("manual-apply-all");
  }

  function handleRevertAll() {
    auditorInstance?.revertAll();
    resetStatesToPending();
    publishIssueCounts("manual-revert");
  }

  function handleIgnore(issue) {
    markIssueStatus(issue, "ignored", { reason: "manual-ignore" });
  }

  function truncate(text, limit) {
    if (domUtils?.truncateText) {
      return domUtils.truncateText(text, limit);
    }
    if (!text) {
      return "";
    }
    const value = String(text);
    if (value.length <= limit) {
      return value;
    }
    const sliceLength = Math.max(0, limit - 3);
    return `${value.slice(0, sliceLength)}...`;
  }

  function createAutoRunner(scope = "page") {
    return {
      scope,
      observer: null,
      timeoutId: null,
      disposed: false,
      mutationHints: new Set(),
      addHintFromNode(node) {
        if (!node || this.mutationHints === null) {
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
          return;
        }
        const relevant = collectRelevantMutationTargets(node, MAX_HINT_EXPANSION);
        if (!relevant.length && isAuditRelevantElement(node)) {
          relevant.push(node);
        }
        for (const element of relevant) {
          if (this.mutationHints === null) {
            break;
          }
          this.mutationHints.add(element);
          if (this.mutationHints.size >= MAX_MUTATION_HINTS) {
            this.mutationHints = null;
            break;
          }
        }
      },
      start() {
        this.disposed = false;
        this.run("auto-initial");
        this.observe();
      },
      observe() {
        if (this.observer) {
          this.observer.disconnect();
        }
        if (!document?.documentElement) {
          return;
        }
        this.mutationHints = new Set();
        const observer = new MutationObserver((records) => {
          if (this.disposed) {
            return;
          }
          if (this.mutationHints !== null) {
            for (const record of records || []) {
              if (!record) {
                continue;
              }
              if (record.type === "attributes" || record.type === "characterData") {
                this.addHintFromNode(record.target);
              }
              if (record.type === "childList") {
                for (const added of record.addedNodes || []) {
                  this.addHintFromNode(added);
                }
              }
              if (this.mutationHints === null) {
                break;
              }
            }
          }
          this.schedule(1200);
        });
        const target = document.body || document.documentElement;
        observer.observe(target, {
          attributes: true,
          attributeFilter: ["alt", "aria-label", "title", "role", "aria-hidden"],
          childList: true,
          subtree: true,
        });
        this.observer = observer;
      },
      schedule(delay = 1000) {
        if (this.timeoutId) {
          clearTimeout(this.timeoutId);
        }
        this.timeoutId = setTimeout(() => this.run("auto-mutation"), delay);
      },
      async run(reason = "auto") {
        if (this.disposed) {
          return;
        }
        if (panelVisible) {
          this.schedule(1500);
          return;
        }
        if (auditInProgress) {
          this.schedule(800);
          return;
        }
        if (!pageHasUserActivation()) {
          aiClient?.requestActivation?.();
          showActivationPrompt();
          this.schedule(2000);
          return;
        }
        hideActivationPrompt(400);
        const now = Date.now();
        const minInterval = (currentSettings?.powerSaverMode ? AUTO_AUDIT_MIN_INTERVAL_MS * 2 : AUTO_AUDIT_MIN_INTERVAL_MS);
        if (lastAuditAt && now - lastAuditAt < minInterval) {
          const remaining = minInterval - (now - lastAuditAt);
          this.schedule(Math.max(remaining, 1000));
          return;
        }
        const hintSnapshot = this.mutationHints;
        const hadOverflow = hintSnapshot === null;
        const hintNodes = hintSnapshot && hintSnapshot.size ? Array.from(hintSnapshot) : null;
        this.mutationHints = new Set();
        if (!hadOverflow && reason === "auto-mutation" && (!hintNodes || hintNodes.length === 0)) {
          return;
        }
        try {
          const report = await runAudit({
            scope: this.scope,
            silent: true,
            autoApply: true,
            reason,
            hintNodes,
            budget: hintNodes ? AUTO_MUTATION_BUDGET : undefined,
          });
          if (hintNodes && report?.hasMore) {
            this.schedule(1500);
          }
        } catch (error) {
          console.warn("[AltSpark] Auto audit failed", error);
          this.schedule(5000);
        }
      },
      stop() {
        this.disposed = true;
        if (this.timeoutId) {
          clearTimeout(this.timeoutId);
          this.timeoutId = null;
        }
        if (this.observer) {
          this.observer.disconnect();
          this.observer = null;
        }
        this.mutationHints = new Set();
      },
    };
  }

  function startAutoAutomation({ scope = "page" } = {}) {
    if (window.top && window.top !== window) {
      return;
    }
    if (currentSettings?.powerSaverMode) {
      return;
    }
    if (autoRunner) {
      autoRunner.stop();
    }
    autoRunner = createAutoRunner(scope);
    autoRunner.start();
  }

function stopAutoAutomation() {
    if (autoRunner) {
      autoRunner.stop();
      autoRunner = null;
    }
    hideActivationPrompt();
  }

  async function composePanelState() {
    await ensureSettings();
    await refreshLocalModelStatus();
    return buildPanelState();
  }

  function buildPanelState() {
    const counts = computeIssueCounts();
    const issues = [];
    const sections = [
      { key: "images", label: "Images", icon: "🖼️" },
      { key: "links", label: "Links", icon: "🔗" },
      { key: "headings", label: "Headings", icon: "🔠" },
    ];
    if (currentReport) {
      for (const section of sections) {
        const group = currentReport[section.key] || [];
        for (const issue of group) {
          if (!issue?.id) {
            continue;
          }
          const statusEntry = issueStates.get(issue.id) || { status: "pending", autoApplied: false };
          issues.push({
            id: issue.id,
            type: issue.type,
            section: section.key,
            categoryLabel: section.label,
            categoryIcon: section.icon,
            title: formatIssueTitle(issue),
            reason: issue.reason || "Needs review",
            suggestion: issue.suggestion || "",
            translatedSuggestion: issue.translatedSuggestion || "",
            context: issue.context || "",
            currentText: deriveIssueCurrentText(issue) || "",
            safe: Boolean(issue.safe),
            canReplaceText: Boolean(issue.canReplaceText),
            defaultReplace: defaultReplacePreference(issue),
            status: statusEntry.status,
            autoApplied: Boolean(statusEntry.autoApplied),
            elementTag: issue.element?.tagName?.toLowerCase() || null,
          });
        }
      }
    }
    const pendingSafeCount = issues.filter((issue) => issue.safe && issue.status === "pending").length;
    const totalSafeCount = issues.filter((issue) => issue.safe).length;
    const meta = currentReport?.meta && typeof currentReport.meta === "object" ? currentReport.meta : null;
    const automation = {
      attempted: Boolean(meta?.autoApplyAttempted),
      executed: Boolean(meta?.autoApplyExecuted),
    };
    const state = {
      counts,
      issues,
      summary: currentReport?.summary || "",
      summaryAlt: currentReport?.summaryAlt || "",
      language:
        currentReport?.language || currentSettings?.userLanguage || navigator.language || "en",
      auditInProgress,
      panelVisible,
      hasReport: Boolean(currentReport),
      lastAuditAt,
      pendingSafeCount,
      totalSafeCount,
      lastAuditDuration,
      progress: normalizeProgress(lastProgressEvent),
      activation: buildActivationState(),
      automation,
      localModels: localModelStatus
        ? {
            ready: Boolean(localModelStatus.ready),
            checkedAt: localModelStatus.checkedAt || Date.now(),
            items: Array.isArray(localModelStatus.items)
              ? localModelStatus.items.map((item) => ({ ...item }))
              : [],
          }
        : null,
    };

    try {
      if (typeof window !== "undefined" && typeof window.__A11Y_CAPTURE_STATE__ === "function") {
        window.__A11Y_CAPTURE_STATE__(state);
      }
    } catch (error) {
      console.warn("[AltSpark] Test state capture failed", error);
    }

    return state;
  }

  function buildActivationState() {
    const aiState = aiClient?.getActivationState?.() || { required: false, lastRequestedAt: null };
    const userActivation = readUserActivationState();
    return {
      required: Boolean(aiState.required),
      lastRequestedAt: aiState.lastRequestedAt || null,
      hasUserActivation: Boolean(userActivation.isActive || userActivation.hasBeenActive),
      userActivationActive: Boolean(userActivation.isActive),
    };
  }

  function normalizeProgress(event) {
    if (!event || !event.total) {
      return null;
    }
    const total = Number(event.total);
    const loaded = Number(event.loaded);
    if (!Number.isFinite(total) || total <= 0) {
      return null;
    }
    const safeLoaded = Number.isFinite(loaded) ? Math.max(0, Math.min(loaded, total)) : 0;
    return {
      kind: event.kind || "model",
      loaded: safeLoaded,
      total,
    };
  }

  function deriveIssueCurrentText(issue) {
    if (!issue?.element) {
      return "";
    }
    if (issue.type === "image") {
      return issue.element.getAttribute("alt") || "(empty)";
    }
    if (issue.type === "link" || issue.type === "heading") {
      return issue.element.innerText || issue.element.textContent || "";
    }
    return "";
  }

  function defaultReplacePreference(issue) {
    if (!issue?.canReplaceText) {
      return false;
    }
    if (issue.type === "link") {
      return !currentSettings?.preferAriaLabel;
    }
    if (issue.type === "heading") {
      return false;
    }
    return false;
  }

  function formatIssueTitle(issue) {
    switch (issue?.type) {
      case "image":
        return "Image alt";
      case "link":
        return "Link text";
      case "heading":
        return "Heading text";
      default:
        return "Item";
    }
  }

  function highlightIssueById(issueId, options = {}) {
    if (!issueId) {
      return false;
    }
    const issue = issueLookup.get(issueId);
    if (!issue?.element) {
      return false;
    }
    if (!highlighterModule?.highlight) {
      return false;
    }
    try {
      highlighterModule.highlight(issue.element, options);
      return true;
    } catch (error) {
      console.warn("[AltSpark] Failed to highlight issue", error);
      return false;
    }
  }

  function clearIssueHighlight() {
    try {
      highlighterModule?.clearHighlight?.();
    } catch (error) {
      console.warn("[AltSpark] Failed to clear highlight", error);
    }
  }

  function setPanelVisibility(visible) {
    const next = Boolean(visible);
    if (panelVisible === next) {
      return;
    }
    panelVisible = next;
    if (!panelVisible) {
      clearIssueHighlight();
    }
    notifyPanelState(panelVisible ? "panel-visible" : "panel-hidden", { immediate: true });
  }

  function isExtensionContextInvalid(error) {
    if (domUtils?.isExtensionContextInvalid) {
      return domUtils.isExtensionContextInvalid(error);
    }
    const message = String(error?.message || error || "").toLowerCase();
    return message.includes("extension context invalidated");
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") {
      return false;
    }
    if (message.type === "a11y-copy-helper:activation-nudge") {
      aiClient?.requestActivation?.();
      notifyPanelState("activation-nudge", { immediate: true });
      sendResponse?.({ ok: true });
      return false;
    }
    if (message.type === "a11y-copy-helper:auto-config") {
      if (message.enabled) {
        startAutoAutomation({ scope: message.scope || "page" });
      } else {
        stopAutoAutomation();
      }
      sendResponse?.({ ok: true });
      return false;
    }
    if (message.type === "a11y-copy-helper:audit") {
      runAudit({ scope: message.scope || "page" })
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error?.message }));
      return true;
    }
    if (message.type === "a11y-copy-helper:get-state") {
      (async () => {
        try {
          const state = await composePanelState();
          sendResponse({ ok: true, state });
        } catch (error) {
          sendResponse({ ok: false, error: error?.message || "Failed to load findings" });
        }
      })();
      return true;
    }
    if (message.type === "a11y-copy-helper:apply-issue") {
      (async () => {
        try {
          const issueId = message.issueId;
          if (!issueId) {
            throw new Error("Missing issue id");
          }
          const issue = issueLookup.get(issueId);
          if (!issue) {
            throw new Error("Issue not found");
          }
          handleApply(issue, { replaceText: Boolean(message.replaceText) });
          const state = await composePanelState();
          sendResponse({ ok: true, state });
        } catch (error) {
          sendResponse({ ok: false, error: error?.message || "Failed to apply issue" });
        }
      })();
      return true;
    }
    if (message.type === "a11y-copy-helper:ignore-issue") {
      (async () => {
        try {
          const issueId = message.issueId;
          if (!issueId) {
            throw new Error("Missing issue id");
          }
          const issue = issueLookup.get(issueId);
          if (!issue) {
            throw new Error("Issue not found");
          }
          handleIgnore(issue);
          const state = await composePanelState();
          sendResponse({ ok: true, state });
        } catch (error) {
          sendResponse({ ok: false, error: error?.message || "Failed to ignore issue" });
        }
      })();
      return true;
    }
    if (message.type === "a11y-copy-helper:apply-safe") {
      (async () => {
        try {
          if (!currentReport) {
            throw new Error("Run an audit before applying fixes");
          }
          applySafeIssues({ autoApplied: false, notify: true });
          const state = await composePanelState();
          sendResponse({ ok: true, state });
        } catch (error) {
          sendResponse({ ok: false, error: error?.message || "Failed to apply safe fixes" });
        }
      })();
      return true;
    }
    if (message.type === "a11y-copy-helper:revert-all") {
      (async () => {
        try {
          if (!currentReport) {
            throw new Error("Nothing to revert");
          }
          handleRevertAll();
          const state = await composePanelState();
          sendResponse({ ok: true, state });
        } catch (error) {
          sendResponse({ ok: false, error: error?.message || "Failed to revert changes" });
        }
      })();
      return true;
    }
    if (message.type === "a11y-copy-helper:panel-highlight") {
      const ok = highlightIssueById(message.issueId, {
        scroll: Boolean(message.scroll),
        pulse: Boolean(message.pulse),
      });
      sendResponse?.(ok ? { ok: true } : { ok: false, error: "Issue not available" });
      return false;
    }
    if (message.type === "a11y-copy-helper:panel-clear-highlight") {
      clearIssueHighlight();
      sendResponse?.({ ok: true });
      return false;
    }
    if (message.type === "a11y-copy-helper:panel-visibility") {
      setPanelVisibility(Boolean(message.visible));
      sendResponse?.({ ok: true, visible: panelVisible });
      return false;
    }
    return false;
  });

  chrome.runtime.sendMessage({ type: "a11y-copy-helper:ready" }).catch(() => {});

  try {
    if (typeof window !== "undefined") {
      window.__A11Y_TEST_RUN_AUDIT__ = async (scope = "page") => {
        await runAudit({ scope });
        return composePanelState();
      };
    }
  } catch (error) {
    console.warn("[AltSpark] Test audit hook failed", error);
  }
}
