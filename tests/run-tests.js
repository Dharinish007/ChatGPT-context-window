/**
 * Master Test Runner for ChatGPT Context Monitor
 */

import { runTokenizerTests } from './unit/tokenizer.test.js';
import { runContextEngineTests } from './unit/context-engine.test.js';
import { runConversationClientTests } from './unit/conversation-client.test.js';
import { runNetworkObserverTests } from './unit/network-observer.test.js';
import { runCompletenessTests } from './unit/completeness.test.js';
import { runDomExtractorTests } from './dom/extractor.test.js';
import { runEvidenceConfidenceTests } from './unit/evidence-confidence.test.js';
import { runModelPlanLimitsTests } from './unit/model-plan-limits.test.js';
import { runBundleIntegrityTests } from './unit/bundle-integrity.test.js';
import { runInterceptorTests } from './unit/interceptor.test.js';
import { runLiveSourcesTests } from './unit/live-sources.test.js';
import { runWidgetStateTests } from './unit/widget-state.test.js';
import { runReliabilityTests } from './unit/reliability.test.js';
import { runAccuracyTests } from './unit/accuracy.test.js';
import { runFinalFixesTests } from './unit/final-fixes.test.js';
import { runConfidenceDiagnosticsTests } from './unit/confidence-diagnostics.test.js';
import { runProvidersTests } from './unit/providers.test.js';
import { runPerformanceTests } from './unit/performance.test.js';

console.log('========================================================');
console.log('  ChatGPT Context Monitor - Production Test Suite');
console.log('========================================================\n');

let totalPassed = 0;
let totalFailed = 0;

const t0 = performance.now();

// 1. Tokenizer tests
const r1 = runTokenizerTests();
totalPassed += r1.passed;
totalFailed += r1.failed;
console.log('');

// 2. Context engine tests
const r2 = runContextEngineTests();
totalPassed += r2.passed;
totalFailed += r2.failed;
console.log('');

// 3. Conversation client tests (Group B)
const r3 = runConversationClientTests();
totalPassed += r3.passed;
totalFailed += r3.failed;
console.log('');

// 4. Network intelligence & observer tests (Group C)
const r4 = runNetworkObserverTests();
totalPassed += r4.passed;
totalFailed += r4.failed;
console.log('');

// 5. Context completeness & virtualization tests (Group D)
const r5 = runCompletenessTests();
totalPassed += r5.passed;
totalFailed += r5.failed;
console.log('');

// 6. DOM extractor tests
const r6 = runDomExtractorTests();
totalPassed += r6.passed;
totalFailed += r6.failed;
console.log('');

// 7. Evidence & Confidence tests (Group E)
const r7 = runEvidenceConfidenceTests();
totalPassed += r7.passed;
totalFailed += r7.failed;
console.log('');

// 8. Model + Plan-Aware Context Limits tests (Group F)
const r8 = runModelPlanLimitsTests();
totalPassed += r8.passed;
totalFailed += r8.failed;
console.log('');

// 9. Bundle integrity & syntax tests
const r9 = runBundleIntegrityTests();
totalPassed += r9.passed;
totalFailed += r9.failed;
console.log('');

// 10. MAIN-world network interceptor tests
const r10 = await runInterceptorTests();
totalPassed += r10.passed;
totalFailed += r10.failed;
console.log('');

// 11. Live data sources (session bearer, capture fallback, backoff)
const r11 = await runLiveSourcesTests();
totalPassed += r11.passed;
totalFailed += r11.failed;
console.log('');

// 12. Provider-neutral widget view state
const r12 = runWidgetStateTests();
totalPassed += r12.passed;
totalFailed += r12.failed;
console.log('');

// 13. Pipeline reliability regressions
const r13 = await runReliabilityTests();
totalPassed += r13.passed;
totalFailed += r13.failed;
console.log('');

// 14. Context accuracy + model/plan intelligence
const r14 = await runAccuracyTests();
totalPassed += r14.passed;
totalFailed += r14.failed;
console.log('');

// 15. Part 1 final fixes: load delay, loading state, refresh, triggers, popup removal
const r15 = await runFinalFixesTests();
totalPassed += r15.passed;
totalFailed += r15.failed;
console.log('');

// 16. Part 3: confidence, evidence provenance, diagnostics
const r16 = await runConfidenceDiagnosticsTests();
totalPassed += r16.passed;
totalFailed += r16.failed;
console.log('');

// 17. Claude + Gemini provider adapters
const r17 = await runProvidersTests();
totalPassed += r17.passed;
totalFailed += r17.failed;
console.log('');

// 18. Performance fast paths are exactly equivalent to the slow ones
const r18 = runPerformanceTests();
totalPassed += r18.passed;
totalFailed += r18.failed;
console.log('');

const t1 = performance.now();
const elapsed = (t1 - t0).toFixed(2);

console.log('========================================================');
console.log(`  Tests Completed in ${elapsed}ms`);
console.log(`  Total Passed: ${totalPassed}`);
console.log(`  Total Failed: ${totalFailed}`);
console.log('========================================================\n');

if (totalFailed > 0) {
  console.error(`💥 Test run failed with ${totalFailed} failure(s).`);
  process.exit(1);
} else {
  console.log('🎉 All test suites passed successfully!');
  process.exit(0);
}
