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

(function () {

// Guard: if this script has already been injected into this page context,
// bail out immediately. Chrome's executeScript may re-run this file when
// settings change; without the IIFE the top-level const/let declarations
// would throw SyntaxError: Identifier '...' has already been declared.
if (window.__textWatcherActive) return;
window.__textWatcherActive = true;

// =============================================================================
// Inlined constants (subset of shared/constants.js)
// =============================================================================

const MSG = Object.freeze({
  TEXT_APPEARED:    'text_appeared',
  TEXT_DISAPPEARED: 'text_disappeared',
  GET_STATE:        'get_state',
  RELOAD_RULES:     'reload_rules',
  PREVIEW_MATCH:    'preview_match',    // Popup → content script: live row match count
  DETECT_ROWS:      'detect_rows',      // Popup → content script: auto-detect table row selector
});

const MATCH_TYPE = Object.freeze({
  EXACT_CASE:    'exact_case',
  EXACT_NOCASE:  'exact_nocase',
  CONTAINS:      'contains',
  CONTAINS_CASE: 'contains_case',
  STARTS_WITH:   'starts_with',
  ENDS_WITH:     'ends_with',
  REGEX:         'regex',
});

const ALERT_EVENT = Object.freeze({
  APPEARS:    'appears',
  DISAPPEARS: 'disappears',
});

const LIMITS = Object.freeze({
  DEBOUNCE_MS:   50,   // MutationObserver debounce window (ms)
  SNIPPET_CHARS: 80,   // Context characters either side of a match
});

// Inlined subset of NOTIF_FREQUENCY (shared/constants.js) — keep in sync.
const NOTIF_FREQUENCY = Object.freeze({
  ONCE_PER_PAGE:    'once_per_page',
  EVERY_OCCURRENCE: 'every_occurrence',
  COOLDOWN:         'cooldown',
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

// Maximum allowed regex pattern length — consistent with shared/matcher.js.
const MAX_REGEX_PATTERN_LENGTH = 300;

/**
 * Test a user-supplied regex pattern against target.
 * Returns false (never throws) on invalid pattern or if pattern exceeds length limit.
 * @param {string} pattern
 * @param {string} target
 * @returns {boolean}
 */
function safeRegexTest(pattern, target) {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) return false;
  try {
    // 'is': i=case-insensitive, s=dotAll so '.' crosses '\n' text-node boundaries
    return new RegExp(pattern, 'is').test(target);
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
    case MATCH_TYPE.CONTAINS_CASE:
      return haystack.includes(needle);
    case MATCH_TYPE.STARTS_WITH:
      // Split on '\n' (the text-node delimiter used by extractPageText) so we test
      // each visible text element independently, not the entire concatenated page.
      return haystack.split('\n').some(
        (seg) => seg.trimStart().toLowerCase().startsWith(needle.toLowerCase())
      );
    case MATCH_TYPE.ENDS_WITH:
      return haystack.split('\n').some(
        (seg) => seg.trimEnd().toLowerCase().endsWith(needle.toLowerCase())
      );
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
      // 'gis': g=all matches, i=case-insensitive, s=dotAll for cross-segment matching
      const rx = new RegExp(needle, 'gis');
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

/** @type {Array<{id:string,pattern:string,matchType:string,enabled:boolean}>} */
let activeUrls = [];

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

/**
 * Pending alert timers — absorb table re-render oscillations.
 * Key: `${keywordId}:${event}`  Value: setTimeout handle
 */
const pendingAlerts = new Map();

/**
 * Grace period (ms) before an alert fires.
 * If the opposite transition arrives within this window (e.g. a dashboard
 * poll that clears and repopulates a table), both are cancelled silently.
 */
const ALERT_SETTLE_MS = 1500;

// =============================================================================
// URL scope filter
// =============================================================================

/**
 * Inlined URL matching logic (mirrors shared/matcher.js matchesUrl).
 * content-script.js cannot use ES module imports.
 */
const URL_MATCH_TYPE_CS = Object.freeze({
  EXACT:    'exact',
  WILDCARD: 'wildcard',
  DOMAIN:   'domain',
});

function matchesUrlCS(href, pattern, matchType) {
  try {
    switch (matchType) {
      case URL_MATCH_TYPE_CS.EXACT:
        return href === pattern;
      case URL_MATCH_TYPE_CS.WILDCARD: {
        const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        return new RegExp('^' + escaped + '$', 'i').test(href);
      }
      case URL_MATCH_TYPE_CS.DOMAIN: {
        const host = new URL(href).hostname;
        const pat  = pattern.replace(/^\*\./, '');
        return host === pat || host.endsWith('.' + pat);
      }
      default: return false;
    }
  } catch (_) { return false; }
}

/**
 * Return true if this keyword should run on the current page.
 * urlScope === 'all' (or missing) → always active.
 * urlScope === string[] → active only if current URL matches one of the bound rules.
 */
function keywordMatchesCurrentUrl(keyword) {
  const scope = keyword.urlScope;
  if (!scope || scope === 'all' || !Array.isArray(scope) || scope.length === 0) return true;
  const href = window.location.href;
  return scope.some((ruleId) => {
    const rule = activeUrls.find((u) => u.id === ruleId);
    return rule && matchesUrlCS(href, rule.pattern, rule.matchType);
  });
}

// =============================================================================
// Entry point
// =============================================================================

(async function init() {
  try {
    const response = await sendMessage({ type: MSG.GET_STATE });
    if (!response || !response.enabled) return;

    activeUrls     = (response.urls     || []).filter((u) => u.enabled);
    activeKeywords = (response.keywords || []).filter((k) => k.enabled && keywordMatchesCurrentUrl(k));
    settings       = response.settings  || {};

    if (activeKeywords.length === 0) return;

    runScan();       // Baseline pass -- records initial state, no alerts
    startObserver(); // Continuous monitoring begins
  } catch (_) {
    // Extension context invalid on restricted pages -- fail silently
  }
})();

// Always register at module scope — outside init() — so RELOAD_RULES messages
// arrive even when init() returned early (extension disabled or no keywords).
// Without this, rules added after page load are silently lost on existing tabs.
// Guard with try/catch: if the extension context was invalidated (e.g. after
// an extension reload on an already-live tab), chrome.runtime is undefined and
// addListener() would throw an uncaught TypeError crashing the whole IIFE.
try {
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === MSG.PREVIEW_MATCH) {
    // Popup queries how many live rows match a given pattern + row selector.
    // When rowSelector is omitted, performs a full-page text match (text mode).
    const { pattern, matchType, rowSelector } = message;
    try {
      if (!rowSelector) {
        // Text mode: scan full page text
        const pageText = extractPageText(null);
        const found    = matchesKeyword(pageText, pattern, matchType);
        let snippet = '';
        if (found) {
          const positions = findMatchPositions(pageText, pattern, matchType);
          if (positions.length > 0) {
            const pos = positions[0];
            const start = Math.max(0, pos.index - 40);
            const end   = Math.min(pageText.length, pos.index + pos.length + 60);
            snippet = (start > 0 ? '…' : '') + pageText.slice(start, end) + (end < pageText.length ? '…' : '');
          }
        }
        sendResponse({ found, matchCount: found ? findMatchPositions(pageText, pattern, matchType).length : 0, snippet });
        return true;
      }
      // Row mode: count matching rows
      const rows = Array.from(document.querySelectorAll(rowSelector))
        .filter(el => el.offsetParent !== null && el.style.visibility !== 'hidden');
      const samples = [];
      let count = 0;
      for (const row of rows) {
        const rowText = extractPageText([row]);
        if (matchesKeyword(rowText, pattern, matchType)) {
          count++;
          if (samples.length < 3) samples.push(rowText.slice(0, 100));
        }
      }
      sendResponse({ count, total: rows.length, samples, firstRowSample: count === 0 && rows.length > 0 ? extractPageText([rows[0]]).slice(0, 120) : null });
    } catch (_) {
      sendResponse({ count: 0, total: 0, error: 'Invalid selector' });
    }
    return true; // async response
  }

  if (message?.type === MSG.DETECT_ROWS) {
    // Popup asks the content script to detect the best CSS selector for table rows.
    // Tries common patterns in priority order; returns the first that finds visible rows.
    const CANDIDATES = [
      'tbody tr',
      '[data-rowid]',
      '[role="row"]:not([role="rowheader"])',
      '.ap-row:not([class*="header"])',
      '[class*="tablerow"]:not([class*="header"])',
      '[class*="row"]:not([class*="header"]):not(html):not(body)',
    ];
    for (const sel of CANDIDATES) {
      try {
        const els = Array.from(document.querySelectorAll(sel))
          .filter(el => el.offsetParent !== null && el.style.visibility !== 'hidden');
        if (els.length > 0) {
          const columns = extractColumnHeaders(document, sel, els[0]);
          sendResponse({ selector: sel, count: els.length, columns });
          return true;
        }
      } catch (_) { continue; }
    }
    sendResponse({ error: 'none found' });
    return true;
  }

  handleBackgroundMessage(message);
});
} catch (_) {
  // Extension context invalidated — content script will stop responding to
  // messages but won't throw an uncaught error on the monitored page.
}

// =============================================================================
// MutationObserver
// =============================================================================

// ─── Column Header Extraction ─────────────────────────────────────────────────
/**
 * Extract column header names for detected table rows.
 * Strategy:
 *  1. Look for <th> elements in the closest <thead> or <tr> preceding the rows.
 *  2. Fall back to data-columnid attributes on the first row's cells.
 *  3. Fall back to index-based labels ("Col 1", "Col 2", …).
 *
 * @param {Document} doc
 * @param {string}   sel      CSS selector used to find rows
 * @param {Element}  firstRow First matching row element
 * @returns {string[]}
 */
function extractColumnHeaders(doc, sel, firstRow) {
  // Try <th> in closest <thead> ancestor
  const thead = firstRow.closest('thead') || firstRow.parentElement?.previousElementSibling;
  if (thead) {
    const ths = Array.from(thead.querySelectorAll('th'));
    if (ths.length > 0) {
      return ths.map((th) => th.textContent.trim()).filter(Boolean);
    }
  }

  // Try <th> anywhere in same table ancestor
  const table = firstRow.closest('table');
  if (table) {
    const ths = Array.from(table.querySelectorAll('thead th, tr:first-child th'));
    if (ths.length > 0) {
      return ths.map((th) => th.textContent.trim()).filter(Boolean);
    }
  }

  // Try data-columnid on the first row's child cells
  const cells = Array.from(firstRow.children);
  const colIds = cells.map((c) => c.getAttribute('data-columnid') || '').filter(Boolean);
  if (colIds.length === cells.length && colIds.length > 0) return colIds;

  // Fall back: use cell count from first row, label by index
  const count = cells.length || 3;
  return Array.from({ length: count }, (_, i) => `Col ${i + 1}`);
}

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
  pendingAlerts.forEach((timer) => clearTimeout(timer));
  pendingAlerts.clear();
}

// =============================================================================
// Core scan logic
// =============================================================================

/**
 * Collect all visible text from the page as one string.
 * TreeWalker is browser-native and faster than querySelectorAll.
 * Skips script / style / noscript / template nodes and hidden elements.
 * @param {Element[]} [roots] - Elements to scan. Defaults to [document.body].
 * @returns {string}
 */
function extractPageText(roots) {
  const scanRoots = (roots && roots.length) ? roots : [document.body];
  const parts = [];

  const filter = {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;

      const tag = parent.tagName ? parent.tagName.toUpperCase() : '';
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(tag)) {
        return NodeFilter.FILTER_REJECT;
      }

      // Avoid getComputedStyle — it forces a synchronous layout reflow on
      // every text node visit and causes [Violation] warnings. Checking
      // inline styles + HTML attributes is O(1) with zero reflow cost.
      // The MutationObserver already watches style/class/hidden changes, so
      // any CSS-class-driven visibility change triggers a fresh runScan().
      if (parent.hidden ||
          parent.getAttribute('aria-hidden') === 'true' ||
          parent.style.display === 'none' ||
          parent.style.visibility === 'hidden') {
        return NodeFilter.FILTER_REJECT;
      }

      return NodeFilter.FILTER_ACCEPT;
    },
  };

  for (const root of scanRoots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, filter);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim();
      if (text) parts.push(text);
    }
  }
  return parts.join('\n');
}

/**
 * Run one full scan of all active keywords against current page text.
 * Detects appear / disappear transitions by comparing to lastPresence.
 */
function runScan() {
  if (!activeKeywords.length) return;

  // Lazily compute full page text once — shared by all unscoped keywords.
  let _fullPageText = null;
  const getFullPageText = () => {
    if (_fullPageText === null) _fullPageText = extractPageText(null);
    return _fullPageText;
  };

  // Precompute row texts keyed by rowSelector — avoids O(K×N) TreeWalker
  // traversals when multiple keywords share the same selector.
  const rowTextCache = new Map(); // rowSelector → string[] | null (null = bad selector)
  const getRowTexts = (sel) => {
    if (rowTextCache.has(sel)) return rowTextCache.get(sel);
    try {
      const texts = Array.from(document.querySelectorAll(sel))
        .filter(el => el.offsetParent !== null && el.style.visibility !== 'hidden')
        .map(el => extractPageText([el]));
      rowTextCache.set(sel, texts);
      return texts;
    } catch (_) {
      rowTextCache.set(sel, null); // cache the failure so we don't retry
      return null;
    }
  };

  for (const keyword of activeKeywords) {
    let pageText   = '';
    let matchCount = 0;

    // ── Branch A: row-selector mode ─────────────────────────────────────────
    if (keyword.rowSelector) {
      const rowTexts = getRowTexts(keyword.rowSelector);
      if (rowTexts === null) {
        // Invalid selector — degrade gracefully to full-page scan
        pageText   = getFullPageText();
        matchCount = matchesKeyword(pageText, keyword.text, keyword.matchType) ? 1 : 0;
        if (!matchCount) pageText = '';
      } else {
        let firstMatch = null;
        for (const rowText of rowTexts) {
          if (matchesKeyword(rowText, keyword.text, keyword.matchType)) {
            if (!firstMatch) firstMatch = rowText; // keep for snippet
            matchCount++;
          }
        }
        pageText = firstMatch ?? '';
      }
    }
    // ── Branch B: scopeSelector mode (unchanged) ─────────────────────────────
    else if (keyword.scopeSelector) {
      try {
        const els = Array.from(document.querySelectorAll(keyword.scopeSelector));
        pageText = els.length ? extractPageText(els) : getFullPageText();
      } catch (_) {
        pageText = getFullPageText();
      }
      matchCount = matchesKeyword(pageText, keyword.text, keyword.matchType) ? 1 : 0;
    }
    // ── Branch C: full page (unchanged) ──────────────────────────────────────
    else {
      pageText   = getFullPageText();
      matchCount = matchesKeyword(pageText, keyword.text, keyword.matchType) ? 1 : 0;
    }

    // Count-based presence tracking (integer instead of boolean).
    // Alerts still fire on 0↔N transitions; count enables future partial-drop detection.
    const prevCount  = lastPresence.has(keyword.id) ? lastPresence.get(keyword.id) : null;
    lastPresence.set(keyword.id, matchCount);

    if (prevCount === null) continue; // Baseline pass — no alerts

    const wasPresent = prevCount  > 0;
    const isPresent  = matchCount > 0;

    if ( isPresent && !wasPresent) scheduleAlert(keyword, ALERT_EVENT.APPEARS,    pageText);
    if (!isPresent &&  wasPresent) scheduleAlert(keyword, ALERT_EVENT.DISAPPEARS, pageText);
  }
}

// =============================================================================
// Alert settle window
// =============================================================================

/**
 * Schedule an alert with a grace period to absorb table re-render oscillations.
 *
 * If the opposite transition (appear ↔ disappear) arrives for the same keyword
 * within ALERT_SETTLE_MS, both are cancelled — the DOM went away and came back
 * as part of a polling re-render, not a real state change.
 *
 * @param {{id:string,text:string,matchType:string,alertAppear:boolean,alertDisappear:boolean}} keyword
 * @param {string} event    - ALERT_EVENT value
 * @param {string} pageText
 */
function scheduleAlert(keyword, event, pageText) {
  const key         = `${keyword.id}:${event}`;
  const oppositeEvt = event === ALERT_EVENT.APPEARS
    ? ALERT_EVENT.DISAPPEARS
    : ALERT_EVENT.APPEARS;
  const oppositeKey = `${keyword.id}:${oppositeEvt}`;

  // Opposite transition within settle window → oscillation (re-render), cancel both
  if (pendingAlerts.has(oppositeKey)) {
    clearTimeout(pendingAlerts.get(oppositeKey));
    pendingAlerts.delete(oppositeKey);
    return;
  }

  // Already scheduled for this direction — don't double-fire
  if (pendingAlerts.has(key)) return;

  pendingAlerts.set(key, setTimeout(() => {
    pendingAlerts.delete(key);
    maybeAlert(keyword, event, pageText);
  }, ALERT_SETTLE_MS));
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
  // Per-keyword toggles
  if (event === ALERT_EVENT.APPEARS    && !keyword.alertAppear)    return;
  if (event === ALERT_EVENT.DISAPPEARS && !keyword.alertDisappear) return;

  // once_per_page frequency gate — handled HERE in the content script.
  // The service worker's shouldSendAlert() intentionally passes once_per_page
  // through unconditionally; gating it there too would double-block and would
  // break cross-tab scenarios where the same keyword fires on different tabs.
  const alerted = alertedThisLoad.get(keyword.id) || { appeared: false, disappeared: false };
  if (settings.notifFrequency === NOTIF_FREQUENCY.ONCE_PER_PAGE) {
    if (event === ALERT_EVENT.APPEARS    && alerted.appeared)    return;
    if (event === ALERT_EVENT.DISAPPEARS && alerted.disappeared) return;
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

  sendMessage({
    type:      event === ALERT_EVENT.APPEARS ? MSG.TEXT_APPEARED : MSG.TEXT_DISAPPEARED,
    keyword:   keyword.label || keyword.text,
    keywordId: keyword.id,
    matchType: keyword.matchType,
    url:       window.location.href,
    title:     document.title,
    snippet,
  });
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
  pendingAlerts.forEach((timer) => clearTimeout(timer));
  pendingAlerts.clear();

  activeUrls     = (message.urls     || []).filter((u) => u.enabled);
  activeKeywords = (message.keywords || []).filter((k) => k.enabled && keywordMatchesCurrentUrl(k));
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

}()); // end TextWatcher IIFE

//# sourceURL=textwatcher-content.js