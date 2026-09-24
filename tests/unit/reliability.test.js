/**
 * Reliability regression tests for the ChatGPT data pipeline
 *
 * Covers: live user message, live streaming, final flush, rapid consecutive messages,
 * duplicates across DOM/network/API, tool messages, conversation switching, new conversation,
 * refresh/navigation, multiple tabs, out-of-order responses, missed early events,
 * failed sources with valid fallback.
 */

import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { RequestObserver } from '../../network/request-observer.js';
import { ConversationClient } from '../../content/conversation-client.js';
import { mergeLiveTurns } from '../../content/turn-merger.js';
import { ContentScriptCoordinator } from '../../content/content-main.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const interceptorCode = fs.readFileSync(path.resolve(__dirname, '../../content/network-interceptor.js'), 'utf8');
const serviceWorkerCode = fs.readFileSync(path.resolve(__dirname, '../../background/service-worker.js'), 'utf8');

// Real ChatGPT-style message ids (UUIDs are identical across request, stream, API and DOM)
const U1 = '11111111-1111-4111-8111-111111111111';
const A1 = '22222222-2222-4222-8222-222222222222';
const U2 = '33333333-3333-4333-8333-333333333333';
const A2 = '44444444-4444-4444-8444-444444444444';
const CONV_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const CONV_B = 'bbbbbbbb-0000-4000-8000-000000000002';

const settle = (ms = 20) => new Promise(r => setTimeout(r, ms));

/** Feeds bridge events into an observer the way window.postMessage would. */
function bridge(observer, eventType, payload) {
  observer.handleMessage({ source: globalThis.window, data: { source: 'CHATGPT_CONTEXT_MONITOR_NET', eventType, payload } });
}

function sse(events) {
  const body = events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status: 200 });
}

function loadInterceptor(respond) {
  const posted = [];
  const listeners = [];
  const window = {
    location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/' },
    fetch: async (url, init) => respond(url, init),
    postMessage: (msg) => posted.push(msg),
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); }
  };
  vm.runInNewContext(interceptorCode, { window, URL, TextDecoder, Response, setTimeout, console });
  const ping = () => listeners.forEach(fn => fn({ source: window, data: { source: 'CHATGPT_CONTEXT_MONITOR_ISOLATED', type: 'PING' } }));
  return { window, posted, ping };
}

function loadServiceWorker(activeTabId) {
  const store = {};
  const badges = {};
  const on = {};
  const chrome = {
    action: {
      setBadgeText: async ({ tabId, text }) => { badges[tabId] = text; },
      setBadgeBackgroundColor: async () => {}
    },
    runtime: {
      lastError: null,
      getManifest: () => ({ version: 'test' }),
      onInstalled: { addListener() {} },
      onMessage: { addListener(fn) { on.message = fn; } }
    },
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      session: {
        set: async (o) => { Object.assign(store, o); },
        get: async (k) => {
          const keys = Array.isArray(k) ? k : [k];
          return Object.fromEntries(keys.filter(x => x in store).map(x => [x, store[x]]));
        },
        remove: async (k) => { delete store[k]; }
      }
    },
    tabs: {
      onRemoved: { addListener(fn) { on.removed = fn; } },
      onUpdated: { addListener(fn) { on.updated = fn; } },
      query: async () => [{ id: activeTabId.value }],
      sendMessage: (id, msg, cb) => cb({ success: false })
    }
  };
  vm.runInNewContext(serviceWorkerCode, { chrome, console });
  const send = (msg, tabId) => new Promise(resolve => on.message(msg, { tab: tabId ? { id: tabId } : undefined }, resolve));
  return { store, badges, on, send };
}

export async function runReliabilityTests() {
  console.log('--- Running Pipeline Reliability Regression Tests ---');
  let passed = 0;
  let failed = 0;
  const assert = (name, cond) => {
    if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; } else { console.error(`  ❌ [FAIL] ${name}`); failed++; }
  };

  const prevWindow = globalThis.window;
  globalThis.window = globalThis.window || {};

  try {
    // ---------------------------------------------------------------- live capture (interceptor)
    {
      const { window, posted } = loadInterceptor(() => sse([
        { o: 'add', v: { conversation_id: CONV_A, message: { id: U1, author: { role: 'user' }, content: { parts: ['Hi'] } } } },
        { o: 'add', v: { message: { id: 'tool-1', author: { role: 'tool' }, content: { parts: [''] } } } },
        { p: '/message/content/parts/0', o: 'append', v: 'search results…' },
        { o: 'add', v: { message: { id: A1, author: { role: 'assistant' }, content: { parts: [''] }, metadata: { model_slug: 'gpt-5-6' } } } },
        { p: '/message/content/parts/0', o: 'append', v: 'Hello' },
        { v: ' there' }
        // connection closes WITHOUT [DONE]
      ]));
      const res = await window.fetch('https://chatgpt.com/backend-api/f/conversation', {
        method: 'POST', body: JSON.stringify({ messages: [{ id: U1, author: { role: 'user' }, content: { parts: ['Hi'] } }] })
      });
      await res.text();
      await settle();

      const chunks = posted.filter(m => m.eventType === 'STREAM_CHUNK').map(m => m.payload);
      const toolChunks = chunks.filter(c => c.messageId === 'tool-1');
      const final = chunks.filter(c => c.messageId === A1).pop();
      const dones = posted.filter(m => m.eventType === 'GENERATION_DONE');
      const keys = new Set(posted.filter(m => m.payload.streamKey).map(m => m.payload.streamKey));

      assert('Live user message captured from the request', posted.some(m => m.eventType === 'CONVERSATION_REQUEST' && m.payload.userMessage.id === U1));
      assert('Tool output streamed with role "tool", not user/assistant', toolChunks.length > 0 && toolChunks.every(c => c.role === 'tool'));
      assert('Previous message flushed when the next one starts (tool text not lost)', toolChunks.some(c => c.text === 'search results…'));
      assert('Stream closed without [DONE]: final text still flushed', final && final.text === 'Hello there' && final.status === 'finished_successfully');
      assert('Stream closed without [DONE]: exactly one GENERATION_DONE', dones.length === 1);
      assert('All events of one stream share a stable streamKey', keys.size === 1);
    }
    {
      // User presses stop mid-stream: partial text is kept
      const { window, posted } = loadInterceptor(() => {
        const enc = new TextEncoder();
        // Deliver two chunks, then fail on the next read (erroring in start() would drop the queue)
        const chunks = [
          `data: ${JSON.stringify({ o: 'add', v: { message: { id: A1, author: { role: 'assistant' }, content: { parts: [''] } } } })}\n\n`,
          `data: ${JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: 'Partial answer' })}\n\n`
        ];
        const stream = new ReadableStream({
          pull(c) {
            if (chunks.length) c.enqueue(enc.encode(chunks.shift()));
            // Abort a moment later, like a user pressing stop after text has arrived
            else return new Promise(r => setTimeout(r, 20)).then(() => c.error(new Error('AbortError')));
          }
        });
        return new Response(stream, { status: 200 });
      });
      const res = await window.fetch('https://chatgpt.com/backend-api/f/conversation', { method: 'POST', body: '{}' });
      await res.text().catch(() => {});
      await settle();
      const aborted = posted.filter(m => m.eventType === 'STREAM_CHUNK').pop();
      assert('Aborted stream keeps its partial text', aborted && aborted.payload.text === 'Partial answer' && aborted.payload.status === 'aborted');
    }

    // ---------------------------------------------------------------- observer: rapid messages, completion, switching
    {
      const refreshes = [];
      const obs = new RequestObserver({ onStreamComplete: (m) => refreshes.push(m) });
      obs.setActiveConversationId(CONV_A);
      bridge(obs, 'CONVERSATION_REQUEST', { conversationId: CONV_A, userMessage: { id: U1, text: 'first', parts: [{ type: 'text', text: 'first' }] } });
      bridge(obs, 'STREAM_CHUNK', { streamKey: 's1', conversationId: CONV_A, messageId: A1, role: 'assistant', text: 'reply one', status: 'finished_successfully' });
      bridge(obs, 'GENERATION_DONE', { streamKey: 's1', conversationId: CONV_A });
      bridge(obs, 'STREAM_COMPLETED', { streamKey: 's1', conversationId: CONV_A });
      bridge(obs, 'CONVERSATION_REQUEST', { conversationId: CONV_A, userMessage: { id: U2, text: 'second', parts: [{ type: 'text', text: 'second' }] } });
      bridge(obs, 'STREAM_CHUNK', { streamKey: 's2', conversationId: CONV_A, messageId: A2, role: 'assistant', text: 'reply tw', status: 'in_progress' });

      const turns = obs.getLiveTurns();
      assert('Rapid consecutive messages: all 4 live turns kept in order', turns.map(t => t.id).join() === [U1, A1, U2, A2].join());
      assert('Live assistant streaming turn marked streaming', turns[3].isStreaming === true && turns[1].isStreaming === false);
      assert('GENERATION_DONE + STREAM_COMPLETED for one stream refresh once', refreshes.length === 1);

      bridge(obs, 'STREAM_CHUNK', { streamKey: 's9', conversationId: CONV_B, messageId: 'late', role: 'assistant', text: 'from B', status: 'in_progress' });
      assert('Chunk from another conversation is ignored', !obs.getLiveTurns().some(t => t.id === 'late'));

      bridge(obs, 'CONVERSATION_LOADED', { conversationId: CONV_B, modelSlug: 'gpt-4o', data: { mapping: {} } });
      assert('Prefetched conversation does not become active or set the model',
        obs.getActiveConversationId() === CONV_A && obs.getObservedModel()?.value !== 'gpt-4o');

      bridge(obs, 'STREAM_CHUNK', { conversationId: CONV_A, messageId: A2, role: 'assistant', text: 'x', modelSlug: 'gpt-5-6', status: 'in_progress' });
      obs.setActiveConversationId(CONV_B);
      assert('Switching conversations clears turns, stream and model',
        obs.getLiveTurns().length === 0 && obs.getStreamingTurn() === null && obs.getObservedModel() === null);
      assert('Plan (account-level) survives a conversation switch', (() => {
        bridge(obs, 'ACCOUNT_PLAN_OBSERVED', { planType: 'go' });
        obs.setActiveConversationId(CONV_A);
        return obs.getObservedPlan()?.value === 'go';
      })());
    }
    {
      // New conversation: no id until the stream assigns one
      const obs = new RequestObserver();
      bridge(obs, 'CONVERSATION_REQUEST', { conversationId: null, userMessage: { id: U1, text: 'hello', parts: [{ type: 'text', text: 'hello' }] } });
      bridge(obs, 'STREAM_CHUNK', { conversationId: CONV_A, messageId: A1, role: 'assistant', text: 'Hi', status: 'in_progress' });
      assert('New conversation: id adopted from the first stream chunk', obs.getActiveConversationId() === CONV_A);
      assert('New conversation: first user message and reply both kept', obs.getLiveTurns().length === 2);
    }

    // ---------------------------------------------------------------- merge: duplicates, order, roles
    {
      const api = [
        { id: U1, role: 'user', text: 'yes' },
        { id: A1, role: 'assistant', text: 'Done.' }
      ];
      const live = [
        { id: U1, role: 'user', text: 'yes', conversationId: CONV_A },
        { id: A1, role: 'assistant', text: 'Done', isStreaming: false, conversationId: CONV_A },
        { id: U2, role: 'user', text: 'yes', conversationId: CONV_A },
        { id: A2, role: 'assistant', text: 'Again', isStreaming: true, conversationId: CONV_A },
        { id: 'tool-9', role: 'tool', text: 'output', conversationId: CONV_A },
        { id: 'sys', role: 'system', text: 'internal', conversationId: CONV_A },
        { id: 'other', role: 'user', text: 'leak', conversationId: CONV_B }
      ];
      const merged = mergeLiveTurns(api, live, { conversationId: CONV_A, baseIsFinal: true });
      assert('Same message from API + network counted once', merged.filter(m => m.id === U1).length === 1 && merged.filter(m => m.id === A1).length === 1);
      assert('Finished API copy wins over the network copy', merged.find(m => m.id === A1).text === 'Done.');
      assert('Genuinely repeated text ("yes" twice) is not discarded', merged.filter(m => m.text === 'yes').length === 2);
      assert('Order preserved: API turns, then new live turns', merged.map(m => m.id).slice(0, 4).join() === [U1, A1, U2, A2].join());
      assert('Tool output kept with role "tool"', merged.find(m => m.id === 'tool-9')?.role === 'tool');
      assert('System/internal turns are not counted', !merged.some(m => m.role === 'system'));
      assert('Turn from another conversation never merged', !merged.some(m => m.id === 'other'));

      // DOM fallback base with synthetic ids + network copies with real ids
      const dom = [
        { id: 'conversation-turn-1', role: 'user', text: 'Explain X' },
        { id: 'conversation-turn-2', role: 'assistant', text: 'X is a long', isStreaming: true }
      ];
      const net = [
        { id: U1, role: 'user', text: 'Explain X' },
        { id: A1, role: 'assistant', text: 'X is a longer answer', isStreaming: true }
      ];
      const m2 = mergeLiveTurns(dom, net, {});
      assert('DOM (synthetic id) + network (real id) of the same turns: no duplicates', m2.length === 2);
      assert('Streaming turn takes the longer text from either source', m2[1].text === 'X is a longer answer' && m2[1].isStreaming === true);
    }

    // ---------------------------------------------------------------- refresh / navigation (coordinator)
    {
      const c = new ContentScriptCoordinator({ models: {} });
      c.handleDOMChange = async () => {}; // Only conversation resolution is under test here
      let url = CONV_A;
      c.conversationClient.extractConversationId = () => url;

      assert('Refresh/open existing conversation: id from URL', c.resolveConversationId() === CONV_A);
      c.requestObserver.setActiveConversationId(CONV_A);
      bridge(c.requestObserver, 'STREAM_CHUNK', { conversationId: CONV_A, messageId: A1, role: 'assistant', text: 'old', status: 'in_progress' });

      url = null; // SPA navigation to "New chat"
      assert('Leaving a conversation for a new chat drops its id', c.resolveConversationId() === null);
      assert('...and its live turns (nothing carried into the new chat)', c.requestObserver.getLiveTurns().length === 0);

      bridge(c.requestObserver, 'STREAM_CHUNK', { conversationId: CONV_B, messageId: A2, role: 'assistant', text: 'new', status: 'in_progress' });
      assert('New chat: id taken from the network until the URL updates', c.resolveConversationId() === CONV_B);

      url = CONV_B; // URL catches up
      assert('URL update to the same new conversation keeps its live turns',
        c.resolveConversationId() === CONV_B && c.requestObserver.getLiveTurns().length === 1);

      url = CONV_A; // return to a previous conversation
      assert('Returning to a previous conversation resolves to it', c.resolveConversationId() === CONV_A);
    }

    // ---------------------------------------------------------------- out-of-order + fallback (API client)
    {
      const original = globalThis.fetch;
      let call = 0;
      const tree = (text) => ({ conversation_id: CONV_A, current_node: 'n1', mapping: { n1: { id: 'n1', parent: null, children: [], message: { id: U1, author: { role: 'user' }, content: { parts: [text] } } } } });
      globalThis.fetch = async (url) => {
        if (String(url).endsWith('/api/auth/session')) return new Response(JSON.stringify({ accessToken: 't' }), { status: 200 });
        call++;
        if (call === 1) { await settle(60); return new Response(JSON.stringify(tree('OLD')), { status: 200 }); }
        if (call === 2) return new Response(JSON.stringify(tree('NEW')), { status: 200 });
        return new Response('{}', { status: 500 });
      };
      try {
        const client = new ConversationClient({ baseUrl: 'https://chatgpt.com' });
        const slow = client.fetchConversation(CONV_A);
        const fresh = await client.fetchConversation(CONV_A, { force: true });
        await slow;
        const cached = client.cache.get(CONV_A).data.mapping.n1.message.content.parts[0];
        assert('Forced refresh does not reuse an older in-flight request', fresh.data.mapping.n1.message.content.parts[0] === 'NEW');
        assert('Late older response does not overwrite newer cached data', cached === 'NEW');

        client.cache.clear();
        const fallback = await client.fetchConversation(CONV_A); // call 3 -> 500
        assert('Failed API refresh falls back to last known-good data, not zero',
          fallback.success === true && fallback.fromCapture === true && fallback.data.mapping.n1.message.content.parts[0] === 'NEW');
      } finally {
        globalThis.fetch = original;
      }
    }

    // ---------------------------------------------------------------- missed early events + reconnect
    {
      const { window, posted, ping } = loadInterceptor((url) => new Response(JSON.stringify(
        String(url).includes('accounts') ? { accounts: { default: { account: { plan_type: 'go' } } } } : {}
      ), { status: 200 }));
      await window.fetch('https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27', { method: 'GET' });
      await settle();
      posted.length = 0;
      ping();
      const first = posted.filter(m => m.eventType === 'ACCOUNT_PLAN_OBSERVED').length;
      posted.length = 0;
      ping(); // content script re-initialized (e.g. extension reloaded)
      const second = posted.filter(m => m.eventType === 'ACCOUNT_PLAN_OBSERVED').length;
      assert('Early plan event replayed on first handshake', first === 1);
      assert('Replayed again when the listener reconnects', second === 1);
      assert('Only latest sticky events replayed (no stream chunks)', !posted.some(m => m.eventType === 'STREAM_CHUNK'));
    }

    // ---------------------------------------------------------------- multiple tabs + cleanup (service worker)
    {
      const active = { value: 2 };
      const sw = loadServiceWorker(active);
      await sw.send({ type: 'CONTEXT_UPDATED', payload: { utilization: { percentage: 10 }, tag: 'tab1' } }, 1);
      await sw.send({ type: 'CONTEXT_UPDATED', payload: { utilization: { percentage: 55 }, tag: 'tab2' } }, 2);
      const popup2 = await sw.send({ type: 'GET_POPUP_STATE' });
      active.value = 1;
      const popup1 = await sw.send({ type: 'GET_POPUP_STATE' });
      assert('Tab B update never overwrites tab A (popup per tab)', popup1.state?.tag === 'tab1' && popup2.state?.tag === 'tab2');
      assert('Badge is set per tab', sw.badges[1] === '10%' && sw.badges[2] === '55%');

      sw.on.removed(1);
      await settle();
      assert('Closing a tab removes its state', !('tab_state_1' in sw.store) && 'tab_state_2' in sw.store);

      sw.on.updated(2, { status: 'loading' });
      await settle();
      assert('Refresh / leaving ChatGPT clears the tab state and badge', !('tab_state_2' in sw.store) && sw.badges[2] === '');
    }
  } finally {
    globalThis.window = prevWindow;
  }

  return { passed, failed };
}
