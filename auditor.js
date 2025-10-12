import { resolveUserLanguage } from "./storage.js";
import { normalizeElementList } from "./dom-utils.js";

const DEBUG_AUDITOR_LOGGING = false;

// Link labels we consider too vague to be accessible
const VAGUE_LINK_PATTERNS = [
  /^\s*(click\s+here)\s*$/i,
  /^\s*(read\s+more)\s*$/i,
  /^\s*(more)\s*$/i,
  /^\s*(more\s+info|more\s+information)\s*$/i,
  /^\s*(learn\s+more)\s*$/i,
  /^\s*(see\s+more|see\s+all|see\s+gallery)\s*$/i,
  /^\s*(view\s+details|view\s+more)\s*$/i,
  /^\s*(here)\s*$/i,
  /^\s*(hier\s+klicken)\s*$/i,
  /^\s*(cliquez\s+ici)\s*$/i,
  /^\s*(haz\s+clic\s+aqu\u00ED)\s*$/i,
  /^\s*(clicca\s+qui)\s*$/i,
];

// Headings that are unlikely to give screen reader users enough context
const GENERIC_HEADINGS = [
  /^update$/i,
  /^welcome$/i,
  /^news$/i,
  /^important$/i,
  /^announcement$/i,
  /^section$/i,
  /^overview$/i,
];

const PLACEHOLDER_ALT_PATTERNS = [
  /^\s*(image|photo|picture|graphic|icon|logo)\s*$/i,
  /^\s*(stock\s+photo|placeholder)\s*$/i,
];

const MAX_ALT_LENGTH = 160;
const MAX_ALT_WORDS = 30;

let issueCounter = 0;

// Create a predictable, unique identifier for each finding
function nextIssueId(type) {
  issueCounter += 1;
  return `${type}-${Date.now()}-${issueCounter}`;
}

// Collapse whitespace so comparisons and prompts stay tidy
function normalizeText(value) {
  if (!value) {
    return "";
  }
  return value.replace(/\s+/g, " ").trim();
}

// Skip icons and tracking pixels that do not need alternative text
function isDecorativeImage(img) {
  if (img.hasAttribute("alt") && img.getAttribute("alt") !== "") {
    return false;
  }
  if (img.getAttribute("role") === "presentation") {
    return true;
  }
  if (img.getAttribute("aria-hidden") === "true") {
    return true;
  }
  const width = Number(img.getAttribute("width")) || img.width || img.naturalWidth || 0;
  const height = Number(img.getAttribute("height")) || img.height || img.naturalHeight || 0;
  if (width && height && Math.max(width, height) <= 16) {
    return true;
  }
  if (width <= 1 && height <= 1) {
    return true;
  }
  const computed = window.getComputedStyle(img);
  if (computed && computed.backgroundImage && computed.backgroundImage !== "none") {
    return true;
  }
  return false;
}

// Read the text for any id referenced by aria-labelledby
function getLabelledText(idList) {
  if (!idList) {
    return "";
  }
  return idList
    .split(/\s+/)
    .map((id) => document.getElementById(id))
    .filter(Boolean)
    .map((el) => el.innerText || el.textContent || "")
    .join(" ");
}

// Collect nearby copy so the AI has context when drafting suggestions
function getNearestContext(node) {
  const parts = [];
  if (node.closest) {
    const figure = node.closest("figure");
    if (figure) {
      const caption = figure.querySelector("figcaption");
      if (caption) {
        parts.push(caption.innerText);
      }
    }
  }
  let parent = node.parentElement;
  while (parent && parts.join(" ").length < 400) {
    if (parent.matches("section, article, main, aside, header, footer")) {
      const heading = parent.querySelector("h1, h2, h3, h4, h5, h6");
      if (heading) {
        parts.push(heading.innerText);
      }
      parts.push(parent.innerText || "");
      break;
    }
    parent = parent.parentElement;
  }
  const preceding = previousVisibleText(node, 400);
  if (preceding) {
    parts.push(preceding);
  }
  return normalizeText(parts.join(" ").slice(0, 2000));
}

// Clean noisy context so prompts stay concise
function cleanContext(value = "") {
  if (!value) {
    return "";
  }
  return value
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\b\w+\.(?:jpg|jpeg|png|gif|webp|svg)\b/gi, " ")
    .replace(/[A-Z0-9\/_-]{5,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Walk backwards in the DOM until we find some nearby readable text
function previousVisibleText(node, limit) {
  let cursor = node;
  while (cursor) {
    if (cursor.previousElementSibling) {
      cursor = cursor.previousElementSibling;
      const text = normalizeText(cursor.innerText || cursor.textContent);
      if (text) {
        return text.slice(-limit);
      }
    } else {
      cursor = cursor.parentElement;
    }
  }
  return "";
}

function isImageElement(node) {
  return Boolean(node && node.nodeType === Node.ELEMENT_NODE && node.tagName === "IMG");
}

function isLinkElement(node) {
  return Boolean(
    node &&
    node.nodeType === Node.ELEMENT_NODE &&
    node.tagName === "A" &&
    node.hasAttribute("href")
  );
}

function isHeadingElement(node) {
  return Boolean(node && node.nodeType === Node.ELEMENT_NODE && /^H[1-6]$/.test(node.tagName));
}

function selectHintCandidates(hintSet, predicate) {
  if (!hintSet || !hintSet.size) {
    return null;
  }
  const unique = new Set();
  for (const node of hintSet) {
    if (!predicate(node)) {
      continue;
    }
    unique.add(node);
  }
  return unique.size ? Array.from(unique) : null;
}

// Treat long strings of capital letters as shouting
function isAllCaps(text) {
  if (!text) {
    return false;
  }
  const letters = text.replace(/[^A-Z\u00C0-\u00DD]+/g, "");
  if (letters.length < 4) {
    return false;
  }
  return letters === letters.toUpperCase();
}

// Respect user-selected ranges when we run a partial audit
function withinSelection(element, scope, range) {
  if (scope === "page" || !range) {
    return true;
  }
  try {
    return range.intersectsNode(element);
  } catch (_error) {
    return false;
  }
}

// Trim verbose alt text so it stays within recommended limits
function clampAlt(text) {
  if (!text) {
    return "";
  }
  let trimmed = text.trim();
  if (trimmed.length > 300) {
    trimmed = `${trimmed.slice(0, 297).trim()}...`;
  }
  return trimmed;
}

// Provide a translated suggestion when the user's language differs
async function maybeTranslate(ai, suggestion, language, settings) {
  if (!settings.offerTranslations) {
    return null;
  }
  if (!suggestion || !suggestion.trim()) {
    return null;
  }
  const preferred = resolveUserLanguage(settings);
  if (!preferred || !language || preferred.toLowerCase().startsWith(language.toLowerCase())) {
    return null;
  }
  const translated = await ai.translateText(suggestion, preferred, language);
  if (!translated || translated.trim() === suggestion.trim()) {
    return null;
  }
  return translated.trim();
}

// Runs the individual accessibility checks and tracks the resulting issues
export class Auditor {
  // Keep references to the AI helper and the current user preferences
  constructor(aiClient, settings) {
    this.ai = aiClient;
    this.settings = settings;
    this.issues = [];
  }

  // Undo any previous fixes so we do not stack changes between audits
  clearHistory() {
    this.issues.forEach((issue) => issue.revert?.());
    this.issues = [];
  }

  // Main entry point: gather findings for images, links, and headings
  async audit({ scope = "page", range = null, hintNodes = null, budget = Infinity } = {}) {
    this.clearHistory();
    const normalizedHints = normalizeElementList(hintNodes);
    const hintSet = normalizedHints ? new Set(normalizedHints) : null;
    const scopeText = scope === "selection" && range ? range.toString() : sampleDocumentText(8000);
    const languageInfo = await this.ai.detectLanguage(scopeText.slice(0, 8000));
    const language = languageInfo.language || document.documentElement.getAttribute("lang") || "en";
    const summaryContext = generateSummaryContext(scope, range);
    const summary = await this.ai.summarizeText(summaryContext, { type: "key-points", language });
    const report = {
      language,
      summary,
      summaryAlt: null,
      images: [],
      links: [],
      headings: [],
    };
    const finiteBudget = Number.isFinite(budget);
    let remainingBudget = finiteBudget ? Math.max(0, Math.floor(budget)) : Infinity;
    let hasMore = false;

    if (this.settings.auditImages) {
      const imageResult = await this.auditImages(scope, range, language, hintSet, remainingBudget);
      report.images.push(...imageResult.issues);
      if (finiteBudget) {
        remainingBudget = Math.max(0, remainingBudget - imageResult.used);
      }
      hasMore = hasMore || imageResult.hasMore;
    }
    if (this.settings.auditLinks) {
      const linkResult = await this.auditLinks(scope, range, language, hintSet, remainingBudget);
      report.links.push(...linkResult.issues);
      if (finiteBudget) {
        remainingBudget = Math.max(0, remainingBudget - linkResult.used);
      }
      hasMore = hasMore || linkResult.hasMore;
    }
    if (this.settings.auditHeadings) {
      const headingResult = await this.auditHeadings(scope, range, language, hintSet, remainingBudget);
      report.headings.push(...headingResult.issues);
      if (finiteBudget) {
        remainingBudget = Math.max(0, remainingBudget - headingResult.used);
      }
      hasMore = hasMore || headingResult.hasMore;
    }

    report.summaryAlt = await maybeTranslate(this.ai, summary, language, this.settings);
    report.hasMore = Boolean(hasMore);
    report.meta = {
      budgetRequested: finiteBudget ? Math.max(0, Math.floor(budget)) : null,
      budgetRemaining: finiteBudget ? Math.max(0, remainingBudget) : null,
      hintCount: normalizedHints ? normalizedHints.length : 0,
    };

    return report;
  }

  // Wrap apply/revert so callers always get a reliable undo function
  registerIssue(issue) {
    issue.lastUndo = null;
    issue.apply = (options = {}) => {
      if (issue.lastUndo) {
        try {
          issue.lastUndo();
        } catch (error) {
          console.warn("[AltSpark] Failed to revert previous state", error);
        }
        issue.lastUndo = null;
      }
      if (typeof issue._apply === "function") {
        const undo = issue._apply(options);
        if (typeof undo === "function") {
          issue.lastUndo = undo;
        }
      }
    };
    issue.revert = () => {
      if (issue.lastUndo) {
        try {
          issue.lastUndo();
        } finally {
          issue.lastUndo = null;
        }
      }
    };
    this.issues.push(issue);
    return issue;
  }

  // Flag images that are missing helpful alternative text
  async auditImages(scope, range, language, hintSet, budget) {
    const issues = [];
    const hintCandidates = selectHintCandidates(hintSet, isImageElement);
    const imgs = hintCandidates && hintCandidates.length ? hintCandidates : Array.from(document.images);
    const finiteBudget = Number.isFinite(budget);
    const limit = finiteBudget ? Math.max(0, Math.floor(budget)) : Infinity;
    let processed = 0;
    let hasMore = false;
    for (const img of imgs) {
      if (!withinSelection(img, scope, range)) {
        continue;
      }
      if (finiteBudget && processed >= limit) {
        hasMore = true;
        break;
      }
      processed += 1;
      const rawAlt = img.getAttribute("alt");
      const trimmedAlt = rawAlt ? rawAlt.trim() : "";
      const hasAlt = Boolean(trimmedAlt);
      const placeholderAlt = hasAlt && PLACEHOLDER_ALT_PATTERNS.some((pattern) => pattern.test(trimmedAlt));
      const verboseAlt =
        hasAlt && (trimmedAlt.length > MAX_ALT_LENGTH || trimmedAlt.split(/\s+/).length > MAX_ALT_WORDS);

      if (!hasAlt && isDecorativeImage(img)) {
        const issue = this.registerIssue({
          id: nextIssueId("img"),
          type: "image",
          element: img,
          reason: "Likely decorative image without empty alt",
          suggestion: "Mark image as decorative",
          translatedSuggestion: null,
          language,
          safe: true,
          suggestionType: "decorative",
          _apply: () => {
            const prevAlt = img.getAttribute("alt");
            const prevHidden = img.getAttribute("aria-hidden");
            img.setAttribute("alt", "");
            img.setAttribute("aria-hidden", "true");
            return () => {
              if (prevAlt === null) {
                img.removeAttribute("alt");
              } else {
                img.setAttribute("alt", prevAlt);
              }
              if (prevHidden === null) {
                img.removeAttribute("aria-hidden");
              } else {
                img.setAttribute("aria-hidden", prevHidden);
              }
            };
          },
        });
        issues.push(issue);
        continue;
      }

      if (hasAlt && !placeholderAlt && !verboseAlt) {
        continue;
      }

      const contextParts = [
        getLabelledText(img.getAttribute("aria-labelledby")),
        img.getAttribute("aria-label"),
        img.getAttribute("title"),
        getNearestContext(img),
      ];
      const rawContext = normalizeText(contextParts.filter(Boolean).join(" "));
      const cleanedContext = cleanContext(rawContext);
      const displayContext = cleanedContext || rawContext || "";

      const describeImage = async () => {
        let suggestion = null;
        try {
          suggestion = await this.ai.describeImageWithPrompt?.(img, { language });
          if (suggestion) {
            return clampAlt(suggestion);
          }
        } catch (_error) {
          if (DEBUG_AUDITOR_LOGGING) {
            console.log("[AltSpark][Auditor] describeImageWithPrompt error", _error);
          }
        }
        let seed = cleanedContext
          ? await this.ai.summarizeText(cleanedContext, { type: "tldr", language })
          : "";
        if (!seed) {
          seed = cleanedContext || trimmedAlt || "Describe this image concisely.";
        }
        suggestion = await this.ai.rewriteText(
          seed,
          'Provide a concise alt text under 125 characters without saying "Image of". Focus on purpose.',
          { language }
        );
        suggestion = clampAlt(suggestion) || null;
        if (suggestion && cleanedContext && suggestion.toLowerCase() === cleanedContext.toLowerCase()) {
          suggestion =
            clampAlt(
              await this.ai.rewriteText(
                cleanedContext,
                'Describe the key subject of the image in under 125 characters without using file names.',
                { language }
              ),
            ) || suggestion;
        }
        return suggestion;
      };

      let suggestion = null;
      if (!hasAlt || placeholderAlt) {
        suggestion = await describeImage();
      }
      if (!suggestion && verboseAlt) {
        suggestion = clampAlt(
          await this.ai.rewriteText(
            trimmedAlt,
            'Rewrite this alt text so it stays under 125 characters while keeping the main subject clear.',
            { language }
          )
        );
        if (suggestion && suggestion.toLowerCase() === trimmedAlt.toLowerCase()) {
          suggestion =
            clampAlt(
              await this.ai.rewriteText(
                cleanedContext || trimmedAlt,
                'Summarize the key subject of this image in under 125 characters without repeating unnecessary detail.',
                { language }
              )
            ) || suggestion;
        }
      }
      if (!suggestion) {
        suggestion = clampAlt(trimmedAlt || displayContext || "Descriptive image");
      }
      const translated = suggestion
        ? await maybeTranslate(this.ai, suggestion, language, this.settings)
        : null;
      const reason = !hasAlt
        ? "Image missing descriptive alt text"
        : placeholderAlt
        ? "Image alt text is too vague"
        : "Image alt text is too long";

      const issue = this.registerIssue({
        id: nextIssueId("img"),
        type: "image",
        element: img,
        reason,
        suggestion,
        translatedSuggestion: translated,
        language,
        safe: true,
        suggestionType: "alt",
        context: displayContext || trimmedAlt || "Context unavailable.",
        _apply: () => {
          const prevAlt = img.getAttribute("alt");
          const prevHidden = img.getAttribute("aria-hidden");
          const nextAlt = (translated || suggestion || "").trim();
          img.setAttribute("alt", nextAlt);
          img.removeAttribute("aria-hidden");
          return () => {
            if (prevAlt === null) {
              img.removeAttribute("alt");
            } else {
              img.setAttribute("alt", prevAlt);
            }
            if (prevHidden === null) {
              img.removeAttribute("aria-hidden");
            } else {
              img.setAttribute("aria-hidden", prevHidden);
            }
          };
        },
      });
      issues.push(issue);
    }
    return { issues, used: processed, hasMore };
  }

  // Catch vague link phrases and suggest clearer labels
  async auditLinks(scope, range, language, hintSet, budget) {
    const issues = [];
    const hintCandidates = selectHintCandidates(hintSet, isLinkElement);
    const anchors = hintCandidates && hintCandidates.length
      ? hintCandidates
      : Array.from(document.querySelectorAll("a[href]"));
    const finiteBudget = Number.isFinite(budget);
    const limit = finiteBudget ? Math.max(0, Math.floor(budget)) : Infinity;
    let processed = 0;
    let hasMore = false;
    for (const anchor of anchors) {
      if (!withinSelection(anchor, scope, range)) {
        continue;
      }
      if (finiteBudget && processed >= limit) {
        hasMore = true;
        break;
      }
      processed += 1;
      const label = normalizeText(anchor.innerText || anchor.textContent);
      if (!label) {
        continue;
      }
      if (!VAGUE_LINK_PATTERNS.some((pattern) => pattern.test(label))) {
        continue;
      }
      if (anchor.getAttribute("aria-label")) {
        continue;
      }
      const ariaLabelled = getLabelledText(anchor.getAttribute("aria-labelledby"));
      if (ariaLabelled) {
        continue;
      }
      const contextParts = [
        anchor.getAttribute("title"),
        anchor.closest("article, section, div, li")?.innerText,
        previousVisibleText(anchor, 400),
      ];
      const context = normalizeText(contextParts.filter(Boolean).join(" ")).slice(0, 2000);
      const suggestion = normalizeText(
        await this.ai.rewriteText(
          context || label,
          "Write a short aria-label that clearly states where the link goes or what action it performs.",
          { language }
        ) || `${label} destination`
      ).slice(0, 120);
      const translated = await maybeTranslate(this.ai, suggestion, language, this.settings);
      const issue = this.registerIssue({
        id: nextIssueId("lnk"),
        type: "link",
        element: anchor,
        reason: "Vague link text",
        suggestion,
        translatedSuggestion: translated,
        language,
        safe: true,
        context,
        _apply: ({ replaceText = false } = {}) => {
          const prevLabel = anchor.getAttribute("aria-label");
          const prevText = anchor.innerText;
          if (replaceText) {
            anchor.innerText = suggestion;
            anchor.removeAttribute("aria-label");
          } else {
            anchor.setAttribute("aria-label", suggestion);
          }
          return () => {
            if (replaceText) {
              anchor.innerText = prevText;
              if (prevLabel === null) {
                anchor.removeAttribute("aria-label");
              } else {
                anchor.setAttribute("aria-label", prevLabel);
              }
            } else if (prevLabel === null) {
              anchor.removeAttribute("aria-label");
            } else {
              anchor.setAttribute("aria-label", prevLabel);
            }
          };
        },
      });
      issue.canReplaceText = true;
      issues.push(issue);
    }
    return { issues, used: processed, hasMore };
  }

  // Spot headings that are too long, generic, or aggressive
  async auditHeadings(scope, range, language, hintSet, budget) {
    const issues = [];
    const hintCandidates = selectHintCandidates(hintSet, isHeadingElement);
    const headings = hintCandidates && hintCandidates.length
      ? hintCandidates
      : Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"));
    const finiteBudget = Number.isFinite(budget);
    const limit = finiteBudget ? Math.max(0, Math.floor(budget)) : Infinity;
    let processed = 0;
    let hasMore = false;
    for (const heading of headings) {
      if (!withinSelection(heading, scope, range)) {
        continue;
      }
      if (finiteBudget && processed >= limit) {
        hasMore = true;
        break;
      }
      processed += 1;
      const text = normalizeText(heading.innerText || heading.textContent);
      if (!text) {
        continue;
      }
      let reason = null;
      if (text.length > 70) {
        reason = "Heading is longer than 70 characters.";
      } else if (isAllCaps(text)) {
        reason = "Heading is in all caps.";
      } else if (GENERIC_HEADINGS.some((pattern) => pattern.test(text))) {
        reason = "Heading is too generic.";
      }
      if (!reason) {
        continue;
      }
      const contextParts = [
        text,
        heading.closest("section, article, div")?.innerText,
        previousVisibleText(heading, 400),
      ];
      const context = normalizeText(contextParts.filter(Boolean).join(" ")).slice(0, 2200);
      const suggestion = normalizeText(
        await this.ai.rewriteText(
          context,
          "Draft a heading under 60 characters that reflects the key message or topic in a friendly title case.",
          { language }
        ) || text.slice(0, 60)
      ).slice(0, 80);
      const translated = await maybeTranslate(this.ai, suggestion, language, this.settings);
      const issue = this.registerIssue({
        id: nextIssueId("hdg"),
        type: "heading",
        element: heading,
        reason,
        suggestion,
        translatedSuggestion: translated,
        language,
        safe: false,
        context,
        _apply: ({ replaceText = false } = {}) => {
          const markerId = `a11y-copy-helper-preview-${issue.id}`;
          const prevPreview = document.getElementById(markerId);
          const prevText = heading.innerText;
          if (replaceText) {
            heading.innerText = suggestion;
          } else if (!prevPreview) {
            const badge = document.createElement("span");
            badge.id = markerId;
            badge.textContent = suggestion;
            badge.setAttribute("role", "note");
            badge.className = "a11y-copy-helper-heading-preview";
            heading.dataset.a11yCopyHelperPreviewId = markerId;
            heading.insertAdjacentElement("afterend", badge);
          }
          return () => {
            if (replaceText) {
              heading.innerText = prevText;
            } else {
              const previewEl = document.getElementById(markerId);
              if (previewEl) {
                previewEl.remove();
              }
              delete heading.dataset.a11yCopyHelperPreviewId;
            }
          };
        },
      });
      issue.canReplaceText = true;
      issues.push(issue);
    }
    return { issues, used: processed, hasMore };
  }

  // Restore the page to its original state after previewing fixes
  revertAll() {
    for (const issue of this.issues) {
      issue.revert();
    }
  }
}

// Build a short summary block for the AI when describing the page
function generateSummaryContext(scope, range) {
  if (scope === "selection" && range) {
    return range.toString().slice(0, 4000);
  }
  return `${document.title}\n${sampleDocumentText(6000)}`;
}

function sampleDocumentText(limit = 6000) {
  const root = document.body || document.documentElement;
  if (!root) {
    return "";
  }
  const snippets = [];
  const seenNodes = new Set();
  let collected = 0;

  const pushSnippet = (value) => {
    if (!value) {
      return false;
    }
    const normalized = normalizeText(value);
    if (!normalized) {
      return false;
    }
    const remaining = limit - collected;
    if (remaining <= 0) {
      return true;
    }
    const snippet = normalized.slice(0, remaining);
    snippets.push(snippet);
    collected += snippet.length;
    return collected >= limit;
  };

  const selectors = [
    "main h1, main h2, main p, main li",
    "article h1, article h2, article p, article li",
    "section h1, section h2, section p",
    "header h1, header h2",
    "h1, h2, h3",
    "p",
    "li",
  ];
  const MAX_PER_SELECTOR = 40;

  outer: for (const selector of selectors) {
    const nodes = root.querySelectorAll(selector);
    let used = 0;
    for (const node of nodes) {
      if (used >= MAX_PER_SELECTOR) {
        break;
      }
      if (seenNodes.has(node)) {
        continue;
      }
      seenNodes.add(node);
      used += 1;
      if (pushSnippet(node.textContent || "")) {
        break outer;
      }
    }
  }

  if (collected < limit * 0.5) {
    pushSnippet(root.textContent || "");
  }

  return snippets.join(" ");
}
