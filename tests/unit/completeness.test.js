/**
 * Unit & Integration Tests for Group D: Context Completeness & Virtualization Reconciliation
 * 
 * Verifies:
 * - Detection of virtualized / partial DOM when older turns are unmounted
 * - Reconciliation: Authoritative API (12 turns) vs DOM (2 turns)
 * - Prevention of silent token undercounting
 * - Regenerated branch and active tree traversal
 * - Streaming in-flight turn completeness
 * - API unavailable / offline fallback with lower bound flagging
 * - New chat initialization with full completeness
 */

import { ContextCalculator } from '../../engine/context-calculator.js';
import { ConfidenceEngine, ConfidenceLevel } from '../../engine/confidence-engine.js';
import { ConversationClient } from '../../content/conversation-client.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.resolve(__dirname, '..', 'fixtures', 'conversations');

export function runCompletenessTests() {
  console.log('--- Running Context Completeness & Virtualization Tests ---');
  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ [PASS] ${message}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${message}`);
      failed++;
    }
  }

  const client = new ConversationClient();

  // 1. Full DOM == Full Conversation (e.g. 4 turns in authoritative, 4 turns in DOM)
  {
    const authMessages = [
      { id: 'm1', role: 'user', tokens: 50 },
      { id: 'm2', role: 'assistant', tokens: 100 },
      { id: 'm3', role: 'user', tokens: 40 },
      { id: 'm4', role: 'assistant', tokens: 120 }
    ];
    const rawDomMessages = [
      { id: 'm1', role: 'user', tokens: 50 },
      { id: 'm2', role: 'assistant', tokens: 100 },
      { id: 'm3', role: 'user', tokens: 40 },
      { id: 'm4', role: 'assistant', tokens: 120 }
    ];

    const renderedTurnCount = rawDomMessages.length;
    const authoritativeTurnCount = authMessages.length;
    const domIsPartial = authoritativeTurnCount > renderedTurnCount;
    const virtualizationGap = Math.max(0, authoritativeTurnCount - renderedTurnCount);

    const completeness = {
      conversationComplete: true,
      domIsPartial,
      renderedTurnCount,
      authoritativeTurnCount,
      virtualizationGap,
      completenessSource: 'authoritative_api'
    };

    const state = ContextCalculator.calculate({
      messages: authMessages,
      model: { id: 'gpt-4o', displayName: 'GPT-4o', contextWindow: 128000, encoding: 'o200k_base' },
      completeness,
      isPartial: false
    });

    assert(state.completeness.conversationComplete === true, 'Full conversation marked conversationComplete=true');
    assert(state.completeness.domIsPartial === false, 'Full DOM is NOT partial (domIsPartial=false)');
    assert(state.completeness.renderedTurnCount === 4, 'Rendered turn count is 4');
    assert(state.completeness.authoritativeTurnCount === 4, 'Authoritative turn count is 4');
    assert(state.completeness.virtualizationGap === 0, 'Virtualization gap is 0');
    assert(state.completeness.completenessSource === 'authoritative_api', 'Completeness source is authoritative_api');
    assert(state.tokens.conversation === 310, 'Total tokens calculated over all 4 turns (310)');
  }

  // 2. DOM Virtualization: DOM contains only 2 of 12 turns (Prevents silent undercounting!)
  {
    const longRaw = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'long-conversation.json'), 'utf8'));
    const normalized = client.normalizeConversation(longRaw);
    assert(normalized.messages.length === 12, 'Authoritative long conversation has 12 turns');

    // Simulate virtualized DOM that has scrolled and only contains the last 2 turns
    const virtualizedDomMessages = [
      { id: normalized.messages[10].id, role: 'user', text: normalized.messages[10].text, tokens: 40 },
      { id: normalized.messages[11].id, role: 'assistant', text: normalized.messages[11].text, tokens: 150 }
    ];

    const renderedTurnCount = virtualizedDomMessages.length; // 2
    const authoritativeTurnCount = normalized.messages.length; // 12
    const domIsPartial = authoritativeTurnCount > renderedTurnCount; // true
    const virtualizationGap = authoritativeTurnCount - renderedTurnCount; // 10

    const completeness = {
      conversationComplete: true,
      domIsPartial,
      renderedTurnCount,
      authoritativeTurnCount,
      virtualizationGap,
      completenessSource: 'authoritative_api'
    };

    // Effective messages uses the Authoritative Base of all 12 turns
    const tokenizedMessages = normalized.messages.map((m, i) => ({
      id: m.id,
      role: m.role,
      tokens: 100 // 100 tokens per turn = 1200 total
    }));

    const state = ContextCalculator.calculate({
      messages: tokenizedMessages,
      model: { id: 'o1', displayName: 'o1', contextWindow: 200000, encoding: 'o200k_base' },
      completeness,
      isPartial: false // Authoritative API provides full ground truth
    });

    assert(state.completeness.domIsPartial === true, 'Correctly flags DOM as partial/virtualized');
    assert(state.completeness.virtualizationGap === 10, 'Accurately measures 10 unmounted/virtualized turns');
    assert(state.completeness.conversationComplete === true, 'Conversation context is complete via API');
    assert(state.tokens.conversation === 1200, 'Context calculated over all 12 turns (1200 tokens) rather than 2 DOM turns (200 tokens)');
    assert(state.confidence.level === ConfidenceLevel.HIGH || state.confidence.level === ConfidenceLevel.MEDIUM, 'Maintains verified confidence because full authoritative ground truth was used');
  }

  // 3. Virtualized Older Messages: Preserves unmounted turns across pagination
  {
    const completeness = {
      conversationComplete: true,
      domIsPartial: true,
      renderedTurnCount: 3,
      authoritativeTurnCount: 15,
      virtualizationGap: 12,
      completenessSource: 'authoritative_api'
    };

    const state = ContextCalculator.calculate({
      messages: new Array(15).fill(null).map((_, i) => ({ id: `t-${i}`, role: i % 2 === 0 ? 'user' : 'assistant', tokens: 50 })),
      model: { id: 'gpt-4o', contextWindow: 128000 },
      completeness,
      isPartial: false
    });

    assert(state.tokens.conversation === 750, 'Preserves all 15 turns totaling 750 tokens');
    assert(state.observables.virtualizationGap === 12, 'Observables record exact virtualization gap (12)');
  }

  // 4. Branch Changes & Regenerated Turns (Only active branch counted, abandoned excluded)
  {
    const branchedRaw = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'branched-conversation.json'), 'utf8'));
    const normalized = client.normalizeConversation(branchedRaw);

    assert(normalized.messages.length === 4, 'Active branch resolves exactly 4 active turns');
    const hasAbandonedV1 = normalized.messages.some(m => m.id === 'msg-ast-1-v1');
    const hasActiveV2 = normalized.messages.some(m => m.id === 'msg-ast-1-v2');
    assert(!hasAbandonedV1, 'Abandoned turn (v1) is excluded from completeness');
    assert(hasActiveV2, 'Active regenerated turn (v2) is included in completeness');

    const state = ContextCalculator.calculate({
      messages: normalized.messages.map(m => ({ id: m.id, role: m.role, tokens: 60 })),
      model: { id: 'gpt-4o', contextWindow: 128000 },
      completeness: {
        conversationComplete: true,
        domIsPartial: false,
        renderedTurnCount: 4,
        authoritativeTurnCount: 4,
        virtualizationGap: 0,
        completenessSource: 'authoritative_api'
      },
      isPartial: false
    });

    assert(state.tokens.conversation === 240, 'Calculates exact token total for active branch (240 tokens)');
  }

  // 5. Streaming State (In-flight turn merged with full authoritative base)
  {
    const baseMessages = [
      { id: 'm1', role: 'user', tokens: 30 },
      { id: 'm2', role: 'assistant', tokens: 80 }
    ];
    const liveStreamingTurn = { id: 'm3-stream', role: 'assistant', tokens: 45, isStreaming: true };

    const effectiveMessages = [...baseMessages, liveStreamingTurn];
    const completeness = {
      conversationComplete: true,
      domIsPartial: false,
      renderedTurnCount: 3,
      authoritativeTurnCount: 2,
      virtualizationGap: 0,
      completenessSource: 'in_flight_stream'
    };

    const state = ContextCalculator.calculate({
      messages: effectiveMessages,
      model: { id: 'gpt-4o', contextWindow: 128000 },
      completeness,
      isPartial: false
    });

    assert(state.completeness.conversationComplete === true, 'Streaming generation marked complete');
    assert(state.completeness.completenessSource === 'in_flight_stream', 'Completeness source is in_flight_stream');
    assert(state.tokens.conversation === 155, 'Includes in-flight streaming turn tokens (155 total)');
  }

  // 6. API Unavailable / Offline on Existing Chat (DOM fallback with lower bound penalty)
  {
    const domOnlyMessages = [
      { id: 'dom-1', role: 'user', tokens: 50 },
      { id: 'dom-2', role: 'assistant', tokens: 120 }
    ];

    const completeness = {
      conversationComplete: false,
      domIsPartial: true,
      renderedTurnCount: 2,
      authoritativeTurnCount: null,
      virtualizationGap: 0,
      completenessSource: 'dom_partial'
    };

    const state = ContextCalculator.calculate({
      messages: domOnlyMessages,
      model: { id: 'gpt-4o', contextWindow: 128000, source: 'verified' },
      completeness,
      isPartial: true // Flagged as partial because API failed on an existing multi-turn chat
    });

    assert(state.completeness.conversationComplete === false, 'API unavailable flags conversationComplete=false');
    assert(state.completeness.domIsPartial === true, 'DOM is marked domIsPartial=true');
    assert(state.completeness.completenessSource === 'dom_partial', 'Completeness source is dom_partial');
    assert(state.observables.isPartialConversation === true, 'isPartialConversation observable is true');
    assert(state.confidence.reasons.some(r => r.includes('partially loaded / virtualized in DOM')), 'Confidence engine includes partial/virtualized warning');
    assert(state.confidence.score <= 0.65, 'Confidence score penalizes unverified partial DOM');
  }

  // 7. New Chat with No Conversation ID
  {
    const newChatMessages = [
      { id: 'fresh-1', role: 'user', tokens: 25 }
    ];

    const completeness = {
      conversationComplete: true,
      domIsPartial: false,
      renderedTurnCount: 1,
      authoritativeTurnCount: null,
      virtualizationGap: 0,
      completenessSource: 'dom_complete'
    };

    const state = ContextCalculator.calculate({
      messages: newChatMessages,
      model: { id: 'gpt-4o', contextWindow: 128000 },
      completeness,
      isPartial: false // Fresh chat has all turns in DOM
    });

    assert(state.completeness.conversationComplete === true, 'New chat marked conversationComplete=true');
    assert(state.completeness.domIsPartial === false, 'New chat is NOT partial (domIsPartial=false)');
    assert(state.completeness.completenessSource === 'dom_complete', 'Completeness source is dom_complete');
    assert(state.tokens.conversation === 25, 'Calculates exact tokens for fresh turn (25)');
  }

  return { passed, failed };
}
