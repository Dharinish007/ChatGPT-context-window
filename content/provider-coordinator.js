/**
 * Context Monitor - Coordinator for provider adapters (Claude, Gemini)
 *
 * Same pipeline and widget as ChatGPT, fed by a provider adapter (content/providers.js):
 *   saved conversation (adapter API, when it has one) or the page  ->  live page turns merged in
 *   ->  model / plan evidence reconciled  ->  published context window  ->  tokens (ESTIMATED)
 *   ->  confidence + context intelligence  ->  widget + toolbar badge
 * ChatGPT keeps its own coordinator (content-main.js); nothing here runs on ChatGPT.
 */

import { Tokenizer } from '../engine/tokenizer.js';
import { ContextCalculator } from '../engine/context-calculator.js';
import { EvidenceMerger, EvidenceType } from '../engine/evidence-merger.js';
import { analyzeContext } from '../engine/context-advisor.js';
import { ContextWidget } from './overlay-ui.js';
import { toWidgetState } from './widget-state.js';
import { mergeLiveTurns } from './turn-merger.js';
import { ChatGPTDOMObserver } from './chatgpt-dom.js';

const API_TTL_MS = 60000; // Saved copy stays fresh for a minute; a reply finishing re-reads it at once
const API_BACKOFF_MS = 15000; // After a failed read, wait before trying again (Refresh skips this)

export class ProviderCoordinator {
  /** @param {Object} provider Adapter from content/providers.js */
  constructor(provider) {
    this.provider = provider;
    this.tokenizer = new Tokenizer();
    this.overlayUI = new ContextWidget({
      provider: provider.name,
      findInput: () => provider.findInput(document),
      onRefresh: () => this.refresh(),
      getDiagnostics: () => this.getDiagnostics()
    });
    this.domObserver = null;
    this.latestState = null;
    this.activeConversationId = null;
    this._runSeq = 0;
    this._api = null; // { conversationId, result, at } last successful saved-conversation read
    this._apiFailure = null; // { conversationId, error, at }
    this._apiInFlight = null;
    this._wasStreaming = false;
    this._sessionStartTokens = new Map();
  }

  init() {
    this.overlayUI.mount();
    this.domObserver = new ChatGPTDOMObserver({
      onChange: (event) => this.handleDOMChange(event),
      composerSelector: this.provider.inputSelector
    });
    this.domObserver.start();
    this.tokenizer.getEncoder(); // Build the BPE tables while the first read is in flight
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request?.type !== 'TOGGLE_OVERLAY') return false;
        this.overlayUI.isVisible = !this.overlayUI.isVisible;
        this.overlayUI.render();
        sendResponse({ success: true, isVisible: this.overlayUI.isVisible });
        return true;
      });
    }
  }

  /** Same-origin JSON GET with the page's cookies; throws on HTTP errors. */
  async _fetchJson(path) {
    const res = await fetch(path, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP error ${res.status}`);
    return res.json();
  }

  /**
   * Saved conversation through the adapter's API: cached per conversation, one read at a time,
   * backed off after a failure. Returns { result, error, fromCache }.
   */
  async _readApi(conversationId, force = false) {
    if (!this.provider.hasApi || !conversationId) return { result: null, error: null };
    const fresh = this._api && this._api.conversationId === conversationId && Date.now() - this._api.at < API_TTL_MS;
    if (!force && fresh) return { result: this._api.result, error: null, fromCache: true };
    const failed = this._apiFailure && this._apiFailure.conversationId === conversationId && Date.now() - this._apiFailure.at < API_BACKOFF_MS;
    if (!force && failed) return { result: this._keptCopy(conversationId), error: this._apiFailure.error };
    if (!force && this._apiInFlight?.conversationId === conversationId) return this._apiInFlight.promise;

    const promise = (async () => {
      try {
        const result = await this.provider.fetchConversation(conversationId, (p) => this._fetchJson(p));
        if (!result) throw new Error('Conversation API unavailable');
        this._api = { conversationId, result, at: Date.now() };
        this._apiFailure = null;
        return { result, error: null };
      } catch (err) {
        this._apiFailure = { conversationId, error: err.message || 'Conversation API failed', at: Date.now() };
        return { result: this._keptCopy(conversationId), error: this._apiFailure.error };
      } finally {
        if (this._apiInFlight?.promise === promise) this._apiInFlight = null;
      }
    })();
    this._apiInFlight = { conversationId, promise };
    return promise;
  }

  /** Last good copy of this conversation (used when a later read fails). */
  _keptCopy(conversationId) {
    return this._api && this._api.conversationId === conversationId ? this._api.result : null;
  }

  async refresh() {
    await this.handleDOMChange({ isRefresh: true, forceApi: true });
  }

  _conversationRef(id) {
    return id ? this.tokenizer.hashString(id).toString(16) : null;
  }

  getDiagnostics() {
    const currentRef = this._conversationRef(this.provider.conversationId(location.href));
    const copiedAt = new Date().toISOString();
    const d = this.latestState?.diagnostics;
    if (!d) return { note: 'Nothing read yet in this tab', provider: this.provider.name, currentConversationRef: currentRef, copiedAt };
    if (d.conversation.ref !== currentRef) {
      return { note: 'The conversation on screen is still loading; data from the previous conversation is withheld', provider: this.provider.name, currentConversationRef: currentRef, loading: true, copiedAt };
    }
    return { ...d, copiedAt, stateAgeMs: Date.now() - this.latestState.timestamp };
  }

  async handleDOMChange(event = {}) {
    const runSeq = ++this._runSeq;
    const p = this.provider;
    try {
      const conversationId = p.conversationId(location.href);
      if (conversationId !== this.activeConversationId) {
        // Another saved conversation: show loading, never the previous one's numbers
        if (conversationId) this.overlayUI.update(toWidgetState(null, { provider: p.name }));
        this.activeConversationId = conversationId;
        this._wasStreaming = false;
      }

      // Page (one read per pass)
      const dom = p.extractMessages(document);
      const domModelRaw = p.detectModel(document);
      const domPlan = p.detectPlan(document);
      const streaming = dom.some(m => m.isStreaming);
      // A reply just finished: the saved copy is now behind, read it again
      const forceApi = Boolean(event.forceApi) || (this._wasStreaming && !streaming);
      this._wasStreaming = streaming;

      // Saved conversation (Claude API) when available
      const api = await this._readApi(conversationId, forceApi);
      if (runSeq !== this._runSeq) return;
      const saved = api.result && (!api.result.conversationId || api.result.conversationId === conversationId) ? api.result : null;

      let messages;
      let dataSource;
      let completenessSource;
      if (saved && saved.messages.length > 0) {
        dataSource = 'authoritative';
        completenessSource = 'authoritative_api';
        // Turns on the page beyond the saved ones are live (just sent / still streaming)
        const savedVisible = saved.messages.filter(m => m.role !== 'tool').length;
        messages = mergeLiveTurns(saved.messages, dom.length > savedVisible ? dom.slice(savedVisible) : [], { conversationId, baseIsFinal: true });
      } else {
        dataSource = conversationId && p.hasApi ? 'dom_fallback' : 'dom';
        messages = dom;
        // A saved chat read only from the page may miss turns (API failed, or lazy-loaded history)
        completenessSource = conversationId && (p.hasApi || p.pageMayBePartial) ? 'dom_partial' : 'dom_complete';
      }
      const complete = completenessSource !== 'dom_partial';
      const awaitingData = Boolean(conversationId) && messages.length === 0;

      // Model and plan evidence
      const modelCandidates = [];
      if (saved?.model) modelCandidates.push({ value: saved.model, compareKey: p.modelKey(saved.model), source: 'conversation_api', evidenceType: EvidenceType.EXACT });
      if (domModelRaw) modelCandidates.push({ value: domModelRaw, compareKey: p.modelKey(domModelRaw), source: 'dom', evidenceType: EvidenceType.OBSERVED });
      const planCandidates = [];
      if (saved?.plan) planCandidates.push({ value: saved.plan.value, source: 'account_api', evidenceType: saved.plan.evidenceType });
      if (domPlan) planCandidates.push(domPlan);
      const turnCandidates = [];
      if (saved) turnCandidates.push({ value: saved.visibleTurns, source: 'conversation_api', evidenceType: EvidenceType.EXACT });
      if (dom.length && (!saved || dom.length >= saved.visibleTurns)) turnCandidates.push({ value: dom.length, source: 'dom', evidenceType: EvidenceType.OBSERVED });

      const completeness = {
        conversationComplete: complete,
        domIsPartial: !complete,
        renderedTurnCount: dom.length,
        authoritativeTurnCount: saved ? saved.visibleTurns : null,
        virtualizationGap: 0,
        completenessSource
      };
      const reconciled = EvidenceMerger.reconcileState({ modelCandidates, planCandidates, turnCandidates, completeness, networkHealth: { networkAvailable: false } });
      const ev = reconciled.evidence;
      const modelRaw = ev.model?.value || null;
      const plan = ev.plan?.value || 'unknown';
      const limit = p.resolveLimit(modelRaw, plan);

      // Tokens: o200k BPE as an estimate (the provider's tokenizer is not public)
      const tokenized = messages.map(m => {
        const r = this.tokenizer.countMessagePartsTokens(m.id, m.parts || [{ type: 'text', text: m.text }], 'o200k_base');
        return { id: m.id, role: m.role, tokens: r.tokens, hasNonTextParts: r.hasNonTextParts, nonTextParts: r.nonTextParts, isStreaming: Boolean(m.isStreaming) };
      });
      const attachments = saved?.attachments || { count: 0, estimatedTokens: 0, hasUnknown: false };

      const state = ContextCalculator.calculate({
        messages: tokenized,
        model: {
          // The window may be known from the plan alone (Gemini), so the id is the provider's app
          id: limit.recognized || limit.contextWindow ? (p.modelKey(modelRaw) || `${p.name.toLowerCase()}-app`) : 'unknown',
          displayName: p.displayName(modelRaw) || `${p.name} (model not detected)`,
          contextWindow: limit.contextWindow,
          limitStatus: limit.status,
          limitSource: limit.source,
          recognized: limit.recognized,
          encoding: 'o200k_base'
        },
        plan: ev.plan,
        attachments,
        tools: { observed: tokenized.some(m => m.role === 'tool'), list: [] },
        completeness,
        isPartial: !complete,
        evidence: ev,
        conflicts: reconciled.conflicts,
        agreements: reconciled.agreements,
        networkHealth: { networkAvailable: false },
        tokenizerExact: false
      });

      state.observables.dataSource = dataSource;
      state.observables.conversationId = conversationId;
      state.observables.awaitingData = awaitingData;
      if (api.error) state.observables.apiError = saved ? `Conversation API failed (${api.error}); using the last good copy` : `Conversation API failed (${api.error}); reading the page`;
      state.completeness.isLowerBound = !complete;
      state.completeness.hiddenContextMeasured = false;
      const windowKnown = Boolean(state.model.contextWindow);
      ev.limit = {
        value: state.model.contextWindow,
        status: windowKnown ? state.model.limitStatus : 'UNKNOWN',
        source: windowKnown ? 'model_db' : 'unknown',
        reference: windowKnown ? limit.source : null,
        evidenceType: windowKnown ? EvidenceType.OBSERVED : EvidenceType.UNKNOWN
      };
      ev.tokens = { total: { value: state.tokens.totalMeasurable, source: 'tokenizer', evidenceType: EvidenceType.ESTIMATED, approximate: true } };

      if (!awaitingData && conversationId && !this._sessionStartTokens.has(conversationId)) this._sessionStartTokens.set(conversationId, state.tokens.totalMeasurable);
      state.intelligence = analyzeContext({
        percentage: state.utilization.percentage,
        usedTokens: state.tokens.totalMeasurable,
        contextLimit: state.model.contextWindow,
        remainingTokens: state.tokens.remaining,
        messages: tokenized,
        attachments,
        isLowerBound: !complete,
        sessionStartTokens: conversationId ? (this._sessionStartTokens.get(conversationId) ?? null) : null
      });

      // Structure only: no message text, no raw conversation id
      state.diagnostics = {
        provider: p.name,
        generatedAt: new Date().toISOString(),
        conversation: {
          ref: this._conversationRef(conversationId), loading: awaitingData, dataSource, apiError: api.error || null,
          turns: { api: saved ? saved.visibleTurns : null, page: dom.length, counted: messages.length }, completeness: { source: completenessSource, lowerBound: !complete }
        },
        candidates: { model: modelCandidates.map(c => `${c.source}:${c.value}`), plan: planCandidates.map(c => `${c.source}:${c.value}`) },
        conflicts: reconciled.conflicts.map(c => ({ field: c.field, winning: `${c.winning.source}:${c.winning.value}`, discarded: `${c.discarded.source}:${c.discarded.value}` })),
        agreements: reconciled.agreements,
        resolved: { model: modelRaw, plan, limit: state.model.contextWindow, limitStatus: ev.limit.status, limitReference: ev.limit.reference },
        tokens: { used: state.tokens.totalMeasurable, remaining: state.tokens.remaining, percentage: state.utilization.percentage, tokenizer: 'o200k_base (approximate for this provider)' },
        confidence: { level: state.confidence.level, percentage: state.confidence.percentage, highBlockers: state.confidence.highBlockers || [] },
        intelligence: { health: state.intelligence.health.level, advice: state.intelligence.advice.title }
      };
      state.evidence = ev;
      state.conflicts = reconciled.conflicts;

      this.latestState = state;
      this.overlayUI.update(toWidgetState(state, { provider: p.name }));
      this.syncState(state);
    } catch (err) {
      console.error(`[Context Monitor] ${p.name} extraction error:`, err);
    }
  }

  /** Toolbar badge; at most one message per 250 ms (streaming updates the page many times a second). */
  syncState(state) {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    this._pendingSync = state;
    if (this._syncTimer) return;
    const send = () => {
      if (!this._pendingSync) return;
      chrome.runtime.sendMessage({ type: 'CONTEXT_UPDATED', payload: this._pendingSync }).catch(() => {});
      this._pendingSync = null;
    };
    send();
    this._syncTimer = setTimeout(() => { this._syncTimer = null; send(); }, 250);
  }
}
