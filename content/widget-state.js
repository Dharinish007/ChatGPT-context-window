/**
 * Context Monitor - Widget View State
 *
 * Maps the engine's context state into the provider-neutral shape the widget renders.
 * The widget never reads engine internals; any future provider adapter (Claude, Gemini, ...)
 * only needs to produce this shape. Pure function: formatting only, no recalculation.
 */

/**
 * "gpt-5-6" -> "GPT-5.6", "gpt-5-5-thinking" -> "GPT-5.5 Thinking", "gpt-4o-mini" -> "GPT-4o Mini".
 * Display formatting only; unknown shapes pass through unchanged.
 * @param {string} slug
 * @returns {string}
 */
export function formatModelName(slug) {
  if (!slug || typeof slug !== 'string') return 'Unknown model';
  const m = slug.trim().match(/^gpt-(\d+[a-z]?)(?:[-.](\d+))?(?:-(.+))?$/i);
  if (!m) return slug.trim();
  const version = m[2] ? `${m[1]}.${m[2]}` : m[1];
  const rest = m[3] ? ' ' + m[3].split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : '';
  return `GPT-${version}${rest}`;
}

/**
 * @param {Object} s Context state produced by ContextCalculator + coordinator
 * @param {{ provider?: string }} [opts]
 * @returns {{
 *   provider: string, model: string, modelFamily: string|null, plan: string|null,
 *   usedTokens: number, contextLimit: number|null, remainingTokens: number|null,
 *   percentage: number|null, limitStatus: string, confidence: number, confidenceLevel: string,
 *   evidence: Array<{ ok: boolean, text: string }>, breakdown: Array<{ label: string, value: string, tag?: string }>,
 *   source: string, turns: number, warning: string|null, diagnostics: Object|null, ready: boolean
 * }}
 */
export function toWidgetState(s, opts = {}) {
  const provider = opts.provider || 'AI';
  // No state yet, or a saved conversation whose turns are still loading: never render "0 tokens"
  if (!s || s.observables?.awaitingData) {
    return {
      provider, conversationId: s?.observables?.conversationId || null, model: 'Detecting…', modelFamily: null, plan: null,
      usedTokens: 0, contextLimit: null, remainingTokens: null, percentage: null,
      limitStatus: 'UNKNOWN', confidence: 0, confidenceLevel: 'LOW',
      evidence: [], breakdown: [], source: '', turns: 0, warning: null, diagnostics: s?.diagnostics || null, ready: false
    };
  }

  // Family matches render as "<slug> (<Family>)"; split them back apart for display
  const rawName = s.model?.id !== 'unknown' ? (s.model?.displayName || '') : '';
  const fam = rawName.match(/^(.*)\s\(([^)]+)\)$/);
  const slug = fam ? fam[1] : rawName;
  const modelFamily = fam ? fam[2] : null;
  let model = rawName ? formatModelName(slug) : 'Model unknown';
  if (modelFamily) {
    // "GPT-5.5 Thinking" + family "Thinking" -> "GPT-5.5" · "Thinking"
    model = model.replace(new RegExp(`\\s${modelFamily}$`, 'i'), '');
  }

  const tier = s.plan?.tier && s.plan.tier !== 'unknown' ? s.plan.tier : null;
  const usedTokens = s.tokens?.totalMeasurable ?? 0;
  const contextLimit = s.model?.contextWindow || null;
  const percentage = contextLimit ? (s.utilization?.percentage ?? null) : null;
  const dataSource = s.observables?.dataSource;
  const authoritative = dataSource === 'authoritative';

  const confidence = s.confidence?.percentage ?? Math.round((s.confidence?.score || 0) * 100);

  const isLowerBound = s.completeness?.isLowerBound ?? (!authoritative && Boolean(s.completeness?.domIsPartial));

  return {
    provider,
    conversationId: s.observables?.conversationId || null,
    model,
    modelFamily,
    plan: tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : null,
    usedTokens,
    contextLimit,
    remainingTokens: contextLimit ? Math.max(0, contextLimit - usedTokens) : null,
    percentage,
    limitStatus: contextLimit ? (s.model?.limitStatus === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED') : 'UNKNOWN',
    confidence,
    confidenceLevel: s.confidence?.level || 'LOW',
    evidence: (s.confidence?.factors || []).map(f => ({ ok: f.type === 'positive', text: f.text })),
    breakdown: [
      { label: 'You', value: (s.tokens?.user ?? 0).toLocaleString() },
      { label: `${provider} + tools`, value: (s.tokens?.assistant ?? 0).toLocaleString() },
      {
        label: 'Attachments',
        value: s.observables?.attachmentsCount
          ? `${s.observables.attachmentsCount} · ${(s.tokens?.attachments ?? 0).toLocaleString()} est.`
          : 'None'
      },
      { label: 'Hidden context', value: 'Not measurable', tag: 'UNKNOWN' }
    ],
    source: authoritative ? 'Full conversation (API)' : dataSource === 'dom_fallback' ? 'Page text (API unavailable)' : 'Page text',
    turns: s.observables?.messagesCount ?? 0,
    // usedTokens counts visible conversation text only; true when turns may also be missing
    isLowerBound,
    conflicts: (s.conflicts || []).map(c => ({ field: c.field, winning: c.winning, discarded: c.discarded })),
    // Only warn when the count really depends on what the page has rendered
    warning: s.observables?.apiError
      ? s.observables.apiError
      : (isLowerBound ? 'Count may be low: only turns rendered on the page were read.' : null),
    diagnostics: s.diagnostics || null,
    ready: true
  };
}
