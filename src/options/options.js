/**
 * options.js
 * Full settings page logic.
 * Sections: Keywords, URLs, Notifications, Badge & Icon, History
 */

import { MATCH_TYPE, URL_MATCH_TYPE, NOTIF_FREQUENCY, STORAGE_KEY, MSG, WEBHOOK_FORMAT, URL_SCOPE_ALL, WEBHOOK_SCOPE_ALL } from '../shared/constants.js';
import {
  getEnabled, setEnabled,
  getKeywords, saveKeywords, addKeyword, updateKeyword, removeKeyword,
  getUrls, saveUrls, addUrl, updateUrl, removeUrl,
  getSettings, saveSettings,
  getAlertHistory, clearAlertHistory, removeAlertEvent,
  getOnboarded, setOnboarded,
  getWebhooks, saveWebhooks, addWebhook, updateWebhook, removeWebhook,
} from '../shared/storage.js';
import { validateRegex, matchesUrl } from '../shared/matcher.js';
import { qs, qsa, timeAgo, truncate, escapeHtml, MATCH_TYPE_LABEL, URL_MATCH_TYPE_LABEL, onStorageChange } from '../shared/utils.js';

// ─── SVG Icon Strings ─────────────────────────────────────────────────────────
const SVG_PAUSE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
const SVG_PLAY  = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
const SVG_SCOPE = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
const SVG_EDIT  = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';

// ─── Routing ──────────────────────────────────────────────────────────────────

const sections = ['setup', 'rules', 'settings', 'activity', 'privacy'];

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
  // Read onboarded state and any deep-link target in parallel so we can show
  // the correct section on the very first paint — no flash to a wrong section.
  const [onboarded, { tw_open_section: deepLink }] = await Promise.all([
    getOnboarded(),
    chrome.storage.local.get('tw_open_section'),
  ]);

  if (deepLink) {
    chrome.storage.local.remove('tw_open_section');
    showSection(deepLink);
  } else if (!onboarded) {
    showSection('setup');
  } else {
    showSection('rules');
  }

  if (!onboarded) {
    qs('#welcomeBanner').classList.remove('hidden');
    qs('#dismissWelcomeBtn')?.addEventListener('click', async () => {
      await setOnboarded();
      qs('#welcomeBanner').classList.add('hidden');
    });
  }

  await Promise.all([
    renderKeywords(),
    renderUrls(),
    renderNotifSettings(),
    renderAlertHistory(),
    renderSidebarStatus(),
    renderWebhookList(),
    renderUrlBindingAddForm(),
  ]);
  bindKeywordEvents();
  bindUrlEvents();
  bindNotifEvents();
  bindExportImport();
  bindActivityEvents();
  bindSetupEvents();
  bindGlobalToggle();
  bindWebhookListEvents();
  bindClearButtons();
  listenForChanges();

  // When the options page is already open, handle deep-links written by the popup.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.tw_open_section) return;
    const target = changes.tw_open_section.newValue;
    if (target) {
      chrome.storage.local.remove('tw_open_section');
      showSection(target);
    }
  });
}

// ─── Welcome Banner ───────────────────────────────────────────────────────────────

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
      showToast('Notifications are blocked in Browser settings.', 'error');
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
        showToast('Notification could not be sent — check extension permissions.', 'error');
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
        ` Sent to browser - if nothing appeared, check OS notification settings and make sure ${navigator.userAgent.includes('Edg') ? 'Microsoft Edge' : 'Google Chrome'} notifications are allowed.`
      );
      qs('#notifPermBanner').classList.remove('hidden');
    });
  });

  qs('#setupGoKeywords').addEventListener('click', (e) => {
    e.preventDefault();
    showSection('rules');
  });

  qs('#setupGoUrls').addEventListener('click', (e) => {
    e.preventDefault();
    showSection('rules');
  });

  qs('#setupGoWebhooks').addEventListener('click', (e) => {
    e.preventDefault();
    showSection('settings');
  });

  qs('#setupDone').addEventListener('click', async (e) => {
    e.preventDefault();
    await setEnabled(true);
    const toggle = qs('#globalToggle');
    if (toggle) toggle.checked = true;
    await renderSidebarStatus();
    showSection('rules');
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
    return `<p class="url-binding-hint">No URL rules yet - keyword will fire on all pages. <a class="link" href="#" data-nav="urls">Add URL rules</a> to restrict it.</p>`;
  }
  const isAll = !currentScope || currentScope === URL_SCOPE_ALL || !Array.isArray(currentScope);
  const selected = isAll ? [] : currentScope;
  const items = active.map((u) => {
    const checked = selected.includes(u.id) ? 'checked' : '';
    const label   = u.label || truncate(u.pattern, 32);
    return `<label class="url-binding-bar__item">
      <input type="checkbox" name="urlScope" value="${escapeHtml(u.id)}" ${checked} />
      <span title="${escapeHtml(u.pattern)}">${escapeHtml(label)}</span>
    </label>`;
  }).join('');
  return `<p class="url-binding-hint">Bind to specific URLs (leave all unchecked = all pages):</p>${items}`;
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
 * Render small tags in keyword list showing which webhooks a keyword is bound to.
 */
function buildWebhookScopeTags(kw, webhooks) {
  const scope = kw.webhookScope;
  if (!scope || scope === WEBHOOK_SCOPE_ALL || !Array.isArray(scope) || scope.length === 0) return '';
  return scope.map((id) => {
    const wh = webhooks.find((w) => w.id === id);
    if (!wh) return '';
    return `<span class="rule-item__tag rule-item__tag--webhook-bound" title="Webhook: ${escapeHtml(wh.name || wh.url)}">\u{1F4E1} ${escapeHtml(wh.name || truncate(wh.url, 20))}</span>`;
  }).join('');
}

/**
 * Build a checklist of webhook configs for inside the keyword inline edit form.
 */
async function buildWebhookBindingChecklist(currentScope, webhooks) {
  const active = webhooks.filter((w) => w.enabled && w.url);
  if (active.length === 0) {
    return `<p class="url-binding-hint">No webhooks yet — keyword will fire all webhooks. <a class="link" href="#" data-nav="settings">Add a webhook</a> to restrict it.</p>`;
  }
  const isAll = !currentScope || currentScope === WEBHOOK_SCOPE_ALL || !Array.isArray(currentScope);
  const selected = isAll ? [] : currentScope;
  const items = active.map((w) => {
    const checked = selected.includes(w.id) ? 'checked' : '';
    const label   = w.name || truncate(w.url, 32);
    return `<label class="url-binding-bar__item">
      <input type="checkbox" name="webhookScope" value="${escapeHtml(w.id)}" ${checked} />
      <span title="${escapeHtml(w.url)}">${escapeHtml(label)}</span>
    </label>`;
  }).join('');
  return `<p class="url-binding-hint">Bind to specific webhooks (leave all unchecked = all webhooks):</p>${items}`;
}

function readWebhookBindingFromForm(form) {
  const container = form.querySelector('.webhook-binding-edit');
  if (!container) return WEBHOOK_SCOPE_ALL;
  const checked = Array.from(container.querySelectorAll('input[name="webhookScope"]:checked')).map((cb) => cb.value);
  return checked.length > 0 ? checked : WEBHOOK_SCOPE_ALL;
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

// Extract human-readable column values from a table-rule regex pattern.
// Pattern looks like: (?:^|\s)Val1(?=\s|$)[\s\S]*(?:^|\s)Val2(?=\s|$)
function decodeTableRuleText(pattern) {
  const matches = [...pattern.matchAll(/\(\?:\^\|\\s\)([\s\S]*?)\(\?=\\s\|\$\)/g)];
  if (!matches.length) return pattern;
  return matches.map(m => m[1].replace(/\\(.)/g, '$1')).join(' → ');
}

function decodeTableRuleValues(pattern) {
  const matches = [...pattern.matchAll(/\(\?:\^\|\\s\)([\s\S]*?)\(\?=\\s\|\$\)/g)];
  return matches.map(m => m[1].replace(/\\(.)/g, '$1'));
}

function buildTableRulePattern(values) {
  return values
    .filter(Boolean)
    .map(v => `(?:^|\\s)${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`)
    .join('[\\s\\S]*');
}

async function renderKeywords(filter = '') {
  const [keywords, urls, webhooks] = await Promise.all([getKeywords(), getUrls(), getWebhooks()]);
  const list  = qs('#kwList');
  const badge = qs('#kwBadge');
  badge.textContent = keywords.filter((k) => k.enabled).length;

  const filtered = filter
    ? keywords.filter((k) => k.text.toLowerCase().includes(filter.toLowerCase()))
    : keywords;

  if (filtered.length === 0) {
    list.innerHTML = `<li class="rule-list__empty">${filter ? 'No matches.' : 'No keyword rules yet. Add one from the extension popup.'}</li>`;
    return;
  }

  list.innerHTML = '';
  filtered.forEach((kw) => {
    const li = document.createElement('li');
    li.className = 'rule-item';
    li.dataset.id = kw.id;

    const matchLabel = MATCH_TYPE_LABEL[kw.matchType] || kw.matchType;
    const isTableRule = !!(kw.rowSelector);
    const displayText = isTableRule
      ? (kw.label || decodeTableRuleText(kw.text))
      : (kw.label || kw.text);
    const displayTag  = isTableRule
      ? `<span class="rule-item__tag rule-item__tag--table">Table rule</span>`
      : `<span class="rule-item__tag rule-item__tag--match">${escapeHtml(matchLabel)}</span>`;

    li.innerHTML = `
      <div class="rule-item__main${!kw.enabled ? ' rule-item--disabled' : ''}">
        <div class="rule-item__text">${escapeHtml(displayText)}</div>
        <div class="rule-item__meta">
          ${displayTag}
          ${kw.scopeSelector ? `<span class="rule-item__tag rule-item__tag--scope" title="Scope: ${escapeHtml(kw.scopeSelector)}">${SVG_SCOPE} ${escapeHtml(truncate(kw.scopeSelector, 30))}</span>` : ''}
          ${buildUrlScopeTags(kw, urls)}
          ${buildWebhookScopeTags(kw, webhooks)}
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

// ─── Options Keyword Form State ───────────────────────────────────────────────

function kwSetMode(mode) {
  const rowBtn   = qs('#kwModeRowBtn');
  const textBtn  = qs('#kwModeTextBtn');
  const rowPanel = qs('#kwRowModePanel');
  const txtPanel = qs('#kwTextModePanel');

  rowBtn?.classList.toggle('active', mode === 'row');
  textBtn?.classList.toggle('active', mode === 'text');
  rowBtn?.setAttribute('aria-selected', mode === 'row');
  textBtn?.setAttribute('aria-selected', mode === 'text');

  if (rowPanel) rowPanel.style.display = mode === 'row' ? '' : 'none';
  if (txtPanel) txtPanel.style.display = mode === 'text' ? '' : 'none';
}

function kwGetMatchType() {
  const caseOn  = qs('#kwModCaseBtn')?.classList.contains('active');
  const exactOn = qs('#kwModExactBtn')?.classList.contains('active');
  const regexOn = qs('#kwModRegexBtn')?.classList.contains('active');
  if (regexOn)       return MATCH_TYPE.REGEX;
  if (exactOn && caseOn) return MATCH_TYPE.EXACT;
  if (exactOn)       return MATCH_TYPE.EXACT;
  if (caseOn)        return MATCH_TYPE.CONTAINS; // contains + case-sensitive — stored as CONTAINS
  return MATCH_TYPE.CONTAINS;
}

function kwUpdateMatchHint() {
  const hint    = qs('#kwMatchHint');
  const regexOn = qs('#kwModRegexBtn')?.classList.contains('active');
  const exactOn = qs('#kwModExactBtn')?.classList.contains('active');
  const caseOn  = qs('#kwModCaseBtn')?.classList.contains('active');
  if (!hint) return;
  if (regexOn)             hint.textContent = 'Regular expression';
  else if (exactOn && caseOn) hint.textContent = 'Exact phrase, case-sensitive';
  else if (exactOn)        hint.textContent = 'Exact phrase';
  else if (caseOn)         hint.textContent = 'Case-sensitive match';
  else                     hint.textContent = 'Matches text anywhere on the page, any case';
}

function kwResetForm() {
  // Mode back to text
  kwSetMode('text');
  // Clear text input
  const kwText = qs('#kwText');
  if (kwText) kwText.value = '';
  // Clear modifier buttons
  qs('#kwModCaseBtn')?.classList.remove('active');
  qs('#kwModExactBtn')?.classList.remove('active');
  qs('#kwModRegexBtn')?.classList.remove('active');
  kwUpdateMatchHint();
  // Clear label
  const kwLabel = qs('#kwLabel');
  if (kwLabel) kwLabel.value = '';
  // Reset checkboxes
  const kwAlertAppear    = qs('#kwAlertAppear');
  const kwAlertDisappear = qs('#kwAlertDisappear');
  if (kwAlertAppear)    kwAlertAppear.checked    = true;
  if (kwAlertDisappear) kwAlertDisappear.checked = true;
  // Reset URL binding
  qs('#kwUrlBinding')?.querySelectorAll('input[type=checkbox]').forEach((cb) => { cb.checked = false; });
  // Reset scope/enabled
  const kwScope   = qs('#kwScope');
  const kwEnabled = qs('#kwEnabled');
  if (kwScope)   kwScope.value      = '';
  if (kwEnabled) kwEnabled.checked  = true;
  // Hide error
  hideError(qs('#kwError'));
  // Sync clear buttons
  qs('#kwLabel')?.dispatchEvent(new Event('input'));
}

function bindKeywordEvents() {
  // Mode tabs
  qs('#kwModeRowBtn')?.addEventListener('click', () => kwSetMode('row'));
  qs('#kwModeTextBtn')?.addEventListener('click', () => kwSetMode('text'));

  // Modifier buttons
  ['#kwModCaseBtn', '#kwModExactBtn', '#kwModRegexBtn'].forEach((sel) => {
    qs(sel)?.addEventListener('click', () => {
      const btn = qs(sel);
      if (!btn) return;
      // Regex is exclusive
      if (sel === '#kwModRegexBtn') {
        const wasActive = btn.classList.contains('active');
        qs('#kwModCaseBtn')?.classList.remove('active');
        qs('#kwModExactBtn')?.classList.remove('active');
        btn.classList.toggle('active', !wasActive);
      } else {
        qs('#kwModRegexBtn')?.classList.remove('active');
        btn.classList.toggle('active');
      }
      kwUpdateMatchHint();
    });
  });

  // Add keyword
  qs('#addKwBtn')?.addEventListener('click', handleAddKeyword);
  qs('#kwText')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAddKeyword();
  });

  // Search/filter
  qs('#kwSearch').addEventListener('input', (e) => {
    renderKeywords(e.target.value);
  });

  // "Add URL rules" nav link inside the binding widget (add form)
  qs('#kwUrlBinding')?.addEventListener('click', (e) => {
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
      const [keywords, urls, webhooks] = await Promise.all([getKeywords(), getUrls(), getWebhooks()]);
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

      const isTableRule = !!(kw.rowSelector);
      const editBodyHtml = isTableRule
        ? (() => {
            const vals = decodeTableRuleValues(kw.text);
            const rows = (vals.length ? vals : ['']).map(v =>
              `<div class="col-filter-edit-row">
                <input class="input col-filter-edit-input" value="${escapeHtml(v)}" placeholder="Column value…" maxlength="200" />
                <button class="col-filter-edit-remove" type="button" data-action="remove-col-filter" aria-label="Remove">×</button>
              </div>`
            ).join('');
            return `<div class="col-filter-edit-grid" data-table-edit="true">${rows}</div>
              <button class="btn btn--ghost btn--sm" type="button" data-action="add-col-filter" style="margin-top:4px;">+ Add column</button>`;
          })()
        : `<div class="rule-item__edit-row">
            <input class="input" name="text" value="${escapeHtml(kw.text)}" maxlength="500" placeholder="Keyword…" />
            <select class="select" name="matchType">${matchOptions}</select>
          </div>`;

      li.insertAdjacentHTML('beforeend', `
        <form class="rule-item__edit" data-edit-id="${id}" novalidate>
          ${editBodyHtml}
          <input class="input" name="scope" value="${escapeHtml(kw.scopeSelector || '')}" placeholder="Scope: CSS selector (optional)" maxlength="500" style="margin-top:6px;" />
          <div class="url-binding-edit" data-binding-for="${id}">
            ${await buildUrlBindingChecklist(kw.urlScope, urls)}
          </div>
          <div class="webhook-binding-edit" data-binding-for="${id}">
            ${await buildWebhookBindingChecklist(kw.webhookScope, webhooks)}
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
      if (!isTableRule) li.querySelector('input[name="text"]').select();
    }

    if (action === 'add-col-filter') {
      const grid = e.target.closest('form.rule-item__edit')?.querySelector('.col-filter-edit-grid');
      if (!grid) return;
      const row = document.createElement('div');
      row.className = 'col-filter-edit-row';
      row.innerHTML = `<input class="input col-filter-edit-input" value="" placeholder="Column value…" maxlength="200" />
        <button class="col-filter-edit-remove" type="button" data-action="remove-col-filter" aria-label="Remove">×</button>`;
      grid.appendChild(row);
      row.querySelector('input').focus();
    }

    if (action === 'remove-col-filter') {
      const row  = e.target.closest('.col-filter-edit-row');
      const grid = row?.closest('.col-filter-edit-grid');
      if (!grid) return;
      if (grid.querySelectorAll('.col-filter-edit-row').length > 1) row.remove();
      else row.querySelector('input').value = '';
    }

    if (action === 'save-edit') {
      const form    = e.target.closest('form.rule-item__edit');
      const editId  = form?.dataset.editId;
      const errEl   = form?.querySelector('[data-role="edit-error"]');
      const grid    = form?.querySelector('.col-filter-edit-grid[data-table-edit]');

      let text, matchType;
      if (grid) {
        const vals = Array.from(grid.querySelectorAll('.col-filter-edit-input'))
          .map(i => i.value.trim()).filter(Boolean);
        if (!vals.length) { showError(errEl, 'Please enter at least one column value.'); return; }
        text      = buildTableRulePattern(vals);
        matchType = MATCH_TYPE.REGEX;
      } else {
        text      = form?.querySelector('[name="text"]')?.value.trim();
        matchType = form?.querySelector('[name="matchType"]')?.value;
        if (!text) { showError(errEl, 'Keyword cannot be empty.'); return; }
        if (matchType === MATCH_TYPE.REGEX) {
          const { valid, error } = validateRegex(text);
          if (!valid) { showError(errEl, `Invalid regex: ${error}`); return; }
        }
      }

      await updateKeyword(editId, {
        text,
        matchType,
        scopeSelector:  form.querySelector('[name="scope"]')?.value.trim() || '',
        urlScope:       readUrlBindingFromForm(form),
        webhookScope:   readWebhookBindingFromForm(form),
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
  const errEl = qs('#kwError');
  hideError(errEl);

  const text      = qs('#kwText').value.trim();
  const matchType = kwGetMatchType();
  if (!text) { showError(errEl, 'Please enter a keyword.'); return; }
  if (matchType === MATCH_TYPE.REGEX) {
    const { valid, error } = validateRegex(text);
    if (!valid) { showError(errEl, `Invalid regex: ${error}`); return; }
  }

  const label = qs('#kwLabel')?.value.trim() || '';

  const added = await addKeyword({
    text,
    matchType,
    label,
    scopeSelector:  qs('#kwScope')?.value.trim() ?? '',
    urlScope:       readUrlBindingFromContainer(qs('#kwUrlBinding')),
    enabled:        qs('#kwEnabled')?.checked ?? true,
    alertAppear:    qs('#kwAlertAppear')?.checked ?? true,
    alertDisappear: qs('#kwAlertDisappear')?.checked ?? true,
  });

  if (!added) {
    showError(qs('#kwError'), 'A rule with this pattern already exists.');
    return;
  }

  kwResetForm();
  await renderUrlBindingAddForm();
  await renderKeywords();
  await renderSidebarStatus();
  showToast('Rule saved!');
}

// ─── URLs ─────────────────────────────────────────────────────────────────────

async function renderUrls(filter = '') {
  const urls  = await getUrls();
  const list  = qs('#urlList');
  const badge = qs('#urlBadge');
  badge.textContent = urls.filter((u) => u.enabled).length;

  const filtered = filter
    ? urls.filter((u) => (u.label || u.pattern).toLowerCase().includes(filter.toLowerCase()))
    : urls;

  if (filtered.length === 0) {
    list.innerHTML = `<li class="rule-list__empty">${filter ? 'No matches.' : 'No URL rules yet. Add one from the extension popup.'}</li>`;
    return;
  }

  list.innerHTML = '';
  filtered.forEach((url) => {
    const li = document.createElement('li');
    li.className = 'rule-item';
    li.dataset.id = url.id;

    const typeLabel = URL_MATCH_TYPE_LABEL[url.matchType] || url.matchType;

    li.innerHTML = `
      <div class="rule-item__main${!url.enabled ? ' rule-item--disabled' : ''}">
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
  const urlHint = qs('#urlHint');

  const HINTS = {
    wildcard: '<strong>Wildcard:</strong> Use * as wildcard. E.g. <code>https://example.com/*</code>',
    exact:    '<strong>Exact URL:</strong> Matches only this precise URL.',
    domain:   '<strong>Domain-wide:</strong> Enter domain like <code>example.com</code> or <code>*.example.com</code>',
  };

  // Modifier-button group for match type
  qs('#section-urls')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.url-match-btns .modifier-btn');
    if (!btn) return;
    btn.closest('.url-match-btns').querySelectorAll('.modifier-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    if (urlHint) urlHint.innerHTML = HINTS[btn.dataset.match] || '';
  });

  // Search/filter
  qs('#urlSearch')?.addEventListener('input', (e) => {
    renderUrls(e.target.value);
  });

  // Add URL
  qs('#addUrlBtn')?.addEventListener('click', handleAddUrl);
  qs('#urlPattern')?.addEventListener('keydown', (e) => {
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
      if (matchType === URL_MATCH_TYPE.DOMAIN) {
        const stripped = pattern.replace(/^\*\./, '');
        if (/[:/]/.test(stripped)) {
          showError(errEl, 'Domain should be a hostname only, e.g. example.com');
          return;
        }
      } else {
        try {
          const parsed = new URL(pattern.replace(/\*/g, 'x'));
          if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            showError(errEl, 'Only http:// and https:// URLs are supported.');
            return;
          }
        } catch (_) { showError(errEl, 'Invalid URL format (e.g. https://example.com/*)'); return; }
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
  const matchType = qs('#section-urls .url-match-btns .modifier-btn.active')?.dataset.match ?? 'wildcard';
  const label     = qs('#urlLabel').value.trim();
  const errEl     = qs('#urlError');

  hideError(errEl);

  if (!pattern) { showError(errEl, 'Please enter a URL or pattern.'); return; }

  if (matchType === URL_MATCH_TYPE.DOMAIN) {
    const stripped = pattern.replace(/^\*\./, '');
    if (/[:/]/.test(stripped)) {
      showError(errEl, 'Domain should be a hostname only, e.g. example.com');
      return;
    }
  } else {
    try {
      const parsed = new URL(pattern.replace(/\*/g, 'x'));
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        showError(errEl, 'Only http:// and https:// URLs are supported.');
        return;
      }
    } catch (_) { showError(errEl, 'Invalid URL. Example: https://example.com/*'); return; }
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

function checkNotifPermission() {
  const banner = qs('#notifSectionBanner');
  if (!banner) return;

  const perm = Notification.permission;

  if (perm === 'granted') {
    banner.classList.add('hidden');
    return;
  }

  const warningIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:6px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
  banner.classList.remove('perm-banner--ok', 'hidden');

  if (perm === 'default') {
    banner.innerHTML = warningIcon +
      'Notifications are not yet allowed. ' +
      '<a href="#" id="grantNotifLink" style="color:inherit;font-weight:600;text-decoration:underline">Allow notifications \u2192</a>';
    qs('#grantNotifLink')?.addEventListener('click', async (e) => {
      e.preventDefault();
      await Notification.requestPermission();
      checkNotifPermission();
    });
  } else {
    banner.innerHTML = warningIcon +
      'Notifications are blocked in browser settings. ' +
      '<a href="#" id="openNotifSettings" style="color:inherit;font-weight:600;text-decoration:underline">Open settings \u2192</a>';
    qs('#openNotifSettings')?.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: 'chrome://settings/content/notifications' });
    });
  }

  banner.classList.remove('hidden');
}

async function renderNotifSettings() {
  checkNotifPermission();
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
        <div class="rule-item__text">“${escapeHtml(truncate(entry.keyword, 50))}” ${isAppear ? 'appeared' : 'disappeared'}</div>
        <div class="rule-item__meta">
          <span class="rule-item__tag ${isAppear ? 'rule-item__tag--appear' : 'rule-item__tag--disappear'}">${isAppear ? '↑ appear' : '↓ disappear'}</span>
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


// ─── Export / Import ──────────────────────────────────────────────────────────

async function doExport() {
  const [keywords, urls, webhooks, settings] = await Promise.all([
    getKeywords(), getUrls(), getWebhooks(), getSettings(),
  ]);
  const { version } = chrome.runtime.getManifest();
  const payload = JSON.stringify({ version, keywords, urls, webhooks, settings }, null, 2);
  const blob = new Blob([payload], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `textwatcher-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast(`Exported ${keywords.length} keyword${keywords.length !== 1 ? 's' : ''} · ${urls.length} URL${urls.length !== 1 ? 's' : ''} · ${webhooks.length} webhook${webhooks.length !== 1 ? 's' : ''}`);
}

function bindExportImport() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="export"]');
    if (btn) { doExport(); return; }
    if (e.target.closest('[data-action="import"]')) qs('#importFileInput').click();
  });

  qs('#importFileInput')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;

    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (_) {
      showToast('Invalid file - could not parse JSON.', 'error');
      return;
    }

    const incoming = {
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
      urls:     Array.isArray(parsed.urls)     ? parsed.urls     : [],
      webhooks: Array.isArray(parsed.webhooks) ? parsed.webhooks : [],
      settings: parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : null,
    };

    if (!incoming.keywords.length && !incoming.urls.length && !incoming.webhooks.length && !incoming.settings) {
      showToast('Nothing to import - file has no recognisable data.');
      return;
    }

    const [existingKws, existingUrls, existingWebhooks] = await Promise.all([
      getKeywords(), getUrls(), getWebhooks(),
    ]);

    const existingKwTexts = new Set(existingKws.map((k) => k.text));
    const existingUrlPats = new Set(existingUrls.map((u) => u.pattern));
    const existingWhKeys  = new Set(existingWebhooks.map((w) => `${w.url}|${w.format}`));

    const newKws      = incoming.keywords.filter((k) => k.text    && !existingKwTexts.has(k.text));
    const newUrls     = incoming.urls.filter((u)     => u.pattern && !existingUrlPats.has(u.pattern));
    const newWebhooks = incoming.webhooks.filter((w) => w.url     && !existingWhKeys.has(`${w.url}|${w.format}`));

    const saves = [
      saveKeywords([...existingKws, ...newKws]),
      saveUrls([...existingUrls, ...newUrls]),
      saveWebhooks([...existingWebhooks, ...newWebhooks]),
    ];
    if (incoming.settings) saves.push(saveSettings(incoming.settings));
    await Promise.all(saves);

    await Promise.all([renderKeywords(), renderUrls(), renderWebhookList(), renderSidebarStatus()]);
    if (incoming.settings) renderNotifSettings();

    const skipped = (incoming.keywords.length - newKws.length)
      + (incoming.urls.length - newUrls.length)
      + (incoming.webhooks.length - newWebhooks.length);
    const parts = [];
    if (newKws.length)      parts.push(`${newKws.length} keyword${newKws.length !== 1 ? 's' : ''}`);
    if (newUrls.length)     parts.push(`${newUrls.length} URL${newUrls.length !== 1 ? 's' : ''}`);
    if (newWebhooks.length) parts.push(`${newWebhooks.length} webhook${newWebhooks.length !== 1 ? 's' : ''}`);
    if (incoming.settings)  parts.push('settings');
    const msg = `Imported ${parts.join(' · ')}` + (skipped ? ` (${skipped} duplicate${skipped !== 1 ? 's' : ''} skipped)` : '');
    showToast(msg);
  });
}

// ─── Storage Change Listener ──────────────────────────────────────────────────

function listenForChanges() {
  onStorageChange(
    [STORAGE_KEY.KEYWORDS, STORAGE_KEY.URLS, STORAGE_KEY.SETTINGS,
     STORAGE_KEY.ALERT_HISTORY, STORAGE_KEY.ENABLED,
     STORAGE_KEY.WEBHOOKS],
    async (changes) => {
      if (STORAGE_KEY.KEYWORDS      in changes) await renderKeywords();
      if (STORAGE_KEY.URLS          in changes) { await renderUrls(); await renderUrlBindingAddForm(); }
      if (STORAGE_KEY.SETTINGS      in changes) { await renderNotifSettings(); }
      if (STORAGE_KEY.ALERT_HISTORY in changes) await renderAlertHistory();
      if (STORAGE_KEY.WEBHOOKS      in changes) await renderWebhookList();
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

// ─── Webhooks ─────────────────────────────────────────────────────────────────


const FORMAT_LABELS = {
  [WEBHOOK_FORMAT.TEAMS]:    'Teams',
  [WEBHOOK_FORMAT.SLACK]:    'Slack',
  [WEBHOOK_FORMAT.TELEGRAM]: 'Telegram',
  [WEBHOOK_FORMAT.GENERIC]:  'Generic',
};

function buildPayloadPreviews() {
  const ts = localISOString(new Date());
  const ms = Date.now();
  return {
    [WEBHOOK_FORMAT.TEAMS]: `{
  "@type":    "MessageCard",
  "@context": "http://schema.org/extensions",
  "themeColor": "3388ff",
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

async function renderWebhookList() {
  const webhooks = await getWebhooks();
  const list = qs('#webhookList');
  if (!list) return;

  if (webhooks.length === 0) {
    list.innerHTML = '<li class="rule-list__empty">No webhooks yet. Click <strong>Add Webhook</strong> to create one.</li>';
    return;
  }

  list.innerHTML = '';
  webhooks.forEach((wh) => {
    const li = document.createElement('li');
    li.className = 'rule-item';
    li.dataset.id = wh.id;

    const formatLabel = FORMAT_LABELS[wh.format] || wh.format;
    const urlDisplay  = wh.url ? truncate(wh.url, 40) : '<em>no URL</em>';

    li.innerHTML = `
      <div class="rule-item__main${!wh.enabled ? ' rule-item--disabled' : ''}">
        <div class="rule-item__text">${escapeHtml(wh.name || 'Unnamed')}</div>
        <div class="rule-item__meta">
          <span class="rule-item__tag rule-item__tag--match">${escapeHtml(formatLabel)}</span>
          <span class="rule-item__tag">${urlDisplay}</span>
          ${!wh.enabled ? '<span class="rule-item__tag">disabled</span>' : ''}
        </div>
      </div>
      <div class="rule-item__actions">
        <button class="btn--icon" data-action="toggle-wh" data-id="${wh.id}" title="${wh.enabled ? 'Disable' : 'Enable'}">${wh.enabled ? SVG_PAUSE : SVG_PLAY}</button>
        <button class="btn--icon" data-action="edit-wh" data-id="${wh.id}" title="Edit">${SVG_EDIT}</button>
        <button class="btn--icon" data-action="test-wh" data-id="${wh.id}" title="Send test payload"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>
        <button class="btn--icon del" data-action="delete-wh" data-id="${wh.id}" title="Delete"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>`;
    list.appendChild(li);
  });
}

function buildWebhookEditForm(wh) {
  const format   = wh?.format || WEBHOOK_FORMAT.TEAMS;
  const previews = buildPayloadPreviews();
  const isTelegram = format === WEBHOOK_FORMAT.TELEGRAM;
  const formatOptions = Object.values(WEBHOOK_FORMAT)
    .map((f) => `<option value="${f}"${f === format ? ' selected' : ''}>${FORMAT_LABELS[f]}</option>`)
    .join('');

  return `<div class="rule-item__edit" data-edit-id="${wh?.id || ''}">
    <div class="rule-item__edit-row">
      <input class="input" name="whName" placeholder="Webhook name (e.g. Slack alerts)" value="${escapeHtml(wh?.name || '')}" maxlength="80" />
      <label class="toggle" title="Enabled"><input type="checkbox" name="whEnabled" ${wh?.enabled !== false ? 'checked' : ''}/><span class="toggle__track"></span></label>
    </div>
    <div class="rule-item__edit-row">
      <input class="input" name="whUrl" placeholder="${isTelegram ? 'https://api.telegram.org/bot{TOKEN}/sendMessage' : 'https://your-server.com/webhook'}" value="${escapeHtml(wh?.url || '')}" maxlength="500" autocomplete="off" spellcheck="false" />
      <select class="select" name="whFormat">${formatOptions}</select>
    </div>
    <div class="rule-item__edit-row" name="whTelegramRow" style="${isTelegram ? '' : 'display:none'}">
      <input class="input" name="whTelegramChatId" placeholder="-1001234567890 or @channelname" value="${escapeHtml(wh?.telegramChatId || '')}" maxlength="100" />
    </div>
    <div class="rule-item__edit-row webhook-secret-row">
      <input type="password" class="input" name="whSecret" placeholder="${wh?.secret ? '••••••••• (saved — enter new value to change)' : 'Secret header (optional)'}" maxlength="200" autocomplete="new-password" />
      <button type="button" class="btn btn--ghost webhook-secret-toggle" title="Show/hide secret"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
    </div>
    <p class="error-msg hidden" name="whUrlError"></p>
    <div class="rule-item__edit-checks">
      <label><input type="checkbox" name="whOnAppear" ${wh?.onAppear !== false ? 'checked' : ''}/> Send when keyword <strong>appears</strong></label>
      <label><input type="checkbox" name="whOnDisappear" ${wh?.onDisappear !== false ? 'checked' : ''}/> Send when keyword <strong>disappears</strong></label>
    </div>
    <details class="payload-preview-details" style="margin-top:8px;">
      <summary class="payload-preview-summary">Payload Preview</summary>
      <pre class="webhook-payload-preview" name="whPreview">${escapeHtml(previews[format] || previews[WEBHOOK_FORMAT.GENERIC])}</pre>
    </details>
    <div class="rule-item__edit-actions">
      <button class="btn btn--primary btn--sm" data-action="save-wh">Save</button>
      <button class="btn btn--ghost btn--sm" data-action="cancel-wh">Cancel</button>
      <span class="webhook-test-result hidden" name="whTestResult" style="margin-left:8px;"></span>
    </div>
  </div>`;
}

function validateWebhookUrl(url) {
  if (!url) return 'URL is required.';
  try {
    const u = new URL(url);
    const ok = u.protocol === 'https:' ||
      (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'));
    return ok ? null : 'Must be https:// or http://localhost.';
  } catch (_) {
    return 'Invalid URL.';
  }
}

function bindWebhookListEvents() {
  qs('#addWebhookBtn')?.addEventListener('click', () => {
    const list = qs('#webhookList');
    // If a new-webhook form is already open, close it
    const existing = list.querySelector('.rule-item[data-new]');
    if (existing) { existing.remove(); return; }
    // Clear empty-state placeholder and inject a new-item row
    if (list.querySelector('.rule-list__empty')) list.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'rule-item';
    li.dataset.new = '1';
    li.innerHTML = buildWebhookEditForm(null);
    list.prepend(li);
    li.querySelector('[name="whName"]')?.focus();
    bindEditFormInteractions(li);
  });

  qs('#webhookList')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;
    const li = btn.closest('li.rule-item');

    if (action === 'toggle-wh') {
      const webhooks = await getWebhooks();
      const wh = webhooks.find((w) => w.id === id);
      if (wh) await updateWebhook(id, { enabled: !wh.enabled });
      await renderWebhookList();
    }

    if (action === 'edit-wh') {
      if (li.querySelector('.rule-item__edit')) {
        await renderWebhookList(); return;
      }
      const webhooks = await getWebhooks();
      const wh = webhooks.find((w) => w.id === id);
      if (!wh) return;
      li.insertAdjacentHTML('beforeend', buildWebhookEditForm(wh));
      bindEditFormInteractions(li);
    }

    if (action === 'cancel-wh') {
      if (li.dataset.new) { li.remove(); return; }
      await renderWebhookList();
    }

    if (action === 'save-wh') {
      const form   = li.querySelector('.rule-item__edit');
      const editId = form.dataset.editId;
      const url    = form.querySelector('[name="whUrl"]').value.trim();
      const urlErr = form.querySelector('[name="whUrlError"]');
      const urlMsg = validateWebhookUrl(url);
      if (urlMsg) {
        showError(urlErr, urlMsg);
        form.querySelector('[name="whUrl"]').focus();
        return;
      }
      hideError(urlErr);

      const secret = form.querySelector('[name="whSecret"]').value;
      const patch  = {
        name:           form.querySelector('[name="whName"]').value.trim() || 'Unnamed',
        enabled:        form.querySelector('[name="whEnabled"]').checked,
        url,
        format:         form.querySelector('[name="whFormat"]').value,
        telegramChatId: form.querySelector('[name="whTelegramChatId"]').value.trim(),
        onAppear:       form.querySelector('[name="whOnAppear"]').checked,
        onDisappear:    form.querySelector('[name="whOnDisappear"]').checked,
      };
      if (secret) patch.secret = secret;

      if (editId) {
        await updateWebhook(editId, patch);
        showToast('Webhook saved!');
      } else {
        await addWebhook(patch);
        showToast('Webhook added!');
      }
      await renderWebhookList();
    }

    if (action === 'delete-wh') {
      await removeWebhook(id);
      await renderWebhookList();
      showToast('Webhook deleted.');
    }

    if (action === 'test-wh') {
      const resultEl = document.createElement('span');
      resultEl.className = 'webhook-test-result';
      resultEl.textContent = 'Sending…';
      btn.after(resultEl);

      let result;
      try {
        result = await chrome.runtime.sendMessage({ type: MSG.TEST_WEBHOOK, webhookId: id });
      } catch (err) {
        resultEl.className = 'webhook-test-result webhook-test-result--err';
        resultEl.textContent = `Error: ${err.message}`;
        return;
      }
      if (!result || !result.sent) {
        resultEl.className = 'webhook-test-result webhook-test-result--err';
        resultEl.textContent = result?.error ? `Failed: ${result.error}` : 'No response.';
        return;
      }
      const ok = result.status >= 200 && result.status < 300;
      resultEl.className = `webhook-test-result webhook-test-result--${ok ? 'ok' : 'warn'}`;
      resultEl.textContent = ok ? `✓ ${result.status}` : `⚠ ${result.status}`;
      setTimeout(() => resultEl.remove(), 4000);
    }
  });
}

function bindEditFormInteractions(li) {
  // Format change: show/hide Telegram row + update payload preview
  li.querySelector('[name="whFormat"]')?.addEventListener('change', (e) => {
    const form       = li.querySelector('.rule-item__edit');
    const format     = e.target.value;
    const isTelegram = format === WEBHOOK_FORMAT.TELEGRAM;
    const tgRow      = form.querySelector('[name="whTelegramRow"]');
    if (tgRow) tgRow.style.display = isTelegram ? '' : 'none';
    const urlInput = form.querySelector('[name="whUrl"]');
    if (isTelegram && !urlInput.value) {
      urlInput.placeholder = 'https://api.telegram.org/bot{TOKEN}/sendMessage';
    } else if (!isTelegram) {
      urlInput.placeholder = 'https://your-server.com/webhook';
    }
    const preview = form.querySelector('[name="whPreview"]');
    if (preview) {
      const previews = buildPayloadPreviews();
      preview.textContent = previews[format] || previews[WEBHOOK_FORMAT.GENERIC];
    }
  });

  // Secret visibility toggle
  li.querySelector('.webhook-secret-toggle')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const inp = li.querySelector('[name="whSecret"]');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    btn.innerHTML = show
      ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`
      : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
  });
}

// ─── Toast ────────────────────────────────────────────────────────────────────

let toastTimer;
function showToast(msg, type = 'success') {
  const el = qs('#toast');
  el.textContent = msg;
  el.className = `toast toast--${type}`;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2500);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function showError(el, msg) { el.textContent = msg; el.classList.remove('hidden'); }
function hideError(el)      { el.textContent = '';  el.classList.add('hidden'); }

// ─── Start ────────────────────────────────────────────────────────────────────
init();
