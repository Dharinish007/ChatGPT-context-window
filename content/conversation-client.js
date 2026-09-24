/**
 * ChatGPT Context Monitor - Authoritative Conversation Client
 * 
 * Retrieves and normalizes conversation structure from ChatGPT Web's authoritative endpoint:
 * GET /backend-api/conversation/{conversation_id}
 * 
 * Features:
 * - Direct tree traversal from current_node leaf to root (resolves active branch without orphaned/edited turns).
 * - Session handling: reads the bearer token from same-origin /api/auth/session (required by
 *   /backend-api), keeps it in a private in-memory field, sends it only to chatgpt.com, never logs or stores it.
 * - Falls back to the conversation JSON the page itself downloaded (captured by the MAIN-world interceptor).
 * - Extracts message IDs, author roles, content types, parts[], model slugs, and file attachments.
 * - Robust error handling for 401/403/404/429, malformed JSON, and network interruptions.
 * - Automatic cycle detection and graceful fallbacks.
 */

export class ConversationClient {
  // Bearer token for same-origin /backend-api calls. Memory only: never stored, logged, or put in state.
  #accessToken = null;

  constructor(options = {}) {
    this.baseUrl = options.baseUrl || '';
    this.cache = new Map(); // conversationId -> { data, normalized, timestamp }
    this.cacheTtlMs = options.cacheTtlMs || 5000; // 5-second in-memory cache to prevent spamming
    this.activeFetches = new Map(); // conversationId -> Promise
    this.lastError = null;
    this.failures = new Map(); // conversationId -> { result, timestamp }
    this.captured = new Map(); // conversationId -> last known-good payload (page's own request or our last success)
    this.fetchSeq = new Map(); // conversationId -> latest request number; older responses never overwrite newer
    this.session = null; // { ok, status, planType, fetchedAt } - safe to expose, holds no token
    this._sessionPromise = null;
    this._normalized = new WeakMap(); // raw payload -> normalized result (payloads are never mutated)
    this.onRevalidated = null; // (conversationId) => void, when a background refresh brought new data
    this.stats = { downloads: 0, cacheHits: 0, staleServed: 0, normalizeReused: 0 };
  }

  _origin() {
    return (typeof window !== 'undefined' && window.location?.origin) ? window.location.origin : this.baseUrl;
  }

  /**
   * Reads the logged-in session (GET /api/auth/session, cookie-authenticated).
   * /backend-api rejects cookie-only requests, so its accessToken is required for the
   * conversation endpoint; the same response also reports the account's plan type.
   * @param {{ force?: boolean }} [opts]
   * @returns {Promise<{ ok: boolean, status: number, planType: string|null, fetchedAt: number }>}
   */
  async getSession({ force = false } = {}) {
    const now = Date.now();
    if (!force && this.session) {
      const ttl = this.session.ok ? 5 * 60 * 1000 : 60 * 1000; // Retry failures after a minute, not every mutation
      if (now - this.session.fetchedAt < ttl) return this.session;
    }
    if (this._sessionPromise) return this._sessionPromise;

    this._sessionPromise = (async () => {
      try {
        const res = await fetch(`${this._origin()}/api/auth/session`, {
          credentials: 'same-origin',
          headers: { 'Accept': 'application/json' }
        });
        if (!res.ok) {
          this.#accessToken = null;
          this.session = { ok: false, status: res.status, planType: null, fetchedAt: now };
        } else {
          const data = await res.json();
          this.#accessToken = typeof data?.accessToken === 'string' ? data.accessToken : null;
          this.session = {
            ok: Boolean(this.#accessToken),
            status: res.status,
            planType: data?.account?.planType || data?.account?.plan_type || null,
            fetchedAt: now
          };
        }
      } catch (err) {
        this.session = { ok: false, status: 0, error: err.message, planType: null, fetchedAt: now };
      }
      return this.session;
    })();
    const pending = this._sessionPromise;
    pending.finally(() => { if (this._sessionPromise === pending) this._sessionPromise = null; });
    return pending;
  }

  /**
   * Headers ChatGPT's own client sends to /backend-api (auth + device id when available).
   * @returns {Object}
   */
  _backendHeaders() {
    const headers = { 'Accept': 'application/json' };
    if (this.#accessToken) headers['Authorization'] = `Bearer ${this.#accessToken}`;
    const didMatch = typeof document !== 'undefined' ? document.cookie.match(/(?:^|;\s*)oai-did=([^;]+)/) : null;
    if (didMatch) headers['oai-device-id'] = decodeURIComponent(didMatch[1]);
    return headers;
  }

  /**
   * Extracts conversation ID from a URL string or window.location.
   * Supports:
   * - /c/{id}
   * - /g/{gpt-id}/c/{id}
   * - ?conversationId={id}
   * 
   * @param {string} [urlString] 
   * @returns {string|null}
   */
  extractConversationId(urlString) {
    const url = urlString || (typeof window !== 'undefined' && window.location ? window.location.href : '');
    if (!url) return null;

    try {
      // 1. Check path matches: /c/UUID or /g/.../c/UUID
      const pathMatch = url.match(/\/c\/([0-9a-fA-F-]{8,})/);
      if (pathMatch && pathMatch[1]) {
        return pathMatch[1];
      }

      // 2. Check query parameter: ?conversationId=UUID or ?c=UUID
      const queryMatch = url.match(/[?&](?:conversationId|conversation_id|c)=([0-9a-fA-F-]{8,})/);
      if (queryMatch && queryMatch[1]) {
        return queryMatch[1];
      }

      return null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Fetches authoritative conversation data from ChatGPT backend API.
   * Safe execution: zero credentials stored, automatic timeout, comprehensive error handling.
   * 
   * @param {string} conversationId 
   * @param {Object} [fetchOptions]
   * @returns {Promise<{ success: boolean, data?: Object, error?: string, status?: number }>}
   */
  async fetchConversation(conversationId, fetchOptions = {}) {
    if (!conversationId) {
      return { success: false, error: 'Missing conversation ID' };
    }

    // Check memory cache
    const now = Date.now();
    if (!fetchOptions.force && this.cache.has(conversationId)) {
      const cached = this.cache.get(conversationId);
      if (now - cached.timestamp < this.cacheTtlMs) {
        this.stats.cacheHits++;
        return { success: true, data: cached.data, fromCache: true };
      }
      // Stale-while-revalidate: answer now with the copy we have and refresh it in the background,
      // so an analysis pass never waits on a full conversation download just because time passed
      if (fetchOptions.staleWhileRevalidate) {
        this.stats.staleServed++;
        this._revalidate(conversationId, cached.data);
        return { success: true, data: cached.data, fromCache: true, stale: true };
      }
    }

    // Back off after a failure so DOM mutations don't hammer a failing endpoint
    const failed = this.failures.get(conversationId);
    if (!fetchOptions.force && failed && now - failed.timestamp < 15000) {
      return failed.result;
    }

    // Deduplicate concurrent requests, except a forced refresh: an in-flight request may have
    // started before the latest message was saved, so reusing it would return stale data
    if (!fetchOptions.force && this.activeFetches.has(conversationId)) {
      return this.activeFetches.get(conversationId);
    }

    const seq = (this.fetchSeq.get(conversationId) || 0) + 1;
    this.fetchSeq.set(conversationId, seq);
    const isLatest = () => this.fetchSeq.get(conversationId) === seq;

    const fetchPromise = (async () => {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeoutId = controller ? setTimeout(() => controller.abort(), 8000) : null;

      try {
        const endpoint = `${this._origin()}/backend-api/conversation/${conversationId}`;
        const doFetch = () => fetch(endpoint, {
          method: 'GET',
          headers: this._backendHeaders(),
          credentials: 'same-origin',
          signal: controller ? controller.signal : undefined
        });

        // /backend-api needs the session bearer token; cookies alone return 401
        await this.getSession();
        this.stats.downloads++;
        let response = await doFetch();
        if (response.status === 401) {
          // Token expired: refresh the session once and retry
          await this.getSession({ force: true });
          this.stats.downloads++;
          response = await doFetch();
        }

        if (timeoutId) clearTimeout(timeoutId);

        if (!response.ok) {
          const status = response.status;
          let errorMessage = `HTTP error ${status}`;

          if (status === 401 || status === 403) {
            errorMessage = this.session?.ok
              ? `Unauthorized (${status}) even with session token`
              : `Unauthorized (${status}): could not read login session (/api/auth/session ${this.session?.status ?? 'n/a'})`;
          } else if (status === 404) {
            errorMessage = 'Conversation not found on backend (new or deleted chat)';
          } else if (status === 429) {
            errorMessage = 'Rate limited: too many conversation requests';
          }

          this.lastError = { status, message: errorMessage, timestamp: now };
          return { success: false, error: errorMessage, status };
        }

        const rawData = await response.json();
        if (!rawData || !rawData.mapping) {
          this.lastError = { status: 200, message: 'Malformed conversation payload: missing mapping tree', timestamp: now };
          return { success: false, error: 'Malformed conversation payload', status: 200 };
        }

        // Cache the raw data, unless a newer request for this conversation was started meanwhile
        if (isLatest()) {
          // Freshness counts from the response: a slow or early (prefetched) read stays reusable for the full TTL
          this.cache.set(conversationId, {
            data: rawData,
            timestamp: Date.now()
          });
        }

        this.lastError = null;
        return { success: true, data: rawData };

      } catch (err) {
        if (timeoutId) clearTimeout(timeoutId);

        const isAbort = err.name === 'AbortError';
        const errorMessage = isAbort ? 'Request timed out after 8s' : (err.message || 'Network fetch failure');
        this.lastError = { status: 0, message: errorMessage, timestamp: now };

        return { success: false, error: errorMessage, isNetworkError: true };
      }
    })();

    const resultPromise = fetchPromise.then(result => {
      if (this.activeFetches.get(conversationId) === resultPromise) {
        this.activeFetches.delete(conversationId);
      }
      if (result.success) {
        this.failures.delete(conversationId);
        // Keep as last known-good, so one failed refresh never collapses the count to DOM-only
        if (isLatest()) this.captured.set(conversationId, result.data);
        return result;
      }
      // Our fetch failed: fall back to the last known-good copy (page's own request or our last success)
      const captured = this.captured.get(conversationId);
      if (captured) return { success: true, data: captured, fromCapture: true, fetchError: result.error };
      this.failures.set(conversationId, { result, timestamp: Date.now() });
      return result;
    });
    this.activeFetches.set(conversationId, resultPromise);
    return resultPromise;
  }

  /**
   * Background refresh of a stale cached copy (one at a time per conversation). Reports only when
   * the saved conversation actually changed (another tab/device, an edit), so callers re-run then.
   * @private
   */
  _revalidate(conversationId, previous) {
    if (this.activeFetches.has(conversationId)) return; // A read is already on its way
    this.fetchConversation(conversationId, { force: true }).then(result => {
      if (!result.success || result.fromCapture || !result.data || result.data === previous) return;
      const changed = !previous ||
        result.data.current_node !== previous.current_node ||
        result.data.update_time !== previous.update_time ||
        Object.keys(result.data.mapping || {}).length !== Object.keys(previous.mapping || {}).length;
      if (changed && typeof this.onRevalidated === 'function') this.onRevalidated(conversationId);
    }).catch(() => {});
  }

  /**
   * Accepts a conversation payload captured passively from the page's own request
   * (MAIN-world interceptor), so we have authoritative data even if our fetch fails.
   * @param {string} conversationId
   * @param {Object} data Raw /backend-api/conversation/{id} JSON
   */
  ingestConversation(conversationId, data) {
    if (!conversationId || !data || !data.mapping) return;
    this.captured.set(conversationId, data);
    this.cache.set(conversationId, { data, timestamp: Date.now() });
    this.failures.delete(conversationId);
  }

  /**
   * Traverses the conversation DAG mapping from current_node to root
   * to resolve the active linear conversation branch, ignoring abandoned or edited branches.
   * 
   * @param {Object} mapping Map of node_id -> node
   * @param {string|null} currentNodeId Active leaf node ID
   * @returns {Array<Object>} Linear chronological list of message nodes on active branch
   */
  resolveActiveBranch(mapping = {}, currentNodeId = null) {
    if (!mapping || typeof mapping !== 'object') return [];

    const nodes = [];
    const visited = new Set();
    let currentId = currentNodeId;

    // Fallback if current_node is not provided or not in mapping
    if (!currentId || !mapping[currentId]) {
      // Find a leaf node (node with no children or highest update time)
      const allNodeIds = Object.keys(mapping);
      if (allNodeIds.length === 0) return [];

      let bestLeaf = allNodeIds[0];
      for (const id of allNodeIds) {
        const node = mapping[id];
        if (!node.children || node.children.length === 0) {
          bestLeaf = id;
          break;
        }
      }
      currentId = bestLeaf;
    }

    // Traverse upwards from current_node to root
    while (currentId && mapping[currentId]) {
      if (visited.has(currentId)) {
        console.warn('[ChatGPT Context Monitor] Cycle detected in conversation mapping at node:', currentId);
        break;
      }
      visited.add(currentId);

      const node = mapping[currentId];
      if (node.message) {
        nodes.push(node);
      }

      currentId = node.parent;
    }

    // Reverse to establish chronological order (root -> leaf)
    return nodes.reverse();
  }

  /**
   * Normalizes raw parts into structured parts array.
   * @param {Object} content Message content object
   * @returns {Array<Object>}
   */
  normalizeParts(content) {
    if (!content) return [];
    const normalizedParts = [];

    const rawParts = content.parts || [];
    for (let i = 0; i < rawParts.length; i++) {
      const part = rawParts[i];
      if (typeof part === 'string') {
        if (part.trim().length > 0) {
          normalizedParts.push({ type: 'text', text: part });
        }
      } else if (part && typeof part === 'object') {
        if (part.content_type === 'image_asset_pointer') {
          normalizedParts.push({
            type: 'image',
            classification: 'ESTIMATED',
            assetPointer: part.asset_pointer,
            sizeBytes: part.size_bytes || null
          });
        } else if (part.text) {
          normalizedParts.push({ type: 'text', text: part.text });
        } else {
          normalizedParts.push({
            type: part.content_type || part.type || 'unknown',
            classification: 'UNKNOWN',
            details: part
          });
        }
      }
    }

    // If content_type is code or text without parts
    if (normalizedParts.length === 0 && content.text) {
      normalizedParts.push({ type: 'text', text: content.text });
    }

    return normalizedParts;
  }

  /**
   * Normalizes attachment references from message metadata.
   * @param {Object} metadata 
   * @returns {Array<Object>}
   */
  normalizeAttachments(metadata) {
    if (!metadata || !Array.isArray(metadata.attachments)) return [];

    return metadata.attachments.map(att => {
      const isImage = (att.mime_type && att.mime_type.startsWith('image/')) ||
                      (att.name && /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(att.name));

      return {
        id: att.id || att.file_id || 'unknown-att',
        name: att.name || 'Untitled File',
        size: att.size || att.file_size || null,
        mimeType: att.mime_type || null,
        type: isImage ? 'image' : 'document',
        classification: isImage ? 'ESTIMATED' : 'UNKNOWN'
      };
    });
  }

  /**
   * Normalizes raw backend conversation response into internal message models.
   * 
   * @param {Object} conversationPayload Response from GET /backend-api/conversation/{id}
   * @returns {{ conversationId: string, title: string, modelSlug: string|null, messages: Array<Object>, attachments: Object }}
   */
  normalizeConversation(conversationPayload) {
    // Same payload object -> same result: re-walking a long tree on every pass was wasted work
    if (conversationPayload && typeof conversationPayload === 'object' && this._normalized.has(conversationPayload)) {
      this.stats.normalizeReused++;
      return this._normalized.get(conversationPayload);
    }
    const result = this._normalizeUncached(conversationPayload);
    if (conversationPayload && typeof conversationPayload === 'object') this._normalized.set(conversationPayload, result);
    return result;
  }

  /** @private */
  _normalizeUncached(conversationPayload) {
    if (!conversationPayload || !conversationPayload.mapping) {
      return {
        conversationId: null,
        title: '',
        modelSlug: null,
        messages: [],
        attachments: { count: 0, estimatedTokens: 0, hasUnknown: false, items: [] }
      };
    }

    const activeNodes = this.resolveActiveBranch(
      conversationPayload.mapping,
      conversationPayload.current_node
    );

    const messages = [];
    const allAttachments = [];
    let detectedModelSlug = null;
    let turnIndex = 0;
    let hiddenMessages = 0; // Server-injected context messages (not measurable as visible turns)

    for (let i = 0; i < activeNodes.length; i++) {
      const node = activeNodes[i];
      const msg = node.message;
      if (!msg) continue;

      const role = msg.author?.role || 'user';
      // Ignore system instructions if they are standard internal framing
      if (role === 'system') continue;

      // Hidden context injected server-side (custom instructions, memory) is not a visible turn.
      // Counting it would inflate "You" and the turn count; it stays in the UNKNOWN hidden context.
      const contentType = msg.content?.content_type;
      if (msg.metadata?.is_visually_hidden_from_conversation ||
          contentType === 'user_editable_context' || contentType === 'model_editable_context') {
        hiddenMessages++;
        continue;
      }

      const parts = this.normalizeParts(msg.content);
      const attachments = this.normalizeAttachments(msg.metadata);

      // Latest assistant slug wins: model can change mid-conversation and the current one sets the limit
      if (role === 'assistant' && msg.metadata?.model_slug) {
        detectedModelSlug = msg.metadata.model_slug;
      }

      // Reasoning traces ("thoughts", "reasoning_recap") carry no parts and are not resent as context;
      // an empty message must not count as a turn
      if (parts.length === 0 && attachments.length === 0) continue;

      // Combine text parts for backward compatibility
      const textParts = parts.filter(p => p.type === 'text' && p.text);
      const combinedText = textParts.map(p => p.text).join('\n\n');

      // Track all attachments
      if (attachments.length > 0) {
        allAttachments.push(...attachments);
      }

      // Also track image parts as attachments if not already in metadata
      const imageParts = parts.filter(p => p.type === 'image');
      for (const img of imageParts) {
        allAttachments.push({
          id: img.assetPointer || `image-${turnIndex}`,
          name: 'Uploaded Image',
          type: 'image',
          classification: 'ESTIMATED'
        });
      }

      messages.push({
        id: msg.id || node.id || `turn-${turnIndex}-${role}`,
        nodeId: node.id,
        // Tool output (search results, code execution) is model-side context, not user input
        role: role === 'user' ? 'user' : (role === 'tool' ? 'tool' : 'assistant'),
        text: combinedText,
        parts,
        modelSlug: msg.metadata?.model_slug || null,
        attachments,
        createTime: msg.create_time,
        isStreaming: false
      });

      turnIndex++;
    }

    // Calculate attachment statistics
    let attachmentEstimatedTokens = 0;
    let hasUnknownAttachments = false;

    for (const att of allAttachments) {
      if (att.type === 'image') {
        attachmentEstimatedTokens += 300; // Calibrated vision tokens
      } else {
        hasUnknownAttachments = true;
      }
    }

    return {
      conversationId: conversationPayload.conversation_id || null,
      title: conversationPayload.title || '',
      modelSlug: detectedModelSlug || conversationPayload.default_model_slug || null,
      hiddenMessages,
      messages,
      attachments: {
        count: allAttachments.length,
        estimatedTokens: attachmentEstimatedTokens,
        hasUnknown: hasUnknownAttachments,
        items: allAttachments
      }
    };
  }

  /**
   * Clears internal cache (e.g. on navigation or logout).
   */
  clearCache() {
    this.cache.clear();
    this.activeFetches.clear();
    this.lastError = null;
  }
}
