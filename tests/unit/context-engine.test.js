/**
 * Unit Tests for Context Engine (Classifier, Calculator, Confidence, and Model Config)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ContextClassifier, AccuracyClass } from '../../engine/context-classifier.js';
import { ConfidenceEngine, ConfidenceLevel } from '../../engine/confidence-engine.js';
import { ContextCalculator } from '../../engine/context-calculator.js';
import { ModelDetector } from '../../content/model-detector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const modelLimitsDb = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../config/model-limits.json'), 'utf8')
);

export function runContextEngineTests() {
  console.log('--- Running Context Engine Tests ---');
  let passed = 0;
  let failed = 0;

  function assert(name, condition) {
    if (condition) {
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${name}`);
      failed++;
    }
  }

  // 1. Model Limits Resolution Tests
  const detector = new ModelDetector(modelLimitsDb);
  
  const gpt4o = detector.resolveModel('GPT-4o');
  assert('Resolves GPT-4o with 128K context window', gpt4o.contextWindow === 128000 && gpt4o.displayName === 'GPT-4o');

  const o1 = detector.resolveModel('o1');
  assert('Resolves o1 with 200K context window', o1.contextWindow === 200000 && o1.maxOutput === 100000);

  const o3mini = detector.resolveModel('o3-mini');
  assert('Resolves o3-mini with 200K context window', o3mini.contextWindow === 200000);

  const unknownModel = detector.resolveModel('NonExistentModelX');
  assert('Resolves unrecognized model with null context window and unverified source', unknownModel.contextWindow === null && unknownModel.id === 'nonexistentmodelx');

  // 2. Accuracy Taxonomy Classification Tests
  assert('Conversation without authoritative metadata classified as ESTIMATED', ContextClassifier.classifyConversation(false) === AccuracyClass.ESTIMATED);
  assert('Conversation with authoritative metadata classified as EXACT', ContextClassifier.classifyConversation(true) === AccuracyClass.EXACT);
  assert('Known model classified as OBSERVED', ContextClassifier.classifyModel('gpt-4o') === AccuracyClass.OBSERVED);
  assert('Unknown model classified as UNKNOWN', ContextClassifier.classifyModel(null) === AccuracyClass.UNKNOWN);
  assert('Memory tokens ALWAYS classified as UNKNOWN', ContextClassifier.classifyMemory() === AccuracyClass.UNKNOWN);
  assert('Hidden system context ALWAYS classified as UNKNOWN', ContextClassifier.classifyHiddenContext() === AccuracyClass.UNKNOWN);

  // 3. Confidence Engine Tests
  const highConf = ConfidenceEngine.evaluate({
    isAuthoritative: true,
    isModelKnown: true,
    messageCount: 10
  });
  assert('Authoritative metadata yields HIGH confidence (100%)', highConf.level === ConfidenceLevel.HIGH && highConf.score === 1.0);

  const mediumConf = ConfidenceEngine.evaluate({
    isAuthoritative: false,
    isModelKnown: true,
    messageCount: 12,
    attachmentCount: 0,
    hasObservedTools: false,
    isPartialConversation: false
  });
  assert('Clean conversation with known model yields HIGH/MEDIUM confidence', mediumConf.level === ConfidenceLevel.HIGH && mediumConf.score >= 0.75);

  const lowConf = ConfidenceEngine.evaluate({
    isAuthoritative: false,
    isModelKnown: false, // Unknown model
    messageCount: 5,
    isPartialConversation: true, // Truncated
    hasObservedTools: true
  });
  assert('Unknown model + partial conversation yields LOW confidence', lowConf.level === ConfidenceLevel.LOW && lowConf.score < 0.5);

  // 4. Context Calculator Calculation & Formatting Tests
  assert('Formats 850 tokens as "850"', ContextCalculator.formatTokenCount(850) === '850');
  assert('Formats 12,450 tokens as "12.5K"', ContextCalculator.formatTokenCount(12450) === '12.5K');
  assert('Formats 128,000 tokens as "128K"', ContextCalculator.formatTokenCount(128000) === '128K');
  assert('Formats null as "Unknown"', ContextCalculator.formatTokenCount(null) === 'Unknown');

  const calcResult = ContextCalculator.calculate({
    messages: [
      { id: 'm1', role: 'user', tokens: 1200 },
      { id: 'm2', role: 'assistant', tokens: 2800 },
      { id: 'm3', role: 'user', tokens: 800 }
    ],
    model: gpt4o,
    attachments: { count: 1, estimatedTokens: 300, hasUnknown: false },
    tools: { observed: false, list: [] },
    memory: { observed: false, enabled: true },
    isPartial: false
  });

  assert('Calculates user tokens correctly (2000)', calcResult.tokens.user === 2000);
  assert('Calculates assistant tokens correctly (2800)', calcResult.tokens.assistant === 2800);
  assert('Calculates conversation total correctly (4800)', calcResult.tokens.conversation === 4800);
  assert('Calculates total measurable tokens (4800 + 300 = 5100)', calcResult.tokens.totalMeasurable === 5100);
  
  // Utilization: 5100 / 128000 = 3.98% -> ~4.0%
  assert('Calculates correct utilization percentage', calcResult.utilization.percentage === 4.0);
  assert('Enforces accuracy classification map on all outputs', calcResult.accuracy.conversation === 'ESTIMATED' && calcResult.accuracy.memory === 'UNKNOWN');

  return { passed, failed };
}
