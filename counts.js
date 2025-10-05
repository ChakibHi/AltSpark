export function clampToNonNegativeInt(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 0;
  }
  return Math.max(0, Math.round(num));
}

export function normalizeCountMap(raw = {}) {
  return {
    total: clampToNonNegativeInt(raw?.total),
    applied: clampToNonNegativeInt(raw?.applied),
    ignored: clampToNonNegativeInt(raw?.ignored),
    autoApplied: clampToNonNegativeInt(raw?.autoApplied),
    pending: clampToNonNegativeInt(raw?.pending),
  };
}

