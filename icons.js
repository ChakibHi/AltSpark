// Minimal Lucide icon markup extracted from lucide-static v0.545.0.
// Icons remain inline strings to avoid bundling dependencies at runtime.

const wand = `
<svg class="lucide lucide-wand" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="m15 4-3 3" />
  <path d="m14 9-1 1" />
  <path d="m5 14-3 3" />
  <path d="m14.5 17.5-2.5 2.5" />
  <path d="m8 9 5 5" />
  <path d="m2 20 1.5-1.5" />
  <path d="m20 2-2 2" />
  <path d="m18 5-7 7" />
</svg>
`;

const scan = `
<svg class="lucide lucide-scan" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 7V5a2 2 0 0 0-2-2h-2" />
  <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
  <path d="M3 7V5a2 2 0 0 1 2-2h2" />
  <path d="M3 17v2a2 2 0 0 0 2 2h2" />
  <rect width="8" height="8" x="8" y="8" rx="2" />
</svg>
`;

const panelRight = `
<svg class="lucide lucide-panel-right" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2Z" />
  <path d="M15 4v16" />
</svg>
`;

const sparkles = `
<svg class="lucide lucide-sparkles" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M5 3v4M3 5h4" />
  <path d="M19 11v4M17 13h4" />
  <path d="m11 21 2-2-2-2-2 2 2 2" />
  <path d="m21 3-6 6" />
  <path d="m3 21 6-6" />
</svg>
`;

const shieldCheck = `
<svg class="lucide lucide-shield-check" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 22c4.97-2.015 8-5.82 8-10V5l-8-3-8 3v7c0 4.18 3.03 7.985 8 10Z" />
  <path d="m9 12 2 2 4-4" />
</svg>
`;

const rotateCcw = `
<svg class="lucide lucide-rotate-ccw" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M3 2v6h6" />
  <path d="M3 13a9 9 0 1 0 3-7.24L3 8" />
</svg>
`;

const history = `
<svg class="lucide lucide-history" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M3 3v5h5" />
  <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
  <path d="M12 7v5l4 2" />
</svg>
`;

const fileDown = `
<svg class="lucide lucide-file-down" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
  <path d="M14 2v6h6" />
  <path d="M12 18v-6" />
  <path d="m9 15 3 3 3-3" />
</svg>
`;

const plus = `
<svg class="lucide lucide-plus" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 5v14" />
  <path d="M5 12h14" />
</svg>
`;

export const LUCIDE_ICONS = {
  wand,
  scan,
  panelRight,
  shieldCheck,
  rotateCcw,
  history,
  fileDown,
  plus,
  sparkles,
};

export function getIcon(name) {
  return LUCIDE_ICONS[name] || "";
}

