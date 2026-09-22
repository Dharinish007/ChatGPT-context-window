/**
 * ChatGPT Context Monitor - Context Classifier
 * 
 * Enforces the strict epistemic accuracy taxonomy:
 * - EXACT: Authoritative usage/context metadata directly from OpenAI/system
 * - OBSERVED: Directly visible from DOM/network state (model name, attached file names/sizes)
 * - ESTIMATED: Calculated via local tokenizer or calibrated heuristic
 * - UNKNOWN: Server-side, hidden, unobservable, or unmeasurable data
 */

export const EvidenceType = Object.freeze({
  EXACT: 'EXACT',
  OBSERVED: 'OBSERVED',
  ESTIMATED: 'ESTIMATED',
  UNKNOWN: 'UNKNOWN'
});

export const AccuracyClass = EvidenceType;

export class ContextClassifier {
  /**
   * Classifies conversation message token accuracy.
   * @param {boolean} isAuthoritative 
   * @returns {string} AccuracyClass
   */
  static classifyConversation(isAuthoritative = false) {
    return isAuthoritative ? AccuracyClass.EXACT : AccuracyClass.ESTIMATED;
  }

  /**
   * Classifies model identification accuracy.
   * @param {string|null} modelId 
   * @returns {string} AccuracyClass
   */
  static classifyModel(modelId) {
    if (!modelId || modelId === 'unknown') {
      return AccuracyClass.UNKNOWN;
    }
    return AccuracyClass.OBSERVED;
  }

  /**
   * Classifies subscription plan tier identification accuracy.
   * @param {string|null} planTier 
   * @returns {string} AccuracyClass
   */
  static classifyPlan(planTier) {
    if (!planTier || planTier === 'unknown') {
      return AccuracyClass.UNKNOWN;
    }
    return AccuracyClass.OBSERVED;
  }

  /**
   * Classifies context limit accuracy.
   * @param {number|null} contextWindow 
   * @param {boolean} isVerified 
   * @returns {string} AccuracyClass
   */
  static classifyLimit(contextWindow, isVerified = true) {
    if (!contextWindow || contextWindow <= 0) {
      return AccuracyClass.UNKNOWN;
    }
    return isVerified ? AccuracyClass.OBSERVED : AccuracyClass.ESTIMATED;
  }

  /**
   * Classifies file attachment token contribution.
   * @param {number} fileCount 
   * @param {boolean} hasTextPreview 
   * @returns {string} AccuracyClass
   */
  static classifyAttachment(fileCount, hasTextPreview = false) {
    if (fileCount === 0) return AccuracyClass.OBSERVED;
    return hasTextPreview ? AccuracyClass.ESTIMATED : AccuracyClass.UNKNOWN;
  }

  /**
   * Classifies memory context tokens.
   * @returns {string} AccuracyClass
   */
  static classifyMemory() {
    // Memory retrieval overhead is server-side and hidden from DOM
    return AccuracyClass.UNKNOWN;
  }

  /**
   * Classifies tools/MCP/apps context tokens.
   * @param {boolean} toolObserved 
   * @returns {string} AccuracyClass
   */
  static classifyTools(toolObserved = false) {
    return toolObserved ? AccuracyClass.UNKNOWN : AccuracyClass.OBSERVED;
  }

  /**
   * Classifies hidden/system/developer prompt context tokens.
   * @returns {string} AccuracyClass
   */
  static classifyHiddenContext() {
    return AccuracyClass.UNKNOWN;
  }

  /**
   * Validates and returns overall total accuracy classification.
   * @param {boolean} hasExactMetadata 
   * @returns {string} AccuracyClass
   */
  static classifyTotal(hasExactMetadata = false) {
    return hasExactMetadata ? AccuracyClass.EXACT : AccuracyClass.ESTIMATED;
  }
}
