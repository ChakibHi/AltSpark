import { truncateText } from "./dom-utils.js";

const HOST_ID = "a11y-copy-helper-root";
const DOCK_ID = "a11y-copy-helper-dock";
const HIGHLIGHT_STYLE_ID = "a11y-copy-helper-highlight-style";

function ensureHighlightStyle() {
  if (document.getElementById(HIGHLIGHT_STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = HIGHLIGHT_STYLE_ID;
  style.textContent = `
    .a11y-copy-helper-target-highlight {
      outline: 3px solid #f97316 !important;
      outline-offset: 2px !important;
      box-shadow: 0 0 0 4px rgba(249, 115, 22, 0.35) !important;
      transition: outline 0.2s ease;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

class OverlayUI {
  constructor(handlers) {
    this.handlers = handlers;
    this.report = null;
    this.cards = new Map();
    this.replaceState = new Map();
    this.highlighted = null;
    this.dragState = null;
    this.isHidden = false;
    this.boundClamp = () => this.clampPosition();

    this.handleClick = this.handleClick.bind(this);
    this.handleKeydown = this.handleKeydown.bind(this);
    this.onDragMove = this.onDragMove.bind(this);
    this.onDragEnd = this.onDragEnd.bind(this);

    ensureHighlightStyle();

    this.host = document.getElementById(HOST_ID);
    if (!this.host) {
      this.host = document.createElement("div");
      this.host.id = HOST_ID;
      this.host.setAttribute("role", "presentation");
      document.documentElement.appendChild(this.host);
    }
    this.shadow = this.host.attachShadow({ mode: "open" });
    this.shadow.innerHTML = "";

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = chrome.runtime.getURL("styles.css");
    this.shadow.appendChild(link);

    this.panel = document.createElement("section");
    this.panel.className = "a11y-copy-helper-panel";
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-label", "AltSpark (Local)");
    this.panel.tabIndex = -1;

    this.panel.innerHTML = `
      <header class="panel-header" aria-label="Overlay controls">
        <div class="panel-drag-handle">
          <div class="panel-title">AltSpark (Local)</div>
          <div class="panel-subtitle">Accessibility copy insights</div>
        </div>
        <div class="panel-actions">
          <button class="panel-action" type="button" data-panel-action="hide" aria-label="Hide panel">_</button>
          <button class="panel-action" type="button" data-panel-action="close" aria-label="Close panel">X</button>
        </div>
      </header>
      <div class="panel-progress" hidden>
        <span class="progress-label">Preparing models</span>
        <div class="progress-bar"><div class="progress-value"></div></div>
      </div>
      <div class="panel-body" tabindex="0">
        <section class="panel-section" data-section="summary">
          <h2>Summary 📝</h2>
          <div class="summary-card">
            <p class="summary-text"></p>
            <p class="summary-alt" hidden></p>
          </div>
        </section>
        <section class="panel-section" data-section="images">
          <h2>Images 🖼️</h2>
          <div class="issue-list"></div>
        </section>
        <section class="panel-section" data-section="links">
          <h2>Links 🔗</h2>
          <div class="issue-list"></div>
        </section>
        <section class="panel-section" data-section="headings">
          <h2>Headings 🔠</h2>
          <div class="issue-list"></div>
        </section>
      </div>
      <footer class="panel-footer">
        <button data-action="apply-all" type="button">Apply All (safe) ✅</button>
        <button data-action="revert-all" type="button">Revert All ↩️</button>
        <button data-action="export" type="button">Export report (.md) 📤</button>
      </footer>
    `;

    this.shadow.appendChild(this.panel);

    this.shadow.addEventListener("click", this.handleClick);
    this.shadow.addEventListener("keydown", this.handleKeydown);

    const dragHandle = this.panel.querySelector(".panel-drag-handle");
    dragHandle.addEventListener("pointerdown", (event) => this.startDrag(event));

    this.handleDocumentKey = (event) => {
      if (event.key === "Escape" && !this.isHidden) {
        this.handlers.onHide?.();
        this.hidePanel();
      }
    };
    document.addEventListener("keydown", this.handleDocumentKey, true);
    window.addEventListener("resize", this.boundClamp);

    this.panel.querySelector("[data-panel-action='close']").addEventListener("click", () => {
      this.handlers.onClose?.();
      this.destroy();
    });
    this.panel.querySelector("[data-panel-action='hide']").addEventListener("click", () => {
      this.handlers.onHide?.();
      this.hidePanel();
    });
  }

  destroy() {
    document.removeEventListener("keydown", this.handleDocumentKey, true);
    window.removeEventListener("resize", this.boundClamp);
    this.panel.removeEventListener("pointermove", this.onDragMove);
    this.panel.removeEventListener("pointerup", this.onDragEnd);
    this.panel.removeEventListener("pointercancel", this.onDragEnd);
    this.shadow.removeEventListener("click", this.handleClick);
    this.shadow.removeEventListener("keydown", this.handleKeydown);
    this.cards.clear();
    this.replaceState.clear();
    this.clearHighlight();
    this.removeDock();
    if (this.host) {
      this.host.remove();
    }
    this.host = null;
    this.shadow = null;
    this.panel = null;
  }

  handleClick(event) {
    const panelAction = event.target.closest("[data-panel-action]");
    if (panelAction) {
      return;
    }
    const footerButton = event.target.closest("button[data-action]");
    if (footerButton) {
      const action = footerButton.dataset.action;
      if (action === "apply-all") {
        this.handlers.onApplyAllSafe?.(this.report);
      } else if (action === "revert-all") {
        this.handlers.onRevertAll?.(this.report);
        this.resetCards();
      } else if (action === "export") {
        this.handlers.onExport?.(this.report);
      }
      return;
    }
    const issueButton = event.target.closest("button[data-issue-id]");
    if (!issueButton) {
      return;
    }
    const issueId = issueButton.dataset.issueId;
    const card = this.cards.get(issueId);
    if (!card) {
      return;
    }
    const issue = card.issue;
    const actionType = issueButton.dataset.actionType;
    if (actionType === "apply") {
      const replaceCheckbox = card.element.querySelector("input[type='checkbox'][data-toggle='replace']");
      const replaceText = replaceCheckbox ? replaceCheckbox.checked : false;
      this.handlers.onApply?.(issue, { replaceText });
      card.element.classList.add("issue-applied");
    } else if (actionType === "copy") {
      const text = issue.suggestion || "";
      navigator.clipboard?.writeText(text).catch(() => {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        this.shadow.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      });
      card.element.classList.add("issue-copied");
    } else if (actionType === "ignore") {
      card.element.classList.add("issue-ignored");
      setTimeout(() => card.element.remove(), 200);
      this.cards.delete(issueId);
      this.clearHighlight();
      this.handlers.onIgnore?.(issue);
    } else if (actionType === "reveal") {
      this.highlightIssue(issue, { scroll: true, pulse: true });
    }
  }

  handleKeydown(event) {
    if (event.key === "Enter" && event.target.closest(".issue-card")) {
      event.preventDefault();
      const button = event.target.closest(".issue-card").querySelector("button[data-action-type='apply']");
      button?.click();
    }
  }

  render(report, handlers) {
    this.handlers = handlers;
    const settings = handlers?.settings;
    this.report = report;
    this.currentSettings = settings;
    this.cards.clear();
    this.replaceState.clear();
    this.isHidden = false;

    const summaryText = this.panel.querySelector(".summary-text");
    summaryText.textContent = report.summary || "No textual summary generated.";
    const summaryAlt = this.panel.querySelector(".summary-alt");
    if (report.summaryAlt) {
      summaryAlt.hidden = false;
      summaryAlt.textContent = `Preferred language (${resolveLanguageLabel(settings)}): ${report.summaryAlt}`;
    } else {
      summaryAlt.hidden = true;
      summaryAlt.textContent = "";
    }

    this.renderSection("images", report.images, settings);
    this.renderSection("links", report.links, settings);
    this.renderSection("headings", report.headings, settings);

    this.showPanel();
    this.panel.focus({ preventScroll: true });
  }

  renderSection(sectionName, issues, settings) {
    const section = this.panel.querySelector(`section[data-section='${sectionName}'] .issue-list`);
    section.innerHTML = "";
    if (!issues?.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "All good here!";
      section.appendChild(empty);
      return;
    }
    issues.forEach((issue) => {
      const card = this.createIssueCard(issue, settings);
      section.appendChild(card.element);
      this.cards.set(issue.id, card);
    });
  }

  createIssueCard(issue, settings) {
    const element = document.createElement("article");
    element.className = "issue-card";
    element.tabIndex = 0;
    element.dataset.issueId = issue.id;

    const currentText = deriveCurrentText(issue);

    element.innerHTML = `
      <header>
        <h3>${formatIssueTitle(issue)}</h3>
        <p class="issue-reason">${issue.reason || "Needs review"}</p>
      </header>
      <div class="issue-body">
        <div class="issue-current"><strong>Current:</strong> ${currentText || "(empty)"}</div>
        <div class="issue-suggestion"><strong>Suggestion:</strong> <span>${issue.suggestion || "(none)"}</span></div>
        ${issue.translatedSuggestion ? `<div class="issue-translation"><strong>${resolveLanguageLabel(settings)}:</strong> ${issue.translatedSuggestion}</div>` : ""}
        ${issue.context ? `<details><summary>Context</summary><p>${truncateText(issue.context, 320)}</p></details>` : ""}
      </div>
      <div class="issue-controls">
        <div class="issue-toggles">
          ${issue.canReplaceText ? toggleTemplate(issue, settings) : ""}
        </div>
        <div class="issue-buttons">
          <button type="button" data-action-type="reveal" data-issue-id="${issue.id}">Reveal 👁️</button>
          <button type="button" data-action-type="apply" data-issue-id="${issue.id}">Apply ✅</button>
          <button type="button" data-action-type="copy" data-issue-id="${issue.id}">Copy 📋</button>
          <button type="button" data-action-type="ignore" data-issue-id="${issue.id}">Ignore 🚫</button>
        </div>
      </div>
    `;

    element.addEventListener("mouseenter", () => this.highlightIssue(issue));
    element.addEventListener("mouseleave", () => this.clearHighlight());
    element.addEventListener("focusin", () => this.highlightIssue(issue));
    element.addEventListener("focusout", () => this.clearHighlight());

    const replaceCheckbox = element.querySelector("input[type='checkbox'][data-toggle='replace']");
    if (replaceCheckbox) {
      replaceCheckbox.addEventListener("change", () => {
        this.replaceState.set(issue.id, replaceCheckbox.checked);
      });
      if (issue.type === "link" && settings?.preferAriaLabel) {
        replaceCheckbox.checked = false;
      }
      if (issue.type === "heading") {
        replaceCheckbox.checked = false;
      }
    }

    return { element, issue };
  }

  updateProgress(event) {
    const container = this.panel.querySelector(".panel-progress");
    const progressValue = this.panel.querySelector(".progress-value");
    const label = this.panel.querySelector(".progress-label");
    if (!event || !event.total) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    const ratio = Math.min(1, event.loaded / event.total);
    progressValue.style.width = `${Math.round(ratio * 100)}%`;
    label.textContent = `Downloading ${event.kind} (${Math.round(ratio * 100)}%)`;
  }

  resetCards() {
    this.cards.forEach((card) => {
      card.element.classList.remove("issue-applied", "issue-ignored", "issue-copied");
    });
    this.clearHighlight();
  }

  highlightIssue(issue, options = {}) {
    if (!issue?.element) {
      return;
    }
    if (options.scroll) {
      issue.element.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    this.clearHighlight();
    issue.element.classList.add("a11y-copy-helper-target-highlight");
    this.highlighted = issue.element;
    if (options.pulse && typeof issue.element.animate === "function") {
      issue.element.animate(
        [
          { transform: "scale(1)", boxShadow: "0 0 0 0 rgba(249, 115, 22, 0.0)" },
          { transform: "scale(1.02)", boxShadow: "0 0 0 8px rgba(249, 115, 22, 0.15)" },
          { transform: "scale(1)", boxShadow: "0 0 0 0 rgba(249, 115, 22, 0.0)" }
        ],
        { duration: 700, easing: "ease-out" }
      );
    }
  }

  clearHighlight() {
    if (this.highlighted) {
      this.highlighted.classList.remove("a11y-copy-helper-target-highlight");
      this.highlighted = null;
    }
  }

  hidePanel() {
    if (this.isHidden) {
      return;
    }
    this.clearHighlight();
    this.panel.setAttribute("aria-hidden", "true");
    this.panel.classList.add("panel-hidden");
    this.isHidden = true;
    this.showDock();
  }

  showPanel() {
    this.panel.setAttribute("aria-hidden", "false");
    this.panel.classList.remove("panel-hidden");
    this.isHidden = false;
    this.removeDock();
    this.clampPosition();
  }

  showDock() {
    if (document.getElementById(DOCK_ID)) {
      return;
    }
    const button = document.createElement("button");
    button.id = DOCK_ID;
    button.className = "a11y-copy-helper-dock";
    button.type = "button";
    button.textContent = "AltSpark >>";
    button.addEventListener("click", () => {
      this.showPanel();
      this.panel.focus({ preventScroll: true });
    });
    document.body.appendChild(button);
  }

  removeDock() {
    const existing = document.getElementById(DOCK_ID);
    if (existing) {
      existing.remove();
    }
  }

  startDrag(event) {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const rect = this.panel.getBoundingClientRect();
    this.dragState = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    this.panel.addEventListener("pointermove", this.onDragMove);
    this.panel.addEventListener("pointerup", this.onDragEnd);
    this.panel.addEventListener("pointercancel", this.onDragEnd);
    this.panel.classList.add("panel-dragging");
  }

  onDragMove(event) {
    if (!this.dragState || event.pointerId !== this.dragState.pointerId) {
      return;
    }
    event.preventDefault();
    const { offsetX, offsetY } = this.dragState;
    let left = event.clientX - offsetX;
    let top = event.clientY - offsetY;
    const maxLeft = window.innerWidth - this.panel.offsetWidth - 12;
    const maxTop = window.innerHeight - this.panel.offsetHeight - 12;
    left = Math.min(Math.max(12, left), Math.max(12, maxLeft));
    top = Math.min(Math.max(12, top), Math.max(12, maxTop));
    this.panel.style.left = `${left}px`;
    this.panel.style.top = `${top}px`;
    this.panel.style.right = "auto";
    this.panel.style.bottom = "auto";
  }

  onDragEnd(event) {
    if (!this.dragState || event.pointerId !== this.dragState.pointerId) {
      return;
    }
    const handle = this.panel.querySelector(".panel-drag-handle");
    handle?.releasePointerCapture(event.pointerId);
    this.panel.removeEventListener("pointermove", this.onDragMove);
    this.panel.removeEventListener("pointerup", this.onDragEnd);
    this.panel.removeEventListener("pointercancel", this.onDragEnd);
    this.panel.classList.remove("panel-dragging");
    this.dragState = null;
  }

  clampPosition() {
    if (!this.panel) {
      return;
    }
    const rect = this.panel.getBoundingClientRect();
    let left = rect.left;
    let top = rect.top;
    const maxLeft = window.innerWidth - rect.width - 12;
    const maxTop = window.innerHeight - rect.height - 12;
    left = Math.min(Math.max(12, left), Math.max(12, maxLeft));
    top = Math.min(Math.max(12, top), Math.max(12, maxTop));
    this.panel.style.left = `${left}px`;
    this.panel.style.top = `${top}px`;
    this.panel.style.right = "auto";
    this.panel.style.bottom = "auto";
  }
}

function toggleTemplate(issue, settings) {
  const id = `toggle-${issue.id}`;
  const defaultLabel = issue.type === "link" ? "Replace link text" : "Replace heading text";
  const defaultChecked = issue.type === "link" ? !settings?.preferAriaLabel : false;
  return `
    <label class="replace-toggle" for="${id}">
      <input id="${id}" type="checkbox" data-toggle="replace" ${defaultChecked ? "checked" : ""} />
      ${defaultLabel}
    </label>
  `;
}

function resolveLanguageLabel(settings) {
  if (!settings) {
    return "Preferred";
  }
  if (settings.userLanguage === "auto") {
    const lang = navigator.language || "en";
    return lang.toUpperCase();
  }
  return settings.userLanguage.toUpperCase();
}

function formatIssueTitle(issue) {
  switch (issue.type) {
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

function deriveCurrentText(issue) {
  if (!issue?.element) {
    return "";
  }
  if (issue.type === "image") {
    if (Object.prototype.hasOwnProperty.call(issue, "originalAltText")) {
      const snapshot = issue.originalAltText;
      if (typeof snapshot === "string" && snapshot.trim()) {
        return snapshot.trim();
      }
      return "(empty)";
    }
    return issue.element.getAttribute("alt") || "(empty)";
  }
  if (issue.type === "link" || issue.type === "heading") {
    return issue.element.innerText || issue.element.textContent || "";
  }
  return "";
}

let overlayInstance = null;

export function renderReport(report, handlers) {
  if (!overlayInstance) {
    overlayInstance = new OverlayUI(handlers);
  }
  overlayInstance.render(report, handlers);
}

export function updateProgress(event) {
  overlayInstance?.updateProgress(event);
}

export function closeOverlay() {
  overlayInstance?.destroy();
  overlayInstance = null;
}

export function hideOverlay() {
  overlayInstance?.hidePanel();
}

export function showOverlay() {
  overlayInstance?.showPanel();
}

