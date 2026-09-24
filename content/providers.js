/**
 * Context Monitor - Provider adapters for Claude (claude.ai) and Gemini (gemini.google.com)
 *
 * Each adapter only knows its site: how to find the conversation id, read turns from the page,
 * read the model and plan, and which context window applies. Everything else (tokenizer, evidence,
 * confidence, widget) is the shared engine in provider-coordinator.js.
 *
 * Context windows come only from the providers' own published pages; anything not published stays
 * UNKNOWN. Neither provider publishes the tokenizer its chat app uses, so counts are ESTIMATED with
 * the o200k BPE tokenizer and confidence can never be HIGH for these sites.
 */

// element -> { raw, text }: cleaning clones the node, so unchanged elements reuse the last result
const textCache = new WeakMap();
// Set while a MutationObserver reports every page change through invalidateText(): cached text is
// then trusted without re-reading the element.
const textTrust = { enabled: false };

/** Page change at `node`: drop cached text of every element containing it. */
export function invalidateText(node) {
  for (let el = node && (node.nodeType === 1 ? node : node.parentElement); el; el = el.parentElement) textCache.delete(el);
}

/** Trust cached text while mutations are being reported (see invalidateText). */
export function trustTextCache(enabled) {
  textTrust.enabled = Boolean(enabled);
}

/**
 * Visible text of a message element without UI chrome (buttons, screen-reader labels, thinking).
 * @param {Element} el
 * @param {string} removeSelector
 * @returns {string}
 */
export function cleanText(el, removeSelector) {
  if (!el) return '';
  if (textTrust.enabled) {
    const trusted = textCache.get(el);
    if (trusted) return trusted.text;
  }
  const count = typeof el.getElementsByTagName === 'function' ? el.getElementsByTagName('*').length : -1;
  const raw = `${count}|${el.textContent || ''}`;
  const hit = textCache.get(el);
  if (hit && hit.raw === raw) return hit.text;
  let text;
  if (typeof el.cloneNode === 'function') {
    const clone = el.cloneNode(true);
    if (removeSelector && clone.querySelectorAll) clone.querySelectorAll(removeSelector).forEach(n => n.remove());
    text = (clone.innerText || clone.textContent || '').trim();
  } else {
    text = (el.innerText || el.textContent || '').trim();
  }
  textCache.set(el, { raw, text });
  return text;
}

/** Keeps only matches that are not inside another match (a turn wrapper can contain the message). */
function topLevel(nodes) {
  const set = new Set(nodes);
  return nodes.filter(n => {
    for (let p = n.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
    return true;
  });
}

// ============================================================================ Claude

// support.claude.com/en/articles/8606394 (checked 2026-09-24): chatting on paid plans (Pro, Max,
// Team, Enterprise) is 200K, except these models at 1M. The Free plan is not published.
const CLAUDE_LIMIT_SOURCE = 'Claude Help Center: context window on paid plans (support.claude.com/en/articles/8606394)';
const CLAUDE_1M_MODELS = new Set(['fable-5.1', 'opus-5.5', 'sonnet-5']);
const CLAUDE_PAID_PLANS = new Set(['pro', 'max', 'team', 'enterprise']);

/**
 * "claude-opus-5-5", "Opus 5.5", "claude-sonnet-4-5-20250929", "claude-3-5-sonnet-20241022" -> "opus-5.5",
 * "opus-5.5", "sonnet-4.5", "sonnet-3.5". null when no Claude family/version is present.
 * @param {string} value
 * @returns {string|null}
 */
export function claudeModelKey(value) {
  const s = String(value || '').toLowerCase();
  // Versions are 1-2 digits, so a date suffix ("sonnet-20241022") is never read as a version
  let m = s.match(/\b(opus|sonnet|haiku|fable)[\s-]*(\d{1,2})(?:[.-](\d{1,2}))?(?!\d)/);
  if (!m) {
    const old = s.match(/claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku)/);
    if (!old) return null;
    m = [null, old[3], old[1], old[2]];
  }
  const minor = m[3] && m[3] !== '0' ? `.${m[3]}` : '';
  return `${m[1]}-${m[2]}${minor}`;
}

export const ClaudeProvider = {
  name: 'Claude',
  hosts: ['claude.ai'],
  inputSelector: 'div.ProseMirror[contenteditable="true"], [data-testid="chat-input"], fieldset [contenteditable="true"]',
  hasApi: true,

  conversationId(url) {
    const m = String(url || '').match(/\/chat\/([0-9a-f-]{36})/i);
    return m ? m[1] : null;
  },

  findInput(doc) {
    return doc.querySelector(this.inputSelector);
  },

  extractMessages(doc) {
    const nodes = topLevel(Array.from(doc.querySelectorAll('[data-testid="user-message"], .font-claude-response, .font-claude-message')));
    return nodes.map((el, i) => {
      const role = el.matches && el.matches('[data-testid="user-message"]') ? 'user' : 'assistant';
      const text = cleanText(el, 'button, .sr-only, [aria-hidden="true"]');
      return { id: `claude-dom-${i}-${role}`, role, text, parts: [{ type: 'text', text }], isStreaming: Boolean(el.closest && el.closest('[data-is-streaming="true"]')) };
    }).filter(m => m.text);
  },

  detectModel(doc) {
    const el = doc.querySelector('[data-testid="model-selector-dropdown"]');
    const text = el ? (el.textContent || '').trim() : '';
    return text && claudeModelKey(text) ? text : null;
  },

  detectPlan(doc) {
    const el = doc.querySelector('[data-testid="user-menu-button"]');
    const m = el ? (el.textContent || '').match(/\b(Free|Pro|Max|Team|Enterprise)\s+plan\b/i) : null;
    return m ? { value: m[1].toLowerCase(), source: 'dom', evidenceType: 'OBSERVED' } : null;
  },

  modelKey: claudeModelKey,

  displayName(raw) {
    const key = claudeModelKey(raw);
    if (!key) return raw || null;
    const [family, version] = key.split('-');
    return `Claude ${family.charAt(0).toUpperCase()}${family.slice(1)} ${version}`;
  },

  /**
   * @returns {{ contextWindow: number|null, status: string, source: string, recognized: boolean }}
   */
  resolveLimit(rawModel, plan) {
    const key = claudeModelKey(rawModel);
    if (!key) return { contextWindow: null, status: 'UNKNOWN', source: 'Model not recognized', recognized: false };
    if (!plan || plan === 'unknown') return { contextWindow: null, status: 'UNKNOWN', source: 'Plan unknown', recognized: true };
    if (!CLAUDE_PAID_PLANS.has(plan)) return { contextWindow: null, status: 'UNKNOWN', source: `No published context window for the ${plan} plan`, recognized: true };
    return { contextWindow: CLAUDE_1M_MODELS.has(key) ? 1000000 : 200000, status: 'VERIFIED', source: CLAUDE_LIMIT_SOURCE, recognized: true };
  },

  /** Organization id: the lastActiveOrg cookie, else the first organization of the account. */
  async _orgId(fetchJson) {
    const m = (typeof document !== 'undefined' ? document.cookie : '').match(/(?:^|;\s*)lastActiveOrg=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
    const orgs = await fetchJson('/api/organizations');
    return Array.isArray(orgs) && orgs[0]?.uuid ? orgs[0].uuid : null;
  },

  /**
   * Reads the saved conversation (claude.ai's own same-origin API, cookie-authenticated) and the
   * account plan. Returns null when unavailable; the page is then read instead.
   */
  async fetchConversation(conversationId, fetchJson) {
    const org = await this._orgId(fetchJson);
    if (!org) return null;
    const [conv, orgInfo] = await Promise.all([
      fetchJson(`/api/organizations/${org}/chat_conversations/${conversationId}?tree=True&rendering_mode=messages&render_all_tools=true`),
      fetchJson(`/api/organizations/${org}`).catch(() => null)
    ]);
    return { ...this.normalizeConversation(conv), plan: this.planFromOrganization(orgInfo) };
  },

  /** capabilities: claude_max / claude_pro / raven (Team or Enterprise); only "chat" -> free (inferred). */
  planFromOrganization(org) {
    const caps = Array.isArray(org?.capabilities) ? org.capabilities : null;
    if (!caps) return null;
    if (caps.includes('claude_max')) return { value: 'max', evidenceType: 'OBSERVED' };
    if (caps.includes('claude_pro')) return { value: 'pro', evidenceType: 'OBSERVED' };
    if (caps.includes('raven')) return { value: org.raven_type === 'enterprise' ? 'enterprise' : 'team', evidenceType: 'OBSERVED' };
    return { value: 'free', evidenceType: 'ESTIMATED' }; // No paid capability listed
  },

  /**
   * Active branch (current_leaf_message_uuid -> parents) of a claude.ai conversation, as turns.
   * Tool calls and results are counted as "tool"; earlier thinking is not resent, so it is skipped;
   * text extracted from attached files is part of the prompt and counted with the user turn.
   */
  normalizeConversation(conv) {
    const all = Array.isArray(conv?.chat_messages) ? conv.chat_messages : [];
    const byId = new Map(all.map(m => [m.uuid, m]));
    let chain = [];
    if (conv?.current_leaf_message_uuid && byId.has(conv.current_leaf_message_uuid)) {
      const seen = new Set();
      for (let m = byId.get(conv.current_leaf_message_uuid); m && !seen.has(m.uuid); m = byId.get(m.parent_message_uuid)) {
        seen.add(m.uuid);
        chain.unshift(m);
      }
    } else {
      chain = [...all].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    }

    const messages = [];
    let files = 0;
    let unknownFiles = 0;
    for (const m of chain) {
      const role = m.sender === 'human' ? 'user' : 'assistant';
      const text = [];
      const tool = [];
      if (Array.isArray(m.content) && m.content.length > 0) {
        for (const block of m.content) {
          if (block.type === 'text' && block.text) text.push(block.text);
          else if (block.type === 'tool_use') tool.push(JSON.stringify(block.input ?? {}));
          else if (block.type === 'tool_result') {
            const c = Array.isArray(block.content) ? block.content.map(x => x.text || '').join('\n') : String(block.content ?? '');
            if (c) tool.push(c);
          }
        }
      } else if (m.text) {
        text.push(m.text);
      }
      for (const a of m.attachments || []) {
        files++;
        if (a.extracted_content) text.push(a.extracted_content);
        else unknownFiles++;
      }
      for (const f of [...(m.files || []), ...(m.files_v2 || [])]) {
        files++;
        unknownFiles++;
      }
      if (text.length) messages.push({ id: m.uuid, role, text: text.join('\n\n'), parts: [{ type: 'text', text: text.join('\n\n') }], isStreaming: false });
      if (tool.length) messages.push({ id: `${m.uuid}-tool`, role: 'tool', text: tool.join('\n\n'), parts: [{ type: 'text', text: tool.join('\n\n') }], isStreaming: false });
    }
    return {
      conversationId: conv?.uuid || null,
      model: conv?.model || null,
      messages,
      visibleTurns: chain.length,
      attachments: { count: files, estimatedTokens: 0, hasUnknown: unknownFiles > 0 }
    };
  }
};

// ============================================================================ Gemini

// support.google.com/gemini/answer/16275805 (checked 2026-09-24): the context window depends on the
// plan, not the model: no AI plan 32K, Google AI Plus 128K, Google AI Pro and Ultra 1M.
const GEMINI_LIMIT_SOURCE = 'Gemini Apps Help: limits by plan (support.google.com/gemini/answer/16275805)';
const GEMINI_LIMITS = { free: 32000, plus: 128000, pro: 1000000, ultra: 1000000 };

export const GeminiProvider = {
  name: 'Gemini',
  hosts: ['gemini.google.com'],
  inputSelector: 'rich-textarea [contenteditable="true"], .ql-editor[contenteditable="true"]',
  hasApi: false,
  // Gemini loads older turns as you scroll up, so a saved chat read from the page may be incomplete
  pageMayBePartial: true,

  conversationId(url) {
    const m = String(url || '').match(/\/app\/([0-9a-f]{8,})/i) || String(url || '').match(/\/gem\/[^/]+\/([0-9a-f]{8,})/i);
    return m ? m[1] : null;
  },

  findInput(doc) {
    return doc.querySelector(this.inputSelector);
  },

  extractMessages(doc) {
    const nodes = Array.from(doc.querySelectorAll('user-query, model-response'));
    return nodes.map((el, i) => {
      const role = String(el.tagName).toLowerCase() === 'user-query' ? 'user' : 'assistant';
      const content = role === 'user'
        ? (el.querySelector('.query-text') || el)
        : (el.querySelector('message-content') || el.querySelector('.model-response-text') || el);
      const text = cleanText(content, 'button, .cdk-visually-hidden, .screen-reader-only, model-thoughts, mat-icon');
      return { id: `gemini-dom-${i}-${role}`, role, text, parts: [{ type: 'text', text }], isStreaming: false };
    }).filter(m => m.text);
  },

  detectModel(doc) {
    const el = doc.querySelector('[data-test-id="bard-mode-menu-button"], [data-test-id*="mode-menu"] button, button.gds-mode-switch-button');
    const text = el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
    return text && text.length < 40 ? text : null;
  },

  /** Explicit "Google AI Pro/Ultra/Plus" text is OBSERVED; a bare PRO/ULTRA badge is only a hint. */
  detectPlan(doc) {
    for (const el of doc.querySelectorAll('header, top-bar-actions, [data-test-id*="pillbox"], .gds-pillbox, [role="banner"]')) {
      const text = el.textContent || '';
      const named = text.match(/Google AI (Ultra|Pro|Plus)\b/);
      if (named) return { value: named[1].toLowerCase(), source: 'dom', evidenceType: 'OBSERVED' };
      const badge = text.match(/\b(ULTRA|PRO|PLUS)\b/);
      if (badge) return { value: badge[1].toLowerCase(), source: 'dom_heuristic', evidenceType: 'ESTIMATED' };
    }
    return null;
  },

  modelKey: (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim() || null,

  displayName(raw) {
    return raw ? (/gemini/i.test(raw) ? raw : `Gemini · ${raw}`) : null;
  },

  resolveLimit(rawModel, plan) {
    if (!plan || plan === 'unknown' || !(plan in GEMINI_LIMITS)) {
      return { contextWindow: null, status: 'UNKNOWN', source: 'Plan unknown', recognized: Boolean(rawModel) };
    }
    // Google publishes the window per plan for every model, so the model is not needed for the limit
    return { contextWindow: GEMINI_LIMITS[plan], status: 'VERIFIED', source: GEMINI_LIMIT_SOURCE, recognized: true };
  }
};

export const PROVIDERS = [ClaudeProvider, GeminiProvider];

/** Adapter for a hostname, or null (ChatGPT uses its own coordinator). */
export function providerForHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return PROVIDERS.find(p => p.hosts.some(h => host === h || host.endsWith(`.${h}`))) || null;
}
