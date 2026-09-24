/**
 * ChatGPT Context Monitor - Authoritative Conversation Client
 * 
 * Retrieves and normalizes conversation structure from ChatGPT Web's authoritative endpoint:
 * GET /backend-api/conversation/{conversation_id}
 * 
 * Features:
 * - Direct tree traversal from current_node leaf to root (resolves active branch without orphaned/edited turns).
 * - Safe session handling: uses ambient same-origin credentials, zero credential logging or storage.
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
    this.session = null; // { ok, status, planType, fetchedAt } - safe to expose, holds no token
    this._sessionPromise = null;
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
      } finally {
        this._sessionPromise = null;
      }
      return this.session;
    })();
    return this._sessionPromise;
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
        return { success: true, data: cached.data, fromCache: true };
      }
    }

    // Deduplicate concurrent requests for the same conversation ID
    if (this.activeFetches.has(conversationId)) {
      return this.activeFetches.get(conversationId);
    }

    const fetchPromise = (async () => {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeoutId = controller ? setTimeout(() => controller.abort(), 8000) : null;

      try {
        const origin = (typeof window !== 'undefined' && window.location?.origin) ? window.location.origin : this.baseUrl;
        const endpoint = `${origin}/backend-api/conversation/${conversationId}`;

        // Attempt same-origin fetch with ambient session cookies
        const response = await fetch(endpoint, {
          method: 'GET',
          headers: {
            'Accept': 'application/json'
          },
          credentials: 'same-origin',
          signal: controller ? controller.signal : undefined
        });

        if (timeoutId) clearTimeout(timeoutId);

        if (!response.ok) {
          const status = response.status;
          let errorMessage = `HTTP error ${status}`;

          if (status === 401 || status === 403) {
            errorMessage = 'Unauthorized: session cookie expired or unauthenticated';
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

        // Cache the raw data
        this.cache.set(conversationId, {
          data: rawData,
          timestamp: now
        });

        this.lastError = null;
        return { success: true, data: rawData };

      } catch (err) {
        if (timeoutId) clearTimeout(timeoutId);

        const isAbort = err.name === 'AbortError';
        const errorMessage = isAbort ? 'Request timed out after 8s' : (err.message || 'Network fetch failure');
        this.lastError = { status: 0, message: errorMessage, timestamp: now };

        return { success: false, error: errorMessage, isNetworkError: true };
      } finally {
        this.activeFetches.delete(conversationId);
      }
    })();

    this.activeFetches.set(conversationId, fetchPromise);
    return fetchPromise;
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

    for (let i = 0; i < activeNodes.length; i++) {
      const node = activeNodes[i];
      const msg = node.message;
      if (!msg) continue;

      const role = msg.author?.role || 'user';
      // Ignore system instructions if they are standard internal framing
      if (role === 'system') continue;

      const parts = this.normalizeParts(msg.content);
      const attachments = this.normalizeAttachments(msg.metadata);

      // Extract model slug from assistant messages if present
      if (msg.metadata?.model_slug && !detectedModelSlug) {
        detectedModelSlug = msg.metadata.model_slug;
      }

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
        role: role === 'assistant' ? 'assistant' : 'user',
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
      modelSlug: detectedModelSlug,
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
