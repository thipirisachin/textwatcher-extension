/**
 * options.js
 * Full settings page logic.
 * Sections: Keywords, URLs, Notifications, Badge & Icon, History
 */

import { MATCH_TYPE, URL_MATCH_TYPE, NOTIF_FREQUENCY, STORAGE_KEY, MSG, WEBHOOK_FORMAT, URL_SCOPE_ALL } from '../shared/constants.js';
import {
  getEnabled, setEnabled,
  getKeywords, saveKeywords, addKeyword, updateKeyword, removeKeyword,
  getUrls, saveUrls, addUrl, updateUrl, removeUrl,
  getSettings, saveSettings,
  getHistory, saveHistorySnapshot, restoreHistoryEntry, removeHistoryEntry,
  getAlertHistory, clearAlertHistory, removeAlertEvent,
  getOnboarded, setOnboarded,
  getWebhookSettings, saveWebhookSettings,
} from '../shared/storage.js';
import { validateRegex, matchesUrl } from '../shared/matcher.js';
import { qs, qsa, timeAgo, truncate, escapeHtml, MATCH_TYPE_LABEL, URL_MATCH_TYPE_LABEL, onStorageChange } from '../shared/utils.js';

// ─── SVG Icon Strings ─────────────────────────────────────────────────────────
const SVG_PAUSE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
const SVG_PLAY  = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
const SVG_SCOPE = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
const SVG_EDIT  = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';

// ─── Routing ──────────────────────────────────────────────────────────────────

const sections = ['setup', 'keywords', 'urls', 'notifications', 'activity', 'badge', 'history', 'webhooks', 'privacy'];

function showSection(id) {
  const current = document.querySelector('.panel:not(.hidden)');
  const next = qs(`#section-${id}`);

  const doSwap = () => {
    sections.forEach((s) => qs(`#section-${s}`)?.classList.toggle('hidden', s !== id));
    qsa('.nav-link').forEach((a) => a.classList.toggle('active', a.dataset.section === id));
  };

  if (current && current !== next) {
    current.classList.add('panel--leaving');
    setTimeout(() => {
      current.classList.remove('panel--leaving');
      doSwap();
    }, 150);
  } else {
    doSwap();
  }
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
    renderWelcomeBanner(),
    renderWebhookSettings(),
    renderUrlBindingAddForm(),
  ]);
  bindKeywordEvents();
  bindUrlEvents();
  bindNotifEvents();
  bindBadgeEvents();
  bindHistoryEvents();
  bindActivityEvents();
  bindSetupEvents();
  bindGlobalToggle();
  bindWebhookEvents();
  bindClearButtons();
  listenForChanges();

  // Deep-link: if the popup stored a target section, navigate there and clear.
  // Also listen for future writes (options page already open when popup fires).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.tw_open_section) return;
    const target = changes.tw_open_section.newValue;
    if (target) {
      chrome.storage.local.remove('tw_open_section');
      showSection(target);
    }
  });

  const { tw_open_section: target } = await chrome.storage.local.get('tw_open_section');
  if (target) {
    await chrome.storage.local.remove('tw_open_section');
    showSection(target);
  }
}

// ─── Welcome Banner ───────────────────────────────────────────────────────────────

async function renderWelcomeBanner() {
  const onboarded = await getOnboarded();
  if (!onboarded) {
    qs('#welcomeBanner').classList.remove('hidden');
    showSection('setup');
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

// ─── Setup Guide ─────────────────────────────────────────────────────────────

function bindSetupEvents() {
  qs('#testNotifBtn').addEventListener('click', () => {
    const perm = Notification.permission;

    if (perm === 'denied') {
      // Browser-level block is detectable and definitive.
      showToast('Notifications are blocked in Browser settings.');
      qs('#notifPermBanner').classList.remove('perm-banner--ok');
      qs('#notifPermBanner').textContent = '';
      qs('#notifPermBanner').insertAdjacentHTML('afterbegin',
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' +
        ' Notifications are blocked in Browser. Go to <strong>chrome://settings/content/notifications</strong> and allow notifications for Browser, then click the test button again.'
      );
      qs('#notifPermBanner').classList.remove('hidden');
      return;
    }

    // 'granted' or 'default' — attempt to create and let Chrome decide.
    chrome.notifications.create(`tw_test_${Date.now()}`, {
      type:     'basic',
      iconUrl:  chrome.runtime.getURL('src/icons/icon48.png'),
      title:    'TextWatcher',
      message:  'Notifications are working correctly! \u2713',
      priority: 1,
    }, () => {
      if (chrome.runtime.lastError) {
        // Extension-level failure (rare — e.g. notifications manifest permission missing).
        showToast('Notification could not be sent — check extension permissions.');
        qs('#notifPermBanner').classList.remove('perm-banner--ok');
        qs('#notifPermBanner').textContent = '';
        qs('#notifPermBanner').insertAdjacentHTML('afterbegin',
          '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' +
          ` Extension error: ${chrome.runtime.lastError.message}`
        );
        qs('#notifPermBanner').classList.remove('hidden');
        return;
      }
      // Sent OK at the Chrome level, but OS may still silently swallow it.
      const osHint = perm === 'default'
        ? ' If nothing appeared, go to <strong>chrome://settings/content/notifications</strong> and allow Browser notifications.'
        : ' If nothing appeared, check <strong>OS notification settings</strong> and make sure Browser notifications are allowed.';
      qs('#notifPermBanner').classList.add('perm-banner--ok');
      showToast('Test notification sent!');
      qs('#notifPermBanner').textContent = '';
      qs('#notifPermBanner').insertAdjacentHTML('afterbegin',
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' +
        ` Notification sent by Browser.${osHint}`
      );
      qs('#notifPermBanner').classList.remove('hidden');
    });
  });

  qs('#setupGoKeywords').addEventListener('click', (e) => {
    e.preventDefault();
    showSection('keywords');
  });

  qs('#setupGoUrls').addEventListener('click', (e) => {
    e.preventDefault();
    showSection('urls');
  });

  qs('#setupGoWebhooks').addEventListener('click', (e) => {
    e.preventDefault();
    showSection('webhooks');
  });

  qs('#setupDone').addEventListener('click', async (e) => {
    e.preventDefault();
    await setEnabled(true);
    const toggle = qs('#globalToggle');
    if (toggle) toggle.checked = true;
    await renderSidebarStatus();
    showSection('keywords');
    showToast('Monitoring enabled!');
  });

  // Accordion for setup guide steps — single-expand with CSS grid-rows animation
  document.querySelectorAll('.setup-accordion__hd').forEach((btn) => {
    btn.addEventListener('click', () => {
      const bodyId = btn.dataset.accordion;
      const wrap   = qs(`#${bodyId}-wrap`);
      const open   = btn.getAttribute('aria-expanded') === 'true';

      if (!open) {
        // Collapse all others first
        document.querySelectorAll('.setup-accordion__hd').forEach((other) => {
          if (other === btn) return;
          other.setAttribute('aria-expanded', 'false');
          const otherWrap = qs(`#${other.dataset.accordion}-wrap`);
          if (otherWrap) otherWrap.classList.remove('open');
        });
      }

      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      if (wrap) wrap.classList.toggle('open', !open);
    });
  });
}

// ─── Global Toggle ────────────────────────────────────────────────────────────

function bindGlobalToggle() {
  qs('#globalToggle').addEventListener('change', async (e) => {
    await setEnabled(e.target.checked);
    await renderSidebarStatus();
    showToast(e.target.checked ? 'Monitoring enabled' : 'Monitoring paused');
  });
}

// ─── Clear buttons on input-wrap ─────────────────────────────────────────────

function bindClearButtons() {
  document.querySelectorAll('.input-wrap').forEach((wrap) => {
    const input = wrap.querySelector('input');
    const btn   = wrap.querySelector('.input-clear');
    if (!input || !btn) return;
    const sync = () => wrap.classList.toggle('has-value', input.value.length > 0);
    input.addEventListener('input', sync);
    btn.addEventListener('click', () => { input.value = ''; sync(); input.dispatchEvent(new Event('input')); input.focus(); });
    sync();
  });
}

// ─── Keywords ─────────────────────────────────────────────────────────────────

// ─── URL Binding Helpers ──────────────────────────────────────────────────────

/**
 * Render small tags in keyword list showing which URLs a keyword is bound to.
 */
function buildUrlScopeTags(kw, urls) {
  const scope = kw.urlScope;
  if (!scope || scope === URL_SCOPE_ALL || !Array.isArray(scope) || scope.length === 0) return '';
  return scope.map((id) => {
    const rule = urls.find((u) => u.id === id);
    if (!rule) return '';
    const label = rule.label || truncate(rule.pattern, 28);
    return `<span class="rule-item__tag rule-item__tag--url-bound" title="Bound to: ${escapeHtml(rule.pattern)}">\uD83D\uDD17 ${escapeHtml(label)}</span>`;
  }).join('');
}

/**
 * Build a checklist of URL rules for inside the inline edit form.
 * @param {string|string[]} currentScope
 * @param {Array} urls
 */
async function buildUrlBindingChecklist(currentScope, urls) {
  const active = urls.filter((u) => u.enabled);
  if (active.length === 0) {
    return `<p class="hint" style="margin:4px 0;">No URL rules defined yet. <a class="link" href="#" data-nav="urls">Add URL rules</a> first, then bind keywords to them.</p>`;
  }
  const isAll = !currentScope || currentScope === URL_SCOPE_ALL || !Array.isArray(currentScope);
  const selected = isAll ? [] : currentScope;
  const items = active.map((u) => {
    const checked = selected.includes(u.id) ? 'checked' : '';
    const label   = u.label || truncate(u.pattern, 40);
    return `<label class="url-binding-item">
      <input type="checkbox" name="urlScope" value="${escapeHtml(u.id)}" ${checked} />
      <span class="url-binding-item__label" title="${escapeHtml(u.pattern)}">${escapeHtml(label)}</span>
    </label>`;
  }).join('');
  return `<p class="hint url-binding-hint">Bind to specific URLs (leave all unchecked for <em>all URLs</em>):</p>${items}`;
}

/**
 * Read selected URL rule IDs from a form container (inline edit form).
 * Returns URL_SCOPE_ALL if none checked.
 */
function readUrlBindingFromForm(form) {
  return readUrlBindingFromContainer(form.querySelector('.url-binding-edit'));
}

function readUrlBindingFromContainer(container) {
  if (!container) return URL_SCOPE_ALL;
  const checked = Array.from(container.querySelectorAll('input[name="urlScope"]:checked')).map((cb) => cb.value);
  return checked.length > 0 ? checked : URL_SCOPE_ALL;
}

/**
 * Populate the URL binding widget in the Add Keyword form.
 * Called on init and whenever URL rules change.
 */
async function renderUrlBindingAddForm() {
  const container = qs('#kwUrlBinding');
  if (!container) return;
  const urls = await getUrls();
  const html = await buildUrlBindingChecklist(URL_SCOPE_ALL, urls);
  container.innerHTML = html;
}

async function renderKeywords(filter = '') {
  const [keywords, urls] = await Promise.all([getKeywords(), getUrls()]);
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
          ${buildUrlScopeTags(kw, urls)}
          ${kw.alertAppear    ? '<span class="rule-item__tag rule-item__tag--appear">↑ appears</span>' : ''}
          ${kw.alertDisappear ? '<span class="rule-item__tag rule-item__tag--disappear">↓ disappears</span>' : ''}
          ${!kw.enabled       ? '<span class="rule-item__tag">disabled</span>' : ''}
        </div>
      </div>
      <div class="rule-item__actions">
        <button class="btn--icon" data-action="toggle" data-id="${kw.id}" title="${kw.enabled ? 'Disable' : 'Enable'}" aria-label="${kw.enabled ? 'Disable' : 'Enable'} keyword ${escapeHtml(kw.text)}">
          ${kw.enabled ? SVG_PAUSE : SVG_PLAY}
        </button>
        <button class="btn--icon" data-action="edit" data-id="${kw.id}" title="Edit" aria-label="Edit keyword ${escapeHtml(kw.text)}">${SVG_EDIT}</button>
        <button class="btn--icon del" data-action="delete" data-id="${kw.id}" title="Delete" aria-label="Delete keyword ${escapeHtml(kw.text)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
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

  // "Add URL rules" nav link inside the binding widget (add form)
  qs('#kwUrlBinding').addEventListener('click', (e) => {
    const a = e.target.closest('a[data-nav]');
    if (a) { e.preventDefault(); showSection(a.dataset.nav); }
  });

  // List actions (delegated)
  qs('#kwList').addEventListener('click', async (e) => {
    // "Add URL rules" nav link inside inline edit binding widget
    const navLink = e.target.closest('a[data-nav]');
    if (navLink) { e.preventDefault(); showSection(navLink.dataset.nav); return; }

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
      const [keywords, urls] = await Promise.all([getKeywords(), getUrls()]);
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
          <div class="url-binding-edit" data-binding-for="${id}">
            ${await buildUrlBindingChecklist(kw.urlScope, urls)}
          </div>
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
        urlScope:       readUrlBindingFromForm(form),
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
    urlScope:       readUrlBindingFromContainer(qs('#kwUrlBinding')),
    enabled:        qs('#kwEnabled').checked,
    alertAppear:    qs('#kwAlertAppear').checked,
    alertDisappear: qs('#kwAlertDisappear').checked,
  });

  qs('#kwText').value  = '';
  qs('#kwScope').value = '';
  // Reset binding checkboxes
  qs('#kwUrlBinding').querySelectorAll('input[type=checkbox]').forEach((cb) => { cb.checked = false; });
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
        <button class="btn--icon" data-action="toggle" data-id="${url.id}" title="${url.enabled ? 'Disable' : 'Enable'}" aria-label="${url.enabled ? 'Disable' : 'Enable'} URL rule ${escapeHtml(url.label || url.pattern)}">
          ${url.enabled ? SVG_PAUSE : SVG_PLAY}
        </button>
        <button class="btn--icon" data-action="edit-url" data-id="${url.id}" title="Edit" aria-label="Edit URL rule ${escapeHtml(url.label || url.pattern)}">${SVG_EDIT}</button>
        <button class="btn--icon del" data-action="delete" data-id="${url.id}" title="Delete" aria-label="Delete URL rule ${escapeHtml(url.label || url.pattern)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
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
      result.textContent = `Matched by rule: "${match.label || match.pattern}" (${match.matchType})`;
    } else {
      result.className = 'status-result status-result--err';
      result.textContent = 'No active URL rule matches this URL.';
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

  const added = await addUrl({
    pattern,
    matchType,
    label: label || pattern,
    enabled: qs('#urlEnabled').checked,
  });

  if (!added) { showError(errEl, 'This URL rule already exists.'); return; }
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
        <button class="btn--icon" data-action="restore" data-id="${entry.id}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.5"/></svg> Restore</button>
        <button class="btn--icon del" data-action="delete" data-id="${entry.id}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
    `;
    list.appendChild(li);
  });
}

function bindHistoryEvents() {
  qs('#saveNowBtn').addEventListener('click', async () => {
    const label = qs('#saveLabel').value.trim() || `Setup ${new Date().toLocaleString()}`;
    const saved = await saveHistorySnapshot(label);
    if (saved === null) {
      const [kws, us] = await Promise.all([getKeywords(), getUrls()]);
      showToast((kws.length === 0 && us.length === 0)
        ? 'Nothing to save — add keywords or URLs first.'
        : 'This setup is already saved.');
      return;
    }
    qs('#saveLabel').value = '';
    await renderHistory();
    showToast('Setup saved!');
  });

  qs('#histList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;

    if (action === 'restore') {
      // Fetch entry first so we can show counts in the toast
      const allHistory = await getHistory();
      const entry = allHistory.find((h) => h.id === id);
      await restoreHistoryEntry(id);
      await Promise.all([renderKeywords(), renderUrls(), renderHistory(), renderSidebarStatus()]);
      const kCount = entry?.keywords?.length ?? 0;
      const uCount = entry?.urls?.length ?? 0;
      showToast(`Restored: ${kCount} keyword${kCount !== 1 ? 's' : ''} · ${uCount} URL${uCount !== 1 ? 's' : ''}`);
      showSection('keywords');
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
     STORAGE_KEY.HISTORY, STORAGE_KEY.ALERT_HISTORY, STORAGE_KEY.ENABLED,
     STORAGE_KEY.WEBHOOK],
    async (changes) => {
      if (STORAGE_KEY.KEYWORDS      in changes) await renderKeywords();
      if (STORAGE_KEY.URLS          in changes) { await renderUrls(); await renderUrlBindingAddForm(); }
      if (STORAGE_KEY.SETTINGS      in changes) { await renderNotifSettings(); await renderBadgeSettings(); }
      if (STORAGE_KEY.HISTORY       in changes) await renderHistory();
      if (STORAGE_KEY.ALERT_HISTORY in changes) await renderAlertHistory();
      // Only re-render webhook settings if there are no unsaved changes — avoid
      // clobbering the form or re-disabling the save button while the user is editing.
      if (STORAGE_KEY.WEBHOOK in changes && qs('#saveWebhookBtn').disabled) await renderWebhookSettings();
      await renderSidebarStatus();
    }
  );
}

// ─── Webhooks ───────────────────────────────────────────────────────────────

// ─── Webhook Payload Previews ────────────────────────────────────────────────
function localISOString(date) {
  const tzOffset = -date.getTimezoneOffset();
  const sign = tzOffset >= 0 ? '+' : '-';
  const pad  = n => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return date.getFullYear()
    + '-' + pad(date.getMonth() + 1)
    + '-' + pad(date.getDate())
    + 'T' + pad(date.getHours())
    + ':' + pad(date.getMinutes())
    + ':' + pad(date.getSeconds())
    + sign + pad(tzOffset / 60) + ':' + pad(tzOffset % 60);
}

function buildPayloadPreviews() {
  const ts = localISOString(new Date());
  const ms = Date.now();
  return {
    [WEBHOOK_FORMAT.TEAMS]: `{
  "@type":    "MessageCard",
  "@context": "http://schema.org/extensions",
  "themeColor": "28a745",
  "summary":  "TextWatcher: \\"your keyword\\" appeared",
  "sections": [{
    "activityTitle":    "\u{1F7E2} Keyword \\"your keyword\\" appeared",
    "activitySubtitle": "Page Title",
    "activityText":     "[https://monitored-page.com/](https://monitored-page.com/)",
    "facts": [
      { "name": "Keyword",    "value": "your keyword" },
      { "name": "Event",      "value": "appears"      },
      { "name": "Match Type", "value": "contains"     },
      { "name": "Time",       "value": "${ts}" }
    ]
  }],
  "potentialAction": [{
    "@type": "OpenUri",
    "name":  "Open Page",
    "targets": [{ "os": "default", "uri": "https://monitored-page.com/" }]
  }]
}`,
    [WEBHOOK_FORMAT.SLACK]: `{
  "text": "\u{1F7E2} *your keyword* appeared \u2014 <https://monitored-page.com/|Page Title>"
}`,
    [WEBHOOK_FORMAT.TELEGRAM]: `{
  "chat_id":    "-1001234567890",
  "text":       "\u{1F7E2} *your keyword* appeared\\n\u{1F517} https://monitored-page.com/",
  "parse_mode": "Markdown"
}`,
    [WEBHOOK_FORMAT.GENERIC]: `{
  "event":        "appears",
  "keyword":      "your keyword",
  "matchType":    "contains",
  "url":          "https://monitored-page.com/",
  "title":        "Page Title",
  "snippet":      "...surrounding context...",
  "timestamp":    "${ts}",
  "timestamp_ms": ${ms},
  "source":       "TextWatcher"
}`,
  };
}

const TELEGRAM_URL_HINT = 'Set URL to <code>https://api.telegram.org/bot{YOUR_TOKEN}/sendMessage</code>. The Chat ID field below identifies the destination chat.';
const DEFAULT_URL_HINT  = 'Must be <code>https://</code>. <code>http://localhost</code> is also allowed for local testing.';

// ─── Webhook UI helpers ───────────────────────────────────────────────────────
function updateWebhookFormatUI(format) {
  const previews = buildPayloadPreviews();
  qs('#webhookPayloadPreview').textContent = previews[format] || previews[WEBHOOK_FORMAT.GENERIC];
  const isTelegram = format === WEBHOOK_FORMAT.TELEGRAM;
  qs('#webhookTelegramChatIdRow').style.display = isTelegram ? '' : 'none';
  qs('#webhookUrlHint').innerHTML = isTelegram ? TELEGRAM_URL_HINT : DEFAULT_URL_HINT;
  if (isTelegram && !qs('#webhookUrl').value) {
    qs('#webhookUrl').placeholder = 'https://api.telegram.org/bot{TOKEN}/sendMessage';
  } else if (!isTelegram) {
    qs('#webhookUrl').placeholder = 'https://your-server.com/webhook';
  }
}

async function renderWebhookSettings() {
  const cfg = await getWebhookSettings();
  qs('#webhookEnabled').checked     = cfg.enabled;
  qs('#webhookOnAppear').checked    = cfg.onAppear;
  qs('#webhookOnDisappear').checked = cfg.onDisappear;
  qs('#webhookFormat').value        = cfg.format || WEBHOOK_FORMAT.TEAMS;
  qs('#webhookTelegramChatId').value = cfg.telegramChatId || '';
  // Set URL before updateWebhookFormatUI so the Telegram placeholder check is accurate
  qs('#webhookUrl').value = cfg.url;
  updateWebhookFormatUI(cfg.format || WEBHOOK_FORMAT.TEAMS);

  // Show masked placeholder if a secret is saved; never pre-fill the real value
  const secretInput = qs('#webhookSecret');
  secretInput.placeholder = cfg.secret
    ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (saved — enter new value to change)'
    : 'Leave empty for no authentication';
  secretInput.value = '';

  qs('#saveWebhookBtn').disabled = true;
}

function bindWebhookEvents() {
  const saveBtn   = qs('#saveWebhookBtn');
  const testBtn   = qs('#webhookTestBtn');
  const testResult = qs('#webhookTestResult');

  function markDirty() { saveBtn.disabled = false; }

  const urlErrEl = qs('#webhookUrlError');

  qs('#webhookEnabled').addEventListener('change', markDirty);
  qs('#webhookUrl').addEventListener('input', () => { markDirty(); hideError(urlErrEl); });
  qs('#webhookSecret').addEventListener('input', markDirty);
  qs('#webhookFormat').addEventListener('change', () => {
    markDirty();
    updateWebhookFormatUI(qs('#webhookFormat').value);
  });
  qs('#webhookTelegramChatId').addEventListener('input', markDirty);
  qs('#webhookOnAppear').addEventListener('change', markDirty);
  qs('#webhookOnDisappear').addEventListener('change', markDirty);

  // Show/hide secret toggle
  qs('#webhookSecretToggle').addEventListener('click', () => {
    const inp = qs('#webhookSecret');
    const isHidden = inp.type === 'password';
    inp.type = isHidden ? 'text' : 'password';
    qs('#webhookSecretEye').innerHTML = isHidden
      ? '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'
      : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
  });

  saveBtn.addEventListener('click', async () => {
    const url    = qs('#webhookUrl').value.trim();
    const secret = qs('#webhookSecret').value; // intentionally not trimmed

    // Validate URL only if one is entered
    if (url) {
      try {
        const u = new URL(url);
        const isHttps    = u.protocol === 'https:';
        const isLocalHttp = u.protocol === 'http:' &&
          (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
        if (!isHttps && !isLocalHttp) throw new Error();
      } catch (_) {
        showError(urlErrEl, 'Invalid URL. Must be https:// or http://localhost.');
        qs('#webhookUrl').focus();
        return;
      }
    }

    const patch = {
      enabled:        qs('#webhookEnabled').checked,
      url,
      format:         qs('#webhookFormat').value,
      telegramChatId: qs('#webhookTelegramChatId').value.trim(),
      onAppear:       qs('#webhookOnAppear').checked,
      onDisappear:    qs('#webhookOnDisappear').checked,
    };
    // Only overwrite the secret if the user typed a new one
    if (secret) patch.secret = secret;

    hideError(urlErrEl);
    await saveWebhookSettings(patch);
    await renderWebhookSettings(); // re-render to show masked placeholder
    showToast('Webhook settings saved!');
    saveBtn.disabled = true;

    // Hide any previous test result on save
    testResult.classList.add('hidden');
  });

  testBtn.addEventListener('click', async () => {
    testResult.className = 'webhook-test-result';
    testResult.textContent = 'Sending…';

    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: MSG.TEST_WEBHOOK });
    } catch (err) {
      testResult.className = 'webhook-test-result webhook-test-result--err';
      testResult.textContent = `Extension error: ${err.message}`;
      return;
    }

    if (!result) {
      testResult.className = 'webhook-test-result webhook-test-result--err';
      testResult.textContent = 'No response from service worker.';
      return;
    }

    if (!result.sent) {
      testResult.className = 'webhook-test-result webhook-test-result--err';
      testResult.textContent = result.error
        ? `✗ Failed: ${result.error}`
        : '✗ Webhook is disabled or no URL configured. Save settings first.';
      return;
    }

    const ok = result.status >= 200 && result.status < 300;
    testResult.className = `webhook-test-result webhook-test-result--${ok ? 'ok' : 'warn'}`;
    testResult.textContent = ok
      ? `✓ Delivered — server responded ${result.status}`
      : `⚠ Sent but server responded ${result.status} — check your endpoint`;
  });
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

// ─── Start ────────────────────────────────────────────────────────────────────
init();
