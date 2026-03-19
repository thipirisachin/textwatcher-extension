/**
 * tests/unit/utils.test.js
 * Unit tests for src/shared/utils.js
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  debounce,
  truncate,
  escapeHtml,
  timeAgo,
  MATCH_TYPE_LABEL,
  URL_MATCH_TYPE_LABEL,
  onStorageChange,
} from '../../src/shared/utils.js';

// ─── truncate ─────────────────────────────────────────────────────────────────

describe('truncate', () => {
  it('returns the string unchanged when shorter than maxLen', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('returns the string unchanged when exactly maxLen', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('truncates and appends ellipsis when longer than maxLen', () => {
    const result = truncate('hello world', 8);
    expect(result).toHaveLength(8);
    expect(result.endsWith('…')).toBe(true);
  });

  it('uses 60 as the default maxLen', () => {
    const long = 'a'.repeat(61);
    const result = truncate(long);
    expect(result).toHaveLength(60);
    expect(result.endsWith('…')).toBe(true);
  });

  it('returns the original value for falsy input', () => {
    expect(truncate('')).toBe('');
    expect(truncate(null)).toBe(null);
    expect(truncate(undefined)).toBe(undefined);
  });
});

// ─── escapeHtml ───────────────────────────────────────────────────────────────

describe('escapeHtml', () => {
  it('escapes ampersand', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes less-than', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
  });

  it('escapes double quotes', () => {
    expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;');
  });

  it('escapes single quotes', () => {
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });

  it('escapes all five characters in one string', () => {
    const result = escapeHtml(`<div class="a" id='b'>&</div>`);
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
    expect(result).not.toContain('"');
    expect(result).not.toContain("'");
    expect(result).not.toContain('&amp;amp;'); // should not double-escape
    expect(result).toContain('&amp;');
  });

  it('returns safe string unchanged', () => {
    expect(escapeHtml('hello world 123')).toBe('hello world 123');
  });

  it('prevents XSS injection pattern by escaping angle brackets', () => {
    const xss = '<img src=x onerror="alert(1)">';
    const escaped = escapeHtml(xss);
    // The angle brackets must be escaped — without them the tag cannot execute
    expect(escaped).not.toContain('<');
    expect(escaped).not.toContain('>');
    // The output must contain the escaped representations
    expect(escaped).toContain('&lt;');
    expect(escaped).toContain('&gt;');
    // Quotes inside attribute value are also escaped
    expect(escaped).not.toContain('"alert');
    expect(escaped).toContain('&quot;');
  });
});

// ─── timeAgo ──────────────────────────────────────────────────────────────────

describe('timeAgo', () => {
  it('returns "just now" for timestamps within the last 60 seconds', () => {
    expect(timeAgo(Date.now() - 30_000)).toBe('just now');
    expect(timeAgo(Date.now() - 1_000)).toBe('just now');
  });

  it('returns minutes for 1-59 minute old timestamps', () => {
    expect(timeAgo(Date.now() - 5 * 60_000)).toBe('5m ago');
    expect(timeAgo(Date.now() - 59 * 60_000)).toBe('59m ago');
  });

  it('returns hours for 1-23 hour old timestamps', () => {
    expect(timeAgo(Date.now() - 3 * 3600_000)).toBe('3h ago');
    expect(timeAgo(Date.now() - 23 * 3600_000)).toBe('23h ago');
  });

  it('returns days for timestamps >= 24 hours old', () => {
    expect(timeAgo(Date.now() - 2 * 86400_000)).toBe('2d ago');
    expect(timeAgo(Date.now() - 7 * 86400_000)).toBe('7d ago');
  });
});

// ─── debounce ─────────────────────────────────────────────────────────────────

describe('debounce', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(()  => { vi.useRealTimers(); });

  it('does not call fn immediately', () => {
    const fn      = vi.fn();
    const debounced = debounce(fn, 100);
    debounced();
    expect(fn).not.toHaveBeenCalled();
  });

  it('calls fn after the delay elapses', () => {
    const fn      = vi.fn();
    const debounced = debounce(fn, 100);
    debounced();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('resets the timer on each call — only fires once after last call', () => {
    const fn      = vi.fn();
    const debounced = debounce(fn, 100);
    debounced();
    vi.advanceTimersByTime(50);
    debounced();
    vi.advanceTimersByTime(50);
    expect(fn).not.toHaveBeenCalled(); // 50ms since last call — not fired yet
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('passes the most recent arguments to fn', () => {
    const fn      = vi.fn();
    const debounced = debounce(fn, 100);
    debounced('first');
    debounced('second');
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledWith('second');
  });
});

// ─── MATCH_TYPE_LABEL ─────────────────────────────────────────────────────────

describe('MATCH_TYPE_LABEL', () => {
  it('has labels for all six match types', () => {
    const keys = ['exact_case', 'exact_nocase', 'contains', 'starts_with', 'ends_with', 'regex'];
    for (const k of keys) {
      expect(MATCH_TYPE_LABEL[k], `Missing label for "${k}"`).toBeTruthy();
    }
  });

  it('exact_case label accurately reflects contains (not whole-string) behaviour', () => {
    // Must NOT claim "Exact" which implies whole-string match — it is a contains search
    expect(MATCH_TYPE_LABEL['exact_case'].toLowerCase()).not.toBe('exact (case-sensitive)');
    expect(MATCH_TYPE_LABEL['exact_case'].toLowerCase()).toContain('contains');
  });

  it('exact_nocase label accurately reflects contains behaviour', () => {
    expect(MATCH_TYPE_LABEL['exact_nocase'].toLowerCase()).toContain('contains');
  });

  it('all label values are non-empty strings', () => {
    for (const [k, v] of Object.entries(MATCH_TYPE_LABEL)) {
      expect(typeof v, `Label for "${k}" is not a string`).toBe('string');
      expect(v.length, `Label for "${k}" is empty`).toBeGreaterThan(0);
    }
  });
});

describe('URL_MATCH_TYPE_LABEL', () => {
  it('has labels for exact, wildcard, and domain', () => {
    expect(URL_MATCH_TYPE_LABEL['exact']).toBeTruthy();
    expect(URL_MATCH_TYPE_LABEL['wildcard']).toBeTruthy();
    expect(URL_MATCH_TYPE_LABEL['domain']).toBeTruthy();
  });
});

// ─── onStorageChange ──────────────────────────────────────────────────────────

describe('onStorageChange', () => {
  it('registers a listener on chrome.storage.onChanged', () => {
    const handler = vi.fn();
    onStorageChange(['tw_keywords'], handler);
    expect(chrome.storage.onChanged.addListener).toHaveBeenCalled();
  });

  it('returns an unsubscribe function that removes the listener', () => {
    const handler   = vi.fn();
    const unsubscribe = onStorageChange(['tw_keywords'], handler);
    unsubscribe();
    expect(chrome.storage.onChanged.removeListener).toHaveBeenCalled();
  });

  it('only calls handler for watched keys', () => {
    // Grab the listener that was registered
    let capturedListener;
    chrome.storage.onChanged.addListener.mockImplementation((fn) => {
      capturedListener = fn;
    });

    const handler = vi.fn();
    onStorageChange(['tw_keywords'], handler);

    // Simulate a change to an unwatched key
    capturedListener({ tw_settings: { newValue: {} } }, 'local');
    expect(handler).not.toHaveBeenCalled();

    // Simulate a change to a watched key
    capturedListener({ tw_keywords: { newValue: [] } }, 'local');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('ignores changes from non-local areas', () => {
    let capturedListener;
    chrome.storage.onChanged.addListener.mockImplementation((fn) => {
      capturedListener = fn;
    });

    const handler = vi.fn();
    onStorageChange(['tw_keywords'], handler);

    capturedListener({ tw_keywords: { newValue: [] } }, 'sync');
    expect(handler).not.toHaveBeenCalled();
  });
});
