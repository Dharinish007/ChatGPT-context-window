/**
 * ChatGPT Context Monitor - Background Service Worker
 * 
 * Ephemeral Manifest V3 Service Worker.
 * - Enforces zero in-memory global state (persists state in chrome.storage).
 * - Manages extension toolbar badge metrics and alert colors.
 * - Receives context updates from content scripts; the toolbar icon toggles the in-page widget.
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

// Drop cached per-tab state when a tab closes
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`tab_state_${tabId}`).catch(() => {});
});

// A full page load (refresh, or leaving ChatGPT for another site) invalidates the tab's state.
// If the new page is ChatGPT, its content script repopulates it; otherwise nothing stale remains.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  chrome.storage.session.remove(`tab_state_${tabId}`).catch(() => {});
  if (chrome.action) chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
});

// 2. Message passing listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  // Handler for context updates from content script
  if (message.type === 'CONTEXT_UPDATED') {
    (async () => {
      const tabId = sender.tab?.id;

      // Update toolbar badge (blank while the conversation is still loading, never "0%")
      await updateActionBadge(tabId, message.payload?.observables?.awaitingData ? null : message.payload?.utilization);

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

  return false;
});

// 3. Toolbar icon: there is no popup (the in-page widget is the only context UI); a click shows / hides it
chrome.action?.onClicked.addListener((tab) => {
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_OVERLAY' }).catch(() => {});
});
