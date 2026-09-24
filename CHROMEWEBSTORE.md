# Chrome Web Store Listing & Compliance

## 1. Extension Metadata

- **Name:** ChatGPT Context Monitor
- **Short Name:** Context Monitor
- **Version:** 1.0.0
- **Primary Category:** Productivity
- **Secondary Category:** Developer Tools
- **Default Language:** English
- **Single-Purpose Statement:** Calculates and displays verified context-window usage and token metrics for ChatGPT Web conversations without sending conversation data to any external server.

---

## 2. Store Listing Copy

### Summary (132 characters max)
Calculates and displays accurate context-window utilization on ChatGPT Web with verified truth-in-measurement metrics.

### Detailed Description
Take control of your ChatGPT conversations with ChatGPT Context Monitor. Easily monitor context-window limits, token consumption, and model capacity in real time directly inside ChatGPT Web.

Key Features:
- Real-Time Context Gauge: Displays current token usage against verified model context limits (e.g. 128K for GPT-4o, 200K for o1 / o3-mini).
- Truth-in-Measurement: Distinctly classifies metrics as EXACT, OBSERVED, ESTIMATED, or UNKNOWN. Never fabricates hidden tokens for system instructions, memory vectors, or server-side tools.
- Non-Intrusive Floating HUD: Compact in-page meter embedded cleanly in ChatGPT that updates smoothly during streaming without slowing down the page.
- Itemized Breakdown: Separate accounting for user prompts, assistant answers, document uploads, and web search activity.
- 100% Local & Private: All message extraction, tokenization, and calculations occur entirely within your browser. Zero conversation text or tokens are uploaded to any external server.

---

## 3. Permissions Justifications

Every declared permission serves a single necessary purpose:

### `storage`
- **Justification:** Required to save local user preferences (such as toggling the in-page floating HUD on/off) and cache model configuration limits locally so that no remote network requests are needed.

### Host Permissions: `https://chatgpt.com/*` & `https://chat.openai.com/*`
- **Justification:** Required exclusively to inject the content script onto ChatGPT Web pages to detect the active model name, extract conversation message lengths, and render the context HUD meter. Access is strictly confined to ChatGPT domains and does not apply to any other website.

---

## 4. Privacy & Data Handling Disclosures

- **Does the extension collect personally identifiable information (PII)?** No.
- **Does the extension read authentication cookies or tokens?** No.
- **Does the extension transmit user messages or files to any external server?** No. All processing is 100% local inside the browser.
- **Does the extension use analytics or tracking beacons?** No.
- **Is user data sold or transferred to third parties?** No.

---

## 5. Visual Asset Checklist

- [x] Extension Icon (16x16 px) — `assets/icons/icon-16.png`
- [x] Extension Icon (48x48 px) — `assets/icons/icon-48.png`
- [x] Extension Icon (128x128 px) — `assets/icons/icon-128.png`
- [ ] Promotional Tile (440x280 px)
- [ ] Screenshot 1 (1280x800 px) — In-page floating context HUD docked on ChatGPT Web
- [ ] Screenshot 2 (1280x800 px) — In-page widget expanded with full context breakdown
