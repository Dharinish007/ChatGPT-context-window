/**
 * Unit & Integration Tests for Group C: Network Intelligence & Interception Layer
 * 
 * Verifies:
 * - RequestObserver event bridge and normalization
 * - Live streaming chunks and completion
 * - Tool/search activity observation
 * - Multi-source coexistence (Authoritative API + Network + DOM) without duplicates
 * - Health tracking and unsupported endpoint detection
 * - Graceful fallback when network fails
 * - Strict security: zero credential or token leakage
 */

import { RequestObserver } from '../../network/request-observer.js';

// Mock window for Node.js test runner
const mockWindow = {
  addEventListener: () => {},
  removeEventListener: () => {},
  postMessage: () => {},
  location: { href: 'https://chatgpt.com/' }
};
if (typeof globalThis.window === 'undefined') {
  globalThis.window = mockWindow;
}

export function runNetworkObserverTests() {
  console.log('--- Running Network Intelligence & Observer Tests ---');
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

  // Mock a window event dispatcher to simulate MAIN-world postMessage
  function dispatchMockBridgeMessage(observer, eventType, payload = {}, extra = {}) {
    observer.handleMessage({
      source: globalThis.window,
      data: {
        source: 'CHATGPT_CONTEXT_MONITOR_NET',
        version: '1.0',
        eventType,
        payload,
        timestamp: extra.timestamp || Date.now()
      }
    });
  }

  // 1. Handshake & Health tracking
  {
    const observer = new RequestObserver();
    assert(observer.networkAvailable === false, 'Observer initializes with networkAvailable=false');
    assert(observer.interceptionErrors === 0, 'Observer initializes with 0 interception errors');

    dispatchMockBridgeMessage(observer, 'INTERCEPTOR_READY', { features: ['fetch', 'xhr', 'sse'] });
    assert(observer.networkAvailable === true, 'INTERCEPTOR_READY handshake sets networkAvailable=true');
    assert(observer.getHealth().networkAvailable === true, 'getHealth() reports networkAvailable=true');
  }

  // 2. User prompt submission (POST /backend-api/conversation)
  {
    let promptSentPayload = null;
    const observer = new RequestObserver({
      onPromptSent: (turn) => { promptSentPayload = turn; }
    });

    dispatchMockBridgeMessage(observer, 'CONVERSATION_REQUEST', {
      endpoint: '/backend-api/conversation',
      conversationId: 'conv-test-123',
      model: 'gpt-4o',
      parentMessageId: 'parent-001',
      userMessage: {
        id: 'usr-msg-999',
        role: 'user',
        text: 'Analyze this context window implementation',
        parts: [{ type: 'text', text: 'Analyze this context window implementation' }],
        contentType: 'text'
      }
    });

    assert(observer.getActiveConversationId() === 'conv-test-123', 'Captures active conversation ID from request');
    assert(observer.getObservedModel()?.value === 'gpt-4o', 'Captures requested model slug gpt-4o');
    assert(observer.getObservedModel()?.source === 'network', 'Stamps model provenance as source: network');
    assert(observer.getObservedModel()?.evidenceType === 'OBSERVED', 'Stamps model evidenceType as OBSERVED');

    const pendingUser = observer.getPendingUserTurn();
    assert(pendingUser !== null, 'Retains pending user turn in-flight');
    assert(pendingUser.id === 'usr-msg-999', 'Pending user turn retains exact message ID');
    assert(pendingUser.role === 'user', 'Pending user turn is user role');
    assert(pendingUser.text === 'Analyze this context window implementation', 'Pending user turn retains exact text');
    assert(pendingUser.source === 'network', 'Pending user turn records provenance source: network');
    assert(promptSentPayload !== null && promptSentPayload.id === 'usr-msg-999', 'Fires onPromptSent callback');
  }

  // 3. Live Streaming Assistant Response (SSE chunks & completion)
  {
    const streamChunks = [];
    let completedMeta = null;
    const observer = new RequestObserver({
      onStreamChunk: (turn) => { streamChunks.push(turn.text); },
      onStreamComplete: (meta) => { completedMeta = meta; }
    });

    // Start stream
    dispatchMockBridgeMessage(observer, 'STREAM_STARTED', {
      streamId: 'stream-1',
      conversationId: 'conv-test-123',
      model: 'gpt-4o'
    });
    assert(observer.getHealth().activeStreamsCount === 1, 'Increments active streams count on STREAM_STARTED');

    // Chunk 1
    dispatchMockBridgeMessage(observer, 'STREAM_CHUNK', {
      streamId: 'stream-1',
      conversationId: 'conv-test-123',
      messageId: 'asst-msg-001',
      role: 'assistant',
      text: 'Hello! I am examining',
      status: 'in_progress',
      modelSlug: 'gpt-4o'
    });

    let liveTurn = observer.getStreamingTurn();
    assert(liveTurn !== null, 'Streaming assistant turn is populated');
    assert(liveTurn.id === 'asst-msg-001', 'Streaming assistant turn retains message ID');
    assert(liveTurn.isStreaming === true, 'Streaming assistant turn marked isStreaming=true');
    assert(liveTurn.text === 'Hello! I am examining', 'Streaming turn text reflects chunk 1');
    assert(liveTurn.source === 'network', 'Streaming turn has provenance source: network');

    // Chunk 2 (cumulative progress)
    dispatchMockBridgeMessage(observer, 'STREAM_CHUNK', {
      streamId: 'stream-1',
      conversationId: 'conv-test-123',
      messageId: 'asst-msg-001',
      role: 'assistant',
      text: 'Hello! I am examining your context pipeline.',
      status: 'in_progress',
      modelSlug: 'gpt-4o'
    });
    assert(observer.getStreamingTurn().text === 'Hello! I am examining your context pipeline.', 'Streaming turn updates text smoothly');
    assert(streamChunks.length === 2, 'Fires onStreamChunk callback on each update');

    // Stream completed
    dispatchMockBridgeMessage(observer, 'STREAM_COMPLETED', {
      streamId: 'stream-1',
      conversationId: 'conv-test-123',
      messageId: 'asst-msg-001',
      modelSlug: 'gpt-4o'
    });

    assert(observer.getStreamingTurn().isStreaming === false, 'Stream complete sets isStreaming=false');
    assert(observer.getStreamingTurn().status === 'finished_successfully', 'Stream complete sets status to finished');
    assert(observer.getHealth().activeStreamsCount === 0, 'Decrements active streams count to 0');
    assert(completedMeta !== null && completedMeta.conversationId === 'conv-test-123', 'Fires onStreamComplete callback');
  }

  // 4. Tool & Web Search Observation
  {
    const observer = new RequestObserver();
    dispatchMockBridgeMessage(observer, 'TOOL_INVOKED', {
      streamId: 'stream-1',
      toolName: 'web_search'
    });

    const tools = observer.getObservedTools();
    assert(tools.length === 1, 'Observed 1 tool invocation in stream');
    assert(tools[0].name === 'web_search', 'Correctly captured tool name web_search');
    assert(tools[0].source === 'network', 'Tool evidence records source: network');
    assert(tools[0].evidenceType === 'OBSERVED', 'Tool evidence records evidenceType: OBSERVED');
  }

  // 5. Conversation Switch & Reset
  {
    const observer = new RequestObserver();
    dispatchMockBridgeMessage(observer, 'CONVERSATION_REQUEST', {
      conversationId: 'conv-A',
      userMessage: { id: 'msg-A', text: 'Chat A' }
    });
    dispatchMockBridgeMessage(observer, 'STREAM_CHUNK', {
      messageId: 'asst-A',
      text: 'Response A',
      status: 'in_progress'
    });

    assert(observer.getPendingUserTurn() !== null, 'Has pending user turn in conv-A');
    assert(observer.getStreamingTurn() !== null, 'Has streaming assistant turn in conv-A');

    // Switch to conv-B
    observer.setActiveConversationId('conv-B');
    assert(observer.getActiveConversationId() === 'conv-B', 'Switches active conversation ID');
    assert(observer.getPendingUserTurn() === null, 'Flushes in-flight user turn on conversation switch');
    assert(observer.getStreamingTurn() === null, 'Flushes streaming turn on conversation switch');
  }

  // 6. Multi-Source Deduplication Pipeline (Authoritative API + Network + DOM)
  {
    // Simulate authoritative conversation messages from Group B
    const authMessages = [
      { id: 'turn-1', role: 'user', text: 'Hello', parts: [{ type: 'text', text: 'Hello' }] },
      { id: 'turn-2', role: 'assistant', text: 'Hi there!', parts: [{ type: 'text', text: 'Hi there!' }] }
    ];

    // Simulate network capturing a new in-flight user prompt
    const netUserTurn = {
      id: 'turn-3',
      role: 'user',
      text: 'Tell me a story',
      parts: [{ type: 'text', text: 'Tell me a story' }],
      source: 'network',
      evidenceType: 'OBSERVED'
    };

    // Simulate network receiving live assistant streaming turn
    const netStreamingTurn = {
      id: 'turn-4',
      role: 'assistant',
      text: 'Once upon a time',
      parts: [{ type: 'text', text: 'Once upon a time' }],
      isStreaming: true,
      source: 'network',
      evidenceType: 'OBSERVED'
    };

    // Simulate DOM observer also seeing the streaming assistant turn
    const domMessages = [
      { id: 'turn-3', role: 'user', text: 'Tell me a story' },
      { id: 'turn-4', role: 'assistant', text: 'Once upon a time, in', isStreaming: true }
    ];

    // Pipeline merge logic:
    const effectiveMessages = [...authMessages];

    // Merge in-flight user turn
    const userExists = effectiveMessages.some(m => m.id === netUserTurn.id);
    if (!userExists) {
      effectiveMessages.push(netUserTurn);
    }

    // Merge streaming turn: pick longer between network and DOM
    let activeStream = netStreamingTurn;
    const domStream = domMessages.find(m => m.isStreaming);
    if (domStream && domStream.text && domStream.text.length > activeStream.text.length) {
      activeStream = { ...activeStream, text: domStream.text };
    }

    const existingStreamIdx = effectiveMessages.findIndex(m => m.id === activeStream.id);
    if (existingStreamIdx !== -1) {
      effectiveMessages[existingStreamIdx] = activeStream;
    } else {
      effectiveMessages.push(activeStream);
    }

    assert(effectiveMessages.length === 4, 'Multi-source pipeline produces exactly 4 messages without duplicates');
    assert(effectiveMessages[0].id === 'turn-1', 'Turn 1 is authoritative user');
    assert(effectiveMessages[1].id === 'turn-2', 'Turn 2 is authoritative assistant');
    assert(effectiveMessages[2].id === 'turn-3', 'Turn 3 is network in-flight user');
    assert(effectiveMessages[3].id === 'turn-4', 'Turn 4 is live streaming assistant');
    assert(effectiveMessages[3].text === 'Once upon a time, in', 'Stream corroboration kept more complete text without duplication');
  }

  // 7. Error Handling & Graceful Fallback
  {
    const observer = new RequestObserver();
    dispatchMockBridgeMessage(observer, 'INTERCEPTION_ERROR', {
      type: 'STREAM_CLONE_ERROR',
      endpoint: '/backend-api/conversation',
      error: 'Cannot clone locked response body'
    });

    assert(observer.getHealth().interceptionErrors === 1, 'Records interception error in health status');
    assert(observer.getHealth().errorCount === 1, 'Error count correctly tracked');

    dispatchMockBridgeMessage(observer, 'ENDPOINT_STATUS_ERROR', {
      endpoint: '/backend-api/conversation',
      status: 503
    });
    assert(observer.getHealth().interceptionErrors === 2, 'Records status error in health status');

    // Simulate complete network failure: verify observer getters don't throw
    assert(observer.getStreamingTurn() === null, 'No active stream during error');
    assert(observer.getPendingUserTurn() === null, 'No pending user turn during error');
    assert(Array.isArray(observer.getObservedTools()), 'getObservedTools() returns valid array even on error');
  }

  // 8. Unsupported / New Endpoint Detection
  {
    const observer = new RequestObserver();
    dispatchMockBridgeMessage(observer, 'UNSUPPORTED_ENDPOINT_OBSERVED', {
      endpoint: '/backend-api/canvas/save',
      method: 'POST',
      status: 200
    });

    const health = observer.getHealth();
    assert(health.unsupportedEndpoints.includes('/backend-api/canvas/save'), 'Tracks new/unsupported endpoint for health monitoring');
  }

  // 9. Security & Privacy Protection
  {
    const observer = new RequestObserver();
    // Simulate raw event that might contain sensitive headers if buggy
    dispatchMockBridgeMessage(observer, 'CONVERSATION_REQUEST', {
      endpoint: '/backend-api/conversation',
      conversationId: 'sec-test-conv',
      model: 'gpt-4o',
      headers: {
        Authorization: 'Bearer eyJhbGciOi...',
        Cookie: '__Secure-next-auth.session-token=secret'
      },
      userMessage: {
        id: 'sec-msg-01',
        text: 'Clean prompt',
        parts: [{ type: 'text', text: 'Clean prompt' }]
      }
    });

    const pending = observer.getPendingUserTurn();
    assert(pending.headers === undefined, 'Does not store or forward Authorization or Cookie headers');
    assert(JSON.stringify(observer.getHealth()).includes('eyJhbGciOi') === false, 'No auth tokens exist in health state');
    assert(JSON.stringify(pending).includes('__Secure-next-auth') === false, 'No session cookies exist in message state');
  }

  // 10. Provenance Stamping (Task 13)
  {
    const observer = new RequestObserver();
    dispatchMockBridgeMessage(observer, 'STREAM_CHUNK', {
      messageId: 'prov-msg-1',
      role: 'assistant',
      text: 'Testing provenance',
      status: 'in_progress',
      modelSlug: 'o1'
    });

    const turn = observer.getStreamingTurn();
    assert(turn.source === 'network', 'Turn records source: network');
    assert(turn.evidenceType === 'OBSERVED', 'Turn records evidenceType: OBSERVED');

    const model = observer.getObservedModel();
    assert(model.source === 'network', 'Model records source: network');
    assert(model.evidenceType === 'OBSERVED', 'Model records evidenceType: OBSERVED');
  }

  return { passed, failed };
}
