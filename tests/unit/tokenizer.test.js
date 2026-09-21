/**
 * Unit Tests for Local Tokenizer
 */

import { Tokenizer } from '../../engine/tokenizer.js';

export function runTokenizerTests() {
  console.log('--- Running Tokenizer Tests ---');
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

  const tokenizer = new Tokenizer();

  // Test 1: Empty and null inputs
  assert('Empty string returns 0 tokens', tokenizer.countTokens('') === 0);
  assert('Null input returns 0 tokens', tokenizer.countTokens(null) === 0);

  // Test 2: Basic English sentence
  const basicText = 'Hello world! How are you today?';
  const basicCount = tokenizer.countTokens(basicText);
  // ~7-9 tokens
  assert('Basic English tokenization in realistic range', basicCount >= 6 && basicCount <= 10);

  // Test 3: Contractions
  const contractionText = "It's we'll they'd shouldn't";
  const contractionCount = tokenizer.countTokens(contractionText);
  assert('Contractions properly segmented into subwords', contractionCount >= 7 && contractionCount <= 12);

  // Test 4: Code blocks & symbols
  const codeText = `def calculate_sum(a: int, b: int) -> int:\n    return a + b\n`;
  const codeCount = tokenizer.countTokens(codeText);
  assert('Python code snippet tokenized cleanly', codeCount >= 18 && codeCount <= 26);

  // Test 5: Numbers and punctuation
  const numText = 'Invoice #982348 dated 2026-09-21: total $4,582.50 USD.';
  const numCount = tokenizer.countTokens(numText);
  assert('Numbers and punctuation segmented', numCount >= 15 && numCount <= 24);

  // Test 6: Multilingual & CJK
  const cjkText = 'こんにちは世界！ ChatGPT コンテキストモニター';
  const cjkCount = tokenizer.countTokens(cjkText);
  assert('CJK characters tokenized with proper byte weighting', cjkCount >= 10 && cjkCount <= 35);

  // Test 7: Message Caching
  const msgId = 'test-msg-123';
  const sampleMsg = 'This is a message to test deterministic LRU caching performance.';
  const count1 = tokenizer.countMessageTokens(msgId, sampleMsg);
  
  // Subsequent call should hit cache
  const count2 = tokenizer.countMessageTokens(msgId, sampleMsg);
  assert('Cached message token count matches initial count', count1 === count2);

  // Modify text with same ID: cache should invalidate and recompute
  const updatedMsg = 'This is a message to test deterministic LRU caching performance with extra text.';
  const count3 = tokenizer.countMessageTokens(msgId, updatedMsg);
  assert('Modified text with same ID invalidates cache and yields higher count', count3 > count1);

  // Test 8: Performance benchmark
  const longText = 'The quick brown fox jumps over the lazy dog. '.repeat(500); // ~4,500 words
  const t0 = performance.now();
  const longCount = tokenizer.countTokens(longText);
  const t1 = performance.now();
  const durationMs = t1 - t0;
  assert(`High-throughput performance: 4.5K words in ${durationMs.toFixed(2)}ms (< 25ms target)`, durationMs < 25);
  assert('Long text token estimate is proportional', longCount > 4000 && longCount < 6000);

  return { passed, failed };
}
