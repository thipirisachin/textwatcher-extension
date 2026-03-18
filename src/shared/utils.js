/**
 * utils.js
 * General-purpose utility functions.
 * No imports from other project files — zero circular dependencies.
 */

// ─── Debounce ─────────────────────────────────────────────────────────────────

/**
 * Returns a debounced version of fn that waits `delay` ms after the last call.
 * Used to batch rapid MutationObserver callbacks.
 *
 * @template {(...args: any[]) => any} T
 * @param {T} fn
 * @param {number} delay
 * @returns {T}
 */
export function debounce(fn, delay) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// ─── String Utilities ─────────────────────────────────────────────────────────

/**
 * Truncate a string to maxLen and add ellipsis if needed.
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
export function truncate(str, maxLen = 60) {
  if (!str || str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

/**
 * Escape HTML special chars — used when injecting text into innerHTML.
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Format a timestamp as a human-readable relative time string.
 * @param {number} timestamp - Unix ms
 * @returns {string}
 */
export function timeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  const sec  = Math.floor(diff / 1000);
  const min  = Math.floor(sec / 60);
  const hr   = Math.floor(min / 60);
  const day  = Math.floor(hr / 24);

  if (sec < 60)  return 'just now';
  if (min < 60)  return `${min}m ago`;
  if (hr  < 24)  return `${hr}h ago`;
  return `${day}d ago`;
}

// ─── Match Type Labels ────────────────────────────────────────────────────────

/**
 * Human-readable labels for match types.
 * Keeps UI and logic decoupled.
 */
export const MATCH_TYPE_LABEL = {
  exact_case:   'Contains (case-sensitive)',   // substring search, case-sensitive
  exact_nocase: 'Contains (case-insensitive)', // substring search, case-insensitive
  contains:     'Contains',                    // alias for exact_nocase (case-insensitive)
  starts_with:  'Starts with',
  ends_with:    'Ends with',
  regex:        'Regex',
};

export const URL_MATCH_TYPE_LABEL = {
  exact:    'Exact URL',
  wildcard: 'Wildcard',
  domain:   'Domain-wide',
};

// ─── DOM Helpers (safe for content script use) ───────────────────────────────

/**
 * Query a single element — returns null instead of throwing.
 * @param {string} selector
 * @param {Element|Document} [root=document]
 * @returns {Element|null}
 */
export function qs(selector, root = document) {
  return root.querySelector(selector);
}

/**
 * Query all elements — returns an Array, not NodeList.
 * @param {string} selector
 * @param {Element|Document} [root=document]
 * @returns {Element[]}
 */
export function qsa(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

// ─── Storage Change Listener Helper ──────────────────────────────────────────

/**
 * Watch specific storage keys and call handler when they change.
 * Cleans up automatically if you call the returned unsubscribe fn.
 *
 * @param {string[]} keys
 * @param {(changes: object) => void} handler
 * @returns {() => void} unsubscribe
 */
export function onStorageChange(keys, handler) {
  const listener = (changes, area) => {
    if (area !== 'local') return;
    const relevant = Object.fromEntries(
      Object.entries(changes).filter(([k]) => keys.includes(k))
    );
    if (Object.keys(relevant).length > 0) handler(relevant);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
