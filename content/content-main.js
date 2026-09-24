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
import { analyzeContext } from '../engine/context-advisor.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Rolling timing samples (last `size` per metric) for the performance section of diagnostics.
 */
export class PerfStats {
  constructor(size = 50) {
    this.size = size;
    this.series = {};
    this.counters = { passes: 0, superseded: 0, syncsSent: 0, syncsCoalesced: 0 };
  }

  record(name, ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return;
    const s = this.series[name] || (this.series[name] = []);
    s.push(ms);
    if (s.length > this.size) s.shift();
  }

  last(name) {
    const s = this.series[name];
    return s && s.length ? s[s.length - 1] : null;
  }

  /** { metric: { last, median, p95, max, n } } in milliseconds */
  summary() {
    const out = {};
    for (const [name, s] of Object.entries(this.series)) {
      if (!s.length) continue;
      const sorted = [...s].sort((a, b) => a - b);
      out[name] = {
        last: round1(s[s.length - 1]),
        median: round1(sorted[Math.floor((sorted.length - 1) / 2)]),
        p95: round1(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]),
        max: round1(sorted[sorted.length - 1]),
        n: s.length
      };
    }
    return out;
  }
}

export class ContentScriptCoordinator {
  constructor(modelLimitsDb) {
    this.tokenizer = new Tokenizer();
    this.messageExtractor = new MessageExtractor();
    this.modelDetector = new ModelDetector(modelLimitsDb);
    this.planDetector = new PlanDetector();
    // The saved conversation only changes when a reply finishes (forced re-read), on an edit (also a
    // reply) or elsewhere (another tab/device). So a copy stays fresh for a minute, and after that it
    // is refreshed in the background (stale-while-revalidate) instead of blocking a pass.
    this.conversationClient = new ConversationClient({ cacheTtlMs: 60000 });
    this.conversationClient.onRevalidated = (id) => {
      if (id === this.activeConversationId) this.handleDOMChange({ isRevalidated: true });
    };
    this.perf = new PerfStats();
    this._sessionStartTokens = new Map(); // conversationId -> used tokens when first measured on this page
    this._syncTimer = null;
    this._lastSyncAt = 0;
    this.attachmentDetector = new AttachmentDetector();
    this.toolDetector = new ToolDetector();
    // UI adapter: the only ChatGPT-specific UI knowledge is the name and where the input is
    this.overlayUI = new ContextWidget({
      provider: 'ChatGPT',
      findInput: () => document.querySelector('#prompt-textarea') || document.querySelector('form textarea'),
      onRefresh: () => this.refresh(),
      getDiagnostics: () => this.getDiagnostics()
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
   * Starts the network reads at document_start, while the page itself is still loading, instead
   * of after it (document_idle + session + conversation round trips was most of the initial delay).
   * Needs no DOM; the first analysis pass in init() reuses the in-flight or cached results.
   */
  prefetch() {
    this.requestObserver.start();
    const conversationId = this.conversationClient.extractConversationId();
    if (conversationId) {
      this.conversationClient.fetchConversation(conversationId); // Reads the session first
    } else {
      this.conversationClient.getSession();
    }
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
      onChange: (event) => this.handleDOMChange(event),
      // Changed elements drop their cached text; unchanged messages are reused without re-reading
      onMutations: (records) => { for (const r of records) this.messageExtractor.invalidate(r.target); }
    });
    this.messageExtractor.trustCache = true;
    this.domObserver.start();

    // Start Network Intelligence observer (Group C); no-op if prefetch() already started it
    this.requestObserver.start();

    // Build the BPE rank table (one-off, ~0.1 s) while the first pass waits on the network
    this.tokenizer.warm();

    // Toolbar icon click (background service worker) shows / hides the widget
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
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
    if (!this._streamPendingSince) this._streamPendingSince = Date.now();
    if (this._streamRafId) return;
    // Adaptive: every 50 ms, but never more often than twice the last pass took, so a long reply in a
    // long conversation cannot saturate the page's main thread. setTimeout, not requestAnimationFrame:
    // rAF is paused in background tabs, which froze live counts.
    const wait = Math.max(50, Math.min(500, 2 * (this.perf.last('computeMs') || 0)));
    this._streamRafId = setTimeout(() => {
      this._streamRafId = null;
      const triggeredAt = this._streamPendingSince;
      this._streamPendingSince = 0;
      this.handleDOMChange({ isStreamProgress: true, triggeredAt });
    }, wait);
  }

  /**
   * Handler for completed stream generation. The final text is already known from the stream, so
   * the numbers update at once; the saved tree is re-read in the background and applied when it lands
   * (previously the update waited for that full download).
   * @param {Object} meta
   */
  async handleStreamComplete(meta = {}) {
    const convId = meta.conversationId || this.activeConversationId;
    const saved = convId ? this.conversationClient.fetchConversation(convId, { force: true }) : null;
    await this.handleDOMChange({ isStreamComplete: true, triggeredAt: Date.now() });
    if (saved) {
      await saved;
      await this.handleDOMChange({ isStreamComplete: true });
    }
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
   * Refresh button: re-reads the current conversation now, bypassing the short cache and the
   * failure back-off, then recomputes from the fresh copy plus the current page.
   */
  async refresh() {
    const conversationId = this.resolveConversationId();
    if (!this.conversationClient.session?.ok) {
      await this.conversationClient.getSession({ force: true }); // Retry a failed session read too
    }
    if (conversationId) {
      await this.conversationClient.fetchConversation(conversationId, { force: true });
    }
    await this.handleDOMChange({ isRefresh: true });
  }

  /**
   * Short hash identifying a conversation in diagnostics without exposing its id.
   * @param {string|null} conversationId
   * @returns {string|null}
   */
  _conversationRef(conversationId) {
    return conversationId ? this.tokenizer.hashString(conversationId).toString(16) : null;
  }

  /**
   * "Copy diagnostics": the snapshot of the conversation on screen in this tab, checked at copy time.
   * State left over from the previous conversation (the new one is still loading) is withheld.
   * @returns {Object}
   */
  getDiagnostics() {
    const currentRef = this._conversationRef(
      this.conversationClient.extractConversationId() || this.requestObserver.getActiveConversationId()
    );
    const copiedAt = new Date().toISOString();
    const d = this.latestState?.diagnostics;
    if (!d) return { note: 'Nothing read yet in this tab', currentConversationRef: currentRef, copiedAt };
    if (d.conversation?.ref !== currentRef) {
      return {
        note: 'The conversation on screen is still loading; data from the previous conversation is withheld',
        currentConversationRef: currentRef,
        loading: true,
        version: d.version,
        copiedAt
      };
    }
    // Page structure counts are read now (once, at copy time) instead of on every analysis pass
    const count = (sel) => (typeof document !== 'undefined' ? document.querySelectorAll(sel).length : null);
    return {
      ...d,
      dom: {
        ...d.dom,
        roleNodes: count('[data-message-author-role]'),
        turnContainers: count("[data-testid^='conversation-turn-']"),
        articles: count('article'),
        sections: count('section'),
        modelSlugNodes: count('[data-message-model-slug]')
      },
      performance: this.performanceSnapshot(),
      copiedAt,
      stateAgeMs: Date.now() - this.latestState.timestamp
    };
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
    const tPass = now();
    this.perf.counters.passes++;
    try {
      // 1. Identify active conversation ID from URL or Network, and handle navigation
      const conversationId = this.resolveConversationId();
      const isNewConversation = conversationId !== this.activeConversationId;

      // Opening another saved conversation: the previous numbers no longer apply, so show the loading
      // state until this one is read. (A new chat receiving its id from its own stream is the same
      // conversation and keeps its live counts.)
      if (isNewConversation && conversationId && conversationId !== this.requestObserver.getActiveConversationId()) {
        this.overlayUI.update(toWidgetState(null, { provider: 'ChatGPT' }));
      }

      // (The token cache is kept across conversations: entries are keyed by message id + text hash,
      // so reuse is always exact and switching back to a long conversation needs no re-count.)
      if (isNewConversation) {
        this.activeConversationId = conversationId;
        this.requestObserver.setActiveConversationId(conversationId);
      }

      // 2. Read the page once per pass (each detector used to run up to three times per pass)
      const tDom = now();
      const rawDomMessages = this.messageExtractor.extractMessages(document);
      this.perf.record('domMessagesMs', now() - tDom);
      const domAttachments = this.attachmentDetector.detect(document);
      // Pass the raw slug (not the resolved family key) so the UI shows the real model name
      const domModelRaw = this.modelDetector.detectRawModelString(document);
      const domModel = this.modelDetector.resolveModel(domModelRaw);
      const domTools = this.toolDetector.detect(document);
      // The plan is account-level and the detector reads the whole sidebar (layout + every link), so it
      // is re-read at most every 5 s, and always on Refresh / navigation (the session API is primary)
      if (!this._domPlan || event.isRefresh || event.isNavigation || Date.now() - this._domPlan.at > 5000) {
        this._domPlan = { at: Date.now(), value: this.planDetector.detect(document) };
      }
      const domPlan = this._domPlan.value;
      this.perf.record('domScanMs', now() - tDom);

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
      let effectiveAttachments = domAttachments;
      let dataSource = 'dom';
      let apiError = null;
      let authMessagesCount = null;
      let normalized = null;
      let authStatus = null;
      let authFromCapture = false;

      // Session gives the bearer token for the API and the account plan (cached, cheap to call).
      // A pass only waits on the network when no copy of the conversation exists yet.
      const tWait = now();
      const session = await this.conversationClient.getSession();
      let authResult = null;
      if (conversationId) {
        authResult = await this.conversationClient.fetchConversation(conversationId, { staleWhileRevalidate: true });
      }
      this.perf.record('networkWaitMs', now() - tWait);
      const tCompute = now();

      if (conversationId) {
        authStatus = authResult.status ?? null;
        authFromCapture = Boolean(authResult.fromCapture);
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
        model = domModel;
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

      // A saved conversation always has turns. None from any source (API pending or failed, page not
      // rendered yet) means it is still loading, not empty: "0 tokens" would be wrong. A 404 is final.
      const awaitingData = Boolean(conversationId) && effectiveMessages.length === 0 && authStatus !== 404;

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
      const tTok = now();
      let tokenizedMessages = tokenize(encoding);
      let tokenizeMs = now() - tTok;

      // 7. Detect tools from both DOM and Network
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
        const tRetok = now();
        tokenizedMessages = tokenize(model.encoding); // Count with the winning model's tokenizer
        tokenizeMs += now() - tRetok;
      }
      this.perf.record('tokenizeMs', tokenizeMs);

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
      contextState.observables.awaitingData = awaitingData;
      // Measured tokens are a lower bound when turns may be missing (API unavailable for an existing
      // conversation). Hidden system/memory context is never measured, so it is always excluded.
      contextState.completeness.isLowerBound = !conversationComplete;
      contextState.completeness.hiddenContextMeasured = false;

      // Context intelligence: health, consumers, growth and advice from the measured values only
      if (!awaitingData && conversationId && !this._sessionStartTokens.has(conversationId)) {
        this._sessionStartTokens.set(conversationId, contextState.tokens.totalMeasurable);
      }
      contextState.intelligence = analyzeContext({
        percentage: contextState.utilization.percentage,
        usedTokens: contextState.tokens.totalMeasurable,
        contextLimit: contextState.model.contextWindow,
        remainingTokens: contextState.tokens.remaining,
        messages: tokenizedMessages,
        attachments: effectiveAttachments,
        isLowerBound: !conversationComplete,
        sessionStartTokens: conversationId ? (this._sessionStartTokens.get(conversationId) ?? null) : null
      });

      // Limit and token provenance depend on the winning model + plan, so they are recorded only now.
      // The limit comes from the curated limits table (OBSERVED + VERIFIED/UNVERIFIED status), never EXACT.
      const ev = reconciled.evidence;
      const windowKnown = Boolean(contextState.model.contextWindow);
      ev.limit = {
        value: contextState.model.contextWindow,
        status: windowKnown ? contextState.model.limitStatus : 'UNKNOWN',
        source: windowKnown ? 'model_db' : 'unknown',
        reference: windowKnown ? (model.limitSource || null) : null,
        evidenceType: windowKnown ? EvidenceType.OBSERVED : EvidenceType.UNKNOWN
      };
      // Counted locally from visible text: an estimate of what the model receives, not reported usage
      const counted = (value) => ({ value, source: 'tokenizer', evidenceType: EvidenceType.ESTIMATED, textFrom: dataSource });
      ev.tokens = {
        user: counted(contextState.tokens.user),
        assistant: counted(contextState.tokens.assistant),
        total: counted(contextState.tokens.totalMeasurable),
        contextWindow: { value: ev.limit.value, source: ev.limit.source, evidenceType: ev.limit.evidenceType }
      };

      // Structure-only snapshot for the "Copy diagnostics" button. Never message text, the login token,
      // or the raw conversation id (a hash identifies it); ids inside paths are redacted.
      const redact = (s) => String(s).replace(/[0-9a-f-]{20,}/gi, ':id');
      const brief = (e) => (e ? { value: e.value ?? null, source: e.source, type: e.evidenceType, confirmedBy: e.confirmedBy || [] } : null);
      const urlConversationId = this.conversationClient.extractConversationId();
      contextState.diagnostics = {
        version: typeof chrome !== 'undefined' && chrome.runtime?.getManifest ? chrome.runtime.getManifest().version : null,
        generatedAt: new Date().toISOString(),
        page: {
          path: redact(location.pathname),
          visible: typeof document !== 'undefined' && document.visibilityState ? document.visibilityState === 'visible' : null
        },
        conversation: {
          ref: this._conversationRef(conversationId),
          idFrom: conversationId ? (urlConversationId ? 'url' : 'network') : 'none (new chat)',
          loading: awaitingData,
          requestInFlight: Boolean(conversationId && this.conversationClient.activeFetches.has(conversationId)),
          dataSource,
          apiStatus: authStatus,
          apiError: apiError || null,
          usedPageCopy: authFromCapture,
          turns: {
            api: apiVisibleTurns,
            apiIncludingTools: authMessagesCount,
            page: rawDomMessages.length,
            live: liveCandidates.length,
            counted: effectiveMessages.length
          },
          completeness: { source: completenessSource, complete: conversationComplete, lowerBound: !conversationComplete, virtualizationGap },
          hiddenMessagesExcluded: normalized?.hiddenMessages || 0
        },
        session: session ? { ok: session.ok, status: session.status, planType: session.planType || null, error: session.error || null } : null,
        // Page structure counts are taken at copy time (getDiagnostics), not on every pass
        dom: {
          turns: rawDomMessages.length,
          rawModel: domModelRaw
        },
        intelligence: {
          health: contextState.intelligence.health.level,
          warnings: contextState.intelligence.warnings.map(w => w.level),
          consumers: contextState.intelligence.consumers.map(c => `${c.key}:${c.share}%`),
          growth: contextState.intelligence.growth,
          sessionGrowth: contextState.intelligence.sessionGrowth,
          advice: contextState.intelligence.advice.title
        },
        network: {
          available: networkHealth.networkAvailable,
          activeStreams: networkHealth.activeStreamsCount,
          interceptionErrors: networkHealth.interceptionErrors,
          observedModel: this.requestObserver.getObservedModel()?.value || null,
          observedPlan: netPlan?.value || null,
          // Endpoint + status only: raw error text can quote response bodies
          recentErrors: (this.requestObserver.errorLog || []).slice(-5).map(e => ({
            type: e.type, endpoint: redact(e.endpoint), status: /^Status \d+$/.test(e.details) ? e.details : null
          })),
          unsupportedEndpoints: Array.from(this.requestObserver.unsupportedEndpoints || []).slice(0, 15).map(redact)
        },
        candidates: {
          model: modelCandidates.map(c => `${c.source}:${c.value}`),
          plan: planCandidates.map(c => `${c.source}:${c.value}`),
          turns: turnCandidates.map(c => `${c.source}:${c.value}`),
          attachments: attachmentCandidates.map(c => `${c.source}:${c.value}`)
        },
        evidence: {
          model: brief(ev.model),
          plan: brief(ev.plan),
          turns: brief(ev.turns),
          attachments: brief(ev.attachments),
          limit: { value: ev.limit.value, status: ev.limit.status, source: ev.limit.source, type: ev.limit.evidenceType, reference: ev.limit.reference },
          tokens: { source: 'tokenizer', type: EvidenceType.ESTIMATED, textFrom: dataSource }
        },
        agreements: reconciled.agreements,
        conflicts: reconciled.conflicts.map(c => ({
          field: c.field,
          winning: `${c.winning.source}:${c.winning.value}`,
          discarded: `${c.discarded.source}:${c.discarded.value}`
        })),
        resolved: {
          model: model?.id,
          modelName: contextState.model.displayName,
          recognized: contextState.model.recognized,
          plan: contextState.plan.tier,
          limit: contextState.model.contextWindow,
          limitStatus: ev.limit.status,
          limitReference: ev.limit.reference
        },
        tokens: {
          used: contextState.tokens.totalMeasurable,
          user: contextState.tokens.user,
          assistant: contextState.tokens.assistant,
          attachments: contextState.tokens.attachments,
          remaining: contextState.tokens.remaining,
          percentage: contextState.utilization.percentage,
          lowerBound: !conversationComplete,
          hiddenContextMeasured: false
        },
        confidence: {
          level: contextState.confidence.level,
          percentage: contextState.confidence.percentage,
          highBlockers: contextState.confidence.highBlockers || [],
          factors: contextState.confidence.factors.map(f => `${f.type === 'positive' ? '+' : '-'} ${f.text}`)
        }
      };

      if (apiError) {
        contextState.observables.apiError = apiError;
      }

      contextState.evidence = reconciled.evidence;
      contextState.conflicts = reconciled.conflicts;

      // A newer pass started while this one awaited the API; its result wins
      if (runSeq !== this._runSeq) {
        this.perf.counters.superseded++;
        return;
      }
      this.perf.record('computeMs', now() - tCompute);

      // Time from page navigation to the first real numbers, for measuring load delay on the live site
      if (!awaitingData && this._firstDataAtMs === undefined) this._firstDataAtMs = Math.round(performance.now());
      contextState.diagnostics.firstDataAtMs = this._firstDataAtMs ?? null;

      this.latestState = contextState;

      // 10. Update in-page floating HUD
      const tRender = now();
      this.overlayUI.update(toWidgetState(contextState, { provider: 'ChatGPT' }));
      this.perf.record('renderMs', now() - tRender);
      this.perf.record('passMs', now() - tPass);
      // Update latency: from the change on the page / stream chunk to the widget showing it
      if (event.triggeredAt) this.perf.record('updateLatencyMs', Date.now() - event.triggeredAt);
      contextState.diagnostics.performance = this.performanceSnapshot();

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
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
    this._pendingSync = state;
    // Leading + trailing throttle: the first update goes out at once, bursts (streaming at 20 passes/s)
    // collapse into at most one message per SYNC_MS carrying the latest state. The widget is updated
    // directly on every pass; this only feeds the toolbar badge.
    const SYNC_MS = 250;
    if (this._syncTimer) {
      this.perf.counters.syncsCoalesced++;
      return;
    }
    const send = () => {
      const payload = this._pendingSync;
      this._pendingSync = null;
      if (!payload) return;
      this._lastSyncAt = Date.now();
      this.perf.counters.syncsSent++;
      chrome.runtime.sendMessage({ type: 'CONTEXT_UPDATED', payload }).catch(() => {
        // Suppress errors when service worker is temporarily inactive
      });
    };
    const wait = SYNC_MS - (Date.now() - this._lastSyncAt);
    if (wait <= 0) {
      send();
      // Hold the window open so the next burst coalesces into one trailing send
      this._syncTimer = setTimeout(() => { this._syncTimer = null; send(); }, SYNC_MS);
    } else {
      this._syncTimer = setTimeout(() => { this._syncTimer = null; send(); }, wait);
    }
  }

  /**
   * Latency + work counters for the "performance" section of diagnostics (milliseconds).
   *   passMs          whole analysis pass, including any wait for the network
   *   networkWaitMs   time a pass waited for session / conversation data (0 when served from cache)
   *   domScanMs       reading the page (messages, attachments, model, tools, plan)
   *   tokenizeMs      BPE counting (only new or changed messages are encoded)
   *   computeMs       everything after the data arrived, up to rendering
   *   renderMs        widget update
   *   updateLatencyMs page change / stream chunk -> widget shows it (includes debounce)
   * @returns {Object}
   */
  performanceSnapshot() {
    return {
      timings: this.perf.summary(),
      counters: {
        ...this.perf.counters,
        ignoredMutationBatches: this.domObserver?.ignoredMutations ?? 0,
        apiDownloads: this.conversationClient.stats.downloads,
        apiCacheHits: this.conversationClient.stats.cacheHits,
        apiStaleServed: this.conversationClient.stats.staleServed,
        normalizeReused: this.conversationClient.stats.normalizeReused,
        messagesEncoded: this.tokenizer.stats.encoded,
        charsEncoded: this.tokenizer.stats.encodedChars,
        tokenCacheHits: this.tokenizer.stats.cacheHits,
        pageTextCleaned: this.messageExtractor.stats?.cleaned ?? 0,
        pageTextReused: this.messageExtractor.stats?.reused ?? 0
      }
    };
  }
}
