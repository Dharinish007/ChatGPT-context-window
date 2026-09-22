/**
 * ChatGPT Context Monitor - Evidence Merger & Reconciliation Layer
 * 
 * Reconciles multi-source observations across Authoritative API, Network, DOM,
 * and local inference. Strictly enforces source precedence and records disagreements
 * rather than silently discarding conflicting evidence.
 * 
 * Precedence Order:
 * Authoritative API (conversation_api) > Network (network) > DOM (dom) > Local Inference (tokenizer/model_db/heuristic)
 */

export const EvidenceType = Object.freeze({
  EXACT: 'EXACT',
  OBSERVED: 'OBSERVED',
  ESTIMATED: 'ESTIMATED',
  UNKNOWN: 'UNKNOWN'
});

export const SourcePriority = Object.freeze({
  conversation_api: 4,
  authoritative_api: 4,
  authoritative: 4,
  network: 3,
  dom: 2,
  dom_complete: 2,
  dom_partial: 2,
  model_db: 1,
  tokenizer: 1,
  heuristic: 1,
  unknown: 0
});

export class EvidenceMerger {
  /**
   * Reconciles multiple observations for a single property based on source priority.
   * Detects disagreements and tracks winning vs discarded evidence.
   * 
   * @param {string} fieldName - Property name being reconciled
   * @param {Array<{ value: any, source: string, evidenceType: string }>} candidates
   * @returns {{
   *   winner: { value: any, source: string, evidenceType: string }|null,
   *   conflicts: Array<{ field: string, winning: Object, discarded: Object, reason: string }>,
   *   hasConflict: boolean
   * }}
   */
  static reconcileField(fieldName, candidates = []) {
    const validCandidates = candidates.filter(c => 
      c && 
      c.value !== null && 
      c.value !== undefined && 
      c.value !== 'unknown' && 
      c.value !== ''
    );
    if (validCandidates.length === 0) {
      return {
        winner: {
          value: null,
          source: 'unknown',
          evidenceType: EvidenceType.UNKNOWN
        },
        conflicts: [],
        hasConflict: false
      };
    }

    // Sort candidates by SourcePriority descending
    validCandidates.sort((a, b) => {
      const pA = SourcePriority[a.source] ?? 0;
      const pB = SourcePriority[b.source] ?? 0;
      return pB - pA;
    });

    const winner = validCandidates[0];
    const conflicts = [];

    // Check for meaningful disagreements among candidates with priority >= 2
    for (let i = 1; i < validCandidates.length; i++) {
      const other = validCandidates[i];
      const otherPriority = SourcePriority[other.source] ?? 0;
      if (otherPriority < 2) continue; // Ignore low-confidence heuristics

      const isDisagreement = this._isDisagreement(fieldName, winner.value, other.value);
      if (isDisagreement) {
        conflicts.push({
          field: fieldName,
          winning: {
            value: winner.value,
            source: winner.source,
            evidenceType: winner.evidenceType
          },
          discarded: {
            value: other.value,
            source: other.source,
            evidenceType: other.evidenceType
          },
          reason: `Higher priority source (${winner.source}) superseded (${other.source}) with differing value`
        });
      }
    }

    return {
      winner,
      conflicts,
      hasConflict: conflicts.length > 0
    };
  }

  /**
   * Reconciles all observable context domains and returns complete evidence state.
   * 
   * @param {Object} input
   * @param {Array<Object>} [input.modelCandidates]
   * @param {Array<Object>} [input.turnCandidates]
   * @param {Array<Object>} [input.toolCandidates]
   * @param {Array<Object>} [input.attachmentCandidates]
   * @param {Object} [input.completeness]
   * @param {Object} [input.networkHealth]
   * @returns {{
   *   evidence: Object,
   *   conflicts: Array<Object>,
   *   hasConflicts: boolean
   * }}
   */
  static reconcileState(input = {}) {
    const allConflicts = [];

    // 1. Model reconciliation
    const modelResult = this.reconcileField('model', input.modelCandidates || []);
    if (modelResult.hasConflict) {
      allConflicts.push(...modelResult.conflicts);
    }

    // 2. Turns / Messages count reconciliation
    const turnResult = this.reconcileField('turns', input.turnCandidates || []);
    if (turnResult.hasConflict) {
      allConflicts.push(...turnResult.conflicts);
    }

    // 3. Attachments reconciliation
    const attachResult = this.reconcileField('attachments', input.attachmentCandidates || []);
    if (attachResult.hasConflict) {
      allConflicts.push(...attachResult.conflicts);
    }

    // 4. Tools reconciliation
    const toolResult = this.reconcileField('tools', input.toolCandidates || []);
    if (toolResult.hasConflict) {
      allConflicts.push(...toolResult.conflicts);
    }

    const completeness = input.completeness || {};
    const networkHealth = input.networkHealth || {};

    const evidence = {
      model: modelResult.winner,
      turns: turnResult.winner,
      attachments: attachResult.winner,
      tools: toolResult.winner,
      completeness: {
        value: completeness.conversationComplete ? 'COMPLETE' : 'PARTIAL',
        source: completeness.completenessSource || 'dom_complete',
        evidenceType: completeness.completenessSource === 'authoritative_api' ? EvidenceType.EXACT : EvidenceType.OBSERVED,
        domIsPartial: Boolean(completeness.domIsPartial),
        virtualizationGap: completeness.virtualizationGap || 0
      },
      network: {
        value: networkHealth.networkAvailable ? 'AVAILABLE' : 'UNAVAILABLE',
        source: 'network',
        evidenceType: EvidenceType.OBSERVED,
        activeStreams: networkHealth.activeStreamsCount || 0,
        errors: networkHealth.interceptionErrors || 0
      },
      tokens: input.tokens ? {
        user: {
          value: input.tokens.user ?? 0,
          source: input.isAuthoritative ? 'conversation_api' : 'tokenizer',
          evidenceType: input.isAuthoritative ? EvidenceType.EXACT : EvidenceType.ESTIMATED
        },
        assistant: {
          value: input.tokens.assistant ?? 0,
          source: input.isAuthoritative ? 'conversation_api' : 'tokenizer',
          evidenceType: input.isAuthoritative ? EvidenceType.EXACT : EvidenceType.ESTIMATED
        },
        total: {
          value: input.tokens.totalMeasurable ?? input.tokens.conversation ?? 0,
          source: input.isAuthoritative ? 'conversation_api' : 'tokenizer',
          evidenceType: input.isAuthoritative ? EvidenceType.EXACT : EvidenceType.ESTIMATED
        },
        contextWindow: {
          value: input.tokens.contextWindow ?? null,
          source: 'model_db',
          evidenceType: input.tokens.contextWindow ? EvidenceType.EXACT : EvidenceType.UNKNOWN
        }
      } : null,
      serverContext: {
        value: 'UNOBSERVABLE',
        source: 'unknown',
        evidenceType: EvidenceType.UNKNOWN
      },
      conflicts: allConflicts,
      hasConflicts: allConflicts.length > 0
    };

    return {
      evidence,
      conflicts: allConflicts,
      hasConflicts: allConflicts.length > 0
    };
  }

  /**
   * Determines if two values constitute a material disagreement.
   * @private
   */
  static _isDisagreement(field, valA, valB) {
    if (valA === valB) return false;
    if (typeof valA === 'string' && typeof valB === 'string') {
      return valA.trim().toLowerCase() !== valB.trim().toLowerCase();
    }
    if (typeof valA === 'number' && typeof valB === 'number') {
      return valA !== valB;
    }
    return true;
  }
}
