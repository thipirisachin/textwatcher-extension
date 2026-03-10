/**
 * content-script.js
 * Injected into monitored pages via chrome.scripting.executeScript().
 *
 * WARNING -- NO ES MODULE IMPORTS ALLOWED HERE:
 *   Scripts injected via chrome.scripting.executeScript() run as plain
 *   scripts, not ES modules. `import` throws SyntaxError immediately.
 *   All dependencies from shared/ are inlined directly into this file.
 *   If you change constants in shared/constants.js or functions in
 *   shared/matcher.js / shared/utils.js, mirror the change here too.
 *
 * Design principles:
 *  - Self-contained: zero imports, zero external dependencies
 *  - MutationObserver (not timers): zero polling, minimal CPU
 *  - TreeWalker for text nodes: browser-native, fast
 *  - Debounces mutations to batch rapid DOM changes (50 ms)
 *  - Tracks per-keyword state to detect appear / disappear transitions
 *  - Alerts only ONCE per keyword per page load (configurable)
 *  - Zero external network calls, zero data collection
 */

// =============================================================================
// Inlined constants (subset of shared/constants.js)
// =============================================================================

const MSG = Object.freeze({
  TEXT_APPEARED:    'text_appeared',
  TEXT_DISAPPEARED: 'text_disappeared',
  GET_STATE:        'get_state',
  STATE_UPDATE:     'state_update',
  RELOAD_RULES:     'reload_rules',
  TAB_MATCHED:      'tab_matched',
});

const MATCH_TYPE = Object.freeze({
  EXACT_CASE:   'exact_case',
  EXACT_NOCASE: 'exact_nocase',
  CONTAINS:     'contains',
  STARTS_WITH:  'starts_with',
  ENDS_WITH:    'ends_with',
  REGEX:        'regex',
});

const ALERT_EVENT = Object.freeze({
  APPEARS:    'appears',
  DISAPPEARS: 'disappears',
});

const LIMITS = Object.freeze({
  DEBOUNCE_MS:   50,   // MutationObserver debounce window (ms)
  SNIPPET_CHARS: 80,   // Context characters either side of a match
});

// =============================================================================
// Inlined: debounce  (shared/utils.js)
// =============================================================================

/**
 * Returns a debounced version of fn that fires after `delay` ms of inactivity.
 * @param {Function} fn
 * @param {number}   delay
 * @returns {Function}
 */
function debounce(fn, delay) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// =============================================================================
// Inlined: safeRegexTest  (shared/matcher.js)
// =============================================================================

/**
 * Test a user-supplied regex pattern against target.
 * Returns false (never throws) on invalid pattern.
 * @param {string} pattern
 * @param {string} target
 * @returns {boolean}
 */
function safeRegexTest(pattern, target) {
  try {
    return new RegExp(pattern, 'i').test(target);
  } catch (_) {
    return false;
  }
}

// =============================================================================
// Inlined: matchesKeyword  (shared/matcher.js)
// =============================================================================

/**
 * Test whether page text contains a keyword according to its match type.
 * @param {string} haystack  - Full page text
 * @param {string} needle    - Keyword / phrase from the rule
 * @param {string} matchType - One of MATCH_TYPE values
 * @returns {boolean}
 */
function matchesKeyword(haystack, needle, matchType) {
  if (!haystack || !needle) return false;
  switch (matchType) {
    case MATCH_TYPE.EXACT_CASE:
      return haystack.includes(needle);
    case MATCH_TYPE.EXACT_NOCASE:
      return haystack.toLowerCase().includes(needle.toLowerCase());
    case MATCH_TYPE.CONTAINS:
      return haystack.toLowerCase().includes(needle.toLowerCase());
    case MATCH_TYPE.STARTS_WITH:
      return haystack.trimStart().toLowerCase().startsWith(needle.toLowerCase());
    case MATCH_TYPE.ENDS_WITH:
      return haystack.trimEnd().toLowerCase().endsWith(needle.toLowerCase());
    case MATCH_TYPE.REGEX:
      return safeRegexTest(needle, haystack);
    default:
      return false;
  }
}

// =============================================================================
// Inlined: findMatchPositions  (shared/matcher.js)
// =============================================================================

/**
 * Find all positions where needle matches inside haystack.
 * Used to extract a context snippet around the first match.
 * @param {string} haystack
 * @param {string} needle
 * @param {string} matchType
 * @returns {{ index: number, length: number }[]}
 */
function findMatchPositions(haystack, needle, matchType) {
  const positions = [];
  if (!haystack || !needle) return positions;

  if (matchType === MATCH_TYPE.REGEX) {
    try {
      const rx = new RegExp(needle, 'gi');
      let m;
      while ((m = rx.exec(haystack)) !== null) {
        positions.push({ index: m.index, length: m[0].length });
      }
    } catch (_) { /* invalid regex -- silently skip */ }
    return positions;
  }

  const caseSensitive = (matchType === MATCH_TYPE.EXACT_CASE);
  const searchStr     = caseSensitive ? haystack : haystack.toLowerCase();
  const searchNeedle  = caseSensitive ? needle   : needle.toLowerCase();

  let start = 0;
  while (true) {
    const idx = searchStr.indexOf(searchNeedle, start);
    if (idx === -1) break;
    positions.push({ index: idx, length: needle.length });
    start = idx + 1;
  }
  return positions;
}

// =============================================================================
// Inlined: extractSnippet  (shared/matcher.js)
// =============================================================================

/**
 * Extract a readable context snippet around a match position.
 * @param {string} text     - Full text
 * @param {number} index    - Match start index
 * @param {number} length   - Match length
 * @param {number} ctxChars - Context chars either side
 * @returns {string}
 */
function extractSnippet(text, index, length, ctxChars) {
  const start  = Math.max(0, index - ctxChars);
  const end    = Math.min(text.length, index + length + ctxChars);
  const prefix = start > 0           ? '\u2026' : '';
  const suffix = end < text.length   ? '\u2026' : '';
  return prefix + text.slice(start, end).trim() + suffix;
}

// =============================================================================
// Module state
// =============================================================================

/** @type {Array<{id:string,text:string,matchType:string,enabled:boolean,alertAppear:boolean,alertDisappear:boolean}>} */
let activeKeywords = [];

/** @type {object} Snapshot of global settings from storage */
let settings = {};

/**
 * Per-keyword alert gate for the current page load.
 * Key: keyword.id  Value: { appeared: boolean, disappeared: boolean }
 */
const alertedThisLoad = new Map();

/**
 * Last known on-page presence of each keyword.
 * Key: keyword.id  Value: boolean | null  (null = not yet scanned)
 */
const lastPresence = new Map();

// =============================================================================
// Entry point
// =============================================================================

/**
 * Guard against double-injection. The service worker may re-inject on
 * RELOAD_RULES; the flag prevents a second observer being attached.
 */
if (typeof window.__textWatcherActive === 'undefined') {
  window.__textWatcherActive = true;
  console.log('[TW:content] Script injected on', window.location.href);

  (async function init() {
    try {
      console.log('[TW:content] Sending GET_STATE to service worker...');
      const response = await sendMessage({ type: MSG.GET_STATE });
      console.log('[TW:content] GET_STATE response:', JSON.stringify(response));

      if (!response) { console.warn('[TW:content] No response -- service worker not ready or context invalid'); return; }
      if (!response.enabled) { console.warn('[TW:content] Extension is disabled'); return; }

      activeKeywords = (response.keywords || []).filter((k) => k.enabled);
      settings       = response.settings  || {};
      console.log('[TW:content] Active keywords:', activeKeywords.length, activeKeywords.map(k => k.text));
      console.log('[TW:content] URL rules:', (response.urls || []).length);

      if (activeKeywords.length === 0) { console.warn('[TW:content] No enabled keywords -- monitoring not started'); return; }

      runScan();       // Baseline pass -- records initial state, no alerts
      startObserver(); // Continuous monitoring begins
      console.log('[TW:content] Observer started, monitoring active');

      chrome.runtime.onMessage.addListener(handleBackgroundMessage);
    } catch (err) {
      console.error('[TW:content] Init error:', err);
    }
  })();
} else {
  console.log('[TW:content] Already active on this page, skipping re-init');
}

// =============================================================================
// MutationObserver
// =============================================================================

let observer = null;

/**
 * Attach a MutationObserver to document.body.
 * Callbacks are debounced to LIMITS.DEBOUNCE_MS.
 */
function startObserver() {
  if (observer) return;

  const debouncedScan = debounce(runScan, LIMITS.DEBOUNCE_MS);

  observer = new MutationObserver((mutations) => {
    const relevant = mutations.some(
      (m) =>
        m.type === 'childList' ||
        m.type === 'attributes' ||
        (m.type === 'characterData' && m.target.nodeType === Node.TEXT_NODE)
    );
    if (relevant) debouncedScan();
  });

  observer.observe(document.body, {
    childList:       true,   // Nodes added / removed
    subtree:         true,   // Entire DOM tree
    characterData:   true,   // Inline text edits
    attributes:      true,   // CSS class / style / hidden attribute changes
    attributeFilter: ['style', 'class', 'hidden', 'aria-hidden'],
  });
}

/** Disconnect the observer. Called before rule reload. */
function stopObserver() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

// =============================================================================
// Core scan logic
// =============================================================================

/**
 * Collect all visible text from the page as one string.
 * TreeWalker is browser-native and faster than querySelectorAll.
 * Skips script / style / noscript / template nodes and hidden elements.
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

        const tag = parent.tagName ? parent.tagName.toUpperCase() : '';
        if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(tag)) {
          return NodeFilter.FILTER_REJECT;
        }

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
 * Run one full scan of all active keywords against current page text.
 * Detects appear / disappear transitions by comparing to lastPresence.
 */
function runScan() {
  if (!activeKeywords.length) return;

  const pageText = extractPageText();
  console.log('[TW:content] runScan — page text length:', pageText.length, '| first 120 chars:', pageText.slice(0, 120));

  for (const keyword of activeKeywords) {
    const isPresent = matchesKeyword(pageText, keyword.text, keyword.matchType);
    const wasBefore = lastPresence.has(keyword.id)
      ? lastPresence.get(keyword.id)
      : null;

    console.log(`[TW:content] keyword="${keyword.text}" isPresent=${isPresent} wasBefore=${wasBefore}`);
    lastPresence.set(keyword.id, isPresent);

    if (wasBefore === null) { console.log('[TW:content] Baseline pass -- no alert'); continue; }

    if ( isPresent && !wasBefore) maybeAlert(keyword, ALERT_EVENT.APPEARS,    pageText);
    if (!isPresent &&  wasBefore) maybeAlert(keyword, ALERT_EVENT.DISAPPEARS, pageText);
  }
}

// =============================================================================
// Alert gating
// =============================================================================

/**
 * Apply all filters before forwarding an alert to the service worker:
 *   - Per-keyword alertAppear / alertDisappear toggles
 *   - Global alertOnAppear / alertOnDisappear settings
 *   - notifFrequency === 'once_per_page' gate
 *
 * @param {{id:string,text:string,matchType:string,alertAppear:boolean,alertDisappear:boolean}} keyword
 * @param {string} event    - ALERT_EVENT value
 * @param {string} pageText
 */
function maybeAlert(keyword, event, pageText) {
  console.log(`[TW:content] maybeAlert — keyword="${keyword.text}" event=${event}`);

  // Per-keyword toggles
  if (event === ALERT_EVENT.APPEARS    && !keyword.alertAppear)    { console.warn('[TW:content] BLOCKED: alertAppear=false');    return; }
  if (event === ALERT_EVENT.DISAPPEARS && !keyword.alertDisappear) { console.warn('[TW:content] BLOCKED: alertDisappear=false'); return; }

  // Global settings
  if (event === ALERT_EVENT.APPEARS    && settings.alertOnAppear    === false) { console.warn('[TW:content] BLOCKED: settings.alertOnAppear=false');    return; }
  if (event === ALERT_EVENT.DISAPPEARS && settings.alertOnDisappear === false) { console.warn('[TW:content] BLOCKED: settings.alertOnDisappear=false'); return; }

  // once_per_page frequency gate
  const alerted = alertedThisLoad.get(keyword.id) || { appeared: false, disappeared: false };
  console.log('[TW:content] alerted state:', alerted, '| frequency:', settings.notifFrequency);
  if (settings.notifFrequency === 'once_per_page') {
    if (event === ALERT_EVENT.APPEARS    && alerted.appeared)    { console.warn('[TW:content] BLOCKED: already alerted (appear) this page load');    return; }
    if (event === ALERT_EVENT.DISAPPEARS && alerted.disappeared) { console.warn('[TW:content] BLOCKED: already alerted (disappear) this page load'); return; }
  }

  if (event === ALERT_EVENT.APPEARS)    alerted.appeared    = true;
  if (event === ALERT_EVENT.DISAPPEARS) alerted.disappeared = true;
  alertedThisLoad.set(keyword.id, alerted);

  // Build context snippet for appear events (when enabled)
  let snippet = null;
  if (settings.showSnippet && event === ALERT_EVENT.APPEARS) {
    const positions = findMatchPositions(pageText, keyword.text, keyword.matchType);
    if (positions.length > 0) {
      snippet = extractSnippet(
        pageText,
        positions[0].index,
        positions[0].length,
        LIMITS.SNIPPET_CHARS
      );
    }
  }

  const msg = {
    type:      event === ALERT_EVENT.APPEARS ? MSG.TEXT_APPEARED : MSG.TEXT_DISAPPEARED,
    keyword:   keyword.text,
    matchType: keyword.matchType,
    url:       window.location.href,
    title:     document.title,
    snippet,
  };
  console.log('[TW:content] Sending message to service worker:', msg.type, msg.keyword);
  sendMessage(msg).then(r => console.log('[TW:content] Service worker ack:', r));
}

// =============================================================================
// Background message handler
// =============================================================================

/**
 * React to RELOAD_RULES pushed by the service worker when settings change.
 * Resets all state and restarts monitoring with the new rule set.
 * @param {object} message
 */
function handleBackgroundMessage(message) {
  if (!message || message.type !== MSG.RELOAD_RULES) return;

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

// =============================================================================
// Messaging helper
// =============================================================================

/**
 * Send a message to the background service worker (Promise wrapper).
 * Swallows ALL errors -- context invalidation and extension reloads must
 * never crash or throw on the monitored page.
 * @param {object} message
 * @returns {Promise<any>}
 */
function sendMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null); // Extension reloaded / context invalid
        } else {
          resolve(response);
        }
      });
    } catch (_) {
      resolve(null);
    }
  });
}

//# sourceURL=textwatcher-content.js