/**
 * ChatGPT Context Monitor - Real-Chrome performance benchmark
 *
 * Serves a ChatGPT-like page with a long conversation (default 150 turns, ~450 KB of text) plus
 * mock /api/auth/session and /backend-api/conversation/{id} endpoints, runs the built content
 * script in headless Chrome and measures, from the outside (works on any version of the code):
 *   load    - time from script start to the first real numbers, main-thread blocking (long tasks)
 *   typing  - 8 s of typing in the chat input: analysis passes, API downloads, blocking time
 *   stream  - 6 s of a streamed reply (network chunks + DOM growth): update latency, blocking time
 *   idle    - 12 s with a small periodic page change: API re-downloads of an unchanged conversation
 *
 * Usage: node scripts/benchmark.js [turns]
 */

import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TURNS = Number(process.argv[2]) || 150;
const CONV = 'bbbbbbbb-1111-4222-8333-444444444444';
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- deterministic conversation
const words = 'context window token model reply streaming latency cache budget summary answer question detail example function value result system network page layout render'.split(' ');
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const sentence = (n) => Array.from({ length: n }, () => words[Math.floor(rand() * words.length)]).join(' ') + '.';
const turns = [];
for (let i = 0; i < TURNS; i++) {
  const user = i % 2 === 0;
  const text = user
    ? sentence(40)
    : [sentence(60), sentence(55), 'const total = items.reduce((sum, x) => sum + x.tokens, 0);\nconsole.log(total);', sentence(70), sentence(50)].join('\n\n');
  turns.push({ id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, role: user ? 'user' : 'assistant', text });
}
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const turnHtml = (t, i) => {
  const body = t.role === 'user'
    ? `<div class="whitespace-pre-wrap">${esc(t.text)}</div>`
    : `<div class="markdown prose">${t.text.split('\n\n').map(p => p.startsWith('const') ? `<pre><code>${esc(p)}</code></pre>` : `<p>${esc(p)}</p>`).join('')}<ul><li>point one</li><li>point two</li></ul></div>`;
  return `<section data-testid="conversation-turn-${i + 1}" data-turn="${t.role}"><div data-message-author-role="${t.role}" data-message-id="${t.id}"${t.role === 'assistant' ? ' data-message-model-slug="gpt-5-6"' : ''}>${body}<div class="toolbar"><button>Copy</button><button>Edit</button></div></div></section>`;
};
const page = `<!doctype html><html><head><title>bench</title></head><body style="margin:0;background:#fff">
<nav style="position:fixed;left:0;top:0;bottom:0;width:240px;overflow:auto">${Array.from({ length: 50 }, (_, i) => `<a href="#">Chat ${i}</a><br>`).join('')}</nav>
<header><button data-testid="model-switcher-dropdown">ChatGPT 5.6</button></header>
<main style="margin-left:260px;padding-bottom:160px">${turns.map(turnHtml).join('')}</main>
<form style="position:fixed;bottom:24px;left:50%;transform:translateX(-50%);width:560px"><div id="prompt-textarea" contenteditable="true" style="min-height:40px;border:1px solid #ccc"></div></form>
</body></html>`;

const tree = () => {
  const mapping = { root: { id: 'root', parent: null, children: [], message: null } };
  let parent = 'root';
  turns.forEach((t, i) => {
    const nid = `node-${i}`;
    mapping[parent].children.push(nid);
    mapping[nid] = { id: nid, parent, children: [], message: { id: t.id, author: { role: t.role }, content: { content_type: 'text', parts: [t.text] }, metadata: t.role === 'assistant' ? { model_slug: 'gpt-5-6' } : {} } };
    parent = nid;
  });
  return { conversation_id: CONV, current_node: parent, mapping, title: 'bench' };
};

// ---------------------------------------------------------------- mock server
const hits = { session: 0, conversation: 0 };
const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/auth/session')) {
    hits.session++;
    await delay(60);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ accessToken: 'bench-token', account: { planType: 'plus' } }));
  }
  if (req.url.startsWith(`/backend-api/conversation/${CONV}`)) {
    hits.conversation++;
    await delay(250); // server + transfer time of a long conversation
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(tree()));
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(page);
});

// ---------------------------------------------------------------- CDP
class CDP {
  constructor(url) { this.url = url; this.id = 0; this.cbs = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((ok, bad) => { this.ws.onopen = ok; this.ws.onerror = bad; });
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.cbs.has(m.id)) { const { ok, bad } = this.cbs.get(m.id); this.cbs.delete(m.id); m.error ? bad(m.error) : ok(m.result); }
    };
  }
  send(method, params = {}) {
    return new Promise((ok, bad) => { const id = ++this.id; this.cbs.set(id, { ok, bad }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

async function main() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
  const port = 9333;
  const chrome = spawn(CHROME_PATH, ['--headless=new', `--remote-debugging-port=${port}`, '--disable-gpu', '--no-first-run',
    `--user-data-dir=${profile}`, '--window-size=1280,800', 'about:blank']);
  try {
    let targets = [];
    for (let i = 0; i < 30 && !targets.some(t => t.type === 'page'); i++) {
      await delay(300);
      targets = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json()).catch(() => []);
    }
    const cdp = new CDP(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: `${origin}/c/${CONV}` });
    await delay(1500);

    const script = fs.readFileSync(process.env.BENCH_BUNDLE || path.join(rootDir, 'content', 'content-script.js'), 'utf8');
    await cdp.eval(`
      window.__updates = [];
      window.__longTasks = [];
      new PerformanceObserver(l => { for (const e of l.getEntries()) window.__longTasks.push({ start: e.startTime, dur: e.duration }); }).observe({ type: 'longtask', buffered: false });
      window.chrome = { runtime: {
        sendMessage: (m) => { if (m?.type === 'CONTEXT_UPDATED') window.__updates.push({ t: performance.now(), used: m.payload.tokens?.totalMeasurable, ready: !m.payload.observables?.awaitingData, perf: m.payload.diagnostics?.performance || null }); return Promise.resolve(); },
        onMessage: { addListener() {} }, getManifest: () => ({ version: 'bench' })
      }, storage: { session: { set: async () => {} } } };
      window.__t0 = performance.now();
      true
    `);
    await cdp.send('Runtime.evaluate', { expression: script });

    const blocking = (from, to) => `window.__longTasks.filter(e => e.start >= ${from} && e.start < ${to}).reduce((s, e) => s + e.dur, 0)`;
    const results = {};

    // ---- load
    await delay(6000);
    results.load = await cdp.eval(`(() => {
      const first = window.__updates.find(u => u.ready && u.used > 0);
      return { firstDataMs: first ? Math.round(first.t - window.__t0) : null, usedTokens: first?.used ?? null,
        blockingMs: Math.round(${blocking('window.__t0', 'window.__t0 + 6000')}),
        updates: window.__updates.length };
    })()`);
    results.load.apiDownloads = hits.conversation;

    // ---- typing in the chat input (should not trigger work: nothing sent yet)
    let before = { ...hits };
    const typing = await cdp.eval(`(async () => {
      const box = document.getElementById('prompt-textarea');
      const start = performance.now(); const n0 = window.__updates.length;
      for (let i = 0; i < 80; i++) { box.textContent += 'typing '; await new Promise(r => setTimeout(r, 100)); }
      await new Promise(r => setTimeout(r, 600));
      return { updates: window.__updates.length - n0, blockingMs: Math.round(${blocking('start', 'performance.now()')}) };
    })()`);
    results.typing = { ...typing, apiDownloads: hits.conversation - before.conversation };

    // ---- streamed reply: network chunks + DOM growth every 50 ms
    before = { ...hits };
    const stream = await cdp.eval(`(async () => {
      const ID = 'ffffffff-0000-4000-8000-00000000abcd';
      const post = (eventType, payload) => window.postMessage({ source: 'CHATGPT_CONTEXT_MONITOR_NET', eventType, payload, timestamp: Date.now() }, '*');
      const main = document.querySelector('main');
      main.insertAdjacentHTML('beforeend', '<section data-testid="conversation-turn-x" data-turn="assistant"><div data-message-author-role="assistant" data-message-id="' + ID + '"><div class="markdown result-streaming"></div></div></section>');
      const md = main.lastElementChild.querySelector('.markdown');
      post('STREAM_STARTED', { conversationId: '${CONV}', model: 'gpt-5-6', streamKey: 'k1' });
      const start = performance.now(); const n0 = window.__updates.length;
      const lat = []; let text = '';
      for (let i = 0; i < 60; i++) {
        text += 'streamed words arrive here quickly with more detail and numbers 12345 ';
        md.textContent = text;
        const sent = performance.now(); const len = text.length;
        post('STREAM_CHUNK', { conversationId: '${CONV}', messageId: ID, role: 'assistant', text, status: 'in_progress', streamKey: 'k1' });
        // latency: until the widget's token text changes after this chunk (what the user sees)
        const shown = await new Promise(r => {
          const el = document.getElementById('chatgpt-context-monitor-host').shadowRoot.querySelector('.tokens');
          const before = el.textContent;
          const mo = new MutationObserver(() => { if (el.textContent !== before) { mo.disconnect(); r(performance.now()); } });
          mo.observe(el, { childList: true, characterData: true, subtree: true });
          setTimeout(() => { mo.disconnect(); r(null); }, 1500);
        });
        if (shown !== null) lat.push(shown - sent);
      }
      const end = performance.now();
      lat.sort((a, b) => a - b);
      return { chunks: 60, updates: window.__updates.length - n0,
        updateLatencyMs: { median: Math.round(lat[Math.floor(lat.length / 2)] || -1), p95: Math.round(lat[Math.floor(lat.length * 0.95)] || -1), samples: lat.length },
        blockingMs: Math.round(${blocking('start', 'end')}) };
    })()`);
    results.stream = { ...stream, apiDownloads: hits.conversation - before.conversation };

    // ---- idle page with a small periodic change (e.g. a timestamp or animation)
    before = { ...hits };
    const idle = await cdp.eval(`(async () => {
      const tick = document.createElement('span'); document.querySelector('header').appendChild(tick);
      const start = performance.now(); const n0 = window.__updates.length;
      for (let i = 0; i < 24; i++) { tick.textContent = String(i); await new Promise(r => setTimeout(r, 500)); }
      return { updates: window.__updates.length - n0, blockingMs: Math.round(${blocking('start', 'performance.now()')}) };
    })()`);
    results.idle = { ...idle, apiDownloads: hits.conversation - before.conversation };

    results.selfReported = await cdp.eval(`window.__updates.at(-1)?.perf || 'not instrumented'`);
    console.log(JSON.stringify({ turns: TURNS, textKB: Math.round(turns.reduce((s, t) => s + t.text.length, 0) / 1024), ...results }, null, 2));
  } finally {
    chrome.kill();
    server.close();
    await delay(800);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch(e => { console.error(e); process.exit(1); });
