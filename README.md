# TextWatcher

Monitor any website for text changes and get notified the moment something appears or disappears — without writing a line of code.

---

## What it does

TextWatcher watches pages you care about and sends you a notification when:
- A keyword or phrase **appears** on the page
- A keyword or phrase **disappears** from the page
- A specific **row in a table** matches or stops matching your criteria

All monitoring happens inside your browser. Nothing is sent anywhere unless you configure a webhook.

---

## Features

| | |
|---|---|
| **Table Mode** | Track a specific row in a table by its column values |
| **Text Mode** | Watch for any keyword or phrase anywhere on the page |
| **Flexible URL matching** | Exact URL, wildcard (`example.com/*`), or entire domain |
| **Match options** | Contains, exact phrase, case-sensitive, or regular expression |
| **Browser notifications** | Instant alerts with page title and matched content |
| **Webhook alerts** | Optionally send alerts to Slack or Microsoft Teams |
| **Alert history** | Log of every alert fired, with timestamps |
| **Rule history** | Save and restore your full setup with one click |
| **Badge indicator** | Toolbar icon shows active match count at a glance |

---

## Installation

### Chrome / Edge

1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `textwatcher-extension` folder
5. The TextWatcher icon appears in your toolbar

### Firefox

1. Open `about:debugging` → **This Firefox**
2. Click **Load Temporary Add-on**
3. Select `manifest.json` from the project folder

> For a permanent Firefox install, sign the extension via [addons.mozilla.org](https://addons.mozilla.org/developers/)

---

## Quick start

1. Click the **TextWatcher** icon in your toolbar
2. Add a URL to tell it which page to watch (e.g. `https://example.com/*`)
3. Create a rule — enter a keyword or table row values
4. Hit **Save Rule**
5. TextWatcher watches the page continuously and notifies you when something changes

---

## Settings

Open **Settings** from the popup footer to access:

- **Keywords** — manage all your watch rules
- **URLs** — manage which pages are monitored
- **Notifications** — control alert frequency, cooldown, and content
- **Webhooks** — send alerts to Slack or Microsoft Teams
- **Activity** — view the full alert history
- **Rule History** — restore a previous setup

---

## Privacy

TextWatcher runs entirely in your browser. Your keywords, URLs, and alert history are stored locally using `chrome.storage.local` and never leave your device.

The only exception is **webhooks** — if you configure a Slack or Teams webhook URL in Settings, TextWatcher will send alert data to that URL when a rule fires. Webhooks are optional and disabled by default.

---

## Development

No build step required — plain JavaScript with ES modules.

To reload after making changes:
1. Go to `chrome://extensions`
2. Click the **↻ reload** button on the TextWatcher card
