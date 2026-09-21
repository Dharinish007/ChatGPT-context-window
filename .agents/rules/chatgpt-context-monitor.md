# ChatGPT Context Monitor — Project Rules & Engineering Constraints

## Authority & Documentation Precedence
1. Official Chrome for Developers Documentation (`https://developer.chrome.com/docs/extensions`)
2. Google Chrome Chrome Extensions Skill (`GoogleChrome/modern-web-guidance`)
3. Browser Extension Skills (`quangpl/browser-extension-skills`)
Rule: `Official Chrome Documentation > Google Chrome Skill > Third-Party Guidance`

## Architecture & Code Boundaries
- Strictly Manifest V3. No MV2 features or deprecated APIs.
- Keep DOM extraction, context analysis, network research, service worker, and UI responsibilities cleanly separated.
- Content scripts must never block the main thread; batch DOM mutations and use debouncing with `requestAnimationFrame`.
- Service workers are ephemeral; never store in-memory state in variables. Use `chrome.storage.local` / `chrome.storage.session`.
- Async `runtime.onMessage` listeners must return `true;` synchronously to keep message channels open.

## Context Accuracy & Truth-in-Measurement
Every measurement must explicitly distinguish:
- `EXACT` — authoritative usage/context metadata directly from OpenAI/ChatGPT
- `OBSERVED` — directly observed from UI/network (model name, attached file names/sizes)
- `ESTIMATED` — calculated from observable information (local tokenizer)
- `UNKNOWN` — not exposed/available (hidden system instructions, server-side memory, MCP tools, web context)

### Strict Prohibitions
- NEVER claim DOM conversation tokens = complete model context.
- NEVER fabricate hidden token counts for system/developer instructions, memory retrieval, MCP/app data, tool definitions, web/search context, or server-side runtime context.
- Mark unknown or unobservable context explicitly as `UNKNOWN`.

## Security & Privacy
- Process all conversation data locally. Zero conversation text or hashes sent to external servers.
- Use minimum required permissions (`storage`, specific `host_permissions` for `https://chatgpt.com/*` and `https://chat.openai.com/*`).

## Implementation Discipline
- Inspect repository before writing major code.
- Validate assumptions against official Chrome documentation.
- Implement incrementally layer by layer and verify each layer before proceeding.
- Maintain fallbacks for ChatGPT UI and DOM changes.
