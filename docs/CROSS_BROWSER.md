# Cross-browser notes (Chrome vs Firefox)

`chrome/` and `firefox/` share every `.js`, `.html`, `.css` and image file. Only `manifest.json` differs. `tools/sync-firefox.ps1` copies the shared files and `tools/check-wiring.js` fails if they drift.

## The API namespace rule

Firefox exposes promise-based WebExtension APIs under `browser.*`. Its `chrome.*` namespace is callback-based, for Chrome compatibility, and does **not** return promises. Chrome has promises under `chrome.*` in MV3 (and newer Chrome versions also expose `browser.*`).

The shared modules therefore pick a namespace once:

```js
export const api = globalThis.browser ?? globalThis.chrome;
```

Content scripts cannot import modules, so `content.js` has the same one-line local copy. Every API call in the extension goes through `api`. Firefox users would otherwise hit `await chrome.storage.sync.get()` returning `undefined` and `chrome.tabs.query()` failing, and the extension would not start. Keep this rule when adding code.

`content.js` also wraps `runtime.sendMessage` because Firefox supports only the promise form while older Chrome needs a callback.

## What differs in `firefox/manifest.json`

| Key | Chrome | Firefox | Why |
| --- | ------ | ------- | --- |
| `background` | `service_worker` + `type: module` | `scripts` + `type: module` | Firefox runs MV3 background code as an event page, not a service worker. The code keeps no state between events, so behavior is the same. |
| `minimum_chrome_version` | `105` | not present | Needed for the CSS Custom Highlight API and the MV3 APIs used here. |
| `browser_specific_settings` | not present | `gecko.id`, `strict_min_version` 140, `data_collection_permissions`, `gecko_android` | Required by addons.mozilla.org. Version 140 is where `data_collection_permissions` and the Custom Highlight API both exist. |

`data_collection_permissions.required` is `["websiteContent", "authenticationInfo"]`. Page and selection text goes to the configured provider for checking, and the API key is authentication information handled by the extension. Neither is sent to the developer.

## Custom endpoints and optional host permissions

Both manifests declare:

```json
"optional_host_permissions": ["https://*/*", "http://*/*"]
```

The required host permission is only `https://api.groq.com/*`. When the user chooses another endpoint, the options page calls `permissions.request({ origins: [pattern] })` from a button click. Browsers require that user gesture, and the origin must be declared as optional. The extension never fetches an origin it has not been granted.

`originPatternFor()` strips the path and port, because match patterns have no port. One granted origin therefore covers every port on that host, which is what local model servers need.

## Behavior notes

- **Underlines in rich text** use the CSS Custom Highlight API (Chrome 105+, Firefox 140+). Where it is unavailable the badge list and tooltips still work; only the in-place underline is missing.
- **Content-script styles:** the UI first tries a constructable stylesheet (not blocked by page CSP), and falls back to a `<style>` element if the browser refuses a sheet created in the content-script world.
- **Host permissions:** Firefox treats MV3 host permissions as user-controlled. If the extension is silent on a site, allow access to all websites under `about:addons` > Groq Writer > Permissions.
- **Context menus:** Chrome before 123 does not return a promise from `contextMenus.removeAll()`, so `background.js` uses a callback/promise helper and serializes menu rebuilds.
- **Keyboard shortcuts:** browsers own the key bindings. The extension can read them with `commands.getAll()` and can open the browser's manager (`commands.openShortcutSettings()` in Firefox, `chrome://extensions/shortcuts` in Chromium), but it cannot assign keys itself. Chrome allows at most four commands with `suggested_key`; the manifest uses exactly four.
- **mailto: links** (Report a bug) open the system's default mail handler in both browsers.

## Testing a Firefox build locally

1. `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on...**, then choose `firefox/manifest.json`.

Lint with Mozilla's tool (needs npm access):

```
npx web-ext lint --source-dir firefox --self-hosted
```

Build a package with `tools/package.ps1` (output goes to `dist/`).
