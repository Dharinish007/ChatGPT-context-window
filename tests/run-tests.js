/**
 * Master Test Runner for ChatGPT Context Monitor
 */

import { runTokenizerTests } from './unit/tokenizer.test.js';
import { runContextEngineTests } from './unit/context-engine.test.js';
import { runConversationClientTests } from './unit/conversation-client.test.js';
import { runNetworkObserverTests } from './unit/network-observer.test.js';
import { runCompletenessTests } from './unit/completeness.test.js';
import { runDomExtractorTests } from './dom/extractor.test.js';

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
