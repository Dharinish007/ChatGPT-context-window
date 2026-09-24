/**
 * Performance optimizations: every fast path must give exactly the same result as the slow one.
 *   - count-only BPE == js-tiktoken encode(text, 'all').length (both encodings, adversarial text)
 *   - message text reused until the element changes (mutation-driven invalidation)
 *   - strategy pruning picks the same winner as extracting every strategy
 *   - one grouped page query == one query per group
 *   - conversation copies are bounded
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Tokenizer } from '../../engine/tokenizer.js';
import { MessageExtractor } from '../../content/message-extractor.js';
import { queryGroups } from '../../content/tool-detector.js';
import { ConversationClient } from '../../content/conversation-client.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/conversations');

export function runPerformanceTests() {
  console.log('--- Running Performance Optimization Equivalence Tests ---');
  let passed = 0;
  let failed = 0;
  const assert = (name, cond) => {
    if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; } else { console.error(`  ❌ [FAIL] ${name}`); failed++; }
  };

  // ------------------------------------------------------------------ count-only BPE == reference encoder
  {
    const tk = new Tokenizer();
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pieces = ['a', 'Z', ' ', '  ', '\n', '\n\n', '\r\n', '\t', '0', '12', '345', '6789', '.', ',', '!', '?', '...', '—', '"', "'s", "n't",
      'é', 'ü', 'ß', 'Ω', '日本語', '中文', 'العربية', 'हिन्दी', '🙂', '👩‍💻', '🇮🇳', '\ud800', '\udc00', '<|endoftext|>', '<|fim_prefix|>',
      '<|endofprompt|>', 'function f(x) {', '=>', '    ', 'x'.repeat(200), '9'.repeat(50), ' '.repeat(40), 'https://example.com/a?b=c'];
    const samples = [];
    for (let i = 0; i < 600; i++) {
      let s = '';
      const n = 1 + Math.floor(rnd() * 30);
      for (let j = 0; j < n; j++) s += pieces[Math.floor(rnd() * pieces.length)];
      samples.push(s);
    }
    // Real conversation text from the fixtures
    for (const f of fs.readdirSync(fixtures)) {
      const json = JSON.parse(fs.readFileSync(path.join(fixtures, f), 'utf8'));
      for (const node of Object.values(json.mapping || {})) {
        for (const p of node.message?.content?.parts || []) if (typeof p === 'string' && p) samples.push(p);
      }
    }
    for (const enc of ['o200k_base', 'cl100k_base']) {
      const ref = tk.getEncoder(enc);
      const mismatches = samples.filter(s => tk.getCounter(enc).count(s) !== ref.encode(s, 'all').length);
      assert(`${enc}: count-only BPE equals js-tiktoken on ${samples.length} texts (unicode, emoji, lone surrogates, special tokens, long runs)`, mismatches.length === 0);
    }
    const long = samples.join('\n');
    assert('Whole corpus in one text: identical count', tk.countTokens(long, 'o200k_base') === tk.getEncoder('o200k_base').encode(long, 'all').length);

    const counter = tk.getCounter('o200k_base');
    const before = counter.stats.pieceHits;
    tk.countTokens('the same words again and again the same words', 'o200k_base');
    assert('Repeated words are counted once (piece cache hits)', counter.stats.pieceHits > before);
    assert('Rank table build time is measured', typeof tk.stats.initMs === 'number');
  }

  // ------------------------------------------------------------------ message text reuse + invalidation
  {
    const ex = new MessageExtractor();
    let cleans = 0;
    ex.cleanElementText = (el) => { cleans++; return el.textContent.trim(); };
    const turn = { nodeType: 1, parentElement: null, textContent: 'Hello world', getElementsByTagName: () => ({ length: 1 }) };
    const textNode = { nodeType: 3, parentElement: turn };

    ex._cleanText(turn);
    ex._cleanText(turn);
    assert('Untrusted mode: unchanged element reused (validated by its text)', cleans === 1 && ex.stats.reused === 1);
    turn.textContent = 'Hello world, again';
    assert('Untrusted mode: changed text is re-read', ex._cleanText(turn) === 'Hello world, again' && cleans === 2);

    ex.trustCache = true;
    let reads = 0;
    const watched = { nodeType: 1, parentElement: null, getElementsByTagName: () => ({ length: 1 }), get textContent() { reads++; return 'Streaming text'; } };
    ex._cleanText(watched);
    const readsAfterFirst = reads;
    ex._cleanText(watched);
    ex._cleanText(watched);
    assert('Trusted mode: unchanged element is not even read again', reads === readsAfterFirst);
    ex.invalidate({ nodeType: 3, parentElement: watched });
    ex._cleanText(watched);
    assert('Trusted mode: a mutation inside the element forces a re-read', reads > readsAfterFirst);

    ex._cleanText(turn);
    const c = cleans;
    ex.invalidate(textNode); // text node inside `turn`
    ex._cleanText(turn);
    assert('Invalidation walks up from text nodes to the message element', cleans === c + 1);
  }

  // ------------------------------------------------------------------ strategy pruning == extract-all
  {
    const ex = new MessageExtractor();
    // strategy index -> [elements matched, non-empty messages produced]
    const cases = [
      { shape: [[5, 5], [5, 4], [2, 2], [0, 0]], winner: 0 },
      { shape: [[3, 1], [4, 4], [4, 4], [0, 0]], winner: 1 },
      { shape: [[6, 2], [3, 3], [0, 0], [3, 3]], winner: 1 },
      { shape: [[0, 0], [0, 0], [0, 0], [0, 0]], winner: -1 },
      { shape: [[4, 1], [1, 1], [9, 2], [2, 2]], winner: 2 }
    ];
    for (const { shape, winner } of cases) {
      const extracted = [];
      const selectors = [];
      ex._topTurns = (root, selector) => {
        const i = selectors.length;
        selectors.push(selector);
        return Array.from({ length: shape[i][0] }, () => ({ strategy: i }));
      };
      ex._extractFrom = (turns) => {
        if (!turns.length) return [];
        const i = turns[0].strategy;
        extracted.push(i);
        return Array.from({ length: shape[i][1] }, (_, k) => ({ id: `${i}-${k}` }));
      };
      const result = ex.extractMessages({});
      // Reference: extract every strategy, keep the first with the most messages
      let ref = [];
      let refIndex = -1;
      shape.forEach(([, n], i) => { if (n > ref.length) { ref = Array.from({ length: n }, (_, k) => ({ id: `${i}-${k}` })); refIndex = i; } });
      const got = result.length ? Number(result[0].id.split('-')[0]) : -1;
      assert(`Strategy pruning picks the same winner as extracting all (${JSON.stringify(shape)})`, got === refIndex && got === winner && result.length === ref.length);
      if (JSON.stringify(shape) === JSON.stringify(cases[0].shape)) {
        assert('Strategies that cannot win are never extracted', !extracted.includes(2) && !extracted.includes(3));
      }
    }
  }

  // ------------------------------------------------------------------ one grouped query == one query per group
  {
    const mk = (tags) => ({ tags, matches(sel) { return sel.split(',').some(s => this.tags.includes(s.trim())); } });
    const els = [mk(['a']), mk(['b']), mk(['a', 'c']), mk(['d'])];
    let queries = 0;
    const root = { querySelectorAll(sel) { queries++; const parts = sel.split(',').map(s => s.trim()); return els.filter(e => e.tags.some(t => parts.includes(t))); } };
    const groups = ['a', 'b, c', 'e'];
    const got = queryGroups(root, groups);
    const expected = groups.map(g => root.querySelectorAll(g));
    assert('Grouped query: same elements per group as separate queries', JSON.stringify(got.map(g => g.map(e => e.tags))) === JSON.stringify(expected.map(g => g.map(e => e.tags))));
    queries = 0;
    queryGroups(root, groups);
    assert('Grouped query: one page traversal instead of one per group', queries === 1);
  }

  // ------------------------------------------------------------------ bounded conversation copies
  {
    const client = new ConversationClient();
    for (let i = 1; i <= 5; i++) client.ingestConversation(`conv-${i}`, { mapping: { a: {} }, n: i });
    assert('Only the 3 most recent conversation copies are kept (was unbounded)', client.cache.size === 3 && client.captured.size === 3 && !client.cache.has('conv-1') && client.cache.has('conv-5'));
    client.ingestConversation('conv-3', { mapping: { a: {} }, n: 33 });
    client.ingestConversation('conv-6', { mapping: { a: {} }, n: 6 });
    assert('Re-used conversation counts as recent (least recently used is dropped)', client.cache.has('conv-3') && !client.cache.has('conv-4'));
  }

  console.log(`\n  Performance Equivalence Results: ${passed} passed, ${failed} failed`);
  return { passed, failed };
}
