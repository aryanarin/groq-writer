# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.2.0] - 2026-10-31

### Changed
- Renamed the extension to **FluentText**. Groq remains available as the default provider, but the product no longer uses Groq's registered name as its own.
- New blue-to-teal icon set with a white F and a flowing underline, plus a matching padded store icon and promo tile.
- The settings page now uses a dark brand bar, a grouped sticky sidebar, and a compact two-column card layout instead of one long scrolling column. Navigation highlights the current section, and the layout collapses to a horizontal nav on narrow windows.
- The in-page star, badge, tooltip, settings panel, popup, context menu, bug report subject, privacy policy and documentation now use the FluentText name and the new blue accent.
- Placeholder branding in the status badge changed from G to F.
- The Firefox add-on ID is now `fluenttext@ysaryan.eu.org`, and the project repository moved to `github.com/aryanarin/fluenttext`.

## [1.1.1] - 2026-10-25

### Added
- A dedicated **Cloudflare Worker / proxy** provider. Enter the Worker URL and an optional proxy token: requests go to exactly that URL with `Authorization: Bearer <token>`, and no API key is stored in the browser. It has its own connection test and host-permission flow.

### Fixed
- Upgrading from 1.0.0 no longer converts the saved Worker URL into a custom endpoint and discards it. The URL is kept, and the proxy provider is selected.
- Empty model names now restore the selected provider's default instead of only reporting that they would be.

## [1.1.0] - 2026-10-25

### Added
- Custom endpoints and other providers: choose Groq, OpenAI, OpenRouter, Mistral, a local Ollama server, or any OpenAI-compatible API. Endpoint URL, authentication header (`Authorization: Bearer`, `x-api-key`, `api-key`, or none), per-provider key and optional host-permission request are handled in settings.
- Parameter fallback for providers that reject Groq-specific fields (`response_format`, `max_completion_tokens`, `temperature`, `reasoning_effort`), plus JSON extraction from loosely formatted replies.
- Connection testing and model discovery for the selected provider, with a small chat fallback when a server does not publish `/models`.
- Configurable quick actions: the quick rewrite shortcut now applies any chosen rewrite mode, and the quick translate shortcut uses any chosen language. Settings shows the current key bindings and links to the browser's shortcut manager.
- Support links in the in-page badge panel, star menu, result and error cards, popup, settings header and right-click menu, alongside the Support dialog (Ko-fi and UPI).
- Bundled privacy policy page.
- Settings and Support entries in the right-click menu.
- Optional example Worker token (`PROXY_TOKEN`) for proxy authentication.

### Changed
- Cross-browser API access now goes through one `browser`/`chrome` namespace wrapper. Firefox only returns promises from `browser.*`, so the previous direct `chrome.*` promise calls could fail there.
- Personal dictionary and disabled sites moved to local storage to stay below sync storage's per-item quota. Existing values are read and migrated in place.
- Privacy policy and store notes now cover custom providers, authentication information, and optional host permissions.
- Firefox data collection declaration now includes `authenticationInfo` as well as `websiteContent`.

### Fixed
- Toast messages for quick actions rendered no text.
- Quick actions scheduled the wrong field for a recheck after replacing text.
- Context-menu rebuilding now works on Chrome versions before 123 (callback-style `removeAll`) and is serialized to avoid duplicate IDs.
- Provider error messages no longer mention Groq when a different endpoint is in use.
- Empty model names for custom endpoints are no longer silently replaced with Groq model names.

## [1.0.0] - 2026-10-08

First release.

### Added
- Proofreading as you type in textareas, text inputs and rich text editors: spelling, grammar, punctuation, clarity and style, with inline underlines, an accept/dismiss tooltip, and a "Fix all" badge panel.
- Rewrite menu for selected text: improve, fix, shorten, longer, paraphrase, formal, friendly, confident, and custom instructions.
- Translation to pinned languages, any typed language, and a "More languages" right-click submenu, with automatic source-language detection and a Detect language action.
- Right-click menu that works on any selection, including read-only page text.
- Cloudflare Worker (or any compatible proxy) support, so no API key needs to live in the browser.
- Personal dictionary, per-site disable, language variants, configurable models and pause.
- Report a bug (prefilled email) and Support dialog.
- Chrome (Manifest V3) and Firefox builds from one codebase.
- Two keyboard shortcuts for quick actions:
  - **Alt+Shift+F**: Make selected text more formal (direct replacement, no result card).
  - **Alt+Shift+G**: Translate selected text to German (direct replacement, no result card).
  - For read-only text, results are copied to the clipboard instead of replacing.
  - Toast notifications confirm completion or show errors.
