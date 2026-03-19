/**
 * tests/unit/service-worker.test.js
 * Unit tests for the three exported pure functions in service-worker.js:
 *   - isAllowedWebhookUrl
 *   - buildWebhookPayload
 *   - shouldSendAlert
 *
 * The service worker registers Chrome event listeners at the top level.
 * All chrome.* APIs are stubbed in setup.js so the module loads cleanly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isAllowedWebhookUrl,
  buildWebhookPayload,
  shouldSendAlert,
} from '../../src/background/service-worker.js';

import { WEBHOOK_FORMAT, ALERT_EVENT, NOTIF_FREQUENCY } from '../../src/shared/constants.js';

// ─── isAllowedWebhookUrl ──────────────────────────────────────────────────────

describe('isAllowedWebhookUrl', () => {
  describe('allowed', () => {
    it('allows HTTPS on any host', () => {
      expect(isAllowedWebhookUrl('https://hooks.slack.com/services/abc')).toBe(true);
    });
    it('allows HTTPS with port', () => {
      expect(isAllowedWebhookUrl('https://example.com:8443/hook')).toBe(true);
    });
    it('allows HTTP on localhost', () => {
      expect(isAllowedWebhookUrl('http://localhost:3000/webhook')).toBe(true);
    });
    it('allows HTTP on 127.0.0.1', () => {
      expect(isAllowedWebhookUrl('http://127.0.0.1:9000/hook')).toBe(true);
    });
  });

  describe('blocked', () => {
    it('blocks HTTP on a public host', () => {
      expect(isAllowedWebhookUrl('http://example.com/webhook')).toBe(false);
    });
    it('blocks file:// URIs', () => {
      expect(isAllowedWebhookUrl('file:///etc/passwd')).toBe(false);
    });
    it('blocks javascript: URIs', () => {
      expect(isAllowedWebhookUrl('javascript:alert(1)')).toBe(false);
    });
    it('blocks data: URIs', () => {
      expect(isAllowedWebhookUrl('data:text/html,<h1>hi</h1>')).toBe(false);
    });
    it('blocks plain strings that are not URLs', () => {
      expect(isAllowedWebhookUrl('not-a-url')).toBe(false);
    });
    it('blocks empty string', () => {
      expect(isAllowedWebhookUrl('')).toBe(false);
    });
    it('blocks HTTP on a host that contains "localhost" as a substring', () => {
      // "notlocalhost.com" must NOT be allowed
      expect(isAllowedWebhookUrl('http://notlocalhost.com/webhook')).toBe(false);
    });
  });
});

// ─── buildWebhookPayload ──────────────────────────────────────────────────────

const BASE_PAYLOAD = {
  event:     ALERT_EVENT.APPEARS,
  keyword:   'deploy',
  matchType: 'contains',
  url:       'https://example.com/status',
  title:     'Status Page',
  snippet:   'deploy completed successfully',
  timestamp: new Date('2025-01-15T12:00:00.000Z').getTime(),
};

describe('buildWebhookPayload', () => {
  describe('TEAMS format', () => {
    const cfg = { format: WEBHOOK_FORMAT.TEAMS, telegramChatId: '' };

    it('produces a valid JSON string', () => {
      expect(() => JSON.parse(buildWebhookPayload(cfg, BASE_PAYLOAD))).not.toThrow();
    });

    it('includes @type MessageCard', () => {
      const body = JSON.parse(buildWebhookPayload(cfg, BASE_PAYLOAD));
      expect(body['@type']).toBe('MessageCard');
    });

    it('uses blue themeColor for "appears" event', () => {
      const body = JSON.parse(buildWebhookPayload(cfg, BASE_PAYLOAD));
      expect(body.themeColor).toBe('3388ff');
    });

    it('uses red themeColor for "disappears" event', () => {
      const disappears = { ...BASE_PAYLOAD, event: ALERT_EVENT.DISAPPEARS };
      const body = JSON.parse(buildWebhookPayload(cfg, disappears));
      expect(body.themeColor).toBe('dc3545');
    });

    it('includes keyword in the summary', () => {
      const body = JSON.parse(buildWebhookPayload(cfg, BASE_PAYLOAD));
      expect(body.summary).toContain('deploy');
    });

    it('includes a potentialAction to open the page', () => {
      const body = JSON.parse(buildWebhookPayload(cfg, BASE_PAYLOAD));
      expect(body.potentialAction).toHaveLength(1);
      expect(body.potentialAction[0]['@type']).toBe('OpenUri');
    });
  });

  describe('SLACK format', () => {
    const cfg = { format: WEBHOOK_FORMAT.SLACK };

    it('produces valid JSON with text field', () => {
      const body = JSON.parse(buildWebhookPayload(cfg, BASE_PAYLOAD));
      expect(body.text).toBeTruthy();
      expect(body.username).toBe('TextWatcher');
    });

    it('includes keyword in text', () => {
      const body = JSON.parse(buildWebhookPayload(cfg, BASE_PAYLOAD));
      expect(body.text).toContain('deploy');
    });
  });

  describe('TELEGRAM format', () => {
    const cfg = { format: WEBHOOK_FORMAT.TELEGRAM, telegramChatId: '-100123456' };

    it('produces valid JSON with chat_id and text', () => {
      const body = JSON.parse(buildWebhookPayload(cfg, BASE_PAYLOAD));
      expect(body.chat_id).toBe('-100123456');
      expect(body.text).toContain('deploy');
      expect(body.parse_mode).toBe('Markdown');
    });
  });

  describe('GENERIC format', () => {
    const cfg = { format: WEBHOOK_FORMAT.GENERIC };

    it('produces valid JSON with all standard fields', () => {
      const body = JSON.parse(buildWebhookPayload(cfg, BASE_PAYLOAD));
      expect(body.event).toBe(ALERT_EVENT.APPEARS);
      expect(body.keyword).toBe('deploy');
      expect(body.matchType).toBe('contains');
      expect(body.url).toBe('https://example.com/status');
      expect(body.source).toBe('TextWatcher');
    });

    it('includes an ISO-8601 timestamp', () => {
      const body = JSON.parse(buildWebhookPayload(cfg, BASE_PAYLOAD));
      // Matches basic ISO-8601 pattern
      expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('includes timestamp_ms as a number', () => {
      const body = JSON.parse(buildWebhookPayload(cfg, BASE_PAYLOAD));
      expect(typeof body.timestamp_ms).toBe('number');
    });

    it('snippet can be null for disappears events', () => {
      const disappears = { ...BASE_PAYLOAD, event: ALERT_EVENT.DISAPPEARS, snippet: null };
      const body = JSON.parse(buildWebhookPayload(cfg, disappears));
      expect(body.snippet).toBeNull();
    });

    it('falls back to GENERIC for unknown format', () => {
      const unknownCfg = { format: 'unknown_format' };
      const body = JSON.parse(buildWebhookPayload(unknownCfg, BASE_PAYLOAD));
      expect(body.source).toBe('TextWatcher'); // generic structure
    });
  });
});

// ─── shouldSendAlert ──────────────────────────────────────────────────────────

describe('shouldSendAlert', () => {
  describe('EVERY_OCCURRENCE', () => {
    const settings = { notifFrequency: NOTIF_FREQUENCY.EVERY_OCCURRENCE };

    it('always returns true', () => {
      expect(shouldSendAlert(1, 'kw-1', ALERT_EVENT.APPEARS, settings)).toBe(true);
      expect(shouldSendAlert(1, 'kw-1', ALERT_EVENT.APPEARS, settings)).toBe(true);
      expect(shouldSendAlert(1, 'kw-1', ALERT_EVENT.APPEARS, settings)).toBe(true);
    });
  });

  describe('ONCE_PER_PAGE', () => {
    const settings = { notifFrequency: NOTIF_FREQUENCY.ONCE_PER_PAGE };

    it('always returns true (gate lives in content script, not service worker)', () => {
      // The service worker defers this check to the content script and always passes
      expect(shouldSendAlert(10, 'kw-2', ALERT_EVENT.APPEARS, settings)).toBe(true);
      expect(shouldSendAlert(10, 'kw-2', ALERT_EVENT.APPEARS, settings)).toBe(true);
    });
  });

  describe('COOLDOWN', () => {
    it('returns true on first call', () => {
      const settings = { notifFrequency: NOTIF_FREQUENCY.COOLDOWN, cooldownSeconds: 60 };
      expect(shouldSendAlert(20, 'kw-cool-1', ALERT_EVENT.APPEARS, settings)).toBe(true);
    });

    it('returns false on a second immediate call within the cooldown window', () => {
      const settings = { notifFrequency: NOTIF_FREQUENCY.COOLDOWN, cooldownSeconds: 60 };
      const tabId = 21;
      const kwId  = 'kw-cool-2';
      shouldSendAlert(tabId, kwId, ALERT_EVENT.APPEARS, settings); // first — primes the map
      expect(shouldSendAlert(tabId, kwId, ALERT_EVENT.APPEARS, settings)).toBe(false);
    });

    it('is keyed by tabId+keywordId+event — different event fires independently', () => {
      const settings = { notifFrequency: NOTIF_FREQUENCY.COOLDOWN, cooldownSeconds: 60 };
      const tabId = 22;
      const kwId  = 'kw-cool-3';
      shouldSendAlert(tabId, kwId, ALERT_EVENT.APPEARS, settings);
      // Disappears event has its own cooldown key — should still fire
      expect(shouldSendAlert(tabId, kwId, ALERT_EVENT.DISAPPEARS, settings)).toBe(true);
    });

    it('is keyed per tab — same keyword on different tabs fires independently', () => {
      const settings = { notifFrequency: NOTIF_FREQUENCY.COOLDOWN, cooldownSeconds: 60 };
      const kwId = 'kw-cool-4';
      shouldSendAlert(30, kwId, ALERT_EVENT.APPEARS, settings);
      // Different tabId — should fire
      expect(shouldSendAlert(31, kwId, ALERT_EVENT.APPEARS, settings)).toBe(true);
    });

    it('returns true again after the cooldown expires', () => {
      vi.useFakeTimers();
      const settings = { notifFrequency: NOTIF_FREQUENCY.COOLDOWN, cooldownSeconds: 5 };
      const tabId = 40;
      const kwId  = 'kw-cool-5';

      shouldSendAlert(tabId, kwId, ALERT_EVENT.APPEARS, settings); // primes
      expect(shouldSendAlert(tabId, kwId, ALERT_EVENT.APPEARS, settings)).toBe(false); // within cooldown

      vi.advanceTimersByTime(6000); // advance past cooldown
      expect(shouldSendAlert(tabId, kwId, ALERT_EVENT.APPEARS, settings)).toBe(true);

      vi.useRealTimers();
    });

    it('uses 5s default when cooldownSeconds is missing', () => {
      vi.useFakeTimers();
      const settings = { notifFrequency: NOTIF_FREQUENCY.COOLDOWN }; // no cooldownSeconds
      const tabId = 50;
      const kwId  = 'kw-cool-6';

      shouldSendAlert(tabId, kwId, ALERT_EVENT.APPEARS, settings);
      expect(shouldSendAlert(tabId, kwId, ALERT_EVENT.APPEARS, settings)).toBe(false);

      vi.advanceTimersByTime(6000);
      expect(shouldSendAlert(tabId, kwId, ALERT_EVENT.APPEARS, settings)).toBe(true);

      vi.useRealTimers();
    });
  });
});
