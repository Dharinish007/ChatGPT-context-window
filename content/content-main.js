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
import { RequestObserver } from '../network/request-observer.js';

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
    this._streamRafId = null;

    // Network Intelligence Observer (Group C)
    this.requestObserver = new RequestObserver({
      onStreamChunk: (turn) => this.handleStreamingChunk(turn),
      onStreamComplete: (meta) => this.handleStreamComplete(meta),
      onPromptSent: (userTurn) => this.handlePromptSent(userTurn),
      onConversationLoaded: (meta) => this.handleConversationLoaded(meta)
    });
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

    // Start Network Intelligence observer (Group C)
    this.requestObserver.start();

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
   * Throttled handler for live streaming chunk updates from Network.
   * @param {Object} turn 
   */
  handleStreamingChunk(turn) {
    if (this._streamRafId) return;
    this._streamRafId = requestAnimationFrame(() => {
      this._streamRafId = null;
      this.handleDOMChange({ isStreamProgress: true });
    });
  }

  /**
   * Handler for completed stream generation.
   * Triggers authoritative fetch to pull finalized conversation tree.
   * @param {Object} meta 
   */
  async handleStreamComplete(meta = {}) {
    const convId = meta.conversationId || this.activeConversationId;
    if (convId) {
      await this.conversationClient.fetchConversation(convId, { bypassCache: true });
    }
    this.handleDOMChange({ isStreamComplete: true });
  }

  /**
   * Handler for user prompt submission captured via network.
   * @param {Object} userTurn 
   */
  handlePromptSent(userTurn) {
    this.handleDOMChange({ isPromptSent: true });
  }

  /**
   * Handler for conversation loaded event captured via network.
   * @param {Object} meta 
   */
  handleConversationLoaded(meta = {}) {
    if (meta.conversationId && meta.conversationId !== this.activeConversationId) {
      this.activeConversationId = meta.conversationId;
      this.requestObserver.setActiveConversationId(meta.conversationId);
    }
    this.handleDOMChange({ isConversationLoaded: true });
  }

  /**
   * Main analysis pass executed on DOM mutations or network stream events.
   * Integrates Authoritative Conversation API + Network Stream + DOM into a unified pipeline.
   * 
   * Pipeline:
   *   Authoritative Conversation API (GET /backend-api/conversation/{id})
   *          +
   *   Network Stream (POST /backend-api/conversation SSE)
   *          +
   *   DOM (Fallback & Real-time corroboration)
   *          ↓
   *   Existing Context Pipeline
   * 
   * @param {Object} event 
   */
  async handleDOMChange(event = {}) {
    try {
      // 1. Identify active conversation ID from URL or Network, and handle navigation
      const conversationId = this.conversationClient.extractConversationId() || this.requestObserver.getActiveConversationId();
      const isNewConversation = conversationId !== this.activeConversationId;

      if (event.isNavigation || isNewConversation) {
        this.tokenizer.clearCache();
        if (isNewConversation) {
          this.activeConversationId = conversationId;
          this.requestObserver.setActiveConversationId(conversationId);
        }
      }

      // 2. Extract DOM messages (used as base fallback and for real-time corroboration)
      const rawDomMessages = this.messageExtractor.extractMessages(document);

      // 3. Detect model specifications with provenance
      let model = null;
      let modelProvenance = { source: 'dom', evidenceType: 'OBSERVED' };

      // Priority A: Network observed model from live request/SSE stream
      const netModel = this.requestObserver.getObservedModel();
      if (netModel && netModel.value) {
        model = this.modelDetector.resolveModel(netModel.value);
        modelProvenance = { source: 'network', evidenceType: 'OBSERVED' };
      }

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

            // Priority B: Authoritative model slug
            if (normalized.modelSlug) {
              model = this.modelDetector.resolveModel(normalized.modelSlug);
              modelProvenance = { source: 'authoritative', evidenceType: 'OBSERVED' };
            }
          }
        } else {
          dataSource = 'dom_fallback';
          apiError = authResult.error || 'Failed to fetch conversation';
        }
      }

      // Priority C: DOM header switcher fallback if still unresolved
      if (!model) {
        model = this.modelDetector.detect(document);
        modelProvenance = { source: 'dom', evidenceType: 'OBSERVED' };
      }

      // 5. Supplement with in-flight Network evidence
      // 5a. In-flight User Prompt (observed immediately on POST before API or DOM settles)
      const pendingUserTurn = this.requestObserver.getPendingUserTurn();
      if (pendingUserTurn) {
        const alreadyExists = effectiveMessages.some(m => 
          m.id === pendingUserTurn.id || 
          (m.role === 'user' && m.text && m.text === pendingUserTurn.text)
        );
        if (!alreadyExists) {
          effectiveMessages.push(pendingUserTurn);
        }
      }

      // 5b. Live Streaming Assistant Turn (from Network SSE stream or DOM)
      const netStreamingTurn = this.requestObserver.getStreamingTurn();
      const domStreamingTurn = rawDomMessages.find(m => m.isStreaming);

      let activeStreamingTurn = null;
      if (netStreamingTurn && netStreamingTurn.isStreaming) {
        activeStreamingTurn = netStreamingTurn;
        // If DOM has longer text, prefer the longer text without duplicating
        if (domStreamingTurn && domStreamingTurn.text && domStreamingTurn.text.length > activeStreamingTurn.text.length) {
          activeStreamingTurn = {
            ...activeStreamingTurn,
            text: domStreamingTurn.text,
            parts: [{ type: 'text', text: domStreamingTurn.text }],
            source: 'dom'
          };
        }
      } else if (domStreamingTurn) {
        activeStreamingTurn = domStreamingTurn;
      }

      if (activeStreamingTurn) {
        // Prevent duplicate messages: update in-place if ID or streaming slot exists
        const existingIndex = effectiveMessages.findIndex(m => m.id === activeStreamingTurn.id);
        if (existingIndex !== -1) {
          effectiveMessages[existingIndex] = {
            ...effectiveMessages[existingIndex],
            ...activeStreamingTurn,
            isStreaming: true
          };
        } else {
          const lastEff = effectiveMessages[effectiveMessages.length - 1];
          if (lastEff && lastEff.role === activeStreamingTurn.role && (lastEff.id === activeStreamingTurn.id || lastEff.isStreaming)) {
            effectiveMessages[effectiveMessages.length - 1] = {
              ...lastEff,
              ...activeStreamingTurn,
              isStreaming: true
            };
          } else {
            effectiveMessages.push(activeStreamingTurn);
          }
        }
      }

      const encoding = model?.encoding || 'o200k_base';

      // 6. Tokenize messages incrementally using model-aware BPE tokenizer with parts[] support
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

      // 7. Detect tools from both DOM and Network
      const domTools = this.toolDetector.detect(document);
      const netTools = this.requestObserver.getObservedTools();
      const combinedToolList = [...(domTools.list || [])];

      for (const nt of netTools) {
        if (!combinedToolList.some(t => t.type === nt.name || t.label?.toLowerCase() === nt.name.toLowerCase())) {
          combinedToolList.push({
            type: nt.name,
            label: nt.name === 'web_search' ? 'Web Search' : nt.name,
            source: 'network',
            evidenceType: 'OBSERVED'
          });
        }
      }

      const tools = {
        observed: domTools.observed || netTools.length > 0,
        list: combinedToolList
      };

      // 8. Calculate context metrics
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

      // Attach authoritative & network observables
      const networkHealth = this.requestObserver.getHealth();
      contextState.observables.dataSource = dataSource;
      contextState.observables.conversationId = conversationId;
      contextState.observables.domMessagesCount = rawDomMessages.length;
      contextState.observables.authoritativeMessagesCount = authMessagesCount;
      contextState.observables.network = networkHealth;

      if (apiError) {
        contextState.observables.apiError = apiError;
      }

      // 9. Stamped Epistemic Evidence Model (Task 13)
      contextState.evidence = {
        dataSource: {
          value: dataSource,
          source: dataSource === 'authoritative' ? 'authoritative_api' : (dataSource === 'dom_fallback' ? 'dom_fallback' : 'dom'),
          evidenceType: dataSource === 'authoritative' ? 'EXACT' : 'OBSERVED'
        },
        model: {
          value: model.id,
          source: modelProvenance.source,
          evidenceType: 'OBSERVED'
        },
        networkHealth: {
          value: networkHealth.networkAvailable ? 'AVAILABLE' : 'UNAVAILABLE',
          source: 'network',
          evidenceType: 'OBSERVED',
          details: networkHealth
        }
      };

      this.latestState = contextState;

      // 10. Update in-page floating HUD
      this.overlayUI.update(contextState);

      // 11. Sync state to chrome.storage.session and background service worker
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
