/**
 * Part 2 - Context accuracy + model/plan intelligence
 *
 * Runs the real coordinator pipeline (handleDOMChange) with controlled inputs:
 * API tree, session, rendered DOM turns, network turns/model. Only the I/O edges are stubbed;
 * normalization, merging, tokenization, reconciliation, limits and math are the production code.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ContentScriptCoordinator } from '../../content/content-main.js';
import { ModelDetector } from '../../content/model-detector.js';
import { PlanDetector, normalizePlanTier } from '../../content/plan-detector.js';
import { Tokenizer } from '../../engine/tokenizer.js';
import { ContextCalculator } from '../../engine/context-calculator.js';
import { EvidenceMerger } from '../../engine/evidence-merger.js';
import { toWidgetState } from '../../content/widget-state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../config/model-limits.json'), 'utf8'));

const CONV_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const CONV_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Builds a linear conversation tree: [{ role, text?, slug?, contentType?, hidden?, parts? }] */
function tree(conversationId, turns, extra = {}) {
  const mapping = { root: { id: 'root', parent: null, children: [], message: { id: 'sys', author: { role: 'system' }, content: { parts: [''] } } } };
  let parent = 'root';
  turns.forEach((t, i) => {
    const nid = `n${i}`;
    mapping[parent].children.push(nid);
    mapping[nid] = {
      id: nid, parent, children: [],
      message: {
        id: t.id || id(i + 1),
        author: { role: t.role },
        content: t.contentType
          ? { content_type: t.contentType, ...(t.content || {}) }
          : { content_type: 'text', parts: t.parts || [t.text] },
        metadata: { ...(t.slug ? { model_slug: t.slug } : {}), ...(t.hidden ? { is_visually_hidden_from_conversation: true } : {}) }
      }
    };
    parent = nid;
  });
  return { conversation_id: conversationId, current_node: parent, mapping, ...extra };
}

const EMPTY_DOC = {
  querySelector: () => null,
  querySelectorAll: () => [],
  documentElement: { classList: { contains: () => false } },
  body: null
};

/** Coordinator with only I/O stubbed. */
function harness({ url = CONV_A, api = null, apiError = null, session = { ok: true, status: 200, planType: 'plus' }, dom = [], domModel = null, domPlan = null } = {}) {
  const c = new ContentScriptCoordinator(DB);
  const env = { url, api, apiError, session, dom, domModel, domPlan };
  c.overlayUI = { mount() {}, update() {}, render() {} };
  c.syncState = () => {};
  c.conversationClient.extractConversationId = () => env.url;
  c.conversationClient.getSession = async () => env.session;
  c.conversationClient.fetchConversation = async () =>
    env.api ? { success: true, data: env.api } : { success: false, error: env.apiError || 'HTTP error 500' };
  c.messageExtractor.extractMessages = () => env.dom;
  const realRaw = c.modelDetector.detectRawModelString.bind(c.modelDetector);
  c.modelDetector.detectRawModelString = () => env.domModel;
  c.modelDetector.detect = () => c.modelDetector.resolveModel(env.domModel);
  c.planDetector.detect = () => env.domPlan || { value: 'unknown', source: 'unknown', evidenceType: 'UNKNOWN' };
  const run = async () => { await c.handleDOMChange(); return c.latestState; };
  const bridge = (eventType, payload) => c.requestObserver.handleMessage({ source: globalThis.window, data: { source: 'CHATGPT_CONTEXT_MONITOR_NET', eventType, payload } });
  return { c, env, run, bridge, realRaw };
}

export async function runAccuracyTests() {
  console.log('--- Running Context Accuracy + Model/Plan Intelligence Tests ---');
  let passed = 0;
  let failed = 0;
  const assert = (name, cond) => {
    if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; } else { console.error(`  ❌ [FAIL] ${name}`); failed++; }
  };

  const saved = { document: globalThis.document, window: globalThis.window, location: globalThis.location };
  globalThis.document = EMPTY_DOC;
  globalThis.window = { location: { href: 'https://chatgpt.com/', origin: 'https://chatgpt.com', pathname: '/' } };
  globalThis.location = globalThis.window.location;
  const tk = new Tokenizer();
  const count = (t) => tk.countTokens(t, 'o200k_base');

  try {
    // ------------------------------------------------------------ complete conversation token calculation
    {
      const USER1 = 'Explain how photosynthesis converts light into chemical energy.';
      const ASSIST1 = 'Photosynthesis captures light in chlorophyll and stores it as glucose via the Calvin cycle.';
      const TOOL = 'Search results: 3 sources about chloroplast structure.';
      const USER2 = 'Now summarize in one line.';
      const ASSIST2 = 'Plants turn light, water and CO2 into sugar and oxygen.';
      const api = tree(CONV_A, [
        { role: 'user', contentType: 'user_editable_context', content: { user_profile: 'I am a biologist', user_instructions: 'Be brief' } },
        { role: 'user', text: USER1 },
        { role: 'assistant', contentType: 'thoughts', content: { thoughts: [{ content: 'reasoning...' }] }, slug: 'gpt-5-6' },
        { role: 'assistant', text: ASSIST1, slug: 'gpt-5-6' },
        { role: 'tool', text: TOOL },
        { role: 'user', text: USER2 },
        { role: 'assistant', text: ASSIST2, slug: 'gpt-5-6' }
      ]);
      const { run } = harness({ api });
      const s = await run();
      const expUser = count(USER1) + count(USER2);
      const expAssist = count(ASSIST1) + count(TOOL) + count(ASSIST2);
      const used = expUser + expAssist;

      assert('Complete conversation: user tokens = exact sum of user turns', s.tokens.user === expUser);
      assert('Tool output counted on the model side, never as user', s.tokens.assistant === expAssist);
      assert('Hidden custom-instructions message excluded from turns/tokens', s.observables.hiddenMessagesExcluded === 1);
      assert('Empty reasoning ("thoughts") message is not a turn', s.observables.messagesCount === 5);
      assert('Used tokens = user + assistant + tools', s.tokens.totalMeasurable === used);
      assert('Window: GPT-5.6 Instant on Plus = 54,000', s.model.contextWindow === 54000);
      assert('Remaining = window - used', s.tokens.remaining === 54000 - used);
      assert('Percentage = used / window, one decimal', s.utilization.percentage === Number(((used / 54000) * 100).toFixed(1)));
      assert('Complete API data is not a lower bound', s.completeness.isLowerBound === false);
      assert('Hidden context is explicitly marked as not measured', s.completeness.hiddenContextMeasured === false);

      const vm = toWidgetState(s, { provider: 'ChatGPT' });
      assert('Normalized state carries conversationId', vm.conversationId === CONV_A);
      assert('Normalized state: used/limit/remaining/percentage consistent',
        vm.usedTokens === used && vm.contextLimit === 54000 && vm.remainingTokens === 54000 - used && vm.percentage === s.utilization.percentage);
    }

    // ------------------------------------------------------------ duplicates across API + DOM + network, repeats, order
    {
      const api = tree(CONV_A, [
        { role: 'user', text: 'yes', id: id(1) },
        { role: 'assistant', text: 'Okay.', id: id(2), slug: 'gpt-5-6' },
        { role: 'user', text: 'yes', id: id(3) },
        { role: 'assistant', text: 'Okay again.', id: id(4), slug: 'gpt-5-6' }
      ]);
      const dom = [
        { id: id(3), role: 'user', text: 'yes' },
        { id: id(4), role: 'assistant', text: 'Okay again.' }
      ];
      const h = harness({ api, dom });
      h.c.requestObserver.setActiveConversationId(CONV_A);
      h.bridge('CONVERSATION_REQUEST', { conversationId: CONV_A, userMessage: { id: id(3), text: 'yes', parts: [{ type: 'text', text: 'yes' }] } });
      h.bridge('STREAM_CHUNK', { conversationId: CONV_A, messageId: id(4), role: 'assistant', text: 'Okay again.', status: 'finished_successfully' });
      const s = await h.run();
      const expected = count('yes') * 2 + count('Okay.') + count('Okay again.');
      assert('Same turns in API + DOM + network counted once', s.tokens.totalMeasurable === expected && s.observables.messagesCount === 4);
      assert('Repeated identical user messages both counted', s.tokens.user === count('yes') * 2);

      // Partial live assistant stream appended after the saved tree, in order
      h.bridge('CONVERSATION_REQUEST', { conversationId: CONV_A, userMessage: { id: id(5), text: 'more', parts: [{ type: 'text', text: 'more' }] } });
      h.bridge('STREAM_CHUNK', { conversationId: CONV_A, messageId: id(6), role: 'assistant', text: 'Partial repl', status: 'in_progress' });
      const s2 = await h.run();
      assert('Partial assistant stream counted while streaming', s2.tokens.totalMeasurable === expected + count('more') + count('Partial repl'));
      assert('Live turns appended in order after saved turns', s2.observables.messagesCount === 6);
    }

    // ------------------------------------------------------------ model switching, precedence, conflicts, agreement
    {
      const api = tree(CONV_A, [
        { role: 'user', text: 'a' }, { role: 'assistant', text: 'b', slug: 'gpt-4o' },
        { role: 'user', text: 'c' }, { role: 'assistant', text: 'd', slug: 'gpt-5-6' }
      ]);
      const h = harness({ api, domModel: 'gpt-5-6' });
      const s = await h.run();
      assert('Latest assistant slug in the tree is the model (not the first)', s.evidence.model.value === 'gpt-5-6' && s.model.id === 'chatgpt-instant');
      assert('API and DOM agree on model: agreement recorded, no conflict',
        s.evidence.agreements.includes('model') && !s.conflicts.some(c => c.field === 'model'));
      assert('Agreement credited in confidence reasons', s.confidence.factors.some(f => f.text === 'Sources agree on model'));

      // User switches to Thinking and sends: live stream is newer than the saved tree
      h.c.requestObserver.setActiveConversationId(CONV_A);
      h.bridge('STREAM_CHUNK', { conversationId: CONV_A, messageId: id(9), role: 'assistant', text: 'x', modelSlug: 'gpt-5-6-thinking', status: 'in_progress' });
      const s2 = await h.run();
      assert('Model switch in the same conversation: live model wins', s2.evidence.model.value === 'gpt-5-6-thinking' && s2.model.id === 'chatgpt-reasoning');
      assert('Thinking window applied (Plus 256K)', s2.model.contextWindow === 256000);
      assert('Contradicting API model preserved as a conflict, not hidden',
        s2.conflicts.some(c => c.field === 'model' && c.discarded.value === 'gpt-5-6'));

      // Header text vs slug for the same model is not a conflict
      const h2 = harness({ api, domModel: 'GPT-5.6 Instant' });
      const s3 = await h2.run();
      assert('"GPT-5.6 Instant" header vs "gpt-5-6" slug is not a conflict', !s3.conflicts.some(c => c.field === 'model'));
    }

    // ------------------------------------------------------------ conversation switching / prefetch / refresh / new chat
    {
      const apiA = tree(CONV_A, [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b', slug: 'gpt-5-6-thinking' }]);
      const apiB = tree(CONV_B, [{ role: 'user', text: 'c' }, { role: 'assistant', text: 'd', slug: 'gpt-5-6' }]);
      const h = harness({ api: apiA });
      await h.run();
      h.bridge('STREAM_CHUNK', { conversationId: CONV_A, messageId: id(7), role: 'assistant', text: 'z', modelSlug: 'gpt-5-6-thinking', status: 'in_progress' });
      h.env.url = CONV_B;
      h.env.api = apiB;
      const sB = await h.run();
      assert('Conversation switch: model from A never labels B', sB.model.id === 'chatgpt-instant' && sB.evidence.model.value === 'gpt-5-6');
      assert('Conversation switch: A\'s live turn not counted in B', sB.observables.messagesCount === 2);
      assert('Conversation switch: plan unchanged (account-level)', sB.plan.tier === 'plus');

      // Prefetched (sidebar) conversation data must not change anything
      h.c.handleConversationLoaded({ conversationId: CONV_A, data: apiA });
      const sB2 = await h.run();
      assert('Prefetched conversation cannot change the active model', sB2.evidence.model.value === 'gpt-5-6' && sB2.observables.conversationId === CONV_B);

      // Mis-keyed data (payload for A returned while B is on screen) is rejected
      h.env.api = apiA;
      const sB3 = await h.run();
      assert('API payload from another conversation is ignored', sB3.observables.apiError === 'Conversation data belonged to a different conversation; ignored' && sB3.evidence.model.value !== 'gpt-5-6-thinking');

      // Refresh: brand-new coordinator, same URL
      const r = harness({ url: CONV_B, api: apiB });
      const sR = await r.run();
      assert('Refresh keeps the correct model and plan', sR.evidence.model.value === 'gpt-5-6' && sR.plan.tier === 'plus');

      // New conversation: nothing in the URL, only rendered DOM turns
      const n = harness({ url: null, api: null, dom: [{ id: id(1), role: 'user', text: 'hello' }], domModel: 'gpt-5-6' });
      const sN = await n.run();
      assert('New conversation: counted from DOM, not flagged as a lower bound', sN.tokens.totalMeasurable === count('hello') && sN.completeness.isLowerBound === false);
    }

    // ------------------------------------------------------------ unknown model / partial matching
    {
      const d = new ModelDetector(DB);
      for (const slug of ['gpt-7', 'gpt-4.1-nano', 'gpt-4-1-nano', 'claude-sonnet-4', 'o9-ultra']) {
        const m = d.resolveModel(slug, 'plus');
        assert(`Unknown model "${slug}" gets no context limit`, m.contextWindow === null && m.recognized === false);
      }
      assert('Dated variant resolves to its base model', d.resolveModel('gpt-4o-2024-08-06', 'plus').id === 'gpt-4o');
      assert('Longest specific key wins (gpt-4o-mini-2024-07-18 -> gpt-4o-mini)', d.resolveModel('gpt-4o-mini-2024-07-18', 'plus').id === 'gpt-4o-mini');
      assert('Legacy alias still exact (gpt-4-0613 -> gpt-4)', d.resolveModel('gpt-4-0613', 'plus').id === 'gpt-4');
      assert('Model name kept untruncated for display', d.resolveModel('gpt-5-6-thinking-mini', 'plus').displayName === 'gpt-5-6-thinking-mini (Thinking)');

      const api = tree(CONV_A, [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'yo', slug: 'gpt-7-preview' }]);
      const s = await harness({ api }).run();
      assert('Unknown model through pipeline: no window, no percentage', s.model.contextWindow === null && s.utilization.percentage === null && s.tokens.remaining === null);
      assert('Unknown model shown by name, flagged unrecognized', s.model.displayName === 'gpt-7-preview' && s.model.recognized === false);
      assert('Unknown model lowers confidence with an explicit reason', s.confidence.factors.some(f => f.text === 'Model not recognized or context window limit unknown'));
    }

    // ------------------------------------------------------------ plan detection
    {
      assert('Session plan "chatgptplusplan" normalizes to plus', normalizePlanTier('chatgptplusplan') === 'plus');
      assert('Session plan "chatgpt_team_plan" normalizes to team', normalizePlanTier('chatgpt_team_plan') === 'team');
      assert('Unrecognized plan string stays unknown', normalizePlanTier('premium_ultra') === 'unknown');

      const pd = new PlanDetector();
      const el = (text) => ({ innerText: text, textContent: text });
      const doc = (map, header = '') => ({
        querySelector: (sel) => (sel === 'header' ? el(header) : map[sel] ? el(map[sel]) : null),
        querySelectorAll: () => []
      });
      assert('Upsell "Upgrade to Pro" is not read as a Pro plan',
        pd.detect(doc({ "button[data-testid='profile-button']": 'Upgrade to Pro' })).value !== 'pro');
      assert('Header upsell "Get ChatGPT Plus" is not read as Plus', pd.detect(doc({}, 'Get ChatGPT Plus')).value !== 'plus');
      assert('Explicit "ChatGPT Plus" label is read as Plus', pd.detect(doc({}, 'ChatGPT Plus')).value === 'plus');
      const heur = pd.detect(doc({ "a[href*='/pricing']": 'Upgrade plan' }));
      assert('Upgrade-prompt Free inference is marked heuristic', heur.value === 'free' && heur.source === 'dom_heuristic');

      // Precedence + conflicts through the pipeline
      const api = tree(CONV_A, [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b', slug: 'gpt-5-6' }]);
      const h = harness({ api, session: { ok: true, planType: 'plus' } });
      h.bridge('ACCOUNT_PLAN_OBSERVED', { planType: 'pro' });
      const s = await h.run();
      assert('Session plan outranks accounts/check (network)', s.plan.tier === 'plus' && s.evidence.plan.source === 'session_api');
      assert('Plan disagreement preserved as a conflict', s.conflicts.some(c => c.field === 'plan' && c.discarded.value === 'pro'));

      const h2 = harness({ api, session: { ok: false, status: 403, planType: null }, domPlan: { value: 'free', source: 'dom_heuristic', evidenceType: 'ESTIMATED' } });
      h2.bridge('ACCOUNT_PLAN_OBSERVED', { planType: 'go' });
      const s2 = await h2.run();
      assert('Session unavailable: network plan used; heuristic never creates a conflict', s2.plan.tier === 'go' && !s2.conflicts.some(c => c.field === 'plan'));

      const h3 = harness({ api, session: { ok: false, status: 403, planType: null } });
      const s3 = await h3.run();
      assert('No plan source: plan stays unknown, window unknown (no guess)', s3.plan.tier === 'unknown' && s3.model.contextWindow === null && s3.utilization.percentage === null);
    }

    // ------------------------------------------------------------ lower bound, false conflicts
    {
      const dom = [{ id: id(1), role: 'user', text: 'only rendered turn' }];
      const s = await harness({ api: null, apiError: 'HTTP error 500', dom, domModel: 'gpt-5-6' }).run();
      assert('API failed for an existing conversation: marked lower bound', s.completeness.isLowerBound === true);
      assert('Lower bound surfaced in the normalized state', toWidgetState(s).isLowerBound === true);

      const api = tree(CONV_A, [
        { role: 'user', text: '1' }, { role: 'assistant', text: '2', slug: 'gpt-5-6' },
        { role: 'user', text: '3' }, { role: 'assistant', text: '4', slug: 'gpt-5-6' }
      ]);
      const partial = await harness({ api, dom: [{ id: id(3), role: 'user', text: '3' }, { id: id(4), role: 'assistant', text: '4' }] }).run();
      assert('Fewer rendered DOM turns than API (virtualized) is not a conflict', !partial.conflicts.some(c => c.field === 'turns'));
      const extra = await harness({ api, dom: [1, 2, 3, 4, 5].map(i => ({ id: id(i), role: i % 2 ? 'user' : 'assistant', text: String(i) })) }).run();
      assert('More DOM turns than the API has (stale API) is recorded as a conflict', extra.conflicts.some(c => c.field === 'turns'));
    }

    // ------------------------------------------------------------ math edge cases
    {
      const model = { id: 'x', displayName: 'X', contextWindow: 1000, limitStatus: 'VERIFIED', recognized: true };
      const over = ContextCalculator.calculate({ messages: [{ id: 'a', role: 'user', tokens: 1500 }], model, plan: 'plus' });
      assert('Over the window: percentage capped at 100, remaining 0', over.utilization.percentage === 100 && over.tokens.remaining === 0);
      const tiny = ContextCalculator.calculate({ messages: [{ id: 'a', role: 'user', tokens: 1 }], model: { ...model, contextWindow: 256000 }, plan: 'plus' });
      assert('Tiny usage rounds to 0% (UI shows <0.1)', tiny.utilization.percentage === 0 && tiny.tokens.remaining === 255999);
      const third = ContextCalculator.calculate({ messages: [{ id: 'a', role: 'user', tokens: 1 }], model: { ...model, contextWindow: 3 }, plan: 'plus' });
      assert('Percentage rounded to one decimal (1/3 -> 33.3)', third.utilization.percentage === 33.3);
      const unknownPlan = ContextCalculator.calculate({ messages: [{ id: 'a', role: 'user', tokens: 10 }], model, plan: 'unknown' });
      assert('Unknown plan: no window, no percentage, no remaining', unknownPlan.model.contextWindow === null && unknownPlan.utilization.percentage === null && unknownPlan.tokens.remaining === null);
    }

    // ------------------------------------------------------------ evidence merger rules
    {
      const r = EvidenceMerger.reconcileState({
        modelCandidates: [
          { value: 'gpt-5-6', compareKey: '5-6', source: 'conversation_api' },
          { value: 'GPT-5.6', compareKey: '5-6', source: 'dom' }
        ],
        planCandidates: [{ value: 'plus', source: 'session_api' }]
      });
      assert('compareKey: differently written same model agrees', r.agreements.includes('model') && !r.hasConflicts);
      assert('Single source is not "agreement"', !r.agreements.includes('plan'));
    }
  } finally {
    globalThis.document = saved.document;
    globalThis.window = saved.window;
    globalThis.location = saved.location;
  }

  return { passed, failed };
}
