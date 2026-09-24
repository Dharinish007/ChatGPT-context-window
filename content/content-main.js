/**
 * ChatGPT Context Monitor - Content Script Coordinator
 * 
 * Coordinates DOM extraction, model detection, tokenization,
 * context calculation, UI HUD updates, and background messaging.
 */

import { Tokenizer } from '../engine/tokenizer.js';
import { ContextCalculator } from '../engine/context-calculator.js';
import { EvidenceMerger, EvidenceType } from '../engine/evidence-merger.js';
import { MessageExtractor } from './message-extractor.js';
import { ModelDetector } from './model-detector.js';
import { PlanDetector, normalizePlanTier, PlanTier } from './plan-detector.js';
import { AttachmentDetector } from './attachment-detector.js';
import { ToolDetector } from './tool-detector.js';
import { ContextWidget } from './overlay-ui.js';
import { toWidgetState } from './widget-state.js';
import { mergeLiveTurns } from './turn-merger.js';
import { ConversationClient } from './conversation-client.js';
import { ChatGPTDOMObserver } from './chatgpt-dom.js';
import { RequestObserver } from '../network/request-observer.js';

export class ContentScriptCoordinator {
  constructor(modelLimitsDb) {
    this.tokenizer = new Tokenizer();
    this.messageExtractor = new MessageExtractor();
    this.modelDetector = new ModelDetector(modelLimitsDb);
    this.planDetector = new PlanDetector();
    this.conversationClient = new ConversationClient();
    this.attachmentDetector = new AttachmentDetector();
    this.toolDetector = new ToolDetector();
    // UI adapter: the only ChatGPT-specific UI knowledge is the name and where the input is
    this.overlayUI = new ContextWidget({
      provider: 'ChatGPT',
      findInput: () => document.querySelector('#prompt-textarea') || document.querySelector('form textarea')
    });
    this.domObserver = null;
    this.latestState = null;
    this.activeConversationId = null;
    this._streamRafId = null;
    this._runSeq = 0; // Guards against older async passes overwriting newer state
    this._lastUrlConversationId = null;

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
    // setTimeout, not requestAnimationFrame: rAF is paused in background tabs, which froze live counts
    this._streamRafId = setTimeout(() => {
      this._streamRafId = null;
      this.handleDOMChange({ isStreamProgress: true });
    }, 50);
  }

  /**
   * Handler for completed stream generation.
   * Triggers authoritative fetch to pull finalized conversation tree.
   * @param {Object} meta 
   */
  async handleStreamComplete(meta = {}) {
    const convId = meta.conversationId || this.activeConversationId;
    if (convId) {
      await this.conversationClient.fetchConversation(convId, { force: true });
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
    // The page downloaded the full conversation tree itself; keep it as authoritative fallback data
    if (meta.conversationId && meta.data) {
      this.conversationClient.ingestConversation(meta.conversationId, meta.data);
    }
    // Only re-run when it is the conversation on screen; the page also prefetches others
    // (e.g. on sidebar hover), and those must never become the active conversation.
    if (!meta.conversationId || meta.conversationId === this.conversationClient.extractConversationId()) {
      this.handleDOMChange({ isConversationLoaded: true });
    }
  }

  /**
   * Which conversation is on screen. The URL is the source of truth; without an id in the URL
   * (new chat) the network id is used, but only one adopted on this page: leaving /c/<id> for a
   * new chat drops the previous conversation's network state so nothing carries over.
   * @returns {string|null}
   */
  resolveConversationId() {
    const urlConversationId = this.conversationClient.extractConversationId();
    if (!urlConversationId && this._lastUrlConversationId) {
      this.requestObserver.setActiveConversationId(null);
    }
    this._lastUrlConversationId = urlConversationId;
    return urlConversationId || this.requestObserver.getActiveConversationId();
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
    const runSeq = ++this._runSeq;
    try {
      // 1. Identify active conversation ID from URL or Network, and handle navigation
      const conversationId = this.resolveConversationId();
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
      let normalized = null;

      // Session gives the bearer token for the API and the account plan (cached, cheap to call)
      const session = await this.conversationClient.getSession();

      if (conversationId) {
        const authResult = await this.conversationClient.fetchConversation(conversationId);
        if (authResult.fromCapture) {
          apiError = `Direct fetch failed (${authResult.fetchError}); using the page's own conversation response`;
        }
        if (authResult.success && authResult.data) {
          normalized = this.conversationClient.normalizeConversation(authResult.data);
          // A payload for a different conversation (mis-keyed capture) must never be used here
          if (normalized.conversationId && normalized.conversationId !== conversationId) {
            apiError = 'Conversation data belonged to a different conversation; ignored';
            normalized = null;
          }
          if (normalized && normalized.messages && normalized.messages.length > 0) {
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

      // 5. Merge in-flight turns: every network turn of this conversation (arrival order), plus a
      //    DOM turn still streaming when the base is the API tree. Matched by message id, so
      //    DOM + network + API overlap is never double counted and new turns are never dropped.
      const domStreamingTurn = rawDomMessages.find(m => m.isStreaming);
      const liveCandidates = [...this.requestObserver.getLiveTurns()];
      if (domStreamingTurn && dataSource === 'authoritative') {
        liveCandidates.push(domStreamingTurn);
      }
      effectiveMessages = mergeLiveTurns(effectiveMessages, liveCandidates, {
        conversationId,
        baseIsFinal: dataSource === 'authoritative'
      });

      const encoding = model?.encoding || 'o200k_base';

      // 6. Tokenize messages incrementally using model-aware BPE tokenizer with parts[] support
      const tokenize = (enc) => effectiveMessages.map(msg => {
        const parts = msg.parts || [{ type: 'text', text: msg.text }];
        const partsResult = this.tokenizer.countMessagePartsTokens(msg.id, parts, enc);
        return {
          id: msg.id,
          role: msg.role,
          tokens: partsResult.tokens,
          hasNonTextParts: partsResult.hasNonTextParts,
          nonTextParts: partsResult.nonTextParts,
          isStreaming: Boolean(msg.isStreaming)
        };
      });
      let tokenizedMessages = tokenize(encoding);

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

      // Turns the page can render (tool output and hidden context are not rendered as turns)
      const apiVisibleTurns = normalized
        ? normalized.messages.filter(m => m.role === 'user' || m.role === 'assistant').length
        : null;

      // 8. Reconcile Completeness & Virtualization (Group D)
      const renderedTurnCount = rawDomMessages.length;
      let authoritativeTurnCount = null;
      let conversationComplete = true;
      let domIsPartial = false;
      let virtualizationGap = 0;
      let completenessSource = 'dom_complete';

      if (dataSource === 'authoritative' && authMessagesCount !== null) {
        authoritativeTurnCount = apiVisibleTurns;
        completenessSource = 'authoritative_api';
        if (authoritativeTurnCount > renderedTurnCount) {
          domIsPartial = true;
          virtualizationGap = authoritativeTurnCount - renderedTurnCount;
        }
        // When authoritative data is present, the context state has all turns in the active branch
        conversationComplete = true;
      } else if (conversationId) {
        // An existing conversation was loaded, but authoritative API failed / offline
        authoritativeTurnCount = null;
        domIsPartial = true;
        conversationComplete = false;
        virtualizationGap = 0;
        completenessSource = 'dom_partial';
      } else {
        // Brand new chat with no conversation ID in URL
        authoritativeTurnCount = null;
        domIsPartial = false;
        conversationComplete = true;
        virtualizationGap = 0;
        completenessSource = 'dom_complete';
      }

      const completeness = {
        conversationComplete,
        domIsPartial,
        renderedTurnCount,
        authoritativeTurnCount,
        virtualizationGap,
        completenessSource
      };

      // 9. Multi-Source Candidate Assembly & Evidence Reconciliation (Group E)
      const networkHealth = this.requestObserver.getHealth();

      // MODEL precedence (highest first):
      //   live_network     - model of THIS conversation's request/stream on this page (newest reply;
      //                      observer resets on conversation switch, ignores prefetched conversations)
      //   conversation_api - latest assistant model_slug on the active branch of the saved tree
      //   dom              - latest data-message-model-slug, else model-like header text
      // Candidates compare by a normalized key so "gpt-5-6" and "GPT-5.6 Instant" are not a conflict.
      const modelKey = ModelDetector.modelKey;
      const modelCandidates = [];
      if (netModel && netModel.value) {
        modelCandidates.push({ value: netModel.value, compareKey: modelKey(netModel.value), source: 'live_network', evidenceType: EvidenceType.OBSERVED });
      }
      if (normalized?.modelSlug) {
        modelCandidates.push({ value: normalized.modelSlug, compareKey: modelKey(normalized.modelSlug), source: 'conversation_api', evidenceType: EvidenceType.EXACT });
      }
      const domModel = this.modelDetector.detect(document);
      // Pass the raw slug (not the resolved family key) so the UI shows the real model name
      const domModelRaw = this.modelDetector.detectRawModelString(document);
      if (domModelRaw && domModel && domModel.id !== 'unknown') {
        modelCandidates.push({ value: domModelRaw, compareKey: modelKey(domModelRaw), source: 'dom', evidenceType: EvidenceType.OBSERVED });
      }

      // TURNS: the page renders a subset (virtualized history, no tool turns). Fewer DOM turns is
      // expected, not a contradiction; equal counts are agreement; MORE DOM turns than the API has
      // means the API copy is stale, which is recorded as a conflict.
      const turnCandidates = [];
      if (apiVisibleTurns !== null) {
        turnCandidates.push({ value: apiVisibleTurns, source: 'conversation_api', evidenceType: EvidenceType.EXACT });
      }
      if (rawDomMessages.length > 0 && (apiVisibleTurns === null || rawDomMessages.length >= apiVisibleTurns)) {
        turnCandidates.push({ value: rawDomMessages.length, source: 'dom', evidenceType: EvidenceType.OBSERVED });
      }

      // ATTACHMENTS: same subset rule as turns
      const attachmentCandidates = [];
      if (normalized?.attachments) {
        attachmentCandidates.push({ value: normalized.attachments.count, source: 'conversation_api', evidenceType: EvidenceType.EXACT });
      }
      const domAttachments = this.attachmentDetector.detect(document);
      if (domAttachments && (!normalized?.attachments || domAttachments.count >= normalized.attachments.count)) {
        attachmentCandidates.push({ value: domAttachments.count, source: 'dom', evidenceType: EvidenceType.OBSERVED });
      }

      // TOOLS: sources name tools differently ("web.run" vs "web_search") and each sees a subset;
      // they are combined (union), not treated as competing claims
      const toolCandidates = tools.list.length > 0
        ? [{ value: tools.list.map(t => t.type).join(','), source: netTools.length > 0 ? 'network' : 'dom', evidenceType: EvidenceType.OBSERVED }]
        : [];

      // PLAN precedence (account-level, never taken from a conversation):
      //   session_api (/api/auth/session account.planType) > network (accounts/check account.plan_type)
      //   > dom (explicit plan label) > dom_heuristic (upgrade prompt; never creates a conflict)
      const planCandidates = [];
      if (session?.planType) {
        planCandidates.push({ value: normalizePlanTier(session.planType), source: 'session_api', evidenceType: EvidenceType.EXACT });
      }
      const netPlan = this.requestObserver.getObservedPlan();
      if (netPlan && netPlan.value) {
        planCandidates.push({ value: normalizePlanTier(netPlan.value), source: 'network', evidenceType: EvidenceType.OBSERVED });
      }
      const domPlan = this.planDetector.detect(document);
      if (domPlan && domPlan.value && domPlan.value !== PlanTier.UNKNOWN) {
        planCandidates.push({ value: domPlan.value, source: domPlan.source === 'dom_heuristic' ? 'dom_heuristic' : 'dom', evidenceType: domPlan.evidenceType || EvidenceType.OBSERVED });
      }

      const reconciled = EvidenceMerger.reconcileState({
        modelCandidates,
        planCandidates,
        turnCandidates,
        attachmentCandidates,
        toolCandidates,
        completeness,
        networkHealth
      });

      // Update model + plan-aware limits with winning evidence
      const winningPlan = reconciled.evidence?.plan?.value || PlanTier.UNKNOWN;
      const winningModelSlug = reconciled.evidence?.model?.value || null;
      model = this.modelDetector.resolveModel(winningModelSlug, winningPlan);
      if (model.encoding && model.encoding !== encoding) {
        tokenizedMessages = tokenize(model.encoding); // Count with the winning model's tokenizer
      }

      // 10. Calculate context metrics
      const contextState = ContextCalculator.calculate({
        messages: tokenizedMessages,
        model,
        plan: reconciled.evidence?.plan || domPlan,
        attachments: effectiveAttachments,
        tools,
        memory: {
          observed: tools.list.some(t => t.type === 'memory'),
          enabled: true
        },
        completeness,
        isPartial: !conversationComplete,
        evidence: reconciled.evidence,
        conflicts: reconciled.conflicts,
        agreements: reconciled.agreements,
        networkHealth
      });

      // Attach authoritative & network observables
      contextState.observables.dataSource = dataSource;
      contextState.observables.conversationId = conversationId;
      contextState.observables.domMessagesCount = rawDomMessages.length;
      contextState.observables.authoritativeMessagesCount = authMessagesCount;
      contextState.observables.network = networkHealth;
      contextState.observables.plan = winningPlan;
      contextState.observables.hiddenMessagesExcluded = normalized?.hiddenMessages || 0;
      // Measured tokens are a lower bound when turns may be missing (API unavailable for an existing
      // conversation). Hidden system/memory context is never measured, so it is always excluded.
      contextState.completeness.isLowerBound = !conversationComplete;
      contextState.completeness.hiddenContextMeasured = false;

      // Structure-only snapshot for the "Copy diagnostics" button: no message text, no token
      contextState.diagnostics = {
        version: typeof chrome !== 'undefined' && chrome.runtime?.getManifest ? chrome.runtime.getManifest().version : null,
        path: location.pathname.replace(/[0-9a-f-]{20,}/gi, ':id'),
        session: session ? { ok: session.ok, status: session.status, planType: session.planType || null } : null,
        conversationApi: conversationId ? {
          dataSource,
          error: apiError || null,
          authoritativeTurns: authMessagesCount
        } : 'no conversation id in URL',
        dom: {
          turns: rawDomMessages.length,
          roleNodes: document.querySelectorAll('[data-message-author-role]').length,
          turnContainers: document.querySelectorAll("[data-testid^='conversation-turn-']").length,
          articles: document.querySelectorAll('article').length,
          sections: document.querySelectorAll('section').length,
          modelSlugNodes: document.querySelectorAll('[data-message-model-slug]').length,
          rawModel: domModelRaw
        },
        network: {
          available: networkHealth.networkAvailable,
          observedModel: this.requestObserver.getObservedModel()?.value || null,
          observedPlan: netPlan?.value || null,
          unsupportedEndpoints: Array.from(this.requestObserver.unsupportedEndpoints || []).slice(0, 15)
        },
        candidates: {
          model: modelCandidates.map(c => `${c.source}:${c.value}`),
          plan: planCandidates.map(c => `${c.source}:${c.value}`)
        },
        resolved: { model: model?.id, limit: contextState.model?.contextWindow, limitStatus: contextState.model?.limitStatus }
      };

      if (apiError) {
        contextState.observables.apiError = apiError;
      }

      contextState.evidence = reconciled.evidence;
      contextState.conflicts = reconciled.conflicts;

      // A newer pass started while this one awaited the API; its result wins
      if (runSeq !== this._runSeq) return;

      this.latestState = contextState;

      // 10. Update in-page floating HUD
      this.overlayUI.update(toWidgetState(contextState, { provider: 'ChatGPT' }));

      // 11. Sync state to chrome.storage.session and background service worker
      this.syncState(contextState);

    } catch (err) {
      console.error('[ChatGPT Context Monitor] Extraction error:', err);
    }
  }

  /**
   * Sends the full context state to the service worker (badge + per-tab popup cache).
   * @param {Object} state 
   */
  syncState(state) {
    if (typeof chrome === 'undefined') return;

    // Send full state: the service worker caches it per tab and the popup renders from it
    if (chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'CONTEXT_UPDATED',
        payload: state
      }).catch(() => {
        // Suppress errors when service worker is temporarily inactive
      });
    }
  }
}
