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

import { MSG, BADGE_COLOR, NOTIF_FREQUENCY, ALERT_EVENT, STORAGE_KEY, WEBHOOK_FORMAT } from '../shared/constants.js';
import { getKeywords, getUrls, getSettings, getEnabled, addAlertEvent,
         getOnboarded, getWebhookSettings } from '../shared/storage.js';
import { matchesUrl } from '../shared/matcher.js';
import { truncate, MATCH_TYPE_LABEL } from '../shared/utils.js';

// ─── Cooldown Tracker ─────────────────────────────────────────────────────────
// Key: `${tabId}:${keywordId}:${event}`, Value: timestamp of last alert
const cooldownMap = new Map();

// ─── Notification Batcher ─────────────────────────────────────────────────────
// Groups alerts that arrive within BATCH_WINDOW_MS into a single notification.
// Key: tabId  Value: { timer, deadline, events: [...], url, tabId, settings }
const BATCH_WINDOW_MS   = 1000;
const BATCH_MAX_WAIT_MS = 5000; // Hard ceiling — never delay a notification beyond this
const pendingBatches    = new Map();

/**
 * Queue an alert event for batched notification.
 * Resets the 1-second window on each new event for the same tab,
 * but enforces a hard 5-second maximum so busy pages can't defer forever.
 */
function queueNotification(opts) {
  const { tabId, settings } = opts;
  let batch = pendingBatches.get(tabId);

  if (batch) {
    clearTimeout(batch.timer);
  } else {
    batch = { events: [], tabId, settings, deadline: Date.now() + BATCH_MAX_WAIT_MS };
    pendingBatches.set(tabId, batch);
  }

  batch.events.push(opts);

  // Respect the hard deadline — if we're past it, flush immediately.
  const remaining = batch.deadline - Date.now();
  if (remaining <= 0) {
    pendingBatches.delete(tabId);
    flushBatch(batch);
    return;
  }

  batch.timer = setTimeout(() => {
    pendingBatches.delete(tabId);
    flushBatch(batch);
  }, Math.min(BATCH_WINDOW_MS, remaining));
}

/**
 * Fire the consolidated notification for a completed batch.
 * Settings are passed in from the batch (captured at queue time) to avoid
 * a redundant storage read 1 second after the alert was already processed.
 */
async function flushBatch({ tabId, events, settings }) {
  const count = events.length;

  if (count === 1) {
    // Single event — original detailed format
    await fireNotification({ ...events[0], settings });
    return;
  }

  // Multiple events — summarise
  const appears    = events.filter((e) => e.event === ALERT_EVENT.APPEARS).length;
  const disappears = events.filter((e) => e.event === ALERT_EVENT.DISAPPEARS).length;

  let host = events[0].url;
  try { host = new URL(events[0].url).hostname; } catch (_) { /* keep raw */ }

  const parts = [];
  if (appears)    parts.push(`${appears} appeared`);
  if (disappears) parts.push(`${disappears} gone`);

  const notifId = `tw:${tabId}:${Date.now()}`;
  const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  chrome.notifications.create(notifId, {
    type:           'basic',
    iconUrl:        chrome.runtime.getURL('src/icons/icon48.png'),
    title:          `TextWatcher — ${count} alerts`,
    message:        parts.join(', '),
    contextMessage: `${host}  ·  ${now}`,
    priority:       1,
  });
}

// ─── Tab Match Count (session-persistent) ────────────────────────────────────
// Stored in chrome.storage.session so counts survive MV3 service worker restarts
// within a browser session. chrome.storage.session clears on browser close.
// Key in session storage: 'tw_tab_counts'  Value: { [tabId]: number }

async function getTabMatchCount(tabId) {
  const { tw_tab_counts: counts = {} } = await chrome.storage.session.get('tw_tab_counts');
  return counts[String(tabId)] || 0;
}

async function setTabMatchCount(tabId, count) {
  const { tw_tab_counts: counts = {} } = await chrome.storage.session.get('tw_tab_counts');
  counts[String(tabId)] = count;
  await chrome.storage.session.set({ tw_tab_counts: counts });
}

async function deleteTabMatchCount(tabId) {
  const { tw_tab_counts: counts = {} } = await chrome.storage.session.get('tw_tab_counts');
  delete counts[String(tabId)];
  await chrome.storage.session.set({ tw_tab_counts: counts });
}

// ─── Startup ──────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await injectIntoMatchingTabs();
  await refreshBadge();

  if (reason === 'install') {
    const alreadyOnboarded = await getOnboarded();
    if (!alreadyOnboarded) {
      chrome.runtime.openOptionsPage();
    }
  }
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
    await setTabMatchCount(tabId, 0);
    updateBadgeForTab(tabId, 0);
  }
});

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await deleteTabMatchCount(tabId);
  // Evict all cooldown entries for this tab to prevent unbounded Map growth
  for (const key of cooldownMap.keys()) {
    if (key.startsWith(`${tabId}:`)) cooldownMap.delete(key);
  }
});

// ─── Message Handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Track whether the message channel is still open.
  // Chrome closes it after the listener returns if sendResponse isn't called,
  // or after the tab navigates. Calling sendResponse on a closed channel
  // also produces console errors.
  let responded = false;
  const safeRespond = (value) => {
    if (!responded) {
      responded = true;
      try { sendResponse(value); } catch (_) { /* channel already closed */ }
    }
  };

  handleMessage(message, sender, safeRespond);
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
      const [enabled, settings] = await Promise.all([getEnabled(), getSettings()]);
      if (!enabled) { sendResponse({ ok: false }); break; }
      await handleAlertMessage(tabId, ALERT_EVENT.APPEARS, message, settings);
      sendResponse({ ok: true });
      break;
    }

    // Text disappeared from a page
    case MSG.TEXT_DISAPPEARED: {
      const tabId = sender.tab?.id;
      if (!tabId) break;
      const [enabled, settings] = await Promise.all([getEnabled(), getSettings()]);
      if (!enabled) { sendResponse({ ok: false }); break; }
      await handleAlertMessage(tabId, ALERT_EVENT.DISAPPEARS, message, settings);
      sendResponse({ ok: true });
      break;
    }

    // Options page requesting a test webhook delivery
    case MSG.TEST_WEBHOOK: {
      const result = await fireWebhook({
        event:     'appears',
        keyword:   'TextWatcher Test',
        matchType: 'contains',
        url:       'https://textwatcher.test/demo',
        title:     'TextWatcher — Test Payload',
        snippet:   'This is a test payload sent from TextWatcher settings.',
      }, { isTest: true });
      sendResponse(result);
      break;
    }

    default:
      sendResponse(null);
  }
}

// ─── Notification Logic ───────────────────────────────────────────────────────

/**
 * Shared handler for TEXT_APPEARED and TEXT_DISAPPEARED messages.
 * Queues a notification, logs the alert event, and updates the badge.
 */
async function handleAlertMessage(tabId, event, message, settings) {
  if (!shouldSendAlert(tabId, message.keywordId, event, settings)) return;

  const isAppear = event === ALERT_EVENT.APPEARS;

  queueNotification({
    tabId,
    keywordId: message.keywordId,
    event,
    keyword:   message.keyword,
    matchType: message.matchType,
    url:       message.url,
    snippet:   isAppear ? message.snippet : null,
    settings,
  });

  // Fire webhook in parallel with the alert log write — both are awaited so
  // the service worker stays alive for the full duration of both operations.
  await Promise.all([
    addAlertEvent({
      event,
      keyword:   message.keyword,
      matchType: message.matchType,
      url:       message.url,
      title:     message.title,
      snippet:   isAppear ? message.snippet : null,
      tabId,
      timestamp: Date.now(),
    }),
    fireWebhook({
      event,
      keyword:   message.keyword,
      matchType: message.matchType,
      url:       message.url,
      title:     message.title,
      snippet:   isAppear ? message.snippet : null,
    }),
  ]);

  const delta   = isAppear ? 1 : -1;
  const current = Math.max(0, (await getTabMatchCount(tabId)) + delta);
  await setTabMatchCount(tabId, current);
  if (settings.badgeEnabled) updateBadgeForTab(tabId, current);
}

/**
 * Fire a browser notification for a single alert event.
 * Title carries the keyword + verb; message holds match type/snippet;
 * contextMessage holds URL + time (displayed in a lighter weight by Chrome).
 */
async function fireNotification({ tabId, event, keyword, matchType, url, snippet, settings }) {
  const isAppear = event === ALERT_EVENT.APPEARS;
  const notifId  = `tw:${tabId}:${Date.now()}`;
  const verb     = isAppear ? 'appeared' : 'gone';
  const title    = `TextWatcher — "${truncate(keyword, 40)}" ${verb}`;

  const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Primary body: match type and/or snippet
  const bodyParts = [];
  if (settings.showMatchType && matchType) {
    bodyParts.push(MATCH_TYPE_LABEL[matchType] || matchType);
  }
  if (settings.showSnippet && snippet) {
    bodyParts.push(truncate(snippet, 100));
  }

  // contextMessage: URL path + time (lighter sub-line in Chrome)
  const ctxParts = [];
  if (settings.showUrl && url) {
    try {
      const { hostname, pathname } = new URL(url);
      ctxParts.push(truncate(hostname + pathname, 55));
    } catch (_) { ctxParts.push(truncate(url, 55)); }
  }
  ctxParts.push(now);

  chrome.notifications.create(notifId, {
    type:           'basic',
    iconUrl:        chrome.runtime.getURL('src/icons/icon48.png'),
    title,
    message:        bodyParts.join('  ·  ') || verb.charAt(0).toUpperCase() + verb.slice(1),
    contextMessage: ctxParts.join('  ·  '),
    priority:       1,
  });
}

// When user clicks a notification, focus the originating tab.
// The notification ID encodes the tabId as the second colon-separated segment.
chrome.notifications.onClicked.addListener(async (notificationId) => {
  chrome.notifications.clear(notificationId);
  if (!notificationId.startsWith('tw:')) return;
  const parts = notificationId.split(':');
  if (parts.length < 3) return;
  const tabId = Number(parts[1]);
  if (!Number.isInteger(tabId) || tabId <= 0) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (_) {
    // Tab was closed — nothing to do
  }
});

// ─── Webhook ──────────────────────────────────────────────────────────────────

const WEBHOOK_TIMEOUT_MS = 8000;

// Base64-encoded icon48.png — embedded so webhook platforms (Teams, Slack) can
// display the TextWatcher logo without requiring a public server.
const LOGO_DATA_URI = 'data:image/png;base64,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';

/**
 * Validate a webhook URL.
 * Allows https:// for any host and http:// for localhost / 127.0.0.1 only.
 * @param {string} urlStr
 * @returns {boolean}
 */
function isAllowedWebhookUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:') {
      return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    }
    return false;
  } catch (_) {
    return false;
  }
}

/**
 * Shape the request body according to the configured payload format.
 * @param {object} cfg  Webhook settings from storage
 * @param {object} payload  Internal alert payload
 * @returns {string}  JSON string ready to POST
 */
function buildWebhookPayload(cfg, payload) {
  const title      = payload.title    || '';
  const url        = payload.url      || '';
  const isAppear   = payload.event === ALERT_EVENT.APPEARS;
  const eventLabel = isAppear ? 'appeared' : 'disappeared';
  const tsDate     = new Date(payload.timestamp || Date.now());
  // ISO-8601 with local offset — used in Slack/Telegram/Generic
  const tzOffset   = -tsDate.getTimezoneOffset();
  const sign       = tzOffset >= 0 ? '+' : '-';
  const pad        = n => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const tsIso      = tsDate.getFullYear()
    + '-' + pad(tsDate.getMonth() + 1)
    + '-' + pad(tsDate.getDate())
    + 'T' + pad(tsDate.getHours())
    + ':' + pad(tsDate.getMinutes())
    + ':' + pad(tsDate.getSeconds())
    + sign + pad(tzOffset / 60) + ':' + pad(tzOffset % 60);
  // Human-readable local string for Teams facts — avoids Teams auto-reformatting ISO dates
  const tsLocal    = tsDate.toLocaleString(undefined, {
    dateStyle: 'medium', timeStyle: 'long',
  });

  switch (cfg.format) {
    case WEBHOOK_FORMAT.TEAMS:
      return JSON.stringify({
        '@type':    'MessageCard',
        '@context': 'http://schema.org/extensions',
        themeColor: isAppear ? '3388ff' : 'dc3545',
        summary:    `TextWatcher: "${payload.keyword}" ${eventLabel}`,
        sections: [{
          activityImage:    LOGO_DATA_URI,
          activityTitle:    `Keyword "${payload.keyword}" ${eventLabel}`,
          activitySubtitle: title || url,
          activityText:     `[${url}](${url})`,
          facts: [
            { name: 'Keyword',    value: payload.keyword   },
            { name: 'Event',      value: payload.event     },
            { name: 'Match Type', value: payload.matchType },
            { name: 'Time',       value: tsLocal              },
          ],
        }],
        potentialAction: [{
          '@type': 'OpenUri',
          name:    'Open Page',
          targets: [{ os: 'default', uri: url }],
        }],
      });

    case WEBHOOK_FORMAT.SLACK:
      return JSON.stringify({
        icon_url:  LOGO_DATA_URI,
        username:  'TextWatcher',
        text: `*${payload.keyword}* ${eventLabel} — <${url}|${title || url}>`,
      });

    case WEBHOOK_FORMAT.TELEGRAM:
      return JSON.stringify({
        chat_id:    cfg.telegramChatId || '',
        text:       `*${payload.keyword}* ${eventLabel}\n${url}`,
        parse_mode: 'Markdown',
      });

    default: // WEBHOOK_FORMAT.GENERIC
      return JSON.stringify({
        event:     payload.event,
        keyword:   payload.keyword,
        matchType: payload.matchType,
        url:       payload.url,
        title:     payload.title   || '',
        snippet:   payload.snippet || null,
        timestamp: tsIso,
        timestamp_ms: payload.timestamp || Date.now(),
        source:    'TextWatcher',
      });
  }
}

/**
 * POST an alert payload to the configured webhook URL.
 * Completely isolated — a failure here must never affect notifications or badge.
 *
 * @param {{ event, keyword, matchType, url, title, snippet }} payload
 * @param {{ isTest?: boolean }} [opts]
 * @returns {Promise<{ sent: boolean, status?: number, error?: string }>}
 */
async function fireWebhook(payload, opts = {}) {
  let cfg;
  try {
    cfg = await getWebhookSettings();
  } catch (_) {
    return { sent: false, error: 'Could not read webhook settings.' };
  }

  if (!cfg.enabled) return { sent: false };

  const isAppear = payload.event === ALERT_EVENT.APPEARS;
  if (!opts.isTest) {
    if (isAppear  && !cfg.onAppear)    return { sent: false };
    if (!isAppear && !cfg.onDisappear) return { sent: false };
  }

  if (!isAllowedWebhookUrl(cfg.url)) {
    return { sent: false, error: 'Invalid or disallowed webhook URL.' };
  }

  const body = buildWebhookPayload(cfg, { ...payload, timestamp: payload.timestamp || Date.now() });

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent':   'TextWatcher-Extension/1.0',
  };
  if (cfg.secret) {
    headers['X-TextWatcher-Secret'] = cfg.secret;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const res = await fetch(cfg.url, {
      method:  'POST',
      headers,
      body,
      signal:  controller.signal,
    });
    clearTimeout(timer);
    return { sent: true, status: res.status };
  } catch (err) {
    clearTimeout(timer);
    const error = err.name === 'AbortError'
      ? `Timed out after ${WEBHOOK_TIMEOUT_MS / 1000}s`
      : (err.message || 'Network error');
    return { sent: false, error };
  }
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
function shouldSendAlert(tabId, keywordId, event, settings) {
  const freq = settings.notifFrequency || NOTIF_FREQUENCY.ONCE_PER_PAGE;

  if (freq === NOTIF_FREQUENCY.EVERY_OCCURRENCE) return true;

  if (freq === NOTIF_FREQUENCY.COOLDOWN) {
    const key  = `${tabId}:${keywordId}:${event}`;
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
  const text  = count > 0 ? '●' : '';
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
  } catch (err) {
    // Expected on chrome://, restricted pages, or tabs that navigated mid-inject
    // Log only unexpected errors (not the standard "Cannot access" messages)
    if (err?.message && !err.message.includes('Cannot access') &&
        !err.message.includes('No tab with id')) {
      console.warn('[TextWatcher] Unexpected inject error:', err.message);
    }
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

  const matchingTabs = tabs.filter(
    (tab) => tab.url &&
      !tab.url.startsWith('chrome://') &&
      !tab.url.startsWith('about:') &&
      activeUrls.some((u) => matchesUrl(tab.url, u.pattern, u.matchType))
  );

  await Promise.all(matchingTabs.map((tab) => injectContentScript(tab.id)));
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

  if (!enabled) {
    // Extension was just disabled — tell every active content script to stop monitoring.
    // We send to ALL tabs (not just currently-matched ones) because the URL rules may
    // have just changed, making previously-matched tabs no longer matched.
    const allTabs = await chrome.tabs.query({});
    const broadcastable = allTabs.filter(
      (t) => t.id && t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('about:')
    );
    await Promise.all(
      broadcastable.map((t) => safelySendToTab(t.id, { type: MSG.RELOAD_RULES, keywords: [], urls: [], settings }))
    );
    return;
  }

  // Re-inject into any newly matching tabs
  await injectIntoMatchingTabs();

  // Push reload ONLY to tabs whose URL matches an active rule.
  // Avoids sending to every open tab and triggering "Receiving end does
  // not exist" on tabs that never had a content script injected.
  const tabs = await chrome.tabs.query({});
  const activeUrls = urls.filter((u) => u.enabled);

  const monitoredTabs = tabs.filter(
    (t) => t.id && t.url &&
      !t.url.startsWith('chrome://') &&
      !t.url.startsWith('about:') &&
      activeUrls.some((u) => matchesUrl(t.url, u.pattern, u.matchType))
  );

  await Promise.all(
    monitoredTabs.map((t) => safelySendToTab(t.id, { type: MSG.RELOAD_RULES, keywords, urls, settings }))
  );
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Safely send a message to a specific tab's content script.
 * Handles the "Receiving end does not exist" error that occurs when:
 *   - The tab has no content script injected yet
 *   - The tab navigated away and the context is stale
 *   - The tab is a chrome:// or restricted page
 *
 * In MV3, chrome.tabs.sendMessage returns a Promise — uncaught rejections
 * cause "Uncaught (in promise) Error" in the console. This wrapper
 * silences expected failures without hiding real bugs.
 *
 * @param {number} tabId
 * @param {object} message
 * @returns {Promise<any>}
 */
async function safelySendToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        // Expected: tab has no content script — silently ignore
        resolve(null);
      } else {
        resolve(response);
      }
    });
  });
}

