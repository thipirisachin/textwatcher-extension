/**
 * options.js
 * Full settings page logic.
 * Sections: Keywords, URLs, Notifications, Badge & Icon, History
 */

import { MATCH_TYPE, URL_MATCH_TYPE, NOTIF_FREQUENCY, STORAGE_KEY } from '../shared/constants.js';
import {
  getEnabled, setEnabled,
  getKeywords, saveKeywords, addKeyword, updateKeyword, removeKeyword,
  getUrls, saveUrls, addUrl, updateUrl, removeUrl,
  getSettings, saveSettings,
  getHistory, saveHistorySnapshot, restoreHistoryEntry, removeHistoryEntry,
  getAlertHistory, clearAlertHistory,
} from '../shared/storage.js';
import { validateRegex, matchesUrl } from '../shared/matcher.js';
import { qs, qsa, timeAgo, truncate, onStorageChange } from '../shared/utils.js';

// ─── SVG Icon Strings ─────────────────────────────────────────────────────────
const SVG_PAUSE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
const SVG_PLAY  = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
const SVG_SCOPE = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';

// ─── Routing ──────────────────────────────────────────────────────────────────

const sections = ['keywords', 'urls', 'notifications', 'activity', 'badge', 'history'];

function showSection(id) {
  sections.forEach((s) => {
    qs(`#section-${s}`)?.classList.toggle('hidden', s !== id);
  });
  qsa('.nav-link').forEach((a) => {
    a.classList.toggle('active', a.dataset.section === id);
  });
}

qsa('.nav-link').forEach((link) => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    showSection(link.dataset.section);
  });
});

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  await Promise.all([
    renderKeywords(),
    renderUrls(),
    renderNotifSettings(),
    renderBadgeSettings(),
    renderHistory(),
    renderAlertHistory(),
    renderSidebarStatus(),
  ]);
  bindKeywordEvents();
  bindUrlEvents();
  bindNotifEvents();
  bindBadgeEvents();
  bindHistoryEvents();
  bindActivityEvents();
  bindGlobalToggle();
  listenForChanges();
}

// ─── Sidebar Status ───────────────────────────────────────────────────────────

async function renderSidebarStatus() {
  const [enabled, keywords, urls] = await Promise.all([
    getEnabled(), getKeywords(), getUrls(),
  ]);
  const dot    = qs('#sidebarDot');
  const text   = qs('#sidebarStatusText');
  const toggle = qs('#globalToggle');
  const activeK = keywords.filter((k) => k.enabled).length;
  const activeU = urls.filter((u) => u.enabled).length;

  if (toggle) toggle.checked = enabled;
  dot.className = `status-dot status-dot--${enabled ? 'active' : 'inactive'}`;
  text.textContent = enabled
    ? `${activeK} keywords, ${activeU} URLs`
    : 'Paused';
}

// ─── Global Toggle ────────────────────────────────────────────────────────────

function bindGlobalToggle() {
  qs('#globalToggle').addEventListener('change', async (e) => {
    await setEnabled(e.target.checked);
    await renderSidebarStatus();
    showToast(e.target.checked ? 'Monitoring enabled' : 'Monitoring paused');
  });
}

// ─── Keywords ─────────────────────────────────────────────────────────────────

async function renderKeywords(filter = '') {
  const keywords = await getKeywords();
  const list  = qs('#kwList');
  const badge = qs('#kwBadge');
  badge.textContent = keywords.filter((k) => k.enabled).length;

  const filtered = filter
    ? keywords.filter((k) => k.text.toLowerCase().includes(filter.toLowerCase()))
    : keywords;

  if (filtered.length === 0) {
    list.innerHTML = `<li class="rule-list__empty">${filter ? 'No matches.' : 'No keywords yet. Add one above.'}</li>`;
    return;
  }

  list.innerHTML = '';
  filtered.forEach((kw) => {
    const li = document.createElement('li');
    li.className = `rule-item${!kw.enabled ? ' rule-item--disabled' : ''}`;
    li.dataset.id = kw.id;

    const matchLabel = MATCH_TYPE_LABEL[kw.matchType] || kw.matchType;

    li.innerHTML = `
      <div class="rule-item__main">
        <div class="rule-item__text">${escapeHtml(kw.text)}</div>
        <div class="rule-item__meta">
          <span class="rule-item__tag rule-item__tag--match">${escapeHtml(matchLabel)}</span>
          ${kw.scopeSelector ? `<span class="rule-item__tag rule-item__tag--scope" title="Scope: ${escapeHtml(kw.scopeSelector)}">${SVG_SCOPE} ${escapeHtml(truncate(kw.scopeSelector, 30))}</span>` : ''}
          ${kw.alertAppear    ? '<span class="rule-item__tag rule-item__tag--appear">↑ appears</span>' : ''}
          ${kw.alertDisappear ? '<span class="rule-item__tag rule-item__tag--disappear">↓ disappears</span>' : ''}
          ${!kw.enabled       ? '<span class="rule-item__tag">disabled</span>' : ''}
        </div>
      </div>
      <div class="rule-item__actions">
        <button class="btn--icon" data-action="toggle" data-id="${kw.id}" title="${kw.enabled ? 'Disable' : 'Enable'}">
          ${kw.enabled ? SVG_PAUSE : SVG_PLAY}
        </button>
        <button class="btn--icon del" data-action="delete" data-id="${kw.id}" title="Delete"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
    `;
    list.appendChild(li);
  });
}

function bindKeywordEvents() {
  const kwMatchType = qs('#kwMatchType');
  const kwRegexHint = qs('#kwRegexHint');

  // Show regex hint when regex selected
  kwMatchType.addEventListener('change', () => {
    kwRegexHint.style.display = kwMatchType.value === MATCH_TYPE.REGEX ? 'block' : 'none';
  });

  // Add keyword
  qs('#addKwBtn').addEventListener('click', handleAddKeyword);
  qs('#kwText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAddKeyword();
  });

  // Search/filter
  qs('#kwSearch').addEventListener('input', (e) => {
    renderKeywords(e.target.value);
  });

  // List actions (delegated)
  qs('#kwList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;

    if (action === 'toggle') {
      const keywords = await getKeywords();
      const kw = keywords.find((k) => k.id === id);
      if (kw) await updateKeyword(id, { enabled: !kw.enabled });
      await renderKeywords(qs('#kwSearch').value);
      await renderSidebarStatus();
    }

    if (action === 'delete') {
      await removeKeyword(id);
      await renderKeywords(qs('#kwSearch').value);
      await renderSidebarStatus();
      showToast('Keyword removed.');
    }
  });
}

async function handleAddKeyword() {
  const text      = qs('#kwText').value.trim();
  const matchType = qs('#kwMatchType').value;
  const errEl     = qs('#kwError');

  hideError(errEl);

  if (!text) { showError(errEl, 'Please enter a keyword.'); return; }

  if (matchType === MATCH_TYPE.REGEX) {
    const { valid, error } = validateRegex(text);
    if (!valid) { showError(errEl, `Invalid regex: ${error}`); return; }
  }

  await addKeyword({
    text,
    matchType,
    scopeSelector:  qs('#kwScope').value.trim(),
    enabled:        qs('#kwEnabled').checked,
    alertAppear:    qs('#kwAlertAppear').checked,
    alertDisappear: qs('#kwAlertDisappear').checked,
  });

  qs('#kwText').value  = '';
  qs('#kwScope').value = '';
  await renderKeywords();
  await renderSidebarStatus();
  showToast('Keyword added!');
}

// ─── URLs ─────────────────────────────────────────────────────────────────────

async function renderUrls() {
  const urls  = await getUrls();
  const list  = qs('#urlList');
  const badge = qs('#urlBadge');
  badge.textContent = urls.filter((u) => u.enabled).length;

  if (urls.length === 0) {
    list.innerHTML = '<li class="rule-list__empty">No URL rules yet. Add one above.</li>';
    return;
  }

  list.innerHTML = '';
  urls.forEach((url) => {
    const li = document.createElement('li');
    li.className = `rule-item${!url.enabled ? ' rule-item--disabled' : ''}`;
    li.dataset.id = url.id;

    const typeLabel = URL_MATCH_TYPE_LABEL[url.matchType] || url.matchType;

    li.innerHTML = `
      <div class="rule-item__main">
        <div class="rule-item__text">${escapeHtml(url.label || url.pattern)}</div>
        <div class="rule-item__meta">
          <span class="rule-item__tag rule-item__tag--match">${escapeHtml(typeLabel)}</span>
          <span class="rule-item__tag">${escapeHtml(truncate(url.pattern, 40))}</span>
          ${!url.enabled ? '<span class="rule-item__tag">disabled</span>' : ''}
        </div>
      </div>
      <div class="rule-item__actions">
        <button class="btn--icon" data-action="toggle" data-id="${url.id}" title="${url.enabled ? 'Disable' : 'Enable'}">
          ${url.enabled ? SVG_PAUSE : SVG_PLAY}
        </button>
        <button class="btn--icon del" data-action="delete" data-id="${url.id}" title="Delete"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
    `;
    list.appendChild(li);
  });
}

function bindUrlEvents() {
  const urlMatchType = qs('#urlMatchType');
  const urlHint      = qs('#urlHint');

  const HINTS = {
    wildcard: '<strong>Wildcard:</strong> Use * as wildcard. E.g. <code>https://example.com/*</code>',
    exact:    '<strong>Exact URL:</strong> Matches only this precise URL.',
    domain:   '<strong>Domain-wide:</strong> Enter domain like <code>example.com</code> or <code>*.example.com</code>',
  };

  urlMatchType.addEventListener('change', () => {
    urlHint.innerHTML = HINTS[urlMatchType.value] || '';
  });

  // Add URL
  qs('#addUrlBtn').addEventListener('click', handleAddUrl);
  qs('#urlPattern').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAddUrl();
  });

  // Add current tab's URL
  qs('#addCurrentUrlBtn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      qs('#urlPattern').value = tab.url;
      qs('#urlLabel').value   = tab.title || tab.url;
    }
  });

  // URL checker
  qs('#checkUrlBtn').addEventListener('click', async () => {
    const input  = qs('#checkUrl').value.trim();
    const result = qs('#checkResult');
    const urls   = await getUrls();
    const activeUrls = urls.filter((u) => u.enabled);
    const match  = activeUrls.find((u) => matchesUrl(input, u.pattern, u.matchType));

    result.classList.remove('hidden', 'status-result--ok', 'status-result--err');
    if (match) {
      result.className = 'status-result status-result--ok';
      result.textContent = `✅ Matched by rule: "${match.label || match.pattern}" (${match.matchType})`;
    } else {
      result.className = 'status-result status-result--err';
      result.textContent = '❌ No active URL rule matches this URL.';
    }
  });

  // List actions
  qs('#urlList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;

    if (action === 'toggle') {
      const urls = await getUrls();
      const url = urls.find((u) => u.id === id);
      if (url) await updateUrl(id, { enabled: !url.enabled });
      await renderUrls();
      await renderSidebarStatus();
    }

    if (action === 'delete') {
      await removeUrl(id);
      await renderUrls();
      await renderSidebarStatus();
      showToast('URL rule removed.');
    }
  });
}

async function handleAddUrl() {
  const pattern   = qs('#urlPattern').value.trim();
  const matchType = qs('#urlMatchType').value;
  const label     = qs('#urlLabel').value.trim();
  const errEl     = qs('#urlError');

  hideError(errEl);

  if (!pattern) { showError(errEl, 'Please enter a URL or pattern.'); return; }

  if (matchType !== URL_MATCH_TYPE.DOMAIN) {
    try { new URL(pattern.replace(/\*/g, 'x')); }
    catch (_) { showError(errEl, 'Invalid URL. Example: https://example.com/*'); return; }
  }

  await addUrl({
    pattern,
    matchType,
    label: label || pattern,
    enabled: qs('#urlEnabled').checked,
  });

  qs('#urlPattern').value = '';
  qs('#urlLabel').value   = '';
  await renderUrls();
  await renderSidebarStatus();
  showToast('URL rule added!');
}

// ─── Notifications ────────────────────────────────────────────────────────────

async function renderNotifSettings() {
  const s = await getSettings();

  qs('#alertOnAppear').checked    = s.alertOnAppear    !== false;
  qs('#alertOnDisappear').checked = s.alertOnDisappear !== false;
  qs('#showUrl').checked          = s.showUrl          !== false;
  qs('#showMatchType').checked    = s.showMatchType    !== false;
  qs('#showSnippet').checked      = s.showSnippet      !== false;
  qs('#cooldownSeconds').value    = s.cooldownSeconds  || 5;

  const freq = s.notifFrequency || NOTIF_FREQUENCY.ONCE_PER_PAGE;
  const radio = qs(`input[name="notifFreq"][value="${freq}"]`);
  if (radio) radio.checked = true;

  qs('#cooldownRow').style.display = freq === NOTIF_FREQUENCY.COOLDOWN ? 'flex' : 'none';
}

function bindNotifEvents() {
  // Show/hide cooldown input
  qs('#notifFreqGroup').addEventListener('change', (e) => {
    if (e.target.name === 'notifFreq') {
      qs('#cooldownRow').style.display =
        e.target.value === NOTIF_FREQUENCY.COOLDOWN ? 'flex' : 'none';
    }
  });

  qs('#saveNotifBtn').addEventListener('click', async () => {
    const freq = qs('input[name="notifFreq"]:checked')?.value || NOTIF_FREQUENCY.ONCE_PER_PAGE;
    await saveSettings({
      alertOnAppear:    qs('#alertOnAppear').checked,
      alertOnDisappear: qs('#alertOnDisappear').checked,
      showUrl:          qs('#showUrl').checked,
      showMatchType:    qs('#showMatchType').checked,
      showSnippet:      qs('#showSnippet').checked,
      notifFrequency:   freq,
      cooldownSeconds:  parseInt(qs('#cooldownSeconds').value) || 5,
    });
    showToast('Notification settings saved!');
  });
}

// ─── Badge & Icon ─────────────────────────────────────────────────────────────

async function renderBadgeSettings() {
  const s = await getSettings();
  qs('#badgeEnabled').checked      = s.badgeEnabled      !== false;
  qs('#badgeShowCount').checked    = s.badgeShowCount     !== false;
  qs('#iconChangeOnMatch').checked = s.iconChangeOnMatch  !== false;
  qs('#popupStatusEnabled').checked= s.popupStatusEnabled !== false;
}

function bindBadgeEvents() {
  qs('#saveBadgeBtn').addEventListener('click', async () => {
    await saveSettings({
      badgeEnabled:      qs('#badgeEnabled').checked,
      badgeShowCount:    qs('#badgeShowCount').checked,
      iconChangeOnMatch: qs('#iconChangeOnMatch').checked,
      popupStatusEnabled:qs('#popupStatusEnabled').checked,
    });
    showToast('Badge settings saved!');
  });
}
// ─── Activity (Alert Log) ───────────────────────────────────────────────────────

async function renderAlertHistory() {
  const events = await getAlertHistory();
  const list   = qs('#activityList');
  const badge  = qs('#activityBadge');
  badge.textContent = events.length;

  if (events.length === 0) {
    list.innerHTML = '<li class="rule-list__empty">No alert events yet.</li>';
    return;
  }

  list.innerHTML = '';
  events.forEach((entry) => {
    const li = document.createElement('li');
    li.className = 'rule-item';
    const isAppear = entry.event === 'appears';
    const time = new Date(entry.timestamp).toLocaleString([], {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    let host = entry.url;
    try { host = new URL(entry.url).hostname; } catch (_) { /* keep raw */ }
    const matchLabel = MATCH_TYPE_LABEL[entry.matchType] || entry.matchType;

    li.innerHTML = `
      <div class="rule-item__main">
        <div class="rule-item__text">“${escapeHtml(truncate(entry.keyword, 50))}” ${isAppear ? 'appeared' : 'gone'}</div>
        <div class="rule-item__meta">
          <span class="rule-item__tag ${isAppear ? 'rule-item__tag--appear' : 'rule-item__tag--disappear'}">${isAppear ? '↑ appear' : '↓ gone'}</span>
          <span class="rule-item__tag rule-item__tag--match">${escapeHtml(matchLabel)}</span>
          <span class="rule-item__tag" title="${escapeHtml(entry.url)}">${escapeHtml(host)}</span>
          <span class="rule-item__tag">${time}</span>
        </div>
      </div>
    `;
    if (entry.snippet) {
      li.querySelector('.rule-item__main').insertAdjacentHTML(
        'beforeend',
        `<div class="rule-item__snippet">“${escapeHtml(truncate(entry.snippet, 100))}”</div>`
      );
    }
    list.appendChild(li);
  });
}

function bindActivityEvents() {
  qs('#clearActivityBtn').addEventListener('click', async () => {
    await clearAlertHistory();
    await renderAlertHistory();
    showToast('Alert log cleared.');
  });
}
// ─── History ──────────────────────────────────────────────────────────────────

  const history = await getHistory();
  const list    = qs('#histList');
  const badge   = qs('#histBadge');
  badge.textContent = history.length;

  if (history.length === 0) {
    list.innerHTML = '<li class="history-list__empty">No saved setups yet.</li>';
    return;
  }

  list.innerHTML = '';
  history.forEach((entry) => {
    const li = document.createElement('li');
    li.className = 'history-item';
    li.dataset.id = entry.id;

    const kwdSummary = entry.keywords.length > 0
      ? entry.keywords.slice(0, 5).map((k) => `"${truncate(k.text, 25)}"`).join(', ')
      : 'No keywords';

    li.innerHTML = `
      <div class="history-item__meta">
        <div class="history-item__label">${escapeHtml(entry.label)}</div>
        <div class="history-item__sub">
          ${escapeHtml(kwdSummary)} · ${entry.urls.length} URL${entry.urls.length !== 1 ? 's' : ''} · ${timeAgo(entry.timestamp)}
        </div>
      </div>
      <div class="history-item__actions">
        <button class="btn--icon" data-action="restore" data-id="${entry.id}">↩ Restore</button>
        <button class="btn--icon del" data-action="delete" data-id="${entry.id}">✕</button>
      </div>
    `;
    list.appendChild(li);
  });
}

function bindHistoryEvents() {
  qs('#saveNowBtn').addEventListener('click', async () => {
    const label = qs('#saveLabel').value.trim() || `Setup ${new Date().toLocaleString()}`;
    await saveHistorySnapshot(label);
    qs('#saveLabel').value = '';
    await renderHistory();
    showToast('Setup saved!');
  });

  qs('#histList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;

    if (action === 'restore') {
      await restoreHistoryEntry(id);
      await renderKeywords();
      await renderUrls();
      await renderSidebarStatus();
      showToast('Setup restored!');
    }

    if (action === 'delete') {
      await removeHistoryEntry(id);
      await renderHistory();
    }
  });
}

// ─── Storage Change Listener ──────────────────────────────────────────────────

function listenForChanges() {
  onStorageChange(
    [STORAGE_KEY.KEYWORDS, STORAGE_KEY.URLS, STORAGE_KEY.SETTINGS,
     STORAGE_KEY.HISTORY, STORAGE_KEY.ALERT_HISTORY, STORAGE_KEY.ENABLED],
    async (changes) => {
      if (STORAGE_KEY.KEYWORDS      in changes) await renderKeywords();
      if (STORAGE_KEY.URLS          in changes) await renderUrls();
      if (STORAGE_KEY.SETTINGS      in changes) { await renderNotifSettings(); await renderBadgeSettings(); }
      if (STORAGE_KEY.HISTORY       in changes) await renderHistory();
      if (STORAGE_KEY.ALERT_HISTORY in changes) await renderAlertHistory();
      await renderSidebarStatus();
    }
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────

let toastTimer;
function showToast(msg) {
  const el = qs('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2500);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function showError(el, msg) { el.textContent = msg; el.classList.remove('hidden'); }
function hideError(el)      { el.textContent = '';  el.classList.add('hidden'); }

function escapeHtml(str = '') {
  return str
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const MATCH_TYPE_LABEL = {
  exact_case:   'Exact (case-sensitive)',
  exact_nocase: 'Exact (case-insensitive)',
  contains:     'Contains',
  starts_with:  'Starts with',
  ends_with:    'Ends with',
  regex:        'Regex',
};

const URL_MATCH_TYPE_LABEL = {
  exact:    'Exact URL',
  wildcard: 'Wildcard',
  domain:   'Domain-wide',
};

// ─── Start ────────────────────────────────────────────────────────────────────
init();
