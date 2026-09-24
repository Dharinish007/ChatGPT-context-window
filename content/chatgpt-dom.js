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
      this._pendingSince = 0;
      this.triggerUpdate();
    }, delay);
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
