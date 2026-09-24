/**
 * Unit Tests for the provider-neutral widget view state (content/widget-state.js)
 * The UI must display engine values unchanged: only formatting, never recalculation.
 */

import { toWidgetState, formatModelName } from '../../content/widget-state.js';

export function runWidgetStateTests() {
  console.log('--- Running Widget View-State Tests ---');
  let passed = 0;
  let failed = 0;
  const assert = (name, cond) => {
    if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; } else { console.error(`  ❌ [FAIL] ${name}`); failed++; }
  };

  const engine = {
    model: { id: 'chatgpt-instant', displayName: 'gpt-5-6 (Instant)', contextWindow: 54000, limitStatus: 'VERIFIED' },
    plan: { tier: 'go' },
    tokens: { totalMeasurable: 7060, user: 3132, assistant: 3928, attachments: 0 },
    utilization: { percentage: 13.1 },
    confidence: { level: 'HIGH', percentage: 100, factors: [
      { type: 'positive', text: 'Exact tokenizer' }, { type: 'negative', text: 'Tool internal overhead unknown' }] },
    observables: { dataSource: 'authoritative', messagesCount: 17, attachmentsCount: 0 },
    completeness: { domIsPartial: true },
    diagnostics: { session: { ok: true } }
  };
  const vm = toWidgetState(engine, { provider: 'ChatGPT' });

  assert('Percentage passed through unchanged', vm.percentage === 13.1);
  assert('Used / limit / remaining taken from engine', vm.usedTokens === 7060 && vm.contextLimit === 54000 && vm.remainingTokens === 46940);
  assert('Confidence score and level passed through unchanged', vm.confidence === 100 && vm.confidenceLevel === 'HIGH');
  assert('Evidence mirrors engine factors (no invented reasons)', vm.evidence.length === 2 && vm.evidence[0].ok && !vm.evidence[1].ok && vm.evidence[0].text === 'Exact tokenizer');
  assert('Model and family split for display', vm.model === 'GPT-5.6' && vm.modelFamily === 'Instant');
  assert('Plan formatted', vm.plan === 'Go');
  assert('Provider name comes from the adapter', vm.provider === 'ChatGPT' && vm.breakdown[1].label === 'ChatGPT + tools');
  assert('No "count may be low" warning when the full conversation came from the API', vm.warning === null);
  assert('Diagnostics carried through for the copy button', vm.diagnostics?.session?.ok === true);

  const domOnly = toWidgetState({ ...engine, observables: { dataSource: 'dom_fallback', messagesCount: 4 }, model: { id: 'unknown' } });
  assert('Unknown model -> no limit, no percentage', domOnly.contextLimit === null && domOnly.percentage === null && domOnly.model === 'Model unknown');
  assert('Partial page-text count still warns', /Count may be low/.test(domOnly.warning || ''));
  assert('Not-ready state before first engine pass', toWidgetState(null).ready === false);

  assert('formatModelName: gpt-5-5-thinking', formatModelName('gpt-5-5-thinking') === 'GPT-5.5 Thinking');
  assert('formatModelName: gpt-4o-mini', formatModelName('gpt-4o-mini') === 'GPT-4o Mini');
  assert('formatModelName: non-GPT names pass through', formatModelName('claude-sonnet-4') === 'claude-sonnet-4');

  return { passed, failed };
}
