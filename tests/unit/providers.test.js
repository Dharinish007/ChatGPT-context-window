/**
 * Claude + Gemini provider adapters: conversation reading, live updates, model / plan detection,
 * published context limits, estimated tokens and confidence. Runs the real ProviderCoordinator with
 * only the page and network edges stubbed.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ClaudeProvider, GeminiProvider, claudeModelKey, providerForHost } from '../../content/providers.js';
import { ProviderCoordinator } from '../../content/provider-coordinator.js';
import { ConfidenceEngine } from '../../engine/confidence-engine.js';
import { Tokenizer } from '../../engine/tokenizer.js';
import { toWidgetState } from '../../content/widget-state.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLAUDE_CONV = '11111111-2222-4333-8444-555555555555';

/** Minimal element: text, tag, attribute-selector matching for the adapters' selectors. */
function el(tag, text, attrs = {}, parent = null) {
  const node = {
    tagName: tag.toUpperCase(), textContent: text, attrs, parentElement: parent,
    matches(sel) { return sel.split(',').some(s => matchOne(node, s.trim())); },
    closest(sel) { for (let n = node; n; n = n.parentElement) if (n.matches(sel)) return n; return null; },
    querySelector(sel) { return (node.children || []).find(c => c.matches(sel)) || null; },
    querySelectorAll() { return []; }
  };
  return node;
}
function matchOne(node, s) {
  const attr = s.match(/^\[([\w-]+)="([^"]+)"\]$/);
  if (attr) return node.attrs[attr[1]] === attr[2];
  if (s.startsWith('.')) return (node.attrs.class || '').split(' ').includes(s.slice(1));
  return node.tagName.toLowerCase() === s.toLowerCase();
}
const doc = (nodes, extra = {}) => ({
  querySelectorAll: (sel) => (extra.all?.(sel)) || nodes.filter(n => n.matches(sel)),
  querySelector: (sel) => (extra.one?.(sel)) || null,
  cookie: extra.cookie || ''
});

function claudeTree() {
  const msg = (uuid, parent, sender, content, extra = {}) => ({ uuid, parent_message_uuid: parent, sender, content, ...extra });
  return {
    uuid: CLAUDE_CONV,
    model: 'claude-opus-5-5',
    current_leaf_message_uuid: 'a2',
    chat_messages: [
      msg('u1', '00000000-0000-4000-8000-000000000000', 'human', [{ type: 'text', text: 'Summarize the attached notes please.' }],
        { attachments: [{ file_name: 'notes.txt', extracted_content: 'Meeting notes: ship the adapter on Friday.' }], files: [{ file_kind: 'image' }] }),
      msg('a1', 'u1', 'assistant', [
        { type: 'thinking', thinking: 'internal reasoning that is not resent' },
        { type: 'tool_use', name: 'web_search', input: { query: 'adapter release' } },
        { type: 'tool_result', content: [{ type: 'text', text: 'Result: release notes page.' }] },
        { type: 'text', text: 'The notes say the adapter ships on Friday.' }
      ]),
      msg('u2', 'a1', 'human', [{ type: 'text', text: 'And the owner?' }]),
      msg('a2', 'u2', 'assistant', [{ type: 'text', text: 'The notes do not name an owner.' }]),
      msg('x2', 'u2', 'assistant', [{ type: 'text', text: 'An abandoned regenerated branch that must not count.' }])
    ]
  };
}

/** ProviderCoordinator with the page and API stubbed. */
function harness(provider, env) {
  const c = new ProviderCoordinator(provider);
  const p = Object.create(provider);
  p.extractMessages = () => env.dom || [];
  p.detectModel = () => env.domModel || null;
  p.detectPlan = () => env.domPlan || null;
  p.fetchConversation = async () => {
    env.apiCalls = (env.apiCalls || 0) + 1;
    if (env.apiError) throw new Error(env.apiError);
    return env.api ? provider.normalizeConversation ? { ...provider.normalizeConversation(env.api), plan: env.accountPlan || null } : null : null;
  };
  c.provider = p;
  c.overlayUI = { mount() {}, render() {}, update(vm) { env.vm = vm; } };
  c.syncState = () => {};
  const run = async (event) => { await c.handleDOMChange(event); return c.latestState; };
  return { c, run };
}

export async function runProvidersTests() {
  console.log('--- Running Claude + Gemini Provider Adapter Tests ---');
  let passed = 0;
  let failed = 0;
  const assert = (name, cond) => {
    if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; } else { console.error(`  ❌ [FAIL] ${name}`); failed++; }
  };
  const saved = { document: globalThis.document, location: globalThis.location };
  const tk = new Tokenizer();
  const count = (t) => tk.countTokens(t, 'o200k_base');

  try {
    // ------------------------------------------------------------------ routing
    assert('claude.ai -> Claude adapter, gemini.google.com -> Gemini adapter', providerForHost('claude.ai') === ClaudeProvider && providerForHost('gemini.google.com') === GeminiProvider);
    assert('ChatGPT hosts keep the ChatGPT coordinator (no adapter)', providerForHost('chatgpt.com') === null && providerForHost('chat.openai.com') === null && providerForHost('') === null);

    // ------------------------------------------------------------------ Claude: ids, models, limits
    assert('Claude conversation id from /chat/<uuid>; new chat has none',
      ClaudeProvider.conversationId(`https://claude.ai/chat/${CLAUDE_CONV}`) === CLAUDE_CONV && ClaudeProvider.conversationId('https://claude.ai/new') === null);
    assert('Claude model keys: API slugs and selector text agree',
      claudeModelKey('claude-opus-5-5') === 'opus-5.5' && claudeModelKey('Opus 5.5') === 'opus-5.5' &&
      claudeModelKey('claude-sonnet-4-5-20250929') === 'sonnet-4.5' && claudeModelKey('claude-3-5-sonnet-20241022') === 'sonnet-3.5' &&
      claudeModelKey('Sonnet 5') === 'sonnet-5' && claudeModelKey('Fable 5.1') === 'fable-5.1' && claudeModelKey('New chat') === null);
    const l1 = ClaudeProvider.resolveLimit('claude-opus-5-5', 'pro');
    const l2 = ClaudeProvider.resolveLimit('claude-sonnet-4-5-20250929', 'max');
    assert('Claude: Opus 5.5 on a paid plan = 1M (published), VERIFIED', l1.contextWindow === 1000000 && l1.status === 'VERIFIED' && /support\.claude\.com/.test(l1.source));
    assert('Claude: other models on paid plans = 200K (published)', l2.contextWindow === 200000 && l2.status === 'VERIFIED');
    assert('Claude: Free plan window is not published -> UNKNOWN', ClaudeProvider.resolveLimit('Sonnet 5', 'free').contextWindow === null && ClaudeProvider.resolveLimit('Sonnet 5', 'free').status === 'UNKNOWN');
    assert('Claude: unknown plan or unrecognized model -> UNKNOWN, never guessed',
      ClaudeProvider.resolveLimit('Opus 5.5', 'unknown').contextWindow === null && ClaudeProvider.resolveLimit('mystery', 'pro').recognized === false);
    assert('Claude plan from account capabilities',
      ClaudeProvider.planFromOrganization({ capabilities: ['chat', 'claude_max'] }).value === 'max' &&
      ClaudeProvider.planFromOrganization({ capabilities: ['chat', 'claude_pro'] }).evidenceType === 'OBSERVED' &&
      ClaudeProvider.planFromOrganization({ capabilities: ['chat', 'raven'], raven_type: 'enterprise' }).value === 'enterprise' &&
      ClaudeProvider.planFromOrganization({ capabilities: ['chat'] }).evidenceType === 'ESTIMATED' &&
      ClaudeProvider.planFromOrganization(null) === null);

    // ------------------------------------------------------------------ Claude: conversation reading
    const norm = ClaudeProvider.normalizeConversation(claudeTree());
    const texts = norm.messages.map(m => m.text).join(' | ');
    assert('Claude: only the active branch is read (abandoned branch excluded)', !texts.includes('abandoned') && norm.visibleTurns === 4);
    assert('Claude: earlier thinking is not counted (not resent)', !texts.includes('internal reasoning'));
    assert('Claude: tool calls and results are counted as tool output', norm.messages.some(m => m.role === 'tool' && m.text.includes('release notes page') && m.text.includes('adapter release')));
    assert('Claude: text extracted from attached files is counted with the user turn', norm.messages[0].role === 'user' && norm.messages[0].text.includes('Meeting notes'));
    assert('Claude: files without visible content are flagged unknown', norm.attachments.count === 2 && norm.attachments.hasUnknown === true);

    // ------------------------------------------------------------------ Claude: full pipeline
    globalThis.location = { href: `https://claude.ai/chat/${CLAUDE_CONV}`, hostname: 'claude.ai', pathname: `/chat/${CLAUDE_CONV}` };
    globalThis.document = { cookie: '', querySelector: () => null, querySelectorAll: () => [] };
    {
      const env = { api: claudeTree(), accountPlan: { value: 'pro', evidenceType: 'OBSERVED' }, domModel: 'Opus 5.5', dom: [
        { id: 'claude-dom-0-user', role: 'user', text: 'Summarize the attached notes please.' },
        { id: 'claude-dom-1-assistant', role: 'assistant', text: 'The notes say the adapter ships on Friday.' },
        { id: 'claude-dom-2-user', role: 'user', text: 'And the owner?' },
        { id: 'claude-dom-3-assistant', role: 'assistant', text: 'The notes do not name an owner.' }
      ] };
      const { run } = harness(ClaudeProvider, env);
      const s = await run();
      const expected = norm.messages.reduce((sum, m) => sum + count(m.text), 0);
      const vm = toWidgetState(s, { provider: 'Claude' });
      assert('Claude: saved conversation read through the API', s.observables.dataSource === 'authoritative' && s.completeness.completenessSource === 'authoritative_api');
      assert('Claude: tokens = o200k count of the active branch (incl. tools and file text)', s.tokens.totalMeasurable === expected);
      assert('Claude: 1M window for Opus 5.5 on Pro, percentage computed', s.model.contextWindow === 1000000 && s.utilization.percentage !== null);
      assert('Claude: model agreed by API and page, plan from the account API', s.evidence.model.confirmedBy.includes('dom') && s.evidence.plan.source === 'account_api');
      assert('Claude: token counts are ESTIMATED (approximate tokenizer)', s.evidence.tokens.total.evidenceType === 'ESTIMATED' && s.accuracy.total === 'ESTIMATED');
      assert('Claude: never HIGH, with the reason', s.confidence.level !== 'HIGH' && s.confidence.highBlockers.includes('approximate tokenizer') &&
        s.confidence.factors.some(f => f.text.startsWith('Approximate tokenizer')));
      assert('Claude: widget shows the provider name and model', vm.provider === 'Claude' && vm.breakdown[1].label === 'Claude + tools' && vm.model === 'Claude Opus 5.5');

      // Live: user sends a message, reply streams on the page before it is saved
      env.dom = [...env.dom,
        { id: 'claude-dom-4-user', role: 'user', text: 'Please draft the release email.' },
        { id: 'claude-dom-5-assistant', role: 'assistant', text: 'Subject: Adapter release', isStreaming: true }];
      const live = await run();
      assert('Claude live: new turns on the page are added to the saved ones', live.tokens.totalMeasurable === expected + count('Please draft the release email.') + count('Subject: Adapter release'));
      const callsBefore = env.apiCalls;
      env.dom = env.dom.map(m => ({ ...m, isStreaming: false }));
      await run();
      assert('Claude live: a reply finishing re-reads the saved conversation', env.apiCalls === callsBefore + 1);
    }
    {
      const env = { apiError: 'HTTP error 403', domModel: 'Sonnet 5', domPlan: { value: 'max', source: 'dom', evidenceType: 'OBSERVED' },
        dom: [{ id: 'claude-dom-0-user', role: 'user', text: 'Hi' }, { id: 'claude-dom-1-assistant', role: 'assistant', text: 'Hello!' }] };
      const { run } = harness(ClaudeProvider, env);
      const s = await run();
      assert('Claude API failure: page text is used and marked as a lower bound', s.observables.dataSource === 'dom_fallback' && s.completeness.isLowerBound === true && /403/.test(s.observables.apiError));
      assert('Claude API failure: plan from the page, 1M for Sonnet 5 on Max', s.plan.tier === 'max' && s.model.contextWindow === 1000000);
    }

    // ------------------------------------------------------------------ Gemini
    assert('Gemini conversation id from /app/<id> and /gem/<gem>/<id>',
      GeminiProvider.conversationId('https://gemini.google.com/app/8f2c1a9b3d4e') === '8f2c1a9b3d4e' &&
      GeminiProvider.conversationId('https://gemini.google.com/gem/coding-partner/8f2c1a9b3d4e') === '8f2c1a9b3d4e' &&
      GeminiProvider.conversationId('https://gemini.google.com/app') === null);
    assert('Gemini windows by plan (published): free 32K, Plus 128K, Pro/Ultra 1M',
      GeminiProvider.resolveLimit('Fast', 'free').contextWindow === 32000 && GeminiProvider.resolveLimit(null, 'plus').contextWindow === 128000 &&
      GeminiProvider.resolveLimit('Pro', 'pro').contextWindow === 1000000 && GeminiProvider.resolveLimit('Thinking', 'ultra').status === 'VERIFIED');
    assert('Gemini: unknown plan -> window UNKNOWN', GeminiProvider.resolveLimit('Fast', 'unknown').contextWindow === null);
    const pro = GeminiProvider.detectPlan(doc([], { all: () => [{ textContent: 'Gemini  Google AI Pro' }] }));
    const badge = GeminiProvider.detectPlan(doc([], { all: () => [{ textContent: 'Gemini PRO' }] }));
    assert('Gemini plan: explicit "Google AI Pro" is OBSERVED, a bare badge only ESTIMATED',
      pro.value === 'pro' && pro.evidenceType === 'OBSERVED' && badge.source === 'dom_heuristic' && badge.evidenceType === 'ESTIMATED' &&
      GeminiProvider.detectPlan(doc([], { all: () => [] })) === null);
    const gDom = doc([
      Object.assign(el('user-query', 'You said Explain tokens'), { querySelector: () => el('div', 'Explain tokens', { class: 'query-text' }) }),
      Object.assign(el('model-response', 'Gemini said Tokens are pieces of text.'), { querySelector: (s) => (s === 'message-content' ? el('message-content', 'Tokens are pieces of text.') : null) })
    ]);
    const gMsgs = GeminiProvider.extractMessages(gDom);
    assert('Gemini page reading: user-query / model-response turns in order, content only',
      gMsgs.length === 2 && gMsgs[0].role === 'user' && gMsgs[0].text === 'Explain tokens' && gMsgs[1].role === 'assistant' && gMsgs[1].text === 'Tokens are pieces of text.');

    globalThis.location = { href: 'https://gemini.google.com/app/8f2c1a9b3d4e', hostname: 'gemini.google.com', pathname: '/app/8f2c1a9b3d4e' };
    {
      const env = { domModel: 'Pro', domPlan: { value: 'pro', source: 'dom', evidenceType: 'OBSERVED' }, dom: gMsgs };
      const { run } = harness(GeminiProvider, env);
      const s = await run();
      assert('Gemini: read from the page; saved chat marked as possibly incomplete', s.observables.dataSource === 'dom' && s.completeness.isLowerBound === true);
      assert('Gemini: 1M window on Google AI Pro; tokens estimated', s.model.contextWindow === 1000000 && s.tokens.totalMeasurable === count('Explain tokens') + count('Tokens are pieces of text.'));
      assert('Gemini: no conversation API calls; never HIGH', env.apiCalls === undefined && s.confidence.level !== 'HIGH');
      assert('Gemini: widget shows Gemini and the detected mode', toWidgetState(s, { provider: 'Gemini' }).model === 'Gemini · Pro');

      env.domPlan = null;
      const s2 = await run();
      assert('Gemini: plan not detected -> window UNKNOWN, no percentage', s2.model.contextWindow === null && s2.utilization.percentage === null);
    }

    // ------------------------------------------------------------------ Claude page reading
    {
      const turn = el('div', '', { 'data-is-streaming': 'true' });
      const user = el('div', 'What is BPE?', { 'data-testid': 'user-message' });
      const reply = el('div', 'Byte pair encoding merges', { class: 'font-claude-response' }, turn);
      const msgs = ClaudeProvider.extractMessages(doc([user, reply]));
      assert('Claude page reading: roles, text and streaming flag', msgs.length === 2 && msgs[0].role === 'user' && msgs[1].role === 'assistant' && msgs[1].isStreaming === true && msgs[0].isStreaming === false);
    }

    // ------------------------------------------------------------------ ChatGPT unchanged
    const chatgptConf = ConfidenceEngine.evaluate({ isModelKnown: true, messageCount: 4, completenessSource: 'authoritative_api', isNetworkActive: true });
    assert('ChatGPT keeps the exact tokenizer factor (default unchanged)', chatgptConf.factors.some(f => f.text === 'Exact tokenizer') && !chatgptConf.highBlockers.includes('approximate tokenizer'));
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    const main = manifest.content_scripts.find(s => s.js.includes('content/content-script.js'));
    const interceptor = manifest.content_scripts.find(s => s.js.includes('content/network-interceptor.js'));
    assert('Manifest: widget runs on ChatGPT, Claude and Gemini', ['https://claude.ai/*', 'https://gemini.google.com/*', 'https://chatgpt.com/*'].every(h => main.matches.includes(h)));
    assert('Manifest: ChatGPT network interceptor stays ChatGPT-only', interceptor.matches.every(h => /chatgpt\.com|chat\.openai\.com/.test(h)));
    assert('Bundle selects the adapter by hostname and keeps ChatGPT prefetch',
      /providerForHost\(location\.hostname\)[\s\S]*if \(!provider\) coordinator\.prefetch\(\)/.test(fs.readFileSync(path.join(root, 'content/content-script.js'), 'utf8')));
  } finally {
    Object.assign(globalThis, saved);
  }

  console.log(`\n  Provider Adapter Results: ${passed} passed, ${failed} failed`);
  return { passed, failed };
}
