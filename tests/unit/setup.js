/**
 * tests/unit/setup.js
 * Global Chrome Extension API mock.
 * Runs before every test file via vitest setupFiles.
 * Each test that needs specific storage responses should override these mocks locally.
 */

import { vi } from 'vitest';

// ─── In-memory storage backend ───────────────────────────────────────────────
// Tests that exercise storage.js use this store directly rather than
// swapping mock implementations per-test.
export const localStore  = {};
export const sessionStore = {};

function makeStorageMock(store) {
  return {
    get: vi.fn((keys, cb) => {
      const result = {};
      const list   = typeof keys === 'string' ? [keys] : (Array.isArray(keys) ? keys : Object.keys(keys));
      for (const k of list) {
        if (Object.prototype.hasOwnProperty.call(store, k)) result[k] = store[k];
      }
      if (cb) cb(result);
      return Promise.resolve(result);
    }),
    set: vi.fn((data, cb) => {
      Object.assign(store, data);
      if (cb) cb();
      return Promise.resolve();
    }),
    remove: vi.fn((keys, cb) => {
      const list = typeof keys === 'string' ? [keys] : keys;
      for (const k of list) delete store[k];
      if (cb) cb();
      return Promise.resolve();
    }),
    clear: vi.fn((cb) => {
      for (const k of Object.keys(store)) delete store[k];
      if (cb) cb();
      return Promise.resolve();
    }),
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  };
}

// ─── Global chrome stub ───────────────────────────────────────────────────────
globalThis.chrome = {
  storage: {
    local:   makeStorageMock(localStore),
    session: makeStorageMock(sessionStore),
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  runtime: {
    lastError:      null,
    onInstalled:    { addListener: vi.fn() },
    onStartup:      { addListener: vi.fn() },
    onMessage:      { addListener: vi.fn() },
    openOptionsPage: vi.fn(),
    getURL:         vi.fn((path) => `chrome-extension://test-extension-id/${path}`),
  },
  tabs: {
    onUpdated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
    query:       vi.fn().mockResolvedValue([]),
    get:         vi.fn(),
    update:      vi.fn(),
    sendMessage: vi.fn(),
  },
  windows:  { update: vi.fn() },
  notifications: {
    create:    vi.fn(),
    clear:     vi.fn(),
    onClicked: { addListener: vi.fn() },
  },
  action: {
    setBadgeText:            vi.fn(),
    setBadgeBackgroundColor: vi.fn(),
  },
  scripting: { executeScript: vi.fn() },
};

// ─── Helpers exported for use in individual test files ───────────────────────

/** Reset the in-memory store and all mock call counts between tests. */
export function resetStorage() {
  for (const k of Object.keys(localStore))  delete localStore[k];
  for (const k of Object.keys(sessionStore)) delete sessionStore[k];
  vi.clearAllMocks();
  // Re-bind storage mocks so cleared mocks still have the right implementation
  chrome.storage.local   = makeStorageMock(localStore);
  chrome.storage.session = makeStorageMock(sessionStore);
}
