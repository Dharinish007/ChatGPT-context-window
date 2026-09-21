/**
 * ChatGPT Context Monitor - Confidence Engine
 * 
 * Computes an honest confidence score (HIGH, MEDIUM, LOW) along with an
 * explanatory rationale based on measurable observables vs unmeasurable unknowns.
 */

export const ConfidenceLevel = Object.freeze({
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW'
});

export class ConfidenceEngine {
  /**
   * Evaluates context measurement confidence.
   * 
   * @param {Object} params
   * @param {boolean} params.isAuthoritative - True if exact API usage metadata exists
   * @param {boolean} params.isModelKnown - True if active model was identified in config
   * @param {number} params.messageCount - Number of observable message turns
   * @param {number} params.attachmentCount - Number of attached files
   * @param {boolean} params.hasUnknownAttachments - True if attachments cannot be tokenized
   * @param {boolean} params.hasObservedTools - True if web search, python, memory, or MCP was invoked
   * @param {boolean} params.isPartialConversation - True if older messages could be truncated
   * @returns {{ level: string, score: number, reasons: string[] }}
   */
  static evaluate(params = {}) {
    const {
      isAuthoritative = false,
      isModelKnown = true,
      messageCount = 0,
      attachmentCount = 0,
      hasUnknownAttachments = false,
      hasObservedTools = false,
      isPartialConversation = false
    } = params;

    // Direct exact usage metadata always yields High confidence
    if (isAuthoritative) {
      return {
        level: ConfidenceLevel.HIGH,
        score: 1.0,
        reasons: ['Authoritative usage metadata provided directly by system']
      };
    }

    let score = 0.85;
    const reasons = [];

    if (!isModelKnown) {
      score -= 0.40;
      reasons.push('Model not recognized or context window limit unknown');
    }

    if (isPartialConversation) {
      score -= 0.25;
      reasons.push('Conversation is partially loaded / virtualized in DOM; count is lower bound');
    }

    if (hasUnknownAttachments && attachmentCount > 0) {
      score -= 0.15;
      reasons.push(`${attachmentCount} attachment(s) processed internally without observable token size`);
    }

    if (hasObservedTools) {
      score -= 0.15;
      reasons.push('External tools / web search / memory executed with unobservable system prompts');
    }

    if (messageCount === 0) {
      score = Math.min(score, 0.5);
      reasons.push('No conversation messages currently detected in DOM');
    }

    // Determine categorical level
    let level;
    if (score >= 0.75) {
      level = ConfidenceLevel.HIGH;
    } else if (score >= 0.50) {
      level = ConfidenceLevel.MEDIUM;
    } else {
      level = ConfidenceLevel.LOW;
    }

    return {
      level,
      score: Math.max(0.1, Math.min(1.0, Number(score.toFixed(2)))),
      reasons: reasons.length > 0 ? reasons : ['Clean conversation text with verified model context limits']
    };
  }
}
