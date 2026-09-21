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
    const messages = [];

    // Query conversation turn articles using cascading selectors
    const turnSelectors = [
      "article[data-testid^='conversation-turn-']",
      "article",
      "div[data-message-author-role]",
      ".conversation-turn"
    ];

    let turnElements = [];
    for (let i = 0; i < turnSelectors.length; i++) {
      const found = root.querySelectorAll(turnSelectors[i]);
      if (found && found.length > 0) {
        turnElements = Array.from(found);
        break;
      }
    }

    // If turn elements are nested articles, keep only top-level turns
    const topTurns = turnElements.filter(el => {
      let parent = el.parentElement;
      while (parent && parent !== root) {
        if (turnElements.includes(parent)) return false;
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

      // Extract or generate a deterministic ID
      const turnId = turnEl.getAttribute('data-testid') ||
                     turnEl.getAttribute('id') ||
                     `turn-${i}-${role}`;

      const isStreaming = turnEl.classList.contains('result-streaming') ||
                          Boolean(turnEl.querySelector('.result-streaming'));

      messages.push({
        id: turnId,
        role,
        text,
        isStreaming
      });
    }

    return messages;
  }
}
