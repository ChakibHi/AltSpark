const HIGHLIGHT_CLASS = "a11y-copy-helper-target-highlight";
const STYLE_ID = "a11y-copy-helper-highlight-style";

let highlightedElement = null;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .${HIGHLIGHT_CLASS} {
      outline: 3px solid #f97316 !important;
      outline-offset: 2px !important;
      box-shadow: 0 0 0 4px rgba(249, 115, 22, 0.35) !important;
      transition: outline 0.2s ease;
    }
  `;
  (document.head || document.documentElement || document.body || document).appendChild(style);
}

export function highlight(element, { scroll = false, pulse = false } = {}) {
  if (!element) {
    return;
  }
  ensureStyle();
  if (scroll) {
    try {
      element.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch (_error) {
      // ignore scroll failures
    }
  }
  clearHighlight();
  element.classList.add(HIGHLIGHT_CLASS);
  highlightedElement = element;
  if (pulse && typeof element.animate === "function") {
    element.animate(
      [
        { transform: "scale(1)", boxShadow: "0 0 0 0 rgba(249, 115, 22, 0)" },
        { transform: "scale(1.02)", boxShadow: "0 0 0 8px rgba(249, 115, 22, 0.18)" },
        { transform: "scale(1)", boxShadow: "0 0 0 0 rgba(249, 115, 22, 0)" },
      ],
      { duration: 700, easing: "ease-out" }
    );
  }
}

export function clearHighlight() {
  if (!highlightedElement) {
    return;
  }
  highlightedElement.classList.remove(HIGHLIGHT_CLASS);
  highlightedElement = null;
}

export function pulse(element) {
  highlight(element, { pulse: true });
}

export function isHighlighting(element) {
  return Boolean(highlightedElement && highlightedElement === element);
}

export function reset() {
  clearHighlight();
}
