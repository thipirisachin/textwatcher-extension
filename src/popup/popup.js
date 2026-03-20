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
import { qs, truncate, escapeHtml, onStorageChange, debounce } from '../shared/utils.js';
import { startTour, maybeAutoStartTour } from './tour.js';


// ─── DOM References ───────────────────────────────────────────────────────────
const masterToggle        = qs('#masterToggle');
const quickKeyword        = qs('#quickKeyword');
const quickAlertAppear    = qs('#quickAlertAppear');
const quickAlertDisappear = qs('#quickAlertDisappear');
const addKeywordBtn       = qs('#addKeywordBtn');
const keywordError        = qs('#keywordError');
const quickUrl            = qs('#quickUrl');
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
let currentMode = 'row';

// Row selector auto-detected silently on init / mode switch
let detectedRowSelector = null;

// Column names detected from the active page table
let detectedColumns = [];

// ─── Tour Steps ───────────────────────────────────────────────────────────────

const TOUR_STEPS = [
  {
    target: '#tabCtxBar',
    text: 'This tells you if TextWatcher is watching the current page. Green dot = monitored.',
  },
  {
    // Table Mode only — visible only after detection succeeds
    target: '#colFilterWrap',
    text: 'Table Mode: enter partial text from any column. The preview below shows how many rows match — aim for 1.',
  },
  {
    // Text Mode only — skipped when #textModePanel is hidden
    target: '#quickKeywordWrap',
    text: 'Text Mode: type any keyword or phrase to watch for anywhere on the page.',
  },
  {
    // Text Mode only — skipped when #matchHint is hidden
    target: '#matchHint',
    text: 'Use the Aa / ab / .* buttons to match case, exact phrase, or use a regular expression.',
  },
  {
    target: '#alertName',
    text: 'Give it a name — this is what you\'ll see in the notification.',
  },
  {
    target: '#urlBindingBar',
    text: 'Choose which pages this rule applies to, or leave as "All pages".',
  },
  {
    target: '#addKeywordBtn',
    text: 'Hit Save Rule to start watching. You\'ll get a notification when that content appears or disappears.',
  },
  {
    target: '#quickUrl',
    text: 'Add URL rules to tell TextWatcher which pages to monitor. Use * as a wildcard.',
  },
  {
    target: '.url-match-btns',
    text: 'Wild matches with *, Exact needs the full URL, Domain matches the whole site.',
  },
  {
    target: '#addUrlBtn',
    text: 'Add the URL and your rules will activate on matching pages.',
  },
  {
    target: '.footer',
    text: 'Rule History saves snapshots of your setup so you can restore them. Settings opens the full options page to manage all rules, view alert logs, and configure webhooks.',
  },
  {
    target: '.summary-grid',
    text: 'See all your active keywords, URLs, and recent alerts at a glance here.',
  },
];

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  await renderAll();
  bindEvents();
  listenForStorageChanges();
  autoDetectRows(); // silent — no await needed
  await restoreFormState();
  checkPageMonitoredStatus(); // show "not monitored" hint in text mode if needed
  maybeAutoStartTour(TOUR_STEPS);
}

async function renderAll() {
  await Promise.all([
    renderTabContext(),
    renderToggle(),
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
      '<a href="#" id="scrollToUrl" tabindex="0">Add one ↓</a>' +
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

  // Prepend "All pages" pill with a styled dot
  const allPill = document.createElement('span');
  allPill.className = 'url-binding-bar__item url-binding-bar__item--all';
  allPill.id = 'urlBindAll';
  allPill.innerHTML = '<span class="url-binding-bar__dot"></span> All pages';
  allPill.addEventListener('click', () => {
    urlBindingBar.querySelectorAll('input[name="quickUrlScope"]').forEach((cb) => { cb.checked = false; });
    updateAllPagesPill();
  });
  urlBindingBar.prepend(allPill);

  // Wire checkbox change events to update pill state
  urlBindingBar.querySelectorAll('input[name="quickUrlScope"]').forEach((cb) => {
    cb.addEventListener('change', () => updateAllPagesPill());
  });

  // Set allPill active on initial render (nothing checked by default)
  updateAllPagesPill();

  qs('#moreUrlsLink')?.addEventListener('click', (e) => {
    e.preventDefault();
    openOptionsAt('urls');
  });
}

function updateAllPagesPill() {
  const allPill = qs('#urlBindAll');
  if (!allPill) return;
  const anyChecked = Array.from(
    urlBindingBar.querySelectorAll('input[name="quickUrlScope"]')
  ).some((cb) => cb.checked);
  allPill.classList.toggle('active', !anyChecked);
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
    tabCtxText.textContent = `Watching this page · ${activeKw} active keyword${activeKw !== 1 ? 's' : ''}`;
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
}

// ─── Counts ───────────────────────────────────────────────────────────────────

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

  const textPanel = qs('#textModePanel');
  const rowPanel  = qs('#rowModePanel');

  if (isRow) {
    textPanel.style.display = 'none';
    rowPanel.style.display  = '';
    rowPanel.classList.remove('mode-panel--entering');
    void rowPanel.offsetWidth; // force reflow
    rowPanel.classList.add('mode-panel--entering');
  } else {
    rowPanel.style.display  = 'none';
    textPanel.style.display = '';
    textPanel.classList.remove('mode-panel--entering');
    void textPanel.offsetWidth;
    textPanel.classList.add('mode-panel--entering');
  }

  addKeywordBtn.textContent = 'Save Rule';

  // Reset row state when switching away from row mode
  if (!isRow) {
    detectedRowSelector = null;
    detectedColumns = [];
    const alertNameEl = qs('#alertName');
    if (alertNameEl) alertNameEl.placeholder = 'Notification title (optional)';
  } else {
    autoDetectRows(); // re-detect when switching to row mode
    updateAlertNamePlaceholder();
  }

  // Hide previews when switching modes; clear any stale error from the other mode
  hideError(keywordError);
  const preview = qs('#matchPreview');
  const samples = qs('#matchSamples');
  if (preview) preview.style.display = 'none';
  if (samples) samples.innerHTML = '';
  const txtPreview = qs('#textMatchPreview');
  const txtSamples = qs('#textMatchSamples');
  if (txtPreview) txtPreview.style.display = 'none';
  if (txtSamples) txtSamples.innerHTML = '';
  // Trigger text preview immediately if switching to text mode with content
  if (!isRow) {
    debouncedPreview();
    checkPageMonitoredStatus();
  }
}

// ─── Silent Row Auto-Detection ───────────────────────────────────────────────
// Called on popup open and whenever switching to row mode.
// Updates detectedRowSelector quietly; triggers preview if columns have values.

async function autoDetectRows() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  const colFilterWrap = qs('#colFilterWrap');
  const addColBtn     = qs('#addColBtn');
  const colFilterList = qs('#colFilterList');

  // Check URL rules locally first — the content script may still be injected
  // even after a URL rule is removed, so we can't rely on message failure alone.
  const tabUrl = tab.url ?? '';
  if (tabUrl && !/^(chrome|about|edge|moz-extension|chrome-extension):/.test(tabUrl)) {
    const urls     = await getUrls();
    const monitored = urls.filter((u) => u.enabled).some((u) => matchesUrl(tabUrl, u.pattern, u.matchType));
    if (!monitored) {
      if (colFilterWrap) {
        colFilterWrap.dataset.detectState = 'no-rule';
        showColFilterOverlay(colFilterWrap, "This page isn't monitored — add a URL rule first");
      }
      if (addColBtn) addColBtn.disabled = true;
      if (colFilterList) colFilterList.innerHTML = '';
      return;
    }
  }

  // Set detecting state
  if (colFilterWrap) colFilterWrap.dataset.detectState = 'detecting';
  if (addColBtn) addColBtn.disabled = true;
  if (colFilterList) colFilterList.innerHTML = '';

  const res = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { type: MSG.DETECT_ROWS },
      (r) => resolve(chrome.runtime.lastError ? null : r));
  });

  if (res === null) {
    // No rule — page isn't monitored
    if (colFilterWrap) {
      colFilterWrap.dataset.detectState = 'no-rule';
      showColFilterOverlay(colFilterWrap, "This page isn't monitored — add a URL rule first");
    }
    return;
  }

  if (res?.error) {
    // No table found on this page
    if (colFilterWrap) {
      colFilterWrap.dataset.detectState = 'no-table';
      showColFilterOverlay(colFilterWrap, 'No table found on this page');
    }
    return;
  }

  if (res?.selector) {
    detectedRowSelector = res.selector;
    detectedColumns = res.columns || [];
    renderColFilters(detectedColumns);
    if (colFilterWrap) colFilterWrap.dataset.detectState = 'ok';
    if (addColBtn) addColBtn.disabled = false;

    // Re-apply any saved column filter values (by column name)
    const { [FORM_STATE_KEY]: saved } = await chrome.storage.session.get(FORM_STATE_KEY);
    if (saved?.colFilters?.length) {
      const list = qs('#colFilterList');
      saved.colFilters.forEach(({ col, value }) => {
        if (!value) return;
        const input = list?.querySelector(`.col-filter-input[data-col="${CSS.escape(col)}"]`);
        if (input) {
          input.value = value;
          input.closest('.col-filter-cell')?.classList.add('has-value');
        }
      });
      updateAlertNamePlaceholder();
    }

    debouncedPreview();
  }
}

function showColFilterOverlay(wrap, msg) {
  const msgEl = wrap.querySelector('#colDetectMsg');
  if (msgEl) msgEl.textContent = msg;
}

// Manage the "not monitored" overlay on the text mode keyword input.
// Mirrors how col-detect-overlay works for table mode: blocks the input
// with an overlay when the page has no matching URL rule.
async function checkPageMonitoredStatus() {
  const textInputWrap = qs('#textInputWrap');
  if (!textInputWrap || currentMode !== 'text') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabUrl = tab?.url ?? '';
  if (!tabUrl || /^(chrome|about|edge|moz-extension|chrome-extension):/.test(tabUrl)) {
    textInputWrap.dataset.detectState = 'ok';
    return;
  }
  const urls = await getUrls();
  const monitored = urls.filter((u) => u.enabled).some((u) => matchesUrl(tabUrl, u.pattern, u.matchType));
  if (!monitored) {
    textInputWrap.dataset.detectState = 'no-rule';
    const msgEl = qs('#textDetectMsg');
    if (msgEl) msgEl.textContent = "This page isn't monitored — add a URL rule first";
    qs('#quickKeyword')?.blur();
  } else {
    textInputWrap.dataset.detectState = 'ok';
  }
}

// ─── Column Filter Rendering ─────────────────────────────────────────────────

function renderColFilters(columns) {
  const list = qs('#colFilterList');
  if (!list) return;
  list.innerHTML = '';
  const initial = columns.length > 0 ? columns.slice(0, 3) : ['Column 1', 'Column 2', 'Column 3'];
  initial.forEach((col) => appendColFilter(col));
  updateAddColBtn();
  updateAlertNamePlaceholder();
}

function appendColFilter(colName, insertBefore = null) {
  const list = qs('#colFilterList');
  const cell = document.createElement('div');
  cell.className = 'col-filter-cell';
  cell.innerHTML = `
    <input type="text" class="input col-filter-input" placeholder="${escapeHtml(colName)}" maxlength="200" data-col="${escapeHtml(colName)}" />
    <button class="col-filter-cell-remove" type="button" aria-label="Remove column" title="Remove column">×</button>`;

  const input  = cell.querySelector('.col-filter-input');
  const removeBtn = cell.querySelector('.col-filter-cell-remove');

  input.addEventListener('input', () => {
    cell.classList.toggle('has-value', input.value.length > 0);
    debouncedPreview();
    updateAlertNamePlaceholder();
    debouncedSaveFormState();
  });

  removeBtn.addEventListener('click', () => {
    const rows = list.querySelectorAll('.col-filter-cell');
    if (rows.length <= 1) return; // keep minimum 1
    cell.remove();
    updateAddColBtn();
    debouncedPreview();
    updateAlertNamePlaceholder();
  });

  list.insertBefore(cell, insertBefore ?? null);
  // Trigger entry animation
  requestAnimationFrame(() => cell.classList.add('col-filter-cell--entering'));
}

function updateAddColBtn() {
  const btn = qs('#addColBtn');
  if (!btn) return;
  const current = qs('#colFilterList')?.querySelectorAll('.col-filter-cell').length ?? 0;
  const max = detectedColumns.length || 3;
  btn.disabled = current >= max;
}

// ─── Live Row Match Preview ───────────────────────────────────────────────────

function getMatchType() {
  const caseOn  = qs('#modCaseBtn')?.classList.contains('active')  ?? false;
  const exactOn = qs('#modExactBtn')?.classList.contains('active') ?? false;
  const regexOn = qs('#modRegexBtn')?.classList.contains('active') ?? false;

  if (regexOn)             return MATCH_TYPE.REGEX;
  if (exactOn && caseOn)   return MATCH_TYPE.EXACT_CASE;
  if (exactOn)             return MATCH_TYPE.EXACT_NOCASE;
  if (caseOn)              return MATCH_TYPE.CONTAINS_CASE;
  return MATCH_TYPE.CONTAINS;
}

function getUrlMatchType() {
  return qs('.url-match-btns .modifier-btn.active')?.dataset.match ?? 'wildcard';
}

function setUrlMatchType(type) {
  qs('.url-match-btns')?.querySelectorAll('.modifier-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.match === type);
  });
}

function getRowPattern() {
  const parts = Array.from(
    document.querySelectorAll('#colFilterList .col-filter-input')
  ).map((el) => el.value.trim()).filter(Boolean);
  return parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
}

const debouncedPreview = debounce(async () => {
  const preview   = qs('#matchPreview');
  const samplesEl = qs('#matchSamples');

  // ── Text mode preview ────────────────────────────────────────────
  if (currentMode === 'text') {
    const txtPreview = qs('#textMatchPreview');
    const txtSamples = qs('#textMatchSamples');
    if (!txtPreview) return;

    const keyword  = qs('#quickKeyword')?.value.trim() ?? '';
    const matchType = getMatchType();

    if (!keyword) {
      txtPreview.style.display = 'none';
      if (txtSamples) txtSamples.innerHTML = '';
      return;
    }

    if (matchType === MATCH_TYPE.REGEX) {
      try { new RegExp(keyword); } catch (_) {
        txtPreview.style.display = '';
        txtPreview.className     = 'match-preview none';
        txtPreview.textContent   = '⚠ Invalid regular expression';
        if (txtSamples) txtSamples.innerHTML = '';
        return;
      }
    }

    txtPreview.style.display = '';
    txtPreview.className     = 'match-preview off';
    txtPreview.textContent   = 'Checking…';
    if (txtSamples) txtSamples.innerHTML = '';

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('no tab');

      const response = await new Promise((resolve) => {
        chrome.tabs.sendMessage(
          tab.id,
          { type: MSG.PREVIEW_MATCH, pattern: keyword, matchType },
          (res) => resolve(chrome.runtime.lastError ? null : res)
        );
      });

      if (!response) {
        txtPreview.className   = 'match-preview off';
        txtPreview.textContent = 'Not monitoring this page — add a URL rule first';
      } else if (response.found) {
        const count = response.matchCount ?? 1;
        txtPreview.className   = 'match-preview ok';
        txtPreview.textContent = `✓ Found ${count} match${count !== 1 ? 'es' : ''} on this page`;
        if (txtSamples && response.snippet) {
          txtSamples.innerHTML =
            '<span style="font-size:10px;color:var(--text-3);display:block;margin-top:4px;">Found near:</span>' +
            `<code>${escapeHtml(response.snippet)}</code>`;
        }
      } else {
        txtPreview.className   = 'match-preview none';
        txtPreview.textContent = 'No match on this page';
      }
    } catch (_) {
      txtPreview.style.display = 'none';
    }
    return;
  }

  // ── Row mode preview (original) ──────────────────────────────────
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
      preview.textContent = '1 unique match — rule will fire for this row only';
    } else if (response.count > 1) {
      preview.className   = 'match-preview warn';
      preview.textContent = `⚠ ${response.count} rows match — add more column values to narrow it down`;
    } else {
      preview.className   = 'match-preview none';
      preview.textContent = `No rows match (${response.total} row${response.total !== 1 ? 's' : ''} checked)`;
    }

    if (samplesEl && response.samples?.length) {
      samplesEl.innerHTML =
        '<span style="font-size:10px;color:var(--text-3);display:block;margin-top:4px;">Matched rows:</span>' +
        response.samples.map((s) => `<code>${escapeHtml(s)}…</code>`).join('');
    } else if (samplesEl && response.firstRowSample) {
      samplesEl.innerHTML =
        `<span style="font-size:10px;color:var(--text-3);display:block;margin-top:4px;">First row looks like:</span>` +
        `<code>${escapeHtml(response.firstRowSample)}…</code>`;
    } else if (samplesEl) {
      samplesEl.innerHTML = '';
    }
  } catch (_) {
    preview.style.display = 'none';
  }
}, 350);

// ─── Alert Name Placeholder ───────────────────────────────────────────────────

function updateAlertNamePlaceholder() {
  const el = qs('#alertName');
  if (!el || currentMode !== 'row') return;
  const parts = Array.from(
    document.querySelectorAll('#colFilterList .col-filter-input')
  ).map((inp) => inp.value.trim()).filter(Boolean);
  el.placeholder = parts.length > 0
    ? `Row: ${parts.join(' / ')}`
    : 'Notification title (optional)';
}

function buildAutoLabel() {
  if (currentMode !== 'row') return '';
  const parts = Array.from(
    document.querySelectorAll('#colFilterList .col-filter-input')
  ).map((inp) => inp.value.trim()).filter(Boolean);
  return parts.length > 0 ? `Row: ${parts.join(' / ')}` : '';
}

// ─── Match Hint ───────────────────────────────────────────────────────────────

function updateMatchHint() {
  const hint = qs('#matchHint');
  if (!hint) return;
  const caseOn  = qs('#modCaseBtn')?.classList.contains('active')  ?? false;
  const exactOn = qs('#modExactBtn')?.classList.contains('active') ?? false;
  const regexOn = qs('#modRegexBtn')?.classList.contains('active') ?? false;
  if (regexOn)                   hint.textContent = 'Regular expression';
  else if (exactOn && caseOn)    hint.textContent = 'Exact phrase, case-sensitive';
  else if (exactOn)              hint.textContent = 'Exact phrase match';
  else if (caseOn)               hint.textContent = 'Case-sensitive match';
  else                           hint.textContent = 'Matches text anywhere on the page, any case';
}

// ─── URL Match Hint ───────────────────────────────────────────────────────────

function updateUrlMatchHint() {
  const hint = qs('#urlMatchHint');
  if (!hint) return;
  const type = getUrlMatchType();
  if (type === 'exact')       hint.textContent = 'Full URL must match exactly — e.g. https://example.com/page';
  else if (type === 'domain') hint.textContent = 'Domain only — e.g. example.com';
  else                        hint.textContent = 'Use * as wildcard — e.g. https://example.com/*';
}

function updateUrlInputPlaceholder() {
  const input = qs('#quickUrl');
  if (!input) return;
  const type = getUrlMatchType();
  if (type === 'exact')       input.placeholder = 'https://example.com/page';
  else if (type === 'domain') input.placeholder = 'example.com';
  else                        input.placeholder = 'https://example.com/*';
}

// ─── Add Keyword / Rule Handler ───────────────────────────────────────────────

async function handleAddKeyword() {
  hideError(keywordError);

  let text, matchType, rowSelector = '';

  if (currentMode === 'row') {
    // Row mode: pattern built from column filter inputs, match type always Regex
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
    matchType = getMatchType();

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

  let alertName;
  if (currentMode === 'row') {
    alertName = qs('#alertName')?.value.trim() || buildAutoLabel() || text;
  } else {
    alertName = qs('#alertName')?.value.trim() || text;
  }

  const added = await addKeyword({
    text,
    matchType,
    label:          alertName,
    scopeSelector:  '',
    rowSelector,
    urlScope:       readUrlBinding(),
    enabled:        true,
    alertAppear:    quickAlertAppear.checked,
    alertDisappear: quickAlertDisappear.checked,
  });

  if (!added) {
    showToast('A rule with this pattern already exists.');
    return;
  }

  // Reset form
  if (currentMode === 'row') {
    document.querySelectorAll('#colFilterList .col-filter-input').forEach((el) => {
      el.value = '';
    });
    detectedRowSelector = null;
    autoDetectRows();
  } else {
    quickKeyword.value = '';
  }
  const alertNameEl = qs('#alertName');
  if (alertNameEl) alertNameEl.value = '';

  // Clear all preview / sample elements regardless of mode
  const preview = qs('#matchPreview');
  const samples = qs('#matchSamples');
  if (preview) preview.style.display = 'none';
  if (samples) samples.innerHTML = '';
  const txtPreview = qs('#textMatchPreview');
  const txtSamples = qs('#textMatchSamples');
  if (txtPreview) txtPreview.style.display = 'none';
  if (txtSamples) txtSamples.innerHTML = '';

  urlBindingBar?.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = false; });

  const urls = await getUrls();
  const boundCount = readUrlBinding() === URL_SCOPE_ALL
    ? urls.filter((u) => u.enabled).length
    : (Array.isArray(readUrlBinding()) ? readUrlBinding().length : 0);
  const pageNote = boundCount > 0
    ? `watching on ${boundCount} page${boundCount !== 1 ? 's' : ''}`
    : 'watching on all pages';

  showToast(`Rule saved — ${pageNote}`);
  clearFormState();
  await renderCounts();
}

// ─── Add URL Handler ──────────────────────────────────────────────────────────

async function handleAddUrl() {
  const pattern   = quickUrl.value.trim();
  const matchType = getUrlMatchType();
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

  const added = await addUrl({ pattern, matchType, label: label || pattern, enabled: true });

  if (!added) {
    showToast('This URL pattern already exists.');
    return;
  }

  quickUrl.value      = '';
  quickUrlLabel.value = '';
  showToast('URL added');
  await renderCounts();
  await renderUrlBindingBar();

  // Re-check monitored status in text mode — overlay should clear after URL is added
  if (currentMode === 'text') checkPageMonitoredStatus();

  // If the column filter area was showing the "not monitored" overlay,
  // re-run detection now that a URL rule exists. The service worker needs
  // a moment to inject the content script via storage.onChanged, so we
  // set the overlay to "detecting" immediately and retry after 400 ms.
  const colFilterWrap = qs('#colFilterWrap');
  if (colFilterWrap?.dataset.detectState === 'no-rule') {
    colFilterWrap.dataset.detectState = 'detecting';
    const msgEl = colFilterWrap.querySelector('#colDetectMsg');
    if (msgEl) msgEl.textContent = 'Detecting…';
    setTimeout(async () => {
      await autoDetectRows();
      // If still no content script after injection window, the added URL
      // may not match this tab — show a clearer message than "add a URL rule".
      if (colFilterWrap.dataset.detectState === 'no-rule') {
        showColFilterOverlay(colFilterWrap, "URL added — reload this tab to start monitoring");
      }
    }, 400);
  }
}

// ─── Event Bindings ───────────────────────────────────────────────────────────

function bindEvents() {
  updateMatchHint();
  updateUrlMatchHint();
  updateUrlInputPlaceholder();
  // Clear (×) buttons on all .input-wrap inputs
  document.querySelectorAll('.input-wrap').forEach((wrap) => {
    const input = wrap.querySelector('input');
    const btn   = wrap.querySelector('.input-clear');
    if (!input || !btn) return;
    const sync = () => wrap.classList.toggle('has-value', input.value.length > 0);
    input.addEventListener('input', () => { sync(); debouncedSaveFormState(); });
    btn.addEventListener('click', () => { input.value = ''; sync(); input.focus(); debouncedSaveFormState(); });
    sync();
  });

  // Master toggle
  masterToggle.addEventListener('change', async () => {
    await setEnabled(masterToggle.checked);
  });

  // Mode tabs
  qs('#modeTextBtn').addEventListener('click', () => { setMode('text'); debouncedSaveFormState(); });
  qs('#modeRowBtn').addEventListener('click',  () => { setMode('row');  debouncedSaveFormState(); });

  // Add keyword / rule
  addKeywordBtn.addEventListener('click', handleAddKeyword);
  quickKeyword?.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleAddKeyword(); });
  quickKeyword?.addEventListener('input',   () => { debouncedPreview(); debouncedSaveFormState(); });

  // #addColBtn click: append next unused column
  qs('#addColBtn')?.addEventListener('click', () => {
    const list = qs('#colFilterList');
    if (!list) return;
    const shownCols = Array.from(list.querySelectorAll('.col-filter-input')).map((el) => el.dataset.col);
    // Find the lowest-index missing column to preserve original order
    const nextCol = detectedColumns.find((c) => !shownCols.includes(c))
      ?? `Column ${shownCols.length + 1}`;
    const nextIdx = detectedColumns.indexOf(nextCol);
    // Insert before the first shown cell whose column has a higher index
    const cells = Array.from(list.querySelectorAll('.col-filter-cell'));
    const insertBefore = cells.find((cell) => {
      const col = cell.querySelector('.col-filter-input')?.dataset.col;
      return detectedColumns.indexOf(col) > nextIdx;
    }) ?? null;
    appendColFilter(nextCol, insertBefore);
    updateAddColBtn();
  });
  // Match modifier buttons (text mode): Aa / ab / .*
  // .* is exclusive (regex overrides); Aa and ab are independent toggles.
  qs('.modifier-btns')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.modifier-btn');
    if (!btn) return;
    const mod = btn.dataset.mod;
    if (mod === 'regex') {
      const nowActive = !btn.classList.contains('active');
      btn.classList.toggle('active', nowActive);
      // When regex turns on, deactivate exact (case stays — it's informational for regex too)
      if (nowActive) qs('#modExactBtn')?.classList.remove('active');
    } else {
      btn.classList.toggle('active');
      // When exact or case turns on, deactivate regex
      qs('#modRegexBtn')?.classList.remove('active');
    }
    updateMatchHint();
    debouncedPreview();
    debouncedSaveFormState();
  });

  // URL match type buttons (radio behaviour — one active at a time)
  qs('.url-match-btns')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.modifier-btn');
    if (!btn) return;
    setUrlMatchType(btn.dataset.match);
    updateUrlMatchHint();
    updateUrlInputPlaceholder();
    debouncedSaveFormState();
  });

  // Add URL
  addUrlBtn.addEventListener('click', handleAddUrl);
  quickUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleAddUrl(); });

  // Fill URL from current tab — exact match of the full page URL
  useCurrentUrlBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && !tab.url.startsWith('chrome') && !tab.url.startsWith('about')) {
      quickUrl.value      = tab.url;
      quickUrlLabel.value = tab.title || '';
      setUrlMatchType('exact');
      updateUrlMatchHint();
      updateUrlInputPlaceholder();
      quickUrl.closest('.input-wrap')?.classList.add('has-value');
      debouncedSaveFormState();
    }
  });

  // Tab context bar — "+ Add URL" shortcut — exact match of the full page URL
  tabCtxAddBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && !tab.url.startsWith('chrome') && !tab.url.startsWith('about')) {
      quickUrl.value      = tab.url;
      quickUrlLabel.value = tab.title || '';
      setUrlMatchType('exact');
      updateUrlMatchHint();
      updateUrlInputPlaceholder();
      quickUrl.closest('.input-wrap')?.classList.add('has-value');
      quickUrl.focus();
      quickUrl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      debouncedSaveFormState();
    }
  });

  // Summary card navigation
  qs('#cardKeywords').addEventListener('click', () => openOptionsAt('keywords'));
  qs('#cardUrls').addEventListener('click',     () => openOptionsAt('urls'));
  qs('#cardAlerts').addEventListener('click',   () => openOptionsAt('activity'));

  // Footer nav buttons
  qs('#navSetups').addEventListener('click', () => openOptionsAt('history'));
  openOptionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());

  // Alert checkboxes — save state on change
  qs('#quickAlertAppear')?.addEventListener('change',    debouncedSaveFormState);
  qs('#quickAlertDisappear')?.addEventListener('change', debouncedSaveFormState);

  // Tour button
  qs('#tourBtn')?.addEventListener('click', () => startTour(TOUR_STEPS));
}

// ─── Storage Change Listener ──────────────────────────────────────────────────

function listenForStorageChanges() {
  onStorageChange(
    [STORAGE_KEY.KEYWORDS, STORAGE_KEY.URLS, STORAGE_KEY.HISTORY,
     STORAGE_KEY.ALERT_HISTORY, STORAGE_KEY.ENABLED],
    async () => {
      await renderAll();
      // Re-check monitored status in text mode when keyword is empty
      if (currentMode === 'text' && !qs('#quickKeyword')?.value.trim()) {
        await checkPageMonitoredStatus();
      }
      // Re-check in row mode — URL removal should re-show the overlay
      if (currentMode === 'row') autoDetectRows();
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

// ─── Form State Persistence ───────────────────────────────────────────────────
// Saves all in-progress form data to session storage so navigating to the
// options page and back doesn't wipe the user's work.

const FORM_STATE_KEY = 'tw_popup_form';

const debouncedSaveFormState = debounce(saveFormState, 400);

async function saveFormState() {
  const colFilters = Array.from(
    document.querySelectorAll('#colFilterList .col-filter-input')
  ).map((el) => ({ col: el.dataset.col, value: el.value }));

  const state = {
    mode:           currentMode,
    keyword:        quickKeyword?.value ?? '',
    modCase:        qs('#modCaseBtn')?.classList.contains('active')  ?? false,
    modExact:       qs('#modExactBtn')?.classList.contains('active') ?? false,
    modRegex:       qs('#modRegexBtn')?.classList.contains('active') ?? false,
    colFilters,
    alertName:      qs('#alertName')?.value ?? '',
    alertAppear:    qs('#quickAlertAppear')?.checked ?? true,
    alertDisappear: qs('#quickAlertDisappear')?.checked ?? true,
    urlMatchType:   getUrlMatchType(),
    quickUrl:       quickUrl?.value ?? '',
    quickUrlLabel:  quickUrlLabel?.value ?? '',
  };

  await chrome.storage.session.set({ [FORM_STATE_KEY]: state });
}

async function restoreFormState() {
  const { [FORM_STATE_KEY]: state } = await chrome.storage.session.get(FORM_STATE_KEY);
  if (!state) return;

  // Mode
  if (state.mode && state.mode !== currentMode) setMode(state.mode);

  // Text mode keyword + modifiers
  if (quickKeyword && state.keyword) {
    quickKeyword.value = state.keyword;
    quickKeyword.closest('.input-wrap')?.classList.toggle('has-value', true);
  }
  if (state.modCase)  qs('#modCaseBtn')?.classList.add('active');
  if (state.modExact) qs('#modExactBtn')?.classList.add('active');
  if (state.modRegex) qs('#modRegexBtn')?.classList.add('active');
  updateMatchHint();

  // Row mode column filters — values are re-applied by autoDetectRows() after
  // renderColFilters() runs. Nothing to do here for the detection-success path.
  // If detection fails (no-table / no-rule), the col filter area is grayed out
  // and there's no list to restore into, so we skip this entirely.

  // Shared fields
  const alertNameEl = qs('#alertName');
  if (alertNameEl && state.alertName) alertNameEl.value = state.alertName;
  if (state.alertAppear    !== undefined && qs('#quickAlertAppear'))    qs('#quickAlertAppear').checked    = state.alertAppear;
  if (state.alertDisappear !== undefined && qs('#quickAlertDisappear')) qs('#quickAlertDisappear').checked = state.alertDisappear;

  // Quick Add URL
  if (state.urlMatchType) { setUrlMatchType(state.urlMatchType); updateUrlMatchHint(); }
  if (quickUrl && state.quickUrl) {
    quickUrl.value = state.quickUrl;
    quickUrl.closest('.input-wrap')?.classList.toggle('has-value', true);
  }
  if (quickUrlLabel && state.quickUrlLabel) {
    quickUrlLabel.value = state.quickUrlLabel;
    quickUrlLabel.closest('.input-wrap')?.classList.toggle('has-value', true);
  }

  updateAlertNamePlaceholder();
}

async function clearFormState() {
  await chrome.storage.session.remove(FORM_STATE_KEY);
}

let toastTimer = null;
function showToast(msg) {
  const toast = qs('#popupToast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2500);
}

// ─── Start ────────────────────────────────────────────────────────────────────
init();
