/**
 * Context Monitor - Context Intelligence (health, consumers, growth, advice)
 *
 * Pure function over values the pipeline already measured. It never adds a number for hidden
 * system / memory / tool context: that part is only ever named as "not counted".
 *
 * Health levels follow the same thresholds as the usage bar colours:
 *   HEALTHY  < 50%     MODERATE 50-65%     HIGH 65-85%     CRITICAL >= 85%     UNKNOWN (no known window)
 */

export const HealthLevel = Object.freeze({
  HEALTHY: 'HEALTHY',
  MODERATE: 'MODERATE',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
  UNKNOWN: 'UNKNOWN'
});

export const HEALTH_THRESHOLDS = Object.freeze({ MODERATE: 50, HIGH: 65, CRITICAL: 85 });

const LABELS = { HEALTHY: 'Healthy', MODERATE: 'Moderate', HIGH: 'High', CRITICAL: 'Critical', UNKNOWN: 'Unknown' };
const RECENT_EXCHANGES = 5; // Growth uses the latest exchanges: the current pace, not the chat's average
const fmt = (n) => Math.round(n).toLocaleString('en-US');

/** @param {number|null} percentage */
export function healthLevel(percentage) {
  if (percentage === null || percentage === undefined || Number.isNaN(percentage)) return HealthLevel.UNKNOWN;
  if (percentage >= HEALTH_THRESHOLDS.CRITICAL) return HealthLevel.CRITICAL;
  if (percentage >= HEALTH_THRESHOLDS.HIGH) return HealthLevel.HIGH;
  if (percentage >= HEALTH_THRESHOLDS.MODERATE) return HealthLevel.MODERATE;
  return HealthLevel.HEALTHY;
}

/**
 * Splits the conversation into exchanges: a user message plus every reply / tool turn after it.
 * @param {Array<{ role: string, tokens: number }>} messages
 * @returns {number[]} tokens per exchange, oldest first
 */
export function exchangeSizes(messages) {
  const sizes = [];
  for (const m of messages || []) {
    if (m.role === 'user' || sizes.length === 0) sizes.push(0);
    sizes[sizes.length - 1] += m.tokens || 0;
  }
  return sizes;
}

/**
 * @param {Object} input
 * @param {number|null} input.percentage
 * @param {number} input.usedTokens
 * @param {number|null} input.contextLimit
 * @param {number|null} input.remainingTokens
 * @param {Array<{ role: string, tokens: number, isStreaming?: boolean }>} input.messages Tokenized turns, in order
 * @param {{ count: number, estimatedTokens: number, hasUnknown: boolean }} [input.attachments]
 * @param {boolean} [input.isLowerBound] Turns may be missing (page text only)
 * @param {number|null} [input.sessionStartTokens] Used tokens when this conversation was first measured on this page
 * @returns {Object}
 */
export function analyzeContext(input = {}) {
  const {
    percentage = null, usedTokens = 0, contextLimit = null, remainingTokens = null,
    messages = [], attachments = { count: 0, estimatedTokens: 0, hasUnknown: false },
    isLowerBound = false, sessionStartTokens = null
  } = input;

  const level = healthLevel(contextLimit ? percentage : null);

  // ---- What is consuming the context (measured text, estimated images; unknown parts named only)
  const byRole = { user: 0, assistant: 0, tool: 0 };
  let largest = null;
  messages.forEach((m, i) => {
    const t = m.tokens || 0;
    const role = m.role === 'user' ? 'user' : m.role === 'tool' ? 'tool' : 'assistant';
    byRole[role] += t;
    if (!largest || t > largest.tokens) largest = { index: i + 1, role, tokens: t };
  });
  const share = (t) => (usedTokens > 0 ? Math.round((t / usedTokens) * 100) : 0);
  const consumers = [
    { key: 'assistant', label: 'Replies', tokens: byRole.assistant, share: share(byRole.assistant), evidenceType: 'ESTIMATED' },
    { key: 'user', label: 'Your messages', tokens: byRole.user, share: share(byRole.user), evidenceType: 'ESTIMATED' },
    { key: 'tool', label: 'Tool output', tokens: byRole.tool, share: share(byRole.tool), evidenceType: 'ESTIMATED' },
    { key: 'attachments', label: 'Images (estimated)', tokens: attachments.estimatedTokens || 0, share: share(attachments.estimatedTokens || 0), evidenceType: 'ESTIMATED' }
  ].filter(c => c.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  const largestTurn = largest && largest.tokens > 0 ? { ...largest, share: share(largest.tokens) } : null;

  // ---- Growth: tokens per exchange at the current pace, and exchanges left at that pace
  const sizes = exchangeSizes(messages);
  const recent = sizes.slice(-RECENT_EXCHANGES);
  let growth;
  if (sizes.length < 2) {
    growth = { available: false, reason: 'Needs at least 2 exchanges', exchanges: sizes.length };
  } else {
    const perExchange = recent.reduce((s, x) => s + x, 0) / recent.length;
    growth = {
      available: true,
      evidenceType: 'ESTIMATED',
      exchanges: sizes.length,
      basis: recent.length,
      perExchange: Math.round(perExchange),
      lastExchange: sizes[sizes.length - 1],
      exchangesLeft: remainingTokens !== null && contextLimit && perExchange > 0 ? Math.floor(remainingTokens / perExchange) : null
    };
  }
  const sessionGrowth = sessionStartTokens !== null && sessionStartTokens !== undefined ? Math.max(0, usedTokens - sessionStartTokens) : null;

  // ---- Warnings (most important first)
  const warnings = [];
  if (level === HealthLevel.CRITICAL) {
    warnings.push({ level: 'critical', text: `${Math.round(percentage)}% of the window is used. When it fills, the model starts losing the earliest messages.` });
  } else if (level === HealthLevel.HIGH) {
    warnings.push({ level: 'warn', text: `${Math.round(percentage)}% of the window is used. Plan to wrap up or summarize.` });
  }
  // (The lower-bound case already has its own warning in the widget; the advice below adds the action.)
  if (attachments.hasUnknown && attachments.count > 0) warnings.push({ level: 'info', text: 'Uploaded files are not counted: their token size is not visible.' });
  if (level === HealthLevel.UNKNOWN && usedTokens > 0) warnings.push({ level: 'info', text: 'Context window unknown for this model or plan, so health cannot be judged.' });

  // ---- Advice: one clear action
  const pace = growth.available && growth.exchangesLeft !== null
    ? `about ${fmt(growth.exchangesLeft)} more exchange${growth.exchangesLeft === 1 ? '' : 's'} at the current pace (~${fmt(growth.perExchange)} tokens each)`
    : null;
  const bigTurn = largestTurn && largestTurn.share >= 25 && messages.length > 2
    ? ` The largest single ${largestTurn.role === 'user' ? 'message you sent' : largestTurn.role === 'tool' ? 'tool result' : 'reply'} takes ${largestTurn.share}% (${fmt(largestTurn.tokens)} tokens); avoid repeating large pastes.`
    : '';
  let advice;
  if (level === HealthLevel.CRITICAL) {
    advice = { title: 'Start a new chat soon', text: `Only ${fmt(remainingTokens)} tokens left${pace ? `, ${pace}` : ''}. Ask for a summary of this chat and continue in a new one.${bigTurn}` };
  } else if (level === HealthLevel.HIGH) {
    advice = { title: 'Plan a wrap-up', text: `${pace ? `Room for ${pace}.` : `${fmt(remainingTokens)} tokens left.`} Consider a summary and a fresh chat before it fills.${bigTurn}` };
  } else if (level === HealthLevel.MODERATE) {
    advice = { title: 'Room left', text: `${pace ? `Room for ${pace}.` : `${fmt(remainingTokens)} tokens left.`}${bigTurn}` };
  } else if (level === HealthLevel.HEALTHY) {
    advice = { title: 'Plenty of room', text: pace ? `Room for ${pace}.` : `${fmt(remainingTokens ?? 0)} tokens left.` };
  } else {
    advice = { title: 'Window unknown', text: `${fmt(usedTokens)} tokens counted. Without a known window, remaining room cannot be estimated.` };
  }
  if (isLowerBound) advice.text += ' Press Refresh to read the full conversation.';

  return {
    health: { level, label: LABELS[level], percentage: contextLimit ? percentage : null, isLowerBound: Boolean(isLowerBound) },
    warnings,
    consumers,
    largestTurn,
    growth,
    sessionGrowth,
    advice,
    // Stated, never quantified
    notCounted: 'Hidden instructions, memory and tool definitions are not counted, so the real remaining room is lower.'
  };
}
