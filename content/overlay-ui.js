/**
 * ChatGPT Context Monitor - In-Page Overlay HUD
 * 
 * Injects a sleek, non-intrusive context meter directly into ChatGPT Web.
 * Uses Shadow DOM to guarantee zero CSS style pollution with ChatGPT's interface.
 */

export class OverlayUI {
  constructor() {
    this.hostElement = null;
    this.shadowRoot = null;
    this.isExpanded = false;
    this.isVisible = true;
    this.latestState = null;
  }

  /**
   * Mounts the overlay HUD into the document.
   */
  mount() {
    if (document.getElementById('chatgpt-context-monitor-host')) {
      return;
    }

    this.hostElement = document.createElement('div');
    this.hostElement.id = 'chatgpt-context-monitor-host';
    this.hostElement.style.cssText = `
      position: fixed;
      top: 14px;
      right: 18px;
      z-index: 99999;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      user-select: none;
    `;

    this.shadowRoot = this.hostElement.attachShadow({ mode: 'open' });
    this.render();
    document.body.appendChild(this.hostElement);
  }

  /**
   * Updates the HUD with newly computed context state.
   * @param {Object} state 
   */
  update(state) {
    this.latestState = state;
    if (!this.shadowRoot) {
      this.mount();
    }
    this.render();
  }

  /**
   * Renders the Shadow DOM content.
   */
  render() {
    if (!this.shadowRoot) return;

    if (!this.isVisible) {
      this.shadowRoot.innerHTML = `
        <style>
          .reopen-pill {
            background: #1e1e24;
            color: #10a37f;
            border: 1px solid #333;
            border-radius: 20px;
            padding: 6px 12px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            display: flex;
            align-items: center;
            gap: 6px;
          }
          .reopen-pill:hover {
            background: #2a2a34;
          }
        </style>
        <button class="reopen-pill" id="reopen-btn">
          <span>📊 Context</span>
        </button>
      `;
      this.shadowRoot.getElementById('reopen-btn')?.addEventListener('click', () => {
        this.isVisible = true;
        this.render();
      });
      return;
    }

    const state = this.latestState;
    const planTier = state?.model?.planTier || state?.plan?.tier;
    const planSuffix = (planTier && planTier !== 'unknown') ? ` [${planTier.toUpperCase()}]` : '';
    const rawModelName = state?.model?.displayName || 'Detecting...';
    const modelName = `${rawModelName}${planSuffix}`;
    const totalTokensFormatted = state?.tokens?.formatted?.total || '0';
    const limitFormatted = state?.tokens?.formatted?.contextWindow || 'Unknown';
    const percent = state?.utilization?.percentage !== null && state?.utilization?.percentage !== undefined
      ? state.utilization.percentage
      : 0;
    const percentStr = state?.utilization?.formatted || '0%';
    const accuracy = state?.accuracy?.total || 'ESTIMATED';
    const confidence = state?.confidence?.level || 'MEDIUM';
    const confidencePercent = state?.confidence?.percentage !== undefined
      ? state.confidence.percentage
      : Math.round((state?.confidence?.score || 0.5) * 100);
    const isLowerBound = Boolean(state?.completeness?.domIsPartial || state?.confidence?.serverContextCompleteness?.isLowerBound);
    const groundTruthSource = state?.evidence?.turns?.source || state?.evidence?.dataSource?.source || state?.observables?.dataSource || 'dom';
    const groundTruthLabel = (groundTruthSource === 'conversation_api' || groundTruthSource === 'authoritative' || groundTruthSource === 'authoritative_api')
      ? 'Authoritative API'
      : (groundTruthSource === 'network' ? 'Network Stream' : 'DOM Extraction');
    const evidenceLevel = (groundTruthSource === 'conversation_api' || groundTruthSource === 'authoritative') ? 'EXACT' : 'OBSERVED';
    const factors = state?.confidence?.factors || [];

    // Progress bar color based on utilization
    let barColor = '#10a37f'; // OpenAI green
    if (percent > 85) {
      barColor = '#ef4444'; // Red alert
    } else if (percent > 65) {
      barColor = '#f59e0b'; // Amber warning
    }

    const confidenceBadgeColor = confidence === 'HIGH' ? '#10a37f' : confidence === 'MEDIUM' ? '#f59e0b' : '#6b7280';

    this.shadowRoot.innerHTML = `
      <style>
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }
        .hud-container {
          background: rgba(26, 27, 30, 0.95);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          color: #e5e7eb;
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 12px;
          box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4);
          overflow: hidden;
          transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
          width: ${this.isExpanded ? '320px' : 'auto'};
        }
        .hud-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 12px;
          gap: 10px;
          cursor: pointer;
        }
        .hud-title-area {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .model-tag {
          background: rgba(16, 163, 127, 0.15);
          color: #10a37f;
          padding: 2px 7px;
          border-radius: 6px;
          font-size: 11px;
          font-weight: 600;
          max-width: 110px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .metric-text {
          font-size: 13px;
          font-weight: 600;
          color: #f3f4f6;
          letter-spacing: -0.01em;
        }
        .percent-badge {
          background: rgba(255, 255, 255, 0.08);
          color: #d1d5db;
          padding: 2px 6px;
          border-radius: 4px;
          font-size: 11px;
          font-weight: 700;
        }
        .controls {
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .icon-btn {
          background: transparent;
          border: none;
          color: #9ca3af;
          font-size: 13px;
          cursor: pointer;
          border-radius: 4px;
          padding: 2px 4px;
          line-height: 1;
        }
        .icon-btn:hover {
          color: #ffffff;
          background: rgba(255, 255, 255, 0.1);
        }
        .progress-bar-bg {
          height: 3px;
          width: 100%;
          background: rgba(255, 255, 255, 0.08);
        }
        .progress-bar-fill {
          height: 100%;
          width: ${Math.min(100, percent)}%;
          background: ${barColor};
          transition: width 0.3s ease;
        }
        /* Expanded Popover */
        .popover-body {
          padding: 12px;
          border-top: 1px solid rgba(255, 255, 255, 0.08);
          display: flex;
          flex-direction: column;
          gap: 10px;
          font-size: 12px;
        }
        .section-title {
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: #9ca3af;
          margin-bottom: 4px;
        }
        .lower-bound-banner {
          background: rgba(245, 158, 11, 0.15);
          border: 1px solid rgba(245, 158, 11, 0.35);
          border-radius: 6px;
          padding: 6px 8px;
          font-size: 11px;
          color: #fbbf24;
          display: flex;
          gap: 6px;
          align-items: center;
          line-height: 1.3;
        }
        .provenance-box {
          background: rgba(255, 255, 255, 0.04);
          padding: 7px 9px;
          border-radius: 6px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 11px;
        }
        .breakdown-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 3px 0;
          color: #d1d5db;
        }
        .breakdown-val {
          font-weight: 600;
          color: #f3f4f6;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .accuracy-pill {
          font-size: 9px;
          padding: 1px 4px;
          border-radius: 3px;
          font-weight: 700;
          background: rgba(255, 255, 255, 0.1);
          color: #9ca3af;
        }
        .accuracy-pill.exact {
          color: #10b981;
          background: rgba(16, 185, 129, 0.15);
        }
        .accuracy-pill.observed {
          color: #60a5fa;
          background: rgba(96, 165, 250, 0.15);
        }
        .accuracy-pill.estimated {
          color: #f59e0b;
          background: rgba(245, 158, 11, 0.15);
        }
        .accuracy-pill.unknown {
          color: #9ca3af;
          background: rgba(156, 163, 175, 0.15);
        }
        .confidence-box {
          background: rgba(255, 255, 255, 0.04);
          padding: 8px 10px;
          border-radius: 6px;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .confidence-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .confidence-label {
          color: #9ca3af;
          font-size: 11px;
        }
        .confidence-value {
          font-weight: 700;
          font-size: 11px;
          color: ${confidenceBadgeColor};
        }
        .confidence-factors {
          display: flex;
          flex-direction: column;
          gap: 3px;
          border-top: 1px solid rgba(255, 255, 255, 0.06);
          padding-top: 6px;
        }
        .factor-row {
          font-size: 10px;
          line-height: 1.35;
          display: flex;
          gap: 4px;
        }
        .factor-row.positive {
          color: #34d399;
        }
        .factor-row.negative {
          color: #f87171;
        }
        .limitations-note {
          font-size: 10px;
          color: #6b7280;
          line-height: 1.3;
          border-top: 1px dashed rgba(255, 255, 255, 0.08);
          padding-top: 6px;
        }
      </style>

      <div class="hud-container">
        <div class="hud-header" id="hud-toggle">
          <div class="hud-title-area">
            <span class="model-tag" title="${modelName}">${modelName}</span>
            <span class="metric-text">~${totalTokensFormatted} / ${limitFormatted}</span>
            <span class="percent-badge">${percentStr}</span>
          </div>
          <div class="controls">
            <button class="icon-btn" id="expand-btn" title="${this.isExpanded ? 'Collapse' : 'Expand breakdown'}">
              ${this.isExpanded ? '▲' : '▼'}
            </button>
            <button class="icon-btn" id="close-btn" title="Minimize">✕</button>
          </div>
        </div>

        <div class="progress-bar-bg">
          <div class="progress-bar-fill"></div>
        </div>

        ${this.isExpanded ? `
          <div class="popover-body">
            ${isLowerBound ? `
              <div class="lower-bound-banner">
                <span>⚠️</span>
                <span>Context count is a <strong>lower bound</strong> (older turns virtualized in DOM).</span>
              </div>
            ` : ''}

            <div class="provenance-box">
              <span style="color: #9ca3af;">Primary Source:</span>
              <span style="font-weight: 600;">${groundTruthLabel} <span class="accuracy-pill ${evidenceLevel.toLowerCase()}">${evidenceLevel}</span></span>
            </div>

            <div>
              <div class="section-title">Context Breakdown</div>
              <div class="breakdown-row">
                <span>User Turns</span>
                <span class="breakdown-val">${state?.tokens?.formatted?.user || '0'} <span class="accuracy-pill ${state?.evidence?.tokens?.user?.evidenceType?.toLowerCase() || 'estimated'}">${state?.evidence?.tokens?.user?.evidenceType || 'EST'}</span></span>
              </div>
              <div class="breakdown-row">
                <span>Assistant Turns</span>
                <span class="breakdown-val">${state?.tokens?.formatted?.assistant || '0'} <span class="accuracy-pill ${state?.evidence?.tokens?.assistant?.evidenceType?.toLowerCase() || 'estimated'}">${state?.evidence?.tokens?.assistant?.evidenceType || 'EST'}</span></span>
              </div>
              <div class="breakdown-row">
                <span>Attachments</span>
                <span class="breakdown-val">${state?.tokens?.formatted?.attachments || '0'} <span class="accuracy-pill ${state?.accuracy?.attachments === 'ESTIMATED' ? 'estimated' : (state?.accuracy?.attachments === 'EXACT' ? 'exact' : 'unknown')}">${state?.accuracy?.attachments || 'UNK'}</span></span>
              </div>
              <div class="breakdown-row">
                <span>Memory Retrieval</span>
                <span class="breakdown-val">Server-side <span class="accuracy-pill unknown">UNK</span></span>
              </div>
              <div class="breakdown-row">
                <span>Tools / MCP / Search</span>
                <span class="breakdown-val">${state?.observables?.toolsObserved ? 'Observed' : 'None'} <span class="accuracy-pill ${state?.observables?.toolsObserved ? 'unknown' : 'observed'}">${state?.observables?.toolsObserved ? 'UNK' : 'OBS'}</span></span>
              </div>
              <div class="breakdown-row">
                <span>Hidden System Context</span>
                <span class="breakdown-val">Not Exposed <span class="accuracy-pill unknown">UNK</span></span>
              </div>
            </div>

            <div class="confidence-box">
              <div class="confidence-header">
                <span class="confidence-label">Measurement Confidence:</span>
                <span class="confidence-value">${confidencePercent}% (${confidence})</span>
              </div>
              ${factors.length > 0 ? `
                <div class="confidence-factors">
                  ${factors.map(f => `
                    <div class="factor-row ${f.type}">
                      <span>${f.type === 'positive' ? '+' : '−'}</span>
                      <span>${f.text}</span>
                    </div>
                  `).join('')}
                </div>
              ` : ''}
            </div>

            <div class="limitations-note">
              <strong>Truth-in-Measurement:</strong> Confidence reflects visible token measurement accuracy (${confidencePercent}%). Unobservable server prompts, internal tool schemas, and memory vector overhead remain classified as UNKNOWN.
            </div>
          </div>
        ` : ''}
      </div>
    `;

    // Event handlers
    this.shadowRoot.getElementById('hud-toggle')?.addEventListener('click', (e) => {
      // Don't toggle if clicking close button
      if (e.target.id === 'close-btn') return;
      this.isExpanded = !this.isExpanded;
      this.render();
    });

    this.shadowRoot.getElementById('close-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.isVisible = false;
      this.render();
    });
  }

  /**
   * Unmounts HUD from DOM.
   */
  unmount() {
    if (this.hostElement) {
      this.hostElement.remove();
      this.hostElement = null;
      this.shadowRoot = null;
    }
  }
}
