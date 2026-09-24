/**
 * ChatGPT Context Monitor - In-Page Status Bar
 *
 * A persistent one-line context status bar (in the spirit of Claude Code / Codex:
 * "12.4K / 54K · 23% · 77% left") docked above ChatGPT's composer (bottom-right fallback).
 * - Built once, then updated in place (textContent only): no flicker, no lost hover/expand
 *   state, and page-derived strings can never inject HTML.
 * - Click to expand an upward details panel; it never hides itself.
 * - Shadow DOM keeps ChatGPT's CSS out and ours in.
 */

const STYLES = `
  :host { all: initial; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  .wrap {
    --bg: rgba(24, 24, 27, 0.96); --fg: #e4e4e7; --muted: #a1a1aa; --line: rgba(255,255,255,0.10);
    --track: rgba(255,255,255,0.10); --ok: #10a37f; --warn: #f59e0b; --bad: #ef4444; --unk: #71717a;
    font: 12px/1.4 ui-monospace, SFMono-Regular, "Cascadia Mono", Menlo, Consolas, monospace;
    color: var(--fg);
    display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
  }
  .wrap.light {
    --bg: rgba(255, 255, 255, 0.97); --fg: #18181b; --muted: #52525b; --line: rgba(0,0,0,0.10);
    --track: rgba(0,0,0,0.08); --unk: #a1a1aa;
  }
  .bar, .panel {
    background: var(--bg); border: 1px solid var(--line); border-radius: 10px;
    box-shadow: 0 6px 24px rgba(0,0,0,0.25);
    backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  }
  .bar {
    display: flex; align-items: center; gap: 10px; padding: 6px 10px;
    cursor: pointer; color: inherit; font: inherit; text-align: left;
    white-space: nowrap; max-width: calc(100vw - 32px);
  }
  .bar:focus-visible { outline: 2px solid var(--ok); outline-offset: 2px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--unk); flex: none; }
  .meter { display: block; width: 64px; height: 4px; border-radius: 2px; background: var(--track); overflow: hidden; flex: none; }
  .fill { display: block; height: 100%; width: 0; background: var(--ok); transition: width .25s ease; }
  .tokens { font-weight: 600; }
  .muted { color: var(--muted); }
  .sep { color: var(--line); }
  .model { overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
  .chev { color: var(--muted); font-size: 10px; }

  .panel { width: 360px; max-width: calc(100vw - 32px); max-height: var(--panel-max, 60vh); overflow: auto; padding: 12px; display: none; }
  .panel.open { display: block; }
  .row { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; }
  .row .k { color: var(--muted); white-space: nowrap; }
  .row .v { text-align: right; overflow-wrap: anywhere; }
  .tag { font-size: 10px; padding: 0 4px; border-radius: 3px; margin-left: 6px; border: 1px solid var(--line); color: var(--muted); }
  .h { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; margin: 10px 0 4px; }
  .notes { display: flex; flex-direction: column; gap: 2px; font-size: 11px; }
  .notes .pos { color: var(--ok); }
  .notes .neg { color: var(--warn); }
  .warn { color: var(--warn); font-size: 11px; margin-top: 6px; }
  .actions { display: flex; justify-content: space-between; align-items: center; margin-top: 10px; gap: 8px; }
  .btn {
    font: inherit; font-size: 11px; color: var(--fg); background: transparent;
    border: 1px solid var(--line); border-radius: 6px; padding: 3px 8px; cursor: pointer;
  }
  .btn:hover { border-color: var(--muted); }
  .fine { color: var(--muted); font-size: 10px; }
`;

export class OverlayUI {
  constructor() {
    this.hostElement = null;
    this.shadowRoot = null;
    this.isExpanded = false;
    this.isVisible = true;
    this.latestState = null;
    this.el = {};
  }

  mount() {
    if (this.hostElement || typeof document === 'undefined') return;
    const existing = document.getElementById('chatgpt-context-monitor-host');
    if (existing) existing.remove();

    this.hostElement = document.createElement('div');
    this.hostElement.id = 'chatgpt-context-monitor-host';
    this.hostElement.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;';
    this.shadowRoot = this.hostElement.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = STYLES;
    this.shadowRoot.appendChild(style);

    const make = (tag, cls, parent, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text) n.textContent = text;
      if (parent) parent.appendChild(n);
      return n;
    };

    const wrap = make('div', 'wrap', this.shadowRoot);

    // Details panel (opens upward, above the bar)
    const panel = make('div', 'panel', wrap);
    panel.id = 'cm-panel';
    const rows = {};
    const addRow = (key, label) => {
      const r = make('div', 'row', panel);
      make('span', 'k', r, label);
      rows[key] = make('span', 'v', r);
    };
    make('div', 'h', panel, 'Context');
    addRow('used', 'Used');
    addRow('limit', 'Window');
    addRow('left', 'Remaining');
    make('div', 'h', panel, 'Breakdown');
    addRow('user', 'You');
    addRow('assistant', 'ChatGPT + tools');
    addRow('attachments', 'Attachments');
    addRow('hidden', 'System prompt / memory');
    make('div', 'h', panel, 'Detected');
    addRow('model', 'Model');
    addRow('plan', 'Plan');
    addRow('source', 'Conversation source');
    addRow('turns', 'Turns');
    make('div', 'h', panel, 'Confidence');
    const notes = make('div', 'notes', panel);
    const warn = make('div', 'warn', panel);
    const actions = make('div', 'actions', panel);
    const copyBtn = make('button', 'btn', actions, 'Copy diagnostics');
    make('span', 'fine', actions, 'Visible text only; hidden context is not counted');

    // The always-visible bar
    const bar = make('button', 'bar', wrap);
    bar.setAttribute('aria-controls', 'cm-panel');
    bar.setAttribute('aria-expanded', 'false');
    const dot = make('span', 'dot', bar);
    const tokens = make('span', 'tokens', bar, 'reading conversation…');
    const meterEl = make('span', 'meter', bar);
    const fill = make('span', 'fill', meterEl);
    const pct = make('span', 'muted', bar);
    make('span', 'sep', bar, '│');
    const model = make('span', 'model', bar);
    const chev = make('span', 'chev', bar, '▲');

    bar.addEventListener('click', () => {
      this.isExpanded = !this.isExpanded;
      this._applyExpanded();
    });
    copyBtn.addEventListener('click', async () => {
      const text = JSON.stringify(this.latestState?.diagnostics || { note: 'no state yet' }, null, 2);
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = 'Copied ✓';
      } catch (_) {
        copyBtn.textContent = 'Copy failed';
      }
      setTimeout(() => { copyBtn.textContent = 'Copy diagnostics'; }, 1500);
    });

    this.el = { wrap, panel, rows, notes, warn, bar, dot, tokens, meterEl, fill, pct, model, chev };
    (document.body || document.documentElement).appendChild(this.hostElement);
    window.addEventListener('resize', () => this._position());
    this.render();
  }

  /**
   * Docks the bar right-aligned just above ChatGPT's composer (like Codex's context indicator),
   * so it never covers the input. Falls back to the bottom-right corner if no composer is found.
   */
  _position() {
    if (!this.hostElement) return;
    const input = document.querySelector('#prompt-textarea');
    const composer = input && (input.closest('form') || input.parentElement);
    const r = composer && composer.getBoundingClientRect();
    let right = 16;
    let bottom = 16;
    if (r && r.width > 200 && r.top > 120) {
      right = Math.max(8, Math.round(window.innerWidth - r.right));
      bottom = Math.max(8, Math.round(window.innerHeight - r.top + 6));
    }
    this.hostElement.style.right = `${right}px`;
    this.hostElement.style.bottom = `${bottom}px`;
    // Keep the upward panel inside the viewport
    this.el.wrap?.style.setProperty('--panel-max', `${Math.max(160, window.innerHeight - bottom - 60)}px`);
  }

  update(state) {
    this.latestState = state;
    if (!this.hostElement) this.mount();
    // SPA re-renders can drop our node; re-attach instead of rebuilding
    if (this.hostElement && !this.hostElement.isConnected) {
      (document.body || document.documentElement).appendChild(this.hostElement);
    }
    this.render();
  }

  _applyExpanded() {
    const { panel, bar, chev } = this.el;
    if (!panel) return;
    panel.classList.toggle('open', this.isExpanded);
    bar.setAttribute('aria-expanded', String(this.isExpanded));
    chev.textContent = this.isExpanded ? '▼' : '▲';
  }

  render() {
    if (!this.hostElement) return;
    this.hostElement.style.display = this.isVisible ? '' : 'none';
    const { wrap, rows, notes, warn, dot, tokens, meterEl, fill, pct, model } = this.el;
    if (!wrap) return;

    // Follow ChatGPT's theme
    const light = !document.documentElement.classList.contains('dark') &&
      !(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches && !document.documentElement.classList.contains('light'));
    wrap.classList.toggle('light', light);

    this._applyExpanded();
    this._position();

    const s = this.latestState;
    if (!s) return;

    const used = s.tokens?.totalMeasurable ?? 0;
    const usedFmt = s.tokens?.formatted?.total || '0';
    const limit = s.model?.contextWindow || null;
    const limitFmt = limit ? s.tokens?.formatted?.contextWindow : null;
    const p = s.utilization?.percentage;
    const planTier = s.plan?.tier && s.plan.tier !== 'unknown' ? s.plan.tier : null;
    const planName = planTier ? planTier.charAt(0).toUpperCase() + planTier.slice(1) : null;
    const modelName = s.model?.displayName && s.model.id !== 'unknown' ? s.model.displayName : 'model unknown';

    // Bar
    const color = p === null || p === undefined ? 'var(--unk)' : p >= 85 ? 'var(--bad)' : p >= 65 ? 'var(--warn)' : 'var(--ok)';
    dot.style.background = color;
    fill.style.background = color;
    if (limit && p !== null && p !== undefined) {
      tokens.textContent = `${usedFmt} / ${limitFmt}`;
      fill.style.width = `${Math.min(100, p)}%`;
      const usedPct = p === 0 && used > 0 ? '<0.1' : String(p);
      pct.textContent = `${usedPct}% · ${Math.max(0, Math.round((100 - p) * 10) / 10)}% left`;
      meterEl.style.display = '';
    } else {
      tokens.textContent = `${usedFmt} tokens`;
      pct.textContent = planName ? 'window unknown for this model' : 'window unknown (plan not detected)';
      meterEl.style.display = 'none';
    }
    model.textContent = [modelName, planName].filter(Boolean).join(' · ');
    model.title = model.textContent;

    // Panel
    const tag = (el, text, evidence) => {
      el.textContent = text;
      if (evidence) {
        const t = document.createElement('span');
        t.className = 'tag';
        t.textContent = evidence;
        el.appendChild(t);
      }
    };
    const statusTag = s.model?.limitStatus === 'VERIFIED' ? 'VERIFIED' : (limit ? 'UNVERIFIED' : 'UNKNOWN');
    tag(rows.used, `${used.toLocaleString()} tokens`, 'ESTIMATED');
    tag(rows.limit, limit ? `${limit.toLocaleString()} tokens` : 'Unknown', statusTag);
    rows.left.textContent = limit ? `${Math.max(0, limit - used).toLocaleString()} tokens` : '—';
    rows.user.textContent = (s.tokens?.user ?? 0).toLocaleString();
    rows.assistant.textContent = (s.tokens?.assistant ?? 0).toLocaleString();
    rows.attachments.textContent = s.observables?.attachmentsCount
      ? `${s.observables.attachmentsCount} (${(s.tokens?.attachments ?? 0).toLocaleString()} est.)`
      : 'None';
    tag(rows.hidden, 'Not measurable', 'UNKNOWN');
    tag(rows.model, modelName, s.evidence?.model?.source ? s.evidence.model.source.replace('_', ' ') : null);
    tag(rows.plan, planName || 'Unknown', s.evidence?.plan?.source ? s.evidence.plan.source.replace('_', ' ') : null);
    const ds = s.observables?.dataSource;
    rows.source.textContent = ds === 'authoritative' ? 'ChatGPT API (full conversation)'
      : ds === 'dom_fallback' ? 'Page text (API unavailable)' : 'Page text';
    rows.turns.textContent = String(s.observables?.messagesCount ?? 0);

    notes.textContent = '';
    const level = s.confidence?.level || 'LOW';
    const pctConf = s.confidence?.percentage ?? Math.round((s.confidence?.score || 0) * 100);
    const head = document.createElement('div');
    head.textContent = `${pctConf}% (${level})`;
    notes.appendChild(head);
    for (const f of (s.confidence?.factors || []).slice(0, 6)) {
      const d = document.createElement('div');
      d.className = f.type === 'positive' ? 'pos' : 'neg';
      d.textContent = `${f.type === 'positive' ? '+' : '−'} ${f.text}`;
      notes.appendChild(d);
    }

    warn.textContent = s.observables?.apiError
      ? `API: ${s.observables.apiError}`
      : (s.completeness?.domIsPartial ? 'Count may be low: only turns rendered on the page were read.' : '');
  }

  unmount() {
    if (this.hostElement) {
      this.hostElement.remove();
      this.hostElement = null;
      this.shadowRoot = null;
      this.el = {};
    }
  }
}
