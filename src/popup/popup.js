/**
 * popup.js
 * Handles all popup UI interactions.
 * Communicates via chrome.storage and chrome.runtime messaging only.
 */

import {
  getEnabled, setEnabled,
  getKeywords, addKeyword,
  getUrls, addUrl,
  getAlertHistory,
} from '../shared/storage.js';
import { STORAGE_KEY, MATCH_TYPE, URL_SCOPE_ALL } from '../shared/constants.js';
import { validateRegex, matchesUrl } from '../shared/matcher.js';
import { qs, timeAgo, truncate, escapeHtml, onStorageChange } from '../shared/utils.js';

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
const useCurrentUrlBtn  = qs('#useCurrentUrlBtn');
const urlError          = qs('#urlError');
const keywordCount      = qs('#keywordCount');
const urlCount          = qs('#urlCount');
const alertCount        = qs('#alertCount');
const openOptionsBtn    = qs('#openOptionsBtn');

// ── Tab Context Bar refs (resolved lazily — element may not exist on old DOM)
const tabCtxBar    = qs('#tabCtxBar');
const tabCtxDot    = qs('#tabCtxDot');
const tabCtxText   = qs('#tabCtxText');
const tabCtxAddBtn = qs('#tabCtxAddBtn');
const quickUrlBinding = qs('#quickUrlBinding');

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  await renderAll();
  bindEvents();
  listenForStorageChanges();
}

async function renderAll() {
  await Promise.all([
    renderTabContext(),
    renderToggle(),
    renderStatus(),
    renderCounts(),
    renderPopupUrlBinding(),
  ]);
}

// ─── URL Binding in Popup Keyword Form ───────────────────────────────────────────────────────────

async function renderPopupUrlBinding() {
  if (!quickUrlBinding) return;
  const urls = await getUrls();
  const active = urls.filter((u) => u.enabled);
  if (active.length === 0) {
    quickUrlBinding.innerHTML = '<p class="advanced-hint" style="margin:0">Add URL rules first to bind this keyword to specific pages.</p>';
    return;
  }
  quickUrlBinding.innerHTML = active.map((u) => {
    const label = truncate(u.label || u.pattern, 38);
    return `<label class="popup-url-binding__item">
      <input type="checkbox" name="quickUrlScope" value="${escapeHtml(u.id)}" />
      <span>${escapeHtml(label)}</span>
    </label>`;
  }).join('');
}

function readPopupUrlBinding() {
  if (!quickUrlBinding) return URL_SCOPE_ALL;
  const checked = Array.from(quickUrlBinding.querySelectorAll('input[name="quickUrlScope"]:checked')).map((cb) => cb.value);
  return checked.length > 0 ? checked : URL_SCOPE_ALL;
}

// ─── Tab Context Bar ────────────────────────────────────────────────────────────────────────────────

async function renderTabContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabUrl = tab?.url ?? '';

  // Hide bar for browser-internal pages.
  if (!tabUrl || /^(chrome|about|edge|moz-extension|chrome-extension):/.test(tabUrl)) {
    tabCtxBar.style.display = 'none';
    return;
  }

  tabCtxBar.style.display = '';

  const enabled = await getEnabled();
  if (!enabled) {
    tabCtxBar.className    = 'tab-ctx-bar';
    tabCtxDot.className    = 'tab-ctx-bar__dot';
    tabCtxText.textContent = 'Monitoring paused';
    tabCtxAddBtn.classList.add('hidden');
    return;
  }

  const [urls, keywords] = await Promise.all([getUrls(), getKeywords()]);
  const activeUrls = urls.filter((u) => u.enabled);
  const matched    = activeUrls.filter((u) => matchesUrl(tabUrl, u.pattern, u.matchType));

  if (matched.length > 0) {
    const activeKw = keywords.filter((k) => {
      if (!k.enabled) return false;
      if (!k.urlScope || k.urlScope === 'all') return true;
      return k.urlScope.some((uid) => matched.some((u) => u.id === uid));
    }).length;
    tabCtxBar.className    = 'tab-ctx-bar tab-ctx-bar--watched';
    tabCtxDot.className    = 'tab-ctx-bar__dot';
    tabCtxText.textContent = `Watching this page · ${activeKw} keyword${activeKw !== 1 ? 's' : ''} active`;
    tabCtxAddBtn.classList.add('hidden');
  } else {
    tabCtxBar.className    = 'tab-ctx-bar tab-ctx-bar--unwatched';
    tabCtxDot.className    = 'tab-ctx-bar__dot';
    tabCtxText.textContent = "This page isn't monitored";
    tabCtxAddBtn.classList.remove('hidden');
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
  const [keywords, urls, alerts] = await Promise.all([
    getKeywords(),
    getUrls(),
    getAlertHistory(),
  ]);

  keywordCount.textContent = keywords.filter((k) => k.enabled).length;
  urlCount.textContent     = urls.filter((u) => u.enabled).length;
  alertCount.textContent   = alerts.length;
}

// ─── Open Options at Section ──────────────────────────────────────────────────

async function openOptionsAt(section) {
  await chrome.storage.local.set({ tw_open_section: section });
  chrome.runtime.openOptionsPage();
}

// ─── Event Bindings ───────────────────────────────────────────────────────────

function bindEvents() {
  // Clear (×) buttons on all .input-wrap inputs
  document.querySelectorAll('.input-wrap').forEach((wrap) => {
    const input = wrap.querySelector('input');
    const btn   = wrap.querySelector('.input-clear');
    if (!input || !btn) return;
    const sync = () => wrap.classList.toggle('has-value', input.value.length > 0);
    input.addEventListener('input', sync);
    btn.addEventListener('click', () => { input.value = ''; sync(); input.focus(); });
    sync();
  });

  // Master toggle
  masterToggle.addEventListener('change', async () => {
    await setEnabled(masterToggle.checked);
    updateStatusIndicator(masterToggle.checked);
    await renderStatus();
  });

  // Advanced toggle (scope selector)
  qs('#advancedToggleBtn').addEventListener('click', () => {
    const wrap = qs('#advancedRowWrap');
    const btn  = qs('#advancedToggleBtn');
    const open = wrap.classList.contains('open');
    wrap.classList.toggle('open', !open);
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

  // Fill URL field from current active tab
  useCurrentUrlBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && !tab.url.startsWith('chrome') && !tab.url.startsWith('about')) {
      quickUrl.value      = tab.url;
      quickUrlLabel.value = tab.title || '';
    }
  });

  // Tab context bar — "+ Add URL" shortcut
  tabCtxAddBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && !tab.url.startsWith('chrome') && !tab.url.startsWith('about')) {
      try {
        const { hostname } = new URL(tab.url);
        quickUrl.value          = hostname;
        quickUrlMatchType.value = 'domain';
        quickUrlLabel.value     = tab.title || '';
      } catch (_) {
        quickUrl.value = tab.url;
      }
      quickUrl.focus();
      quickUrl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  // History actions (delegated) - removed (list no longer in popup)

  // Summary card navigation
  qs('#cardKeywords').addEventListener('click', () => openOptionsAt('keywords'));
  qs('#cardUrls').addEventListener('click',     () => openOptionsAt('urls'));
  qs('#cardAlerts').addEventListener('click',   () => openOptionsAt('activity'));

  // Footer nav buttons
  qs('#navSetups').addEventListener('click',  () => openOptionsAt('history'));
  openOptionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
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
    urlScope:       readPopupUrlBinding(),
    enabled:        true,
    alertAppear:    quickAlertAppear.checked,
    alertDisappear: quickAlertDisappear.checked,
  });

  quickKeyword.value    = '';
  qs('#quickScope').value = '';
  // Reset URL binding checkboxes
  quickUrlBinding?.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = false; });
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

  // Validate scheme for all match types. `domain` skips URL parsing but must
  // still be a plain hostname — block javascript:, data:, and other dangerous schemes.
  if (matchType === 'domain') {
    const stripped = pattern.replace(/^\*\./, '');
    if (/[:/]/.test(stripped)) {
      showError(urlError, 'Domain should be a hostname only, e.g. example.com');
      return;
    }
  } else {
    try {
      const parsed = new URL(pattern.replace(/\*/g, 'x'));
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        showError(urlError, 'Only http:// and https:// URLs are supported.');
        return;
      }
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
    [STORAGE_KEY.KEYWORDS, STORAGE_KEY.URLS, STORAGE_KEY.HISTORY,
     STORAGE_KEY.ALERT_HISTORY, STORAGE_KEY.ENABLED],
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
  // Reuse status bar as toast. Build DOM safely — never interpolate msg into innerHTML.
  const icon = document.createElement('span');
  icon.innerHTML = SVG_CHECK; // SVG is a trusted compile-time constant
  statusText.textContent = '';
  statusText.appendChild(icon);
  statusText.appendChild(document.createTextNode(' ' + msg));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    renderStatus();
  }, 2000);
}


// ─── Start ────────────────────────────────────────────────────────────────────
init();
