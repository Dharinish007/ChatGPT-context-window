/**
 * ChatGPT Context Monitor - Live Turn Merger
 *
 * Merges in-flight turns (network stream, rendered-but-unsaved DOM turn) into the base message list
 * (authoritative API tree, or DOM fallback) without double counting and without dropping new turns.
 *
 * Identity rules:
 * - ChatGPT assigns every message a UUID that is identical in the request body, the SSE stream,
 *   the conversation API and the DOM (data-message-id). Matching is by that id first.
 * - Text matching is only a fallback when one side has a synthetic id (e.g. "turn-3-user",
 *   "net-usr-..."), and only against the latest message of the same role, so a genuinely
 *   repeated message ("yes", "yes") is never swallowed.
 */

const REAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRealMessageId(id) {
  return typeof id === 'string' && REAL_ID.test(id);
}

/**
 * @param {Array<Object>} base Messages from the API tree or the DOM
 * @param {Array<Object>} candidates Live turns (network turns in arrival order, then a DOM streaming turn)
 * @param {{ conversationId?: string|null, baseIsFinal?: boolean }} [opts]
 *   baseIsFinal: base came from the API, so a finished base message is never overwritten
 * @returns {Array<Object>} New array; inputs are not mutated
 */
export function mergeLiveTurns(base, candidates, opts = {}) {
  const { conversationId = null, baseIsFinal = false } = opts;
  const out = base.map(m => ({ ...m }));

  for (const t of candidates) {
    if (!t || !t.role || t.role === 'system') continue;
    // A turn tagged with another conversation never leaks into this one
    if (conversationId && t.conversationId && t.conversationId !== conversationId) continue;
    const text = t.text || '';

    let idx = t.id ? out.findIndex(m => m.id === t.id) : -1;

    if (idx === -1) {
      // Fallback identity: latest message of the same role, when either id is synthetic
      let lastSameRole = -1;
      for (let i = out.length - 1; i >= 0; i--) {
        if (out[i].role === t.role) { lastSameRole = i; break; }
      }
      const cand = lastSameRole === -1 ? null : out[lastSameRole];
      if (cand && (!isRealMessageId(cand.id) || !isRealMessageId(t.id))) {
        const candText = cand.text || '';
        const sameText = candText === text;
        // A streaming turn and its growing copy share a prefix; only the tail can be streaming
        const sameStream = lastSameRole === out.length - 1 && (cand.isStreaming || t.isStreaming) &&
          (candText.startsWith(text) || text.startsWith(candText));
        if (sameText || sameStream) idx = lastSameRole;
      }
    }

    if (idx === -1) {
      out.push({ ...t, parts: t.parts || [{ type: 'text', text }], text });
      continue;
    }

    const m = out[idx];
    if (baseIsFinal && idx < base.length && !m.isStreaming && !t.isStreaming) {
      continue; // The saved API copy is the truth for a finished message
    }
    const mText = m.text || '';
    const longer = text.length > mText.length ? t : m;
    out[idx] = {
      ...m,
      id: isRealMessageId(m.id) ? m.id : (t.id || m.id),
      text: longer === t ? text : mText,
      parts: longer === t ? (t.parts || [{ type: 'text', text }]) : (m.parts || [{ type: 'text', text: mText }]),
      isStreaming: Boolean(t.isStreaming)
    };
  }

  return out;
}
