/**
 * ChatGPT Context Monitor - Model Detector
 * 
 * Inspects ChatGPT Web DOM headers, buttons, and metadata to identify the
 * active model, resolving it against verified model configurations.
 */

export class ModelDetector {
  /**
   * @param {Object} modelLimitsDatabase Parsed content of config/model-limits.json
   */
  constructor(modelLimitsDatabase = {}) {
    this.models = modelLimitsDatabase.models || {};
    this.fallback = modelLimitsDatabase.productDisclaimers?.unknownModelFallback || {
      displayName: 'Unknown Model',
      contextWindow: null,
      maxOutput: null,
      source: 'Unrecognized model'
    };
  }

  /**
   * Scans DOM for visible model text indicators.
   * @param {Document|HTMLElement} root 
   * @returns {string|null} Raw detected model name
   */
  detectRawModelString(root = document) {
    const candidateSelectors = [
      "button[data-testid='model-switcher-dropdown']",
      "button[aria-haspopup='menu'][data-testid*='model']",
      "header button[class*='text-token-text-primary']",
      "header div[class*='font-semibold']",
      "[data-testid='model-selector']",
      "button.text-token-text-secondary"
    ];

    for (let i = 0; i < candidateSelectors.length; i++) {
      const el = root.querySelector(candidateSelectors[i]);
      if (el) {
        const text = (el.innerText || el.textContent || '').trim();
        if (text && !text.includes('ChatGPT') && text.length < 50) {
          return text;
        }
        // If it says "ChatGPT 4o" or similar, extract model part
        if (/ChatGPT\s*([4-9o\.-]+)/i.test(text)) {
          const match = text.match(/ChatGPT\s*([4-9o\.-]+)/i);
          return match ? match[1] : text;
        }
      }
    }

    // Check message turn attributes (some ChatGPT builds stamp data-message-model-slug)
    const slugEl = root.querySelector('[data-message-model-slug]');
    if (slugEl) {
      const slug = slugEl.getAttribute('data-message-model-slug');
      if (slug && slug !== 'user') return slug;
    }

    // Check page title or URL params if applicable
    const url = typeof window !== 'undefined' ? window.location.href : '';
    if (url.includes('model=')) {
      const match = url.match(/model=([a-zA-Z0-9\.-]+)/);
      if (match) return match[1];
    }

    return null;
  }

  /**
   * Resolves raw model string against verified model database.
   * @param {string|null} rawString 
   * @returns {Object} Model specification with context limits
   */
  resolveModel(rawString) {
    if (!rawString) {
      return {
        id: 'unknown',
        ...this.fallback
      };
    }

    const normalized = rawString.toLowerCase().trim();

    // 1. Direct key match
    if (this.models[normalized]) {
      return {
        id: normalized,
        ...this.models[normalized]
      };
    }

    // 2. Alias match
    for (const [modelId, spec] of Object.entries(this.models)) {
      if (spec.aliases && spec.aliases.includes(normalized)) {
        return {
          id: modelId,
          ...spec
        };
      }
      // Substring fuzzy matching (e.g. "o1-preview-2024" -> "o1-preview")
      if (normalized.includes(modelId)) {
        return {
          id: modelId,
          ...spec
        };
      }
    }

    // 3. Fallback for unrecognized models
    return {
      id: normalized,
      displayName: rawString,
      contextWindow: null,
      maxOutput: null,
      source: 'Unrecognized custom model or preview',
      lastVerified: null
    };
  }

  /**
   * Runs complete detection from DOM root.
   * @param {Document|HTMLElement} root 
   * @returns {Object}
   */
  detect(root = document) {
    const raw = this.detectRawModelString(root);
    return this.resolveModel(raw);
  }
}
