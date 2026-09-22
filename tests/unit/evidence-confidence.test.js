/**
 * Unit Tests for Group E - Evidence & Confidence
 * 
 * Verifies:
 * 1. Standardized evidence levels (EXACT, OBSERVED, ESTIMATED, UNKNOWN)
 * 2. Field-level provenance { value, source, evidenceType }
 * 3. Source priority hierarchy (Authoritative API > Network > DOM > Local Inference)
 * 4. Multi-source evidence merging, conflict detection & resolution
 * 5. Explainable confidence evaluation with positive and negative factors
 * 6. Observable Context Confidence vs Complete Server Context (Truth-in-Measurement)
 * 7. All 12 required scenarios from Group E specifications
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { EvidenceMerger, EvidenceType, SourcePriority } from '../../engine/evidence-merger.js';
import { ConfidenceEngine, ConfidenceLevel } from '../../engine/confidence-engine.js';
import { ContextCalculator } from '../../engine/context-calculator.js';
import { ModelDetector } from '../../content/model-detector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const modelLimitsDb = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../config/model-limits.json'), 'utf8')
);

export function runEvidenceConfidenceTests() {
  console.log('--- Running Group E: Evidence & Confidence Tests ---');
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

  const detector = new ModelDetector(modelLimitsDb);
  const gpt4o = detector.resolveModel('gpt-4o');

  // =========================================================================
  // 1. Evidence Levels & Source Priority
  // =========================================================================
  assert('Evidence levels are standardized to EXACT, OBSERVED, ESTIMATED, UNKNOWN',
    EvidenceType.EXACT === 'EXACT' &&
    EvidenceType.OBSERVED === 'OBSERVED' &&
    EvidenceType.ESTIMATED === 'ESTIMATED' &&
    EvidenceType.UNKNOWN === 'UNKNOWN'
  );

  assert('Source priority order: Authoritative API (4) > Network (3) > DOM (2) > Local inference (1)',
    SourcePriority.conversation_api === 4 &&
    SourcePriority.network === 3 &&
    SourcePriority.dom === 2 &&
    SourcePriority.tokenizer === 1 &&
    SourcePriority.model_db === 1
  );

  // =========================================================================
  // Scenario 1: all fields EXACT (Authoritative usage tokens)
  // =========================================================================
  const allExactConf = ConfidenceEngine.evaluate({
    isAuthoritative: true,
    isModelKnown: true,
    modelDisplayName: 'GPT-4o',
    messageCount: 10
  });

  assert('Scenario 1 [all fields EXACT]: Level is HIGH and percentage is 100%',
    allExactConf.level === ConfidenceLevel.HIGH &&
    allExactConf.percentage === 100 &&
    allExactConf.score === 1.0
  );
  assert('Scenario 1 [all fields EXACT]: Observable confidence is 100%',
    allExactConf.observableConfidence.percentage === 100 &&
    allExactConf.observableConfidence.level === ConfidenceLevel.HIGH
  );
  assert('Scenario 1 [all fields EXACT]: Server context status is EXACT_USAGE and isLowerBound is false',
    allExactConf.serverContextCompleteness.status === 'EXACT_USAGE' &&
    allExactConf.serverContextCompleteness.isLowerBound === false
  );

  // =========================================================================
  // Scenario 2: mixed EXACT/OBSERVED/ESTIMATED
  // =========================================================================
  const mixedReconcile = EvidenceMerger.reconcileState({
    modelCandidates: [
      { value: 'gpt-4o', source: 'conversation_api', evidenceType: EvidenceType.EXACT },
      { value: 'gpt-4o', source: 'dom', evidenceType: EvidenceType.OBSERVED }
    ],
    turnCandidates: [
      { value: 6, source: 'conversation_api', evidenceType: EvidenceType.EXACT },
      { value: 6, source: 'dom', evidenceType: EvidenceType.OBSERVED }
    ],
    completeness: {
      conversationComplete: true,
      domIsPartial: false,
      completenessSource: 'authoritative_api'
    },
    networkHealth: { networkAvailable: true }
  });

  assert('Scenario 2 [mixed]: Authoritative API wins model with EXACT evidence',
    mixedReconcile.evidence.model.source === 'conversation_api' &&
    mixedReconcile.evidence.model.evidenceType === EvidenceType.EXACT
  );
  assert('Scenario 2 [mixed]: Authoritative API wins turns with EXACT evidence',
    mixedReconcile.evidence.turns.source === 'conversation_api' &&
    mixedReconcile.evidence.turns.value === 6 &&
    mixedReconcile.evidence.turns.evidenceType === EvidenceType.EXACT
  );
  assert('Scenario 2 [mixed]: Network status stamped as OBSERVED',
    mixedReconcile.evidence.network.evidenceType === EvidenceType.OBSERVED &&
    mixedReconcile.evidence.network.value === 'AVAILABLE'
  );
  assert('Scenario 2 [mixed]: Server context stamped as UNKNOWN',
    mixedReconcile.evidence.serverContext.evidenceType === EvidenceType.UNKNOWN
  );

  // =========================================================================
  // Scenario 3: unknown attachments
  // =========================================================================
  const unknownAttachConf = ConfidenceEngine.evaluate({
    isAuthoritative: false,
    isModelKnown: true,
    messageCount: 8,
    attachmentCount: 2,
    hasUnknownAttachments: true,
    completenessSource: 'authoritative_api',
    isNetworkActive: true
  });

  assert('Scenario 3 [unknown attachments]: Confidence score penalizes unmeasurable attachments',
    unknownAttachConf.percentage < 90 &&
    unknownAttachConf.factors.some(f => f.type === 'negative' && f.text.includes('attachment(s) processed internally'))
  );

  // =========================================================================
  // Scenario 4: unknown tool overhead
  // =========================================================================
  const toolConf = ConfidenceEngine.evaluate({
    isAuthoritative: false,
    isModelKnown: true,
    messageCount: 8,
    attachmentCount: 0,
    hasObservedTools: true,
    completenessSource: 'authoritative_api',
    isNetworkActive: true
  });

  assert('Scenario 4 [unknown tool overhead]: Explicit negative factor for tool internal overhead',
    toolConf.factors.some(f => f.type === 'negative' && f.text === 'Tool internal overhead unknown')
  );
  assert('Scenario 4 [unknown tool overhead]: Matches canonical 96% confidence scenario',
    toolConf.percentage === 96 &&
    toolConf.level === ConfidenceLevel.HIGH
  );

  // Verify the exact factor breakdown requested in prompt task 7
  const canonicalFactors = toolConf.factors.map(f => `${f.type === 'positive' ? '+' : '-'} ${f.text}`);
  assert('Scenario 4 [explainability]: Contains "+ Full authoritative conversation"',
    canonicalFactors.includes('+ Full authoritative conversation')
  );
  assert('Scenario 4 [explainability]: Contains "+ Exact tokenizer"',
    canonicalFactors.includes('+ Exact tokenizer')
  );
  assert('Scenario 4 [explainability]: Contains "+ Network active"',
    canonicalFactors.includes('+ Network active')
  );
  assert('Scenario 4 [explainability]: Contains "+ DOM/API agreement"',
    canonicalFactors.includes('+ DOM/API agreement')
  );
  assert('Scenario 4 [explainability]: Contains "- Tool internal overhead unknown"',
    canonicalFactors.includes('- Tool internal overhead unknown')
  );

  // =========================================================================
  // Scenario 5: incomplete DOM (Virtualization / Partial rendering)
  // =========================================================================
  const partialDomConf = ConfidenceEngine.evaluate({
    isAuthoritative: false,
    isModelKnown: true,
    messageCount: 4,
    isPartialConversation: true,
    completenessSource: 'dom_partial',
    isNetworkActive: false
  });

  assert('Scenario 5 [incomplete DOM]: Penalizes partial DOM significantly',
    partialDomConf.score <= 0.60
  );
  assert('Scenario 5 [incomplete DOM]: Marks serverContextCompleteness as LOWER_BOUND',
    partialDomConf.serverContextCompleteness.status === 'LOWER_BOUND' &&
    partialDomConf.serverContextCompleteness.isLowerBound === true
  );
  assert('Scenario 5 [incomplete DOM]: Factor explicitly mentions lower bound',
    partialDomConf.factors.some(f => f.type === 'negative' && f.text.includes('lower bound'))
  );

  // =========================================================================
  // Scenario 6: API unavailable (DOM Fallback)
  // =========================================================================
  const apiUnavailableConf = ConfidenceEngine.evaluate({
    isAuthoritative: false,
    isModelKnown: true,
    messageCount: 6,
    isPartialConversation: true,
    completenessSource: 'dom_partial',
    isNetworkActive: true
  });

  assert('Scenario 6 [API unavailable]: Lacks authoritative positive factor',
    !apiUnavailableConf.factors.some(f => f.text === 'Full authoritative conversation')
  );
  assert('Scenario 6 [API unavailable]: Confidence is lower than with API (<= 65%)',
    apiUnavailableConf.percentage <= 65
  );

  // =========================================================================
  // Scenario 7: Network unavailable
  // =========================================================================
  const netUnavailableConf = ConfidenceEngine.evaluate({
    isAuthoritative: false,
    isModelKnown: true,
    messageCount: 6,
    isNetworkActive: false,
    completenessSource: 'dom_complete'
  });

  assert('Scenario 7 [Network unavailable]: Includes negative factor for network interception unavailable',
    netUnavailableConf.factors.some(f => f.type === 'negative' && f.text === 'Network interception unavailable')
  );

  // =========================================================================
  // Scenario 8: conflicting DOM/API data
  // =========================================================================
  const domApiConflict = EvidenceMerger.reconcileState({
    modelCandidates: [
      { value: 'o1-preview', source: 'conversation_api', evidenceType: EvidenceType.EXACT },
      { value: 'gpt-4o', source: 'dom', evidenceType: EvidenceType.OBSERVED }
    ],
    turnCandidates: [
      { value: 12, source: 'conversation_api', evidenceType: EvidenceType.EXACT },
      { value: 2, source: 'dom', evidenceType: EvidenceType.OBSERVED }
    ],
    completeness: { conversationComplete: true, completenessSource: 'authoritative_api' },
    networkHealth: { networkAvailable: true }
  });

  assert('Scenario 8 [conflicting DOM/API]: Detects conflict between DOM and API',
    domApiConflict.hasConflicts === true &&
    domApiConflict.conflicts.length > 0
  );
  assert('Scenario 8 [conflicting DOM/API]: Authoritative API wins over DOM on conflict',
    domApiConflict.evidence.model.value === 'o1-preview' &&
    domApiConflict.evidence.model.source === 'conversation_api'
  );
  assert('Scenario 8 [conflicting DOM/API]: Discarded DOM evidence is recorded',
    domApiConflict.conflicts.some(c => c.field === 'model' && c.discarded.source === 'dom' && c.discarded.value === 'gpt-4o')
  );

  const conflictConf = ConfidenceEngine.evaluate({
    isAuthoritative: false,
    isModelKnown: true,
    messageCount: 12,
    completenessSource: 'authoritative_api',
    isNetworkActive: true,
    conflicts: domApiConflict.conflicts
  });

  assert('Scenario 8 [conflicting DOM/API]: Conflicting sources penalize confidence score',
    conflictConf.percentage < 96 &&
    conflictConf.factors.some(f => f.type === 'negative' && f.text.includes('Source conflict'))
  );

  // =========================================================================
  // Scenario 9: conflicting Network/API data
  // =========================================================================
  const netApiConflict = EvidenceMerger.reconcileState({
    modelCandidates: [
      { value: 'gpt-4o-mini', source: 'conversation_api', evidenceType: EvidenceType.EXACT },
      { value: 'gpt-4o', source: 'network', evidenceType: EvidenceType.OBSERVED }
    ],
    completeness: { conversationComplete: true, completenessSource: 'authoritative_api' },
    networkHealth: { networkAvailable: true }
  });

  assert('Scenario 9 [conflicting Network/API]: Detects conflict between Network and API',
    netApiConflict.hasConflicts === true &&
    netApiConflict.conflicts.some(c => c.field === 'model')
  );
  assert('Scenario 9 [conflicting Network/API]: Authoritative API (priority 4) supersedes Network (priority 3)',
    netApiConflict.evidence.model.value === 'gpt-4o-mini' &&
    netApiConflict.evidence.model.source === 'conversation_api' &&
    netApiConflict.conflicts[0].discarded.source === 'network'
  );

  // =========================================================================
  // Scenario 10: complete authoritative conversation
  // =========================================================================
  const cleanAuthConf = ConfidenceEngine.evaluate({
    isAuthoritative: false,
    isModelKnown: true,
    modelDisplayName: 'GPT-4o',
    messageCount: 14,
    attachmentCount: 0,
    hasObservedTools: false,
    completenessSource: 'authoritative_api',
    isNetworkActive: true,
    conflicts: []
  });

  assert('Scenario 10 [complete authoritative conversation]: High confidence (100% measurement confidence)',
    cleanAuthConf.level === ConfidenceLevel.HIGH &&
    cleanAuthConf.percentage === 100
  );
  assert('Scenario 10 [complete authoritative conversation]: All drivers positive',
    cleanAuthConf.factors.every(f => f.type === 'positive')
  );

  // =========================================================================
  // Scenario 11: new chat
  // =========================================================================
  const newChatConf = ConfidenceEngine.evaluate({
    isAuthoritative: false,
    isModelKnown: true,
    messageCount: 0,
    completenessSource: 'dom_complete',
    isNetworkActive: true
  });

  assert('Scenario 11 [new chat]: Score is capped for empty chat (50%)',
    newChatConf.percentage <= 50 &&
    newChatConf.factors.some(f => f.text.includes('No conversation messages'))
  );

  // =========================================================================
  // Scenario 12: fallback mode (pure DOM, no API, no Network)
  // =========================================================================
  const fallbackConf = ConfidenceEngine.evaluate({
    isAuthoritative: false,
    isModelKnown: true,
    messageCount: 4,
    attachmentCount: 0,
    hasObservedTools: false,
    completenessSource: 'dom_complete',
    isNetworkActive: false
  });

  assert('Scenario 12 [fallback mode]: Moderate confidence score without authoritative or network ground truth',
    fallbackConf.percentage >= 60 && fallbackConf.percentage <= 85
  );
  assert('Scenario 12 [fallback mode]: Notes network unavailability',
    fallbackConf.factors.some(f => f.type === 'negative' && f.text === 'Network interception unavailable')
  );

  // =========================================================================
  // Context Calculator Integration with Evidence & Provenance
  // =========================================================================
  const fullCalc = ContextCalculator.calculate({
    messages: [
      { id: 'm1', role: 'user', tokens: 100 },
      { id: 'm2', role: 'assistant', tokens: 250 }
    ],
    model: gpt4o,
    attachments: { count: 0, estimatedTokens: 0, hasUnknown: false },
    tools: { observed: false, list: [] },
    completeness: {
      conversationComplete: true,
      domIsPartial: false,
      renderedTurnCount: 2,
      authoritativeTurnCount: 2,
      completenessSource: 'authoritative_api'
    },
    networkHealth: { networkAvailable: true }
  });

  assert('Calculator output carries stamped evidence object',
    Boolean(fullCalc.evidence) &&
    typeof fullCalc.evidence === 'object'
  );
  assert('Calculator token outputs carry field-level provenance',
    fullCalc.evidence.tokens.user.evidenceType === EvidenceType.ESTIMATED &&
    fullCalc.evidence.tokens.user.source === 'tokenizer' &&
    fullCalc.evidence.tokens.total.value === 350
  );
  assert('Calculator completeness evidence carries source and type',
    fullCalc.evidence.completeness.source === 'authoritative_api' &&
    fullCalc.evidence.completeness.evidenceType === EvidenceType.EXACT
  );
  assert('Calculator confidence object contains percentage and explainable factors',
    typeof fullCalc.confidence.percentage === 'number' &&
    Array.isArray(fullCalc.confidence.factors) &&
    fullCalc.confidence.factors.length > 0
  );

  return { passed, failed };
}
