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
import { qs, truncate, escapeHtml, onStorageChange, debounce, isRestrictedUrl } from '../shared/utils.js';
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
const monitorWrap  = qs('#monitorWrap');

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

// Full cell values for all detected rows — used to power hierarchical dropdowns
let tableRows = [];

// ─── Tour Steps ───────────────────────────────────────────────────────────────

const TOUR_STEPS = [
  {
    target: '#tabCtxBar',
    text: 'This tells you if TextWatcher is watching the current page. Green dot = monitored.',
  },
  {
    // Table Mode only — visible only after detection succeeds
    target: '#colFilterWrap',
    text: 'Table Mode: enter partial text from any column. The preview below shows how many rows match - aim for 1.',
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
    text: 'Give it a name - this is what you\'ll see in the notification.',
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
    text: 'Settings: manage all rules, alerts, and webhooks.',
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
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabUrl = tab?.url ?? '';

  const urlSectionDisabled = isRestrictedUrl(tabUrl);
  [quickUrl, quickUrlLabel, addUrlBtn, useCurrentUrlBtn].forEach(el => {
    if (el) el.disabled = urlSectionDisabled;
  });
  document.querySelectorAll('.url-match-btns .modifier-btn').forEach(btn => {
    btn.disabled = urlSectionDisabled;
  });
  if (urlSectionDisabled) {
    urlBindingBar.innerHTML = '';
    return;
  }

  const urls = await getUrls();
  const active = urls.filter((u) => u.enabled);
  if (active.length === 0) {
    urlBindingBar.innerHTML =
      '<p class="url-binding-bar__warn">' +
      '⚠ No URL rules - won\'t monitor any page. ' +
      '<a href="#" id="scrollToUrl" tabindex="0">Add one</a>' +
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
      <span title="${escapeHtml(u.label ? u.pattern : '')}">${escapeHtml(label)}</span>
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

  // Pre-check the URL rule(s) that match the current tab — default to current page, not all pages
  const matchingIds = active.filter((u) => matchesUrl(tabUrl, u.pattern, u.matchType)).map((u) => u.id);
  if (matchingIds.length > 0) {
    urlBindingBar.querySelectorAll('input[name="quickUrlScope"]').forEach((cb) => {
      if (matchingIds.includes(cb.value)) cb.checked = true;
    });
  }
  updateAllPagesPill();

  qs('#moreUrlsLink')?.addEventListener('click', (e) => {
    e.preventDefault();
    openOptionsAt('rules');
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

  if (isRestrictedUrl(tabUrl)) {
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
    const csResp     = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: MSG.GET_MATCH_COUNT },
        (r) => resolve(chrome.runtime.lastError ? null : r));
    });
    const matchCount  = csResp?.count ?? 0;
    const matchLabel  = matchCount > 0 ? `${matchCount} matching now` : 'none matching yet';
    tabCtxBar.className    = 'tab-ctx-bar tab-ctx-bar--watched';
    tabCtxDot.className    = 'tab-ctx-bar__dot';
    tabCtxText.textContent = `Watching this page · ${activeKw} active · ${matchLabel}`;
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

  const addColBtn     = qs('#addColBtn');
  const colFilterList = qs('#colFilterList');

  // Check URL rules locally first — the content script may still be injected
  // even after a URL rule is removed, so we can't rely on message failure alone.
  const tabUrl = tab.url ?? '';
  const isRestricted = isRestrictedUrl(tabUrl);

  if (isRestricted) {
    if (monitorWrap) { monitorWrap.dataset.detectState = 'no-table'; showDetectOverlay("This page can't be monitored"); }
    if (addColBtn) addColBtn.disabled = true;
    if (colFilterList) colFilterList.innerHTML = '';
    return;
  }

  if (tabUrl) {
    const urls     = await getUrls();
    const monitored = urls.filter((u) => u.enabled).some((u) => matchesUrl(tabUrl, u.pattern, u.matchType));
    if (!monitored) {
      if (monitorWrap) { monitorWrap.dataset.detectState = 'no-rule'; showDetectOverlay("This page isn't monitored - add a URL rule first"); }
      if (addColBtn) addColBtn.disabled = true;
      if (colFilterList) colFilterList.innerHTML = '';
      return;
    }
  }

  // Set detecting state
  if (monitorWrap) monitorWrap.dataset.detectState = 'detecting';
  if (addColBtn) addColBtn.disabled = true;
  if (colFilterList) colFilterList.innerHTML = '';

  const res = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { type: MSG.DETECT_ROWS },
      (r) => resolve(chrome.runtime.lastError ? null : r));
  });

  if (res === null) {
    if (monitorWrap) { monitorWrap.dataset.detectState = 'no-rule'; showDetectOverlay("This page isn't monitored - add a URL rule first"); }
    return;
  }

  if (res?.error) {
    if (monitorWrap) { monitorWrap.dataset.detectState = 'no-table'; showDetectOverlay('No table found on this page'); }
    return;
  }

  if (res?.selector) {
    detectedRowSelector = res.selector;
    detectedColumns = res.columns || [];
    tableRows       = res.rows    || [];
    renderColFilters(detectedColumns);
    if (monitorWrap) monitorWrap.dataset.detectState = 'ok';
    if (addColBtn) addColBtn.hidden = false;

    // Re-apply saved column filter values, then recalculate all dropdowns at once
    const { [FORM_STATE_KEY]: saved } = await chrome.storage.session.get(FORM_STATE_KEY);
    if (saved?.colFilters?.length) {
      for (const { col, value, matchMode } of saved.colFilters) {
        if (!value) continue;
        const picker = qs(`.col-filter-picker[data-col="${CSS.escape(col)}"]`);
        if (picker) {
          _cfSetValue(picker, value);
          if (matchMode && matchMode !== 'exact') {
            picker.dataset.matchMode = matchMode;
            const btn = picker.querySelector('.col-filter-mode-btn');
            if (btn) _cfUpdateModeBtn(btn, matchMode);
          }
        }
      }
      handleColumnSelect();
      updateAlertNamePlaceholder();
    }

    debouncedPreview();
  }
}

function showDetectOverlay(msg) {
  const msgEl = qs('#detectMsg');
  if (msgEl) msgEl.textContent = msg;
}

// Manage the "not monitored" overlay on the text mode keyword input.
// Mirrors how col-detect-overlay works for table mode: blocks the input
// with an overlay when the page has no matching URL rule.
async function checkPageMonitoredStatus() {
  if (currentMode !== 'text') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabUrl = tab?.url ?? '';
  if (isRestrictedUrl(tabUrl)) {
    monitorWrap.dataset.detectState = 'no-rule';
    showDetectOverlay("This page can't be monitored");
    return;
  }
  const urls = await getUrls();
  const monitored = urls.filter((u) => u.enabled).some((u) => matchesUrl(tabUrl, u.pattern, u.matchType));
  if (!monitored) {
    monitorWrap.dataset.detectState = 'no-rule';
    showDetectOverlay("This page isn't monitored - add a URL rule first");
    qs('#quickKeyword')?.blur();
  } else {
    monitorWrap.dataset.detectState = 'ok';
  }
}

// ─── Column Filter — Combobox with portal dropdown ───────────────────────────

// Single dropdown portal appended to body — escapes all overflow:hidden ancestors
const _cfPortal = document.createElement('div');
_cfPortal.className = 'col-filter-dropdown';
document.body.appendChild(_cfPortal);
let _cfActivePicker = null;

function _cfOpen(picker) {
  _cfActivePicker = picker;
  const input = picker.querySelector('.col-filter-input');
  const rect  = input.getBoundingClientRect();
  _cfPortal.style.left  = rect.left  + 'px';
  _cfPortal.style.top   = rect.bottom + 2 + 'px';
  _cfPortal.style.width = rect.width  + 'px';
  _cfRender(picker, input.value);
  _cfPortal.classList.add('col-filter-dropdown--open');
}

function _cfClose() {
  _cfPortal.classList.remove('col-filter-dropdown--open');
  _cfActivePicker = null;
}

function _cfRender(picker, filterText) {
  const colIndex  = +picker.dataset.colIndex;
  const confirmed = picker.dataset.value;
  const all       = getUniqueValuesForColumn(colIndex);
  const shown     = filterText
    ? all.filter(v => v.toLowerCase().includes(filterText.toLowerCase()))
    : all;

  const clearHtml = (confirmed || filterText)
    ? `<div class="col-filter-option col-filter-option--clear" data-value="">✕ Clear</div>` : '';
  _cfPortal.innerHTML = clearHtml +
    (shown.length
      ? shown.map(v => `<div class="col-filter-option${v === confirmed ? ' col-filter-option--selected' : ''}"
          data-value="${escapeHtml(v)}" title="${escapeHtml(v)}">${escapeHtml(v)}</div>`).join('')
      : `<div class="col-filter-option col-filter-option--empty">No matches</div>`);

  _cfPortal.querySelectorAll('.col-filter-option[data-value]').forEach(opt => {
    opt.addEventListener('mousedown', e => {
      e.preventDefault();
      const val = opt.dataset.value;
      _cfSetValue(_cfActivePicker, val);
      handleColumnSelect();
      debouncedPreview();
      updateAlertNamePlaceholder();
      debouncedSaveFormState();
      if (val === '') {
        // Clear — stay open, show all options immediately
        _cfRender(_cfActivePicker, '');
      } else {
        _cfClose();
      }
    });
  });
}

function _cfSetValue(picker, value) {
  if (!picker) return;
  const input = picker.querySelector('.col-filter-input');
  picker.dataset.value = value;
  if (input) {
    input.value = value;
    input.title = value;
    // place cursor at end so backspace edits char-by-char, not select-all-delete
    if (value) requestAnimationFrame(() => input.setSelectionRange(value.length, value.length));
  }
  picker.closest('.col-filter-cell')?.classList.toggle('has-value', !!value);
}

function getUniqueValuesForColumn(colIndex) {
  const allPickers = Array.from(document.querySelectorAll('.col-filter-picker'));
  const filtered = tableRows.filter(row =>
    allPickers.every(p => {
      const i = +p.dataset.colIndex;
      if (i === colIndex) return true;
      const val = p.dataset.value;
      if (!val) return true;
      return row[i] === val;
    })
  );
  // Fall back to all rows if filters produce nothing (free-typed non-matching text)
  const base = filtered.length > 0 ? filtered : tableRows;
  return [...new Set(base.map(r => r[colIndex]).filter(Boolean))].sort();
}

function _cfUpdateModeBtn(btn, mode) {
  const contains = mode === 'contains';
  btn.textContent = contains ? '~' : '=';
  btn.title       = contains ? 'Contains match - click for exact (=)' : 'Exact match - click for contains (~)';
  btn.setAttribute('aria-label', `Match mode: ${mode}`);
}

function renderColFilters(columns) {
  const list = qs('#colFilterList');
  if (!list) return;
  list.innerHTML = '';
  const cols = columns.length > 0 ? columns : ['Column 1', 'Column 2', 'Column 3'];
  cols.slice(0, 3).forEach((col, i) => appendColFilter(col, i));
  updateAddColBtn();
  updateAlertNamePlaceholder();
}

function appendColFilter(colName, colIndex, insertBefore = null) {
  const list = qs('#colFilterList');
  const cell = document.createElement('div');
  cell.className = 'col-filter-cell';
  cell.innerHTML = `
    <div class="col-filter-picker" data-col="${escapeHtml(colName)}" data-col-index="${colIndex}" data-value="" data-match-mode="exact">
      <input class="input col-filter-input" type="text"
             placeholder="${escapeHtml(colName)}" autocomplete="off" spellcheck="false">
      <button class="col-filter-mode-btn" type="button" title="Exact match - click for contains (~)" aria-label="Match mode: exact">=</button>
    </div>
    <button class="col-filter-cell-remove" type="button" aria-label="Remove column" title="Remove column">×</button>`;

  const picker    = cell.querySelector('.col-filter-picker');
  const input     = cell.querySelector('.col-filter-input');
  const modeBtn   = cell.querySelector('.col-filter-mode-btn');
  const removeBtn = cell.querySelector('.col-filter-cell-remove');

  modeBtn.addEventListener('mousedown', e => {
    e.preventDefault(); // keep input focus
    const next = (picker.dataset.matchMode === 'contains') ? 'exact' : 'contains';
    picker.dataset.matchMode = next;
    _cfUpdateModeBtn(modeBtn, next);
    if (_cfActivePicker === picker) _cfRender(picker, input.value);
    handleColumnSelect();
    debouncedPreview();
    debouncedSaveFormState();
  });

  input.addEventListener('focus', () => _cfOpen(picker));

  // Reopen dropdown when clicking an already-focused input
  input.addEventListener('click', () => _cfOpen(picker));

  input.addEventListener('keydown', e => {
    const isOpen = _cfPortal.classList.contains('col-filter-dropdown--open');
    if (e.key === 'Escape') { _cfClose(); return; }
    if (e.key === 'Tab')    { _cfClose(); return; }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen) { _cfOpen(picker); return; }
      const opts = Array.from(_cfPortal.querySelectorAll('.col-filter-option:not(.col-filter-option--empty)'));
      if (!opts.length) return;
      const cur    = _cfPortal.querySelector('.col-filter-option--focused');
      const curIdx = cur ? opts.indexOf(cur) : -1;
      const next   = e.key === 'ArrowDown'
        ? (curIdx < opts.length - 1 ? curIdx + 1 : 0)
        : (curIdx > 0 ? curIdx - 1 : opts.length - 1);
      opts.forEach(o => o.classList.remove('col-filter-option--focused'));
      opts[next].classList.add('col-filter-option--focused');
      opts[next].scrollIntoView({ block: 'nearest' });
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      const focused = _cfPortal.querySelector('.col-filter-option--focused');
      if (focused && isOpen) {
        const val = focused.dataset.value;
        _cfSetValue(picker, val);
        handleColumnSelect();
        debouncedPreview();
        updateAlertNamePlaceholder();
        debouncedSaveFormState();
        if (val === '') { _cfRender(picker, ''); } else { _cfClose(); }
      }
    }
  });

  input.addEventListener('input', () => {
    picker.dataset.value = input.value.trim();
    picker.closest('.col-filter-cell')?.classList.toggle('has-value', !!input.value.trim());
    if (_cfActivePicker === picker) _cfRender(picker, input.value);
    handleColumnSelect();
    debouncedPreview();
    updateAlertNamePlaceholder();
    debouncedSaveFormState();
  });

  input.addEventListener('blur', () => {
    setTimeout(() => { if (_cfActivePicker === picker) _cfClose(); }, 120);
  });

  removeBtn.addEventListener('click', () => {
    if (list.querySelectorAll('.col-filter-cell').length <= 1) return;
    if (_cfActivePicker === picker) _cfClose();
    cell.remove();
    updateAddColBtn();
    handleColumnSelect();
    debouncedPreview();
    updateAlertNamePlaceholder();
  });

  list.insertBefore(cell, insertBefore);
  requestAnimationFrame(() => cell.classList.add('col-filter-cell--entering'));
}

function handleColumnSelect() {
  Array.from(document.querySelectorAll('.col-filter-picker')).forEach(picker => {
    const colIndex = +picker.dataset.colIndex;
    const unique   = getUniqueValuesForColumn(colIndex);
    // Don't clear the picker the user is actively typing in
    if (picker !== _cfActivePicker && picker.dataset.value && !unique.includes(picker.dataset.value)) {
      _cfSetValue(picker, '');
    }
    if (_cfActivePicker === picker) {
      const input = picker.querySelector('.col-filter-input');
      _cfRender(picker, input?.value ?? '');
    }
  });
}

function updateAddColBtn() {
  const btn = qs('#addColBtn');
  if (!btn) return;
  const shown = qs('#colFilterList')?.querySelectorAll('.col-filter-cell').length ?? 0;
  const max   = detectedColumns.length || 3;
  btn.disabled = shown >= max;
  btn.hidden   = false;
}


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
    document.querySelectorAll('#colFilterList .col-filter-picker')
  ).map((el) => {
    const value = el.dataset.value.trim();
    if (!value) return null;
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return (el.dataset.matchMode === 'contains')
      ? escaped
      : `(?:^|\\s)${escaped}(?=\\s|$)`;
  }).filter(Boolean);
  return parts.join('[\\s\\S]*');
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
        txtPreview.textContent = 'Not monitoring this page - add a URL rule first';
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
      preview.textContent = 'Not monitoring this page - add a URL rule first';
    } else if (response.error) {
      preview.className   = 'match-preview none';
      preview.textContent = `⚠ Invalid selector: ${response.error}`;
    } else if (response.count === 1) {
      preview.className   = 'match-preview ok';
      preview.textContent = '1 unique match - rule will fire for this row only';
    } else if (response.count > 1) {
      preview.className   = 'match-preview warn';
      preview.textContent = `⚠ ${response.count} rows match - add more column values to narrow it down`;
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
    document.querySelectorAll('#colFilterList .col-filter-picker')
  ).map((inp) => inp.dataset.value.trim()).filter(Boolean);
  el.placeholder = parts.length > 0
    ? parts.join(' / ')
    : 'Notification title (optional)';
}

function buildAutoLabel() {
  if (currentMode !== 'row') return '';
  const parts = Array.from(
    document.querySelectorAll('#colFilterList .col-filter-picker')
  ).map((inp) => inp.dataset.value.trim()).filter(Boolean);
  return parts.length > 0 ? parts.join(' / ') : '';
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
  if (type === 'exact')       hint.textContent = 'Full URL must match exactly - e.g. https://example.com/page';
  else if (type === 'domain') hint.textContent = 'Domain only - e.g. example.com';
  else                        hint.textContent = 'Use * as wildcard - e.g. https://example.com/*';
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
      showError(keywordError, 'No table detected on this page - add a URL rule and reload the tab first.');
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
    showToast('A rule with this pattern already exists.', 'error');
    return;
  }

  // Reset form
  if (currentMode === 'row') {
    document.querySelectorAll('#colFilterList .col-filter-picker').forEach(p => _cfSetValue(p, ''));
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

  showToast(`Rule saved - ${pageNote}`);
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
    showToast('This URL pattern already exists.', 'error');
    return;
  }

  quickUrl.value      = '';
  quickUrlLabel.value = '';
  await saveFormState();
  showToast('URL added');
  await renderCounts();
  await renderUrlBindingBar();

  // Re-check monitored status in text mode — overlay should clear after URL is added
  if (currentMode === 'text') checkPageMonitoredStatus();

  // If the column filter area was showing the "not monitored" overlay,
  // re-run detection now that a URL rule exists. The service worker needs
  // a moment to inject the content script via storage.onChanged, so we
  // set the overlay to "detecting" immediately and retry after 400 ms.
  if (monitorWrap?.dataset.detectState === 'no-rule') {
    monitorWrap.dataset.detectState = 'detecting';
    showDetectOverlay('Detecting…');
    setTimeout(async () => {
      await autoDetectRows();
      if (monitorWrap.dataset.detectState === 'no-rule') {
        showDetectOverlay("URL added - reload this tab to start monitoring");
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

  // #addColBtn: append next unshown column in correct index order
  qs('#addColBtn')?.addEventListener('click', () => {
    const list = qs('#colFilterList');
    if (!list) return;
    const shownIndices = new Set(
      Array.from(list.querySelectorAll('.col-filter-picker')).map(s => +s.dataset.colIndex)
    );
    const nextIndex = detectedColumns.findIndex((_, i) => !shownIndices.has(i));
    if (nextIndex === -1) return;
    // Insert before the first shown cell whose column index is higher
    const cells = Array.from(list.querySelectorAll('.col-filter-cell'));
    const insertBefore = cells.find(cell => {
      const i = +cell.querySelector('.col-filter-picker')?.dataset.colIndex;
      return i > nextIndex;
    }) ?? null;
    appendColFilter(detectedColumns[nextIndex], nextIndex, insertBefore);
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
      if (quickUrlLabel.value) quickUrlLabel.closest('.input-wrap')?.classList.add('has-value');
      debouncedSaveFormState();
    }
  });

  // Tab context bar — "+ Add URL" — directly saves the current page as an exact-match URL rule
  tabCtxAddBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || tab.url.startsWith('chrome') || tab.url.startsWith('about')) return;

    const added = await addUrl({ pattern: tab.url, matchType: 'exact', label: tab.title || '', enabled: true });
    if (added) {
      await Promise.all([renderCounts(), renderUrlBindingBar(), renderTabContext()]);
      showToast('URL rule added!');
    } else {
      showToast('URL rule already exists.');
    }
  });

  // Summary card navigation
  qs('#cardKeywords').addEventListener('click', () => openOptionsAt('rules'));
  qs('#cardUrls').addEventListener('click',     () => openOptionsAt('rules'));
  qs('#cardAlerts').addEventListener('click',   () => openOptionsAt('activity'));

  // Footer nav buttons
  openOptionsBtn.addEventListener('click', () => openOptionsAt('settings'));

  // Alert checkboxes — save state on change
  qs('#quickAlertAppear')?.addEventListener('change',    debouncedSaveFormState);
  qs('#quickAlertDisappear')?.addEventListener('change', debouncedSaveFormState);

  // Tour button
  qs('#tourBtn')?.addEventListener('click', () => startTour(TOUR_STEPS));
  qs('#feedbackBtn')?.addEventListener('click', () => chrome.tabs.create({ url: 'https://forms.gle/31Cs4ppZJKaADp65A' }));
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
    document.querySelectorAll('#colFilterList .col-filter-picker')
  ).map((el) => ({ col: el.dataset.col, value: el.dataset.value, matchMode: el.dataset.matchMode || 'exact' }));

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
function showToast(msg, type = 'success') {
  const toast = qs('#popupToast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.remove('hidden', 'toast--success', 'toast--error');
  toast.classList.add(type === 'error' ? 'toast--error' : 'toast--success');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2500);
}

// ─── Start ────────────────────────────────────────────────────────────────────
init();
