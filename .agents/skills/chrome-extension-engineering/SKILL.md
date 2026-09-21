---
name: chrome-extension-engineering
description: >
  Definitive engineering standard and development lifecycle skill for Chrome Manifest V3 extensions,
  specifically governing ChatGPT Context Monitor. Integrates Google Chrome Extensions standards,
  official Chrome for Developers documentation, and production testing/security practices.
---

# Chrome Extension Engineering Standard: ChatGPT Context Monitor

## 1. Authority Hierarchy & Conflict Resolution

When engineering Chrome Extensions, reference materials must be applied in this strict order of precedence:
1. **Official Chrome for Developers Documentation** (`https://developer.chrome.com/docs/extensions`): Authoritative specification for all Chrome platform APIs, lifecycle behaviors, permissions, and Manifest V3 constraints.
2. **Google Chrome Chrome Extensions Skill** (`GoogleChrome/modern-web-guidance`): Primary engineering skill, architectural patterns, and failure-prevention rules.
3. **Browser Extension Skills** (`quangpl/browser-extension-skills`): Supplementary implementation workflows, scaffolding, testing strategies, and audit checklists.

**Conflict Resolution Rule:**
`Official Chrome Documentation > Google Chrome Skill > Third-Party Guidance`

---

## 2. Manifest V3 Core Architecture & Non-Negotiable Rules

All code must strictly adhere to Chrome Manifest V3. Violating any of these 20 rules leads to runtime crashes, silent failures, or Chrome Web Store rejection:

1. **Icons:**
   - Only reference actual image files that exist on disk with exact pixel dimensions (`16x16`, `48x48`, `128x128`).
   - If icons cannot be provided immediately, omit `"icons"` and `"default_icon"` entirely; Chrome provides a default puzzle icon.
   - Never reference nonexistent files or reuse a single file for all dimensions.

2. **Side Panel & Action Triggers:**
   - Defining `"side_panel": { "default_path": "sidepanel.html" }` does not automatically open it.
   - To open on action click: use `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` in the service worker.
   - **Crucial:** The property is `openPanelOnActionClick`, NOT `openPanelOnActionIconClick` (the latter throws a silent TypeError that terminates the service worker).
   - Do NOT define `default_popup` if using `action.onClicked` or `openPanelOnActionClick`.

3. **Code Execution & CSP Restrictions:**
   - MV3 CSP strictly forbids `eval()`, `new Function()`, and remote/inline script execution.
   - If sandboxed evaluation or parsing is necessary:
     * Use manifest `"sandbox": { "pages": ["sandbox.html"] }` and communicate via `postMessage`.
     * Or use Blob URLs / `srcdoc` within sandboxed frames.
   - All HTML files must load scripts via external files: `<script src="file.js"></script>`. No inline event handlers (`onclick="..."`).

4. **Tab URL Access & Permissions:**
   - Accessing `tab.url` or `tab.title` requires the `"tabs"` permission or an active gesture invoking `activeTab`. Without it, `tab.url` silently returns `undefined` with no error thrown.

5. **Async/Await Standard & Message Responses:**
   - Always use `async`/`await`; avoid unhandled `.then()` promise chains.
   - For `chrome.runtime.onMessage.addListener((message, sender, sendResponse) => { ... })`:
     * If responding asynchronously, you MUST return `true;` synchronously from the listener to keep the communication channel open.
     * Wrap async listener logic in an IIFE or async function and call `sendResponse({ ... })`.

6. **Content Scripts Main-Thread Discipline:**
   - Content scripts share the DOM and CPU execution thread with ChatGPT Web.
   - Never block the main thread. Batch DOM updates using `requestAnimationFrame` and `scheduler.yield()` / debounced ticks.

7. **Ephemeral Service Workers & State Persistence:**
   - Extension service workers terminate after ~30 seconds of inactivity or when idle.
   - **Never** store state in global memory variables within the service worker.
   - Persist all state in `chrome.storage.local` or `chrome.storage.session`.
   - Never use `setTimeout` or `setInterval` for timers; use `chrome.alarms`.

8. **Chrome Identity & Extension ID:**
   - Unpacked extension IDs change between development environments and differ from the published Chrome Web Store ID.
   - When identity or OAuth is required, pin the public key using `"key"` in `manifest.json`.

9. **Actionable Context Menus:**
   - Any background action executed from a context menu or command must provide clear user confirmation (badge flash, notification, or injected toast).

10. **`chrome.action` Declaration:**
    - Using `chrome.action.setBadgeText`, `chrome.action.setIcon`, or `chrome.action.onClicked` requires an `"action": {}` declaration in `manifest.json`. Without it, `chrome.action` is `undefined`.

11. **`activeTab` Limitations:**
    - `activeTab` only grants temporary tab access upon a direct user gesture (clicking the toolbar action or context menu).
    - It does **not** grant access from a button click inside a side panel or detached popup.
    - For continuous DOM inspection on ChatGPT, declare explicit `host_permissions: ["https://chatgpt.com/*", "https://chat.openai.com/*"]`.

12. **DevTools Panel Resolution:**
    - Paths passed to `chrome.devtools.panels.create()` must be relative to the extension root, not relative to the devtools HTML caller.

13. **Offscreen Document Scope:**
    - Offscreen documents (`chrome.offscreen`) have access to Web APIs (DOM, audio, canvas, MediaRecorder) and `chrome.runtime`, but **no access** to `chrome.action`, `chrome.tabs`, `chrome.downloads`, etc.
    - The service worker handles `chrome.*` APIs; offscreen documents handle DOM/Web APIs.

14. **Valid Image References:**
    - `chrome.notifications.create`, `chrome.action.setIcon`, and context menus require valid, existing image paths or canvas data URLs. Missing paths fail with `"Unable to download all specified images"`.

15. **Capture State Locking:**
    - Tab and media capture APIs (`chrome.tabCapture`) fail if duplicate capture is triggered. Use explicit state locking machines (`idle` → `starting` → `active` → `stopping`) persisted in `chrome.storage.session`.

16. **Desktop Capture Target Tab:**
    - `chrome.desktopCapture.chooseDesktopMedia()` called from a service worker requires passing a target tab with the `url` field populated (requiring `"tabs"` permission).

17. **User Scripts Verification:**
    - `chrome.userScripts` throws an error if user scripts are disabled by the user in `chrome://extensions`. Check `isUserScriptsAvailable()` before calling.

18. **`chrome.windows` Method Availability:**
    - `chrome.windows` does NOT have a `.query()` method. Use `getAll()`, `getCurrent()`, or `getLastFocused()`.

19. **Synchronous User Gestures for Permissions:**
    - `chrome.permissions.request()` must be called synchronously inside a user-gesture event handler. A single `await` gap destroys the transient activation token.

20. **Manifest V3 Declarations Only:**
    - Use `background.service_worker` (not `background.scripts`).
    - Use `chrome.scripting` (not `chrome.tabs.executeScript`).
    - Keep `host_permissions` separated from `permissions`.

---

## 3. Project Architecture: ChatGPT Context Monitor

To maintain clear separation of concerns, the project must adhere to this directory layout:

```text
chatgpt-context-monitor/
├── manifest.json
├── config/
│   ├── model-limits.json            # Versioned model context definitions
│   └── selectors.json               # Semantic selectors & fallback cascading definitions
├── content/
│   ├── chatgpt-dom.js               # MutationObserver & lifecycle orchestration
│   ├── message-extractor.js         # Semantic extraction of user & assistant messages
│   ├── model-detector.js            # Active model and mode detection
│   ├── attachment-detector.js       # File, code, image, and canvas detection
│   └── overlay-ui.js                # Injected HUD / non-intrusive meter
├── engine/
│   ├── tokenizer.js                 # Local tokenizer (tiktoken / BPE / calibrated heuristics)
│   ├── context-calculator.js        # Token aggregation & calculation engine
│   ├── context-classifier.js        # EXACT / OBSERVED / ESTIMATED / UNKNOWN categorization
│   └── confidence-engine.js         # Confidence score & measurement uncertainty
├── network/
│   └── request-observer.js          # Experimental/passive network inspection & validation
├── background/
│   └── service-worker.js            # Badge updates, storage coordination, alarms
├── popup/
│   ├── popup.html                   # Detailed analytics breakdown dashboard
│   ├── popup.css                    # Modern, clean aesthetics
│   └── popup.js                     # Popup controller
├── assets/
│   └── icons/                       # 16, 48, 128 pixel icons
└── tests/
    ├── fixtures/                    # Saved HTML snapshots of ChatGPT conversations
    ├── unit/                        # Tokenizer, classifier, calculator tests
    └── e2e/                         # Extension loading & DOM extraction integration tests
```

---

## 4. Context Accuracy & Truth-in-Measurement Rules

The ChatGPT Context Monitor must never deceive the user or provide illusory precision. Every datum must be stamped with its epistemic classification:

### 4.1 Classification Taxonomy
- **`EXACT`**: Authoritative usage metadata directly exposed by the system or model API.
- **`OBSERVED`**: Directly verified from the active DOM or network headers (e.g., active model string `"GPT-4o"`, attached file name `"data.csv"` of size `14KB`).
- **`ESTIMATED`**: Calculated from observable data using tokenizers and heuristics (e.g., visible conversation text token count = 12,450 tokens).
- **`UNKNOWN`**: Unexposed, server-side, or unmeasurable data.

### 4.2 Non-Negotiable Accuracy Principles
1. **DOM Tokens ≠ Complete Context Window:**
   - Visible message text is only a fraction of the actual prompt submitted to OpenAI's models.
   - Actual context includes hidden system instructions, developer prompts, tool definitions, retrieval augmented memory, search context, and runtime formatting.
   - **Never** claim that conversation tokens represent 100% of model input.
2. **Zero Fabrication:**
   - Do **not** fabricate token counts for system prompts, memories, or MCP tool definitions unless exact or verifiable observed values exist.
   - If memory is enabled, mark it as: `Memory: Enabled (Observed) | Context Contribution: UNKNOWN`.
   - If web search occurred, mark it as: `Search: Executed (Observed) | Injected Tokens: UNKNOWN`.
3. **No Hardcoded Universal Limits:**
   - Never assume a single default context window (e.g. 128k) for all conversations.
   - Use `config/model-limits.json` mapping verified model names to verified limits, citing official sources and last verified dates.
   - If the model is unidentified, report: `Model: UNKNOWN | Context Window: UNKNOWN`.
4. **No Artificial Free-Tier Counters:**
   - Do not display arbitrary counters like `"24 / 50 messages used"` unless ChatGPT explicitly displays this limit in the UI.

---

## 5. Robust DOM Extraction & Dynamic Mutation Handling

ChatGPT is a complex single-page React application with streaming responses, virtualized lists, and frequent UI updates.

### 5.1 Semantic & Role-Based Selector Strategy
- Avoid fragile, dynamically generated class names (e.g., `.css-19zjg`, `.text-token-text-primary`).
- Prioritize stable attributes:
  * Role attributes: `[role="presentation"]`, `article`, `[data-message-author-role]`
  * Stable semantic tags: `main`, `form textarea`, `button[aria-label]`
  * Test attributes: `[data-testid="conversation-turn-..."]`, `[data-testid="model-switcher-dropdown"]`
- Implement a **Cascading Selector Fallback**:
  ```js
  const MESSAGE_SELECTORS = [
    'article[data-testid^="conversation-turn-"]',
    'div[data-message-author-role]',
    'main article',
    '.conversation-turn'
  ];
  ```

### 5.2 MutationObserver & Streaming Handling
- **Observation:** Observe mutations on `main` or `body` with `childList: true, subtree: true, characterData: true`.
- **Debouncing:** Rapid token streaming during assistant responses can fire hundreds of mutations per second. Debounce processing using `requestAnimationFrame` or a micro-timer (e.g., 100ms trailing throttle).
- **Incremental Caching:** Cache token counts by message ID:
  ```text
  messageId -> { textHash, tokenCount }
  ```
  During streaming, re-tokenize only the active streaming turn. Static past turns are looked up from the cache in $O(1)$ time.

---

## 6. Privacy, Security & Permission Discipline

1. **Local-First Processing:**
   - All message extraction, tokenization, and context calculations must occur locally inside the browser.
   - Zero conversation text, message hashes, or token statistics may be transmitted to external servers.
2. **Minimum Permissions:**
   - Manifest `permissions`:
     * `"storage"`: for storing cached model configurations and user preferences.
   - Manifest `host_permissions`:
     * Strictly limited to ChatGPT domains:
       ```json
       "host_permissions": [
         "https://chatgpt.com/*",
         "https://chat.openai.com/*"
       ]
       ```
   - Do **not** request `<all_urls>`, `webRequest`, `cookies`, or arbitrary background permissions unless strictly necessary.

---

## 7. Quality Assurance, Testing & Debugging

1. **Unit Testing:**
   - Test `tokenizer.js` against verified token fixtures.
   - Test `model-limits.json` validation schema.
   - Test `context-classifier.js` categorizing edge cases (empty chats, mixed files, unknown models).
2. **DOM Regression Fixture Testing:**
   - Maintain HTML fixtures of real ChatGPT conversations (plain text, code blocks, tables, LaTeX, attachments, error messages).
   - Ensure `message-extractor.js` correctly extracts turns without missing or duplicate messages.
3. **Multi-Context Debugging Protocol:**
   - Content Script: Inspect through the active page DevTools console.
   - Service Worker: Inspect via `chrome://extensions` → "Inspect views: service worker".
   - Popup/Side Panel: Right-click inside the popup/panel and select "Inspect".

---

## 8. Chrome Web Store (CWS) Publishing Readiness

Every extension project must maintain a top-level `CHROMEWEBSTORE.md` containing:
- Plain-English justifications for every declared permission and host permission.
- Single-purpose statement complying with Google's Extension Quality Guidelines.
- Complete privacy disclosures confirming no user conversation data is collected or sold.
- Screenshot checklists (1280x800 or 640x400).
- Clean zip distribution instructions excluding `.git`, `node_modules`, and internal artifacts.
