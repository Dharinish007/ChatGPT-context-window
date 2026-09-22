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
import { ConversationClient } from './conversation-client.js';
import { ChatGPTDOMObserver } from './chatgpt-dom.js';

export class ContentScriptCoordinator {
  constructor(modelLimitsDb) {
    this.tokenizer = new Tokenizer();
    this.messageExtractor = new MessageExtractor();
    this.modelDetector = new ModelDetector(modelLimitsDb);
    this.conversationClient = new ConversationClient();
    this.attachmentDetector = new AttachmentDetector();
    this.toolDetector = new ToolDetector();
    this.overlayUI = new OverlayUI();
    this.domObserver = null;
    this.latestState = null;
    this.activeConversationId = null;
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
   * Prioritizes authoritative conversation structure from backend API with DOM fallback.
   * @param {Object} event 
   */
  async handleDOMChange(event = {}) {
    try {
      // 1. Identify active conversation ID and handle navigation
      const conversationId = this.conversationClient.extractConversationId();
      const isNewConversation = conversationId !== this.activeConversationId;

      if (event.isNavigation || isNewConversation) {
        this.tokenizer.clearCache();
        if (isNewConversation) {
          this.activeConversationId = conversationId;
        }
      }

      // 2. Extract DOM messages (used as fallback and for real-time streaming updates)
      const rawDomMessages = this.messageExtractor.extractMessages(document);

      // 3. Detect model specifications from DOM as fallback
      let model = this.modelDetector.detect(document);

      // 4. Primary: Retrieve authoritative conversation structure from backend API
      let effectiveMessages = rawDomMessages;
      let effectiveAttachments = this.attachmentDetector.detect(document);
      let dataSource = 'dom';
      let apiError = null;
      let authMessagesCount = null;

      if (conversationId) {
        const authResult = await this.conversationClient.fetchConversation(conversationId);
        if (authResult.success && authResult.data) {
          const normalized = this.conversationClient.normalizeConversation(authResult.data);
          if (normalized.messages && normalized.messages.length > 0) {
            effectiveMessages = [...normalized.messages];
            authMessagesCount = normalized.messages.length;
            dataSource = 'authoritative';

            // Authoritative attachments take precedence over DOM heuristics
            if (normalized.attachments && normalized.attachments.count > 0) {
              effectiveAttachments = normalized.attachments;
            }

            // Prioritize authoritative model slug if detected
            if (normalized.modelSlug) {
              model = this.modelDetector.resolveModel(normalized.modelSlug);
            }

            // Real-time streaming merge:
            // If the user has an active streaming turn in the DOM, append/update it
            // so HUD shows live progress while model is generating.
            const streamingDomTurn = rawDomMessages.find(m => m.isStreaming);
            if (streamingDomTurn) {
              const lastEff = effectiveMessages[effectiveMessages.length - 1];
              if (lastEff && lastEff.role === streamingDomTurn.role && lastEff.id === streamingDomTurn.id) {
                effectiveMessages[effectiveMessages.length - 1] = streamingDomTurn;
              } else {
                effectiveMessages.push(streamingDomTurn);
              }
            }
          }
        } else {
          dataSource = 'dom_fallback';
          apiError = authResult.error || 'Failed to fetch conversation';
        }
      }

      const encoding = model?.encoding || 'o200k_base';

      // 5. Tokenize messages incrementally using model-aware BPE tokenizer with parts[] support
      const tokenizedMessages = effectiveMessages.map(msg => {
        const parts = msg.parts || [{ type: 'text', text: msg.text }];
        const partsResult = this.tokenizer.countMessagePartsTokens(msg.id, parts, encoding);
        return {
          id: msg.id,
          role: msg.role,
          tokens: partsResult.tokens,
          hasNonTextParts: partsResult.hasNonTextParts,
          nonTextParts: partsResult.nonTextParts,
          isStreaming: Boolean(msg.isStreaming)
        };
      });

      // 6. Detect tools, search, memory, and MCP
      const tools = this.toolDetector.detect(document);

      // 7. Calculate context metrics
      const contextState = ContextCalculator.calculate({
        messages: tokenizedMessages,
        model,
        attachments: effectiveAttachments,
        tools,
        memory: {
          observed: tools.list.some(t => t.type === 'memory'),
          enabled: true
        },
        isPartial: false
      });

      // Attach authoritative observables
      contextState.observables.dataSource = dataSource;
      contextState.observables.conversationId = conversationId;
      contextState.observables.domMessagesCount = rawDomMessages.length;
      contextState.observables.authoritativeMessagesCount = authMessagesCount;
      if (apiError) {
        contextState.observables.apiError = apiError;
      }

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
