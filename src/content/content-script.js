/**
 * content-script.js
 * Injected into monitored pages. Watches for text appearance/disappearance.
 *
 * Design principles:
 *  - Uses MutationObserver (not timers) → zero polling, minimal CPU
 *  - Uses TreeWalker to scan only text nodes (browser-native, fast)
 *  - Debounces mutations to batch rapid DOM changes (50ms)
 *  - Tracks per-keyword state to detect appear vs disappear events
 *  - Alerts only ONCE per keyword per page load (configurable)
 *  - Zero external network calls, zero data collection
 */

import { MSG, LIMITS, MATCH_TYPE, ALERT_EVENT } from '../shared/constants.js';
import { matchesKeyword, findMatchPositions, extractSnippet } from '../shared/matcher.js';
import { debounce } from '../shared/utils.js';

// ─── Module State ─────────────────────────────────────────────────────────────

/** @type {import('../shared/storage.js').KeywordRule[]} */
let activeKeywords = [];

/** @type {import('../shared/storage.js').UrlRule[]} */
let activeUrls = [];

/** @type {object} Global settings */
let settings = {};

/**
 * Tracks which keywords have already been alerted this page load.
 * Key: keyword id, Value: { appeared: boolean, disappeared: boolean }
 * Prevents duplicate alerts when notifFrequency === 'once_per_page'.
 */
const alertedThisLoad = new Map();

/**
 * Tracks last known presence of each keyword on the page.
 * Key: keyword id, Value: boolean (true = was present on last scan)
 */
const lastPresence = new Map();

// ─── Entry Point ─────────────────────────────────────────────────────────────

/**
 * Bootstrap: request rules + settings from the background worker,
 * then start monitoring.
 */
(async function init() {
  try {
    const response = await sendMessage({ type: MSG.GET_STATE });
    if (!response || !response.enabled) return;

    activeKeywords = (response.keywords || []).filter((k) => k.enabled);
    settings       = response.settings  || {};

    if (activeKeywords.length === 0) return;

    // Initial scan on page load
    runScan();

    // Continuous monitoring via MutationObserver
    startObserver();

    // Listen for rule updates pushed from background
    chrome.runtime.onMessage.addListener(handleBackgroundMessage);
  } catch (err) {
    // Extension context may be invalid on some pages — fail silently
  }
})();

// ─── MutationObserver ─────────────────────────────────────────────────────────

let observer = null;

/**
 * Start the MutationObserver watching the entire document body.
 * Debounced to 50ms to batch rapid mutations.
 */
function startObserver() {
  if (observer) return;

  const debouncedScan = debounce(runScan, LIMITS.DEBOUNCE_MS);

  observer = new MutationObserver((mutations) => {
    // Quick filter: only care about mutations that add/remove text or nodes
    const relevant = mutations.some(
      (m) => m.type === 'childList' ||
             (m.type === 'characterData' && m.target.nodeType === Node.TEXT_NODE)
    );
    if (relevant) debouncedScan();
  });

  observer.observe(document.body, {
    childList:     true,   // Nodes added/removed
    subtree:       true,   // Watch entire tree
    characterData: true,   // Text content changes
  });
}

/**
 * Stop and disconnect the observer (cleanup on rule reload).
 */
function stopObserver() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

// ─── Core Scan Logic ─────────────────────────────────────────────────────────

/**
 * Extract all visible text from the page as a single string.
 * Uses TreeWalker — browser-native, faster than querySelectorAll.
 * Skips script, style, noscript, and hidden elements.
 *
 * @returns {string}
 */
function extractPageText() {
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;

        // Skip non-visible or irrelevant elements
        const tag = parent.tagName?.toUpperCase();
        if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(tag)) {
          return NodeFilter.FILTER_REJECT;
        }

        // Skip hidden elements
        const style = getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden') {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  const parts = [];
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent.trim();
    if (text) parts.push(text);
  }

  return parts.join(' ');
}

/**
 * Run one full scan of the page against all active keyword rules.
 * Emits appear/disappear events as needed.
 */
function runScan() {
  if (!activeKeywords.length) return;

  const pageText = extractPageText();

  for (const keyword of activeKeywords) {
    const isPresent = matchesKeyword(pageText, keyword.text, keyword.matchType);
    const wasBefore = lastPresence.get(keyword.id) ?? null;

    // Update presence state
    lastPresence.set(keyword.id, isPresent);

    // First scan — establish baseline without alerting
    if (wasBefore === null) continue;

    // Text APPEARED (was absent, now present)
    if (isPresent && !wasBefore) {
      maybeAlert(keyword, ALERT_EVENT.APPEARS, pageText);
    }

    // Text DISAPPEARED (was present, now absent)
    if (!isPresent && wasBefore) {
      maybeAlert(keyword, ALERT_EVENT.DISAPPEARS, pageText);
    }
  }
}

// ─── Alert Gating ─────────────────────────────────────────────────────────────

/**
 * Decide whether to send an alert based on:
 *  - Per-keyword alert toggles (alertAppear / alertDisappear)
 *  - Global settings (alertOnAppear / alertOnDisappear)
 *  - Notification frequency (once_per_page / every_occurrence / cooldown)
 *
 * @param {import('../shared/storage.js').KeywordRule} keyword
 * @param {string} event - ALERT_EVENT value
 * @param {string} pageText
 */
function maybeAlert(keyword, event, pageText) {
  // Check per-keyword toggles
  if (event === ALERT_EVENT.APPEARS    && !keyword.alertAppear)    return;
  if (event === ALERT_EVENT.DISAPPEARS && !keyword.alertDisappear) return;

  // Check global settings
  if (event === ALERT_EVENT.APPEARS    && settings.alertOnAppear    === false) return;
  if (event === ALERT_EVENT.DISAPPEARS && settings.alertOnDisappear === false) return;

  // Frequency gate
  const alerted = alertedThisLoad.get(keyword.id) || { appeared: false, disappeared: false };

  if (settings.notifFrequency === 'once_per_page') {
    if (event === ALERT_EVENT.APPEARS    && alerted.appeared)    return;
    if (event === ALERT_EVENT.DISAPPEARS && alerted.disappeared) return;
  }

  // Mark as alerted
  if (event === ALERT_EVENT.APPEARS)    alerted.appeared    = true;
  if (event === ALERT_EVENT.DISAPPEARS) alerted.disappeared = true;
  alertedThisLoad.set(keyword.id, alerted);

  // Build snippet if enabled
  let snippet = null;
  if (settings.showSnippet && event === ALERT_EVENT.APPEARS) {
    const positions = findMatchPositions(pageText, keyword.text, keyword.matchType);
    if (positions.length > 0) {
      snippet = extractSnippet(pageText, positions[0].index, positions[0].length, LIMITS.SNIPPET_CHARS);
    }
  }

  // Send to background worker
  sendMessage({
    type:      event === ALERT_EVENT.APPEARS ? MSG.TEXT_APPEARED : MSG.TEXT_DISAPPEARED,
    keyword:   keyword.text,
    matchType: keyword.matchType,
    url:       window.location.href,
    title:     document.title,
    snippet,
  });
}

// ─── Message Handlers ─────────────────────────────────────────────────────────

/**
 * Handle messages pushed from the background worker (e.g. rule reload).
 * @param {object} message
 */
function handleBackgroundMessage(message) {
  if (!message) return;

  if (message.type === MSG.RELOAD_RULES) {
    // Rules changed — stop observer, reset state, reload
    stopObserver();
    alertedThisLoad.clear();
    lastPresence.clear();

    activeKeywords = (message.keywords || []).filter((k) => k.enabled);
    settings       = message.settings || {};

    if (activeKeywords.length > 0) {
      runScan();
      startObserver();
    }
  }
}

// ─── Messaging Helper ─────────────────────────────────────────────────────────

/**
 * Send a message to the background service worker.
 * Wraps chrome.runtime.sendMessage in a Promise.
 *
 * @param {object} message
 * @returns {Promise<any>}
 */
function sendMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          // Extension was reloaded or context invalid — ignore
          resolve(null);
        } else {
          resolve(response);
        }
      });
    } catch (_) {
      resolve(null);
    }
  });
}
