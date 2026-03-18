/**
 * storage.js
 * Unified wrapper around chrome.storage.local.
 * All reads/writes go through here — no direct storage calls elsewhere.
 * 100% local, zero external calls.
 */

import { STORAGE_KEY, DEFAULT_SETTINGS, DEFAULT_WEBHOOK, LIMITS } from './constants.js';

// ─── Generic Helpers ─────────────────────────────────────────────────────────

/**
 * Get one or more keys from local storage.
 * @param {string|string[]} keys
 * @returns {Promise<object>}
 */
export async function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(result);
    });
  });
}

/**
 * Set key/value pairs in local storage.
 * @param {object} data
 * @returns {Promise<void>}
 */
export async function storageSet(data) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(data, () => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve();
    });
  });
}

// ─── Master Toggle ───────────────────────────────────────────────────────────

export async function getEnabled() {
  const { [STORAGE_KEY.ENABLED]: val } = await storageGet(STORAGE_KEY.ENABLED);
  return val !== false; // default true
}

export async function setEnabled(bool) {
  await storageSet({ [STORAGE_KEY.ENABLED]: bool });
}

// ─── Settings ────────────────────────────────────────────────────────────────

export async function getSettings() {
  const { [STORAGE_KEY.SETTINGS]: saved } = await storageGet(STORAGE_KEY.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(saved || {}) };
}

export async function saveSettings(partial) {
  const current = await getSettings();
  await storageSet({ [STORAGE_KEY.SETTINGS]: { ...current, ...partial } });
}

// ─── Keywords ────────────────────────────────────────────────────────────────

/**
 * @returns {Promise<KeywordRule[]>}
 */
export async function getKeywords() {
  const { [STORAGE_KEY.KEYWORDS]: list } = await storageGet(STORAGE_KEY.KEYWORDS);
  return list || [];
}

/**
 * Save the full keywords array.
 * @param {KeywordRule[]} keywords
 */
export async function saveKeywords(keywords) {
  const trimmed = keywords.slice(0, LIMITS.MAX_KEYWORDS);
  await storageSet({ [STORAGE_KEY.KEYWORDS]: trimmed });
}

/**
 * Add a single keyword rule.
 * @param {KeywordRule} rule
 */
export async function addKeyword(rule) {
  const list = await getKeywords();
  list.push({ ...rule, id: generateId() });
  await saveKeywords(list);
}

/**
 * Update a keyword rule by id.
 * @param {string} id
 * @param {Partial<KeywordRule>} patch
 */
export async function updateKeyword(id, patch) {
  const list = await getKeywords();
  const idx = list.findIndex((k) => k.id === id);
  if (idx !== -1) list[idx] = { ...list[idx], ...patch };
  await saveKeywords(list);
}

/**
 * Remove a keyword rule by id.
 * @param {string} id
 */
export async function removeKeyword(id) {
  const list = await getKeywords();
  await saveKeywords(list.filter((k) => k.id !== id));
}

// ─── URL Rules ───────────────────────────────────────────────────────────────

/**
 * @returns {Promise<UrlRule[]>}
 */
export async function getUrls() {
  const { [STORAGE_KEY.URLS]: list } = await storageGet(STORAGE_KEY.URLS);
  return list || [];
}

/**
 * Save the full URL rules array.
 * @param {UrlRule[]} urls
 */
export async function saveUrls(urls) {
  const trimmed = urls.slice(0, LIMITS.MAX_URLS);
  await storageSet({ [STORAGE_KEY.URLS]: trimmed });
}

/**
 * Add a single URL rule. Silently rejects exact duplicates (same pattern + matchType).
 * @param {UrlRule} rule
 * @returns {Promise<boolean>} true if added, false if rejected as duplicate
 */
export async function addUrl(rule) {
  const list = await getUrls();
  const isDuplicate = list.some(
    (u) => u.pattern === rule.pattern && u.matchType === rule.matchType
  );
  if (isDuplicate) return false;
  list.push({ ...rule, id: generateId() });
  await saveUrls(list);
  return true;
}

/**
 * Update a URL rule by id.
 * @param {string} id
 * @param {Partial<UrlRule>} patch
 */
export async function updateUrl(id, patch) {
  const list = await getUrls();
  const idx = list.findIndex((u) => u.id === id);
  if (idx !== -1) list[idx] = { ...list[idx], ...patch };
  await saveUrls(list);
}

/**
 * Remove a URL rule by id.
 * @param {string} id
 */
export async function removeUrl(id) {
  const list = await getUrls();
  await saveUrls(list.filter((u) => u.id !== id));
}

// ─── History (last 10 setups) ─────────────────────────────────────────────────

/**
 * @returns {Promise<HistoryEntry[]>}
 */
export async function getHistory() {
  const { [STORAGE_KEY.HISTORY]: list } = await storageGet(STORAGE_KEY.HISTORY);
  return list || [];
}

/**
 * Save current keywords+urls as a new history entry.
 * Keeps only the last LIMITS.MAX_HISTORY entries.
 */
export async function saveHistorySnapshot(label = '') {
  const [keywords, urls, history] = await Promise.all([
    getKeywords(),
    getUrls(),
    getHistory(),
  ]);

  // Don't save an empty setup — nothing useful to restore
  if (keywords.length === 0 && urls.length === 0) return null;

  // Fingerprint covers only the fields that affect monitoring behaviour;
  // label, id, enabled state are intentionally excluded.
  // Computed once and stored with the entry to avoid O(n) recomputation on
  // every subsequent save.
  const computeFingerprint = (kws, us) => JSON.stringify({
    k: kws.map((k) => ({ t: k.text, m: k.matchType, s: k.scopeSelector || '', aa: k.alertAppear, ad: k.alertDisappear }))
          .sort((a, b) => a.t.localeCompare(b.t) || a.m.localeCompare(b.m)),
    u: us.map((u) => ({ p: u.pattern, m: u.matchType }))
         .sort((a, b) => a.p.localeCompare(b.p)),
  });

  const currentPrint = computeFingerprint(keywords, urls);

  // Compare against stored fingerprints (O(n) string compare, not O(n) recompute)
  if (history.some((h) => (h.fingerprint ?? computeFingerprint(h.keywords, h.urls)) === currentPrint)) {
    return null;
  }

  const entry = {
    id:          generateId(),
    label:       label || `Setup ${new Date().toLocaleString()}`,
    timestamp:   Date.now(),
    fingerprint: currentPrint,
    keywords:    JSON.parse(JSON.stringify(keywords)),
    urls:        JSON.parse(JSON.stringify(urls)),
  };

  const updated = [entry, ...history].slice(0, LIMITS.MAX_HISTORY);
  await storageSet({ [STORAGE_KEY.HISTORY]: updated });
  return entry;
}

/**
 * Restore a history entry — overwrites current keywords and urls.
 * Uses a single storageSet call to avoid two separate storage.onChanged
 * events that would put content scripts in an inconsistent state temporarily.
 * @param {string} id
 */
export async function restoreHistoryEntry(id) {
  const history = await getHistory();
  const entry = history.find((h) => h.id === id);
  if (!entry) throw new Error(`History entry ${id} not found`);
  await storageSet({
    [STORAGE_KEY.KEYWORDS]: entry.keywords.slice(0, LIMITS.MAX_KEYWORDS),
    [STORAGE_KEY.URLS]:     entry.urls.slice(0, LIMITS.MAX_URLS),
  });
}

/**
 * Delete a single history entry by id.
 * @param {string} id
 */
export async function removeHistoryEntry(id) {
  const history = await getHistory();
  await storageSet({
    [STORAGE_KEY.HISTORY]: history.filter((h) => h.id !== id),
  });
}

// ─── Alert History (what fired, when, where) ───────────────────────────────────
// Separate from saved-setup history. Records every notification that fired.
// Capped at LIMITS.MAX_ALERT_HISTORY entries (newest first).

/**
 * @returns {Promise<AlertEvent[]>}
 */
export async function getAlertHistory() {
  const { [STORAGE_KEY.ALERT_HISTORY]: list } = await storageGet(STORAGE_KEY.ALERT_HISTORY);
  return list || [];
}

/**
 * Prepend a new alert event to the log, trimming to MAX_ALERT_HISTORY.
 * @param {{ event:string, keyword:string, matchType:string, url:string, title:string, snippet:string|null, tabId:number, timestamp:number }} entry
 */
export async function addAlertEvent(entry) {
  const list    = await getAlertHistory();
  const updated = [{ ...entry, id: generateId() }, ...list].slice(0, LIMITS.MAX_ALERT_HISTORY);
  await storageSet({ [STORAGE_KEY.ALERT_HISTORY]: updated });
}

/**
 * Wipe the entire alert history log.
 */
export async function clearAlertHistory() {
  await storageSet({ [STORAGE_KEY.ALERT_HISTORY]: [] });
}

/**
 * Remove a single alert event by id.
 * @param {string} id
 */
export async function removeAlertEvent(id) {
  const list = await getAlertHistory();
  await storageSet({ [STORAGE_KEY.ALERT_HISTORY]: list.filter((e) => e.id !== id) });
}

// ─── Webhook Settings ────────────────────────────────────────────────────────

/**
 * @returns {Promise<{enabled:boolean,url:string,secret:string,onAppear:boolean,onDisappear:boolean}>}
 */
export async function getWebhookSettings() {
  const { [STORAGE_KEY.WEBHOOK]: saved } = await storageGet(STORAGE_KEY.WEBHOOK);
  return { ...DEFAULT_WEBHOOK, ...(saved || {}) };
}

/**
 * Persist webhook settings. Merges with existing values.
 * @param {Partial<typeof DEFAULT_WEBHOOK>} partial
 */
export async function saveWebhookSettings(partial) {
  const current = await getWebhookSettings();
  await storageSet({ [STORAGE_KEY.WEBHOOK]: { ...current, ...partial } });
}

// ─── Onboarding ───────────────────────────────────────────────────────────────

export async function getOnboarded() {
  const { [STORAGE_KEY.ONBOARDED]: val } = await storageGet(STORAGE_KEY.ONBOARDED);
  return val === true;
}

export async function setOnboarded() {
  await storageSet({ [STORAGE_KEY.ONBOARDED]: true });
}

// ─── Utility ─────────────────────────────────────────────────────────────────

/**
 * Generate a cryptographically random unique ID.
 * @returns {string}
 */
export function generateId() {
  return crypto.randomUUID();
}

/**
 * @typedef {Object} KeywordRule
 * @property {string}  id
 * @property {string}  text           - The keyword/phrase to match
 * @property {string}  matchType      - One of MATCH_TYPE values
 * @property {string}  scopeSelector  - CSS selector to scope matching (empty = whole page)
 * @property {boolean} enabled        - Whether this rule is active
 * @property {boolean} alertAppear    - Alert when text appears
 * @property {boolean} alertDisappear - Alert when text disappears
 */

/**
 * @typedef {Object} UrlRule
 * @property {string}  id
 * @property {string}  pattern        - The URL or pattern
 * @property {string}  matchType      - One of URL_MATCH_TYPE values
 * @property {boolean} enabled        - Whether this rule is active
 * @property {string}  label          - Optional human-readable name
 */

/**
 * @typedef {Object} HistoryEntry
 * @property {string}        id
 * @property {string}        label
 * @property {number}        timestamp
 * @property {string}        [fingerprint] - Cached dedup fingerprint (added in v2)
 * @property {KeywordRule[]} keywords
 * @property {UrlRule[]}     urls
 */
