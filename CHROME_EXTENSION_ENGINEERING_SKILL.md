# Chrome Extension Engineering Standard & Skill Reference
**Project:** ChatGPT Context Monitor  
**Target Platform:** Chromium / Chrome Extension (Manifest V3)

---

## 1. Executive Summary & Source Hierarchy

This repository adheres to the **Chrome Extension Engineering Standard** compiled from three core sources with the following precedence:

1. **Official Chrome for Developers Documentation** (`https://developer.chrome.com/docs/extensions`): Authoritative reference for Chrome Extension platform APIs, permissions, and Manifest V3 constraints.
2. **Google Chrome Chrome Extensions Skill** (`GoogleChrome/modern-web-guidance`): Primary engineering practices, architecture patterns, and critical pitfall mitigations.
3. **Browser Extension Skills** (`quangpl/browser-extension-skills`): Supplementary guidance for implementation workflows, testing, asset generation, and Chrome Web Store auditing.

> **Precedence Rule:** When instructions conflict, always defer to:  
> **Official Chrome Documentation > Google Chrome Skill > Third-Party Guidance.**

---

## 2. Manifest V3 Engineering Rules

Every component of this extension must comply with these 20 platform integrity rules:

| Rule | Area | Requirement |
| :--- | :--- | :--- |
| **1** | **Icons** | Only reference files that physically exist with exact dimensions (16, 48, 128 px), or omit the `"icons"` field entirely. |
| **2** | **Side Panel** | Use `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` (NOT `IconClick`) in the background worker. Do not specify `default_popup` if opening the side panel on action click. |
| **3** | **CSP & Code Exec** | No `eval()`, `new Function()`, or inline scripts. Sandbox dynamic code execution via manifest `"sandbox"` and `postMessage`, or `srcdoc`/`Blob` URLs. |
| **4** | **Tabs URL Access** | Accessing `tab.url` or `tab.title` requires the `"tabs"` permission; without it, `tab.url` silently returns `undefined`. |
| **5** | **Async / Await** | Always use `async`/`await`. In `runtime.onMessage` listeners performing async actions, return `true` synchronously to keep the port open. |
| **6** | **Content Scripts** | Never block the main ChatGPT thread. Batch DOM updates with `requestAnimationFrame` and yield using `scheduler.yield()`. |
| **7** | **Ephemeral SW** | Service workers terminate after ~30s idle. Never store state in variables. Persist in `chrome.storage.local` or `chrome.storage.session`. Use `chrome.alarms` instead of `setInterval`/`setTimeout`. |
| **8** | **Extension ID** | Use a stable `"key"` in `manifest.json` for development if consistent extension IDs are required. |
| **9** | **Context Menus** | Always provide immediate visual confirmation (toast, badge, notification) for context menu actions. |
| **10** | **`chrome.action`** | Declare `"action": {}` in `manifest.json` whenever using `chrome.action.*` APIs. |
| **11** | **`activeTab` Limit** | `activeTab` only activates on direct user gestures (toolbar icon/context menu), not button clicks in side panels or popups. Use explicit `host_permissions` for persistent domain scripting. |
| **12** | **DevTools Panels** | HTML panel paths in `chrome.devtools.panels.create()` must be relative to the extension root. |
| **13** | **Offscreen Docs** | Offscreen documents have access to Web APIs and `chrome.runtime`, but cannot access `chrome.action`, `chrome.tabs`, `chrome.downloads`, etc. |
| **14** | **Image References**| All paths passed to `chrome.notifications` or `chrome.action.setIcon` must exist as physical files or valid data URLs. |
| **15** | **Capture Locking** | Tab capture requires state-machine locking (`idle` → `starting` → `recording` → `stopping`) in `chrome.storage.session` to avoid double-start errors. |
| **16** | **Desktop Capture** | `chrome.desktopCapture.chooseDesktopMedia()` from a service worker requires a target tab object with `url` populated (requiring `"tabs"` permission). |
| **17** | **User Scripts** | Check `isUserScriptsAvailable()` before invoking `chrome.userScripts.*`; API throws if disabled by the user. |
| **18** | **`chrome.windows`**| Use `getAll()`, `getCurrent()`, or `getLastFocused()`. There is NO `chrome.windows.query()` method. |
| **19** | **Permissions API** | Call `chrome.permissions.request()` immediately and synchronously inside a user gesture listener. Any `await` prior to the call forfeits user activation. |
| **20** | **MV3 Exclusivity** | Never use MV2 properties (`background.scripts`, `chrome.browserAction`, `chrome.tabs.executeScript`). |

---

## 3. Project Constraints: ChatGPT Context Monitor

### 3.1 Truth-in-Measurement & Accuracy Taxonomy
Every metric displayed by the extension must explicitly display its confidence category:

```text
┌─────────────────────────┬────────────────────────────────────────────────────────┐
│ Category                │ Meaning                                                │
├─────────────────────────┼────────────────────────────────────────────────────────┤
│ EXACT                   │ Authoritative usage metadata directly from OpenAI/API  │
│ OBSERVED                │ Directly extracted from UI/network (model name, files) │
│ ESTIMATED               │ Calculated from observable content (local tokenizer)   │
│ UNKNOWN                 │ Unexposed server-side data (hidden system prompts, etc)│
└─────────────────────────┴────────────────────────────────────────────────────────┘
```

### 3.2 The Iron Laws of Context Measurement
1. **DOM tokens ≠ Total model context:** The visible conversation is only one part of the context window.
2. **Zero fabrication:** Never invent token counts for:
   - System or developer instructions
   - Memory retrieval
   - MCP or plugin tool definitions
   - Web / search result payloads
   - Hidden server-side formatting
3. **Explicit Unknowns:** When context elements are present but unmeasurable, mark them explicitly as `UNKNOWN`.
4. **No universal limits:** Always reference `config/model-limits.json` for verified model limits, citing OpenAI documentation sources and verification dates.

### 3.3 Modular Architecture & Separation of Concerns
- **`content/`**: UI & DOM extraction (`chatgpt-dom.js`, `message-extractor.js`, `model-detector.js`, `overlay-ui.js`).
- **`engine/`**: Mathematical analysis (`tokenizer.js`, `context-calculator.js`, `context-classifier.js`, `confidence-engine.js`).
- **`network/`**: Passive request inspection (research layer, with full fallback to DOM).
- **`background/`**: Service worker lifecycle, alarms, extension badge.
- **`popup/`**: Dashboard UI for metrics breakdown.
- **`config/`**: JSON configuration for model context sizes and fallback selector lists.

### 3.4 Resilient DOM Observation
- Use `MutationObserver` on `main` / `body` with trailing debounce (100–150ms).
- Avoid relying on fragile, hashed CSS classes. Use semantic roles (`[role="presentation"]`, `article`, `[data-message-author-role]`, `[data-testid]`).
- Cache per-message token counts (`messageId → tokenCount`) so streaming responses only recalculate the active turn.

### 3.5 Privacy & Permissions Minimization
- **Strictly Local-First:** All tokenization and context estimation runs in-browser. Zero chat content leaves the user's browser.
- **Minimum Permissions:** Request only `"storage"`, and constrain `host_permissions` exclusively to:
  * `https://chatgpt.com/*`
  * `https://chat.openai.com/*`

---

## 4. Implementation Protocol
Before writing major extension code:
1. **Repository Audit:** Inspect existing codebase and plan.
2. **Skill Application:** Verify architecture against the Manifest V3 rules.
3. **API & Permission Scoping:** Determine required Chrome APIs and keep permissions minimal.
4. **Official Documentation Validation:** Confirm Chrome API signatures and constraints.
5. **Incremental Building & Verification:** Implement layer by layer (DOM extraction → Tokenizer → Calculator → UI Overlay), verifying each stage with unit and fixture tests before proceeding.
6. **Preserve Fallbacks:** Always retain fallback selectors and estimation mechanisms if network or internal APIs change.
