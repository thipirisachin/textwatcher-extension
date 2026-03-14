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
  getAlertHistory, clearAlertHistory, removeAlertEvent,
  getOnboarded, setOnboarded,
} from '../shared/storage.js';
import { validateRegex, matchesUrl } from '../shared/matcher.js';
import { qs, qsa, timeAgo, truncate, onStorageChange } from '../shared/utils.js';

// ─── SVG Icon Strings ─────────────────────────────────────────────────────────
const SVG_PAUSE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
const SVG_PLAY  = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
const SVG_SCOPE = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
const SVG_EDIT  = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';

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
  // alertOnAppear/alertOnDisappear are now per-keyword only; reset any stale stored false values
  await saveSettings({ alertOnAppear: true, alertOnDisappear: true });

  await Promise.all([
    renderKeywords(),
    renderUrls(),
    renderNotifSettings(),
    renderBadgeSettings(),
    renderHistory(),
    renderAlertHistory(),
    renderSidebarStatus(),
    renderWelcomeBanner(),
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

// ─── Welcome Banner ───────────────────────────────────────────────────────────────

async function renderWelcomeBanner() {
  const onboarded = await getOnboarded();
  if (!onboarded) {
    qs('#welcomeBanner').classList.remove('hidden');
    qs('#dismissWelcomeBtn').addEventListener('click', async () => {
      await setOnboarded();
      qs('#welcomeBanner').classList.add('hidden');
    });
  }
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
        <button class="btn--icon" data-action="edit" data-id="${kw.id}" title="Edit">${SVG_EDIT}</button>
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

    if (action === 'edit') {
      const keywords = await getKeywords();
      const kw = keywords.find((k) => k.id === id);
      if (!kw) return;
      let li = e.target.closest('li.rule-item');
      if (!li) return;

      // Toggle off if this item's form already open
      if (li.querySelector('form.rule-item__edit')) { await renderKeywords(qs('#kwSearch').value); return; }

      // Close any other open edit form first (one at a time)
      if (qs('#kwList').querySelector('form.rule-item__edit')) {
        await renderKeywords(qs('#kwSearch').value);
        li = qs(`#kwList li[data-id="${id}"]`);
        if (!li) return;
      }

      const matchOptions = Object.entries(MATCH_TYPE_LABEL)
        .map(([val, lbl]) => `<option value="${val}"${kw.matchType === val ? ' selected' : ''}>${escapeHtml(lbl)}</option>`)
        .join('');

      li.insertAdjacentHTML('beforeend', `
        <form class="rule-item__edit" data-edit-id="${id}" novalidate>
          <div class="rule-item__edit-row">
            <input class="input" name="text" value="${escapeHtml(kw.text)}" maxlength="500" placeholder="Keyword…" />
            <select class="select" name="matchType">${matchOptions}</select>
          </div>
          <input class="input" name="scope" value="${escapeHtml(kw.scopeSelector || '')}" placeholder="Scope: CSS selector (optional)" maxlength="500" />
          <div class="rule-item__edit-checks">
            <label><input type="checkbox" name="alertAppear"    ${kw.alertAppear    ? 'checked' : ''} /> Alert appears</label>
            <label><input type="checkbox" name="alertDisappear" ${kw.alertDisappear ? 'checked' : ''} /> Alert disappears</label>
          </div>
          <p class="error-msg hidden" data-role="edit-error"></p>
          <div class="rule-item__edit-actions">
            <button type="button" class="btn btn--primary" data-action="save-edit" data-id="${id}">Save</button>
            <button type="button" class="btn btn--ghost"   data-action="cancel-edit">Cancel</button>
          </div>
        </form>
      `);
      li.querySelector('input[name="text"]').select();
    }

    if (action === 'save-edit') {
      const form      = e.target.closest('form.rule-item__edit');
      const editId    = form?.dataset.editId;
      const text      = form?.querySelector('[name="text"]')?.value.trim();
      const matchType = form?.querySelector('[name="matchType"]')?.value;
      const errEl     = form?.querySelector('[data-role="edit-error"]');

      if (!text) { showError(errEl, 'Keyword cannot be empty.'); return; }
      if (matchType === MATCH_TYPE.REGEX) {
        const { valid, error } = validateRegex(text);
        if (!valid) { showError(errEl, `Invalid regex: ${error}`); return; }
      }

      await updateKeyword(editId, {
        text,
        matchType,
        scopeSelector:  form.querySelector('[name="scope"]')?.value.trim() || '',
        alertAppear:    form.querySelector('[name="alertAppear"]')?.checked ?? true,
        alertDisappear: form.querySelector('[name="alertDisappear"]')?.checked ?? true,
      });
      await renderKeywords(qs('#kwSearch').value);
      await renderSidebarStatus();
      showToast('Keyword updated!');
    }

    if (action === 'cancel-edit') {
      await renderKeywords(qs('#kwSearch').value);
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
        <button class="btn--icon" data-action="edit-url" data-id="${url.id}" title="Edit">${SVG_EDIT}</button>
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

  // List actions (delegated)
  qs('#urlList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;

    if (action === 'edit-url') {
      const urls = await getUrls();
      const url  = urls.find((u) => u.id === id);
      if (!url) return;
      let li = e.target.closest('li.rule-item');
      if (!li) return;

      if (li.querySelector('form.rule-item__edit')) {
        await renderUrls();
        return;
      }

      // Close any other open edit form first (one at a time)
      if (qs('#urlList').querySelector('form.rule-item__edit')) {
        await renderUrls();
        li = qs(`#urlList li[data-id="${id}"]`);
        if (!li) return;
      }

      const typeOptions = Object.entries(URL_MATCH_TYPE_LABEL)
        .map(([val, lbl]) => `<option value="${val}"${url.matchType === val ? ' selected' : ''}>${escapeHtml(lbl)}</option>`)
        .join('');

      li.insertAdjacentHTML('beforeend', `
        <form class="rule-item__edit" data-edit-id="${id}" novalidate>
          <div class="rule-item__edit-row">
            <input class="input" name="pattern" value="${escapeHtml(url.pattern)}" maxlength="500" />
            <select class="select" name="matchType">${typeOptions}</select>
          </div>
          <input class="input" name="label" value="${escapeHtml(url.label || '')}" placeholder="Label (optional)" maxlength="100" />
          <p class="error-msg hidden" data-role="edit-error"></p>
          <div class="rule-item__edit-actions">
            <button type="button" class="btn btn--primary" data-action="save-url-edit" data-id="${id}">Save</button>
            <button type="button" class="btn btn--ghost"    data-action="cancel-url-edit">Cancel</button>
          </div>
        </form>
      `);
      li.querySelector('input[name="pattern"]').select();
    }

    if (action === 'save-url-edit') {
      const form      = e.target.closest('form.rule-item__edit');
      const editId    = form?.dataset.editId;
      const pattern   = form?.querySelector('[name="pattern"]')?.value.trim();
      const matchType = form?.querySelector('[name="matchType"]')?.value;
      const label     = form?.querySelector('[name="label"]')?.value.trim();
      const errEl     = form?.querySelector('[data-role="edit-error"]');

      if (!pattern) { showError(errEl, 'Pattern cannot be empty.'); return; }
      if (matchType !== URL_MATCH_TYPE.DOMAIN) {
        try { new URL(pattern.replace(/\*/g, 'x')); }
        catch (_) { showError(errEl, 'Invalid URL format (e.g. https://example.com/*)'); return; }
      }

      await updateUrl(editId, { pattern, matchType, label: label || pattern });
      await renderUrls();
      await renderSidebarStatus();
      showToast('URL rule updated!');
    }

    if (action === 'cancel-url-edit') {
      await renderUrls();
    }

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
  const saveBtn = qs('#saveNotifBtn');

  function markDirty() { saveBtn.disabled = false; }

  // Show/hide cooldown input; mark dirty on any frequency change
  qs('#notifFreqGroup').addEventListener('change', (e) => {
    markDirty();
    if (e.target.name === 'notifFreq') {
      qs('#cooldownRow').style.display =
        e.target.value === NOTIF_FREQUENCY.COOLDOWN ? 'flex' : 'none';
    }
  });
  qs('#cooldownSeconds').addEventListener('input', markDirty);
  qs('#showUrl').addEventListener('change', markDirty);
  qs('#showMatchType').addEventListener('change', markDirty);
  qs('#showSnippet').addEventListener('change', markDirty);

  saveBtn.addEventListener('click', async () => {
    const freq = qs('input[name="notifFreq"]:checked')?.value || NOTIF_FREQUENCY.ONCE_PER_PAGE;
    await saveSettings({
      showUrl:          qs('#showUrl').checked,
      showMatchType:    qs('#showMatchType').checked,
      showSnippet:      qs('#showSnippet').checked,
      notifFrequency:   freq,
      cooldownSeconds:  parseInt(qs('#cooldownSeconds').value) || 5,
    });
    showToast('Notification settings saved!');
    saveBtn.disabled = true;
  });
}

// ─── Badge & Icon ─────────────────────────────────────────────────────────────

async function renderBadgeSettings() {
  const s = await getSettings();
  qs('#badgeEnabled').checked = s.badgeEnabled !== false;
}

function bindBadgeEvents() {
  const saveBtn = qs('#saveBadgeBtn');
  qs('#badgeEnabled').addEventListener('change', () => { saveBtn.disabled = false; });

  saveBtn.addEventListener('click', async () => {
    await saveSettings({
      badgeEnabled: qs('#badgeEnabled').checked,
    });
    showToast('Badge settings saved!');
    saveBtn.disabled = true;
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
      </div>      <div class="rule-item__actions">
        <button class="btn--icon del" data-action="delete-alert" data-id="${entry.id}" title="Dismiss"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>    `;
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

  qs('#activityList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'delete-alert') {
      await removeAlertEvent(btn.dataset.id);
      await renderAlertHistory();
    }
  });
}
// ─── History ──────────────────────────────────────────────────────────────────

async function renderHistory() {
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
