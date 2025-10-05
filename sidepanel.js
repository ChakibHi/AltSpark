import { clampToNonNegativeInt } from "./counts.js";
import { truncateText } from "./dom-utils.js";

const dom = {
  container: document.querySelector('.sidepanel-container'),
  site: document.getElementById('panel-site'),
  status: document.getElementById('panel-status'),
  auditDuration: document.getElementById('panel-audit-duration'),
  tabs: Array.from(document.querySelectorAll('.sidepanel-tab')),
  views: Array.from(document.querySelectorAll('.sidepanel-view')),
  applySafe: document.getElementById('toolbar-apply-safe'),
  undo: document.getElementById('toolbar-undo'),
  runAudit: document.getElementById('toolbar-scan'),
  footerApplyAll: document.getElementById('footer-apply-all'),
  revertAll: document.getElementById('footer-revert-all'),
  exportMarkdown: document.getElementById('footer-export'),
  openPopup: document.getElementById('panel-open-popup'),
  message: document.getElementById('panel-message'),
  summary: {
    section: document.querySelector('.sidepanel-summary'),
    chips: Array.from(document.querySelectorAll('.summary-chip')),
    counts: {
      image: document.getElementById('summary-image-count'),
      link: document.getElementById('summary-link-count'),
      heading: document.getElementById('summary-heading-count'),
    },
    progressBar: document.getElementById('phase-progress'),
    progressLabel: document.getElementById('phase-label'),
  },
  issueList: document.getElementById('panel-issue-list'),
  emptyState: document.getElementById('panel-empty'),
  footerMeta: document.getElementById('footer-meta'),
  announcer: document.getElementById('panel-announcer'),
  settingsForm: document.getElementById('settings-form'),
};

const CONNECTION_ERROR_FRAGMENT = "receiving end does not exist";
const CONTENT_UNAVAILABLE_FRAGMENT = "content script unavailable";

let currentTabId = null;
let currentPageUrl = null;
let currentState = null;
let issueLookup = new Map();
let replaceOverrides = new Map();
let highlightedIssueId = null;
let lastNotifiedTabId = null;
let pendingLoad = false;
let tabActivatedListener = null;
let tabUpdatedListener = null;
let currentSettings = null;
let settingsModulePromise = null;
let settingsWatcherDisposer = null;
let baseMessageState = { text: "", tone: "" };
let overrideMessageState = null;
let currentFilter = 'all';

initialize().catch((error) => {
  console.error('[AltSpark] Failed to initialize side panel', error);
  setStatus(error?.message || 'Unable to initialize side panel', 'error');
});

async function initialize() {
  bindEventListeners();
  switchView('findings');
  await Promise.all([refreshTabContext(), loadSettingsView()]);
  await loadState();
  if (currentTabId != null) {
    notifyVisibility(true, currentTabId);
  }
  const storage = await getStorageModule();
  settingsWatcherDisposer = storage.watchSettings((settings) => {
    currentSettings = settings;
    applySettingsToForm(dom.settingsForm, settings);
  });
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  window.addEventListener('beforeunload', handleBeforeUnload, { once: true });
}

function bindEventListeners() {
  dom.applySafe?.addEventListener('click', handleApplySafe);
  dom.footerApplyAll?.addEventListener('click', handleApplySafe);
  dom.revertAll?.addEventListener('click', handleRevertAll);
  dom.undo?.addEventListener('click', handleRevertAll);
  dom.runAudit?.addEventListener('click', handleRunAudit);
  dom.openPopup?.addEventListener('click', () => {
    if (chrome.action?.openPopup) {
      chrome.action.openPopup().catch(() => {});
    }
  });
  dom.exportMarkdown?.addEventListener('click', handleExportMarkdown);

  dom.summary?.chips?.forEach((chip) => {
    chip.addEventListener('click', () => {
      const targetFilter = chip.dataset.filter || 'all';
      setFilter(targetFilter);
    });
  });

  dom.issueList?.addEventListener('click', handleIssueClick);
  dom.issueList?.addEventListener('change', handleIssuePreferenceChange);
  dom.issueList?.addEventListener('focusin', handleIssueFocus);
  dom.issueList?.addEventListener('pointerenter', handleIssuePointerEnter, true);
  dom.issueList?.addEventListener('pointerleave', handleIssuePointerLeave, true);

  dom.tabs?.forEach((tab) => {
    tab.addEventListener('click', () => {
      const targetView = tab.dataset.view || 'findings';
      switchView(targetView);
    });
  });

  dom.settingsForm?.addEventListener('change', handleSettingsChange);

  tabActivatedListener = () => {
    refreshTabContext()
      .then(() => loadState())
      .catch((error) => console.error('[AltSpark] Tab activation refresh failed', error));
  };
  chrome.tabs.onActivated.addListener(tabActivatedListener);

  tabUpdatedListener = (tabId, changeInfo) => {
    if (tabId === currentTabId && changeInfo.status === 'complete') {
      loadState({ force: true });
    }
  };
  chrome.tabs.onUpdated.addListener(tabUpdatedListener);
}

async function refreshTabContext() {
  setStatus('Checking active tab...', 'info');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'a11y-copy-helper:popup-status' });
    if (!response?.ok) {
      throw new Error(response?.error || 'Unable to read active tab');
    }
    const data = response.data || {};
    const nextTabId = typeof data.tabId === 'number' ? data.tabId : null;
    const previousTabId = currentTabId;
    if (nextTabId !== currentTabId) {
      if (previousTabId != null) {
        notifyVisibility(false, previousTabId);
      }
      currentTabId = nextTabId;
      issueLookup.clear();
      replaceOverrides.clear();
    }
    currentPageUrl = data.url || null;
    if (currentTabId == null) {
      dom.site.textContent = 'No active tab detected.';
      updateState(null);
      setStatus('Open a supported tab to start auditing.', 'warning');
      return;
    }
    if (data.host) {
      dom.site.textContent = `Active site: ${data.host}`;
    } else {
      dom.site.textContent = 'Active tab ready.';
    }
    if (data.automationActive) {
      setMessage('Auto-apply is active on this site.', 'info');
    } else {
      setMessage('', 'info');
    }
    setStatus('Ready. Run an audit to populate findings.', 'info');
  } catch (error) {
    console.error('[AltSpark] Failed to refresh tab context', error);
    dom.site.textContent = 'No active tab detected.';
    updateState(null);
    setStatus(error?.message || 'Unable to read active tab', 'error');
    currentTabId = null;
    currentPageUrl = null;
  }
}

async function loadState({ force = false } = {}) {
  if (currentTabId == null || pendingLoad) {
    return;
  }
  pendingLoad = true;
  setLoading(true);
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'a11y-copy-helper:panel-get-state',
      tabId: currentTabId,
      force,
    });
    if (!response?.ok) {
      throw new Error(response?.error || 'Findings unavailable');
    }
    if (response.state) {
      updateState(response.state, force ? 'refresh' : 'load');
      if (lastNotifiedTabId !== currentTabId) {
        notifyVisibility(true, currentTabId);
      }
    } else {
      updateState(null);
    }
  } catch (error) {
    const message = error?.message || 'Findings unavailable';
    if (isConnectionError(error)) {
      // console.warn('[AltSpark] Panel state unavailable until the page finishes loading', error);
      setMessage('Run an audit on the active tab to populate findings.', 'warning');
    } else {
      console.error('[AltSpark] Failed to load panel state', error);
      setMessage(message, 'error');
    }
    if (force) {
      updateState(null);
    }
  } finally {
    setLoading(false);
    pendingLoad = false;
  }
}

function updateState(state, reason = "update") {
  currentState = state;
  if (!state) {
    if (dom.emptyState) {
      dom.emptyState.textContent = 'Run an audit to populate findings.';
    }
    setActivationNotice(false);
    if (dom.emptyState) {
      dom.emptyState.hidden = false;
    }
    if (dom.issueList) {
      dom.issueList.innerHTML = '';
    }
    issueLookup.clear();
    replaceOverrides.clear();
    updateSummary(null);
    updateButtons();
    updateProgress(null, false);
    updateFooterMeta(null);
    return;
  }
  updateSummary(state);
  updateProgress(state.progress, state.auditInProgress);
  renderIssues(state.issues || [], state.automation);
  updateButtons(state);
  updateFooterMeta(state.counts);
  const activation = state.activation || null;
  if (activation?.required) {
    const message = activation.hasUserActivation
      ? 'Rerun the audit to enable AI suggestions.'
      : 'Click inside the page to enable AI suggestions, then rerun the audit.';
    const tone = activation.hasUserActivation ? 'info' : 'warning';
    setActivationNotice(true, { message, tone });
  } else {
    setActivationNotice(false);
  }
  if (state.auditInProgress) {
    setStatus('Audit is running...', 'info');
  } else if (!state.hasReport) {
    setStatus('Run an audit to populate findings.', 'info');
  } else if (state.automation?.executed) {
    const appliedCount = clampToNonNegativeInt(state.counts?.applied);
    const durationLabel = formatDuration(state.lastAuditDuration);
    const issueLabel = appliedCount === 1 ? 'issue' : 'issues';
    const prefix = appliedCount > 0 ? `Auto-applied ${appliedCount} ${issueLabel}` : 'Auto-applied safe fixes';
    const suffix = durationLabel !== '--' ? ` in ${durationLabel}` : '';
    setStatus(`${prefix}${suffix}.`, 'success');
  } else if (state.pendingSafeCount > 0) {
    setStatus('Review pending suggestions to finish this audit.', 'info');
  } else {
    setStatus('All suggestions are handled for this page.', 'success');
  }
}


function updateSummary(state) {
  const summary = dom.summary;
  if (!summary?.section) {
    return;
  }
  const issues = Array.isArray(state?.issues) ? state.issues : [];
  const perType = { image: 0, link: 0, heading: 0 };
  for (const issue of issues) {
    if (!issue || issue.status !== 'pending') {
      continue;
    }
    const key = issue.type || issue.section;
    if (key && Object.prototype.hasOwnProperty.call(perType, key)) {
      perType[key] += 1;
    }
  }
  if (currentFilter !== 'all' && Object.prototype.hasOwnProperty.call(perType, currentFilter) && perType[currentFilter] === 0) {
    currentFilter = 'all';
  }
  const totalPending = perType.image + perType.link + perType.heading;
  if (summary.counts.image) {
    summary.counts.image.textContent = formatNumber(perType.image);
  }
  if (summary.counts.link) {
    summary.counts.link.textContent = formatNumber(perType.link);
  }
  if (summary.counts.heading) {
    summary.counts.heading.textContent = formatNumber(perType.heading);
  }
  if (!issues.length) {
    summary.section.classList.add('is-empty');
    summary.chips?.forEach((chip) => {
      chip.disabled = true;
      chip.classList.remove('active');
    });
    currentFilter = 'all';
    return;
  }
  summary.section.classList.remove('is-empty');
  summary.chips?.forEach((chip) => {
    const filter = chip.dataset.filter || 'all';
    const isActive = currentFilter !== 'all' && currentFilter === filter;
    chip.classList.toggle('active', isActive);
    chip.disabled = false;
  });
}

function updateButtons(state) {
  const hasTab = currentTabId != null;
  const auditRunning = Boolean(state?.auditInProgress);
  const pendingSafe = clampToNonNegativeInt(state?.pendingSafeCount);
  const appliedCount = clampToNonNegativeInt(state?.counts?.applied);
  const issuesAvailable = Array.isArray(state?.issues) && state.issues.length > 0;

  if (dom.runAudit) {
    dom.runAudit.disabled = !hasTab || auditRunning;
  }

  if (dom.applySafe) {
    dom.applySafe.disabled = !hasTab || pendingSafe <= 0 || auditRunning;
    dom.applySafe.textContent = pendingSafe > 0
      ? `Apply ${formatNumber(pendingSafe)} Safe ${pendingSafe === 1 ? 'fix' : 'fixes'}`
      : 'Apply Safe fixes';
  }

  if (dom.footerApplyAll) {
    dom.footerApplyAll.disabled = !hasTab || pendingSafe <= 0 || auditRunning;
  }

  if (dom.undo) {
    dom.undo.disabled = !hasTab || appliedCount <= 0;
  }

  if (dom.revertAll) {
    dom.revertAll.disabled = !hasTab || appliedCount <= 0;
  }

  if (dom.exportMarkdown) {
    dom.exportMarkdown.disabled = !issuesAvailable;
  }

  dom.summary?.chips?.forEach((chip) => {
    chip.disabled = !issuesAvailable;
  });

  if (dom.openPopup) {
    dom.openPopup.disabled = !hasTab;
  }
}

function updateProgress(progress, running) {
  const summary = dom.summary;
  const bar = summary?.progressBar;
  const label = summary?.progressLabel;
  if (!bar || !label) {
    return;
  }
  if (!running && (!progress || !progress.total)) {
    bar.style.width = '0%';
    bar.removeAttribute('aria-valuenow');
    bar.removeAttribute('data-indeterminate');
    label.textContent = 'Idle';
    summary?.section?.classList.remove('is-running');
    return;
  }
  summary?.section?.classList.add('is-running');
  if (progress && progress.total) {
    const ratio = progress.total > 0 ? Math.min(1, Math.max(0, progress.loaded / progress.total)) : 0;
    const percent = Math.round(ratio * 100);
    bar.style.width = `${percent}%`;
    bar.setAttribute('aria-valuenow', String(percent));
    bar.removeAttribute('data-indeterminate');
    label.textContent = formatProgressLabel(progress.kind, percent);
  } else {
    bar.style.width = '100%';
    bar.removeAttribute('aria-valuenow');
    bar.setAttribute('data-indeterminate', 'true');
    label.textContent = running ? 'Scanning...' : 'Preparing...';
  }
}

function renderIssues(issues, automation) {
  const list = dom.issueList;
  if (!list) {
    return;
  }
  const allIssues = Array.isArray(issues) ? issues : [];
  issueLookup.clear();
  for (const issue of allIssues) {
    if (issue?.id) {
      issueLookup.set(issue.id, issue);
    }
  }
  const filtered = filterIssues(allIssues);
  list.innerHTML = '';
  if (filtered.length === 0) {
    dom.emptyState.hidden = false;
    if (!allIssues.length) {
    dom.emptyState.textContent = automation?.executed
      ? 'All suggested fixes were auto-applied.'
      : 'You\'re all set. Nothing to fix on this page.';
    } else {
      dom.emptyState.textContent = `No pending ${currentFilter} findings.`;
    }
    return;
  }
  dom.emptyState.hidden = true;
  const fragment = document.createDocumentFragment();
  for (const issue of filtered) {
    const replaceChecked = replaceOverrides.has(issue.id)
      ? replaceOverrides.get(issue.id)
      : Boolean(issue.defaultReplace);
    fragment.append(buildIssueCard(issue, replaceChecked));
  }
  list.appendChild(fragment);
}

function buildIssueCard(issue, replaceChecked) {
  const item = document.createElement('li');
  item.className = 'finding-card';
  item.dataset.issueId = issue.id;
  item.dataset.status = issue.status || 'pending';
  item.dataset.safe = issue.safe ? 'true' : 'false';

  const safeLabel = issue.safe ? 'Safe' : 'Review';
  const suggestionHtml = issue.suggestion ? formatMultiline(issue.suggestion) : '';
  const translatedHtml = issue.translatedSuggestion ? formatMultiline(issue.translatedSuggestion) : '';
  const contextHtml = issue.context
    ? formatMultiline(truncateText(issue.context, 320, { trim: true, ellipsis: '...' }))
    : '';
  const applied = issue.status === 'applied';
  const ignored = issue.status === 'ignored';
  const canApply = issue.safe || issue.canReplaceText;
  const currentText = issue.currentText ? `Current: ${escapeHtml(issue.currentText)}` : '';

  item.innerHTML = `
    <article class="finding-card__surface">
      <header class="finding-card__header">
        <span class="finding-chip finding-chip--${issue.safe ? 'safe' : 'review'}">${escapeHtml(safeLabel)}</span>
        <div class="finding-card__title">
          <h3>${escapeHtml(issue.title || issue.reason || 'Issue')}</h3>
          ${currentText ? `<p class="finding-card__subtitle">${currentText}</p>` : ''}
        </div>
      </header>
      <div class="finding-card__body">
        ${suggestionHtml ? `<p class="finding-card__suggestion"><span>Suggestion:</span> ${suggestionHtml}</p>` : ''}
        ${translatedHtml ? `<p class="finding-card__suggestion alt"><span>Preferred language:</span> ${translatedHtml}</p>` : ''}
        ${contextHtml ? `<details class="finding-card__context"><summary>Show context</summary><p>${contextHtml}</p></details>` : ''}
        ${issue.canReplaceText ? `
          <label class="replace-toggle">
            <input type="checkbox" data-issue-replace="true" data-issue-id="${escapeHtml(issue.id)}" ${replaceChecked ? 'checked' : ''} ${applied || ignored ? 'disabled' : ''} />
            <span>${issue.type === 'link' ? 'Replace link text' : 'Replace text'}</span>
          </label>
        ` : ''}
      </div>
      <footer class="finding-card__footer">
        <div class="finding-card__actions">
          <button type="button" class="primary" data-issue-action="apply" data-issue-id="${escapeHtml(issue.id)}" ${!canApply || applied ? 'disabled' : ''}>Apply</button>
          <button type="button" class="secondary" data-issue-action="copy" data-issue-id="${escapeHtml(issue.id)}">Copy</button>
          <button type="button" class="ghost" data-issue-action="highlight" data-issue-id="${escapeHtml(issue.id)}">Highlight</button>
          <button type="button" class="ghost" data-issue-action="ignore" data-issue-id="${escapeHtml(issue.id)}" ${ignored ? 'disabled' : ''}>Ignore</button>
        </div>
      </footer>
    </article>
  `;
  return item;
}

function filterIssues(allIssues) {
  if (currentFilter === 'all') {
    return allIssues;
  }
  return allIssues.filter((issue) => (issue?.type || issue?.section) === currentFilter);
}

function setFilter(nextFilter) {
  const normalized = currentFilter === nextFilter ? 'all' : nextFilter;
  currentFilter = normalized;
  if (currentState) {
    renderIssues(currentState.issues || [], currentState.automation);
    updateSummary(currentState);
  }
}

function updateFooterMeta(rawCounts) {
  if (!dom.footerMeta) {
    return;
  }
  const applied = clampToNonNegativeInt(rawCounts?.applied);
  const reverted = clampToNonNegativeInt(rawCounts?.ignored);
  dom.footerMeta.textContent = `${formatNumber(applied)} applied | ${formatNumber(reverted)} reverted`;
}

function formatNumber(value) {
  try {
    return Number(value || 0).toLocaleString();
  } catch (_error) {
    return String(value || 0);
  }
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return '--';
  }
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  if (ms < 10000) {
    return `${(ms / 1000).toFixed(2)} s`;
  }
  return `${(ms / 1000).toFixed(1)} s`;
}

function formatProgressLabel(kind, percent) {
  if (!kind || kind === 'audit') {
    return `Scanning... ${percent}%`;
  }
  if (kind === 'model') {
    return `Preparing on-device AI... ${percent}%`;
  }
  const cleaned = String(kind).replace(/[-_]+/g, ' ');
  return `${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}... ${percent}%`;
}

function handleApplySafe() {
  if (currentTabId == null) {
    return;
  }
  const buttons = [dom.applySafe, dom.footerApplyAll];
  const hasEnabled = buttons.some((btn) => btn && !btn.disabled);
  if (!hasEnabled) {
    return;
  }
  buttons.forEach((btn) => {
    if (btn) {
      btn.disabled = true;
      btn.dataset.loading = 'true';
    }
  });
  runPanelAction('a11y-copy-helper:panel-apply-safe')
    .then((result) => {
      if (!result?.ok) {
        buttons.forEach((btn) => {
          if (btn) {
            btn.disabled = false;
          }
        });
      }
    })
    .finally(() => {
      buttons.forEach((btn) => {
        if (btn) {
          delete btn.dataset.loading;
        }
      });
    });
}

function handleRevertAll() {
  if (currentTabId == null) {
    return;
  }
  const buttons = [dom.revertAll, dom.undo];
  const hasEnabled = buttons.some((btn) => btn && !btn.disabled);
  if (!hasEnabled) {
    return;
  }
  buttons.forEach((btn) => {
    if (btn) {
      btn.disabled = true;
      btn.dataset.loading = 'true';
    }
  });
  runPanelAction('a11y-copy-helper:panel-revert-all')
    .then((result) => {
      if (!result?.ok) {
        buttons.forEach((btn) => {
          if (btn) {
            btn.disabled = false;
          }
        });
      }
    })
    .finally(() => {
      buttons.forEach((btn) => {
        if (btn) {
          delete btn.dataset.loading;
        }
      });
    });
}

function handleExportMarkdown() {
  if (!Array.isArray(currentState?.issues) || currentState.issues.length === 0) {
    setMessage('No findings to export.', 'info');
    return;
  }
  const lines = ['# Accessibility Findings'];
  const siteLine = dom.site?.textContent ? dom.site.textContent.trim() : '';
  if (siteLine) {
    lines.push('');
    lines.push(`- ${siteLine}`);
  }
  lines.push('');
  currentState.issues.forEach((issue, index) => {
    const heading = issue.categoryLabel || 'Finding';
    const reason = issue.reason || 'Needs review';
    lines.push(`## ${index + 1}. ${heading} - ${reason}`);
    if (issue.suggestion) {
      lines.push(`- Suggestion: ${issue.suggestion}`);
    }
    if (issue.currentText) {
      lines.push(`- Current: ${issue.currentText}`);
    }
    if (issue.context) {
      lines.push(`- Context: ${issue.context}`);
    }
    lines.push('');
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'a11y-copy-helper-findings.md';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  setMessage('Exported findings as Markdown.', 'success');
}

async function handleRunAudit() {
  if (dom.runAudit.disabled || currentTabId == null) {
    return;
  }
  dom.runAudit.disabled = true;
  dom.runAudit.dataset.loading = 'true';
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'a11y-copy-helper:popup-audit',
      tabId: currentTabId,
      scope: 'page',
    });
    if (!response?.ok) {
      throw new Error(response?.error || 'Audit failed');
    }
    setStatus('Audit launched...', 'info');
  } catch (error) {
    console.error('[AltSpark] Failed to run audit', error);
    setMessage(error?.message || 'Audit failed', 'error');
  } finally {
    delete dom.runAudit.dataset.loading;
    if (!currentState?.auditInProgress) {
      dom.runAudit.disabled = false;
    }
  }
}

function handleIssueClick(event) {
  const button = event.target.closest('button[data-issue-action]');
  if (!button) {
    return;
  }
  const issueId = button.dataset.issueId;
  if (!issueId || currentTabId == null) {
    return;
  }
  const action = button.dataset.issueAction;
  if (action === 'copy') {
    const issue = issueLookup.get(issueId);
    copyToClipboard(issue?.suggestion || '');
    button.dataset.flash = 'true';
    setTimeout(() => delete button.dataset.flash, 900);
    return;
  }
  if (action === 'highlight') {
    highlightIssue(issueId, { scroll: true, pulse: true });
    return;
  }
  if (button.disabled) {
    return;
  }
  button.disabled = true;
  button.dataset.loading = 'true';
  let payload = {};
  if (action === 'apply') {
    const replaceText = resolveReplacePreference(issueId);
    payload = { issueId, replaceText };
  } else if (action === 'ignore') {
    payload = { issueId };
  }
  const messageType = action === 'apply'
    ? 'a11y-copy-helper:panel-apply-issue'
    : 'a11y-copy-helper:panel-ignore-issue';
  runPanelAction(messageType, payload)
    .then((result) => {
      if (!result?.ok) {
        button.disabled = false;
      }
    })
    .finally(() => {
      delete button.dataset.loading;
    });
}

function handleIssuePreferenceChange(event) {
  const input = event.target.closest('input[data-issue-replace]');
  if (!input) {
    return;
  }
  replaceOverrides.set(input.dataset.issueId, Boolean(input.checked));
}

function handleIssueFocus(event) {
  const card = event.target.closest('[data-issue-id]');
  if (!card) {
    return;
  }
  const issueId = card.dataset.issueId;
  if (issueId) {
    highlightIssue(issueId, { scroll: false, pulse: false });
  }
}

function handleIssuePointerEnter(event) {
  const card = event.target.closest('[data-issue-id]');
  if (!card) {
    return;
  }
  const issueId = card.dataset.issueId;
  if (issueId && highlightedIssueId !== issueId) {
    highlightIssue(issueId);
  }
}

function handleIssuePointerLeave(event) {
  const related = event.relatedTarget?.closest('[data-issue-id]');
  if (!related) {
    clearHighlight();
  }
}

function resolveReplacePreference(issueId) {
  if (replaceOverrides.has(issueId)) {
    return Boolean(replaceOverrides.get(issueId));
  }
  const issue = issueLookup.get(issueId);
  return Boolean(issue?.defaultReplace);
}

function isConnectionError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return (
    message.includes(CONNECTION_ERROR_FRAGMENT) ||
    message.includes(CONTENT_UNAVAILABLE_FRAGMENT)
  );
}

function setStatus(message, tone = 'info') {
  if (!dom.status) {
    return;
  }
  dom.status.textContent = message;
  dom.status.dataset.tone = tone;
}

function setMessage(message, tone = 'info') {
  if (!dom.message) {
    return;
  }
  baseMessageState = { text: message || '', tone: tone || 'info' };
  if (tone === 'error') {
    overrideMessageState = null;
  }
  renderMessage();
}

function setActivationNotice(required, { message, tone = 'warning' } = {}) {
  if (!dom.message) {
    return;
  }
  if (required) {
    overrideMessageState = {
      text:
        message ||
        'Click inside the page to enable AI suggestions, then rerun the audit.',
      tone,
      source: 'activation',
    };
  } else if (overrideMessageState?.source === 'activation') {
    overrideMessageState = null;
  }
  renderMessage();
}

function renderMessage() {
  if (!dom.message) {
    return;
  }
  const activeMessage = overrideMessageState || baseMessageState;
  const text = activeMessage?.text || '';
  if (!text) {
    dom.message.textContent = '';
    dom.message.dataset.tone = '';
    dom.message.hidden = true;
    return;
  }
  dom.message.textContent = text;
  dom.message.dataset.tone = activeMessage.tone || 'info';
  dom.message.hidden = false;
}

function setLoading(loading) {
  if (!dom.container) {
    return;
  }
  if (loading) {
    dom.container.dataset.loading = 'true';
  } else {
    delete dom.container.dataset.loading;
  }
}

function highlightIssue(issueId, options = {}) {
  if (!issueId || currentTabId == null) {
    return;
  }
  highlightedIssueId = issueId;
  chrome.runtime
    .sendMessage({
      type: 'a11y-copy-helper:panel-highlight',
      tabId: currentTabId,
      issueId,
      scroll: Boolean(options.scroll),
      pulse: Boolean(options.pulse),
    })
    .catch(() => {});
}

function clearHighlight() {
  if (currentTabId == null || highlightedIssueId == null) {
    return;
  }
  const issueId = highlightedIssueId;
  highlightedIssueId = null;
  chrome.runtime
    .sendMessage({ type: 'a11y-copy-helper:panel-clear-highlight', tabId: currentTabId, issueId })
    .catch(() => {});
}

function runPanelAction(type, extra = {}) {
  if (currentTabId == null) {
    return Promise.resolve({ ok: false, error: 'No active tab' });
  }
  return chrome.runtime
    .sendMessage({ type, tabId: currentTabId, ...extra })
    .then((response) => {
      if (response?.state) {
        updateState(response.state);
      }
      if (!response?.ok) {
        throw new Error(response?.error || 'Operation failed');
      }
      return response;
    })
    .catch((error) => {
      console.error(`[AltSpark] ${type} failed`, error);
      setMessage(error?.message || 'Operation failed', 'error');
      return { ok: false, error: error?.message || 'Operation failed' };
    });
}

function handleRuntimeMessage(message, sender) {
  if (!message || typeof message !== 'object') {
    return;
  }
  if (message.type === 'a11y-copy-helper:state-update') {
    if (currentTabId == null) {
      return;
    }
    if (sender?.tab?.id != null && sender.tab.id !== currentTabId) {
      return;
    }
    if (message.pageUrl) {
      currentPageUrl = message.pageUrl;
    }
    if (message.state) {
      updateState(message.state, message.reason || 'update');
    }
    return;
  }
  if (message.type === 'a11y-copy-helper:panel-focus-view') {
    const targetView = typeof message.view === 'string' ? message.view : 'findings';
    switchView(targetView);
  }
}

function handleBeforeUnload() {
  if (tabActivatedListener) {
    chrome.tabs.onActivated.removeListener(tabActivatedListener);
    tabActivatedListener = null;
  }
  if (tabUpdatedListener) {
    chrome.tabs.onUpdated.removeListener(tabUpdatedListener);
    tabUpdatedListener = null;
  }
  if (typeof settingsWatcherDisposer === 'function') {
    settingsWatcherDisposer();
    settingsWatcherDisposer = null;
  }
  chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
  notifyVisibility(false, currentTabId);
}

function notifyVisibility(visible, tabId) {
  if (tabId == null) {
    return;
  }
  chrome.runtime
    .sendMessage({ type: 'a11y-copy-helper:panel-visibility', tabId, visible: Boolean(visible) })
    .catch(() => {});
  if (!visible) {
    chrome.runtime
      .sendMessage({ type: 'a11y-copy-helper:panel-clear-highlight', tabId })
      .catch(() => {});
    if (lastNotifiedTabId === tabId) {
      lastNotifiedTabId = null;
    }
  } else {
    lastNotifiedTabId = tabId;
  }
}

function escapeHtml(value = '') {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case '\'':
        return '&#39;';
      default:
        return char;
    }
  });
}

function formatMultiline(value = '') {
  return escapeHtml(value).replace(/\n/g, '<br />');
}


async function loadSettingsView() {
  if (!dom.settingsForm) {
    return;
  }
  try {
    const storage = await getStorageModule();
    currentSettings = await storage.getSettings();
    applySettingsToForm(dom.settingsForm, currentSettings);
  } catch (error) {
    console.error('[AltSpark] Failed to load settings', error);
  }
}

async function handleSettingsChange(event) {
  if (!event || !dom.settingsForm) {
    return;
  }
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) {
    return;
  }
  try {
    const storage = await getStorageModule();
    const payload = readSettingsFromForm(dom.settingsForm);
    currentSettings = await storage.setSettings(payload);
  } catch (error) {
    console.error('[AltSpark] Failed to save settings', error);
  }
}

async function getStorageModule() {
  if (!settingsModulePromise) {
    settingsModulePromise = import(chrome.runtime.getURL('storage.js'));
  }
  return settingsModulePromise;
}

function switchView(view = "findings") {
  if (!dom.tabs || !dom.views) {
    return;
  }
  const available = dom.views.some((section) => section.dataset.view === view);
  const target = available ? view : "findings";
  dom.tabs.forEach((tab) => {
    const isActive = tab.dataset.view === target;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
  });
  dom.views.forEach((section) => {
    const visible = section.dataset.view === target;
    section.classList.toggle("sidepanel-view--hidden", !visible);
    section.setAttribute("aria-hidden", String(!visible));
  });
}

function applySettingsToForm(form, settings) {
  if (!form || !settings) {
    return;
  }
  const map = [
    ['auditImages', Boolean(settings.auditImages)],
    ['auditLinks', Boolean(settings.auditLinks)],
    ['auditHeadings', Boolean(settings.auditHeadings)],
    ['preferAriaLabel', Boolean(settings.preferAriaLabel)],
    ['offerTranslations', Boolean(settings.offerTranslations)],
    ['autoApplySafe', Boolean(settings.autoApplySafe)],
    ['powerSaverMode', Boolean(settings.powerSaverMode)],
  ];
  for (const [name, value] of map) {
    const field = form.elements.namedItem(name);
    if (field instanceof HTMLInputElement && field.type === 'checkbox') {
      field.checked = value;
    }
  }
  const languageField = form.elements.namedItem('userLanguage');
  if (languageField instanceof HTMLSelectElement) {
    languageField.value = typeof settings.userLanguage === 'string' ? settings.userLanguage : 'auto';
  }
}

function readSettingsFromForm(form) {
  if (!form) {
    return {};
  }
  const readCheckbox = (name) => {
    const field = form.elements.namedItem(name);
    return field instanceof HTMLInputElement ? field.checked : false;
  };
  const languageField = form.elements.namedItem('userLanguage');
  const userLanguage = languageField instanceof HTMLSelectElement ? languageField.value : 'auto';
  return {
    auditImages: readCheckbox('auditImages'),
    auditLinks: readCheckbox('auditLinks'),
    auditHeadings: readCheckbox('auditHeadings'),
    preferAriaLabel: readCheckbox('preferAriaLabel'),
    offerTranslations: readCheckbox('offerTranslations'),
    autoApplySafe: readCheckbox('autoApplySafe'),
    powerSaverMode: readCheckbox('powerSaverMode'),
    userLanguage,
  };
}

function copyToClipboard(text) {
  if (!text) {
    return;
  }
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'absolute';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}
