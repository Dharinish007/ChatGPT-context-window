/**
 * Part 3 - Confidence + evidence + diagnostics
 *
 * Runs the real coordinator pipeline (reconciliation, limits, confidence engine, diagnostics) with
 * only the I/O edges stubbed: API tree, session, network bridge events, rendered DOM turns/model/plan.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ContentScriptCoordinator } from '../../content/content-main.js';
import { ConfidenceEngine } from '../../engine/confidence-engine.js';
import { EvidenceMerger } from '../../engine/evidence-merger.js';
import { toWidgetState } from '../../content/widget-state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../config/model-limits.json'), 'utf8'));

const CONV_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const CONV_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const SECRET_USER = 'My private question about the merger with Initech';
const SECRET_ASSIST = 'Confidential answer text that must never be exported';

function tree(conversationId, slug = 'gpt-5-6', turns = null) {
  const list = turns || [{ role: 'user', text: SECRET_USER }, { role: 'assistant', text: SECRET_ASSIST, slug }];
  const mapping = { root: { id: 'root', parent: null, children: [], message: null } };
  let parent = 'root';
  list.forEach((t, i) => {
    const nid = `n${i}`;
    mapping[parent].children.push(nid);
    mapping[nid] = {
      id: nid, parent, children: [],
      message: { id: `${conversationId.slice(0, 8)}-m${i}`, author: { role: t.role }, content: { content_type: 'text', parts: [t.text] }, metadata: t.slug ? { model_slug: t.slug } : {} }
    };
    parent = nid;
  });
  return { conversation_id: conversationId, current_node: parent, mapping };
}

const domTurns = () => [
  { id: 'd1', role: 'user', text: SECRET_USER },
  { id: 'd2', role: 'assistant', text: SECRET_ASSIST }
];

const EMPTY_DOC = {
  querySelector: () => null,
  querySelectorAll: () => [],
  cookie: '',
  visibilityState: 'visible',
  documentElement: { classList: { contains: () => false } },
  body: null
};

/**
 * @param {Object} o
 *   url: conversation id on screen; api: { [id]: tree }; apiStatus: HTTP status when missing;
 *   fromCapture: API answered from the page's own copy; session; dom: rendered turns;
 *   domModel: raw DOM model string; domPlan: DOM plan candidate
 */
function harness(o = {}) {
  const env = {
    url: CONV_A, api: {}, apiStatus: 500, fromCapture: false,
    session: { ok: true, status: 200, planType: 'plus' },
    dom: [], domModel: null, domPlan: null, ...o
  };
  const c = new ContentScriptCoordinator(DB);
  c.overlayUI = { mount() {}, render() {}, update() {} };
  c.syncState = () => {};
  c.conversationClient.extractConversationId = () => env.url;
  c.conversationClient.getSession = async () => env.session;
  c.conversationClient.fetchConversation = async (id) => {
    if (env.api[id]) return { success: true, data: env.api[id], ...(env.fromCapture ? { fromCapture: true, fetchError: 'HTTP error 401' } : {}) };
    return { success: false, error: `HTTP error ${env.apiStatus}`, status: env.apiStatus };
  };
  c.messageExtractor.extractMessages = () => env.dom;
  c.modelDetector.detectRawModelString = () => env.domModel;
  c.modelDetector.detect = () => c.modelDetector.resolveModel(env.domModel);
  c.planDetector.detect = () => env.domPlan || { value: 'unknown', source: 'unknown', evidenceType: 'UNKNOWN' };
  const bridge = (eventType, payload) => c.requestObserver.handleMessage({ source: globalThis.window, data: { source: 'CHATGPT_CONTEXT_MONITOR_NET', eventType, payload } });
  const run = async () => { await c.handleDOMChange(); return c.latestState; };
  return { c, env, run, bridge };
}

/** Level and percentage must tell the same story. */
const bandOk = (conf) =>
  (conf.level === 'HIGH' && conf.percentage >= 75) ||
  (conf.level === 'MEDIUM' && conf.percentage >= 50 && conf.percentage < 75) ||
  (conf.level === 'LOW' && conf.percentage < 50);

export async function runConfidenceDiagnosticsTests() {
  console.log('--- Running Part 3 Confidence + Evidence + Diagnostics Tests ---');
  let passed = 0;
  let failed = 0;
  const assert = (name, cond) => {
    if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; } else { console.error(`  ❌ [FAIL] ${name}`); failed++; }
  };

  const saved = { document: globalThis.document, window: globalThis.window, location: globalThis.location };
  globalThis.document = EMPTY_DOC;
  globalThis.window = { location: { href: 'https://chatgpt.com/', origin: 'https://chatgpt.com', pathname: '/c/' + CONV_A } };
  globalThis.location = globalThis.window.location;
  const levels = [];

  try {
    // ------------------------------------------------------------ source agreement
    {
      const { run, bridge } = harness({ api: { [CONV_A]: tree(CONV_A) }, dom: domTurns(), domModel: 'gpt-5-6' });
      await run();
      bridge('ACCOUNT_PLAN_OBSERVED', { planType: 'plus' });
      const s = await run();
      const f = s.confidence.factors.map(x => x.text);
      levels.push(s.confidence);
      assert('Agreement: model confirmed by the page', s.evidence.model.source === 'conversation_api' && s.evidence.model.confirmedBy.includes('dom'));
      assert('Agreement: plan confirmed by network', s.evidence.plan.source === 'session_api' && s.evidence.plan.confirmedBy.includes('network'));
      assert('Agreement: turn count confirmed by the page', s.evidence.turns.confirmedBy.includes('dom'));
      assert('Agreement listed per field (model, plan, turns)', ['model', 'plan', 'turns'].every(k => s.evidence.agreements.includes(k)));
      assert('Each result names its source and who confirmed it',
        f.includes('Model gpt-5-6: conversation API [EXACT], confirmed by page (DOM)') &&
        f.includes('Plan plus: session API [EXACT], confirmed by network'));
      assert('Everything verified and agreeing: HIGH with no blockers', s.confidence.level === 'HIGH' && s.confidence.highBlockers.length === 0);
      assert('No conflicts recorded when sources agree', s.conflicts.length === 0);
    }

    // ------------------------------------------------------------ conflicting sources
    {
      const { run, bridge } = harness({ api: { [CONV_A]: tree(CONV_A, 'gpt-5-6') }, dom: domTurns(), domModel: 'gpt-5-6' });
      await run();
      bridge('CONVERSATION_REQUEST', { conversationId: CONV_A, model: 'gpt-5-6-thinking' });
      bridge('ACCOUNT_PLAN_OBSERVED', { planType: 'pro' });
      const s = await run();
      levels.push(s.confidence);
      const fields = s.conflicts.map(k => k.field);
      assert('Model conflict preserved (live network vs conversation API)', s.conflicts.some(k => k.field === 'model' && k.winning.source === 'live_network' && k.discarded.source === 'conversation_api'));
      assert('Plan conflict preserved (session API vs network)', s.conflicts.some(k => k.field === 'plan' && k.winning.source === 'session_api' && k.discarded.value === 'pro'));
      assert('Conflicting fields are not credited as agreement', !s.evidence.agreements.includes('model') && !s.evidence.agreements.includes('plan'));
      assert('Conflicts never show HIGH', s.confidence.level !== 'HIGH' && s.confidence.highBlockers.includes('sources disagree'));
      assert('Lower confidence is explained ("Not HIGH" + each conflict)',
        s.confidence.factors.some(x => x.type === 'negative' && x.text.startsWith('Not HIGH: sources disagree')) &&
        s.confidence.factors.some(x => x.text.startsWith('Source conflict on model')));
      assert('Conflicts carried into diagnostics', fields.length === s.diagnostics.conflicts.length && s.diagnostics.conflicts.some(k => k.field === 'model' && k.discarded === 'conversation_api:gpt-5-6'));
      assert('Widget view keeps the conflicts', toWidgetState(s).conflicts.length === s.conflicts.length);
    }

    // ------------------------------------------------------------ missing sources / unknowns stay UNKNOWN
    {
      // No plan from any source
      const { run } = harness({ api: { [CONV_A]: tree(CONV_A) }, session: { ok: true, status: 200, planType: null } });
      const s = await run();
      levels.push(s.confidence);
      const vm = toWidgetState(s);
      assert('Missing plan stays UNKNOWN in evidence', s.evidence.plan.value === null && s.evidence.plan.evidenceType === 'UNKNOWN' && s.evidence.plan.source === 'unknown');
      assert('Missing plan: limit UNKNOWN, no percentage invented', s.evidence.limit.status === 'UNKNOWN' && s.evidence.limit.evidenceType === 'UNKNOWN' && s.utilization.percentage === null);
      assert('Missing plan: widget shows Unknown plan and UNKNOWN window', vm.plan === null && vm.limitStatus === 'UNKNOWN' && vm.percentage === null);
      assert('Missing plan never shows HIGH, with the reason', s.confidence.level !== 'HIGH' && s.confidence.highBlockers.includes('plan unknown'));
    }
    {
      // No model from any source
      const { run } = harness({ api: { [CONV_A]: tree(CONV_A, null) } });
      const s = await run();
      levels.push(s.confidence);
      assert('Missing model stays UNKNOWN', s.evidence.model.evidenceType === 'UNKNOWN' && s.model.id === 'unknown' && toWidgetState(s).model === 'Model unknown');
      assert('Missing model never shows HIGH', s.confidence.level !== 'HIGH' && s.confidence.highBlockers.includes('model unknown'));
    }
    {
      // Conversation API failed for a saved conversation: only the page was read
      const { run } = harness({ dom: domTurns(), domModel: 'gpt-5-6', apiStatus: 503 });
      const s = await run();
      levels.push(s.confidence);
      assert('API failure: counted from the page, marked partial', s.observables.dataSource === 'dom_fallback' && s.completeness.isLowerBound === true);
      assert('API failure never shows HIGH', s.confidence.level !== 'HIGH' && s.confidence.highBlockers.includes('conversation only partly read'));
      assert('API failure explained', s.confidence.factors.some(x => x.text === 'Authoritative conversation API unavailable; relying on DOM observation'));
    }
    {
      // New chat (no saved conversation): explained as "nothing to read yet", not "API unavailable"
      const { run } = harness({ url: null, dom: domTurns(), domModel: 'gpt-5-6' });
      const s = await run();
      levels.push(s.confidence);
      assert('New chat is not described as an API failure',
        s.confidence.factors.some(x => x.text.startsWith('No saved conversation to read from the API yet')) &&
        !s.confidence.factors.some(x => x.text.startsWith('Authoritative conversation API unavailable')));
    }

    // ------------------------------------------------------------ confidence levels
    {
      // Unverified limit (third-party figure) caps at MEDIUM
      const { run } = harness({ api: { [CONV_A]: tree(CONV_A) }, session: { ok: true, status: 200, planType: 'business' } });
      const s = await run();
      levels.push(s.confidence);
      assert('Unverified context limit: status UNVERIFIED, still OBSERVED from the limits table', s.evidence.limit.status === 'UNVERIFIED' && s.evidence.limit.evidenceType === 'OBSERVED' && s.evidence.limit.value === 54000);
      assert('Unverified context limit never shows HIGH', s.confidence.level === 'MEDIUM' && s.confidence.highBlockers.includes('context limit unverified'));
      assert('Widget marks the window UNVERIFIED', toWidgetState(s).limitStatus === 'UNVERIFIED');
    }
    {
      // Plan known, but no published limit for this model on it (Free + reasoning)
      const { run } = harness({ api: { [CONV_A]: tree(CONV_A, 'gpt-5-6-thinking') }, session: { ok: true, status: 200, planType: 'free' } });
      const s = await run();
      levels.push(s.confidence);
      assert('No published limit: window UNKNOWN, not invented', s.evidence.limit.value === null && s.evidence.limit.status === 'UNKNOWN' && s.utilization.percentage === null);
      assert('No published limit: not HIGH, reason says the window is unknown',
        s.confidence.level !== 'HIGH' && s.confidence.highBlockers.includes('context limit unknown') &&
        s.confidence.factors.some(x => x.text.includes('window UNKNOWN')));
    }
    {
      // Plan only inferred from an upgrade button (ESTIMATED): not enough for HIGH
      const { run } = harness({
        api: { [CONV_A]: tree(CONV_A) }, session: { ok: true, status: 200, planType: null },
        domPlan: { value: 'free', source: 'dom_heuristic', evidenceType: 'ESTIMATED' }
      });
      const s = await run();
      levels.push(s.confidence);
      assert('Heuristic plan is kept as ESTIMATED from the page heuristic', s.evidence.plan.value === 'free' && s.evidence.plan.source === 'dom_heuristic' && s.evidence.plan.evidenceType === 'ESTIMATED');
      assert('Heuristic plan shown as a caveat, not support', s.confidence.factors.some(x => x.type === 'negative' && x.text === 'Plan free: page heuristic [ESTIMATED], single source'));
      assert('Heuristic plan never shows HIGH', s.confidence.level !== 'HIGH' && s.confidence.highBlockers.includes('value inferred, not reported'));
    }
    {
      // Engine-level: unknown attachments and the level/percentage band
      const conf = ConfidenceEngine.evaluate({
        isModelKnown: true, planTier: 'plus', isPlanKnown: true, contextLimit: 54000, isLimitVerified: true,
        messageCount: 6, attachmentCount: 1, hasUnknownAttachments: true, completenessSource: 'authoritative_api', isNetworkActive: true, agreements: []
      });
      levels.push(conf);
      assert('Unmeasured attachment never shows HIGH', conf.level !== 'HIGH' && conf.highBlockers.includes('attachment size unknown'));
      const clean = ConfidenceEngine.evaluate({
        isModelKnown: true, planTier: 'plus', isPlanKnown: true, contextLimit: 54000, isLimitVerified: true,
        messageCount: 6, completenessSource: 'authoritative_api', isNetworkActive: true, agreements: ['model']
      });
      levels.push(clean);
      assert('Complete, verified, agreeing evidence stays HIGH (existing scoring kept)', clean.level === 'HIGH' && clean.percentage === 100);
      assert('Every scenario: level and percentage are consistent', levels.every(bandOk));
    }

    // ------------------------------------------------------------ EXACT / OBSERVED / ESTIMATED / UNKNOWN
    {
      const { run, bridge } = harness({ url: null, session: { ok: true, status: 200, planType: null } });
      await run();
      bridge('ACCOUNT_PLAN_OBSERVED', { planType: 'plus' });
      bridge('CONVERSATION_REQUEST', { model: 'gpt-5-6', userMessage: { id: 'u1', text: 'Hello there', parts: [{ type: 'text', text: 'Hello there' }] } });
      const s = await run();
      assert('Network-only model is OBSERVED from live network', s.evidence.model.source === 'live_network' && s.evidence.model.evidenceType === 'OBSERVED');
      assert('Network-only plan is OBSERVED from network', s.evidence.plan.source === 'network' && s.evidence.plan.evidenceType === 'OBSERVED');

      const h2 = harness({ api: { [CONV_A]: tree(CONV_A) } });
      const s2 = await h2.run();
      assert('API model and session plan are EXACT', s2.evidence.model.evidenceType === 'EXACT' && s2.evidence.plan.evidenceType === 'EXACT');
      assert('Known verified limit: OBSERVED from limits table, VERIFIED, with its reference',
        s2.evidence.limit.evidenceType === 'OBSERVED' && s2.evidence.limit.status === 'VERIFIED' && s2.evidence.limit.source === 'model_db' && /chatgpt\.com\/pricing/.test(s2.evidence.limit.reference));
      assert('Token counts are ESTIMATED (local tokenizer), never EXACT', ['user', 'assistant', 'total'].every(k => s2.evidence.tokens[k].evidenceType === 'ESTIMATED' && s2.evidence.tokens[k].source === 'tokenizer'));
      assert('Hidden server context stays UNKNOWN', s2.evidence.serverContext.evidenceType === 'UNKNOWN');
      assert('Widget: VERIFIED window', toWidgetState(s2).limitStatus === 'VERIFIED');
    }
    {
      // Merger: confirmedBy lists only same-value, reliable, other sources
      const r = EvidenceMerger.reconcileField('plan', [
        { value: 'plus', source: 'session_api', evidenceType: 'EXACT' },
        { value: 'plus', source: 'network', evidenceType: 'OBSERVED' },
        { value: 'plus', source: 'dom_heuristic', evidenceType: 'ESTIMATED' },
        { value: 'pro', source: 'dom', evidenceType: 'OBSERVED' }
      ]);
      assert('confirmedBy excludes heuristics and disagreeing sources', JSON.stringify(r.winner.confirmedBy) === '["network"]' && r.conflicts.length === 1);
    }

    // ------------------------------------------------------------ diagnostics: complete, current, no content
    {
      const { c, env, run, bridge } = harness({ api: { [CONV_A]: tree(CONV_A) }, dom: domTurns(), domModel: 'gpt-5-6' });
      await run();
      c.requestObserver.errorLog.push({ type: 'ENDPOINT_STATUS_ERROR', endpoint: `/backend-api/conversation/${CONV_A}/textdocs`, details: `Unexpected token 'M', "${SECRET_USER}" is not valid JSON` });
      c.requestObserver.errorLog.push({ type: 'ENDPOINT_STATUS_ERROR', endpoint: '/backend-api/me', details: 'Status 403' });
      bridge('ACCOUNT_PLAN_OBSERVED', { planType: 'plus' });
      await run();
      const d = c.getDiagnostics();
      const text = JSON.stringify(d);
      assert('Diagnostics include source, evidence, conflicts, agreements',
        d.conversation.dataSource === 'authoritative' && d.evidence.model.source === 'conversation_api' &&
        Array.isArray(d.conflicts) && d.agreements.includes('model'));
      assert('Diagnostics include confidence level, percentage, blockers and factors',
        d.confidence.level === c.latestState.confidence.level && typeof d.confidence.percentage === 'number' &&
        Array.isArray(d.confidence.highBlockers) && d.confidence.factors.length > 0);
      assert('Diagnostics include model, plan and context-limit resolution',
        d.resolved.model === 'chatgpt-instant' && d.resolved.plan === 'plus' && d.resolved.limit === 54000 && d.resolved.limitStatus === 'VERIFIED' && d.evidence.limit.reference);
      assert('Diagnostics include loading and turn-source information',
        d.conversation.loading === false && d.conversation.turns.api === 2 && d.conversation.turns.page === 2 && d.conversation.completeness.source === 'authoritative_api');
      assert('Diagnostics include all candidates per field', d.candidates.model.length >= 2 && d.candidates.plan.length === 2 && d.candidates.turns.length === 2);
      assert('Diagnostics contain no message text', !text.includes(SECRET_USER) && !text.includes(SECRET_ASSIST) && !text.includes('Initech'));
      assert('Diagnostics contain no raw conversation id (hash ref only)', !text.includes(CONV_A) && /^[0-9a-f]+$/.test(d.conversation.ref));
      assert('Network errors keep endpoint + status only, ids redacted', d.network.recentErrors.length === 2 &&
        d.network.recentErrors[0].endpoint.includes(':id') && d.network.recentErrors[0].status === null && d.network.recentErrors[1].status === 'Status 403');
      assert('Diagnostics carry no auth token fields', !/accessToken|authorization|bearer/i.test(text));
      assert('Diagnostics are stamped with copy time and state age', typeof d.copiedAt === 'string' && d.stateAgeMs >= 0);

      // Switched to B, still loading: A's data must not be copied as B's
      env.url = CONV_B;
      const w = c.getDiagnostics();
      assert('After switching conversation, stale data from the previous one is withheld',
        w.loading === true && !w.evidence && w.currentConversationRef !== d.conversation.ref);

      env.api[CONV_B] = tree(CONV_B, 'gpt-5-6-thinking');
      await run();
      const b = c.getDiagnostics();
      assert('Once read, diagnostics describe the current conversation only',
        b.conversation.ref === w.currentConversationRef && b.resolved.model === 'chatgpt-reasoning' && !JSON.stringify(b).includes(CONV_B));
    }

    // ------------------------------------------------------------ loading / error states
    {
      const { c, run } = harness({ apiStatus: 503 });
      const s = await run();
      const d = c.getDiagnostics();
      assert('Loading state is visible in diagnostics', d.conversation.loading === true && toWidgetState(s).ready === false);
      assert('API error and status are recorded', d.conversation.apiStatus === 503 && d.conversation.apiError === 'HTTP error 503');
      assert('Loading state claims no confidence in the widget', toWidgetState(s).ready === false && toWidgetState(s).percentage === null);
    }
    {
      const { c, run } = harness({ api: { [CONV_A]: tree(CONV_A) }, fromCapture: true });
      await run();
      const d = c.getDiagnostics();
      assert("Fallback to the page's own conversation copy is recorded", d.conversation.usedPageCopy === true && /page's own conversation response/.test(d.conversation.apiError));
    }
    {
      const c = harness().c;
      const d = c.getDiagnostics();
      assert('Before any read, diagnostics say so instead of showing stale data', d.note === 'Nothing read yet in this tab' && !d.evidence);
    }
  } finally {
    Object.assign(globalThis, saved);
  }

  console.log(`\n  Part 3 Confidence + Diagnostics Results: ${passed} passed, ${failed} failed`);
  return { passed, failed };
}
