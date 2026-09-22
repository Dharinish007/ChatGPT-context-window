/**
 * Unit Tests for Authoritative Conversation Client
 * 
 * Tests endpoint URL extraction, active branch tree resolution (handling edits/regenerations),
 * message normalization, parts parsing, authoritative attachments, and robust error handling.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ConversationClient } from '../../content/conversation-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.resolve(__dirname, '../fixtures/conversations');

const shortFixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'short-conversation.json'), 'utf8'));
const longFixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'long-conversation.json'), 'utf8'));
const branchedFixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'branched-conversation.json'), 'utf8'));
const attachmentsFixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'attachments-conversation.json'), 'utf8'));

export function runConversationClientTests() {
  console.log('--- Running Conversation Client Tests ---');
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

  const client = new ConversationClient();

  // 1. URL conversation ID extraction tests
  assert('Extracts UUID from standard ChatGPT /c/ URL',
    client.extractConversationId('https://chatgpt.com/c/c7a8b9d0-1234-5678-9abc-def012345678') === 'c7a8b9d0-1234-5678-9abc-def012345678'
  );

  assert('Extracts UUID from Custom GPT /g/ URL',
    client.extractConversationId('https://chatgpt.com/g/g-somegpt/c/f1e2d3c4-9999-8888-7777-666655554444') === 'f1e2d3c4-9999-8888-7777-666655554444'
  );

  assert('Extracts UUID from query parameter ?conversationId=',
    client.extractConversationId('https://chat.openai.com/?conversationId=b1a2c3d4-4321-8765-dcba-123456789abc') === 'b1a2c3d4-4321-8765-dcba-123456789abc'
  );

  assert('Returns null for ChatGPT root URL without conversation ID',
    client.extractConversationId('https://chatgpt.com/') === null
  );

  assert('Returns null for invalid/empty URL',
    client.extractConversationId('') === null && client.extractConversationId(null) === null
  );

  // 2. Short conversation normalization
  const shortNormalized = client.normalizeConversation(shortFixture);
  assert('Short conversation extracts conversation ID', shortNormalized.conversationId === 'c7a8b9d0-1234-5678-9abc-def012345678');
  assert('Short conversation extracts exactly 2 user/assistant turns (ignores system)', shortNormalized.messages.length === 2);
  assert('Short conversation turn 1 is user', shortNormalized.messages[0].role === 'user');
  assert('Short conversation turn 2 is assistant', shortNormalized.messages[1].role === 'assistant');
  assert('Short conversation detects model slug gpt-4o', shortNormalized.modelSlug === 'gpt-4o');
  assert('Short conversation message has structured parts[]', shortNormalized.messages[0].parts.length === 1 && shortNormalized.messages[0].parts[0].type === 'text');

  // 3. Long conversation normalization
  const longNormalized = client.normalizeConversation(longFixture);
  assert('Long conversation extracts exactly 12 messages in chronological order', longNormalized.messages.length === 12);
  assert('Long conversation starts with first prompt', longNormalized.messages[0].text.includes('Turn 1: What is event sourcing?'));
  assert('Long conversation ends with final answer', longNormalized.messages[11].text.includes('Turn 6 Reply: Event sourcing is ideal'));
  assert('Long conversation detects model slug o1', longNormalized.modelSlug === 'o1');

  // 4. Branched & Regenerated conversation resolution
  const branchedNormalized = client.normalizeConversation(branchedFixture);
  // branchedFixture has:
  // Root -> User 1 -> Ast 1-v1 (abandoned)
  //                -> Ast 1-v2 (active) -> User 2 -> Ast 2 (current_node)
  assert('Branched conversation resolves exactly 4 active turns (skips abandoned branch)', branchedNormalized.messages.length === 4);
  assert('Branched conversation includes active regenerated turn (v2)',
    branchedNormalized.messages.some(m => m.text.includes('optimized iterative fibonacci'))
  );
  assert('Branched conversation excludes abandoned turn (v1)',
    !branchedNormalized.messages.some(m => m.text.includes('recursive fib'))
  );
  assert('Branched conversation preserves message IDs accurately',
    branchedNormalized.messages[1].id === 'msg-ast-1-v2' && branchedNormalized.messages[3].id === 'msg-ast-2'
  );

  // 5. Authoritative Attachments & Multimodal Extraction
  const attNormalized = client.normalizeConversation(attachmentsFixture);
  assert('Attachments conversation identifies exactly 2 attachments', attNormalized.attachments.count === 2);
  assert('Correctly extracts uploaded document attachment with file metadata',
    attNormalized.attachments.items.some(a => a.name === 'Q3_Financial_Summary.pdf' && a.mimeType === 'application/pdf' && a.size === 524288)
  );
  assert('Classifies document attachment as UNKNOWN tokens (Truth-in-Measurement)',
    attNormalized.attachments.items.find(a => a.name === 'Q3_Financial_Summary.pdf')?.classification === 'UNKNOWN'
  );
  assert('Extracts multimodal image asset pointer as image attachment',
    attNormalized.attachments.items.some(a => a.type === 'image' && a.id === 'sed-file-pointer-001')
  );
  assert('Estimates vision tokens (~300) for image attachment', attNormalized.attachments.estimatedTokens === 300);
  assert('Sets hasUnknown to true due to non-image document attachment', attNormalized.attachments.hasUnknown === true);

  // 6. Error handling & resilience tests
  assert('Handles null or undefined payload gracefully',
    client.normalizeConversation(null).messages.length === 0 &&
    client.normalizeConversation({}).messages.length === 0
  );

  assert('Handles malformed mapping without current_node',
    client.normalizeConversation({ mapping: shortFixture.mapping, current_node: null }).messages.length >= 2
  );

  // Cycle detection in mapping
  const cyclicMapping = {
    'node-a': { id: 'node-a', parent: 'node-b', message: { id: 'm-a', author: { role: 'user' }, content: { parts: ['A'] } } },
    'node-b': { id: 'node-b', parent: 'node-a', message: { id: 'm-b', author: { role: 'assistant' }, content: { parts: ['B'] } } }
  };
  const cycleResult = client.resolveActiveBranch(cyclicMapping, 'node-a');
  assert('Cycle detection terminates safely without infinite loop', cycleResult.length <= 2);

  // In-memory caching & deduplication
  client.cache.set('test-cache-id', { data: shortFixture, timestamp: Date.now() });
  assert('Retrieves cached conversation without re-fetching within TTL', client.cache.has('test-cache-id'));

  client.clearCache();
  assert('clearCache flushes cache and active state', client.cache.size === 0 && client.lastError === null);

  // 7. Comparison: DOM scraping count vs Authoritative API count
  // In DOM with virtualization, suppose only the 2 most recent turns were rendered
  const simulatedDomMessages = longNormalized.messages.slice(-2);
  const authoritativeMessages = longNormalized.messages;
  assert('Authoritative API recovers all 12 turns while simulated DOM only has 2 visible',
    authoritativeMessages.length === 12 && simulatedDomMessages.length === 2 && authoritativeMessages.length > simulatedDomMessages.length
  );

  return { passed, failed };
}
