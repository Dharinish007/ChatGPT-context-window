/**
 * Unit Tests for Group F: Model + Plan-Aware Context Limits
 * 
 * Verifies:
 * 1. Known model + known plan (Free, Plus, Pro, Team, Enterprise)
 * 2. Known model + unknown plan
 * 3. Unknown model + known plan
 * 4. Unknown model + unknown plan
 * 5. Conflicting plan signals (e.g. Network 'plus' vs DOM 'free')
 * 6. Outdated or corrupted config handling (graceful fallback)
 * 7. Refreshed / versioned config dynamically loaded
 * 8. Strict distinction: OpenAI API limit vs ChatGPT product limit (Never mixed)
 * 9. Utilization calculation with known context limit
 * 10. Safe fallback: unknown limit -> utilization = UNKNOWN
 * 11. Confidence engine reactions to verified vs unverified limits
 * 12. Plan tier normalization (aliases, case-insensitivity)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ModelDetector } from '../../content/model-detector.js';
import { PlanDetector, normalizePlanTier, PlanTier } from '../../content/plan-detector.js';
import { ContextCalculator } from '../../engine/context-calculator.js';
import { EvidenceMerger, EvidenceType } from '../../engine/evidence-merger.js';
import { ConfidenceEngine, ConfidenceLevel } from '../../engine/confidence-engine.js';
import { ContextClassifier, AccuracyClass } from '../../engine/context-classifier.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const modelLimitsDb = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../config/model-limits.json'), 'utf8')
);

export function runModelPlanLimitsTests() {
  console.log('--- Running Group F: Model + Plan-Aware Context Limits Tests ---');
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

  // =========================================================================
  // 1. Plan Tier Normalization
  // =========================================================================
  assert('Normalizes "free" to PlanTier.FREE', normalizePlanTier('free') === PlanTier.FREE);
  assert('Normalizes "chatgpt_plus" to PlanTier.PLUS', normalizePlanTier('chatgpt_plus') === PlanTier.PLUS);
  assert('Normalizes "Pro_Subscriber" to PlanTier.PRO', normalizePlanTier('Pro_Subscriber') === PlanTier.PRO);
  assert('Normalizes "team" to PlanTier.TEAM', normalizePlanTier('team') === PlanTier.TEAM);
  assert('Normalizes "ChatGPT_Enterprise" to PlanTier.ENTERPRISE', normalizePlanTier('ChatGPT_Enterprise') === PlanTier.ENTERPRISE);
  assert('Normalizes unknown string to PlanTier.UNKNOWN', normalizePlanTier('random_tier') === PlanTier.UNKNOWN);
  assert('Normalizes null/empty to PlanTier.UNKNOWN', normalizePlanTier(null) === PlanTier.UNKNOWN);

  // =========================================================================
  // 2. Known Model + Known Plan
  // =========================================================================
  const gpt4oPlus = detector.resolveModel('gpt-4o', 'plus');
  assert('Known model + known plan (GPT-4o + Plus): resolves 32K context window',
    gpt4oPlus.contextWindow === 32768 &&
    gpt4oPlus.planTier === PlanTier.PLUS &&
    gpt4oPlus.limitStatus === 'VERIFIED'
  );

  const gpt4oFree = detector.resolveModel('gpt-4o', 'free');
  assert('Known model + known plan (GPT-4o + Free): resolves 8K context window',
    gpt4oFree.contextWindow === 8192 &&
    gpt4oFree.planTier === PlanTier.FREE &&
    gpt4oFree.limitStatus === 'VERIFIED'
  );

  const gpt4oPro = detector.resolveModel('gpt-4o', 'pro');
  assert('Known model + known plan (GPT-4o + Pro): resolves 128K context window',
    gpt4oPro.contextWindow === 128000 &&
    gpt4oPro.planTier === PlanTier.PRO &&
    gpt4oPro.limitStatus === 'VERIFIED'
  );

  const gpt4oEnterprise = detector.resolveModel('gpt-4o', 'enterprise');
  assert('Known model + known plan (GPT-4o + Enterprise): resolves 128K context window',
    gpt4oEnterprise.contextWindow === 128000 &&
    gpt4oEnterprise.planTier === PlanTier.ENTERPRISE &&
    gpt4oEnterprise.limitStatus === 'VERIFIED'
  );

  const o1Pro = detector.resolveModel('o1', 'pro');
  assert('Known model + known plan (o1 + Pro): resolves 200K reasoning context window',
    o1Pro.contextWindow === 200000 &&
    o1Pro.planTier === PlanTier.PRO &&
    o1Pro.limitStatus === 'VERIFIED'
  );

  // =========================================================================
  // 3. Known Model + Unknown Plan (Safe Fallback)
  // =========================================================================
  const gpt4oUnknownPlan = detector.resolveModel('gpt-4o', 'unknown');
  assert('Known model + unknown plan: contextWindow is null',
    gpt4oUnknownPlan.contextWindow === null &&
    gpt4oUnknownPlan.limitStatus === 'UNKNOWN' &&
    gpt4oUnknownPlan.planTier === PlanTier.UNKNOWN
  );
  assert('Known model + unknown plan: retains underlying API context limit separately',
    gpt4oUnknownPlan.apiContextLimit === 128000
  );

  // =========================================================================
  // 4. Unknown Model + Known Plan
  // =========================================================================
  const unknownModelKnownPlan = detector.resolveModel('nonexistent-model-xyz', 'plus');
  assert('Unknown model + known plan: contextWindow is null and status is UNKNOWN',
    unknownModelKnownPlan.contextWindow === null &&
    unknownModelKnownPlan.limitStatus === 'UNKNOWN' &&
    unknownModelKnownPlan.apiContextLimit === null
  );

  // =========================================================================
  // 5. Unknown Model + Unknown Plan
  // =========================================================================
  const unknownModelUnknownPlan = detector.resolveModel('nonexistent-model-xyz', 'unknown');
  assert('Unknown model + unknown plan: contextWindow is null',
    unknownModelUnknownPlan.contextWindow === null &&
    unknownModelUnknownPlan.limitStatus === 'UNKNOWN'
  );

  // =========================================================================
  // 6. API Context Limit Must Not Accidentally Become ChatGPT Product Limit
  // =========================================================================
  assert('API limit (128K) is strictly separated from Plus product limit (32K)',
    gpt4oPlus.apiContextLimit === 128000 &&
    gpt4oPlus.contextWindow === 32768 &&
    gpt4oPlus.contextWindow !== gpt4oPlus.apiContextLimit
  );

  assert('API limit (128K) is strictly separated from Free product limit (8K)',
    gpt4oFree.apiContextLimit === 128000 &&
    gpt4oFree.contextWindow === 8192 &&
    gpt4oFree.contextWindow !== gpt4oFree.apiContextLimit
  );

  assert('API limit (128K) is not used as fallback when plan is unknown',
    gpt4oUnknownPlan.contextWindow === null &&
    gpt4oUnknownPlan.apiContextLimit === 128000
  );

  // =========================================================================
  // 7. Conflicting Plan Signals (Multi-source reconciliation)
  // =========================================================================
  const planConflictReconcile = EvidenceMerger.reconcileState({
    planCandidates: [
      { value: 'plus', source: 'network', evidenceType: EvidenceType.OBSERVED },
      { value: 'free', source: 'dom', evidenceType: EvidenceType.OBSERVED }
    ]
  });

  assert('Conflicting plan signals: Detects disagreement between Network and DOM',
    planConflictReconcile.hasConflicts === true &&
    planConflictReconcile.conflicts.some(c => c.field === 'plan')
  );
  assert('Conflicting plan signals: Network (priority 3) supersedes DOM (priority 2)',
    planConflictReconcile.evidence.plan.value === 'plus' &&
    planConflictReconcile.evidence.plan.source === 'network'
  );
  assert('Conflicting plan signals: Discarded DOM evidence is explicitly logged',
    planConflictReconcile.conflicts[0].discarded.source === 'dom' &&
    planConflictReconcile.conflicts[0].discarded.value === 'free'
  );

  // =========================================================================
  // 8. Utilization with Known Limit vs Unknown Limit
  // =========================================================================
  // 8a. Known limit
  const knownCalc = ContextCalculator.calculate({
    messages: [
      { id: 'm1', role: 'user', tokens: 1500 },
      { id: 'm2', role: 'assistant', tokens: 3600 }
    ],
    model: gpt4oPlus, // contextWindow: 32768
    plan: { tier: 'plus', source: 'network' }
  });

  assert('Utilization with known limit: Calculates exact percentage (5100 / 32768 = 15.6%)',
    knownCalc.utilization.percentage === 15.6 &&
    knownCalc.utilization.formatted === '15.6%'
  );
  assert('Utilization with known limit: Formatted context window shows "32.8K"',
    knownCalc.tokens.formatted.contextWindow === '32.8K'
  );
  assert('Classification of verified limit is OBSERVED',
    knownCalc.accuracy.contextWindow === AccuracyClass.OBSERVED
  );

  // 8b. Unknown limit (Safe Fallback)
  const unknownCalc = ContextCalculator.calculate({
    messages: [
      { id: 'm1', role: 'user', tokens: 1500 },
      { id: 'm2', role: 'assistant', tokens: 3600 }
    ],
    model: gpt4oUnknownPlan, // contextWindow: null
    plan: { tier: 'unknown', source: 'unknown' }
  });

  assert('Utilization when limit is unknown: percentage is null',
    unknownCalc.utilization.percentage === null
  );
  assert('Utilization when limit is unknown: formatted is "Unknown"',
    unknownCalc.utilization.formatted === 'Unknown'
  );
  assert('Utilization when limit is unknown: tokens.formatted.contextWindow is "Unknown"',
    unknownCalc.tokens.formatted.contextWindow === 'Unknown'
  );
  assert('Classification of unknown limit is UNKNOWN',
    unknownCalc.accuracy.contextWindow === AccuracyClass.UNKNOWN
  );

  // =========================================================================
  // 9. Confidence Engine: Verified vs Unverified Context Limit
  // =========================================================================
  // 9a. Verified model + plan improves confidence
  const verifiedLimitConf = ConfidenceEngine.evaluate({
    isAuthoritative: false,
    isModelKnown: true,
    isLimitVerified: true,
    planTier: 'plus',
    isPlanKnown: true,
    contextLimit: 32768,
    messageCount: 8,
    completenessSource: 'authoritative_api',
    isNetworkActive: true
  });

  assert('Confidence with verified model+plan: High score and positive factor',
    verifiedLimitConf.factors.some(f => f.type === 'positive' && f.text.includes('Verified PLUS plan context limit'))
  );

  // 9b. Unknown plan lowers confidence
  const unverifiedPlanConf = ConfidenceEngine.evaluate({
    isAuthoritative: false,
    isModelKnown: true,
    isLimitVerified: false,
    planTier: 'unknown',
    isPlanKnown: false,
    contextLimit: null,
    messageCount: 8,
    completenessSource: 'authoritative_api',
    isNetworkActive: true
  });

  assert('Confidence with unknown plan: Penalizes score and adds negative factor',
    unverifiedPlanConf.factors.some(f => f.type === 'negative' && f.text.includes('ChatGPT plan tier unknown')) &&
    unverifiedPlanConf.score < verifiedLimitConf.score
  );

  // 9c. Unverified plan tier (e.g. Go tier with null limit)
  const unverifiedTierConf = ConfidenceEngine.evaluate({
    isAuthoritative: false,
    isModelKnown: true,
    isLimitVerified: false,
    planTier: 'go',
    isPlanKnown: true,
    contextLimit: null,
    messageCount: 8,
    completenessSource: 'authoritative_api',
    isNetworkActive: true
  });

  assert('Confidence with unverified plan tier: Penalizes unverified documentation status',
    unverifiedTierConf.factors.some(f => f.type === 'negative' && f.text.includes('unverified by OpenAI documentation'))
  );

  // =========================================================================
  // 10. Refreshed & Versioned Config
  // =========================================================================
  assert('Detector exposes active config version "2.1.0"', detector.getConfigVersion() === '2.1.0');

  // =========================================================================
  // 11. Current ChatGPT model families (pattern-matched slugs)
  // =========================================================================
  const instantPlus = detector.resolveModel('gpt-5-6-sol', 'plus');
  assert('Unlisted gpt-5.x slug resolves to Instant family (Plus 54K)',
    instantPlus.id === 'chatgpt-instant' && instantPlus.contextWindow === 54000 && instantPlus.limitStatus === 'VERIFIED');
  assert('Family display name keeps the real slug', instantPlus.displayName === 'gpt-5-6-sol (Instant)');
  assert('gpt-6 slug resolves to Instant family (Free 27K)', detector.resolveModel('gpt-6-astra', 'free').contextWindow === 27000);
  assert('Thinking slug resolves to reasoning family (Pro 400K)',
    detector.resolveModel('gpt-5-thinking', 'pro').contextWindow === 400000);
  assert('Short "-t-" reasoning slug resolves to reasoning family (Plus 256K)',
    detector.resolveModel('gpt-5-t-mini', 'plus').contextWindow === 256000);
  assert('DOM header text "5.6 Thinking" resolves to reasoning family',
    detector.resolveModel('5.6 Thinking', 'plus').id === 'chatgpt-reasoning');
  assert('"gpt-5-6-terra" is not mistaken for the "t" reasoning marker',
    detector.resolveModel('gpt-5-6-terra', 'plus').id === 'chatgpt-instant');
  assert('Free reasoning limit is UNKNOWN (pricing page says "Varies")',
    detector.resolveModel('gpt-5-thinking', 'free').contextWindow === null);
  assert('Business limit is flagged UNVERIFIED (not on public pricing page)',
    detector.resolveModel('gpt-5', 'business').limitStatus === 'UNVERIFIED');
  assert('o3 no longer aliases to o3-mini', detector.resolveModel('o3', 'plus').id === 'chatgpt-reasoning');
  assert('o3-mini still resolves exactly', detector.resolveModel('o3-mini', 'plus').id === 'o3-mini');
  assert('gpt-4.1 no longer substring-matches legacy GPT-4 (8K)', detector.resolveModel('gpt-4.1', 'plus').id === 'chatgpt-instant');
  assert('Substring match prefers longest key (gpt-4o-mini-2024 -> gpt-4o-mini)',
    detector.resolveModel('gpt-4o-mini-2024-07-18', 'plus').id === 'gpt-4o-mini');
  assert('Detector exposes last updated date', Boolean(detector.getLastUpdated()));

  // Test refreshing with updated config
  const customConfig = {
    version: '2.1.0',
    lastUpdated: '2026-09-25',
    models: {
      'gpt-next': {
        displayName: 'GPT-Next',
        encoding: 'o200k_base',
        apiContextLimit: 500000,
        productLimits: {
          pro: {
            contextWindow: 500000,
            status: 'VERIFIED',
            source: 'Future OpenAI release notes'
          }
        }
      }
    },
    plans: {
      pro: { displayName: 'Pro', tier: 'pro' }
    }
  };

  const freshDetector = new ModelDetector(modelLimitsDb);
  const refreshResult = freshDetector.refreshConfig(customConfig);

  assert('refreshConfig succeeds with valid new schema', refreshResult.success === true && refreshResult.version === '2.1.0');
  assert('freshDetector resolves newly added model from refreshed config',
    freshDetector.resolveModel('gpt-next', 'pro').contextWindow === 500000
  );

  // Test refreshing with invalid / corrupted config
  const badRefreshResult = freshDetector.refreshConfig({ corrupted: true });
  assert('refreshConfig rejects malformed config missing "models" and preserves existing data',
    badRefreshResult.success === false &&
    freshDetector.getConfigVersion() === '2.1.0'
  );

  return { passed, failed };
}
