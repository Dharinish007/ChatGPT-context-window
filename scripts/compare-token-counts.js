/**
 * Tokenizer Comparison Tool: Old Heuristic vs New Tiktoken BPE
 */

import { Tokenizer as OldTokenizer } from '../engine/tokenizer.js';
import { Tiktoken } from 'js-tiktoken/lite';
import cl100k_base from 'js-tiktoken/ranks/cl100k_base';
import o200k_base from 'js-tiktoken/ranks/o200k_base';

const encCl = new Tiktoken(cl100k_base);
const encO2 = new Tiktoken(o200k_base);
const oldTokenizer = new OldTokenizer();

const testSamples = [
  {
    name: 'Normal English',
    text: 'The quick brown fox jumps over the lazy dog. How are you doing today?'
  },
  {
    name: 'Punctuation & Symbols',
    text: 'Hello, world! (How are you? [Fine; thanks/okay] - "yes"... -- \'really\')'
  },
  {
    name: 'Numbers & Currency',
    text: 'Invoice #982348 dated 2026-09-21: total $4,582.50 USD across 1,000 items.'
  },
  {
    name: 'Unicode / Emoji / Multilingual',
    text: '👨‍👩‍👧‍👦 🎉 ✨ こんにちは世界！ Bonjour le monde! éàüñç'
  },
  {
    name: 'Code Block (Python)',
    text: '```python\ndef calculate_sum(a: int, b: int) -> int:\n    # Returns the sum of a and b\n    return a + b\n```'
  },
  {
    name: 'Code Block (JavaScript)',
    text: 'const fn = async (req, res) => { const { id } = req.params; return res.json({ id, ok: true }); };'
  },
  {
    name: 'Long Message (100 repetitions)',
    text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(100)
  },
  {
    name: 'Contractions',
    text: "It's we'll they'd shouldn't couldn't won't I'm you're"
  }
];

console.log('========================================================================================');
console.log('  TOKENIZER ACCURACY COMPARISON: OLD (Heuristic) vs NEW (Real Tiktoken BPE)');
console.log('========================================================================================');
console.log(
  'Sample'.padEnd(30) +
  'Old (Heuristic)'.padEnd(18) +
  'New (cl100k)'.padEnd(16) +
  'New (o200k)'.padEnd(16) +
  'Diff (Old vs o200k)'
);
console.log('-'.repeat(95));

for (const sample of testSamples) {
  const oldTokens = oldTokenizer.countTokens(sample.text);
  const cl100kTokens = encCl.encode(sample.text, 'all').length;
  const o200kTokens = encO2.encode(sample.text, 'all').length;
  const diff = oldTokens - o200kTokens;
  const pct = ((diff / o200kTokens) * 100).toFixed(1);
  const diffStr = (diff >= 0 ? `+${diff}` : `${diff}`) + ` (${pct}%)`;

  console.log(
    sample.name.padEnd(30) +
    String(oldTokens).padEnd(18) +
    String(cl100kTokens).padEnd(16) +
    String(o200kTokens).padEnd(16) +
    diffStr
  );
}

console.log('========================================================================================\n');
