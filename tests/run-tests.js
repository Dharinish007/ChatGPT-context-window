/**
 * Master Test Runner for ChatGPT Context Monitor
 */

import { runTokenizerTests } from './unit/tokenizer.test.js';
import { runContextEngineTests } from './unit/context-engine.test.js';
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

// 3. DOM extractor tests
const r3 = runDomExtractorTests();
totalPassed += r3.passed;
totalFailed += r3.failed;
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
