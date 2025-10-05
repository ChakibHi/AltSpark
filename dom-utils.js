export function truncateText(value = "", limit = 240, options = {}) {
  const { ellipsis = "...", trim = false } = options;
  const text = trim ? String(value ?? "").trim() : String(value ?? "");
  if (!Number.isFinite(limit) || limit <= 0 || text.length <= limit) {
    return text;
  }
  const sliceLength = Math.max(0, limit - ellipsis.length);
  const sliced = text.slice(0, sliceLength);
  const trimmed = trim ? sliced.trim() : sliced;
  return `${trimmed}${ellipsis}`;
}

export function normalizeElementList(nodes) {
  if (!nodes) {
    return null;
  }
  const source = Array.isArray(nodes) ? nodes : Array.from(nodes);
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

export function isExtensionContextInvalid(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return message.includes("extension context invalidated");
}
