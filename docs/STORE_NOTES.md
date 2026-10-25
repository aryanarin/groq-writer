# Store submission notes

Reusable text for the Chrome Web Store and addons.mozilla.org (AMO). Version 1.1.1.

## Listing

**Name:** Groq Writer

**Short description (132 characters max):**
Fix spelling and grammar as you type, rewrite and translate selected text, with Groq or any OpenAI-compatible API.

**Category:** Productivity

**Long description:**
Groq Writer is a writing assistant that works on any website. It underlines spelling, grammar, punctuation and clarity problems as you type, and lets you accept each fix with a click or fix everything at once. Select text to rewrite it (improve, shorten, formal, friendly and more), translate it to your pinned languages or any language you type, or detect its language. It is open source (GPL v3), has no tracking, and sends text only to the AI provider you choose. Use a Groq API key, another OpenAI-compatible service, a local model server, or a proxy you control. Two quick-action shortcuts can be pointed at the tone and language you use most, and support links are available throughout the extension.

**Links:**
- Homepage and source: https://github.com/aryanarin/groq-writer
- Privacy policy: https://github.com/aryanarin/groq-writer/blob/main/docs/privacy.html (or the GitHub Pages URL if you enable Pages on `/docs`)
- Support: contact@davagni.eu.org, https://ko-fi.com/ysaryan

## Single purpose

Help the user write better text: proofread, rewrite, translate and identify the language of text they type or select on web pages.

## Permission justifications

| Permission | Why |
| ---------- | --- |
| `storage` | Saves settings, the personal dictionary, disabled sites, API keys, and the Worker URL and proxy token locally. |
| `contextMenus` | Adds Groq Writer entries (Rewrite, Translate to, Detect language, Settings, Support) to the right-click menu. |
| `activeTab` | Lets the toolbar popup read the current tab's address to offer the per-site on/off switch. |
| `https://api.groq.com/*` | Sends text to the Groq API for checking, rewriting and translating when Groq is the selected provider. |
| `optional_host_permissions` (`https://*/*`, `http://*/*`) | Only used when the user chooses a custom OpenAI-compatible endpoint or a Cloudflare Worker / proxy. The origin is requested at runtime with `permissions.request()` from a button click, and can be revoked. A single broad optional pattern is needed because the user supplies the endpoint or Worker URL. |
| Content script on `http://*/*` and `https://*/*` | Detects editable fields on any page to show suggestions. The script never reads or sends text from fields it skips (password, email, code editors, `spellcheck="false"`). |

No remote code is loaded. The extension has no analytics and no servers of its own. Requests go to the selected provider or to the user's own proxy.

## Data disclosure

- **Collected:** website content (the text of the field being checked or the selection being rewritten or translated) and authentication information (the API key or proxy token the user enters for their provider or Worker).
- **Purpose:** only to provide the proofreading, rewriting, translation and language-detection features, and to authenticate requests to the provider or Worker the user chose.
- **Recipient:** the configured provider (Groq, Inc. at `api.groq.com` by default), the custom endpoint the user enters, or the Cloudflare Worker / proxy the user runs.
- **Not collected:** browsing history, identifiers, location, analytics, or anything else.
- **Retention:** the extension stores nothing on a server. Keys, proxy URL/token and settings stay in the browser profile. The provider's or proxy operator's own policy applies to text and authentication information it receives.
- **Sale and sharing:** no sale, no sharing beyond transmitting the request to the provider the user configured.
- **Chrome Web Store privacy practices:** select **Website content** and **Authentication information**; both are used for the single purpose above and transferred to the user-selected provider.

AMO: `data_collection_permissions.required = ["websiteContent", "authenticationInfo"]`.

## Reviewer notes

- A provider key, custom endpoint, or Worker URL is required to see suggestions. Reviewers can create a free Groq key at https://console.groq.com/keys, or a test key can be provided in the reviewer notes field.
- Test steps (Groq): open the extension's settings, paste a Groq key under **Connection**, click **Save connection**, then **Test connection**. Open any page with a textarea, type `Teh quick brwon fox jump over teh lazy dog`, wait about a second, and click an underline. Select text and click the orange star for rewrite and translate.
- Test steps (custom endpoint): under **Provider** choose **Custom / other**, enter an OpenAI-compatible base URL, choose the authentication header, enter the key, save, accept the browser's host-permission prompt, and test.
- Test steps (Worker proxy): under **Provider** choose **Cloudflare Worker / proxy**, enter the Worker URL exactly as deployed, enter the optional **Proxy token** if the Worker sets `PROXY_TOKEN`, click **Test connection**, then **Save connection**. The test sends one short chat request; there is no model list to load.
- Settings > **Quick actions and shortcuts** shows the current key bindings and opens the browser's shortcut manager. Browsers, not extensions, assign shortcut keys.
- Support is reachable from the popup, settings header, in-page badge panel, star menu, result cards, and the right-click menu.

## Store assets

Ready in `docs/store-assets/`:

| File | Use |
| ---- | --- |
| `screenshot-1-proofreading.png` | 1280x800 — underlines and the suggestion panel |
| `screenshot-2-rewrite.png` | 1280x800 — rewrite and translate menu |
| `screenshot-3-translation.png` | 1280x800 — translated result card |
| `screenshot-4-connection.png` | 1280x800 — provider and model settings, connected |
| `screenshot-5-proxy.png` | 1280x800 — Cloudflare Worker / proxy settings, saved |
| `promo-440x280.png` | 440x280 small promo tile (Chrome Web Store) |

The screenshots were captured from the running 1.1.1 build against a local demo page and a local proxy endpoint; the API key and proxy token shown are masked test values. The extension icons (16, 48, 128) remain in `chrome/icons/`.
