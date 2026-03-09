/**
 * service-worker.js
 * Background service worker — event-driven, never polling.
 *
 * Responsibilities:
 *  - Respond to content script GET_STATE requests
 *  - Send browser notifications on text appear/disappear
 *  - Manage badge (count, color)
 *  - Inject content scripts into matching tabs
 *  - Push rule reloads to active tabs when rules change
 *  - Cooldown tracking to prevent notification spam
 */

import { MSG, BADGE_COLOR, NOTIF_FREQUENCY, ALERT_EVENT, STORAGE_KEY } from '../shared/constants.js';
import { getKeywords, getUrls, getSettings, getEnabled } from '../shared/storage.js';
import { matchesUrl } from '../shared/matcher.js';
import { truncate } from '../shared/utils.js';

// ─── Cooldown Tracker ─────────────────────────────────────────────────────────
// Key: `${tabId}:${keywordId}:${event}`, Value: timestamp of last alert
const cooldownMap = new Map();

// ─── Match Count Tracker ──────────────────────────────────────────────────────
// Key: tabId, Value: count of active matches on that tab
const tabMatchCount = new Map();

// ─── Startup ──────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  await injectIntoMatchingTabs();
  await refreshBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  await injectIntoMatchingTabs();
  await refreshBadge();
});

// ─── Tab Events ───────────────────────────────────────────────────────────────

// When a tab finishes loading, inject content script if URL matches
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('about:')) return;

  const enabled = await getEnabled();
  if (!enabled) return;

  const urls = await getUrls();
  const activeUrls = urls.filter((u) => u.enabled);
  const matched = activeUrls.some((u) => matchesUrl(tab.url, u.pattern, u.matchType));

  if (matched) {
    await injectContentScript(tabId);
    // Reset match count for this tab on new page load
    tabMatchCount.set(tabId, 0);
    updateBadgeForTab(tabId, 0);
  }
});

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  tabMatchCount.delete(tabId);
});

// ─── Message Handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender, sendResponse);
  return true; // Keep channel open for async response
});

async function handleMessage(message, sender, sendResponse) {
  if (!message?.type) return;

  switch (message.type) {

    // Content script asking for current rules + settings
    case MSG.GET_STATE: {
      const [enabled, keywords, urls, settings] = await Promise.all([
        getEnabled(),
        getKeywords(),
        getUrls(),
        getSettings(),
      ]);
      sendResponse({ enabled, keywords, urls, settings });
      break;
    }

    // Text appeared on a page
    case MSG.TEXT_APPEARED: {
      const tabId = sender.tab?.id;
      if (!tabId) break;

      const settings = await getSettings();

      if (shouldSendAlert(tabId, message.keyword, ALERT_EVENT.APPEARS, settings)) {
        await fireNotification({
          event:     ALERT_EVENT.APPEARS,
          keyword:   message.keyword,
          matchType: message.matchType,
          url:       message.url,
          title:     message.title,
          snippet:   message.snippet,
          settings,
        });

        // Update badge count
        const current = (tabMatchCount.get(tabId) || 0) + 1;
        tabMatchCount.set(tabId, current);
        if (settings.badgeEnabled) updateBadgeForTab(tabId, current);
      }

      sendResponse({ ok: true });
      break;
    }

    // Text disappeared from a page
    case MSG.TEXT_DISAPPEARED: {
      const tabId = sender.tab?.id;
      if (!tabId) break;

      const settings = await getSettings();

      if (shouldSendAlert(tabId, message.keyword, ALERT_EVENT.DISAPPEARS, settings)) {
        await fireNotification({
          event:     ALERT_EVENT.DISAPPEARS,
          keyword:   message.keyword,
          matchType: message.matchType,
          url:       message.url,
          title:     message.title,
          snippet:   null,
          settings,
        });

        // Decrement badge count
        const current = Math.max(0, (tabMatchCount.get(tabId) || 1) - 1);
        tabMatchCount.set(tabId, current);
        if (settings.badgeEnabled) updateBadgeForTab(tabId, current);
      }

      sendResponse({ ok: true });
      break;
    }

    default:
      sendResponse(null);
  }
}

// ─── Notification Logic ───────────────────────────────────────────────────────

/**
 * Fire a browser notification.
 *
 * @param {object} opts
 */
async function fireNotification({ event, keyword, matchType, url, title, snippet, settings }) {
  const isAppear = event === ALERT_EVENT.APPEARS;

  const notifTitle = isAppear
    ? `✅ Text Found: "${truncate(keyword, 40)}"`
    : `❌ Text Gone: "${truncate(keyword, 40)}"`;

  const lines = [];

  if (settings.showUrl && url) {
    lines.push(`📄 ${truncate(new URL(url).hostname + new URL(url).pathname, 50)}`);
  }
  if (settings.showMatchType && matchType) {
    lines.push(`🔍 Match: ${formatMatchType(matchType)}`);
  }
  if (settings.showSnippet && snippet) {
    lines.push(`💬 "${truncate(snippet, 80)}"`);
  }

  const message = lines.join('\n') || (isAppear ? 'Text detected on this page.' : 'Text is no longer present.');

  chrome.notifications.create({
    type:     'basic',
    iconUrl:  chrome.runtime.getURL('src/icons/icon48.png'),
    title:    notifTitle,
    message,
    priority: 1,
  });
}

/**
 * Check cooldown / frequency settings before firing an alert.
 *
 * @param {number} tabId
 * @param {string} keyword
 * @param {string} event
 * @param {object} settings
 * @returns {boolean}
 */
function shouldSendAlert(tabId, keyword, event, settings) {
  const freq = settings.notifFrequency || NOTIF_FREQUENCY.ONCE_PER_PAGE;

  if (freq === NOTIF_FREQUENCY.EVERY_OCCURRENCE) return true;

  if (freq === NOTIF_FREQUENCY.COOLDOWN) {
    const key  = `${tabId}:${keyword}:${event}`;
    const last  = cooldownMap.get(key) || 0;
    const limitMs = (settings.cooldownSeconds || 5) * 1000;
    if (Date.now() - last < limitMs) return false;
    cooldownMap.set(key, Date.now());
    return true;
  }

  // once_per_page: content script handles this gate — background always lets through
  return true;
}

// ─── Badge Management ─────────────────────────────────────────────────────────

/**
 * Update the badge for a specific tab.
 * @param {number} tabId
 * @param {number} count
 */
function updateBadgeForTab(tabId, count) {
  const text  = count > 0 ? String(count) : '';
  const color = count > 0 ? BADGE_COLOR.MATCH : BADGE_COLOR.ACTIVE;

  chrome.action.setBadgeText({ text, tabId });
  chrome.action.setBadgeBackgroundColor({ color, tabId });
}

/**
 * Set badge to inactive (gray) — called when extension is disabled.
 */
async function refreshBadge() {
  const enabled = await getEnabled();
  const settings = await getSettings();

  if (!settings.badgeEnabled) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }

  chrome.action.setBadgeText({ text: enabled ? '' : 'OFF' });
  chrome.action.setBadgeBackgroundColor({
    color: enabled ? BADGE_COLOR.ACTIVE : BADGE_COLOR.INACTIVE,
  });
}

// ─── Content Script Injection ─────────────────────────────────────────────────

/**
 * Inject the content script into a specific tab.
 * Skips if already injected (chrome handles this gracefully).
 *
 * @param {number} tabId
 */
async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files:  ['src/content/content-script.js'],
    });
  } catch (_) {
    // Tab may have navigated or be restricted — ignore
  }
}

/**
 * Inject content script into all currently open tabs that match URL rules.
 */
async function injectIntoMatchingTabs() {
  const enabled = await getEnabled();
  if (!enabled) return;

  const [urls, tabs] = await Promise.all([
    getUrls(),
    chrome.tabs.query({}),
  ]);

  const activeUrls = urls.filter((u) => u.enabled);

  for (const tab of tabs) {
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('about:')) continue;
    const matched = activeUrls.some((u) => matchesUrl(tab.url, u.pattern, u.matchType));
    if (matched) await injectContentScript(tab.id);
  }
}

// ─── Rule Change Propagation ──────────────────────────────────────────────────

/**
 * When rules/settings change in storage, push updated state to all active tabs.
 */
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;

  const relevantKeys = [
    STORAGE_KEY.KEYWORDS,
    STORAGE_KEY.URLS,
    STORAGE_KEY.SETTINGS,
    STORAGE_KEY.ENABLED,
  ];

  const hasRelevant = relevantKeys.some((k) => k in changes);
  if (!hasRelevant) return;

  await refreshBadge();

  const [enabled, keywords, urls, settings] = await Promise.all([
    getEnabled(),
    getKeywords(),
    getUrls(),
    getSettings(),
  ]);

  if (!enabled) return;

  // Re-inject into any newly matching tabs
  await injectIntoMatchingTabs();

  // Push reload to all tabs with active content scripts
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    try {
      chrome.tabs.sendMessage(tab.id, {
        type: MSG.RELOAD_RULES,
        keywords,
        urls,
        settings,
      });
    } catch (_) { /* Tab may not have content script — ignore */ }
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatMatchType(type) {
  const labels = {
    exact_case:   'Exact (case-sensitive)',
    exact_nocase: 'Exact (case-insensitive)',
    contains:     'Contains',
    starts_with:  'Starts with',
    ends_with:    'Ends with',
    regex:        'Regex',
  };
  return labels[type] || type;
}
