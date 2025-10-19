**AltSpark Privacy Policy**

Effective date: October 19, 2025

AltSpark helps you improve copy‑level accessibility (image alt text, link labels, headings) using Chrome’s on‑device AI. We designed AltSpark to be private by default. This document explains what data is processed, what is stored, and your choices.

**Summary**
- Runs locally with Chrome’s built‑in models; no cloud calls by the extension.
- Does not collect analytics, personal data, or unique identifiers.
- Stores only settings, per‑site preferences, and simple aggregate counters in Chrome storage.
- No data is sold or shared with third parties.

**Data We Process (Ephemeral, On‑Device)**
- Page content and structure needed for audits (e.g., image elements, link text, headings) are read by the content script while you are on the page.
- For “Describe this image,” the image pixels may be read to produce an alt description. Processing occurs in your browser using on‑device models.
- This in‑page data is kept in memory only for the duration of the audit/action and is not transmitted off your device by the extension.

**Data We Store (Chrome Storage)**
- Settings: feature toggles (e.g., Auto‑mode on/off), language preferences, and UI options.
- Per‑site preferences: allow/deny Auto‑mode for specific hostnames.
- Aggregate metrics: counts of issues found/applied and total audits (numbers only; no URLs, page text, or images).
- Storage location: `chrome.storage.sync` when available (so your own Chrome profile can sync settings), otherwise `chrome.storage.local`.

You can clear this data at any time by uninstalling the extension, turning off Chrome Sync, or clearing site data for the extension. If a “Reset” option is exposed in settings, it deletes the same stored keys.

**What We Never Collect**
- No browsing history, page URLs, or full page content are transmitted to external servers.
- No account, email, IP, cookies, or advertising identifiers.
- No third‑party analytics or error reporting SDKs.

**On‑Device Models**
- AltSpark uses Chrome’s on‑device capabilities (such as Language Detector, Summarizer, Translator, Writer/Rewriter, and Language Model) via browser‑provided APIs. Model downloads and updates are handled by Chrome, not by AltSpark. AltSpark does not receive telemetry about model content.

**Permissions and Why We Need Them**
- `activeTab`: read the current page’s DOM to audit and apply in‑page fixes when you invoke the extension.
- `contextMenus`: add the “AltSpark: Describe this image” right‑click action.
- `scripting`: inject the content script that performs audits and applies safe fixes.
- `storage`: store your settings, per‑site preferences, and aggregate counters.
- `sidePanel`: show the side panel UI with findings.
- `offscreen`: host a lightweight offscreen document used to preload models and render the quick‑alt overlay resources.

We request the minimum required permissions and use them only for user‑visible features.

**Exports and Clipboard**
- If you choose to export findings, AltSpark generates a Markdown file locally for you to save or share.
- If you copy an alt description, the text is placed on your clipboard at your request.

**Children’s Privacy**
- AltSpark does not target children and does not collect personal information.

**Data Retention**
- In‑page data used during an audit is ephemeral and discarded when you leave the page or close the popup/side panel.
- Settings, per‑site preferences, and aggregate counters persist in Chrome storage until you clear them or uninstall the extension.

**Security**
- All processing is local to your browser. Chrome storage is managed by the browser and is protected by your Google account if sync is enabled.

**Your Choices**
- Disable Auto‑mode globally or per site, or pause it from the popup/side panel.
- Clear stored data via extension settings (if available) or by removing the extension / clearing Chrome storage for AltSpark.

**Policy Changes**
- We may update this policy as Chrome’s on‑device APIs evolve. We will update the effective date and include a brief summary of changes in the repository changelog.

**Contact**
- Questions or requests? Open an issue on the project’s GitHub repository or contact the maintainer via the listing email in the Chrome Web Store.

This policy is provided for transparency and does not constitute legal advice.
