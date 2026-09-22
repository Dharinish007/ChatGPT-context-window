/**
 * ChatGPT Context Monitor - Popup Dashboard Controller
 */

document.addEventListener('DOMContentLoaded', async () => {
  const modelNameEl = document.getElementById('model-name');
  const tokensCurrentEl = document.getElementById('tokens-current');
  const tokensLimitEl = document.getElementById('tokens-limit');
  const metricPercentEl = document.getElementById('metric-percent');
  const progressFillEl = document.getElementById('progress-fill');
  const confidenceLevelEl = document.getElementById('confidence-level');
  const modelSourceEl = document.getElementById('model-source');
  const accuracyTagEl = document.getElementById('accuracy-tag');
  const lowerBoundBadgeEl = document.getElementById('lower-bound-badge');
  const factorsConfidencePillEl = document.getElementById('factors-confidence-pill');
  const factorsListEl = document.getElementById('factors-list');

  const userTokensEl = document.getElementById('user-tokens');
  const userTurnsCountEl = document.getElementById('user-turns-count');
  const assistantTokensEl = document.getElementById('assistant-tokens');
  const assistantTurnsCountEl = document.getElementById('assistant-turns-count');
  const attachmentsCountEl = document.getElementById('attachments-count');
  const attachmentTokensEl = document.getElementById('attachment-tokens');
  const toolsStatusEl = document.getElementById('tools-status');
  const notActiveBanner = document.getElementById('not-active-banner');
  const dashboardContent = document.getElementById('dashboard-content');
  const toggleOverlayCheckbox = document.getElementById('toggle-overlay');
  const rescanBtn = document.getElementById('rescan-btn');

  let activeTabId = null;

  /**
   * Updates popup DOM with context metrics.
   * @param {Object} state 
   */
  function renderState(state) {
    if (!state) return;

    // Model name & limit (Group F)
    const planTier = state.model?.planTier || state.plan?.tier;
    const planSuffix = (planTier && planTier !== 'unknown') ? ` (${planTier.toUpperCase()})` : '';
    const rawModelName = state.model?.displayName || 'Unknown Model';
    modelNameEl.textContent = `${rawModelName}${planSuffix}`;

    // Ground truth provenance & source
    const groundTruthSource = state.evidence?.turns?.source || state.evidence?.dataSource?.source || state.observables?.dataSource || 'dom';
    const groundTruthLabel = (groundTruthSource === 'conversation_api' || groundTruthSource === 'authoritative' || groundTruthSource === 'authoritative_api')
      ? 'Authoritative API'
      : (groundTruthSource === 'network' ? 'Network Stream' : 'DOM Scraping');
    const evidenceLevel = (groundTruthSource === 'conversation_api' || groundTruthSource === 'authoritative') ? 'EXACT' : (state.accuracy?.total || 'OBSERVED');
    modelSourceEl.textContent = `${groundTruthLabel} • ${evidenceLevel}`;

    const currentTokensStr = state.tokens?.formatted?.total || '0';
    const limitTokensStr = state.tokens?.formatted?.contextWindow || 'Unknown';
    tokensCurrentEl.textContent = `~${currentTokensStr}`;
    tokensLimitEl.textContent = limitTokensStr;

    // Percent & progress bar (Unknown fallback handling)
    const isLimitUnknown = state.utilization?.percentage === null || state.utilization?.percentage === undefined;
    const percent = !isLimitUnknown ? state.utilization.percentage : 0;
    metricPercentEl.textContent = state.utilization?.formatted || 'Unknown';
    progressFillEl.style.width = `${Math.min(100, Math.max(0, percent))}%`;

    // Progress bar and percent color
    let barColor = '#10a37f';
    if (percent >= 85) {
      barColor = '#ef4444';
    } else if (percent >= 65) {
      barColor = '#f59e0b';
    }
    progressFillEl.style.backgroundColor = barColor;
    metricPercentEl.style.color = barColor;

    // Accuracy tag & confidence
    accuracyTagEl.textContent = state.accuracy?.total || 'ESTIMATED';
    if (evidenceLevel === 'EXACT') {
      accuracyTagEl.classList.add('exact');
    } else {
      accuracyTagEl.classList.remove('exact');
    }

    const confScore = state.confidence?.percentage !== undefined
      ? state.confidence.percentage
      : Math.round((state.confidence?.score || 0.5) * 100);
    confidenceLevelEl.textContent = `${state.confidence?.level || 'Medium'} (${confScore}%)`;

    if (factorsConfidencePillEl) {
      factorsConfidencePillEl.textContent = `${confScore}%`;
    }

    // Lower bound indicator
    const isLowerBound = Boolean(state.completeness?.domIsPartial || state.confidence?.serverContextCompleteness?.isLowerBound);
    if (lowerBoundBadgeEl) {
      if (isLowerBound) {
        lowerBoundBadgeEl.classList.remove('hidden');
      } else {
        lowerBoundBadgeEl.classList.add('hidden');
      }
    }

    // Explainable factors list
    if (factorsListEl && Array.isArray(state.confidence?.factors) && state.confidence.factors.length > 0) {
      factorsListEl.innerHTML = state.confidence.factors.map(f => `
        <div class="factor-row ${f.type}">
          <span class="factor-sign">${f.type === 'positive' ? '+' : '−'}</span>
          <span class="factor-desc">${f.text}</span>
        </div>
      `).join('');
    }

    // Source table breakdown
    userTokensEl.textContent = state.tokens?.formatted?.user || '0';
    userTurnsCountEl.textContent = `${state.observables?.messagesCount ? Math.ceil(state.observables.messagesCount / 2) : 0} turns`;

    assistantTokensEl.textContent = state.tokens?.formatted?.assistant || '0';
    assistantTurnsCountEl.textContent = `${state.observables?.messagesCount ? Math.floor(state.observables.messagesCount / 2) : 0} turns`;

    attachmentsCountEl.textContent = `${state.observables?.attachmentsCount || 0} files`;
    attachmentTokensEl.textContent = state.tokens?.formatted?.attachments || '0';

    if (state.observables?.toolsObserved && state.observables.toolsList?.length > 0) {
      toolsStatusEl.textContent = state.observables.toolsList.map(t => t.label || t.type).join(', ');
    } else {
      toolsStatusEl.textContent = 'None observed';
    }
  }

  /**
   * Fetches latest state from background service worker or content script.
   */
  async function loadState() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url) {
        showNotActive();
        return;
      }

      activeTabId = tab.id;
      const isChatGPT = tab.url.includes('chatgpt.com') || tab.url.includes('chat.openai.com');

      if (!isChatGPT) {
        showNotActive();
        return;
      }

      showActive();

      // Query service worker for state
      chrome.runtime.sendMessage({ type: 'GET_POPUP_STATE' }, (response) => {
        if (chrome.runtime.lastError || !response || !response.success) {
          // If service worker had no cached state, ping content script directly
          chrome.tabs.sendMessage(activeTabId, { type: 'GET_CONTEXT_DATA' }, (contentResp) => {
            if (contentResp && contentResp.data) {
              renderState(contentResp.data);
            }
          });
        } else {
          renderState(response.state);
        }
      });
    } catch (err) {
      console.error('[ChatGPT Context Monitor] Failed to load popup state:', err);
    }
  }

  function showNotActive() {
    notActiveBanner.classList.remove('hidden');
    dashboardContent.classList.add('hidden');
    modelNameEl.textContent = 'Inactive';
  }

  function showActive() {
    notActiveBanner.classList.add('hidden');
    dashboardContent.classList.remove('hidden');
  }

  // Handle overlay toggle
  toggleOverlayCheckbox.addEventListener('change', async () => {
    if (!activeTabId) return;
    chrome.tabs.sendMessage(activeTabId, { type: 'TOGGLE_OVERLAY' }, (resp) => {
      if (resp) {
        toggleOverlayCheckbox.checked = resp.isVisible;
      }
    });
  });

  // Handle manual rescan
  rescanBtn.addEventListener('click', () => {
    rescanBtn.textContent = 'Scanning...';
    loadState();
    setTimeout(() => {
      rescanBtn.textContent = '⟳ Rescan';
    }, 600);
  });

  // Initialize
  await loadState();
});
