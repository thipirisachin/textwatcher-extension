/**
 * popup.js
 * Handles all popup UI interactions.
 * Communicates via chrome.storage and chrome.runtime messaging only.
 */

import { STORAGE_KEY, MATCH_TYPE, MSG } from '../shared/constants.js';
import {
  getEnabled, setEnabled,
  getKeywords, addKeyword,
  getUrls, addUrl,
  getHistory, saveHistorySnapshot, restoreHistoryEntry, removeHistoryEntry,
} from '../shared/storage.js';
import { validateRegex } from '../shared/matcher.js';
import { qs, timeAgo, truncate, onStorageChange } from '../shared/utils.js';

// ─── SVG Icon Strings ─────────────────────────────────────────────────────────
const SVG_CHEVRON_RIGHT = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
const SVG_CHEVRON_DOWN  = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
const SVG_CHECK         = '<svg style="vertical-align:middle" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

// ─── DOM References ───────────────────────────────────────────────────────────
const masterToggle      = qs('#masterToggle');
const statusDot         = qs('#statusDot');
const statusText        = qs('#statusText');
const quickKeyword      = qs('#quickKeyword');
const quickMatchType    = qs('#quickMatchType');
const quickAlertAppear  = qs('#quickAlertAppear');
const quickAlertDisappear = qs('#quickAlertDisappear');
const addKeywordBtn     = qs('#addKeywordBtn');
const keywordError      = qs('#keywordError');
const quickUrl          = qs('#quickUrl');
const quickUrlMatchType = qs('#quickUrlMatchType');
const quickUrlLabel     = qs('#quickUrlLabel');
const addUrlBtn         = qs('#addUrlBtn');
const urlError          = qs('#urlError');
const keywordCount      = qs('#keywordCount');
const urlCount          = qs('#urlCount');
const historyCount      = qs('#historyCount');
const historyList       = qs('#historyList');
const historyBadge      = qs('#historyBadge');
const openOptionsBtn    = qs('#openOptionsBtn');
const saveSnapshotBtn   = qs('#saveSnapshotBtn');

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  await renderAll();
  bindEvents();
  listenForStorageChanges();
}

async function renderAll() {
  await Promise.all([
    renderToggle(),
    renderStatus(),
    renderCounts(),
    renderHistory(),
    refreshLiveStatus(),
  ]);
}

// ─── Live Match Status ────────────────────────────────────────────────────────

/** Query the active tab's content script for current keyword presence state. */
function getActiveTabMatches() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) { resolve(null); return; }
      chrome.tabs.sendMessage(tabs[0].id, { type: MSG.GET_MATCH_STATE }, (response) => {
        if (chrome.runtime.lastError || !response) { resolve(null); return; }
        resolve(response.matches || null);
      });
    });
  });
}

async function refreshLiveStatus() {
  const section = qs('#liveSection');
  const list    = qs('#matchList');
  const matches = await getActiveTabMatches();

  if (!matches || matches.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  list.innerHTML = '';
  for (const m of matches) {
    const li = document.createElement('li');
    li.className = 'match-item';
    const dotCls = m.present === true  ? 'match-dot--on'
                 : m.present === false ? 'match-dot--off'
                 : 'match-dot--unknown';
    const label = m.present === true ? 'Found' : m.present === false ? 'Absent' : '…';
    li.innerHTML = `
      <span class="match-dot ${dotCls}" title="${label}"></span>
      <span class="match-item__text">${escapeHtml(truncate(m.text, 30))}</span>
      ${m.scopeSelector ? `<span class="match-item__scope" title="${escapeHtml(m.scopeSelector)}">${escapeHtml(truncate(m.scopeSelector, 22))}</span>` : ''}
      <span class="match-item__status ${dotCls.replace('match-dot', 'match-status')}">${label}</span>
    `;
    list.appendChild(li);
  }
}

// ─── Toggle ───────────────────────────────────────────────────────────────────

async function renderToggle() {
  const enabled = await getEnabled();
  masterToggle.checked = enabled;
  updateStatusIndicator(enabled);
}

function updateStatusIndicator(enabled) {
  statusDot.className = `status-dot status-dot--${enabled ? 'active' : 'inactive'}`;
  statusText.textContent = enabled ? 'Monitoring active' : 'Monitoring paused';
}

// ─── Counts & Status ──────────────────────────────────────────────────────────

async function renderStatus() {
  const [enabled, keywords, urls] = await Promise.all([
    getEnabled(),
    getKeywords(),
    getUrls(),
  ]);

  const activeK = keywords.filter((k) => k.enabled).length;
  const activeU = urls.filter((u) => u.enabled).length;

  if (!enabled) {
    statusText.textContent = 'Monitoring paused';
    statusDot.className = 'status-dot status-dot--inactive';
  } else if (activeK === 0 || activeU === 0) {
    statusText.textContent = `Active — add ${activeK === 0 ? 'keywords' : 'URLs'} to begin`;
    statusDot.className = 'status-dot status-dot--inactive';
  } else {
    statusText.textContent = `Monitoring ${activeU} URL${activeU !== 1 ? 's' : ''}, ${activeK} keyword${activeK !== 1 ? 's' : ''}`;
    statusDot.className = 'status-dot status-dot--active';
  }
}

async function renderCounts() {
  const [keywords, urls, history] = await Promise.all([
    getKeywords(),
    getUrls(),
    getHistory(),
  ]);

  keywordCount.textContent = keywords.filter((k) => k.enabled).length;
  urlCount.textContent     = urls.filter((u) => u.enabled).length;
  historyCount.textContent = history.length;
  historyBadge.textContent = history.length;
}

// ─── History ─────────────────────────────────────────────────────────────────

async function renderHistory() {
  const history = await getHistory();

  if (history.length === 0) {
    historyList.innerHTML = '<li class="history-list__empty">No saved setups yet.</li>';
    return;
  }

  historyList.innerHTML = '';
  history.forEach((entry) => {
    const li = document.createElement('li');
    li.className = 'history-item';
    li.dataset.id = entry.id;

    const kwdSummary = entry.keywords.length > 0
      ? entry.keywords.slice(0, 3).map((k) => `"${truncate(k.text, 20)}"`).join(', ')
      : 'No keywords';
    const urlSummary = `${entry.urls.length} URL${entry.urls.length !== 1 ? 's' : ''}`;

    li.innerHTML = `
      <div class="history-item__meta">
        <div class="history-item__label">${escapeHtml(entry.label)}</div>
        <div class="history-item__sub">${escapeHtml(kwdSummary)} · ${urlSummary} · ${timeAgo(entry.timestamp)}</div>
      </div>
      <div class="history-item__actions">
        <button class="btn--icon restore" data-action="restore" data-id="${entry.id}" title="Restore this setup">↩</button>
        <button class="btn--icon delete"  data-action="delete"  data-id="${entry.id}" title="Delete">✕</button>
      </div>
    `;
    historyList.appendChild(li);
  });
}

// ─── Event Bindings ───────────────────────────────────────────────────────────

function bindEvents() {
  // Master toggle
  masterToggle.addEventListener('change', async () => {
    await setEnabled(masterToggle.checked);
    updateStatusIndicator(masterToggle.checked);
    await renderStatus();
  });

  // Advanced toggle (scope selector)
  qs('#advancedToggleBtn').addEventListener('click', () => {
    const row = qs('#advancedRow');
    const btn = qs('#advancedToggleBtn');
    const open = !row.classList.contains('hidden');
    row.classList.toggle('hidden', open);
    btn.innerHTML = (open ? SVG_CHEVRON_RIGHT : SVG_CHEVRON_DOWN) + ' Advanced';
  });

  // Add keyword
  addKeywordBtn.addEventListener('click', handleAddKeyword);
  quickKeyword.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAddKeyword();
  });

  // Add URL
  addUrlBtn.addEventListener('click', handleAddUrl);
  quickUrl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAddUrl();
  });

  // History actions (delegated)
  historyList.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;

    if (action === 'restore') {
      await restoreHistoryEntry(id);
      showToast('Setup restored!');
      await renderAll();
    }

    if (action === 'delete') {
      await removeHistoryEntry(id);
      await renderHistory();
      await renderCounts();
    }
  });

  // Open full settings
  openOptionsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // Save current setup as snapshot
  saveSnapshotBtn.addEventListener('click', async () => {
    const label = `Setup ${new Date().toLocaleString()}`;
    await saveHistorySnapshot(label);
    await renderHistory();
    await renderCounts();
    showToast('Setup saved!');
  });
}

// ─── Add Keyword Handler ──────────────────────────────────────────────────────

async function handleAddKeyword() {
  const text      = quickKeyword.value.trim();
  const matchType = quickMatchType.value;

  hideError(keywordError);

  if (!text) {
    showError(keywordError, 'Please enter a keyword.');
    return;
  }

  if (matchType === MATCH_TYPE.REGEX) {
    const { valid, error } = validateRegex(text);
    if (!valid) {
      showError(keywordError, `Invalid regex: ${error}`);
      return;
    }
  }

  const scopeSelector = qs('#quickScope').value.trim();

  await addKeyword({
    text,
    matchType,
    scopeSelector,
    enabled:        true,
    alertAppear:    quickAlertAppear.checked,
    alertDisappear: quickAlertDisappear.checked,
  });

  quickKeyword.value    = '';
  qs('#quickScope').value = '';
  showToast('Keyword added!');
  await renderCounts();
  await renderStatus();
}

// ─── Add URL Handler ──────────────────────────────────────────────────────────

async function handleAddUrl() {
  const pattern   = quickUrl.value.trim();
  const matchType = quickUrlMatchType.value;
  const label     = quickUrlLabel.value.trim();

  hideError(urlError);

  if (!pattern) {
    showError(urlError, 'Please enter a URL or pattern.');
    return;
  }

  // Basic URL validation for exact/wildcard types
  if (matchType !== 'domain') {
    try {
      // For wildcard, replace * with a valid char before parsing
      new URL(pattern.replace(/\*/g, 'x'));
    } catch (_) {
      showError(urlError, 'Invalid URL format. Example: https://example.com/*');
      return;
    }
  }

  await addUrl({
    pattern,
    matchType,
    label: label || pattern,
    enabled: true,
  });

  quickUrl.value      = '';
  quickUrlLabel.value = '';
  showToast('URL added!');
  await renderCounts();
  await renderStatus();
}

// ─── Storage Change Listener ──────────────────────────────────────────────────

function listenForStorageChanges() {
  onStorageChange(
    [STORAGE_KEY.KEYWORDS, STORAGE_KEY.URLS, STORAGE_KEY.HISTORY, STORAGE_KEY.ENABLED],
    async () => {
      await renderAll();
    }
  );
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideError(el) {
  el.textContent = '';
  el.classList.add('hidden');
}

let toastTimer = null;
function showToast(msg) {
  // Reuse status bar as toast
  const prev = statusText.textContent;
  statusText.innerHTML = `${SVG_CHECK} ${msg}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    renderStatus();
  }, 2000);
}

function escapeHtml(str = '') {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─── Start ────────────────────────────────────────────────────────────────────
init();
