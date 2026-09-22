/**
 * ChatGPT Context Monitor - Context Calculator
 * 
 * Aggregates token measurements across conversation messages, attachments,
 * tools, and model limits to calculate context utilization and breakdown statistics.
 */

import { ContextClassifier, AccuracyClass } from './context-classifier.js';
import { ConfidenceEngine } from './confidence-engine.js';

export class ContextCalculator {
  /**
   * Formats a raw token number into a human-friendly string (e.g. 1,250 -> 1.3K, 128000 -> 128K)
   * @param {number|null} count 
   * @returns {string}
   */
  static formatTokenCount(count) {
    if (count === null || count === undefined || isNaN(count)) {
      return 'Unknown';
    }
    if (count < 1000) {
      return count.toLocaleString();
    }
    if (count < 1000000) {
      const rounded = (Math.round(count / 100) / 10).toFixed(1).replace(/\.0$/, '');
      return `${rounded}K`;
    }
    const m = (Math.round(count / 10000) / 100).toFixed(2).replace(/\.00$/, '');
    return `${m}M`;
  }

  /**
   * Calculates comprehensive context usage state.
   * 
   * @param {Object} input
   * @param {Array<{ id: string, role: string, tokens: number }>} input.messages
   * @param {Object} input.model
   * @param {Object} input.attachments
   * @param {Object} input.tools
   * @param {Object} input.memory
   * @param {Object} input.authoritative
   * @param {boolean} input.isPartial
   * @returns {Object} Context state object
   */
  static calculate(input = {}) {
    const messages = input.messages || [];
    const model = input.model || { displayName: 'Unknown', contextWindow: null, id: 'unknown' };
    const attachments = input.attachments || { count: 0, estimatedTokens: 0, hasUnknown: false };
    const tools = input.tools || { observed: false, list: [] };
    const memory = input.memory || { enabled: false, observed: false };
    const authoritative = input.authoritative || null;
    const isPartial = Boolean(input.isPartial);

    // Sum message tokens by author role and track non-text parts
    let userTokens = 0;
    let assistantTokens = 0;
    let nonTextPartsCount = 0;
    const nonTextPartsList = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const msgTokens = msg.tokens || 0;

      // Track non-text parts when provided
      if (Array.isArray(msg.nonTextParts) && msg.nonTextParts.length > 0) {
        nonTextPartsCount += msg.nonTextParts.length;
        nonTextPartsList.push(...msg.nonTextParts);
      } else if (Array.isArray(msg.parts)) {
        for (const p of msg.parts) {
          if (p && typeof p === 'object' && p.type && p.type !== 'text') {
            nonTextPartsCount++;
            nonTextPartsList.push({
              type: p.type,
              classification: p.classification || 'UNKNOWN'
            });
          }
        }
      }

      if (msg.role === 'user') {
        userTokens += msgTokens;
      } else {
        assistantTokens += msgTokens;
      }
    }
    const conversationTokens = userTokens + assistantTokens;

    // Attachment tokens
    const attachmentTokens = attachments.estimatedTokens || 0;

    // Total measurable context
    const totalMeasurableTokens = conversationTokens + attachmentTokens;

    // Context window & utilization
    const contextWindow = model.contextWindow || null;
    let utilizationPercent = null;
    if (contextWindow && contextWindow > 0) {
      utilizationPercent = Math.min(100, Number(((totalMeasurableTokens / contextWindow) * 100).toFixed(1)));
    }

    // Epistemic classification for each dimension
    const accuracy = {
      conversation: ContextClassifier.classifyConversation(Boolean(authoritative?.tokens)),
      model: ContextClassifier.classifyModel(model.id),
      contextWindow: ContextClassifier.classifyLimit(contextWindow, Boolean(model.source)),
      attachments: ContextClassifier.classifyAttachment(attachments.count, !attachments.hasUnknown),
      memory: ContextClassifier.classifyMemory(),
      tools: ContextClassifier.classifyTools(tools.observed),
      hiddenContext: ContextClassifier.classifyHiddenContext(),
      total: ContextClassifier.classifyTotal(Boolean(authoritative?.tokens))
    };

    // Confidence evaluation
    const confidence = ConfidenceEngine.evaluate({
      isAuthoritative: Boolean(authoritative?.tokens),
      isModelKnown: model.id !== 'unknown' && Boolean(contextWindow),
      messageCount: messages.length,
      attachmentCount: attachments.count,
      hasUnknownAttachments: attachments.hasUnknown,
      hasObservedTools: tools.observed,
      isPartialConversation: isPartial
    });

    return {
      timestamp: Date.now(),
      model: {
        id: model.id || 'unknown',
        displayName: model.displayName || 'Unknown Model',
        encoding: model.encoding || 'o200k_base',
        contextWindow: contextWindow,
        maxOutput: model.maxOutput || null,
        source: model.source || 'unverified',
        accuracy: accuracy.model
      },
      tokens: {
        user: userTokens,
        assistant: assistantTokens,
        conversation: conversationTokens,
        attachments: attachmentTokens,
        totalMeasurable: totalMeasurableTokens,
        formatted: {
          user: this.formatTokenCount(userTokens),
          assistant: this.formatTokenCount(assistantTokens),
          conversation: this.formatTokenCount(conversationTokens),
          attachments: this.formatTokenCount(attachmentTokens),
          total: this.formatTokenCount(totalMeasurableTokens),
          contextWindow: contextWindow ? this.formatTokenCount(contextWindow) : 'Unknown'
        }
      },
      utilization: {
        percentage: utilizationPercent,
        formatted: utilizationPercent !== null ? `${utilizationPercent}%` : 'Unknown'
      },
      observables: {
        messagesCount: messages.length,
        attachmentsCount: attachments.count,
        toolsObserved: tools.observed,
        toolsList: tools.list || [],
        memoryObserved: memory.observed,
        isPartialConversation: isPartial,
        nonTextPartsCount,
        nonTextPartsList
      },
      accuracy,
      confidence,
      limitations: [
        'Visible conversation text is not the complete prompt submitted to the model.',
        'Hidden server-side system prompts, developer instructions, and runtime metadata are not measurable from the client.',
        'Tool schemas and memory retrieval token overhead remain classified as UNKNOWN.'
      ]
    };
  }
}
