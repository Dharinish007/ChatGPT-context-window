/**
 * ChatGPT Context Monitor - Model & Plan-Aware Limit Detector (Group F)
 * 
 * Inspects ChatGPT Web DOM headers, buttons, and metadata to identify the
 * active model and resolves context-window limits based on the actual model + ChatGPT plan tier.
 * 
 * Features:
 * - Model + Plan-aware context limit lookup
 * - Versioned, refreshable limits configuration (avoids frozen hardcoded datasets)
 * - Strict distinction: ChatGPT product context limit vs OpenAI Developer API limit
 * - Safe fallback: unknown limit -> contextWindow = null, utilization = UNKNOWN
 * - Zero guessing / zero fabrication
 */

import { normalizePlanTier, PlanTier } from './plan-detector.js';

export class ModelDetector {
  /**
   * @param {Object} modelLimitsDatabase Parsed content of config/model-limits.json
   */
  constructor(modelLimitsDatabase = {}) {
    this._loadConfig(modelLimitsDatabase);
  }

  /**
   * Internal configuration loader and validator.
   * @private
   */
  _loadConfig(database = {}) {
    this.version = database.version || '1.0.0';
    this.lastUpdated = database.lastUpdated || null;
    this.metadata = database.metadata || {};
    this.models = database.models || {};
    this.plans = database.plans || {};
    this.productDisclaimers = database.productDisclaimers || {};
    this.fallback = database.productDisclaimers?.unknownModelFallback || {
      displayName: 'Unknown Model',
      encoding: 'o200k_base',
      apiContextLimit: null,
      contextWindow: null,
      maxOutput: null,
      source: 'Unrecognized model'
    };
  }

  /**
   * Refreshes the active limits configuration dynamically.
   * Validates schema and versioning to prevent corrupted overrides.
   * 
   * @param {Object} newDatabase 
   * @returns {{ success: boolean, version?: string, error?: string }}
   */
  refreshConfig(newDatabase) {
    if (!newDatabase || typeof newDatabase !== 'object') {
      return { success: false, error: 'Config must be an object' };
    }
    if (!newDatabase.models || typeof newDatabase.models !== 'object') {
      return { success: false, error: 'Config missing required "models" dictionary' };
    }

    this._loadConfig(newDatabase);
    return {
      success: true,
      version: this.version,
      lastUpdated: this.lastUpdated
    };
  }

  /**
   * Returns active dataset version.
   * @returns {string}
   */
  getConfigVersion() {
    return this.version;
  }

  /**
   * Returns active dataset last updated date.
   * @returns {string|null}
   */
  getLastUpdated() {
    return this.lastUpdated;
  }

  /**
   * Resolves context limit specifically for a given model ID and plan tier.
   * Strictly distinguishes between OpenAI API limit and ChatGPT Product limit.
   * 
   * @param {string} modelId 
   * @param {string|null} planTier 
   * @returns {{
   *   contextWindow: number|null,
   *   apiContextLimit: number|null,
   *   status: 'VERIFIED'|'UNVERIFIED'|'UNKNOWN'|'API_DEFAULT',
   *   source: string,
   *   planTier: string,
   *   modelId: string,
   *   lastVerified: string|null
   * }}
   */
  resolveLimit(modelId, planTier = null) {
    const normModel = (modelId || '').toLowerCase().trim();
    const normPlan = planTier ? normalizePlanTier(planTier) : PlanTier.UNKNOWN;

    // Lookup model in database
    let spec = this.models[normModel];
    if (!spec) {
      // Check aliases
      for (const [id, s] of Object.entries(this.models)) {
        if (s.aliases && s.aliases.includes(normModel)) {
          spec = s;
          break;
        }
      }
    }

    if (!spec) {
      return {
        contextWindow: null,
        apiContextLimit: null,
        status: 'UNKNOWN',
        source: 'Unrecognized model',
        planTier: normPlan,
        modelId: normModel || 'unknown',
        lastVerified: null
      };
    }

    const apiContextLimit = spec.apiContextLimit ?? spec.contextWindow ?? null;

    // If plan tier is unknown, the ChatGPT product limit cannot be determined
    // Rule: Never substitute the API context limit for an unknown product limit!
    if (normPlan === PlanTier.UNKNOWN || !normPlan) {
      return {
        contextWindow: null,
        apiContextLimit,
        status: 'UNKNOWN',
        source: 'ChatGPT plan tier unknown; product context window cannot be verified',
        planTier: PlanTier.UNKNOWN,
        modelId: spec.id || normModel,
        lastVerified: null
      };
    }

    // Lookup explicit plan tier in productLimits
    const planSpec = spec.productLimits?.[normPlan];
    if (planSpec) {
      return {
        contextWindow: planSpec.contextWindow ?? null,
        apiContextLimit,
        status: planSpec.status || (planSpec.contextWindow ? 'VERIFIED' : 'UNKNOWN'),
        source: planSpec.source || 'OpenAI verified product documentation',
        planTier: normPlan,
        modelId: spec.id || normModel,
        lastVerified: planSpec.lastVerified || null,
        notes: planSpec.notes || null
      };
    }

    // Plan tier is recognized but model has no verified limit for this tier
    return {
      contextWindow: null,
      apiContextLimit,
      status: 'UNKNOWN',
      source: `Model ${spec.displayName || normModel} has no verified context limit for plan ${normPlan}`,
      planTier: normPlan,
      modelId: spec.id || normModel,
      lastVerified: null
    };
  }

  /**
   * Scans DOM for visible model text indicators.
   * @param {Document|HTMLElement} root 
   * @returns {string|null} Raw detected model name
   */
  detectRawModelString(root = document) {
    if (!root) return null;

    const candidateSelectors = [
      "button[data-testid='model-switcher-dropdown']",
      "button[aria-haspopup='menu'][data-testid*='model']",
      "header button[class*='text-token-text-primary']",
      "header div[class*='font-semibold']",
      "[data-testid='model-selector']",
      "button.text-token-text-secondary"
    ];

    // 1. Real slug stamped on assistant messages; the last one is the model currently in use
    const slugEls = root.querySelectorAll("[data-message-model-slug]");
    for (let i = slugEls.length - 1; i >= 0; i--) {
      const slug = slugEls[i].getAttribute('data-message-model-slug');
      if (slug && slug !== 'user') return slug;
    }

    // 2. Header / switcher text, only when it actually looks like a model name
    //    (buttons like "Share" or "Think" used to be returned as the model)
    const looksLikeModel = (t) => /\b(gpt[-\s]?\d|o\d\b|\d(\.\d+)?\s*(instant|thinking|pro|mini)?\b|4o)/i.test(t);
    for (let i = 0; i < candidateSelectors.length; i++) {
      const el = root.querySelector(candidateSelectors[i]);
      if (el) {
        const text = (el.innerText || el.textContent || '').trim();
        if (text && !text.includes('ChatGPT') && text.length < 50 && looksLikeModel(text)) {
          return text;
        }
        // "ChatGPT 5.6 Thinking" -> "5.6 Thinking" (keep the mode word; it decides the limit family)
        const match = text.match(/ChatGPT\s+([^\n]{1,40})/i);
        if (match && looksLikeModel(match[1])) {
          return match[1].trim();
        }
      }
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
   * Resolves raw model string and plan tier against verified model database.
   * 
   * @param {string|null} rawModelString 
   * @param {string|null} [rawPlanString=null]
   * @returns {Object} Model specification with context limits
   */
  resolveModel(rawModelString, rawPlanString = null) {
    if (!rawModelString) {
      return {
        id: 'unknown',
        planTier: rawPlanString ? normalizePlanTier(rawPlanString) : PlanTier.UNKNOWN,
        limitStatus: 'UNKNOWN',
        ...this.fallback
      };
    }

    const normalized = rawModelString.toLowerCase().trim();

    // 1. Direct key match or alias match
    let matchedId = null;
    let spec = null;

    const entries = Object.entries(this.models);
    if (this.models[normalized]) {
      matchedId = normalized;
      spec = this.models[normalized];
    } else {
      // Exact alias, then family regex patterns (current ChatGPT slugs change too often to list),
      // then longest key contained in the string so "gpt-4o-mini-x" never resolves to "gpt-4o"
      const found =
        entries.find(([, s]) => s.aliases && s.aliases.includes(normalized)) ||
        entries.find(([, s]) => Array.isArray(s.patterns) && s.patterns.some(p => new RegExp(p, 'i').test(normalized))) ||
        entries
          .filter(([modelId]) => normalized.includes(modelId))
          .sort((a, b) => b[0].length - a[0].length)[0];
      if (found) {
        [matchedId, spec] = found;
      }
    }

    // 2. Unrecognized model fallback
    if (!spec) {
      const planTier = rawPlanString ? normalizePlanTier(rawPlanString) : PlanTier.UNKNOWN;
      return {
        id: normalized,
        displayName: rawModelString,
        encoding: this.fallback.encoding || 'o200k_base',
        apiContextLimit: null,
        contextWindow: null,
        maxOutput: null,
        planTier,
        limitStatus: 'UNKNOWN',
        source: 'Unrecognized custom model or preview',
        lastVerified: null
      };
    }

    const apiContextLimit = spec.apiContextLimit ?? spec.contextWindow ?? null;

    // Families cover many live slugs; keep the real slug visible next to the family label
    const displayName = spec.family ? `${rawModelString.trim()} (${spec.displayName})` : spec.displayName;

    // 3. Resolve context window limit
    // If rawPlanString was explicitly provided:
    if (rawPlanString !== null && rawPlanString !== undefined) {
      const limitResult = this.resolveLimit(matchedId, rawPlanString);
      return {
        id: matchedId,
        displayName,
        aliases: spec.aliases || [],
        encoding: spec.encoding || 'o200k_base',
        apiContextLimit,
        contextWindow: limitResult.contextWindow,
        maxOutput: spec.maxOutput || null,
        planTier: limitResult.planTier,
        limitStatus: limitResult.status,
        limitSource: limitResult.source,
        source: limitResult.source,
        lastVerified: limitResult.lastVerified
      };
    }

    // 4. Backward compatibility when no plan argument is passed:
    // Retains underlying model API context window for callers without plan context
    return {
      id: matchedId,
      displayName,
      aliases: spec.aliases || [],
      encoding: spec.encoding || 'o200k_base',
      apiContextLimit,
      contextWindow: spec.contextWindow ?? apiContextLimit,
      maxOutput: spec.maxOutput || null,
      planTier: PlanTier.UNKNOWN,
      limitStatus: 'API_DEFAULT',
      limitSource: spec.apiSource || spec.source,
      source: spec.apiSource || spec.source,
      lastVerified: spec.apiLastVerified || spec.lastVerified || null
    };
  }

  /**
   * Runs complete detection from DOM root.
   * @param {Document|HTMLElement} root 
   * @param {string|null} [planString=null]
   * @returns {Object}
   */
  detect(root = document, planString = null) {
    const raw = this.detectRawModelString(root);
    return this.resolveModel(raw, planString);
  }
}
