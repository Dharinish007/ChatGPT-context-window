/**
 * ChatGPT Context Monitor - Confidence Engine (Group E Redesign)
 * 
 * Computes an honest, explainable, evidence-grounded measurement confidence score.
 * Evaluates the quality, completeness, and agreement of observable data sources.
 * 
 * Non-negotiable principles:
 * - Reflects MEASUREMENT confidence (accuracy of observable tokens), NOT hidden server state.
 * - Distinguishes Observable Context Confidence vs Complete Server Context.
 * - Explains all positive (+) and negative (-) confidence drivers.
 * - Dynamically reacts to source conflicts, virtualization, tool overhead, and network health.
 */

export const ConfidenceLevel = Object.freeze({
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW'
});

export class ConfidenceEngine {
  /**
   * Evaluates context measurement confidence based on observable evidence quality.
   * 
   * @param {Object} params
   * @param {boolean} [params.isAuthoritative=false] - True if exact API usage tokens provided
   * @param {boolean} [params.isModelKnown=true] - True if model context window is verified
   * @param {string} [params.modelDisplayName] - Resolved model name
   * @param {number} [params.messageCount=0] - Number of observable turns
   * @param {number} [params.attachmentCount=0] - Number of attachments
   * @param {boolean} [params.hasUnknownAttachments=false] - True if non-text files are present
   * @param {boolean} [params.hasObservedTools=false] - True if search/python/tools were executed
   * @param {boolean} [params.isPartialConversation=false] - True if DOM view is virtualized/partial
   * @param {string} [params.completenessSource='dom_complete'] - Source of completeness data
   * @param {boolean} [params.isNetworkActive=false] - True if network interception is operational
   * @param {string} [params.encoding='o200k_base'] - BPE tokenizer encoding
   * @param {Array<Object>} [params.conflicts=[]] - Conflicting evidence between sources
   * @returns {{
   *   level: string,
   *   score: number,
   *   percentage: number,
   *   reasons: string[],
   *   factors: Array<{ type: 'positive' | 'negative', text: string }>,
   *   observableConfidence: Object,
   *   serverContextCompleteness: Object
   * }}
   */
  static evaluate(params = {}) {
    const {
      isAuthoritative = false,
      isModelKnown = true,
      isLimitVerified = true,
      planTier,
      isPlanKnown,
      contextLimit = null,
      modelDisplayName = '',
      messageCount = 0,
      attachmentCount = 0,
      hasUnknownAttachments = false,
      hasObservedTools = false,
      isPartialConversation = false,
      completenessSource = 'dom_complete',
      isNetworkActive = false,
      encoding = 'o200k_base',
      conflicts = [],
      agreements // Fields confirmed by 2+ independent sources; undefined = legacy callers
    } = params;

    // 1. Authoritative exact system metadata (100% confidence)
    if (isAuthoritative) {
      return {
        level: ConfidenceLevel.HIGH,
        score: 1.0,
        percentage: 100,
        reasons: ['Authoritative usage metadata provided directly by system'],
        factors: [
          { type: 'positive', text: 'Authoritative exact usage metadata provided directly by system' },
          { type: 'positive', text: `Verified model context limits (${modelDisplayName || 'Verified Model'})` }
        ],
        observableConfidence: {
          level: ConfidenceLevel.HIGH,
          score: 1.0,
          percentage: 100
        },
        serverContextCompleteness: {
          status: 'EXACT_USAGE',
          isLowerBound: false,
          limitations: []
        }
      };
    }

    // 2. Client-side Observable Evidence Evaluation
    let score = 0.83; // Base score for verified client-side observation
    const factors = [];

    // --- Factor A: Conversation Completeness & Ground Truth Source ---
    if (completenessSource === 'authoritative_api') {
      score += 0.10;
      factors.push({ type: 'positive', text: 'Full authoritative conversation' });
    } else if (completenessSource === 'in_flight_stream') {
      score += 0.08;
      factors.push({ type: 'positive', text: 'Authoritative base with live streaming turn' });
    } else if (completenessSource === 'dom_complete') {
      score += 0.05;
      factors.push({ type: 'positive', text: 'Complete active session turn tree in DOM' });
    }

    if (isPartialConversation) {
      score -= 0.25;
      factors.push({ type: 'negative', text: 'Conversation is partially loaded / virtualized in DOM; count is lower bound' });
    }

    // --- Ground Truth Source Availability (Fallback Mode) ---
    if (completenessSource !== 'authoritative_api' && completenessSource !== 'in_flight_stream') {
      score -= 0.10;
      factors.push({ type: 'negative', text: 'Authoritative conversation API unavailable; relying on DOM observation' });
    }

    // --- Factor B: Tokenization Reliability ---
    factors.push({ type: 'positive', text: 'Exact tokenizer' });

    // --- Factor C: Network Interception ---
    if (isNetworkActive) {
      score += 0.02;
      factors.push({ type: 'positive', text: 'Network active' });
    } else if (completenessSource !== 'authoritative_api') {
      score -= 0.04;
      factors.push({ type: 'negative', text: 'Network interception unavailable' });
    }

    // --- Factor D: Multi-Source Agreement vs Disagreements ---
    if (conflicts && conflicts.length > 0) {
      const conflictPenalty = Math.min(0.20, conflicts.length * 0.08);
      score -= conflictPenalty;
      for (const c of conflicts) {
        factors.push({
          type: 'negative',
          text: `Source conflict on ${c.field}: ${c.winning.source} (${c.winning.value}) vs ${c.discarded.source} (${c.discarded.value})`
        });
      }
    } else if (Array.isArray(agreements)) {
      // Credit agreement only where sources were actually compared and matched
      if (agreements.length > 0) {
        score += 0.05;
        factors.push({ type: 'positive', text: `Sources agree on ${agreements.join(', ')}` });
      }
    } else if (completenessSource === 'authoritative_api' || (isNetworkActive && completenessSource === 'dom_complete')) {
      score += 0.05;
      factors.push({ type: 'positive', text: 'DOM/API agreement' });
    }
    const hadAgreementBonus = factors.some(f => f.text === 'DOM/API agreement' || f.text.startsWith('Sources agree on'));

    // --- Factor E: Model Identity & Limits Verification (Group F) ---
    if (isModelKnown) {
      if (!hadAgreementBonus) {
        score += 0.05;
      }

      if (planTier !== undefined) {
        const effectivePlanKnown = isPlanKnown !== undefined ? isPlanKnown : (planTier !== 'unknown' && Boolean(planTier));
        if (!effectivePlanKnown || planTier === 'unknown') {
          score -= 0.15;
          factors.push({ type: 'negative', text: 'ChatGPT plan tier unknown; context window limit cannot be verified' });
        } else if (effectivePlanKnown && !isLimitVerified) {
          score -= 0.10;
          factors.push({ type: 'negative', text: `Context limit for plan ${planTier} is unverified by OpenAI documentation` });
        } else if (effectivePlanKnown && isLimitVerified) {
          factors.push({ type: 'positive', text: `Verified ${planTier.toUpperCase()} plan context limit` });
        }
      }
    } else {
      score -= 0.40;
      factors.push({ type: 'negative', text: 'Model not recognized or context window limit unknown' });
    }

    // --- Factor F: Attachments Knowledge ---
    if (hasUnknownAttachments && attachmentCount > 0) {
      score -= 0.15;
      factors.push({ type: 'negative', text: `${attachmentCount} attachment(s) processed internally without observable token size` });
    } else if (attachmentCount > 0) {
      factors.push({ type: 'positive', text: 'Attachments observed with vision token calibration' });
    }

    // --- Factor G: Tool / Search Execution ---
    if (hasObservedTools) {
      score -= 0.04;
      factors.push({ type: 'negative', text: 'Tool internal overhead unknown' });
    }

    // --- Factor H: Empty Conversation Detection ---
    if (messageCount === 0) {
      score = Math.min(score, 0.50);
      factors.push({ type: 'negative', text: 'No conversation messages currently detected in DOM' });
    }

    // Bound final score between 0.10 and 1.00
    const finalScore = Math.max(0.10, Math.min(1.0, Number(score.toFixed(2))));
    const percentage = Math.round(finalScore * 100);

    // Categorical classification
    let level;
    if (finalScore >= 0.75) {
      level = ConfidenceLevel.HIGH;
    } else if (finalScore >= 0.50) {
      level = ConfidenceLevel.MEDIUM;
    } else {
      level = ConfidenceLevel.LOW;
    }

    // Traditional reasons format for backward compatibility
    const reasons = factors.map(f => (f.type === 'positive' ? `+ ${f.text}` : `- ${f.text}`));

    return {
      level,
      score: finalScore,
      percentage,
      reasons,
      factors,
      observableConfidence: {
        level,
        score: finalScore,
        percentage
      },
      serverContextCompleteness: {
        status: isPartialConversation ? 'LOWER_BOUND' : 'PARTIAL_OBSERVABILITY',
        isLowerBound: Boolean(isPartialConversation),
        limitations: [
          'Server-side system instructions and developer prompts are not exposed in client responses.',
          'RAG / memory embeddings vector retrieval overhead remains unobservable from the client.',
          'Exact internal tool schemas injected by OpenAI remain classified as UNKNOWN.'
        ]
      }
    };
  }
}
