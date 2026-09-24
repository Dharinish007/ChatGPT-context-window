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

    let best = [];
    for (const selector of strategies) {
      const found = this._extractWith(root, selector);
      if (found.length > best.length) best = found;
    }
    return best;
  }

  /**
   * Extracts messages using one selector strategy.
   * @private
   */
  _extractWith(root, selector) {
    const messages = [];
    const turnElements = Array.from(root.querySelectorAll(selector) || []);
    const matched = new Set(turnElements);

    // Keep only top-level matches (a turn container can wrap a message node)
    const topTurns = turnElements.filter(el => {
      let parent = el.parentElement;
      while (parent && parent !== root) {
        if (matched.has(parent)) return false;
        parent = parent.parentElement;
      }
      return true;
    });

    for (let i = 0; i < topTurns.length; i++) {
      const turnEl = topTurns[i];
      const role = this.detectRole(turnEl);

      // Find content wrapper
      const contentEl = turnEl.querySelector('.markdown') ||
                        turnEl.querySelector('.whitespace-pre-wrap') ||
                        turnEl.querySelector('div[class*="prose"]') ||
                        turnEl;

      const text = this.cleanElementText(contentEl);
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
