/**
 * ChatGPT Context Monitor - Message Extractor
 * 
 * Safely extracts user and assistant conversation turns from ChatGPT Web DOM.
 * Strips UI chrome (action buttons, copy icons, edit forms) and preserves
 * rich text, code blocks, tables, and mathematical formulas.
 */

export class MessageExtractor {
  constructor(options = {}) {
    this.selectors = options.selectors || {};
    // element -> { raw: element count + textContent, text: cleaned text }. Cleaning deep-clones the node
    // and queries it many times; visible text cannot change without changing one of the two, so an
    // equal key means the cleaned text is still valid. Entries die with their elements.
    this._textCache = new WeakMap();
    this.stats = { cleaned: 0, reused: 0 };
    // true while a MutationObserver reports every page change through invalidate(): a cached entry is
    // then valid until invalidated, so unchanged messages are not even re-read (no textContent walk).
    this.trustCache = false;
  }

  /**
   * A page change at `node`: drops cached text of every element containing it. Text and structure of
   * an element can only change through a mutation inside it, so this keeps the cache exact.
   * @param {Node} node Mutation target (text nodes are resolved to their parent)
   */
  invalidate(node) {
    for (let el = node && (node.nodeType === 1 ? node : node.parentElement); el; el = el.parentElement) {
      this._textCache.delete(el);
    }
  }

  /**
   * cleanElementText with reuse for unchanged elements (same textContent = same visible text).
   * @param {HTMLElement} element
   * @returns {string}
   */
  _cleanText(element) {
    if (this.trustCache) {
      const trusted = this._textCache.get(element);
      if (trusted) {
        this.stats.reused++;
        return trusted.text;
      }
    }
    // Text plus element count: structure-only changes (a <br>, new block) alter innerText line breaks
    const elements = typeof element.getElementsByTagName === 'function' ? element.getElementsByTagName('*').length : -1;
    const raw = `${elements}|${element.textContent || ''}`;
    const hit = this._textCache.get(element);
    if (hit && hit.raw === raw) {
      this.stats.reused++;
      return hit.text;
    }
    const text = this.cleanElementText(element);
    this._textCache.set(element, { raw, text });
    this.stats.cleaned++;
    return text;
  }

  /**
   * Cleans UI elements from a cloned DOM element to extract pure content.
   * @param {HTMLElement} element 
   * @returns {string} Clean message text
   */
  cleanElementText(element) {
    if (!element) return '';

    // Clone element to avoid touching the live DOM
    const clone = element.cloneNode(true);

    // Remove buttons, toolbars, and UI feedback chips that don't belong to the message
    const uiSelectors = [
      'button',
      '.text-xs', // timestamp or model tags at bottom
      '[data-testid*="copy"]',
      '[data-testid*="edit"]',
      '[data-testid*="thumbs"]',
      'div[class*="speech"]',
      'div[class*="toolbar"]'
    ];

    for (let i = 0; i < uiSelectors.length; i++) {
      const badEls = clone.querySelectorAll(uiSelectors[i]);
      for (let j = 0; j < badEls.length; j++) {
        badEls[j].remove();
      }
    }

    // Preserve code blocks formatted
    const codeBlocks = clone.querySelectorAll('pre');
    for (let i = 0; i < codeBlocks.length; i++) {
      const code = codeBlocks[i].querySelector('code') || codeBlocks[i];
      const text = code.innerText || code.textContent || '';
      codeBlocks[i].textContent = `\n\`\`\`\n${text.trim()}\n\`\`\`\n`;
    }

    const text = clone.innerText || clone.textContent || '';
    return text.trim();
  }

  /**
   * Determines author role (user or assistant) of a turn element.
   * @param {HTMLElement} turnEl 
   * @returns {'user' | 'assistant'}
   */
  detectRole(turnEl) {
    if (!turnEl) return 'assistant';

    // 1. Check explicit data-message-author-role attribute
    const directRole = turnEl.getAttribute('data-message-author-role');
    if (directRole === 'user' || directRole === 'assistant') {
      return directRole;
    }

    // Newer turn containers carry data-turn="user|assistant"
    const turnAttr = turnEl.getAttribute('data-turn');
    if (turnAttr === 'user' || turnAttr === 'assistant') {
      return turnAttr;
    }

    // 2. Check inner elements with author role
    const innerRoleEl = turnEl.querySelector('[data-message-author-role]');
    if (innerRoleEl) {
      const innerRole = innerRoleEl.getAttribute('data-message-author-role');
      if (innerRole === 'user' || innerRole === 'assistant') {
        return innerRole;
      }
    }

    // 3. Fallback: user message container styling or testids
    if (
      turnEl.querySelector('[data-testid="user-message"]') ||
      turnEl.classList.contains('user-message') ||
      turnEl.getAttribute('data-testid')?.includes('user')
    ) {
      return 'user';
    }

    return 'assistant';
  }

  /**
   * Extracts conversation messages from the DOM document.
   * @param {Document|HTMLElement} root 
   * @returns {Array<{ id: string, role: 'user' | 'assistant', text: string, isStreaming: boolean }>}
   */
  extractMessages(root = document) {
    // ChatGPT's markup changes often, so run every strategy and keep the one that yields the most
    // non-empty messages. Stopping at the first selector that matches anything (e.g. a stray
    // <article>) is what produced "0 messages" on live pages.
    const strategies = [
      // Per-message nodes: the most stable anchor across ChatGPT builds
      "[data-message-author-role='user'], [data-message-author-role='assistant']",
      // Turn containers (<article> in older builds, <section> in newer ones)
      "[data-testid^='conversation-turn-']",
      "article",
      ".conversation-turn"
    ];

    // Same winner as extracting every strategy (most messages, earliest strategy on ties), but text is
    // only extracted for strategies that can still win: one strategy yields at most one message per
    // element it matches, so elements are counted first (cheap) and extraction runs in that order.
    const candidates = strategies
      .map((selector, index) => ({ index, turns: this._topTurns(root, selector) }))
      .sort((a, b) => b.turns.length - a.turns.length || a.index - b.index);
    let best = null;
    for (const c of candidates) {
      if (best && (c.turns.length < best.messages.length || (c.turns.length === best.messages.length && c.index > best.index))) continue;
      const messages = this._extractFrom(c.turns);
      if (!best || messages.length > best.messages.length || (messages.length === best.messages.length && c.index < best.index)) {
        best = { index: c.index, messages };
      }
    }
    return best ? best.messages : [];
  }

  /**
   * Top-level matches of a selector (a turn container can wrap a message node).
   * @private
   */
  _topTurns(root, selector) {
    const turnElements = Array.from(root.querySelectorAll(selector) || []);
    const matched = new Set(turnElements);
    return turnElements.filter(el => {
      let parent = el.parentElement;
      while (parent && parent !== root) {
        if (matched.has(parent)) return false;
        parent = parent.parentElement;
      }
      return true;
    });
  }

  /**
   * Extracts messages using one selector strategy.
   * @private
   */
  _extractWith(root, selector) {
    return this._extractFrom(this._topTurns(root, selector));
  }

  /** @private */
  _extractFrom(topTurns) {
    const messages = [];
    for (let i = 0; i < topTurns.length; i++) {
      const turnEl = topTurns[i];
      const role = this.detectRole(turnEl);

      // Find content wrapper
      const contentEl = turnEl.querySelector('.markdown') ||
                        turnEl.querySelector('.whitespace-pre-wrap') ||
                        turnEl.querySelector('div[class*="prose"]') ||
                        turnEl;

      const text = this._cleanText(contentEl);
      if (!text) continue;

      // Prefer ChatGPT's message id so DOM turns line up with API / network turns
      const idEl = turnEl.getAttribute('data-message-id') ? turnEl : turnEl.querySelector("[data-message-id]");
      const turnId = idEl?.getAttribute('data-message-id') ||
                     turnEl.getAttribute('data-testid') ||
                     turnEl.getAttribute('id') ||
                     `turn-${i}-${role}`;

      const slugEl = turnEl.getAttribute('data-message-model-slug') ? turnEl : turnEl.querySelector("[data-message-model-slug]");
      const modelSlug = slugEl?.getAttribute('data-message-model-slug') || null;

      const isStreaming = turnEl.classList.contains('result-streaming') ||
                          Boolean(turnEl.querySelector('.result-streaming'));

      const parts = [{ type: 'text', text }];

      // Detect non-text attachments inside the turn if present
      const fileEls = turnEl.querySelectorAll("[data-testid*='attachment'], [data-testid*='file'], .file-pill, img[alt*='Uploaded']");
      if (fileEls && fileEls.length > 0) {
        for (let f = 0; f < fileEls.length; f++) {
          const isImg = fileEls[f].tagName === 'IMG' || Boolean(fileEls[f].querySelector('img'));
          parts.push({
            type: isImg ? 'image' : 'file',
            classification: isImg ? 'ESTIMATED' : 'UNKNOWN'
          });
        }
      }

      messages.push({
        id: turnId,
        role,
        text,
        parts,
        modelSlug: role === 'assistant' ? modelSlug : null,
        isStreaming
      });
    }

    return messages;
  }
}
