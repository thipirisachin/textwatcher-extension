# TextWatcher Browser Extension

A **100% local**, zero-data-collection browser extension that monitors websites for specific text and sends browser notifications when text appears or disappears.

## Features

- ✅ **Continuous monitoring** via MutationObserver (no polling, minimal CPU)
- ✅ **All match types**: Contains, Exact (case-sensitive/insensitive), Starts with, Ends with, Regex
- ✅ **All URL patterns**: Exact URL, Wildcard (`https://example.com/*`), Domain-wide (`*.example.com`)
- ✅ **Appear & disappear alerts** with per-keyword toggles
- ✅ **Notification frequency control**: Once per page / Every occurrence / Cooldown
- ✅ **Badge indicator** with match count
- ✅ **Last 10 setups** saved as history — one-click restore
- ✅ **Zero external calls** — all data stays on your device
- ✅ **Works on Chrome, Edge, Firefox**

## Project Structure

```
textwatcher-extension/
├── manifest.json                  ← MV3 manifest
├── src/
│   ├── background/
│   │   └── service-worker.js      ← Notifications, badge, tab injection
│   ├── content/
│   │   └── content-script.js      ← MutationObserver page monitoring
│   ├── popup/
│   │   ├── popup.html             ← Quick-add + status
│   │   ├── popup.css
│   │   └── popup.js
│   ├── options/
│   │   ├── options.html           ← Full settings page
│   │   ├── options.css
│   │   └── options.js
│   ├── shared/
│   │   ├── constants.js           ← All app constants
│   │   ├── storage.js             ← Unified storage API
│   │   ├── matcher.js             ← Pure matching logic
│   │   └── utils.js               ← General utilities
│   └── icons/
│       ├── icon16.png
│       ├── icon48.png
│       ├── icon128.png
│       └── generate_icons.py      ← Icon generator script
├── tests/                         ← (add your tests here)
├── docs/                          ← (add docs here)
├── .vscode/
│   ├── settings.json
│   └── extensions.json
└── .gitignore
```

## Installation

### Chrome / Edge
1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `textwatcher-extension` folder
5. The extension icon appears in your toolbar ✅

### Firefox
1. Open `about:debugging`
2. Click **This Firefox** → **Load Temporary Add-on**
3. Select `manifest.json` from the project folder
4. The extension is loaded ✅

> For permanent Firefox install, sign the extension via [addons.mozilla.org](https://addons.mozilla.org/developers/)

## Quick Start

1. Click the **TextWatcher** icon in your toolbar
2. Add a **keyword** (e.g. "Out of Stock") with match type "Contains"
3. Add a **URL** (e.g. `https://shop.example.com/*`) with type "Wildcard"
4. Visit the monitored page — TextWatcher watches continuously
5. Get a browser notification when text appears or disappears

## Settings

Open **⚙ Full Settings** from the popup to configure:

| Section | What you can set |
|---|---|
| **Keywords** | Text, match type, appear/disappear toggles, enable/disable per rule |
| **URLs** | URL pattern, match type, label, enable/disable per rule |
| **Notifications** | Alert events, frequency, cooldown, notification content |
| **Badge & Icon** | Badge count, badge colors, icon change on match |
| **History** | Save/restore/delete the last 10 keyword+URL setups |

## Privacy

- **Zero network calls** — no fetch, XHR, or WebSocket
- **No analytics or telemetry**
- **`chrome.storage.local` only** — data never leaves your device
- **No third-party libraries**
- **No eval()** — regex handled safely via `new RegExp()`

## Development

No build step required — pure vanilla JS with ES modules.

```
# Regenerate icons if needed
python src/icons/generate_icons.py
```

To test changes:
1. Edit files
2. Go to `chrome://extensions`
3. Click the **↻ reload** button on the TextWatcher card
