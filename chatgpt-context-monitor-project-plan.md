# ChatGPT Context Monitor --- Project Plan

## 1. Project Goal

Build a browser extension for ChatGPT Web that determines and displays
the **most accurate possible context-window usage** for the current
conversation.

The extension should show:

-   Current ChatGPT model/mode
-   Model context-window limit
-   Conversation token count
-   Estimated context utilization
-   Observable files/attachments
-   Observable memory/app/MCP/tool information
-   Known vs estimated vs unknown context
-   Confidence/accuracy level
-   Current plan/limit information when ChatGPT exposes it

### Core principle

Do **not** claim exact context usage unless authoritative usage/context
metadata is actually available.

The system must clearly distinguish:

-   **Exact** --- authoritative usage information
-   **Observed** --- directly detected from ChatGPT UI/network
-   **Estimated** --- calculated from observable content
-   **Unknown** --- server-side information that cannot be observed

------------------------------------------------------------------------

# 2. Key Technical Reality

ChatGPT Web does not provide a guaranteed public DOM element or public
browser API containing the complete current context-token count.

Therefore:

> DOM extraction alone cannot provide guaranteed exact context usage.

The extension should use a **hybrid architecture**:

``` text
ChatGPT Web
    │
    ├── DOM Observer
    │     ├── Messages
    │     ├── Model/mode
    │     ├── Attachments
    │     └── Visible UI state
    │
    ├── Network Observer
    │     └── Available request/usage metadata
    │
    └── Visible Settings / App State
          │
          ▼
    Context Collector
          │
          ▼
    Tokenizer + Context Engine
          │
          ├── Model limits
          ├── Conversation tokens
          ├── File estimates
          ├── Tool/MCP estimates
          └── Memory/context estimates
          │
          ▼
    Confidence Engine
          │
          ▼
    Context Dashboard
```

------------------------------------------------------------------------

# 3. Product Output

Example:

``` text
┌────────────────────────────────────┐
│ ChatGPT Context Monitor            │
├────────────────────────────────────┤
│ Model                              │
│ GPT-5.6 Thinking                   │
│                                    │
│ Context                            │
│ 61.3K / 256K                       │
│ ███████░░░░░░░░░ 24%               │
│                                    │
│ Conversation       58.7K           │
│ Attachments         ~2.6K          │
│ Memory              Unknown        │
│ Apps / MCP          Unknown        │
│ Hidden context      Unknown        │
│                                    │
│ Accuracy: ESTIMATED                │
└────────────────────────────────────┘
```

The exact UI can change, but the information model should remain.

------------------------------------------------------------------------

# 4. Context Sources

The analyzer should classify context into the following categories.

## 4.1 Conversation

Extract:

-   User messages
-   Assistant messages
-   Relevant visible conversation content
-   Older messages loaded into the page

Calculate token count using an appropriate tokenizer.

Status:

**Observable / estimated token count**

------------------------------------------------------------------------

## 4.2 Model

Detect:

-   Current selected model
-   Current mode, if applicable
-   Model changes during the conversation

Never assume one fixed context limit for all ChatGPT models.

Use a versioned model configuration database.

Example:

``` json
{
  "model": "example-model",
  "contextWindow": 256000,
  "maxInput": 128000,
  "maxOutput": 128000
}
```

These values must be maintained from authoritative OpenAI documentation
or verified product behavior rather than guessed.

------------------------------------------------------------------------

## 4.3 Files / Attachments

Detect observable:

-   Uploaded files
-   Images
-   Documents
-   Other attachments

Where possible:

-   Determine file type
-   Determine size
-   Estimate token contribution
-   Mark exact contribution as unknown when the platform processes the
    file internally

Do not assume file byte size equals token count.

------------------------------------------------------------------------

## 4.4 Memory

Detect what is visibly exposed by ChatGPT, such as:

-   Memory enabled/disabled
-   Visible memory-related UI
-   Other memory state exposed to the page

Do **not** assume that all stored memory is inserted into every request.

The system should distinguish:

``` text
Memory enabled       = observable
Memory available     = observable where exposed
Memory retrieved     = potentially unknown
Memory token cost    = unknown unless observable
```

------------------------------------------------------------------------

## 4.5 Apps / MCP

Track, where observable:

``` text
Available
Invoked
Result received
Estimated contribution
```

Important distinction:

``` text
MCP tool available
        ≠
MCP tool invoked
        ≠
MCP result returned
        ≠
MCP result included in model context
```

Do not claim that all connected MCP/app data is part of the current
context.

------------------------------------------------------------------------

## 4.6 Web/Search Results

If ChatGPT performs web/search operations and relevant information is
observable:

-   Detect search/tool activity
-   Detect returned content where possible
-   Estimate token contribution where possible

Otherwise mark it as:

``` text
Observed activity: YES
Exact context contribution: UNKNOWN
```

------------------------------------------------------------------------

## 4.7 System / Developer / Hidden Runtime Context

These may include:

-   System instructions
-   Developer instructions
-   Internal tool definitions
-   Runtime metadata
-   Server-side memory retrieval
-   Other hidden context

These should normally be classified as:

``` text
UNKNOWN / NOT OBSERVABLE
```

Never fabricate their token count.

------------------------------------------------------------------------

# 5. Accuracy Model

Every measurement must have a source/accuracy classification.

## Exact

Use only when authoritative token/context information is available.

Example:

``` text
Context: 63,102 / 256,000
Accuracy: EXACT
Source: authoritative usage metadata
```

## Observed

Information directly observed from ChatGPT's UI/network.

Example:

``` text
Model: GPT-X
Accuracy: OBSERVED
```

## Estimated

Calculated using extracted text, tokenizers, known model limits, or
other inference.

Example:

``` text
Conversation: 61.3K tokens
Accuracy: ESTIMATED
```

## Unknown

Information not exposed to the extension.

Example:

``` text
Hidden system context: UNKNOWN
```

------------------------------------------------------------------------

# 6. Token Calculation

Pipeline:

``` text
Extract conversation
        ↓
Normalize message content
        ↓
Select appropriate tokenizer
        ↓
Count tokens
        ↓
Store per-message counts
        ↓
Aggregate conversation tokens
```

Example:

``` text
User messages:       18.4K
Assistant messages:  42.9K
----------------------------
Conversation:        61.3K
```

Then:

``` text
estimated_context_usage =
    estimated_input_tokens / model_context_window
```

Example:

``` text
61,300 / 256,000
≈ 23.9%
```

The UI should say:

``` text
Estimated context usage: 24%
```

unless authoritative usage data exists.

------------------------------------------------------------------------

# 7. Important Token-Counting Limitation

Plain conversation text does not necessarily equal the complete model
input.

Actual context can contain additional:

-   System instructions
-   Developer instructions
-   Tool definitions
-   Memory
-   Retrieved information
-   Files
-   App/MCP results
-   Search results
-   Runtime metadata

Therefore:

``` text
Visible conversation tokens
        ≠
Complete actual model input
```

The extension must not represent the former as the latter.

------------------------------------------------------------------------

# 8. Network Investigation

Network inspection is an advanced/research layer.

Objective:

Determine whether ChatGPT Web requests expose useful information such
as:

-   Model identifier
-   Context metadata
-   Token usage
-   Request structure
-   Tool calls
-   File information
-   Other usage metadata

Possible flow:

``` text
ChatGPT request
      ↓
Network observer
      ↓
Inspect available metadata
      ↓
Validate against DOM/tokenizer
      ↓
If authoritative usage exists:
    use it
otherwise:
    fall back to estimation
```

Do not depend on undocumented internal endpoints as a permanent API.

Internal request formats may change without notice.

------------------------------------------------------------------------

# 9. Source Priority

When multiple sources exist, use this priority:

``` text
1. Authoritative usage/context metadata
2. Directly observed UI/network information
3. Tokenizer calculation from extracted content
4. Model configuration database
5. Estimates
6. Unknown
```

Example:

``` text
Authoritative token usage available?
        │
       YES ──> use authoritative value
        │
       NO
        ↓
Can conversation be extracted?
        │
       YES ──> tokenize and estimate
        │
       NO
        ↓
Mark as UNKNOWN
```

------------------------------------------------------------------------

# 10. Model Configuration Database

Do not hard-code context limits throughout the codebase.

Use a centralized configuration:

``` text
config/
└── model-limits.json
```

Example structure:

``` json
{
  "models": {
    "model-id": {
      "displayName": "Model Name",
      "contextWindow": 256000,
      "maxInput": 128000,
      "maxOutput": 128000,
      "source": "official documentation",
      "lastVerified": "YYYY-MM-DD"
    }
  }
}
```

Requirements:

-   Versioned
-   Easy to update
-   Source documented
-   Last verification date
-   No guessed limits
-   Separate ChatGPT product limits from API model limits

------------------------------------------------------------------------

# 11. Free Chat Limits

Do not hard-code a fixed message count for ChatGPT Free.

Current OpenAI documentation describes ordinary text chat as unlimited
subject to applicable safeguards, while individual models and
capabilities/tools can have separate limits.

Separate these concepts:

``` text
Text chat availability
        ≠
Model usage limits
        ≠
Context-window limit
        ≠
File limits
        ≠
Image-generation limits
        ≠
Voice limits
        ≠
Data-analysis/tool limits
```

The extension should show only limits that are:

-   Officially documented
-   Observable from the UI
-   Or explicitly marked as unknown/dynamic

Do not create fake counters such as:

``` text
47 / 100 messages
```

unless ChatGPT exposes that information.

------------------------------------------------------------------------

# 12. Recommended Extension Architecture

``` text
extension/
│
├── manifest.json
│
├── content/
│   ├── chatgpt-dom.js
│   ├── message-extractor.js
│   ├── model-detector.js
│   └── ui-observer.js
│
├── network/
│   └── request-observer.js
│
├── engine/
│   ├── tokenizer.js
│   ├── context-calculator.js
│   ├── context-classifier.js
│   └── confidence-engine.js
│
├── config/
│   └── model-limits.json
│
├── popup/
│   └── dashboard.html
│
└── background/
    └── service-worker.js
```

Technology can be selected during implementation, but a modern Chromium
extension architecture should be preferred.

------------------------------------------------------------------------

# 13. Context Engine

Create a central data structure similar to:

``` javascript
{
  model: {
    id: "...",
    name: "...",
    contextWindow: 256000,
    source: "observed"
  },

  conversation: {
    tokenCount: 61300,
    source: "estimated"
  },

  attachments: {
    count: 2,
    estimatedTokens: 2600,
    source: "estimated"
  },

  memory: {
    enabled: true,
    retrieved: null,
    tokenCount: null,
    source: "partially-observed"
  },

  apps: {
    available: 2,
    invoked: 1,
    tokenContribution: null,
    source: "observed/unknown"
  },

  hiddenContext: {
    tokenCount: null,
    source: "unknown"
  },

  total: {
    tokenCount: null,
    utilization: null,
    accuracy: "estimated"
  }
}
```

The actual schema can evolve.

------------------------------------------------------------------------

# 14. Confidence Engine

Calculate confidence based on how much of the context is directly
measurable.

Example:

``` text
Known conversation tokens       61.3K
Known attachment tokens          2.1K
Estimated tool contribution     1.4K
Unknown hidden context             ?
```

Display:

``` text
Estimated context: ~64.8K
Confidence: Medium
```

Do not present confidence as scientific certainty. It is an internal
quality indicator.

------------------------------------------------------------------------

# 15. DOM Extraction Strategy

Use robust selectors and avoid relying on fragile CSS classes.

Prefer:

-   Semantic attributes
-   Stable accessibility attributes
-   DOM relationships
-   Role-based identification
-   MutationObserver
-   Multiple selector fallbacks

Handle:

-   New messages
-   Streaming responses
-   Edited messages
-   Regenerated responses
-   Conversation switching
-   Older-message loading
-   Lazy-loaded DOM
-   Virtualized conversation content

The extractor should have automated tests against saved DOM fixtures.

------------------------------------------------------------------------

# 16. Dynamic Conversation Handling

Use:

``` text
MutationObserver
      ↓
Detect DOM changes
      ↓
Identify changed messages
      ↓
Incremental token calculation
      ↓
Update context meter
```

Do not re-tokenize the entire conversation after every DOM mutation if
avoidable.

Use caching:

``` text
messageId → tokenCount
```

Then only recalculate changed messages.

------------------------------------------------------------------------

# 17. Performance Requirements

The extension should:

-   Avoid blocking ChatGPT UI
-   Debounce DOM mutations
-   Tokenize incrementally
-   Cache token counts
-   Avoid excessive network interception
-   Avoid storing unnecessary conversation content
-   Process locally whenever possible

Target:

``` text
Normal conversation:
near-zero visible UI impact
```

------------------------------------------------------------------------

# 18. Privacy Requirements

Because the extension processes private conversations:

### Default

Process locally.

### Avoid

-   Uploading conversation text to your backend
-   Sending tokens/content to third-party servers
-   Persistent storage of full conversation content unless explicitly
    required

Prefer:

``` text
ChatGPT page
     ↓
Local extension
     ↓
Local tokenizer
     ↓
Local context calculation
     ↓
UI
```

If a backend is later required for model-limit configuration, send only
configuration/version information---not conversation content.

------------------------------------------------------------------------

# 19. Development Roadmap

## Phase 1 --- MVP

Implement:

-   ChatGPT page detection
-   Message extraction
-   Model detection
-   Tokenizer
-   Model context configuration
-   Context percentage
-   Basic overlay

Output:

``` text
Estimated Context
62.4K / 256K
24%
```

------------------------------------------------------------------------

## Phase 2 --- Robust Extraction

Add:

-   MutationObserver
-   Streaming detection
-   Conversation switching
-   Older message loading
-   Message caching
-   Incremental token counting
-   Selector fallback system

------------------------------------------------------------------------

## Phase 3 --- Attachments

Add:

-   File detection
-   Image detection
-   File metadata
-   Token estimation
-   Unknown-state handling

------------------------------------------------------------------------

## Phase 4 --- Network Research

Investigate:

-   ChatGPT requests
-   Model metadata
-   Usage metadata
-   Tool calls
-   Context-related metadata

Validate network observations against DOM/tokenizer results.

Do not depend on undocumented endpoints without fallback.

------------------------------------------------------------------------

## Phase 5 --- Context Source Analyzer

Add dashboard sections:

``` text
Conversation
Files
Memory
Apps/MCP
Web/Search
Tools
Hidden/System
```

Each should have:

``` text
Observed
Estimated
Unknown
```

------------------------------------------------------------------------

## Phase 6 --- Accuracy Engine

Implement:

-   Exact/Observed/Estimated/Unknown classification
-   Confidence calculation
-   Source tracking
-   Conflict resolution between DOM and network measurements

------------------------------------------------------------------------

## Phase 7 --- Production Hardening

Add:

-   Automated DOM regression tests
-   Model configuration tests
-   Tokenization tests
-   Performance tests
-   Privacy review
-   Extension permissions minimization
-   Error telemetry only if explicitly designed and privacy-safe
-   Graceful fallback when ChatGPT UI changes

------------------------------------------------------------------------

# 20. Testing Strategy

Create test fixtures for:

-   Short conversation
-   Long conversation
-   Very long conversation
-   Streaming response
-   Conversation with code
-   Conversation with markdown
-   Conversation with tables
-   Conversation with files
-   Conversation with images
-   Conversation using tools/apps
-   Model switching
-   Dynamic/lazy-loaded messages
-   ChatGPT UI changes

For each test compare:

``` text
DOM token estimate
vs
known tokenizer result
vs
network-observed usage (if available)
```

------------------------------------------------------------------------

# 21. Failure Modes

The extension must handle:

### Model not detected

``` text
Model: Unknown
Context limit: Unknown
```

### Conversation partially loaded

``` text
Conversation: Partially observed
Context: Lower-bound estimate
```

### Network format changed

``` text
Network source unavailable
Fallback: DOM + tokenizer
```

### Hidden context unavailable

``` text
Hidden context: Unknown
```

### Tokenizer mismatch

``` text
Estimated token count
Confidence: Reduced
```

Never silently convert unknown values into fake precision.

------------------------------------------------------------------------

# 22. Final Product Philosophy

The extension should answer:

> "How much of this ChatGPT conversation's context can I reliably
> measure?"

rather than falsely claiming:

> "I can see everything ChatGPT sent to the model."

The final dashboard should make the distinction visible:

``` text
┌─────────────────────────────────┐
│ Context Usage                   │
│                                 │
│ ~64.8K / 256K                   │
│ ████████░░░░░░░ 25%             │
│                                 │
│ Conversation       61.3K  ✓     │
│ Attachments         2.1K  ~     │
│ Memory               ?    ?     │
│ Apps / MCP           ?    ?     │
│ Hidden context       ?    ?     │
│                                 │
│ Accuracy: ESTIMATED             │
│ Confidence: MEDIUM              │
└─────────────────────────────────┘
```

------------------------------------------------------------------------

# 23. Success Criteria

The project is successful when the extension can:

1.  Reliably detect the ChatGPT conversation.
2.  Reliably extract available messages.
3.  Detect the active model/mode when exposed.
4.  Maintain an updatable model/context-limit database.
5.  Accurately tokenize extracted content.
6.  Calculate estimated context utilization.
7.  Detect observable attachments.
8.  Detect observable memory/app/MCP/tool state.
9.  Investigate and consume authoritative network usage metadata when
    available.
10. Clearly distinguish exact, observed, estimated, and unknown
    information.
11. Continue functioning when network metadata is unavailable.
12. Handle dynamic ChatGPT DOM changes.
13. Avoid sending private conversation content to a backend by default.
14. Never fabricate hidden context or token counts.

------------------------------------------------------------------------

# 24. First Implementation Task for the AI Agent

Do **not** immediately build every feature.

Start with a technical discovery phase:

``` text
1. Inspect the existing repository.
2. Identify current extension architecture.
3. Determine browser target and manifest version.
4. Identify ChatGPT DOM structures currently available.
5. Identify stable selectors/attributes.
6. Determine how the active model is exposed.
7. Build a message extraction prototype.
8. Build a local token-counting prototype.
9. Build a model/context configuration layer.
10. Create a minimal context overlay.
11. Test against real ChatGPT conversations.
12. Only after this works, investigate network metadata.
```

The AI agent must report findings before making large architectural
changes.

------------------------------------------------------------------------

# 25. Non-Negotiable Rules

-   Do not claim exact context usage without authoritative evidence.
-   Do not assume DOM token count equals complete model input.
-   Do not assume memory is always injected.
-   Do not assume MCP/app availability means its data is in context.
-   Do not hard-code one context window for every model.
-   Do not hard-code undocumented Free-tier message limits.
-   Do not depend entirely on undocumented ChatGPT internal APIs.
-   Do not upload private conversation content to a backend by default.
-   Prefer local processing.
-   Preserve a fallback path when network inspection fails.
-   Mark unknown information explicitly.
-   Keep model-limit sources and verification dates.
-   Build incrementally and validate each layer before moving to the
    next.
