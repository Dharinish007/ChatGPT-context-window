/**
 * Unit Tests for live data sources
 *
 * 1. /backend-api is called with the bearer token from /api/auth/session
 * 2. Plan type is read from the session; the token never appears in exposed state
 * 3. 401 triggers one session refresh + retry
 * 4. When our fetch fails, the conversation captured from the page's own request is used
 * 5. Failures are backed off instead of refetched on every DOM mutation
 */

import { ConversationClient } from '../../content/conversation-client.js';

const TREE = {
  conversation_id: 'c-1',
  current_node: 'n2',
  default_model_slug: 'gpt-5-5',
  mapping: {
    n1: { id: 'n1', parent: null, children: ['n2'], message: { id: 'm1', author: { role: 'user' }, content: { parts: ['hi'] } } },
    n2: { id: 'n2', parent: 'n1', children: [], message: { id: 'm2', author: { role: 'assistant' }, content: { parts: ['hello'] }, metadata: { model_slug: 'gpt-5-5-thinking' } } }
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {} });
    return handler(String(url), init, calls);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

export async function runLiveSourcesTests() {
  console.log('--- Running Live Data Source Tests (session, bearer, capture) ---');
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

  // 1 + 2. Bearer token from session, plan from session, token not exposed
  await withFetch((url, init) => {
    if (url.endsWith('/api/auth/session')) return json({ accessToken: 'secret-token', account: { planType: 'plus' } });
    if (url.includes('/backend-api/conversation/')) {
      return init.headers.Authorization === 'Bearer secret-token' ? json(TREE) : json({ detail: 'Unauthorized' }, 401);
    }
    return json({}, 404);
  }, async () => {
    const client = new ConversationClient({ baseUrl: 'https://chatgpt.com' });
    const res = await client.fetchConversation('c-1');
    assert('Conversation API succeeds with bearer token from /api/auth/session', res.success === true);
    assert('Plan type read from session', client.session?.planType === 'plus');
    assert('Session state exposed to the UI never contains the token', !JSON.stringify(client.session).includes('secret-token'));
    const norm = client.normalizeConversation(res.data);
    assert('Latest assistant model slug wins', norm.modelSlug === 'gpt-5-5-thinking');
  });

  // 3. 401 -> session refresh -> retry
  await withFetch((url, init, calls) => {
    const sessionCalls = calls.filter(c => c.url.endsWith('/api/auth/session')).length;
    if (url.endsWith('/api/auth/session')) return json({ accessToken: `tok-${sessionCalls}` });
    if (url.includes('/backend-api/conversation/')) {
      return init.headers.Authorization === 'Bearer tok-2' ? json(TREE) : json({}, 401);
    }
    return json({}, 404);
  }, async (calls) => {
    const client = new ConversationClient({ baseUrl: 'https://chatgpt.com' });
    const res = await client.fetchConversation('c-1');
    assert('Expired token: session refreshed once and request retried', res.success === true &&
      calls.filter(c => c.url.endsWith('/api/auth/session')).length === 2);
  });

  // 4 + 5. Our fetch fails -> captured page copy is used; without capture, failure is backed off
  await withFetch((url) => {
    if (url.endsWith('/api/auth/session')) return json({}, 403);
    return json({}, 401);
  }, async (calls) => {
    const client = new ConversationClient({ baseUrl: 'https://chatgpt.com' });

    const first = await client.fetchConversation('c-9');
    const before = calls.length;
    const second = await client.fetchConversation('c-9');
    assert('Failure reported with a readable reason', first.success === false && /Unauthorized/.test(first.error));
    assert('Repeated failure is backed off (no new requests)', second.success === false && calls.length === before);

    client.ingestConversation('c-1', TREE);
    client.cache.clear(); // Force the network path; capture must still rescue it
    const rescued = await client.fetchConversation('c-1');
    assert('Captured page response used when direct fetch fails', rescued.success === true && rescued.fromCapture === true);
  });

  return { passed, failed };
}
