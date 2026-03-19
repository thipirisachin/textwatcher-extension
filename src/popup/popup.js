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
import { STORAGE_KEY, MATCH_TYPE, URL_SCOPE_ALL, MSG } from '../shared/constants.js';
import { validateRegex, matchesUrl } from '../shared/matcher.js';
import { qs, timeAgo, truncate, escapeHtml, onStorageChange, debounce } from '../shared/utils.js';

// ─── SVG Icon Strings ─────────────────────────────────────────────────────────
const SVG_CHECK = '<svg style="vertical-align:middle" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

// ─── DOM References ───────────────────────────────────────────────────────────
const masterToggle        = qs('#masterToggle');
const statusDot           = qs('#statusDot');
const statusText          = qs('#statusText');
const quickKeyword        = qs('#quickKeyword');
const quickMatchType      = qs('#quickMatchType');
const quickAlertAppear    = qs('#quickAlertAppear');
const quickAlertDisappear = qs('#quickAlertDisappear');
const addKeywordBtn       = qs('#addKeywordBtn');
const keywordError        = qs('#keywordError');
const quickUrl            = qs('#quickUrl');
const quickUrlMatchType   = qs('#quickUrlMatchType');
const quickUrlLabel       = qs('#quickUrlLabel');
const addUrlBtn           = qs('#addUrlBtn');
const useCurrentUrlBtn    = qs('#useCurrentUrlBtn');
const urlError            = qs('#urlError');
const keywordCount        = qs('#keywordCount');
const urlCount            = qs('#urlCount');
const alertCount          = qs('#alertCount');
const openOptionsBtn      = qs('#openOptionsBtn');

// ── Tab Context Bar
const tabCtxBar    = qs('#tabCtxBar');
const tabCtxDot    = qs('#tabCtxDot');
const tabCtxText   = qs('#tabCtxText');
const tabCtxAddBtn = qs('#tabCtxAddBtn');

// ── URL binding bar (new location — outside Advanced)
const urlBindingBar = qs('#urlBindingBar');

// ─── Mode state ───────────────────────────────────────────────────────────────
// 'text' = Watch for text (MODE A)
// 'row'  = Watch a table row (MODE B)
let currentMode = 'text';

// Row selector auto-detected silently on init / mode switch
let detectedRowSelector = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  await renderAll();
  bindEvents();
  listenForStorageChanges();
  autoDetectRows(); // silent — no await needed
}

async function renderAll() {
  await Promise.all([
    renderTabContext(),
    renderToggle(),
    renderStatus(),
    renderCounts(),
    renderUrlBindingBar(),
  ]);
}

// ─── URL Binding Bar ──────────────────────────────────────────────────────────

async function renderUrlBindingBar() {
  if (!urlBindingBar) return;
  const urls = await getUrls();
  const active = urls.filter((u) => u.enabled);
  if (active.length === 0) {
    urlBindingBar.innerHTML =
      '<p class="url-binding-bar__warn">' +
      '⚠ No URL rules — won\'t monitor any page. ' +
      '<a href="#" id="scrollToUrl" tabindex="0">Add one below ↓</a>' +
      '</p>';
    qs('#scrollToUrl')?.addEventListener('click', (e) => {
      e.preventDefault();
      qs('#quickUrl')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      qs('#quickUrl')?.focus();
    });
    return;
  }
  urlBindingBar.innerHTML = active.map((u) => {
    const label = truncate(u.label || u.pattern, 36);
    return `<label class="url-binding-bar__item">
      <input type="checkbox" name="quickUrlScope" value="${escapeHtml(u.id)}" />
      <span>${escapeHtml(label)}</span>
    </label>`;
  }).join('') + `<a class="url-binding-bar__more" href="#" id="moreUrlsLink" tabindex="0">+ more</a>`;
  qs('#moreUrlsLink')?.addEventListener('click', (e) => {
    e.preventDefault();
    openOptionsAt('urls');
  });
}

function readUrlBinding() {
  if (!urlBindingBar) return URL_SCOPE_ALL;
  const checked = Array.from(
    urlBindingBar.querySelectorAll('input[name="quickUrlScope"]:checked')
  ).map((cb) => cb.value);
  return checked.length > 0 ? checked : URL_SCOPE_ALL;
}

// ─── Tab Context Bar ──────────────────────────────────────────────────────────

async function renderTabContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabUrl = tab?.url ?? '';

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
  statusDot.className    = `status-dot status-dot--${enabled ? 'active' : 'inactive'}`;
  statusText.textContent = enabled ? 'Monitoring active' : 'Monitoring paused';
}

// ─── Counts & Status ──────────────────────────────────────────────────────────

async function renderStatus() {
  const [enabled, keywords, urls] = await Promise.all([
    getEnabled(), getKeywords(), getUrls(),
  ]);
  const activeK = keywords.filter((k) => k.enabled).length;
  const activeU = urls.filter((u) => u.enabled).length;

  if (!enabled) {
    statusText.textContent = 'Monitoring paused';
    statusDot.className    = 'status-dot status-dot--inactive';
  } else if (activeK === 0 || activeU === 0) {
    statusText.textContent = `Active — add ${activeK === 0 ? 'keywords' : 'URLs'} to begin`;
    statusDot.className    = 'status-dot status-dot--inactive';
  } else {
    statusText.textContent = `Monitoring ${activeU} URL${activeU !== 1 ? 's' : ''}, ${activeK} keyword${activeK !== 1 ? 's' : ''}`;
    statusDot.className    = 'status-dot status-dot--active';
  }
}

async function renderCounts() {
  const [keywords, urls, alerts] = await Promise.all([
    getKeywords(), getUrls(), getAlertHistory(),
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

// ─── Mode Switcher ────────────────────────────────────────────────────────────

function setMode(mode) {
  currentMode = mode;

  const isRow = mode === 'row';
  qs('#modeTextBtn').classList.toggle('active', !isRow);
  qs('#modeRowBtn').classList.toggle('active',  isRow);
  qs('#modeTextBtn').setAttribute('aria-selected', String(!isRow));
  qs('#modeRowBtn').setAttribute('aria-selected',  String(isRow));

  qs('#textModePanel').style.display = isRow ? 'none' : '';
  qs('#rowModePanel').style.display  = isRow ? '' : 'none';

  addKeywordBtn.textContent = isRow ? 'Add Rule' : 'Add Keyword';

  // Smart alert defaults per mode
  if (isRow) {
    quickAlertAppear.checked    = false;
    quickAlertDisappear.checked = true;
  } else {
    quickAlertAppear.checked    = true;
    quickAlertDisappear.checked = false;
  }

  // Reset row state when switching away from row mode
  if (!isRow) {
    detectedRowSelector = null;
  } else {
    autoDetectRows(); // re-detect when switching to row mode
  }

  // Hide preview when switching modes
  const preview = qs('#matchPreview');
  const samples = qs('#matchSamples');
  if (preview) preview.style.display = 'none';
  if (samples) samples.innerHTML = '';
}

// ─── Silent Row Auto-Detection ───────────────────────────────────────────────
// Called on popup open and whenever switching to row mode.
// Updates detectedRowSelector quietly; triggers preview if columns have values.

async function autoDetectRows() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  const res = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { type: MSG.DETECT_ROWS },
      (r) => resolve(chrome.runtime.lastError ? null : r));
  });

  if (res?.selector) {
    detectedRowSelector = res.selector;
    debouncedPreview();
  }
}

// ─── Live Row Match Preview ───────────────────────────────────────────────────

function getRowPattern() {
  // In row mode: build pattern from Column 1/2/3 builder
  const parts = [
    qs('#builderCol1')?.value.trim() ?? '',
    qs('#builderCol2')?.value.trim() ?? '',
    qs('#builderCol3')?.value.trim() ?? '',
  ].filter(Boolean);
  return parts.join('.*');
}

const debouncedPreview = debounce(async () => {
  const preview   = qs('#matchPreview');
  const samplesEl = qs('#matchSamples');
  if (!preview) return;

  if (currentMode !== 'row') {
    preview.style.display = 'none';
    if (samplesEl) samplesEl.innerHTML = '';
    return;
  }

  const pattern     = getRowPattern();
  const rowSelector = detectedRowSelector;

  if (!rowSelector || !pattern) {
    preview.style.display = 'none';
    if (samplesEl) samplesEl.innerHTML = '';
    return;
  }

  preview.style.display = '';
  preview.className     = 'match-preview off';
  preview.textContent   = 'Checking…';
  if (samplesEl) samplesEl.innerHTML = '';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('no tab');

    const response = await new Promise((resolve) => {
      chrome.tabs.sendMessage(
        tab.id,
        { type: MSG.PREVIEW_MATCH, pattern, matchType: MATCH_TYPE.REGEX, rowSelector },
        (res) => resolve(chrome.runtime.lastError ? null : res)
      );
    });

    if (!response) {
      preview.className   = 'match-preview off';
      preview.textContent = 'Not monitoring this page — add a URL rule first';
    } else if (response.error) {
      preview.className   = 'match-preview none';
      preview.textContent = `⚠ Invalid selector: ${response.error}`;
    } else if (response.count === 1) {
      preview.className   = 'match-preview ok';
      preview.textContent = '✓ 1 unique match — rule will fire for this row only';
    } else if (response.count > 1) {
      preview.className   = 'match-preview warn';
      preview.textContent = `⚠ ${response.count} rows match — add more column values to narrow it down`;
    } else {
      preview.className   = 'match-preview none';
      preview.textContent = `✗ No rows match (${response.total} row${response.total !== 1 ? 's' : ''} checked)`;
    }

    if (samplesEl && response.samples?.length) {
      samplesEl.innerHTML =
        '<span style="font-size:10px;color:var(--text-3);display:block;margin-top:4px;">Matched rows:</span>' +
        response.samples.map((s) => `<code>${escapeHtml(s)}…</code>`).join('');
    } else if (samplesEl) {
      samplesEl.innerHTML = '';
    }
  } catch (_) {
    preview.style.display = 'none';
  }
}, 350);

// ─── Add Keyword / Rule Handler ───────────────────────────────────────────────

async function handleAddKeyword() {
  hideError(keywordError);

  let text, matchType, rowSelector = '';

  if (currentMode === 'row') {
    // Row mode: pattern built from builder columns, match type always Regex
    text         = getRowPattern();
    matchType    = MATCH_TYPE.REGEX;
    rowSelector  = detectedRowSelector ?? '';

    if (!text) {
      showError(keywordError, 'Enter at least one column value to identify the row.');
      return;
    }
    if (!rowSelector) {
      showError(keywordError, 'No table detected on this page — add a URL rule and reload the tab first.');
      return;
    }
  } else {
    // Text mode: standard keyword flow
    text      = quickKeyword.value.trim();
    matchType = quickMatchType.value;

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
  }

  const alertName = qs('#alertName')?.value.trim() ?? '';

  await addKeyword({
    text,
    matchType,
    label:          alertName || text,
    scopeSelector:  '',
    rowSelector,
    urlScope:       readUrlBinding(),
    enabled:        true,
    alertAppear:    quickAlertAppear.checked,
    alertDisappear: quickAlertDisappear.checked,
  });

  // Reset form
  if (currentMode === 'row') {
    ['#builderCol1', '#builderCol2', '#builderCol3'].forEach((id) => {
      const el = qs(id); if (el) el.value = '';
    });
    detectedRowSelector = null;
  } else {
    quickKeyword.value = '';
  }
  const alertNameEl = qs('#alertName');
  if (alertNameEl) alertNameEl.value = '';
  const preview = qs('#matchPreview');
  const samples = qs('#matchSamples');
  if (preview) preview.style.display = 'none';
  if (samples) samples.innerHTML = '';

  urlBindingBar?.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = false; });

  const urls = await getUrls();
  const boundCount = readUrlBinding() === URL_SCOPE_ALL
    ? urls.filter((u) => u.enabled).length
    : (Array.isArray(readUrlBinding()) ? readUrlBinding().length : 0);
  const pageNote = boundCount > 0
    ? `watching on ${boundCount} page${boundCount !== 1 ? 's' : ''}`
    : 'watching on all pages';

  showToast(`✓ Rule saved — ${pageNote}`);
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

  await addUrl({ pattern, matchType, label: label || pattern, enabled: true });

  quickUrl.value      = '';
  quickUrlLabel.value = '';
  showToast('✓ URL added');
  await renderCounts();
  await renderStatus();
  await renderUrlBindingBar();
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

  // Mode tabs
  qs('#modeTextBtn').addEventListener('click', () => setMode('text'));
  qs('#modeRowBtn').addEventListener('click',  () => setMode('row'));

  // Add keyword / rule
  addKeywordBtn.addEventListener('click', handleAddKeyword);
  quickKeyword?.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleAddKeyword(); });

  // Builder column inputs → update preview live
  ['#builderCol1', '#builderCol2', '#builderCol3'].forEach((id) => {
    qs(id)?.addEventListener('input', debouncedPreview);
  });

  // Add URL
  addUrlBtn.addEventListener('click', handleAddUrl);
  quickUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleAddUrl(); });

  // Fill URL from current tab
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

  // Summary card navigation
  qs('#cardKeywords').addEventListener('click', () => openOptionsAt('keywords'));
  qs('#cardUrls').addEventListener('click',     () => openOptionsAt('urls'));
  qs('#cardAlerts').addEventListener('click',   () => openOptionsAt('activity'));

  // Footer nav buttons
  qs('#navSetups').addEventListener('click', () => openOptionsAt('history'));
  openOptionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
}

// ─── Storage Change Listener ──────────────────────────────────────────────────

function listenForStorageChanges() {
  onStorageChange(
    [STORAGE_KEY.KEYWORDS, STORAGE_KEY.URLS, STORAGE_KEY.HISTORY,
     STORAGE_KEY.ALERT_HISTORY, STORAGE_KEY.ENABLED],
    async () => { await renderAll(); }
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
  const icon = document.createElement('span');
  icon.innerHTML = SVG_CHECK;
  statusText.textContent = '';
  statusText.appendChild(icon);
  statusText.appendChild(document.createTextNode(' ' + msg));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { renderStatus(); }, 2500);
}

// ─── Start ────────────────────────────────────────────────────────────────────
init();
