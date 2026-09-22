/**
 * ChatGPT Context Monitor - MAIN-World Network Interceptor
 * 
 * Injected into the page's MAIN execution context at document_start.
 * Safely instruments window.fetch and XMLHttpRequest to passively observe
 * ChatGPT application traffic and stream generation without interfering with page operations.
 * 
 * Rules:
 * - Runs in window (MAIN world)
 * - Safe postMessage bridge to isolated-world extension
 * - Zero capture/storage of credentials, Authorization headers, or cookies
 * - Passive non-blocking read-only inspection (uses response.clone() for SSE)
 * - Never throws or breaks host page network requests
 */

(function() {
  'use strict';

  // Prevent multiple injections
  if (window.__CHATGPT_CONTEXT_MONITOR_INTERCEPTOR_LOADED__) {
    return;
  }
  window.__CHATGPT_CONTEXT_MONITOR_INTERCEPTOR_LOADED__ = true;

  const BRIDGE_SOURCE = 'CHATGPT_CONTEXT_MONITOR_NET';
  const BRIDGE_VERSION = '1.0';

  /**
   * Dispatches a message to the isolated-world content script via postMessage.
   * @param {string} eventType 
   * @param {Object} payload 
   */
  function dispatchNetworkEvent(eventType, payload = {}) {
    try {
      window.postMessage({
        source: BRIDGE_SOURCE,
        version: BRIDGE_VERSION,
        eventType,
        payload,
        timestamp: Date.now()
      }, '*');
    } catch (_) {
      // Ignore if document is unloading
    }
  }

  /**
   * Determines if a URL is a relevant ChatGPT backend endpoint.
   * @param {string} url 
   * @returns {boolean}
   */
  function isRelevantBackendUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return url.includes('/backend-api/');
  }

  /**
   * Extracts clean path from full URL for logging/unsupported endpoint tracking.
   * @param {string} fullUrl 
   * @returns {string}
   */
  function extractEndpointPath(fullUrl) {
    try {
      const parsed = new URL(fullUrl, window.location.origin);
      return parsed.pathname;
    } catch (_) {
      return fullUrl.split('?')[0] || fullUrl;
    }
  }

  /**
   * Sanitizes string values to prevent memory bloat or unexpected types.
   * @param {*} val 
   * @param {number} maxLen 
   * @returns {string}
   */
  function safeString(val, maxLen = 1000) {
    if (typeof val !== 'string') return '';
    if (val.length <= maxLen) return val;
    return val.slice(0, maxLen);
  }

  /**
   * Extracts safe user message properties from POST /backend-api/conversation payload.
   * Does NOT touch authorization or cookie headers.
   * @param {Object} bodyObj 
   * @returns {Object|null}
   */
  function extractUserMessageFromPayload(bodyObj) {
    if (!bodyObj || typeof bodyObj !== 'object') return null;

    let messageObj = null;
    if (Array.isArray(bodyObj.messages) && bodyObj.messages.length > 0) {
      // Find user message in request
      messageObj = bodyObj.messages.find(m => m?.author?.role === 'user') || bodyObj.messages[bodyObj.messages.length - 1];
    }

    if (!messageObj) return null;

    const parts = [];
    if (messageObj.content && Array.isArray(messageObj.content.parts)) {
      for (const p of messageObj.content.parts) {
        if (typeof p === 'string') {
          parts.push({ type: 'text', text: p });
        } else if (p && typeof p === 'object') {
          parts.push({
            type: p.content_type || p.type || 'unknown',
            name: safeString(p.name || p.asset_pointer || ''),
            size_bytes: typeof p.size_bytes === 'number' ? p.size_bytes : null
          });
        }
      }
    }

    return {
      id: safeString(messageObj.id, 64) || 'net-usr-' + Date.now(),
      role: 'user',
      parts,
      text: parts.filter(p => p.type === 'text').map(p => p.text).join('\n'),
      contentType: safeString(messageObj.content?.content_type, 64) || 'text'
    };
  }

  /**
   * Processes Server-Sent Events (SSE) stream asynchronously without blocking page consumption.
   * Reads from a cloned response stream so the page's original reader remains unaffected.
   * 
   * @param {ReadableStream} stream 
   * @param {Object} meta 
   */
  async function processSSEStream(stream, meta) {
    if (!stream || typeof stream.getReader !== 'function') return;

    const reader = stream.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let streamId = meta.conversationId || 'stream-' + Date.now();
    let currentMessageId = null;
    let currentModelSlug = null;
    let accumulatedText = '';
    let lastParts = [];
    let detectedTools = [];
    let lastDispatchTime = 0;
    const DISPATCH_THROTTLE_MS = 50;

    dispatchNetworkEvent('STREAM_STARTED', {
      streamId,
      conversationId: meta.conversationId,
      model: meta.model,
      timestamp: Date.now()
    });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete trailing fragment in buffer

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line || line.startsWith(':')) {
            // Heartbeat / comment
            continue;
          }

          if (line.startsWith('data:')) {
            const dataStr = line.slice(5).trim();
            if (dataStr === '[DONE]') {
              dispatchNetworkEvent('GENERATION_DONE', {
                streamId,
                conversationId: meta.conversationId,
                messageId: currentMessageId,
                modelSlug: currentModelSlug,
                tools: detectedTools,
                timestamp: Date.now()
              });
              continue;
            }

            try {
              const payload = JSON.parse(dataStr);

              // 1. Capture conversation_id if assigned mid-stream
              if (payload.conversation_id && !meta.conversationId) {
                meta.conversationId = payload.conversation_id;
                streamId = payload.conversation_id;
              }

              // 2. Extract message turn data
              if (payload.message && typeof payload.message === 'object') {
                const msg = payload.message;
                currentMessageId = msg.id || currentMessageId;
                const authorRole = msg.author?.role || 'assistant';

                // Check model slug
                if (msg.metadata?.model_slug) {
                  currentModelSlug = msg.metadata.model_slug;
                }

                // Check tool / search recipient
                if (msg.recipient && msg.recipient !== 'all') {
                  const toolName = safeString(msg.recipient, 64);
                  if (!detectedTools.includes(toolName)) {
                    detectedTools.push(toolName);
                    dispatchNetworkEvent('TOOL_INVOKED', {
                      streamId,
                      toolName,
                      timestamp: Date.now()
                    });
                  }
                }

                // Check action data or tool calls in metadata
                if (msg.metadata?.action_data || msg.metadata?.tool_calls) {
                  const toolName = msg.metadata.action_data?.type || 'tool_call';
                  if (!detectedTools.includes(toolName)) {
                    detectedTools.push(toolName);
                    dispatchNetworkEvent('TOOL_INVOKED', {
                      streamId,
                      toolName,
                      timestamp: Date.now()
                    });
                  }
                }

                // Extract text parts
                if (msg.content && Array.isArray(msg.content.parts)) {
                  lastParts = msg.content.parts;
                  const textParts = lastParts.filter(p => typeof p === 'string');
                  accumulatedText = textParts.join('\n');
                }

                // Throttled stream chunk dispatch
                const now = Date.now();
                if (now - lastDispatchTime >= DISPATCH_THROTTLE_MS || msg.status === 'finished_successfully') {
                  lastDispatchTime = now;
                  dispatchNetworkEvent('STREAM_CHUNK', {
                    streamId,
                    conversationId: meta.conversationId,
                    messageId: currentMessageId,
                    role: authorRole,
                    text: accumulatedText,
                    partsCount: lastParts.length,
                    status: msg.status || 'in_progress',
                    modelSlug: currentModelSlug,
                    tools: detectedTools,
                    timestamp: now
                  });
                }
              }

              // 3. Handle JSON Patch / Delta formats if present
              if (payload.v !== undefined && (payload.p || payload.o)) {
                // Delta format observed
                if (typeof payload.v === 'string') {
                  accumulatedText += payload.v;
                  const now = Date.now();
                  if (now - lastDispatchTime >= DISPATCH_THROTTLE_MS) {
                    lastDispatchTime = now;
                    dispatchNetworkEvent('STREAM_CHUNK', {
                      streamId,
                      conversationId: meta.conversationId,
                      messageId: currentMessageId,
                      role: 'assistant',
                      text: accumulatedText,
                      status: 'in_progress',
                      modelSlug: currentModelSlug,
                      tools: detectedTools,
                      timestamp: now
                    });
                  }
                }
              }

            } catch (_) {
              // Unparseable SSE data chunk, preserve unknown
            }
          }
        }
      }

      // Flush remaining line in buffer
      if (buffer.startsWith('data:')) {
        const remainingData = buffer.slice(5).trim();
        if (remainingData === '[DONE]') {
          dispatchNetworkEvent('GENERATION_DONE', {
            streamId,
            conversationId: meta.conversationId,
            messageId: currentMessageId,
            modelSlug: currentModelSlug,
            timestamp: Date.now()
          });
        }
      }

      dispatchNetworkEvent('STREAM_COMPLETED', {
        streamId,
        conversationId: meta.conversationId,
        messageId: currentMessageId,
        textLength: accumulatedText.length,
        modelSlug: currentModelSlug,
        tools: detectedTools,
        timestamp: Date.now()
      });

    } catch (err) {
      dispatchNetworkEvent('STREAM_ABORTED', {
        streamId,
        conversationId: meta.conversationId,
        messageId: currentMessageId,
        error: safeString(err.message, 200),
        timestamp: Date.now()
      });
    } finally {
      try {
        reader.releaseLock();
      } catch (_) {}
    }
  }

  // ==========================================
  // 1. Instrument window.fetch
  // ==========================================
  const originalFetch = window.fetch;

  if (typeof originalFetch === 'function') {
    window.fetch = async function(...args) {
      const resource = args[0];
      const init = args[1] || {};
      const url = typeof resource === 'string'
        ? resource
        : (resource && typeof resource.url === 'string' ? resource.url : '');

      // Pass through all non-relevant requests instantly
      if (!isRelevantBackendUrl(url)) {
        return originalFetch.apply(this, args);
      }

      const method = (init.method || (resource && resource.method) || 'GET').toUpperCase();
      const endpoint = extractEndpointPath(url);

      // Pre-request observation: inspect user submission on POST /backend-api/conversation
      let requestMeta = {
        url,
        endpoint,
        method,
        conversationId: null,
        model: null
      };

      if (url.includes('/backend-api/conversation') && method === 'POST') {
        try {
          let bodyStr = null;
          if (typeof init.body === 'string') {
            bodyStr = init.body;
          } else if (resource && typeof resource.clone === 'function') {
            try {
              const reqClone = resource.clone();
              bodyStr = await reqClone.text();
            } catch (_) {}
          }

          if (bodyStr) {
            const bodyObj = JSON.parse(bodyStr);
            requestMeta.conversationId = bodyObj.conversation_id || null;
            requestMeta.model = bodyObj.model || null;

            const userMessage = extractUserMessageFromPayload(bodyObj);
            dispatchNetworkEvent('CONVERSATION_REQUEST', {
              endpoint,
              conversationId: requestMeta.conversationId,
              model: requestMeta.model,
              parentMessageId: bodyObj.parent_message_id || null,
              userMessage,
              timestamp: Date.now()
            });
          }
        } catch (_) {
          // Payload parsing error - preserve untouched
        }
      }

      // Execute original fetch
      let response;
      try {
        response = await originalFetch.apply(this, args);
      } catch (networkErr) {
        dispatchNetworkEvent('INTERCEPTION_ERROR', {
          type: 'FETCH_FAILED',
          endpoint,
          error: safeString(networkErr.message, 200),
          timestamp: Date.now()
        });
        throw networkErr;
      }

      // Post-response observation
      try {
        // Track HTTP status anomalies
        if (response.status >= 400) {
          dispatchNetworkEvent('ENDPOINT_STATUS_ERROR', {
            endpoint,
            status: response.status,
            timestamp: Date.now()
          });
        }

        // Handle streaming response: POST /backend-api/conversation
        if (url.includes('/backend-api/conversation') && method === 'POST') {
          if (response.body && !response.bodyUsed) {
            try {
              const cloned = response.clone();
              processSSEStream(cloned.body, requestMeta);
            } catch (cloneErr) {
              dispatchNetworkEvent('INTERCEPTION_ERROR', {
                type: 'STREAM_CLONE_ERROR',
                endpoint,
                error: safeString(cloneErr.message, 200),
                timestamp: Date.now()
              });
            }
          }
        }

        // Handle conversation retrieval: GET /backend-api/conversation/{id}
        else if (url.includes('/backend-api/conversation/') && method === 'GET') {
          if (response.status === 200 && response.body && !response.bodyUsed) {
            try {
              const cloned = response.clone();
              cloned.text().then(text => {
                try {
                  const data = JSON.parse(text);
                  dispatchNetworkEvent('CONVERSATION_LOADED', {
                    endpoint,
                    conversationId: data.conversation_id || null,
                    title: safeString(data.title, 100),
                    modelSlug: safeString(data.model_slug, 50),
                    mappingNodesCount: data.mapping ? Object.keys(data.mapping).length : 0,
                    timestamp: Date.now()
                  });
                } catch (_) {}
              }).catch(() => {});
            } catch (_) {}
          }
        }

        // Handle model list: GET /backend-api/models
        else if (url.includes('/backend-api/models') && method === 'GET') {
          if (response.status === 200 && response.body && !response.bodyUsed) {
            try {
              const cloned = response.clone();
              cloned.text().then(text => {
                try {
                  const data = JSON.parse(text);
                  const models = Array.isArray(data.models) ? data.models.map(m => m.slug || m.id).filter(Boolean) : [];
                  dispatchNetworkEvent('MODELS_OBSERVED', {
                    endpoint,
                    models,
                    timestamp: Date.now()
                  });
                } catch (_) {}
              }).catch(() => {});
            } catch (_) {}
          }
        }

        // Untracked / New backend endpoint detection
        else {
          dispatchNetworkEvent('UNSUPPORTED_ENDPOINT_OBSERVED', {
            endpoint,
            method,
            status: response.status,
            timestamp: Date.now()
          });
        }

      } catch (inspectErr) {
        dispatchNetworkEvent('INTERCEPTION_ERROR', {
          type: 'RESPONSE_INSPECTION_ERROR',
          endpoint,
          error: safeString(inspectErr.message, 200),
          timestamp: Date.now()
        });
      }

      return response;
    };
  }

  // ==========================================
  // 2. Instrument XMLHttpRequest
  // ==========================================
  const originalXHR = window.XMLHttpRequest;

  if (typeof originalXHR === 'function' && originalXHR.prototype) {
    const origOpen = originalXHR.prototype.open;
    const origSend = originalXHR.prototype.send;

    originalXHR.prototype.open = function(method, url, ...rest) {
      try {
        this.__cm_url = typeof url === 'string' ? url : '';
        this.__cm_method = typeof method === 'string' ? method.toUpperCase() : 'GET';
      } catch (_) {}
      return origOpen.call(this, method, url, ...rest);
    };

    originalXHR.prototype.send = function(body) {
      if (this.__cm_url && isRelevantBackendUrl(this.__cm_url)) {
        const endpoint = extractEndpointPath(this.__cm_url);

        try {
          this.addEventListener('load', function() {
            try {
              if (this.status >= 400) {
                dispatchNetworkEvent('ENDPOINT_STATUS_ERROR', {
                  endpoint,
                  status: this.status,
                  timestamp: Date.now()
                });
              } else if (endpoint.includes('/backend-api/conversation')) {
                dispatchNetworkEvent('XHR_CONVERSATION_OBSERVED', {
                  endpoint,
                  status: this.status,
                  timestamp: Date.now()
                });
              }
            } catch (_) {}
          });

          this.addEventListener('error', function() {
            dispatchNetworkEvent('INTERCEPTION_ERROR', {
              type: 'XHR_NETWORK_ERROR',
              endpoint,
              timestamp: Date.now()
            });
          });
        } catch (_) {}
      }

      return origSend.call(this, body);
    };
  }

  // ==========================================
  // 3. PostMessage Bridge Handshake
  // ==========================================
  // Announce interceptor presence to isolated-world extension
  dispatchNetworkEvent('INTERCEPTOR_READY', {
    features: ['fetch', 'xhr', 'sse'],
    timestamp: Date.now()
  });

  // Listen for ping requests from isolated world
  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    if (event.data?.source === 'CHATGPT_CONTEXT_MONITOR_ISOLATED' && event.data?.type === 'PING') {
      dispatchNetworkEvent('INTERCEPTOR_READY', {
        features: ['fetch', 'xhr', 'sse'],
        timestamp: Date.now()
      });
    }
  });

  console.log('[ChatGPT Context Monitor] MAIN-world Network Interceptor active.');
})();
