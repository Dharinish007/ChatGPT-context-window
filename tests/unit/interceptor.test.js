/**
 * Unit Tests for the MAIN-world network interceptor (content/network-interceptor.js)
 *
 * Runs the real script inside a sandboxed fake window and checks what it posts to the bridge:
 * 1. Delta v1 SSE stream (add message + p/o appends + bare {"v"} appends + patch ops)
 * 2. "auto" model hint is not reported as a model
 * 3. Only the exact conversation POST endpoints are parsed as streams
 * 4. accounts/check plan_type nested under .account is extracted
 */

import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const interceptorCode = fs.readFileSync(path.resolve(__dirname, '../../content/network-interceptor.js'), 'utf8');

function sseResponse(events) {
  const body = events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function loadInterceptor(respond) {
  const posted = [];
  const window = {
    location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/' },
    fetch: async (url, init) => respond(url, init),
    postMessage: (msg) => posted.push(msg),
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); }
  };
  const listeners = [];
  vm.runInNewContext(interceptorCode, { window, URL, TextDecoder, Response, setTimeout, console });
  // Simulates the isolated-world content script connecting later (document_idle)
  const ping = () => listeners.forEach(fn => fn({ source: window, data: { source: 'CHATGPT_CONTEXT_MONITOR_ISOLATED', type: 'PING' } }));
  return { window, posted, ping };
}

const settle = () => new Promise(r => setTimeout(r, 20));

export async function runInterceptorTests() {
  console.log('--- Running MAIN-World Network Interceptor Tests ---');
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

  // 1 + 2. Delta v1 stream on /backend-api/f/conversation with model "auto"
  {
    const { window, posted } = loadInterceptor(() => sseResponse([
      { o: 'add', v: { conversation_id: 'c-1', message: { id: 'm-1', author: { role: 'assistant' }, content: { parts: [''] }, metadata: { model_slug: 'gpt-5-6-sol' } } } },
      { p: '/message/content/parts/0', o: 'append', v: 'Hello' },
      { v: ', world' },
      { o: 'patch', v: [{ p: '/message/content/parts/0', o: 'append', v: '!' }, { p: '/message/status', o: 'replace', v: 'finished_successfully' }] },
      '[DONE]'
    ]));

    const res = await window.fetch('https://chatgpt.com/backend-api/f/conversation', {
      method: 'POST',
      body: JSON.stringify({ model: 'auto', messages: [{ id: 'u-1', author: { role: 'user' }, content: { content_type: 'text', parts: ['Hi'] } }] })
    });
    await res.text(); // Page consumes its own copy
    await settle();

    const chunks = posted.filter(m => m.eventType === 'STREAM_CHUNK');
    const lastText = chunks.length ? chunks[chunks.length - 1].payload.text : '';
    const done = posted.find(m => m.eventType === 'GENERATION_DONE');
    const request = posted.find(m => m.eventType === 'CONVERSATION_REQUEST');

    assert('/backend-api/f/conversation POST is observed as a prompt', Boolean(request) && request.payload.userMessage.text === 'Hi');
    assert('"auto" model hint is not reported as a model', request && request.payload.model === null);
    assert('Delta v1 text (append + bare v + patch) is fully accumulated', lastText === 'Hello, world!');
    assert('Status replace op is not appended as text', !lastText.includes('finished_successfully'));
    assert('Model slug from added message reaches GENERATION_DONE', done && done.payload.modelSlug === 'gpt-5-6-sol');
  }

  // 3. Sibling POST (gen_title) is not parsed as a stream
  {
    const { window, posted } = loadInterceptor(() => new Response('{"title":"x"}', { status: 200 }));
    await window.fetch('https://chatgpt.com/backend-api/conversation/gen_title/abc', { method: 'POST', body: '{}' });
    await settle();
    assert('gen_title POST is not treated as a conversation stream', !posted.some(m => m.eventType === 'STREAM_STARTED'));
  }

  // 4. accounts/check nested plan_type
  {
    const { window, posted } = loadInterceptor(() => new Response(JSON.stringify({
      accounts: { default: { account: { plan_type: 'plus', structure: 'personal' } } }
    }), { status: 200 }));
    await window.fetch('https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27', { method: 'GET' });
    await settle();
    const plan = posted.find(m => m.eventType === 'ACCOUNT_PLAN_OBSERVED');
    assert('Plan read from accounts[x].account.plan_type (not "structure")', plan && plan.payload.planType === 'plus');
  }

  // 4b. Early events are replayed when the isolated listener connects late
  {
    const tree = { conversation_id: '0a1b2c3d-4e5f', mapping: { a: { id: 'a', message: null } } };
    const { window, posted, ping } = loadInterceptor((url) => new Response(JSON.stringify(
      url.includes('accounts') ? { accounts: { default: { account: { plan_type: 'pro' } } } } : tree
    ), { status: 200 }));
    await window.fetch('https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27', { method: 'GET' });
    await window.fetch('https://chatgpt.com/backend-api/conversation/0a1b2c3d-4e5f', { method: 'GET' });
    await settle();
    posted.length = 0; // Pretend nobody was listening yet
    ping();
    const plan = posted.find(m => m.eventType === 'ACCOUNT_PLAN_OBSERVED');
    const conv = posted.find(m => m.eventType === 'CONVERSATION_LOADED');
    assert('Plan event replayed to a late listener', plan && plan.payload.planType === 'pro');
    assert('Page-loaded conversation (full tree) replayed to a late listener', conv && conv.payload.data && conv.payload.conversationId === '0a1b2c3d-4e5f');
  }

  // 5. /backend-api/memories is not mistaken for /backend-api/me
  {
    const { window, posted } = loadInterceptor(() => new Response(JSON.stringify({ plan_type: 'pro' }), { status: 200 }));
    await window.fetch('https://chatgpt.com/backend-api/memories', { method: 'GET' });
    await settle();
    assert('/backend-api/memories does not emit a plan event', !posted.some(m => m.eventType === 'ACCOUNT_PLAN_OBSERVED'));
  }

  return { passed, failed };
}
