/**
 * ChatGPT Context Monitor - DOM Observer & Lifecycle Orchestrator
 * 
 * Manages MutationObserver, throttled DOM change detection, streaming response
 * state, and SPA route changes on ChatGPT Web without degrading page performance.
 */

export class ChatGPTDOMObserver {
  /**
   * @param {Object} options
   * @param {Function} options.onChange - Callback fired when DOM updates
   * @param {number} options.debounceMs - Debounce interval (default 120ms)
   */
  constructor(options = {}) {
    this.onChange = options.onChange || (() => {});
    this.debounceMs = options.debounceMs || 120;
    // Upper bound on how long a burst of mutations can postpone an update. Without it, a page that
    // never stops mutating (initial render, animations) kept pushing the trailing debounce back.
    this.maxWaitMs = options.maxWaitMs || 400;
    this.observer = null;
    this.debounceTimer = null;
    this._pendingSince = 0;
    this._composer = null;
    this.ignoredMutations = 0; // Batches skipped as irrelevant (performance diagnostics)
    this.lastUrl = typeof window !== 'undefined' ? window.location.href : '';
    this.isStreaming = false;
  }

  /**
   * Checks if an assistant response is currently streaming in the DOM.
   * @returns {boolean}
   */
  checkIsStreaming() {
    return Boolean(
      document.querySelector('.result-streaming') ||
      document.querySelector("button[aria-label*='Stop generating']") ||
      document.querySelector("button[aria-label*='Stop streaming']") ||
      document.querySelector("[data-testid='stop-button']")
    );
  }

  /**
   * Starts observing ChatGPT DOM changes.
   */
  start() {
    if (this.observer) return;

    this.observer = new MutationObserver((mutations) => {
      this.handleMutations(mutations);
    });

    const target = document.body;
    if (target) {
      this.observer.observe(target, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }

    // Also monitor URL/SPA navigation changes
    window.addEventListener('popstate', () => this.handleNavigation());
    this.pollUrlChange();
    // Background tabs throttle timers (up to once a minute); re-read as soon as the tab is shown again
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.triggerUpdate();
    });

    // Initial trigger
    this.triggerUpdate();
  }

  /**
   * Throttles DOM mutations and fires the change callback.
   * @param {MutationRecord[]} mutations 
   */
  handleMutations(mutations) {
    // Typing in the chat input, the sidebar list and our own widget cannot change the conversation's
    // context; skipping them removes most idle work (every keystroke used to start a full pass)
    if (Array.isArray(mutations) && mutations.length > 0 && !mutations.some(m => this._isRelevant(m))) {
      this.ignoredMutations++;
      return;
    }
    const streamingNow = this.checkIsStreaming();
    this.isStreaming = streamingNow;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // Faster updates (80ms) during active streaming; normal 120ms when stationary,
    // but never later than maxWaitMs after the first unhandled mutation
    const now = Date.now();
    if (!this._pendingSince) this._pendingSince = now;
    const delay = Math.max(0, Math.min(streamingNow ? 80 : this.debounceMs, this._pendingSince + this.maxWaitMs - now));

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const triggeredAt = this._pendingSince; // First unhandled change: start of the update latency
      this._pendingSince = 0;
      this.triggerUpdate({ triggeredAt });
    }, delay);
  }

  /**
   * False for mutations inside regions that never hold conversation content: the chat input's form
   * (unless it is the model switcher), the sidebar <nav>, and the extension's own widget.
   * @param {MutationRecord} m
   * @returns {boolean}
   */
  _isRelevant(m) {
    const node = m.target && (m.target.nodeType === 1 ? m.target : m.target.parentElement);
    if (!node || !node.closest) return true;
    if (node.closest('#chatgpt-context-monitor-host, nav')) return false;
    if (!this._composer || !this._composer.isConnected) {
      this._composer = document.querySelector('#prompt-textarea')?.closest('form') || null;
    }
    if (this._composer && this._composer.contains(node)) {
      return Boolean(node.closest("[data-testid*='model-switcher'], [data-testid*='model-selector']"));
    }
    return true;
  }

  /**
   * Checks for SPA conversation route changes (/c/:id).
   */
  pollUrlChange() {
    setInterval(() => {
      if (typeof window !== 'undefined' && window.location.href !== this.lastUrl) {
        this.handleNavigation();
      }
    }, 500);
  }

  /**
   * Handles conversation navigation event.
   */
  handleNavigation() {
    this.lastUrl = window.location.href;
    // Reset any state needed for new conversation
    this.triggerUpdate({ isNavigation: true });
  }

  /**
   * Fires the change callback with current streaming context.
   * @param {Object} extra 
   */
  triggerUpdate(extra = {}) {
    try {
      this.onChange({
        isStreaming: this.isStreaming,
        url: this.lastUrl,
        ...extra
      });
    } catch (err) {
      console.error('[ChatGPT Context Monitor] DOM update handler error:', err);
    }
  }

  /**
   * Disconnects the observer.
   */
  stop() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
