/**
 * Part 1 (final fixes) - load delay, loading state, refresh, update triggers, popup removal
 *
 * Runs the real coordinator / conversation client / DOM observer / service worker with only the
 * I/O edges stubbed. Widget layout (section order, confidence dropdown, refresh button) needs a real
 * DOM and is checked in scripts/verify-chrome.js.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ContentScriptCoordinator } from '../../content/content-main.js';
import { ConversationClient } from '../../content/conversation-client.js';
import { ChatGPTDOMObserver } from '../../content/chatgpt-dom.js';
import { toWidgetState } from '../../content/widget-state.js';
import { loadServiceWorker } from './reliability.test.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
const DB = JSON.parse(fs.readFileSync(path.join(root, 'config/model-limits.json'), 'utf8'));

const CONV_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const CONV_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function tree(conversationId, turns) {
  const mapping = { root: { id: 'root', parent: null, children: [], message: null } };
  let parent = 'root';
  turns.forEach((t, i) => {
    const nid = `n${i}`;
    mapping[parent].children.push(nid);
    mapping[nid] = {
      id: nid, parent, children: [],
      message: { id: `m-${conversationId.slice(0, 4)}-${i}`, author: { role: t.role }, content: { content_type: 'text', parts: [t.text] }, metadata: t.slug ? { model_slug: t.slug } : {} }
    };
    parent = nid;
  });
  return { conversation_id: conversationId, current_node: parent, mapping };
}

const EMPTY_DOC = {
  querySelector: () => null,
  querySelectorAll: () => [],
  cookie: '',
  documentElement: { classList: { contains: () => false } },
  body: null
};

/** Coordinator with only I/O stubbed; `env.api[id]` is the saved conversation, `env.pending` holds a fetch open. */
function harness({ url = CONV_A, api = {}, session = { ok: true, status: 200, planType: 'plus' }, dom = [] } = {}) {
  const c = new ContentScriptCoordinator(DB);
  const env = { url, api, session, dom, status: 500, fetchCalls: [], widget: [] };
  c.overlayUI = { mount() {}, render() {}, update(vm) { env.widget.push(vm); } };
  c.syncState = (s) => { env.synced = s; };
  c.conversationClient.extractConversationId = () => env.url;
  c.conversationClient.getSession = async (opts = {}) => { env.sessionForced = env.sessionForced || Boolean(opts.force); return env.session; };
  c.conversationClient.fetchConversation = async (id, opts = {}) => {
    env.fetchCalls.push({ id, force: Boolean(opts.force) });
    if (env.pending) await env.pending;
    return env.api[id] ? { success: true, data: env.api[id] } : { success: false, error: `HTTP error ${env.status}`, status: env.status };
  };
  c.messageExtractor.extractMessages = () => env.dom;
  c.modelDetector.detectRawModelString = () => null;
  c.modelDetector.detect = () => c.modelDetector.resolveModel(null);
  c.planDetector.detect = () => ({ value: 'unknown', source: 'unknown', evidenceType: 'UNKNOWN' });
  const run = async (event) => { await c.handleDOMChange(event); return c.latestState; };
  return { c, env, run };
}

export async function runFinalFixesTests() {
  console.log('--- Running Part 1 Final Fixes Tests (load, loading state, refresh, triggers, popup) ---');
  let passed = 0;
  let failed = 0;
  const assert = (name, cond) => {
    if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; } else { console.error(`  ❌ [FAIL] ${name}`); failed++; }
  };

  const saved = { document: globalThis.document, window: globalThis.window, location: globalThis.location, fetch: globalThis.fetch };
  globalThis.document = EMPTY_DOC;
  globalThis.window = { location: { href: 'https://chatgpt.com/', origin: 'https://chatgpt.com', pathname: '/' }, addEventListener() {}, removeEventListener() {}, postMessage() {} };
  globalThis.location = globalThis.window.location;

  const convA = tree(CONV_A, [{ role: 'user', text: 'Explain photosynthesis briefly.' }, { role: 'assistant', text: 'Plants turn light into sugar.', slug: 'gpt-5-6' }]);
  const convB = tree(CONV_B, [{ role: 'user', text: 'What is a qubit?' }, { role: 'assistant', text: 'A quantum bit.', slug: 'gpt-5-6' }]);

  try {
    // ------------------------------------------------------------ 2. no misleading zero state
    {
      // Saved conversation, API failed and page not rendered yet: loading, not "0 tokens"
      const { env, run } = harness({ api: {} });
      const s = await run();
      const vm = toWidgetState(s, { provider: 'ChatGPT' });
      assert('Existing conversation with no turns from any source is marked awaitingData', s.observables.awaitingData === true);
      assert('Widget shows the loading state, not 0 tokens / 0 messages', vm.ready === false && vm.percentage === null);
      assert('Loading view still carries diagnostics and the conversation id', vm.diagnostics !== null && vm.conversationId === CONV_A);
      assert('No first-data time recorded while still loading', s.diagnostics.firstDataAtMs === null);

      // Page renders the turns: correct state appears
      env.dom = [{ id: 'd1', role: 'user', text: 'Explain photosynthesis briefly.' }, { id: 'd2', role: 'assistant', text: 'Plants turn light into sugar.' }];
      const s2 = await run();
      assert('Once the page renders turns, real numbers are shown', toWidgetState(s2).ready === true && s2.tokens.totalMeasurable > 0);
      assert('First-data time is recorded for load-delay diagnostics', typeof s2.diagnostics.firstDataAtMs === 'number');
    }
    {
      // API data arrives: correct state
      const { env, run } = harness({ api: {} });
      await run();
      env.api[CONV_A] = convA;
      const s = await run();
      assert('Once the API copy is available, real numbers are shown', toWidgetState(s).ready === true && s.observables.dataSource === 'authoritative' && s.tokens.totalMeasurable > 0);
    }
    {
      // A deleted / missing conversation (404) is final, not "still loading"
      const { env, run } = harness({ api: {} });
      env.status = 404;
      const s = await run();
      assert('404 conversation is not shown as loading forever', s.observables.awaitingData === false && toWidgetState(s).ready === true);
    }
    {
      // A brand-new empty chat really is 0 tokens
      const { run } = harness({ url: null });
      const s = await run();
      assert('Empty new chat (no conversation id) shows its real 0 state', s.observables.awaitingData === false && toWidgetState(s).ready === true && s.tokens.totalMeasurable === 0);
    }
    {
      // Badge stays blank while loading (never "0%")
      const sw = loadServiceWorker({ value: 1 });
      await sw.send({ type: 'CONTEXT_UPDATED', payload: { utilization: { percentage: 0 }, observables: { awaitingData: true } } }, 1);
      await sw.send({ type: 'CONTEXT_UPDATED', payload: { utilization: { percentage: 12 }, observables: { awaitingData: false } } }, 2);
      assert('Toolbar badge is blank while the conversation is loading', sw.badges[1] === '' && sw.badges[2] === '12%');
    }

    // ------------------------------------------------------------ switching conversations shows loading, not the old numbers
    {
      const { c, env, run } = harness({ api: { [CONV_A]: convA, [CONV_B]: convB } });
      await run();
      env.widget.length = 0;
      env.url = CONV_B;
      let release;
      env.pending = new Promise(r => { release = r; });
      const pass = run();
      await sleep(5);
      assert('Opening another conversation switches the widget to loading immediately', env.widget.length === 1 && env.widget[0].ready === false);
      release();
      env.pending = null;
      const s = await pass;
      assert('...then shows the new conversation once read', s.observables.conversationId === CONV_B && env.widget.at(-1).ready === true);

      // A new chat that receives its id from its own stream keeps its live counts (no loading flash)
      const h2 = harness({ url: null, api: {} });
      await h2.run();
      h2.c.requestObserver.handleMessage({ source: globalThis.window, data: { source: 'CHATGPT_CONTEXT_MONITOR_NET', eventType: 'CONVERSATION_REQUEST',
        payload: { conversationId: CONV_A, userMessage: { id: 'u-live', text: 'Hi there', parts: [{ type: 'text', text: 'Hi there' }] } } } });
      h2.env.widget.length = 0;
      const s2 = await h2.run();
      assert('New chat getting its id from the network does not flash the loading state', h2.env.widget.every(v => v.ready !== false) && s2.tokens.totalMeasurable > 0);
    }

    // ------------------------------------------------------------ 3. refresh button
    {
      const { c, env, run } = harness({ api: { [CONV_A]: convA } });
      await run();
      const before = c.latestState.tokens.totalMeasurable;
      env.api[CONV_A] = tree(CONV_A, [
        { role: 'user', text: 'Explain photosynthesis briefly.' }, { role: 'assistant', text: 'Plants turn light into sugar.', slug: 'gpt-5-6' },
        { role: 'user', text: 'And respiration?' }, { role: 'assistant', text: 'Cells burn sugar with oxygen to release energy.', slug: 'gpt-5-6' }
      ]);
      env.fetchCalls.length = 0;
      await c.refresh();
      assert('Refresh forces a fresh read of the current conversation', env.fetchCalls[0]?.id === CONV_A && env.fetchCalls[0]?.force === true);
      assert('Refresh updates the displayed state immediately', c.latestState.tokens.totalMeasurable > before && c.latestState.observables.messagesCount === 4);

      env.session = { ok: false, status: 0, planType: null };
      c.conversationClient.session = env.session;
      env.sessionForced = false;
      await c.refresh();
      assert('Refresh also retries a failed session read', env.sessionForced === true);
    }
    {
      // Refresh bypasses the real client's cache and failure back-off
      const client = new ConversationClient();
      let calls = 0;
      globalThis.fetch = async (url) => {
        if (String(url).includes('/api/auth/session')) return new Response(JSON.stringify({ accessToken: 't', account: { planType: 'plus' } }), { status: 200 });
        calls++;
        return calls === 1 ? new Response('{}', { status: 500 }) : new Response(JSON.stringify(convA), { status: 200 });
      };
      const failedRead = await client.fetchConversation(CONV_A);
      const backedOff = await client.fetchConversation(CONV_A);
      const callsBeforeRefresh = calls;
      const forced = await client.fetchConversation(CONV_A, { force: true });
      assert('Failed read is backed off for automatic passes', !failedRead.success && !backedOff.success && callsBeforeRefresh === 1);
      assert('Forced (Refresh) read skips the back-off and succeeds', forced.success && calls === 2);
    }

    // ------------------------------------------------------------ 1. initial load delay
    {
      // Prefetch at document_start: the first pass reuses the same request (no second round trip)
      const c = new ContentScriptCoordinator(DB);
      globalThis.window.location.href = `https://chatgpt.com/c/${CONV_A}`;
      const hits = { session: 0, conversation: 0 };
      globalThis.fetch = async (url) => {
        if (String(url).includes('/api/auth/session')) { hits.session++; return new Response(JSON.stringify({ accessToken: 't', account: { planType: 'plus' } }), { status: 200 }); }
        hits.conversation++;
        await sleep(30);
        return new Response(JSON.stringify(convA), { status: 200 });
      };
      c.overlayUI = { mount() {}, render() {}, update() {} };
      c.syncState = () => {};
      c.messageExtractor.extractMessages = () => [];
      c.modelDetector.detectRawModelString = () => null;
      c.modelDetector.detect = () => c.modelDetector.resolveModel(null);
      c.planDetector.detect = () => ({ value: 'unknown', source: 'unknown', evidenceType: 'UNKNOWN' });
      c.prefetch();
      assert('prefetch() starts the network listener at document_start', c.requestObserver._isListening === true);
      assert('prefetch() starts the conversation read before the DOM is ready', c.conversationClient.activeFetches.has(CONV_A));
      await c.handleDOMChange();
      assert('First pass reuses the prefetched read: one session + one conversation request', hits.session === 1 && hits.conversation === 1);
      assert('First pass shows API data from the prefetch', c.latestState.observables.dataSource === 'authoritative');
      c.requestObserver.stop();
      globalThis.window.location.href = 'https://chatgpt.com/';
    }
    {
      // Cache freshness is measured from the response, so a slow (or early) read is reused, not refetched
      const client = new ConversationClient({ cacheTtlMs: 40 });
      let calls = 0;
      globalThis.fetch = async (url) => {
        if (String(url).includes('/api/auth/session')) return new Response(JSON.stringify({ accessToken: 't' }), { status: 200 });
        calls++;
        await sleep(60); // slower than the TTL
        return new Response(JSON.stringify(convA), { status: 200 });
      };
      await client.fetchConversation(CONV_A);
      const again = await client.fetchConversation(CONV_A);
      assert('A read slower than the cache TTL is still reused right after it lands', again.fromCache === true && calls === 1);
    }

    // ------------------------------------------------------------ 4. update triggers
    {
      // Continuous mutations must not postpone updates indefinitely (trailing-only debounce did)
      globalThis.document = { ...EMPTY_DOC, querySelector: () => null };
      let updates = 0;
      const obs = new ChatGPTDOMObserver({ onChange: () => { updates++; }, debounceMs: 120, maxWaitMs: 200 });
      const t0 = Date.now();
      let firstAt = null;
      while (Date.now() - t0 < 700) {
        obs.handleMutations([]);
        await sleep(30); // a mutation every 30 ms, faster than the 120 ms debounce
        if (updates && firstAt === null) firstAt = Date.now() - t0;
      }
      await sleep(250);
      assert('Updates keep firing during continuous page mutations (max wait)', updates >= 3);
      assert('First update arrives within the max wait, not after mutations stop', firstAt !== null && firstAt < 350);

      // A single quiet mutation still uses the normal short debounce
      updates = 0;
      const t1 = Date.now();
      obs.handleMutations([]);
      while (!updates && Date.now() - t1 < 500) await sleep(10);
      assert('A single mutation updates after the short debounce', updates === 1 && Date.now() - t1 < 250);
      globalThis.document = EMPTY_DOC;
    }

    // ------------------------------------------------------------ 5. old popup removed
    {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
      const cs = manifest.content_scripts.find(s => s.js.includes('content/content-script.js'));
      assert('Manifest declares no popup (no duplicate context UI)', manifest.action && !manifest.action.default_popup);
      assert('Popup files are removed', !fs.existsSync(path.join(root, 'popup')));
      assert('Packaging no longer ships popup files', !fs.readFileSync(path.join(root, 'scripts/package-extension.js'), 'utf8').includes('popup/'));
      assert('Content script is injected at document_start (earlier network reads)', cs.run_at === 'document_start');
      assert('Bundle calls prefetch() before waiting for the DOM', /coordinator\.prefetch\(\);[\s\S]*DOMContentLoaded/.test(fs.readFileSync(path.join(root, 'content/content-script.js'), 'utf8')));

      const sw = loadServiceWorker({ value: 7 });
      sw.on.clicked({ id: 7 });
      assert('Toolbar icon click toggles the in-page widget instead of opening a popup', sw.tabs.sent.length === 1 && sw.tabs.sent[0].id === 7 && sw.tabs.sent[0].msg.type === 'TOGGLE_OVERLAY');
      const reply = await Promise.race([sw.send({ type: 'GET_POPUP_STATE' }), sleep(50).then(() => 'no-reply')]);
      assert('Popup state endpoint is gone', reply === 'no-reply');
    }
  } finally {
    Object.assign(globalThis, saved);
  }

  console.log(`\n  Part 1 Final Fixes Results: ${passed} passed, ${failed} failed`);
  return { passed, failed };
}
