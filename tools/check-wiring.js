// SPDX-License-Identifier: GPL-3.0-or-later
// Sanity checks for both builds. No dependencies:  node tools/check-wiring.js
//
//  1. Every file a manifest points at exists.
//  2. Every local file an HTML page loads (script/link/img) exists.
//  3. chrome/ and firefox/ differ only in manifest.json (run tools/sync-firefox.ps1 if not).
//  4. Both manifests agree on name, version, permissions, commands and content scripts.
//  5. Every message type sent anywhere has a handler in background.js or content.js.

'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
let failures = 0;
const fail = (msg) => { failures++; console.error('FAIL  ' + msg); };
const ok = (msg) => console.log('ok    ' + msg);

const read = (p) => fs.readFileSync(p, 'utf8');
const manifests = {};

for (const browser of ['chrome', 'firefox']) {
  const dir = path.join(root, browser);
  const m = JSON.parse(read(path.join(dir, 'manifest.json')));
  manifests[browser] = m;

  const refs = new Set();
  Object.values(m.icons || {}).forEach((f) => refs.add(f));
  if (m.action) {
    if (m.action.default_popup) refs.add(m.action.default_popup);
    Object.values(m.action.default_icon || {}).forEach((f) => refs.add(f));
  }
  if (m.options_ui) refs.add(m.options_ui.page);
  if (m.background) {
    if (m.background.service_worker) refs.add(m.background.service_worker);
    (m.background.scripts || []).forEach((f) => refs.add(f));
  }
  (m.content_scripts || []).forEach((cs) => (cs.js || []).concat(cs.css || []).forEach((f) => refs.add(f)));

  let missing = 0;
  for (const f of refs) {
    if (!fs.existsSync(path.join(dir, f))) { fail(`${browser}/manifest.json references missing file: ${f}`); missing++; }
  }
  if (!missing) ok(`${browser}: all ${refs.size} manifest references exist`);

  // HTML pages
  let htmlMissing = 0;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.html'))) {
    const html = read(path.join(dir, file));
    const re = /(?:src|href)="([^"#?]+)"/g;
    let match;
    while ((match = re.exec(html))) {
      const ref = match[1];
      if (/^(https?:|mailto:|data:)/.test(ref)) continue;
      if (!fs.existsSync(path.join(dir, ref))) { fail(`${browser}/${file} loads missing file: ${ref}`); htmlMissing++; }
    }
  }
  if (!htmlMissing) ok(`${browser}: all local assets used by HTML pages exist`);
}

// Identical shared files
const listFiles = (dir, base = dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name))]);

const chromeFiles = listFiles(path.join(root, 'chrome')).filter((f) => f !== 'manifest.json').sort();
const firefoxFiles = listFiles(path.join(root, 'firefox')).filter((f) => f !== 'manifest.json').sort();
if (JSON.stringify(chromeFiles) !== JSON.stringify(firefoxFiles)) {
  fail('chrome/ and firefox/ contain different files. Run tools/sync-firefox.ps1');
} else {
  let drift = 0;
  for (const f of chromeFiles) {
    if (!fs.readFileSync(path.join(root, 'chrome', f)).equals(fs.readFileSync(path.join(root, 'firefox', f)))) {
      fail(`firefox/${f} differs from chrome/${f}. Run tools/sync-firefox.ps1`);
      drift++;
    }
  }
  if (!drift) ok(`chrome and firefox share ${chromeFiles.length} identical files`);
}

// Manifest parity
const c = manifests.chrome;
const f = manifests.firefox;
const same = (label, a, b) =>
  JSON.stringify(a) === JSON.stringify(b) ? ok(`manifests agree on ${label}`) : fail(`manifests differ on ${label}`);
same('name', c.name, f.name);
same('version', c.version, f.version);
same('permissions', c.permissions, f.permissions);
same('host_permissions', c.host_permissions, f.host_permissions);
same('optional_host_permissions', c.optional_host_permissions, f.optional_host_permissions);
same('content_scripts', c.content_scripts, f.content_scripts);
same('commands', c.commands, f.commands);
same('action', c.action, f.action);

const pkg = JSON.parse(read(path.join(root, 'package.json')));
if (pkg.version !== c.version) fail(`package.json version ${pkg.version} != manifest version ${c.version}`);
else ok('package.json and manifest versions agree');

// Chrome allows at most four suggested keyboard shortcuts.
const suggested = Object.values(c.commands || {}).filter((x) => x.suggested_key).length;
if (suggested > 4) fail(`Chrome allows at most 4 commands with suggested_key (found ${suggested})`);
else ok(`${suggested} command(s) carry a suggested key`);

const optionalHosts = c.optional_host_permissions || [];
if (!optionalHosts.some((p) => p.startsWith('https://')) || !optionalHosts.some((p) => p.startsWith('http://'))) {
  fail('optional_host_permissions must allow both https:// and http:// endpoints');
} else {
  ok('optional host permissions allow custom endpoints');
}

// Every manifest command needs a listener branch in background.js.
const bgText = read(path.join(root, 'chrome', 'background.js'));
const commandHandlers = new Set([...bgText.matchAll(/command === '([a-z-]+)'/g)].map((m) => m[1]));
const missingCommands = Object.keys(c.commands || {}).filter((n) => !commandHandlers.has(n));
if (missingCommands.length) fail(`manifest commands with no background handler: ${missingCommands.join(', ')}`);
else ok(`all ${Object.keys(c.commands || {}).length} commands have a background handler`);

// Firefox must declare the data categories AMO asks about. Keys are authentication info.
const requiredData = (f.browser_specific_settings || {}).gecko?.data_collection_permissions?.required || [];
for (const category of ['websiteContent', 'authenticationInfo']) {
  if (!requiredData.includes(category)) fail(`firefox data_collection_permissions is missing ${category}`);
}
if (requiredData.includes('websiteContent') && requiredData.includes('authenticationInfo')) {
  ok('firefox data collection categories cover page text and API keys');
}

// Message plumbing
const sources = ['background.js', 'content.js', 'popup.js', 'options.js'].map((n) => ({ n, t: read(path.join(root, 'chrome', n)) }));
const sent = new Set();
for (const { t } of sources) {
  // 'text' / 'checkbox' / 'password' are <input type> attributes, not messages.
  for (const m of t.matchAll(/type:\s*'([a-zA-Z]+)'/g)) {
    if (!['text', 'checkbox', 'password'].includes(m[1])) sent.add(m[1]);
  }
}
const handled = new Set();
for (const { n, t } of sources.filter((s) => s.n === 'background.js' || s.n === 'content.js')) {
  for (const m of t.matchAll(/case\s+'([a-zA-Z]+)'/g)) handled.add(m[1]);
}
const unhandled = [...sent].filter((t) => !handled.has(t));
if (unhandled.length) fail(`message types sent but never handled: ${unhandled.join(', ')}`);
else ok(`all ${sent.size} message types have a handler`);

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
