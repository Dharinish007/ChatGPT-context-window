/**
 * Context Monitor - Context Widget (provider-neutral UI)
 *
 * Renders the normalized view state from widget-state.js (toWidgetState). It knows nothing about
 * any AI site: a provider adapter supplies `findInput()` (the chat input element), a name, and
 * `onRefresh()` (re-read the conversation now; may return a promise).
 *
 * Components (each builds its DOM once and exposes update(vm), so updates only change text:
 * no flicker, no lost expand state, and page-derived strings never become HTML):
 *   ContextSummary  - collapsed card: percentage, ConfidenceBadge, refresh, toggle, UsageProgress, used/total, ModelInfo
 *   ContextDetails  - expanded sections, top to bottom: breakdown (+ used/remaining/window),
 *                     confidence dropdown (closed by default) + EvidenceList, diagnostics, model
 * The percentage and progress bar live only in the summary card.
 */

const STYLES = `
  :host { all: initial; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  .root {
    --primary: #6366F1; --accent: #06B6D4;
    --bg: #F8FAFC; --card: #FFFFFF; --text: #0F172A; --muted: #64748B; --line: #E2E8F0; --track: #E2E8F0;
    --ok: #059669; --warn: #D97706; --bad: #DC2626; --shadow: 0 4px 16px rgba(15, 23, 42, 0.10);
    font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-variant-numeric: tabular-nums;
    color: var(--text);
    display: flex; flex-direction: column; align-items: stretch; gap: 8px;
  }
  .root.dark {
    --bg: #0F172A; --card: #111827; --text: #F1F5F9; --muted: #94A3B8; --line: #1F2937; --track: #1E293B;
    --ok: #34D399; --warn: #FBBF24; --bad: #F87171; --shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
  }
  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow);
  }

  /* ContextSummary (collapsed) */
  .summary { padding: 10px 12px; min-width: 200px; }
  .top { display: flex; align-items: center; gap: 8px; }
  .pct { font-size: 18px; font-weight: 700; color: var(--primary); letter-spacing: -0.01em; }
  .pct small { font-size: 10px; font-weight: 600; letter-spacing: .08em; color: var(--muted); margin-left: 4px; }
  .spacer { flex: 1; }
  .badge {
    display: inline-flex; align-items: center; gap: 5px; font-size: 10px; font-weight: 700; letter-spacing: .06em;
    padding: 2px 7px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap;
  }
  .badge i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; display: block; }
  .badge.HIGH { color: var(--ok); } .badge.MEDIUM { color: var(--warn); } .badge.LOW { color: var(--muted); }
  .toggle {
    all: unset; cursor: pointer; width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center;
    color: var(--muted); transition: background .15s ease;
  }
  .toggle:hover { background: var(--track); color: var(--text); }
  .toggle:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }
  .toggle:disabled { cursor: default; opacity: .6; }
  .open .toggle.chev { transform: rotate(180deg); }
  .refreshing svg { animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .progress { height: 4px; border-radius: 999px; background: var(--track); overflow: hidden; margin: 8px 0 7px; }
  .progress b { display: block; height: 100%; width: 0; border-radius: inherit;
    background: linear-gradient(90deg, var(--primary), var(--accent)); transition: width .3s ease; }
  .progress.warn b { background: var(--warn); } .progress.bad b { background: var(--bad); }
  .tokens { font-weight: 600; }
  .model { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* ContextDetails (expanded) */
  .details { display: none; flex-direction: column; gap: 8px; overflow: auto; max-height: var(--details-max, 60vh);
    padding: 2px; margin: -2px; }
  .open .details { display: flex; }
  .section { padding: 10px 12px; }
  .h { font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
  .divider { border-top: 1px solid var(--line); margin: 6px 0; }
  .conf > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 8px; margin: 0; }
  .conf > summary::-webkit-details-marker { display: none; }
  .conf > summary:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; border-radius: 4px; }
  .conf > summary svg { margin-left: auto; color: var(--muted); transition: transform .15s ease; }
  .conf[open] > summary svg { transform: rotate(180deg); }
  .row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 2px 0; }
  .row .k { color: var(--muted); white-space: nowrap; }
  .row .v { text-align: right; min-width: 0; overflow-wrap: anywhere; }
  .tag { font-size: 9px; font-weight: 700; letter-spacing: .05em; padding: 1px 5px; border-radius: 4px; margin-left: 6px;
    border: 1px solid var(--line); color: var(--muted); vertical-align: 1px; white-space: nowrap; }
  .tag.VERIFIED { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); }
  .evidence { list-style: none; display: flex; flex-direction: column; gap: 3px; margin-top: 6px; font-size: 12px; }
  .evidence li { display: flex; gap: 6px; }
  .evidence .y { color: var(--ok); } .evidence .n { color: var(--warn); }
  .warn-text { color: var(--warn); font-size: 12px; margin-bottom: 8px; }
  .btn { all: unset; cursor: pointer; font-size: 12px; font-weight: 600; color: var(--primary);
    border: 1px solid var(--line); border-radius: 8px; padding: 4px 10px; }
  .btn:hover { border-color: var(--primary); }
  .btn:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }
  .fine { color: var(--muted); font-size: 11px; margin-top: 6px; }
`;

const fmtK = (n) => {
  if (n === null || n === undefined) return '—';
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(Math.round(n / 100) / 10).toString().replace(/\.0$/, '')}K`;
  return `${(Math.round(n / 1e4) / 100).toString()}M`;
};
const fmtPct = (p, used) => (p === 0 && used > 0 ? '<0.1' : String(p));

function h(tag, cls, parent, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  if (parent) parent.appendChild(n);
  return n;
}

/** Stroked 16x16 SVG icon from one path. */
function icon(parent, d) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.75');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  parent.appendChild(svg);
  return svg;
}
const CHEVRON_UP = 'M4 10l4-4 4 4';
const CHEVRON_DOWN = 'M4 6l4 4 4-4';
const REFRESH = 'M13 8a5 5 0 1 1-1.5-3.55M13 2.5v3h-3';

/** Progress bar; tone switches to warn/bad near the limit. */
function UsageProgress(parent) {
  const el = h('div', 'progress', parent);
  el.setAttribute('role', 'progressbar');
  el.setAttribute('aria-valuemin', '0');
  el.setAttribute('aria-valuemax', '100');
  const fill = h('b', null, el);
  return {
    el,
    update(vm) {
      const p = vm.percentage;
      el.style.display = p === null ? 'none' : '';
      if (p === null) return;
      fill.style.width = `${Math.min(100, p)}%`;
      el.classList.toggle('warn', p >= 65 && p < 85);
      el.classList.toggle('bad', p >= 85);
      el.setAttribute('aria-valuenow', String(p));
    }
  };
}

/** "● HIGH" or "● 100% HIGH" using the engine's confidence as-is. */
function ConfidenceBadge(parent, withScore = false) {
  const el = h('span', 'badge', parent);
  h('i', null, el);
  const label = h('span', null, el);
  return {
    update(vm) {
      el.style.display = vm.ready === false ? 'none' : ''; // No confidence claim before there is data
      el.className = `badge ${vm.confidenceLevel}`;
      label.textContent = withScore ? `${vm.confidence}% ${vm.confidenceLevel}` : vm.confidenceLevel;
      el.title = `Measurement confidence ${vm.confidence}%`;
    }
  };
}

/** "GPT-5.6 · Instant" (+ plan when requested). */
function ModelInfo(parent, withPlan = false) {
  const el = h('div', 'model', parent);
  return {
    update(vm) {
      el.textContent = [vm.model, vm.modelFamily, withPlan && vm.plan ? `${vm.plan} plan` : null].filter(Boolean).join(' · ');
      el.title = `${vm.provider}: ${el.textContent}`;
    }
  };
}

function ContextSummary(parent, onToggle, onRefresh) {
  const el = h('div', 'card summary', parent);
  const top = h('div', 'top', el);
  const pct = h('span', 'pct', top);
  const confidence = ConfidenceBadge(top);
  h('span', 'spacer', top);

  // Refresh: re-reads the conversation now; spins and is disabled until the pass finishes
  const refresh = h('button', 'toggle refresh', top);
  icon(refresh, REFRESH);
  refresh.setAttribute('aria-label', 'Refresh context data');
  refresh.title = 'Refresh';
  refresh.addEventListener('click', async () => {
    if (refresh.disabled) return;
    refresh.disabled = true;
    refresh.classList.add('refreshing');
    try {
      await onRefresh();
    } catch (_) {
      // The next automatic pass still updates the widget
    } finally {
      refresh.disabled = false;
      refresh.classList.remove('refreshing');
    }
  });

  const toggle = h('button', 'toggle chev', top);
  icon(toggle, CHEVRON_UP); // Details open upward; rotates 180° when open
  toggle.setAttribute('aria-label', 'Show context details');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.addEventListener('click', onToggle);
  const progress = UsageProgress(el);
  const tokens = h('div', 'tokens', el);
  const model = ModelInfo(el);
  return {
    el,
    setExpanded(open) {
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Hide context details' : 'Show context details');
    },
    update(vm) {
      pct.textContent = '';
      if (!vm.ready) {
        pct.textContent = '…';
      } else if (vm.percentage === null) {
        pct.append(fmtK(vm.usedTokens));
        h('small', null, pct, 'TOKENS');
      } else {
        pct.append(`${fmtPct(vm.percentage, vm.usedTokens)}%`);
        h('small', null, pct, 'USED');
      }
      confidence.update(vm);
      progress.update(vm);
      tokens.textContent = !vm.ready ? 'Reading conversation…'
        : vm.contextLimit ? `${fmtK(vm.usedTokens)} / ${fmtK(vm.contextLimit)}`
        : `${fmtK(vm.usedTokens)} / window unknown${vm.plan ? '' : ' (plan not detected)'}`;
      model.update(vm);
    }
  };
}

function EvidenceList(parent) {
  const el = h('ul', 'evidence', parent);
  return {
    update(vm) {
      el.textContent = '';
      for (const e of vm.evidence) {
        const li = h('li', null, el);
        h('span', e.ok ? 'y' : 'n', li, e.ok ? '✓' : '!');
        h('span', null, li, e.text);
      }
    }
  };
}

function ContextDetails(parent, getDiagnostics) {
  const el = h('div', 'details', parent);
  const section = (title) => {
    const s = h('section', 'card section', el);
    h('div', 'h', s, title);
    return s;
  };
  const rowIn = (s, label) => {
    const r = h('div', 'row', s);
    h('span', 'k', r, label);
    return h('span', 'v', r);
  };
  const tagged = (node, text, tag) => {
    node.textContent = text;
    if (tag) h('span', `tag ${tag}`, node, tag);
  };

  // Breakdown (top): what the used tokens are made of, then the exact totals.
  // The percentage and bar are in the summary card only, so they are not repeated here.
  const brk = section('Breakdown');
  const brkRows = h('div', null, brk);
  h('div', 'divider', brk);
  const usedRow = rowIn(brk, 'Used');
  const leftRow = rowIn(brk, 'Remaining');
  const limitRow = rowIn(brk, 'Window');

  // Confidence: native dropdown, closed by default; open state survives updates (DOM is built once)
  const conf = h('details', 'card section conf', el);
  const confHead = h('summary', 'h', conf);
  h('span', null, confHead, 'Confidence');
  const badge = ConfidenceBadge(confHead, true);
  icon(confHead, CHEVRON_DOWN);
  const evidence = EvidenceList(conf);

  // Diagnostics
  const diag = section('Diagnostics');
  const warn = h('div', 'warn-text', diag);
  const copy = h('button', 'btn', diag, 'Copy diagnostics');
  h('div', 'fine', diag, 'Counts visible text only. Hidden system prompts and memory are not measurable.');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(getDiagnostics() || { note: 'no state yet' }, null, 2));
      copy.textContent = 'Copied ✓';
    } catch (_) {
      copy.textContent = 'Copy failed';
    }
    setTimeout(() => { copy.textContent = 'Copy diagnostics'; }, 1500);
  });

  // Model (bottom)
  const mdl = section('Model');
  const providerRow = rowIn(mdl, 'Provider');
  const modelRow = rowIn(mdl, 'Model');
  const planRow = rowIn(mdl, 'Plan');
  const sourceRow = rowIn(mdl, 'Source');
  const turnsRow = rowIn(mdl, 'Turns');

  return {
    el,
    update(vm) {
      // While loading, show dashes rather than zeros
      const tokens = (n) => (vm.ready === false || n === null ? '—' : `${n.toLocaleString()} tokens`);
      usedRow.textContent = tokens(vm.usedTokens);
      leftRow.textContent = tokens(vm.remainingTokens);
      tagged(limitRow, vm.contextLimit ? `${vm.contextLimit.toLocaleString()} tokens` : 'Unknown', vm.limitStatus);

      providerRow.textContent = vm.provider;
      modelRow.textContent = [vm.model, vm.modelFamily].filter(Boolean).join(' · ');
      planRow.textContent = vm.plan || 'Unknown';
      sourceRow.textContent = vm.source || '—';
      turnsRow.textContent = vm.ready === false ? '—' : String(vm.turns);

      brkRows.textContent = '';
      for (const b of vm.breakdown) tagged(rowIn(brkRows, b.label), b.value, b.tag);

      badge.update(vm);
      evidence.update(vm);

      warn.textContent = vm.warning || '';
      warn.style.display = vm.warning ? '' : 'none';
    }
  };
}

export class ContextWidget {
  /**
   * @param {{ provider?: string, findInput?: () => Element|null, onRefresh?: () => any }} [adapter]
   *   Provider adapter: display name, a way to find the chat input, and a refresh action. Nothing else is site-specific.
   */
  constructor(adapter = {}) {
    this.adapter = { provider: adapter.provider || 'AI', findInput: adapter.findInput || (() => null), onRefresh: adapter.onRefresh || (() => {}) };
    this.hostElement = null;
    this.shadowRoot = null;
    this.isExpanded = false;
    this.isVisible = true;
    this.latestState = null;
    this.parts = null;
  }

  mount() {
    if (this.hostElement || typeof document === 'undefined') return;
    document.getElementById('chatgpt-context-monitor-host')?.remove();

    this.hostElement = document.createElement('div');
    this.hostElement.id = 'chatgpt-context-monitor-host';
    this.hostElement.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;';
    this.shadowRoot = this.hostElement.attachShadow({ mode: 'open' });
    h('style', null, this.shadowRoot, STYLES);

    const root = h('div', 'root', this.shadowRoot);
    const details = ContextDetails(root, () => this.latestState?.diagnostics);
    const summary = ContextSummary(root, () => {
      this.isExpanded = !this.isExpanded;
      this.render();
    }, () => this.adapter.onRefresh());
    this.parts = { root, details, summary };

    (document.body || document.documentElement).appendChild(this.hostElement);
    window.addEventListener('resize', () => this._position());
    this.render();
  }

  /** @param {Object} viewState Output of toWidgetState() */
  update(viewState) {
    this.latestState = viewState;
    if (!this.hostElement) this.mount();
    // SPA re-renders can drop our node; re-attach instead of rebuilding
    if (!this.hostElement.isConnected) (document.body || document.documentElement).appendChild(this.hostElement);
    this.render();
  }

  render() {
    if (!this.hostElement || !this.parts) return;
    this.hostElement.style.display = this.isVisible ? '' : 'none';
    const { root, details, summary } = this.parts;

    root.classList.toggle('dark', this._isDarkPage());
    root.classList.toggle('open', this.isExpanded);
    summary.setExpanded(this.isExpanded);

    const vm = this.latestState || { ready: false, percentage: null, usedTokens: 0, evidence: [], breakdown: [], confidenceLevel: 'LOW', confidence: 0, provider: this.adapter.provider, model: 'Detecting…' };
    summary.update(vm);
    if (this.isExpanded) details.update(vm);

    this._position();
  }

  /** Theme from the host page's actual background, so it works on any provider. */
  _isDarkPage() {
    try {
      for (const node of [document.body, document.documentElement]) {
        const m = node && getComputedStyle(node).backgroundColor.match(/\d+(\.\d+)?/g);
        if (m && (m.length < 4 || Number(m[3]) > 0)) {
          const [r, g, b] = m.map(Number);
          return (0.299 * r + 0.587 * g + 0.114 * b) < 128;
        }
      }
    } catch (_) {}
    return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  /**
   * Finds the visual composer box around the adapter's input: the outermost ancestor that is
   * still input-sized (short and not full-width). Works without knowing the site's markup.
   */
  _composerRect() {
    const input = this.adapter.findInput();
    if (!input || !input.getBoundingClientRect) return null;
    let box = input;
    let rect = input.getBoundingClientRect();
    for (let el = input.parentElement; el && el !== document.body; el = el.parentElement) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue; // display: contents wrappers
      if (r.height > 260 || r.width >= window.innerWidth - 4) break; // page-level wrapper, not the composer
      box = el;
      rect = r;
    }
    return box && rect.width > 0 ? rect : null;
  }

  /** Beside the composer when there is room, otherwise right-aligned just above it; corner fallback. */
  _position() {
    if (!this.hostElement || !this.parts) return;
    const s = this.hostElement.style;
    const root = this.parts.root;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const COLLAPSED = 260;
    const EXPANDED = 360;
    const r = this._composerRect();
    const besideRoom = r ? vw - r.right - 32 : 0;
    let width;
    let bottom = 16;

    // The side is chosen from the collapsed width only, so expanding never makes the widget jump
    if (r && r.top > 80 && besideRoom >= COLLAPSED) {
      width = this.isExpanded ? Math.min(EXPANDED, besideRoom) : COLLAPSED;
      s.left = `${Math.round(r.right + 16)}px`;
      s.right = 'auto';
      bottom = Math.max(8, Math.round(vh - r.bottom));
    } else if (r && r.top > 80) {
      width = Math.min(this.isExpanded ? EXPANDED : COLLAPSED, vw - 24);
      s.left = 'auto';
      s.right = `${Math.max(12, Math.round(vw - r.right))}px`;
      bottom = Math.max(8, Math.round(vh - r.top + 8));
    } else {
      width = Math.min(this.isExpanded ? EXPANDED : COLLAPSED, vw - 24);
      s.left = 'auto';
      s.right = '12px';
    }
    root.style.width = `${Math.max(180, width)}px`;
    s.bottom = `${bottom}px`;
    // Expanded details grow upward above the summary card; keep them inside the viewport
    const summaryHeight = this.parts.summary.el.getBoundingClientRect().height || 90;
    root.style.setProperty('--details-max', `${Math.max(120, vh - bottom - summaryHeight - 24)}px`);
  }

  unmount() {
    this.hostElement?.remove();
    this.hostElement = null;
    this.shadowRoot = null;
    this.parts = null;
  }
}
