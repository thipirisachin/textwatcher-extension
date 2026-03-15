/**
 * constants.js
 * Central place for all app-wide constants.
 * Never hardcode magic strings anywhere else — import from here.
 */

// ─── Match Types ────────────────────────────────────────────────────────────
export const MATCH_TYPE = Object.freeze({
  EXACT_CASE:        'exact_case',       // "Hello" matches only "Hello"
  EXACT_NOCASE:      'exact_nocase',     // "Hello" matches "hello", "HELLO"
  CONTAINS:          'contains',         // "ell" matches "Hello"
  STARTS_WITH:       'starts_with',      // "Hel" matches "Hello World"
  ENDS_WITH:         'ends_with',        // "rld" matches "Hello World"
  REGEX:             'regex',            // Any valid JS regex
});

// ─── URL Match Types ─────────────────────────────────────────────────────────
export const URL_MATCH_TYPE = Object.freeze({
  EXACT:             'exact',            // https://example.com/page exactly
  WILDCARD:          'wildcard',         // https://example.com/* 
  DOMAIN:            'domain',           // *.example.com or example.com
});

// ─── Alert Events ────────────────────────────────────────────────────────────
export const ALERT_EVENT = Object.freeze({
  APPEARS:           'appears',
  DISAPPEARS:        'disappears',
});

// ─── Notification Frequency ──────────────────────────────────────────────────
export const NOTIF_FREQUENCY = Object.freeze({
  ONCE_PER_PAGE:     'once_per_page',    // Once per page load
  EVERY_OCCURRENCE:  'every_occurrence', // Every time text changes
  COOLDOWN:          'cooldown',         // Max once every N seconds
});

// ─── Badge State ─────────────────────────────────────────────────────────────
export const BADGE_COLOR = Object.freeze({
  ACTIVE:            '#22c55e',          // Green — monitoring, no match
  MATCH:             '#ef4444',          // Red   — match found
  INACTIVE:          '#6b7280',          // Gray  — extension paused
});

// ─── Storage Keys ────────────────────────────────────────────────────────────
export const STORAGE_KEY = Object.freeze({
  KEYWORDS:          'tw_keywords',      // Array of keyword rule objects
  URLS:              'tw_urls',          // Array of URL rule objects
  SETTINGS:          'tw_settings',      // Global settings object
  HISTORY:           'tw_history',       // Last 10 saved setups
  ALERT_HISTORY:     'tw_alert_history', // Last 50 alert events (what fired)
  ENABLED:           'tw_enabled',       // Master on/off boolean
  ONBOARDED:         'tw_onboarded',     // true once first-install setup is done
  WEBHOOK:           'tw_webhook',       // Webhook configuration object
});

// ─── Message Types (content <-> background) ──────────────────────────────────
export const MSG = Object.freeze({
  TEXT_APPEARED:     'text_appeared',
  TEXT_DISAPPEARED:  'text_disappeared',
  GET_STATE:         'get_state',
  RELOAD_RULES:      'reload_rules',
  TEST_WEBHOOK:      'test_webhook',     // Options page → SW: fire a test payload
});

// ─── Webhook Payload Formats ──────────────────────────────────────────────────
export const WEBHOOK_FORMAT = Object.freeze({
  TEAMS:    'teams',
  SLACK:    'slack',
  TELEGRAM: 'telegram',
  GENERIC:  'generic',
});

// ─── Default Webhook Settings ─────────────────────────────────────────────────
export const DEFAULT_WEBHOOK = Object.freeze({
  enabled:        false,
  url:            '',
  secret:         '',   // Sent as X-TextWatcher-Secret header
  format:         'teams',
  telegramChatId: '',
  onAppear:       true,
  onDisappear:    true,
});

// ─── Keyword URL Scope ────────────────────────────────────────────────────────
// urlScope field on a keyword rule:
//   'all'        → monitor on every matched URL (default, backwards-compatible)
//   string[]     → array of URL rule IDs; only monitor on those specific URLs
export const URL_SCOPE_ALL = 'all';

// ─── Limits ──────────────────────────────────────────────────────────────────
export const LIMITS = Object.freeze({
  MAX_KEYWORDS:      100,
  MAX_URLS:          100,
  MAX_HISTORY:       10,                 // Store last 10 setups
  MAX_ALERT_HISTORY: 50,                 // Store last 50 alert events
  DEBOUNCE_MS:       50,                 // MutationObserver debounce
  COOLDOWN_DEFAULT:  5,                  // Default cooldown in seconds
  SNIPPET_CHARS:     80,                 // Characters of context around match
});

// ─── Default Settings ────────────────────────────────────────────────────────
export const DEFAULT_SETTINGS = Object.freeze({
  enabled:               true,

  // Notification frequency
  notifFrequency:        NOTIF_FREQUENCY.EVERY_OCCURRENCE,
  cooldownSeconds:       LIMITS.COOLDOWN_DEFAULT,

  // Badge
  badgeEnabled:          true,

  // Notification content
  showSnippet:           true,
  showMatchType:         true,
  showUrl:               true,
});
