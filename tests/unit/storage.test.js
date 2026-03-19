/**
 * tests/unit/storage.test.js
 * Unit tests for src/shared/storage.js
 * Uses the in-memory Chrome storage mock from setup.js.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetStorage, localStore } from './setup.js';

import {
  getSettings,
  saveSettings,
  getEnabled,
  setEnabled,
  getKeywords,
  saveKeywords,
  addKeyword,
  removeKeyword,
  getUrls,
  saveUrls,
  addUrl,
  removeUrl,
  saveHistorySnapshot,
  getHistory,
  restoreHistoryEntry,
  removeHistoryEntry,
  getAlertHistory,
  addAlertEvent,
  clearAlertHistory,
  generateId,
} from '../../src/shared/storage.js';

import { DEFAULT_SETTINGS, LIMITS } from '../../src/shared/constants.js';

// Reset storage before every test to prevent state leakage between tests.
beforeEach(() => resetStorage());

// ─── generateId ───────────────────────────────────────────────────────────────

describe('generateId', () => {
  it('returns a string', () => {
    expect(typeof generateId()).toBe('string');
  });
  it('returns a non-empty UUID-like value', () => {
    const id = generateId();
    expect(id.length).toBeGreaterThan(0);
  });
  it('returns unique values on successive calls', () => {
    expect(generateId()).not.toBe(generateId());
  });
});

// ─── getEnabled / setEnabled ──────────────────────────────────────────────────

describe('getEnabled / setEnabled', () => {
  it('defaults to true when nothing stored', async () => {
    expect(await getEnabled()).toBe(true);
  });

  it('returns false after setEnabled(false)', async () => {
    await setEnabled(false);
    expect(await getEnabled()).toBe(false);
  });

  it('returns true after setEnabled(true)', async () => {
    await setEnabled(false);
    await setEnabled(true);
    expect(await getEnabled()).toBe(true);
  });
});

// ─── getSettings / saveSettings ───────────────────────────────────────────────

describe('getSettings', () => {
  it('returns all DEFAULT_SETTINGS keys when nothing stored', async () => {
    const settings = await getSettings();
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      expect(settings).toHaveProperty(key);
    }
  });

  it('returns defaults for every field when storage is empty', async () => {
    const settings = await getSettings();
    expect(settings).toMatchObject(DEFAULT_SETTINGS);
  });

  it('merges stored partial settings with defaults', async () => {
    await saveSettings({ showSnippet: false });
    const settings = await getSettings();
    // Saved override applied
    expect(settings.showSnippet).toBe(false);
    // Other defaults preserved
    expect(settings.badgeEnabled).toBe(DEFAULT_SETTINGS.badgeEnabled);
    expect(settings.notifFrequency).toBe(DEFAULT_SETTINGS.notifFrequency);
  });

  it('a full saveSettings round-trip preserves all fields', async () => {
    const patch = { showSnippet: false, cooldownSeconds: 30, badgeEnabled: false };
    await saveSettings(patch);
    const settings = await getSettings();
    expect(settings.showSnippet).toBe(false);
    expect(settings.cooldownSeconds).toBe(30);
    expect(settings.badgeEnabled).toBe(false);
  });
});

// ─── Keywords CRUD ────────────────────────────────────────────────────────────

describe('getKeywords / saveKeywords / addKeyword / removeKeyword', () => {
  it('returns an empty array when nothing is stored', async () => {
    expect(await getKeywords()).toEqual([]);
  });

  it('saves and retrieves a keywords array', async () => {
    const kws = [{ id: '1', text: 'hello', matchType: 'contains', enabled: true }];
    await saveKeywords(kws);
    expect(await getKeywords()).toEqual(kws);
  });

  it('addKeyword appends a rule with a generated id', async () => {
    await addKeyword({ text: 'world', matchType: 'exact_nocase', enabled: true });
    const list = await getKeywords();
    expect(list).toHaveLength(1);
    expect(list[0].text).toBe('world');
    expect(list[0].id).toBeTruthy();
  });

  it('removeKeyword removes by id', async () => {
    await addKeyword({ text: 'alpha', matchType: 'contains', enabled: true });
    await addKeyword({ text: 'beta',  matchType: 'contains', enabled: true });
    const [first] = await getKeywords();
    await removeKeyword(first.id);
    const remaining = await getKeywords();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].text).toBe('beta');
  });

  it('saveKeywords silently caps at MAX_KEYWORDS', async () => {
    const many = Array.from({ length: LIMITS.MAX_KEYWORDS + 10 }, (_, i) => ({
      id: String(i), text: `kw${i}`, matchType: 'contains', enabled: true,
    }));
    await saveKeywords(many);
    const stored = await getKeywords();
    expect(stored).toHaveLength(LIMITS.MAX_KEYWORDS);
  });
});

// ─── URL Rules CRUD ───────────────────────────────────────────────────────────

describe('getUrls / saveUrls / addUrl / removeUrl', () => {
  it('returns an empty array when nothing is stored', async () => {
    expect(await getUrls()).toEqual([]);
  });

  it('addUrl returns true and stores the rule', async () => {
    const result = await addUrl({ pattern: 'example.com', matchType: 'domain', enabled: true });
    expect(result).toBe(true);
    const list = await getUrls();
    expect(list).toHaveLength(1);
    expect(list[0].pattern).toBe('example.com');
  });

  it('addUrl returns false and does not duplicate on same pattern+matchType', async () => {
    await addUrl({ pattern: 'example.com', matchType: 'domain', enabled: true });
    const result = await addUrl({ pattern: 'example.com', matchType: 'domain', enabled: false });
    expect(result).toBe(false);
    expect(await getUrls()).toHaveLength(1);
  });

  it('addUrl allows same pattern with a different matchType', async () => {
    await addUrl({ pattern: 'example.com', matchType: 'domain',  enabled: true });
    const result = await addUrl({ pattern: 'example.com', matchType: 'wildcard', enabled: true });
    expect(result).toBe(true);
    expect(await getUrls()).toHaveLength(2);
  });

  it('removeUrl removes by id', async () => {
    await addUrl({ pattern: 'a.com', matchType: 'exact', enabled: true });
    await addUrl({ pattern: 'b.com', matchType: 'exact', enabled: true });
    const [first] = await getUrls();
    await removeUrl(first.id);
    const remaining = await getUrls();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].pattern).toBe('b.com');
  });

  it('saveUrls silently caps at MAX_URLS', async () => {
    const many = Array.from({ length: LIMITS.MAX_URLS + 5 }, (_, i) => ({
      id: String(i), pattern: `site${i}.com`, matchType: 'exact', enabled: true,
    }));
    await saveUrls(many);
    expect(await getUrls()).toHaveLength(LIMITS.MAX_URLS);
  });
});

// ─── saveHistorySnapshot ──────────────────────────────────────────────────────

describe('saveHistorySnapshot', () => {
  async function seedKeywordsAndUrls() {
    await addKeyword({ text: 'monitor', matchType: 'contains', enabled: true,
                       alertAppear: true, alertDisappear: false, scopeSelector: '' });
    await addUrl({ pattern: 'example.com', matchType: 'domain', enabled: true });
  }

  it('returns null when keywords and urls are both empty', async () => {
    const result = await saveHistorySnapshot('empty');
    expect(result).toBeNull();
  });

  it('saves a snapshot and returns the entry', async () => {
    await seedKeywordsAndUrls();
    const entry = await saveHistorySnapshot('My Setup');
    expect(entry).not.toBeNull();
    expect(entry.label).toBe('My Setup');
    expect(entry.keywords).toHaveLength(1);
    expect(entry.urls).toHaveLength(1);
    expect(typeof entry.fingerprint).toBe('string');
  });

  it('stores the fingerprint on the entry for future dedup', async () => {
    await seedKeywordsAndUrls();
    const entry = await saveHistorySnapshot();
    const history = await getHistory();
    expect(history[0].fingerprint).toBe(entry.fingerprint);
  });

  it('deduplicates: saving the same setup twice only creates one entry', async () => {
    await seedKeywordsAndUrls();
    await saveHistorySnapshot('first');
    const second = await saveHistorySnapshot('second');
    expect(second).toBeNull(); // duplicate rejected
    expect(await getHistory()).toHaveLength(1);
  });

  it('accepts a new snapshot after changing the keyword list', async () => {
    await seedKeywordsAndUrls();
    await saveHistorySnapshot('v1');
    await addKeyword({ text: 'new-kw', matchType: 'regex', enabled: true,
                       alertAppear: true, alertDisappear: true, scopeSelector: '' });
    const entry = await saveHistorySnapshot('v2');
    expect(entry).not.toBeNull();
    expect(await getHistory()).toHaveLength(2);
  });

  it('caps history at MAX_HISTORY entries (oldest dropped)', async () => {
    for (let i = 0; i < LIMITS.MAX_HISTORY + 2; i++) {
      // Each iteration must have a unique keyword to pass the fingerprint check
      await saveKeywords([{
        id: String(i), text: `kw${i}`, matchType: 'contains',
        enabled: true, alertAppear: true, alertDisappear: false, scopeSelector: '',
      }]);
      await saveHistorySnapshot(`setup-${i}`);
    }
    const history = await getHistory();
    expect(history).toHaveLength(LIMITS.MAX_HISTORY);
  });
});

// ─── restoreHistoryEntry ──────────────────────────────────────────────────────

describe('restoreHistoryEntry', () => {
  it('restores keywords and urls from a history entry', async () => {
    await addKeyword({ text: 'restore-me', matchType: 'contains', enabled: true,
                       alertAppear: true, alertDisappear: false, scopeSelector: '' });
    await addUrl({ pattern: 'restore.com', matchType: 'exact', enabled: true });
    const entry = await saveHistorySnapshot('to-restore');

    // Wipe current state
    await saveKeywords([]);
    await saveUrls([]);
    expect(await getKeywords()).toHaveLength(0);

    await restoreHistoryEntry(entry.id);

    expect(await getKeywords()).toHaveLength(1);
    expect((await getKeywords())[0].text).toBe('restore-me');
    expect(await getUrls()).toHaveLength(1);
    expect((await getUrls())[0].pattern).toBe('restore.com');
  });

  it('uses a SINGLE storageSet call — keywords and urls written atomically', async () => {
    await addKeyword({ text: 'kw', matchType: 'contains', enabled: true,
                       alertAppear: true, alertDisappear: false, scopeSelector: '' });
    const entry = await saveHistorySnapshot('atomic');

    // Count storageSet calls during restoreHistoryEntry
    let setCallCount = 0;
    const origSet = chrome.storage.local.set;
    chrome.storage.local.set = (data, cb) => {
      setCallCount++;
      return origSet(data, cb);
    };

    await restoreHistoryEntry(entry.id);

    expect(setCallCount).toBe(1); // Must be exactly one atomic write
    chrome.storage.local.set = origSet; // restore
  });

  it('throws when the entry id does not exist', async () => {
    await expect(restoreHistoryEntry('nonexistent-id')).rejects.toThrow();
  });
});

// ─── removeHistoryEntry ───────────────────────────────────────────────────────

describe('removeHistoryEntry', () => {
  it('removes the specified entry without affecting others', async () => {
    await addKeyword({ text: 'kw1', matchType: 'contains', enabled: true,
                       alertAppear: true, alertDisappear: false, scopeSelector: '' });
    const e1 = await saveHistorySnapshot('entry-1');

    await addKeyword({ text: 'kw2', matchType: 'regex', enabled: true,
                       alertAppear: true, alertDisappear: false, scopeSelector: '' });
    await saveHistorySnapshot('entry-2');

    await removeHistoryEntry(e1.id);
    const history = await getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].label).toBe('entry-2');
  });
});

// ─── Alert History ────────────────────────────────────────────────────────────

describe('addAlertEvent / getAlertHistory / clearAlertHistory', () => {
  const makeEvent = (i = 0) => ({
    event:     'appears',
    keyword:   `keyword-${i}`,
    matchType: 'contains',
    url:       'https://example.com',
    title:     'Test Page',
    snippet:   'some snippet',
    tabId:     1,
    timestamp: Date.now(),
  });

  it('stores alert events and retrieves them newest-first', async () => {
    await addAlertEvent(makeEvent(1));
    await addAlertEvent(makeEvent(2));
    const history = await getAlertHistory();
    expect(history).toHaveLength(2);
    expect(history[0].keyword).toBe('keyword-2'); // newest first
  });

  it('caps at MAX_ALERT_HISTORY entries', async () => {
    for (let i = 0; i < LIMITS.MAX_ALERT_HISTORY + 5; i++) {
      await addAlertEvent(makeEvent(i));
    }
    expect(await getAlertHistory()).toHaveLength(LIMITS.MAX_ALERT_HISTORY);
  });

  it('clearAlertHistory empties the log', async () => {
    await addAlertEvent(makeEvent());
    await clearAlertHistory();
    expect(await getAlertHistory()).toHaveLength(0);
  });

  it('each event is assigned a unique id', async () => {
    await addAlertEvent(makeEvent(1));
    await addAlertEvent(makeEvent(2));
    const [a, b] = await getAlertHistory();
    expect(a.id).not.toBe(b.id);
  });
});
