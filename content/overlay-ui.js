/**
 * Context Monitor - Context Widget (provider-neutral UI)
 *
 * Renders the normalized view state from widget-state.js (toWidgetState). It knows nothing about
 * any AI site: a provider adapter supplies a name, `findInput()` (the chat input element),
 * `onRefresh()` (re-read the conversation now; may return a promise) and `getDiagnostics()`.
 * Everything lives in a shadow root, so the host page's CSS cannot reach it and ours never leaks out.
 *
 * One card, bottom-anchored. Expanding opens the details ABOVE the summary, so the summary (the
 * main element) never moves and the width never changes:
 *
 *   ContextDetails (open only)  Breakdown (+ used / remaining / window)
 *                               Confidence dropdown (closed by default) + all evidence
 *                               Diagnostics (warning, Copy diagnostics)
 *                               Model (provider, model · family, plan, source, turns)
 *   ContextSummary              [percentage] [confidence]            [refresh] [expand]
 *                               progress bar
 *                               used / total tokens
 *                               model · family
 *
 * The percentage is shown once (summary only). Components build their DOM once; update(vm) writes
 * only what changed, so repeated identical updates cause zero DOM mutations (no flicker, no lost
 * focus/scroll/open state), and page-derived strings are only ever assigned as text, never HTML.
 */

const STYLES = `
  :host { all: initial; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  .root {
    --primary: #6366F1; --accent: #06B6D4; --primary-text: #4F46E5;
    --surface: #FFFFFF; --subtle: #F8FAFC; --text: #0F172A; --muted: #64748B; --line: #E2E8F0; --track: #EEF2F7;
    --ok: #059669; --warn: #D97706; --bad: #DC2626;
    --shadow: 0 1px 2px rgba(15, 23, 42, .06), 0 8px 24px rgba(15, 23, 42, .10);
    font: 12.5px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-variant-numeric: tabular-nums;
    color: var(--text);
    color-scheme: light; /* native scrollbars and focus rings follow the widget theme */
    -webkit-font-smoothing: antialiased;
  }
  .root.dark {
    color-scheme: dark;
    --primary-text: #A5B4FC;
    --surface: #0F172A; --subtle: #111C33; --text: #E2E8F0; --muted: #94A3B8; --line: #1E293B; --track: #1E293B;
    --ok: #34D399; --warn: #FBBF24; --bad: #F87171;
    --shadow: 0 1px 2px rgba(0, 0, 0, .4), 0 10px 28px rgba(0, 0, 0, .45);
  }
  .card {
    display: flex; flex-direction: column; overflow: hidden;
    background: var(--surface); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow);
  }

  /* Summary (always visible) */
  .summary { padding: 12px 14px 11px; }
  .top { display: flex; align-items: center; gap: 8px; min-height: 30px; }
  .pct { display: inline-flex; align-items: baseline; gap: 4px; white-space: nowrap;
    font-size: 26px; font-weight: 700; line-height: 1; letter-spacing: -.02em; color: var(--primary-text); }
  .pct .unit { font-size: 10.5px; font-weight: 600; letter-spacing: .08em; color: var(--muted); }
  .pct.warn { color: var(--warn); } .pct.bad { color: var(--bad); }
  .spacer { flex: 1; }
  .badge {
    display: inline-flex; align-items: center; gap: 5px; font-size: 10px; font-weight: 700; letter-spacing: .06em;
    padding: 2px 7px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap;
    background: var(--subtle);
  }
  .badge i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; display: block; }
  .badge.HIGH { color: var(--ok); } .badge.MEDIUM { color: var(--warn); } .badge.LOW { color: var(--muted); }
  .toggle {
    all: unset; cursor: pointer; width: 26px; height: 26px; border-radius: 8px; display: grid; place-items: center;
    color: var(--muted); transition: background .15s ease, color .15s ease;
  }
  .toggle:hover { background: var(--track); color: var(--text); }
  .toggle:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }
  .toggle:disabled { cursor: default; opacity: .6; }
  .toggle.chev svg { transition: transform .2s ease; }
  .open .toggle.chev svg { transform: rotate(180deg); }
  .refreshing svg { animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .progress { height: 6px; border-radius: 999px; background: var(--track); overflow: hidden; margin: 10px 0 8px; }
  .progress b { display: block; height: 100%; width: 0; border-radius: inherit;
    background: linear-gradient(90deg, var(--primary), var(--accent)); transition: width .35s ease; }
  .progress.warn b { background: var(--warn); } .progress.bad b { background: var(--bad); }
  .tokens { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tokens .of { color: var(--muted); font-weight: 500; }
  .model { margin-top: 2px; color: var(--muted); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* Details (open only), above the summary inside the same card */
  .details { display: none; overflow: auto; overscroll-behavior: contain; max-height: var(--details-max, 60vh);
    border-bottom: 1px solid var(--line); scrollbar-width: thin; }
  .open .details { display: block; }
  .section { padding: 11px 14px; }
  .section + .section { border-top: 1px solid var(--line); }
  .h { font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
  .divider { border-top: 1px dashed var(--line); margin: 6px 0; }
  .conf > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 8px; margin: 0; }
  .conf > summary::-webkit-details-marker { display: none; }
  .conf > summary:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; border-radius: 4px; }
  .conf > summary svg { margin-left: auto; color: var(--muted); transition: transform .2s ease; }
  .conf[open] > summary svg { transform: rotate(180deg); }
  .row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 2px 0; }
  .row .k { color: var(--muted); white-space: nowrap; }
  .row .v { text-align: right; min-width: 0; overflow-wrap: anywhere; font-weight: 500; }
  .tag { font-size: 9px; font-weight: 700; letter-spacing: .05em; padding: 1px 5px; border-radius: 4px; margin-left: 6px;
    border: 1px solid var(--line); color: var(--muted); vertical-align: 1px; white-space: nowrap; }
  .tag:empty { display: none; }
  .tag.VERIFIED { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); }
  .evidence { list-style: none; display: flex; flex-direction: column; gap: 4px; margin-top: 8px; font-size: 12px; }
  .evidence li { display: flex; gap: 7px; align-items: baseline; }
  .evidence li span:last-child { min-width: 0; overflow-wrap: anywhere; }
  .evidence .y { color: var(--ok); } .evidence .n { color: var(--warn); }
  .warn-text { color: var(--warn); font-size: 12px; margin-bottom: 8px; }
  .warn-text:empty { display: none; }
  .btn { all: unset; cursor: pointer; font-size: 12px; font-weight: 600; color: var(--primary-text);
    border: 1px solid var(--line); border-radius: 8px; padding: 4px 10px; background: var(--subtle); }
  .btn:hover { border-color: var(--primary); }
  .btn:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }
  .fine { color: var(--muted); font-size: 11px; margin-top: 8px; }

  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; animation: none !important; }
  }
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

/** Writes only when the value changed: identical updates cause no DOM mutation. */
const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
const setClass = (node, cls) => { if (node.className !== cls) node.className = cls; };
const setAttr = (node, name, value) => { if (node.getAttribute(name) !== value) node.setAttribute(name, value); };

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

const tone = (p) => (p === null ? '' : p >= 85 ? 'bad' : p >= 65 ? 'warn' : '');

/** Progress bar; tone switches to warn/bad near the limit. */
function UsageProgress(parent) {
  const el = h('div', 'progress', parent);
  el.setAttribute('role', 'progressbar');
  el.setAttribute('aria-valuemin', '0');
  el.setAttribute('aria-valuemax', '100');
  el.setAttribute('aria-label', 'Context used');
  const fill = h('b', null, el);
  return {
    el,
    update(vm) {
      const p = vm.percentage;
      const display = p === null ? 'none' : '';
      if (el.style.display !== display) el.style.display = display;
      if (p === null) return;
      const width = `${Math.min(100, p)}%`;
      if (fill.style.width !== width) fill.style.width = width;
      setClass(el, `progress ${tone(p)}`.trim());
      setAttr(el, 'aria-valuenow', String(p));
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
      const display = vm.ready === false ? 'none' : ''; // No confidence claim before there is data
      if (el.style.display !== display) el.style.display = display;
      setClass(el, `badge ${vm.confidenceLevel}`);
      setText(label, withScore ? `${vm.confidence}% ${vm.confidenceLevel}` : vm.confidenceLevel);
      setAttr(el, 'title', `Measurement confidence ${vm.confidence}%`);
    }
  };
}

/** "GPT-5.6 · Instant" */
const modelText = (vm) => [vm.model, vm.modelFamily].filter(Boolean).join(' · ');

function ContextSummary(parent, onToggle, onRefresh) {
  const el = h('div', 'summary', parent);
  const top = h('div', 'top', el);
  const pct = h('span', 'pct', top);
  const pctNum = h('span', 'num', pct);
  const pctUnit = h('span', 'unit', pct);
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
  const used = h('span', null, tokens);
  const of = h('span', 'of', tokens);
  const model = h('div', 'model', el);
  return {
    el,
    setExpanded(open) {
      setAttr(toggle, 'aria-expanded', String(open));
      setAttr(toggle, 'aria-label', open ? 'Hide context details' : 'Show context details');
    },
    update(vm) {
      if (!vm.ready) {
        setText(pctNum, '…');
        setText(pctUnit, '');
      } else if (vm.percentage === null) {
        setText(pctNum, fmtK(vm.usedTokens));
        setText(pctUnit, 'TOKENS');
      } else {
        setText(pctNum, `${fmtPct(vm.percentage, vm.usedTokens)}%`);
        setText(pctUnit, 'USED');
      }
      setClass(pct, `pct ${vm.ready ? tone(vm.percentage) : ''}`.trim());
      confidence.update(vm);
      progress.update(vm);
      if (!vm.ready) {
        setText(used, 'Reading conversation…');
        setText(of, '');
      } else if (vm.contextLimit) {
        setText(used, fmtK(vm.usedTokens));
        setText(of, ` / ${fmtK(vm.contextLimit)} tokens`);
      } else {
        setText(used, fmtK(vm.usedTokens));
        setText(of, ` / window unknown${vm.plan ? '' : ' (plan not detected)'}`);
      }
      setText(model, modelText(vm));
      setAttr(model, 'title', `${vm.provider}: ${model.textContent}`);
    }
  };
}

/** Label/value rows (optionally tagged). Rebuilt only when the rows actually change. */
function RowList(parent) {
  const el = h('div', null, parent);
  let signature = null;
  return {
    update(rows) {
      const next = JSON.stringify(rows);
      if (next === signature) return;
      signature = next;
      el.textContent = '';
      for (const r of rows) {
        const row = h('div', 'row', el);
        h('span', 'k', row, r.label);
        const v = h('span', 'v', row, r.value);
        if (r.tag) h('span', `tag ${r.tag}`, v, r.tag);
      }
    }
  };
}

/** Every confidence reason / evidence line, in engine order. Rebuilt only when the list changes. */
function EvidenceList(parent) {
  const el = h('ul', 'evidence', parent);
  let signature = null;
  return {
    update(vm) {
      const next = JSON.stringify(vm.evidence);
      if (next === signature) return;
      signature = next;
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
    const s = h('section', 'section', el);
    h('div', 'h', s, title);
    return s;
  };

  // Breakdown (top): what the used tokens are made of, then the exact totals.
  // The percentage and bar are in the summary only, so they are not repeated here.
  const brk = section('Breakdown');
  const parts = RowList(brk);
  h('div', 'divider', brk);
  const totals = RowList(brk);

  // Confidence: native dropdown, closed by default; open state survives updates (DOM is built once)
  const conf = h('details', 'section conf', el);
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
  const modelRows = RowList(mdl);

  return {
    el,
    update(vm) {
      // While loading, show dashes rather than zeros
      const tokens = (n) => (vm.ready === false || n === null ? '—' : `${n.toLocaleString()} tokens`);
      parts.update(vm.breakdown.map(b => ({ label: b.label, value: b.value, tag: b.tag || null })));
      totals.update([
        { label: 'Used', value: tokens(vm.usedTokens), tag: null },
        { label: 'Remaining', value: tokens(vm.remainingTokens), tag: null },
        { label: 'Window', value: vm.contextLimit ? `${vm.contextLimit.toLocaleString()} tokens` : 'Unknown', tag: vm.limitStatus || null }
      ]);

      badge.update(vm);
      evidence.update(vm);

      setText(warn, vm.warning || '');

      modelRows.update([
        { label: 'Provider', value: vm.provider, tag: null },
        { label: 'Model', value: modelText(vm), tag: null },
        { label: 'Plan', value: vm.plan || 'Unknown', tag: null },
        { label: 'Source', value: vm.source || '—', tag: null },
        { label: 'Turns', value: vm.ready === false ? '—' : String(vm.turns), tag: null }
      ]);
    }
  };
}

const WIDTH = 300; // One width, collapsed or open: expanding never shifts the card sideways
const GAP = 16;

export class ContextWidget {
  /**
   * @param {{ provider?: string, findInput?: () => Element|null, onRefresh?: () => any, getDiagnostics?: () => Object }} [adapter]
   *   Provider adapter: display name, a way to find the chat input, a refresh action and the
   *   diagnostics source. Nothing else is site-specific.
   */
  constructor(adapter = {}) {
    this.adapter = {
      provider: adapter.provider || 'AI',
      findInput: adapter.findInput || (() => null),
      onRefresh: adapter.onRefresh || (() => {}),
      // Copy diagnostics source; the provider can check it still matches what is on screen
      getDiagnostics: adapter.getDiagnostics || (() => this.latestState?.diagnostics)
    };
    this.hostElement = null;
    this.shadowRoot = null;
    this.isExpanded = false;
    this.isVisible = true;
    this.latestState = null;
    this.parts = null;
    this._raf = null;
    this._observedInput = null;
    this._resizeObserver = null;
  }

  mount() {
    if (this.hostElement || typeof document === 'undefined') return;
    document.getElementById('chatgpt-context-monitor-host')?.remove();

    this.hostElement = document.createElement('div');
    this.hostElement.id = 'chatgpt-context-monitor-host';
    // Own stacking/paint context so the page's layout and styles cannot leak in or be disturbed
    this.hostElement.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;contain:layout style;';
    this.shadowRoot = this.hostElement.attachShadow({ mode: 'open' });
    h('style', null, this.shadowRoot, STYLES);

    const root = h('div', 'root', this.shadowRoot);
    const card = h('div', 'card', root);
    const details = ContextDetails(card, () => this.adapter.getDiagnostics());
    const summary = ContextSummary(card, () => {
      this.isExpanded = !this.isExpanded;
      this.render();
    }, () => this.adapter.onRefresh());
    this.parts = { root, card, details, summary };

    (document.body || document.documentElement).appendChild(this.hostElement);
    window.addEventListener('resize', () => this._schedulePosition());
    if (typeof ResizeObserver !== 'undefined') {
      // The chat input grows while typing; keep clear of it without waiting for a data update
      this._resizeObserver = new ResizeObserver(() => this._schedulePosition());
    }
    // Follow the site's light/dark switch immediately (sites flip a class/attribute on <html>/<body>)
    const themeWatch = new MutationObserver(() => this._applyTheme());
    for (const node of [document.documentElement, document.body].filter(Boolean)) {
      themeWatch.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme'] });
    }
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => this._applyTheme());
    this.render();
  }

  /** Light/dark from the page itself; writes only when it flips. */
  _applyTheme() {
    if (!this.parts) return;
    const { root } = this.parts;
    setClass(root, ['root', this._isDarkPage() ? 'dark' : '', this.isExpanded ? 'open' : ''].filter(Boolean).join(' '));
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
    const display = this.isVisible ? '' : 'none';
    if (this.hostElement.style.display !== display) this.hostElement.style.display = display;
    const { details, summary } = this.parts;

    this._applyTheme();
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
    if (this._resizeObserver && input !== this._observedInput) {
      if (this._observedInput) this._resizeObserver.unobserve(this._observedInput);
      this._resizeObserver.observe(input);
      this._observedInput = input;
    }
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

  /** Coalesces resize bursts into one layout pass per frame. */
  _schedulePosition() {
    if (this._raf) return;
    const run = () => { this._raf = null; this._position(); };
    this._raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : setTimeout(run, 16);
  }

  /**
   * Beside the composer when there is room, otherwise right-aligned just above it; corner fallback.
   * The placement depends only on the page layout (never on open/closed), and styles are written only
   * when they change, so updates and expanding never make the card jump.
   */
  _position() {
    if (!this.hostElement || !this.parts) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.max(200, Math.min(WIDTH, vw - 24));
    const r = this._composerRect();
    let left = 'auto';
    let right = '12px';
    let bottom = GAP;
    let placement = 'corner';

    if (r && r.top > 80 && vw - r.right - 2 * GAP >= width) {
      placement = 'beside';
      left = `${Math.round(r.right + GAP)}px`;
      right = 'auto';
      bottom = Math.max(8, Math.round(vh - r.bottom));
    } else if (r && r.top > 80) {
      placement = 'above';
      right = `${Math.max(12, Math.round(vw - r.right))}px`;
      bottom = Math.max(8, Math.round(vh - r.top + 8));
    }

    const s = this.hostElement.style;
    if (s.left !== left) s.left = left;
    if (s.right !== right) s.right = right;
    if (s.bottom !== `${bottom}px`) s.bottom = `${bottom}px`;
    const w = `${width}px`;
    if (this.parts.root.style.width !== w) this.parts.root.style.width = w;
    if (this.hostElement.dataset.placement !== placement) this.hostElement.dataset.placement = placement;

    // Details open upward above the summary; keep the whole card inside the viewport
    const summaryHeight = this.parts.summary.el.getBoundingClientRect().height || 90;
    const max = `${Math.max(120, vh - bottom - summaryHeight - 24)}px`;
    if (this.parts.root.style.getPropertyValue('--details-max') !== max) this.parts.root.style.setProperty('--details-max', max);
  }

  unmount() {
    this._resizeObserver?.disconnect();
    this.hostElement?.remove();
    this.hostElement = null;
    this.shadowRoot = null;
    this.parts = null;
  }
}
