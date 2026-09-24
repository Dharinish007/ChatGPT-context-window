/**
 * ChatGPT Context Monitor - Request & Network Observer Module
 * 
 * Runs in the isolated content script world.
 * Bridges communication with the MAIN-world network interceptor via window.postMessage,
 * normalizes live network streaming events, tracks network layer health,
 * and feeds observable network evidence into the context pipeline.
 * 
 * Rules:
 * - Supplements, never replaces, Authoritative Conversation API & DOM
 * - Every network-derived value records provenance: { source: "network", evidenceType: "OBSERVED" }
 * - Graceful fallback: complete isolation from network failures or schema mutations
 * - Zero capture or persistence of auth tokens, session cookies, or credentials
 */

export class RequestObserver {
  /**
   * @param {Object} options
   * @param {Function} [options.onStreamChunk] - Callback fired on streaming updates
   * @param {Function} [options.onStreamComplete] - Callback fired when stream finishes
   * @param {Function} [options.onPromptSent] - Callback fired when user submits a message
   * @param {Function} [options.onConversationLoaded] - Callback fired when conversation JSON is loaded
   */
  constructor(options = {}) {
    this.onStreamChunk = options.onStreamChunk || null;
    this.onStreamComplete = options.onStreamComplete || null;
    this.onPromptSent = options.onPromptSent || null;
    this.onConversationLoaded = options.onConversationLoaded || null;

    // Network Health Tracking
    this.networkAvailable = false;
    this.lastEventTimestamp = null;
    this.interceptionErrors = 0;
    this.errorLog = [];
    this.unsupportedEndpoints = new Set();
    this.activeStreamsCount = 0;

    // Normalized Network Evidence State
    this.activeConversationId = null;
    this.observedModel = null; // { value: string, source: 'network', evidenceType: 'OBSERVED' }
    this.observedPlan = null; // { value: string, source: 'network', evidenceType: 'OBSERVED' }
    this.pendingUserTurn = null; // { id, role: 'user', parts, text, source: 'network', evidenceType: 'OBSERVED' }
    this.activeStreamingTurn = null; // { id, role: 'assistant', parts, text, isStreaming: true, ... }
    this.observedTools = new Map(); // toolName -> { name, status, source: 'network', evidenceType: 'OBSERVED' }
    // Every network-observed turn of the active conversation, in arrival order (messageId -> turn).
    // Holding all of them (not just the latest) keeps rapid consecutive messages when the API lags.
    this.liveTurns = new Map();
    this._completedStreams = new Set(); // streamKeys already completed (GENERATION_DONE + STREAM_COMPLETED)

    this._messageListener = (event) => this.handleMessage(event);
    this._isListening = false;
  }

  /**
   * Starts listening to MAIN-world bridge messages and sends a ping handshake.
   */
  start() {
    if (this._isListening || typeof window === 'undefined') return;

    window.addEventListener('message', this._messageListener);
    this._isListening = true;

    // Send handshake ping to MAIN world
    try {
      window.postMessage({
        source: 'CHATGPT_CONTEXT_MONITOR_ISOLATED',
        type: 'PING',
        timestamp: Date.now()
      }, '*');
    } catch (_) {}
  }

  /**
   * Stops listening to bridge messages and cleans up.
   */
  stop() {
    if (!this._isListening || typeof window === 'undefined') return;

    window.removeEventListener('message', this._messageListener);
    this._isListening = false;
  }

  /**
   * Handles incoming messages from MAIN-world interceptor.
   * @param {MessageEvent} event 
   */
  handleMessage(event) {
    if (event.source !== window) return;

    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.source !== 'CHATGPT_CONTEXT_MONITOR_NET') return;

    this.networkAvailable = true;
    this.lastEventTimestamp = data.timestamp || Date.now();

    const eventType = data.eventType;
    const payload = data.payload || {};

    try {
      switch (eventType) {
        case 'INTERCEPTOR_READY':
          this.networkAvailable = true;
          break;

        case 'CONVERSATION_REQUEST':
          this._handleConversationRequest(payload);
          break;

        case 'STREAM_STARTED':
          if (this._isForeign(payload)) break;
          this.activeStreamsCount++;
          if (payload.conversationId) {
            this.activeConversationId = payload.conversationId;
          }
          if (payload.model) {
            this.observedModel = {
              value: payload.model,
              source: 'network',
              evidenceType: 'OBSERVED',
              timestamp: Date.now()
            };
          }
          break;

        case 'STREAM_CHUNK':
          this._handleStreamChunk(payload);
          break;

        case 'TOOL_INVOKED':
          this._handleToolInvoked(payload);
          break;

        case 'GENERATION_DONE':
        case 'STREAM_COMPLETED':
          if (this._isForeign(payload)) break;
          // Both events arrive for one stream; complete it once so we refresh once
          if (payload.streamKey) {
            if (this._completedStreams.has(payload.streamKey)) break;
            this._completedStreams.add(payload.streamKey);
            if (this._completedStreams.size > 50) {
              this._completedStreams.delete(this._completedStreams.values().next().value);
            }
          }
          this._handleStreamCompleted(payload);
          break;

        case 'STREAM_ABORTED':
          if (this._isForeign(payload)) break;
          this.activeStreamsCount = Math.max(0, this.activeStreamsCount - 1);
          if (this.activeStreamingTurn) {
            this.activeStreamingTurn.isStreaming = false;
            this.activeStreamingTurn.status = 'aborted';
            this._upsertLiveTurn(this.activeStreamingTurn);
          }
          break;

        case 'CONVERSATION_LOADED':
          if (payload.modelSlug && payload.conversationId && payload.conversationId === this.activeConversationId) {
            this.observedModel = {
              value: payload.modelSlug,
              source: 'network',
              evidenceType: 'OBSERVED',
              timestamp: Date.now()
            };
          }
          if (typeof this.onConversationLoaded === 'function') {
            this.onConversationLoaded(payload);
          }
          break;

        case 'ACCOUNT_PLAN_OBSERVED':
          if (payload.planType) {
            this.observedPlan = {
              value: payload.planType,
              source: 'network',
              evidenceType: 'OBSERVED',
              endpoint: payload.endpoint || null,
              timestamp: Date.now()
            };
          }
          break;

        case 'MODELS_OBSERVED':
          // Array of model slugs available on ChatGPT Web
          break;

        case 'UNSUPPORTED_ENDPOINT_OBSERVED':
          if (payload.endpoint) {
            this.unsupportedEndpoints.add(payload.endpoint);
          }
          break;

        case 'INTERCEPTION_ERROR':
        case 'ENDPOINT_STATUS_ERROR':
          this.interceptionErrors++;
          if (payload.error || payload.status) {
            this.errorLog.push({
              type: payload.type || 'ERROR',
              endpoint: payload.endpoint || 'unknown',
              details: payload.error || `Status ${payload.status}`,
              timestamp: Date.now()
            });
            // Keep error log bounded
            if (this.errorLog.length > 20) {
              this.errorLog.shift();
            }
          }
          break;

        default:
          break;
      }
    } catch (err) {
      this.interceptionErrors++;
      console.warn('[ChatGPT Context Monitor] Failed to process network event:', err);
    }
  }

  /**
   * Normalizes outgoing prompt request data.
   * @param {Object} payload 
   * @private
   */
  _handleConversationRequest(payload) {
    if (payload.conversationId) {
      this.setActiveConversationId(payload.conversationId);
    }

    if (payload.model) {
      this.observedModel = {
        value: payload.model,
        source: 'network',
        evidenceType: 'OBSERVED',
        timestamp: Date.now()
      };
    }

    if (payload.userMessage) {
      this.pendingUserTurn = {
        id: payload.userMessage.id,
        role: 'user',
        parts: payload.userMessage.parts || [{ type: 'text', text: payload.userMessage.text }],
        text: payload.userMessage.text || '',
        contentType: payload.userMessage.contentType || 'text',
        source: 'network',
        evidenceType: 'OBSERVED',
        conversationId: payload.conversationId || this.activeConversationId || null,
        isStreaming: false
      };
      this._upsertLiveTurn(this.pendingUserTurn);

      if (typeof this.onPromptSent === 'function') {
        this.onPromptSent(this.pendingUserTurn);
      }
    }
  }

  /**
   * Normalizes live SSE stream chunks into the active streaming assistant turn.
   * @param {Object} payload 
   * @private
   */
  _handleStreamChunk(payload) {
    if (this._isForeign(payload)) return; // Late chunk from a conversation we already left
    if (!this.activeConversationId && payload.conversationId) {
      this.activeConversationId = payload.conversationId; // New chat just got its id
    }
    const text = typeof payload.text === 'string' ? payload.text : '';
    const messageId = payload.messageId || 'net-stream-' + (payload.streamId || 'active');

    this.activeStreamingTurn = {
      id: messageId,
      conversationId: payload.conversationId || this.activeConversationId || null,
      role: payload.role || 'assistant',
      parts: [{ type: 'text', text }],
      text,
      status: payload.status || 'in_progress',
      isStreaming: !payload.status || payload.status === 'in_progress',
      modelSlug: payload.modelSlug || (this.observedModel ? this.observedModel.value : null),
      source: 'network',
      evidenceType: 'OBSERVED'
    };

    this._upsertLiveTurn(this.activeStreamingTurn);

    if (payload.modelSlug && (!this.observedModel || this.observedModel.value !== payload.modelSlug)) {
      this.observedModel = {
        value: payload.modelSlug,
        source: 'network',
        evidenceType: 'OBSERVED',
        timestamp: Date.now()
      };
    }

    if (typeof this.onStreamChunk === 'function') {
      this.onStreamChunk(this.activeStreamingTurn);
    }
  }

  /**
   * Normalizes tool execution events observed in stream.
   * @param {Object} payload 
   * @private
   */
  _handleToolInvoked(payload) {
    if (!payload.toolName) return;

    this.observedTools.set(payload.toolName, {
      name: payload.toolName,
      status: 'invoked',
      source: 'network',
      evidenceType: 'OBSERVED',
      timestamp: Date.now()
    });
  }

  /**
   * Normalizes stream completion.
   * @param {Object} payload 
   * @private
   */
  _handleStreamCompleted(payload) {
    this.activeStreamsCount = Math.max(0, this.activeStreamsCount - 1);

    if (this.activeStreamingTurn) {
      this.activeStreamingTurn.isStreaming = false;
      this.activeStreamingTurn.status = 'finished_successfully';
      this._upsertLiveTurn(this.activeStreamingTurn);
    }

    // Clear pending user turn once generation is done
    const completedTurn = this.activeStreamingTurn;

    if (typeof this.onStreamComplete === 'function') {
      this.onStreamComplete({
        conversationId: payload.conversationId || this.activeConversationId,
        turn: completedTurn,
        tools: Array.from(this.observedTools.values())
      });
    }
  }

  /**
   * Resets active streaming and in-flight state (e.g. upon conversation switch).
   */
  resetActiveStream() {
    this.activeStreamingTurn = null;
    this.pendingUserTurn = null;
    this.observedTools.clear();
    this.liveTurns.clear();
    this.observedModel = null; // Model of conversation A must never label conversation B
    this.activeStreamsCount = 0;
  }

  /**
   * True when an event names a conversation other than the active one.
   * @private
   */
  _isForeign(payload) {
    const c = payload && payload.conversationId;
    return Boolean(c && this.activeConversationId && c !== this.activeConversationId);
  }

  /**
   * Inserts or updates a live turn by message id, keeping arrival order; bounded.
   * @private
   */
  _upsertLiveTurn(turn) {
    if (!turn || !turn.id) return;
    const existing = this.liveTurns.get(turn.id);
    this.liveTurns.set(turn.id, existing ? { ...existing, ...turn } : { ...turn });
    if (this.liveTurns.size > 40) {
      this.liveTurns.delete(this.liveTurns.keys().next().value);
    }
  }

  /**
   * All network-observed turns of the active conversation, oldest first.
   * @returns {Array<Object>}
   */
  getLiveTurns() {
    return Array.from(this.liveTurns.values());
  }

  /**
   * Sets active conversation ID and flushes in-flight turns if ID changed.
   * @param {string|null} id 
   */
  setActiveConversationId(id) {
    if (id !== this.activeConversationId) {
      this.activeConversationId = id;
      this.resetActiveStream();
    }
  }

  /**
   * Returns current network health snapshot.
   * @returns {Object}
   */
  getHealth() {
    return {
      networkAvailable: this.networkAvailable,
      lastEventTimestamp: this.lastEventTimestamp,
      interceptionErrors: this.interceptionErrors,
      activeStreamsCount: this.activeStreamsCount,
      unsupportedEndpoints: Array.from(this.unsupportedEndpoints),
      errorCount: this.interceptionErrors
    };
  }

  /**
   * Returns currently observed active model with provenance, or null.
   * @returns {{ value: string, source: string, evidenceType: string }|null}
   */
  getObservedModel() {
    return this.observedModel;
  }

  /**
   * Returns currently observed user plan tier with provenance, or null.
   * @returns {{ value: string, source: string, evidenceType: string }|null}
   */
  getObservedPlan() {
    return this.observedPlan;
  }

  /**
   * Returns in-flight pending user message, or null.
   * @returns {Object|null}
   */
  getPendingUserTurn() {
    return this.pendingUserTurn;
  }

  /**
   * Returns active streaming assistant message, or null.
   * @returns {Object|null}
   */
  getStreamingTurn() {
    return this.activeStreamingTurn;
  }

  /**
   * Returns array of observed tools with provenance.
   * @returns {Array<Object>}
   */
  getObservedTools() {
    return Array.from(this.observedTools.values());
  }

  /**
   * Returns active conversation ID if captured via network.
   * @returns {string|null}
   */
  getActiveConversationId() {
    return this.activeConversationId;
  }
}
