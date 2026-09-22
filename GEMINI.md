# ChatGPT Context Monitor — Agent Engineering Guidelines (GEMINI.md)

This document establishes the project-specific operational rules, architectural boundaries, and engineering disciplines for AI agents modifying the **ChatGPT Context Monitor** Chrome Extension.

---

## 1. Required Skills & Authority Hierarchy

Every agent working on this codebase must strictly apply and follow these three foundational skills:

1. **`high-performance-agent`** (`.agents/skills/high-performance-agent/SKILL.md`):
   * Operating Loop: **UNDERSTAND → PLAN → EXECUTE → VERIFY → ATTACK → FIX → VERIFY AGAIN**.
   * Two-Agent Verification: **Solver** creates minimal solution; **Adversarial Reviewer** actively searches for regressions, bugs, and edge cases.
   * Evidence discipline: fact → evidence → inference → confidence.
2. **`chrome-extension-engineering`** (`.agents/skills/chrome-extension-engineering/SKILL.md`):
   * Project authority order: **Official Chrome Docs > Google Chrome Skill > Third-Party Guidance**.
   * Enforces the 20 Manifest V3 non-negotiable rules, epistemic accuracy taxonomy, and project layer structure.
3. **`chrome-extensions`** (`C:\Users\dhari\.gemini\config\plugins\modern-web-guidance-plugin\skills\chrome-extensions\SKILL.md`):
   * Modern Manifest V3 standards, CSP sandboxing, async message response patterns, and Chrome Web Store publishing guidelines.

---

## 2. Architecture & Important Workflows

The extension operates across three isolated browser contexts coordinated via message passing:

```text
[ MAIN World: ChatGPT Web ]
  │ window.fetch & XHR instrumentation (content/network-interceptor.js)
  │ window.dispatchEvent(CustomEvent)
  ▼
[ ISOLATED World: Content Script ] (content/content-script.js built via scripts/build.js)
  ├── Lifecycle & Event Routing (content/content-main.js)
  ├── DOM Extraction & Mutation Observer (content/chatgpt-dom.js, message-extractor.js)
  ├── Authoritative Backend API Client (content/conversation-client.js)
  ├── Live Network Stream Observer (network/request-observer.js)
  ├── Multi-Source Evidence Reconciliation (engine/evidence-merger.js)
  ├── Local Offline BPE Tokenizer (engine/tokenizer.js via js-tiktoken)
  ├── Context Calculator & Epistemic Classifier (engine/context-calculator.js, context-classifier.js)
  ├── Explainable Confidence Engine (engine/confidence-engine.js)
  └── In-Page Shadow DOM HUD Overlay (content/overlay-ui.js)
  │
  ├── chrome.storage.session.set({ latestContextState })
  └── chrome.runtime.sendMessage({ type: 'CONTEXT_UPDATED' })
  ▼
[ BACKGROUND Service Worker ] (background/service-worker.js)
  └── Updates extension toolbar badge (text & color) based on utilization
  ▲
  └── Queries state for Action Popup
[ ACTION POPUP Dashboard ] (popup/popup.html, popup.js, popup.css)
  └── Analytics breakdown, Evidence & Confidence cards, Lower-Bound indicator
```

### Build Pipeline Invariant
* Modular files in `engine/` and `content/` are bundled into a standalone `content/content-script.js` via `node scripts/build.js`.
* **Rule**: Whenever editing code in `engine/`, `content/`, or `network/`, you **must** run `npm run build` so that `content/content-script.js` is refreshed.

---

## 3. Existing Project Conventions & Invariants

1. **Manifest V3 Strictness**:
   * No `eval()`, `new Function()`, or inline scripts in HTML.
   * Service worker is ephemeral: never store state in global memory variables; use `chrome.storage.session` or `chrome.storage.local`.
   * For async listeners in `chrome.runtime.onMessage`, **always synchronously return `true;`** to keep the message channel open.
2. **Truth-in-Measurement Standard**:
   * Visible conversation tokens $\ne$ total prompt context. Hidden server-side prompts, developer instructions, tool schemas, and vector memory retrieval are strictly unobservable from the client.
   * Standardized Evidence Taxonomy:
     * `EXACT`: Authoritative usage metadata directly from OpenAI or API.
     * `OBSERVED`: Directly captured from live DOM or network headers.
     * `ESTIMATED`: Calibrated local calculation (e.g. BPE token counts).
     * `UNKNOWN`: Unobservable server-side parameters.
   * **Zero Fabrication**: Never invent token counts for system instructions, tool schemas, or memory vectors.
3. **Source Priority Invariant**:
   $$\text{Authoritative API (4)} > \text{Network Stream (3)} > \text{DOM Scraping (2)} > \text{Local Inference / DB (1)} > \text{Unknown (0)}$$
4. **Field-Level Provenance**:
   * Every metric carries `{ value, source, evidenceType }`.
   * Source disagreements must be recorded in `conflicts` (`{ field, winning, discarded, reason }`) rather than silently dropped.
5. **Local-First Privacy**:
   * 100% offline tokenization. Zero conversation text or user data leaves the browser.
   * Host permissions strictly scoped to `https://chatgpt.com/*` and `https://chat.openai.com/*`.

---

## 4. Generic vs. Site-Specific Logic Boundaries

* **Generic Engine Core (`engine/`)**:
  * Files: `tokenizer.js`, `context-calculator.js`, `context-classifier.js`, `confidence-engine.js`, `evidence-merger.js`.
  * **Boundary**: Completely DOM-free, headless, and platform-agnostic. Operates strictly on normalized JavaScript objects (`messages[]`, `parts[]`, `model`, `attachments`, `tools`, `completeness`).
  * **Rule**: Never import DOM utilities or hardcode ChatGPT HTML class names into `engine/`.
* **Site-Specific Adapters (`content/`, `network/`, `config/`)**:
  * Files: `chatgpt-dom.js`, `message-extractor.js`, `model-detector.js`, `attachment-detector.js`, `tool-detector.js`, `conversation-client.js`, `request-observer.js`.
  * **Boundary**: Handles ChatGPT single-page application mutations, selectors, and API endpoints (`/backend-api/conversation/*`).
  * **Rule**: Normalize all extracted site data into generic structures before passing to `engine/`.

---

## 5. Auto Detection vs. Manual Detection

* **Automatic Detection**:
  * **Model Resolution**: Reconciles authoritative API slug $\rightarrow$ network payload $\rightarrow$ DOM header switcher button $\rightarrow$ `config/model-limits.json`. Fallback is `unknown` (with `null` context window), never an arbitrary hardcoded 128K.
  * **Tools & MCP**: Automatically captures both network tool calls (`web_search`, python code interpreter) and DOM tool execution chips.
  * **Streaming**: Debounced via `requestAnimationFrame` to prevent UI thrashing during assistant generation.
* **Manual Interaction**:
  * Popup "⟳ Rescan" button and HUD collapse/expand triggers refresh view from cached session state without clearing in-flight streaming turn buffers.

---

## 6. Container Detection vs. Item Detection

* **Container Detection (`main`, `[role="presentation"]`)**:
  * Identifies the active chat viewport and observes mutations.
  * Measures whether DOM virtualization is active (e.g. when 2 turns are mounted in the DOM while 12 turns exist in the conversation tree).
* **Item Detection (`article[data-testid^="conversation-turn-"]`, `div[data-message-author-role]`)**:
  * Extracts turn roles (`user` vs `assistant`), structured `parts[]` (text, images, code blocks, document references), and message IDs.
  * Deduplicates items by message ID to prevent double-counting when streaming deltas arrive simultaneously from network and DOM.

---

## 7. Initial Extraction vs. Collect More / Pagination / Virtualization

* **Initial Navigation / Switch**:
  * Extracts visible DOM turns as immediate baseline.
  * Resolves active conversation ID from URL query/path and triggers `ConversationClient.fetchConversation(id)`.
* **Authoritative Ground Truth Reconciliation**:
  * If API succeeds: reconstructs the active branch from `root` to `current_node` (excluding abandoned edit branches).
  * If `authoritativeTurnCount > renderedTurnCount`: flags `domIsPartial = true`, records `virtualizationGap`.
* **API Offline / DOM Fallback**:
  * If existing conversation API is unreachable: marks `domIsPartial = true`, sets `completenessSource = 'dom_partial'`.
  * Flags context as **Lower Bound** (`serverContextCompleteness.isLowerBound = true`), triggering warning banners in HUD and popup, and applying virtualization confidence penalties.

---

## 8. Debugging & Root-Cause Methodology

When investigating issues, observe the **Iron Law**: find and verify the root cause before writing fixes.

1. **Identify the Execution Context**:
   * Content Script / Overlay: In-page Chrome DevTools Console.
   * Network Interceptor: Page Console with prefix `[ChatGPT Network Interceptor]`.
   * Service Worker: `chrome://extensions` → "Inspect views: service worker".
   * Action Popup: Right-click popup icon → "Inspect".
2. **Trace the Real Execution Flow**:
   $$\text{Network/DOM Event} \rightarrow \text{Extractor/Interceptor} \rightarrow \text{EvidenceMerger} \rightarrow \text{ContextCalculator} \rightarrow \text{OverlayUI/Popup}$$
   * Validate real runtime payloads against expected shapes rather than guessing.
3. **Avoid Heuristic Hacks**:
   * Never modify `engine/` calculation math to fix an upstream extraction or timing issue.
   * Never use a site-specific workaround in generic engine modules unless proven to be a universal engine bug.

---

## 9. Testing & Regression Verification

Regression prevention is strictly enforced across 7 test suites:

1. **Test Architecture**:
   * Pure Node.js test runner via `node test/run-tests.js`.
   * Fast, isolated execution without external testing framework bloat.
   * Node-based DOM mocks for `document`, `MutationObserver`, and `CustomEvent`.
   * In-memory mocks for `chrome.runtime`, `chrome.storage.local`, and `chrome.storage.session`.
2. **Core Test Suites**:
   * `test/test-tokenizer.js`: BPE tokenization, caching, chat markup overhead, edge cases.
   * `test/test-model-detector.js`: Model slug matching, context window lookup, unknown fallback.
   * `test/test-context-calculator.js`: Token aggregation, utilization percentages, epistemic classifications.
   * `test/test-conversation-client.js`: Tree-branch traversal, message mapping, node parsing, attachment references.
   * `test/test-network-intelligence.js`: MAIN-world event handling, streaming delta assembly, token aggregation.
   * `test/test-context-completeness.js`: Virtualization gap detection, DOM partial detection, lower-bound indicators.
   * `test/test-evidence-confidence.js`: 4-tier evidence tagging (`EXACT`, `OBSERVED`, `ESTIMATED`, `UNKNOWN`), source priority resolution, explainable confidence calculation, conflict logging.
3. **Regression Protocol**:
   * Run `npm test` after any change (baseline: 232+ tests passing).
   * Verify both the reported failure case and existing baseline workflows.
   * Always write a targeted test case reproducing the issue before implementing a fix.
   * Run `npm run validate` to enforce all 12 Manifest V3 rules.

---

## 10. Safe Change & Modification Rules

Every AI agent modifying this repository must adhere to the **10 Core Agent Behaviors**:

1. **Follow relevant project skills before working**: Read and apply `high-performance-agent`, `chrome-extension-engineering`, and `chrome-extensions`.
2. **Inspect existing implementations before creating new ones**: Check existing modules (`EvidenceMerger`, `ContextClassifier`, `ConversationClient`, etc.) before adding new files or structures.
3. **Trace the real execution flow before changing code**: Verify call graphs, event dispatching, and message payload structures across MAIN, ISOLATED, and BACKGROUND worlds.
4. **Find and verify the root cause before fixing**: Adhere to the Iron Law of debugging. Formulate and verify hypotheses with evidence before making edits.
5. **Prefer the smallest correct change**: Avoid wide refactoring, unnecessary dependencies, or style rewrites.
6. **Never use a site-specific workaround to alter generic logic**: Keep `engine/` pure and generic; confine ChatGPT-specific DOM or payload quirks to `content/` and `network/` adapters.
7. **Preserve existing working behavior**: Maintain all established invariants from Groups A–E (epistemic honesty, BPE calibration, tree traversal, streaming assembly, confidence scoring).
8. **Verify both the reported failure and related working cases**: Confirm the fix addresses the bug while leaving all adjacent paths healthy.
9. **Review the final diff for unintended changes**: Run `git diff` prior to completion to catch accidental edits, leftover logging, or unintended line ending modifications.
10. **Never claim a fix without verification**: Provide command outputs, test run counts, and concrete validation evidence in the response.

---

## 11. Known Failure Patterns & Preventions

| Failure Pattern | Consequence | Prevention Rule |
| :--- | :--- | :--- |
| **Stale Build Bundle** | Browser extension runs old code despite file edits | Run `node scripts/build.js` after touching `engine/`, `content/`, or `network/`. |
| **Async Port Disconnect** | `sendResponse` throws "The message port closed before a response was received" | Synchronously `return true;` from `chrome.runtime.onMessage` when responding asynchronously. |
| **Service Worker State Evaporation** | Counters/state reset after 30s of inactivity | Store state in `chrome.storage.session` or `chrome.storage.local`; never use global variables in worker. |
| **Main-Thread UI Freeze** | ChatGPT chat lag or stutter during streaming | Debounce DOM observer callbacks; tokenize only the streaming turn incrementally using LRU cache. |
| **Arbitrary Confidence** | Misleading 95%+ confidence on unknown/partial data | Never hardcode confidence; evaluate evidence completeness and penalize unknown tools, files, or partial DOM. |
| **Fabricated Hidden Tokens** | Inaccurate token counts for server prompts | Classify system prompt, MCP tool schemas, and vector memory context contribution as `UNKNOWN`. |

---

## 12. Definition of Done (DoD)

A task or bug fix is complete only when all the following conditions are met:

1. **Code Quality**: Clean, modular Manifest V3 code adhering to security, privacy, and architectural boundaries.
2. **Bundle Rebuilt**: `npm run build` executes cleanly and updates `content/content-script.js`.
3. **Unit & Integration Tests**: `npm test` passes 100% of test suites (232+ tests, 0 failures).
4. **Manifest V3 Pre-Flight Check**: `npm run validate` passes all 12 extension validation rules.
5. **Release Packaging**: `npm run pack` verifies bundle contents.
6. **Adversarial Review**: Code has been reviewed against regressions, edge cases, and unexpected side effects.
7. **Proof Provided**: Test run evidence and exact results are documented in the final report.
