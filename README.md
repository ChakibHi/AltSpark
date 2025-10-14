# AltSpark
_Made with ♥ by Hicham_

A Chrome MV3 extension that audits any page or text selection for copy-level accessibility issues (alt text, vague links, generic headings) using Chrome's on-device AI models. Suggestions stay local to your browser; no page content is sent to external services.

## Features

- Auto-mode continuous scanning with automatic fixes (opt-in).
- Inline activation prompt ensures Chrome's on-device AI models get the required user gesture once per page.

- Audit any tab or highlighted selection via context menus or the `Ctrl/Cmd+Shift+L` shortcut.
- Lightweight popup shows live finding counts, lifetime totals, and pause toggles, with one-click access to the side panel.
- Side panel groups findings for images, links, and headings with Apply/Copy/Ignore actions, plus inline settings that sync instantly.
- On-device AI (LanguageDetector, Summarizer, Translator, Writer fallback) tailors suggestions to the detected language and tone.
- Multimodal image descriptions use Chrome's LanguageModel to propose alt text when photos lack descriptions.
- Badge, lifetime metrics, auto-apply safe fixes, and per-site pause/whitelist controls keep automation under your control.

## Usage

**Quick Start**

1. Enable Auto-mode from the popup to let AltSpark monitor tabs automatically.
2. When prompted, click once on the page to finish enabling on-device models—after that, audits run on their own.
3. Use the side panel to manage exclusions, inspect applied fixes, or run manual audits.

1. Load the unpacked extension via `chrome://extensions` (enable Developer Mode, choose the `a11y-copy-helper` folder).
2. Right-click any page or highlighted text and pick **AltSpark: Audit page** or **AltSpark: Audit selection**, or use the keyboard shortcut.
3. Review findings in the side panel or overlay, apply safe changes instantly, copy suggestions, or ignore items that do not apply.

## Manual testing page

- [docs/altspark-test-page.html](docs/altspark-test-page.html) — open this file in a browser tab to try the extension against intentionally mixed-quality copy. The page includes:
  - Images with missing, generic, and overly long alt text for rewrite comparisons.
  - Ambiguous link labels, repetitive headings, and short body copy to exercise the auditor.
  - A sample form with incomplete labelling to validate selection-based rewrites.

## Architecture: Chrome On-Device AI Flow

```
+----------------+      +------------------------+      +---------------------+
| Popup / Panels | <--> | Background Service     | <--> | Content Script &    |
| (toolbar UI)   |      | Worker (event broker)  |      | Auditor (page logic) |
+----------------+      +------------------------+      +---------------------+
                                                            |
                                                            v
                                              Chrome On-Device AI APIs
                                   (languageDetector, summarizer, translator, languageModel, writer)
```

1. **Auto-mode or user triggers an audit** - background requests now come from Auto-mode (when enabled) or from the popup, side panel, context menu, or shortcut. The background service worker ensures the content script is injected and relays the audit request.
2. **Content script runs the Auditor** - it gathers page context, normalises copy, and calls into the `AIClient` wrapper. Auto-mode reuses this pipeline to apply safe fixes incrementally and publish live counts.
3. **AIClient talks to Chrome AI APIs** -
   - `chrome.ai.languageDetector` determines language and confidence.
   - `chrome.ai.summarizer` condenses nearby text so headings and links get better prompts.
   - `chrome.ai.translator` offers alternative wording in the user's preferred language when needed.
   - `chrome.ai.languageModel` handles multimodal prompts to describe images and bootstrap accurate alt text.
   - `chrome.ai.writer` (with a `languageModel` fallback) rewrites phrases to be clearer and more accessible.
4. **Findings flow back through the background** - the content script registers issues, updates counts, and shares them with the background, which keeps the badge, metrics, and site preferences in sync.
5. **UI surfaces stay in sync** - the popup and side panel query the background for status, apply/pause automation, and dispatch actions (apply, ignore, revert) back to the content script.

Persistent settings and per-site overrides live in Chrome storage (`chrome.storage.sync` when available). Lifetime metrics are updated in the background after each audit, giving the popup its total count since install.

## Permissions

- `activeTab`, `scripting`: inject the audit overlay and content script on-demand.
- `contextMenus`, `commands`: register context menu entries and keyboard shortcut.
- `storage`: persist user settings, automation switches, and metrics.
- `sidePanel`: integrate the Chrome side panel UI.
- `<all_urls>` host permission: needed to audit any site the user chooses.

## Privacy

All processing happens with Chrome's built-in AI APIs in the browser. No analytics. No external network requests for page content or suggestions.
