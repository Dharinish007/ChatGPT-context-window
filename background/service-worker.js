/**
 * ChatGPT Context Monitor - Background Service Worker
 * 
 * Ephemeral Manifest V3 Service Worker.
 * - Enforces zero in-memory global state (persists state in chrome.storage).
 * - Manages extension toolbar badge metrics and alert colors.
 * - Handles runtime message passing between content scripts and popup.
 * - Sets up default configuration on installation/update.
 */

// Colors for action badge based on context utilization
const BADGE_COLORS = {
  NORMAL: '#10a37f', // Green
  WARNING: '#f59e0b', // Amber (65-85%)
  CRITICAL: '#ef4444' // Red (>85%)
};

/**
 * Updates the extension toolbar badge for a specific tab.
 * @param {number|undefined} tabId 
 * @param {Object} utilization 
 */
async function updateActionBadge(tabId, utilization) {
  if (!chrome.action) return;

  try {
    const percent = utilization?.percentage;

    if (percent === null || percent === undefined) {
      await chrome.action.setBadgeText({ tabId, text: '' });
      return;
    }

    const badgeText = `${Math.round(percent)}%`;
    await chrome.action.setBadgeText({ tabId, text: badgeText });

    let color = BADGE_COLORS.NORMAL;
    if (percent >= 85) {
      color = BADGE_COLORS.CRITICAL;
    } else if (percent >= 65) {
      color = BADGE_COLORS.WARNING;
    }

    await chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch (err) {
    console.error('[ChatGPT Context Monitor] Badge update error:', err);
  }
}

// 1. Installation and update lifecycle
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[ChatGPT Context Monitor] Extension installed / updated. Reason:', details.reason);

  const defaultSettings = {
    showFloatingHUD: true,
    badgeDisplayMode: 'percentage', // 'percentage' | 'tokens' | 'off'
    lastActiveVersion: chrome.runtime.getManifest().version
  };

  const existing = await chrome.storage.local.get('settings');
  if (!existing.settings) {
    await chrome.storage.local.set({ settings: defaultSettings });
  }
});

// 2. Message passing listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  // Handler for context updates from content script
  if (message.type === 'CONTEXT_UPDATED') {
    (async () => {
      const tabId = sender.tab?.id;
      const { utilization, model, tokens } = message.payload || {};

      // Update toolbar badge
      await updateActionBadge(tabId, utilization);

      // Cache latest state in session storage for the tab
      if (tabId) {
        await chrome.storage.session.set({
          [`tab_state_${tabId}`]: message.payload,
          lastActiveTabId: tabId
        });
      }

      sendResponse({ success: true });
    })();
    return true; // Keep channel open for async response
  }

  // Handler for popup requesting current active tab state
  if (message.type === 'GET_POPUP_STATE') {
    (async () => {
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab || !activeTab.id) {
          sendResponse({ success: false, error: 'No active tab' });
          return;
        }

        // Check session storage first
        const key = `tab_state_${activeTab.id}`;
        const stored = await chrome.storage.session.get([key, 'latestContextState']);
        const tabState = stored[key] || stored.latestContextState;

        if (tabState) {
          sendResponse({ success: true, state: tabState, tabId: activeTab.id });
          return;
        }

        // If not in storage, ask the content script directly
        chrome.tabs.sendMessage(activeTab.id, { type: 'GET_CONTEXT_DATA' }, (response) => {
          if (chrome.runtime.lastError || !response || !response.success) {
            sendResponse({ success: false, error: 'Content script not ready or not on ChatGPT' });
          } else {
            sendResponse({ success: true, state: response.data, tabId: activeTab.id });
          }
        });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep channel open
  }

  return false;
});
