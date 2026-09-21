/**
 * ChatGPT Context Monitor - Content Script Coordinator
 * 
 * Coordinates DOM extraction, model detection, tokenization,
 * context calculation, UI HUD updates, and background messaging.
 */

import { Tokenizer } from '../engine/tokenizer.js';
import { ContextCalculator } from '../engine/context-calculator.js';
import { MessageExtractor } from './message-extractor.js';
import { ModelDetector } from './model-detector.js';
import { AttachmentDetector } from './attachment-detector.js';
import { ToolDetector } from './tool-detector.js';
import { OverlayUI } from './overlay-ui.js';
import { ChatGPTDOMObserver } from './chatgpt-dom.js';

export class ContentScriptCoordinator {
  constructor(modelLimitsDb) {
    this.tokenizer = new Tokenizer();
    this.messageExtractor = new MessageExtractor();
    this.modelDetector = new ModelDetector(modelLimitsDb);
    this.attachmentDetector = new AttachmentDetector();
    this.toolDetector = new ToolDetector();
    this.overlayUI = new OverlayUI();
    this.domObserver = null;
    this.latestState = null;
  }

  /**
   * Initializes the content monitor.
   */
  init() {
    console.log('[ChatGPT Context Monitor] Initializing content script...');

    // Mount in-page overlay HUD
    this.overlayUI.mount();

    // Start DOM observing
    this.domObserver = new ChatGPTDOMObserver({
      onChange: (event) => this.handleDOMChange(event)
    });
    this.domObserver.start();

    // Listen for requests from extension action popup or background service worker
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request && request.type === 'GET_CONTEXT_DATA') {
          sendResponse({
            success: true,
            data: this.latestState
          });
          return true; // Keep channel open
        }
        if (request && request.type === 'TOGGLE_OVERLAY') {
          this.overlayUI.isVisible = !this.overlayUI.isVisible;
          this.overlayUI.render();
          sendResponse({ success: true, isVisible: this.overlayUI.isVisible });
          return true;
        }
        return false;
      });
    }
  }

  /**
   * Main analysis pass executed on DOM mutations.
   * @param {Object} event 
   */
  handleDOMChange(event = {}) {
    try {
      // 1. If user navigated to new conversation, clear message tokenizer cache
      if (event.isNavigation) {
        this.tokenizer.clearCache();
      }

      // 2. Extract conversation messages
      const rawMessages = this.messageExtractor.extractMessages(document);

      // 3. Tokenize messages incrementally using LRU cache
      const tokenizedMessages = rawMessages.map(msg => {
        const tokens = this.tokenizer.countMessageTokens(msg.id, msg.text);
        return {
          id: msg.id,
          role: msg.role,
          tokens,
          isStreaming: msg.isStreaming
        };
      });

      // 4. Detect model specifications
      const model = this.modelDetector.detect(document);

      // 5. Detect attachments
      const attachments = this.attachmentDetector.detect(document);

      // 6. Detect tools, search, memory, and MCP
      const tools = this.toolDetector.detect(document);

      // 7. Calculate context metrics
      const contextState = ContextCalculator.calculate({
        messages: tokenizedMessages,
        model,
        attachments,
        tools,
        memory: {
          observed: tools.list.some(t => t.type === 'memory'),
          enabled: true
        },
        isPartial: false
      });

      this.latestState = contextState;

      // 8. Update in-page floating HUD
      this.overlayUI.update(contextState);

      // 9. Sync state to chrome.storage.session and background service worker
      this.syncState(contextState);

    } catch (err) {
      console.error('[ChatGPT Context Monitor] Extraction error:', err);
    }
  }

  /**
   * Syncs context state to chrome.storage.session and notifies service worker.
   * @param {Object} state 
   */
  syncState(state) {
    if (typeof chrome === 'undefined' || !chrome.storage) return;

    // Persist to session storage for instant action popup display
    try {
      chrome.storage.session.set({ latestContextState: state }).catch(() => {});
    } catch (_) {}

    // Send message to service worker to update action badge
    if (chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'CONTEXT_UPDATED',
        payload: {
          utilization: state.utilization,
          model: state.model,
          tokens: state.tokens
        }
      }).catch(() => {
        // Suppress errors when service worker is temporarily inactive
      });
    }
  }
}
