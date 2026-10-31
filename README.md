# FluentText

A writing assistant for Chrome and Firefox, powered by [Groq](https://groq.com) or any OpenAI-compatible API. It proofreads as you type, rewrites and translates selected text, and detects languages, all without leaving the page.

- **Proofreading:** spelling, grammar, punctuation, clarity and style, underlined in place. Click an underline to accept, dismiss, or add a word to your dictionary. A badge in the text box lists everything and offers "Fix all".
- **Rewrite:** improve, fix, shorten, lengthen, paraphrase, formal, friendly, confident, or your own instruction.
- **Translate:** your pinned languages first (English and German by default), any other language by typing it, and the source language is detected automatically.
- **Detect language:** one click to name the language of any selection.
- **Works on any site:** textareas, text inputs and rich text editors. Replace text in a text box, or copy the result from read-only page text.
- **Your choice of provider:** Groq, OpenAI, OpenRouter, Mistral, a local Ollama server, a Cloudflare Worker or other proxy, or any endpoint that speaks the OpenAI chat-completions format.
- **Configurable quick actions:** two keyboard shortcuts apply a rewrite or a translation directly, and you choose which tone and which language they use.
- **Private by design:** no server of ours, no analytics. Text goes only to the provider you configure.

Licensed under the [GNU General Public License v3.0](LICENSE).

## Install

### Chrome, Edge, Brave (Chrome 105 or newer)

1. Download or clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the `chrome/` folder.

### Firefox (Firefox 140 or newer)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...** and choose `firefox/manifest.json`.

Temporary add-ons are removed when Firefox restarts. For a permanent install, submit the Firefox build to [addons.mozilla.org](https://addons.mozilla.org) for signing (see [docs/STORE_NOTES.md](docs/STORE_NOTES.md)). If the extension shows no suggestions in Firefox, open `about:addons`, select FluentText, then **Permissions**, and allow access to all websites.

## Connect it to a provider

The settings page opens on first install. Pick **Groq** for the default setup, **Cloudflare Worker / proxy** to keep the key out of the browser, or **Custom / other** for anything else. All requests use the OpenAI chat-completions format.

### Option A: Groq

1. Create a key at [console.groq.com/keys](https://console.groq.com/keys).
2. Choose **Groq** under **Connection**, paste the key, and click **Save connection**.
3. Click **Test connection** to confirm, and **Load models** to see the models your account can use.

The key is stored only in this browser profile and is sent only to `api.groq.com`.

### Option B: another provider or your own endpoint

1. Under **Provider**, choose OpenAI, OpenRouter, Mistral, Ollama (local), or **Custom / other**.
2. For a preset, the endpoint URL and suggested models are filled in. For a custom endpoint, enter its base URL, for example `https://api.example.com/v1`. `/chat/completions` is appended automatically.
3. Choose the **Authentication header** the service expects: `Authorization: Bearer`, `x-api-key`, `api-key`, or **No authentication**.
4. Paste the API key and click **Save connection**. The browser asks for permission to contact that endpoint's host; allow it so the extension can make requests.
5. Click **Test connection**. If the server publishes a model list, **Load models** fills in the model boxes. If it does not, type the model name from its documentation.

The key is stored only in local extension storage, never synced, and is attached only to requests for that endpoint. Use **Allow access** if you later revoke the host permission.

### Option C: a Cloudflare Worker proxy

Use this if you do not want a key inside the browser, if the provider is awkward to reach from your network, or if you share one key between several tools.

1. Deploy [`docs/cloudflare-worker.example.js`](docs/cloudflare-worker.example.js) as a Worker.
2. Set the Worker's variables: `API_KEY` (as a secret), `API_ENDPOINT` (`https://api.groq.com/openai/v1/chat/completions`), optionally `API_MODEL`, and optionally `PROXY_TOKEN` for authentication.
3. In FluentText choose **Cloudflare Worker / proxy** under **Connection**.
4. Enter the Worker's URL. It is used exactly as entered, with no path added, so paste the address your Worker listens on. When you save or test, the browser asks for permission to contact that host.
5. If the Worker sets `PROXY_TOKEN`, paste the same value into **Proxy token**. Otherwise leave it empty.
6. Click **Test connection**, then **Save connection**. The test sends one short chat request; a Worker has no model list to load.

No API key is stored in the browser. The Worker URL and token stay in local extension storage, never synced. The example Worker answers `POST` and `OPTIONS` with CORS headers. Without `PROXY_TOKEN` anyone who learns the URL can spend your key, so keep it private and set a spend limit. The proxy receives your text, so only use one you control.

### Models

The Groq defaults are `openai/gpt-oss-20b` for as-you-type checks and `openai/gpt-oss-120b` for rewriting and translating. Each provider uses its own model names; the presets suggest current ones, and the Worker preset keeps the Groq names because the example Worker forwards to Groq. If your Worker targets a different service, type that service's model names. Groq retires models regularly, so if requests start failing with "model unavailable", use **Load models** (or type a current name) in settings. **Load models** is not available for a Worker, which has no model list. **Reset to provider defaults** restores the names for the selected provider.

## Using it

| Action | How |
| ------ | --- |
| Proofread | Type in any text box. After a short pause, problems are underlined. Click one for the fix. |
| Fix everything | Click the round badge in the text box, then **Fix all**. |
| Rewrite, translate or detect language | Select text, then click the star, or right-click and choose **FluentText**. |
| Translate to another language | Star menu: type it in **Other language...**. Right-click menu: **Translate to > More languages**. |
| Quick rewrite | Select text and press **Alt+Shift+F** (default). Applies the mode chosen in settings, formal by default. |
| Quick translate | Select text and press **Alt+Shift+G** (default). Translates into the language chosen in settings, German by default. |
| Open the rewrite menu | Select text and press **Alt+Shift+E**. |
| Turn on or off | **Alt+Shift+K**, or the toolbar popup (also has a per-site switch). |

The quick actions replace the selection directly, without showing a result card. In read-only page text they copy the result to the clipboard instead. A toast confirms what happened.

### Changing the quick actions and shortcuts

Open **Settings > Quick actions and shortcuts**. Choose what the quick rewrite shortcut does and which language the translate shortcut uses. The two actions work independently.

The key combinations themselves belong to the browser, not to the extension: browsers do not let extensions assign their own keys. To change them:

- **Chrome / Edge / Brave:** open `chrome://extensions/shortcuts` (or click **Change key combinations** in settings).
- **Firefox:** open `about:addons`, click the gear icon, then **Manage Extension Shortcuts** (or click **Change key combinations** in settings).

The settings page always shows the keys currently bound. If a shortcut shows "Not set", the browser has no key assigned for it.

The star appears in text boxes by default. Turn on **Show the star on any selected text** in settings to get it everywhere, or use the right-click menu on read-only text.

Colors: red is spelling, grammar and punctuation; blue is clarity; purple is style.

## Settings

Provider, endpoint URL, Worker URL and optional proxy token, authentication header, API key, proofreading and rewrite models, language variant (US, UK, Canada, Australia, India, or auto-detect), which categories to check, the pause before checking, the status badge, pinned translation languages, translation register (formal or match the original), quick action tone and language, a personal dictionary, and a list of disabled sites.

The API key, proxy URL and token, personal dictionary and disabled-sites list are stored locally. Other settings may sync through your own browser account; keys and proxy details never do.

## What it skips

Google Docs (canvas editor), code editors (Monaco, CodeMirror, Ace), password and email fields, fields with `spellcheck="false"`, and small single-line inputs unless they contain a few words. Only the first 15,000 characters of a field are checked.

## Privacy

- Text in a field that FluentText is watching is sent to the provider you configured so it can be checked. Nothing is sent anywhere else.
- Your API key, proxy URL and token, and settings stay in the browser. Keys and proxy details never sync; other settings may sync through your browser account. Dictionary and disabled sites stay local.
- Host access to a custom endpoint or Worker is optional and requested only when you add that endpoint. It can be revoked at any time in the browser's extension settings.
- There is no analytics, tracking or account, and the developer operates no server that receives your data.

Details: [docs/privacy.html](docs/privacy.html), also bundled inside the extension.

## How it works

```
Page ──> content.js ──message──> background ──fetch──> provider /chat/completions
 (field detection, underlines,                    └──> your proxy --> api.groq.com
  star menu, result cards)
```

- `content.js` finds editable fields, splits text into chunks, caches results per chunk, locates each suggested snippet in the text, and draws underlines. Textareas and inputs use a hidden mirror layer; rich text uses the CSS Custom Highlight API, so the page DOM is never modified.
- `background.js` is the only code that touches the network. It holds the keys, queues requests, retries on rate limits, asks the provider for JSON, validates every suggestion, and downgrades unsupported parameters for providers with a stricter API than Groq.
- `shared.js` holds defaults, provider presets and storage helpers. The popup and settings page are plain HTML and JS with no build step. Both builds use a small `browser`/`chrome` namespace wrapper so promises work the same way in Chrome and Firefox.

## Project layout

```
fluenttext/
├── chrome/            Chrome / Edge / Brave build (load this folder)
├── firefox/           Firefox build: same files, different manifest.json
├── docs/              Privacy policy, store notes, cross-browser notes, example Worker
├── tools/             sync-firefox.ps1, check-wiring.js, package.ps1, make-icons.ps1
├── .github/           Issue and pull request templates
├── LICENSE            GNU GPL v3
└── CHANGELOG.md
```

## Development

There is no build step and there are no dependencies. Edit files under `chrome/`, then:

```powershell
powershell -ExecutionPolicy Bypass -File tools\sync-firefox.ps1   # copy shared files into firefox/
node tools\check-wiring.js                                         # verify manifests, assets, message handlers
powershell -ExecutionPolicy Bypass -File tools\package.ps1         # build dist\*.zip for both browsers
```

Optional: lint the Firefox build with Mozilla's tool, `npx web-ext lint --source-dir firefox --self-hosted`.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/CROSS_BROWSER.md](docs/CROSS_BROWSER.md).

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| Badge shows `!` | Click it. "Add your API key or endpoint" means setup is incomplete; "The provider rejected your API key" means the key, or the proxy token, is wrong or revoked. |
| "Allow access to ... when the browser asks" | The endpoint is on a host the extension has not been granted. Open settings, click **Allow access** (or **Test connection**) and accept the browser prompt. |
| Worker test returns 401 or 403 | The Worker's `PROXY_TOKEN` and the **Proxy token** field do not match. Leave the field empty only if the Worker sets no token. |
| The selected model may be unavailable | The model name is wrong or retired. Use **Load models** (except with a Worker) or type a current name in settings. |
| Rate limit reached | Provider quota. Raise **Wait after typing stops** in settings, or wait a minute. |
| Nothing underlined in a rich editor | Some editors fight outside changes. Use the badge list or the star menu instead. Please report the site. |
| Endpoint test fails | Check the URL, the authentication header, and that the server returns CORS headers for `POST` and `OPTIONS` if it is a proxy or Worker. |
| Shortcut does nothing | The key may be unassigned or taken by another extension. Open the browser's shortcut page from settings and assign one. |

## Support

FluentText is built and maintained in spare time.

- **Report a bug or request a feature:** use the **Report a bug** link in the popup or settings page (it prefills your version and browser), or [open an issue](https://github.com/aryanarin/fluenttext/issues).
- **Support the project:** [ko-fi.com/ysaryan](https://ko-fi.com/ysaryan), or UPI `ysaryanraj@okaxis` (QR code in the extension's Support dialog). Starring the repository also helps.
- Support links are also available from the badge panel, the star menu, result cards, and the right-click menu.

## License

Copyright (C) 2026 Aryan Raj. FluentText is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. It comes with no warranty. See [LICENSE](LICENSE).

FluentText is an independent project. Groq is a trademark of Groq, Inc., and is used here only to name the compatible API provider; this project is not affiliated with or endorsed by Groq. Other provider names are trademarks of their respective owners.
