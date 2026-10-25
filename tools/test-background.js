// SPDX-License-Identifier: GPL-3.0-or-later
// Background-worker tests with a mocked WebExtension API and fetch.
// No dependencies, no network:  node tools/test-background.js
//
// Runs twice: once with a Firefox-style `browser` namespace, once with a
// Chrome-style `chrome` namespace. Proves the namespace wrapper, provider
// routing, auth headers, parameter fallback, shortcuts, migration and storage.

'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

if (!process.argv[2]) {
  for (const ns of ['browser', 'chrome']) {
    try {
      execFileSync(process.execPath, [__filename, ns], { stdio: 'inherit' });
    } catch {
      process.exit(1);
    }
  }
  process.exit(0);
}

const namespace = process.argv[2];
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'chrome', 'manifest.json'), 'utf8'));
const GROQ_CHAT = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODELS = 'https://api.groq.com/openai/v1/models';

let passes = 0;
let failures = 0;
function assert(condition, label) {
  if (condition) {
    passes++;
    console.log('ok    ' + label);
  } else {
    failures++;
    console.error('FAIL  ' + label);
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function pick(data, keys) {
  if (keys == null) return { ...data };
  if (typeof keys === 'string') return { [keys]: data[keys] };
  if (Array.isArray(keys)) {
    const out = {};
    for (const key of keys) out[key] = data[key];
    return out;
  }
  const out = {};
  for (const key of Object.keys(keys)) out[key] = data[key] === undefined ? keys[key] : data[key];
  return out;
}

const storageListeners = [];
function notify(changes, area) {
  for (const fn of storageListeners) {
    try { fn(changes, area); } catch { /* background listeners are fire-and-forget */ }
  }
}

function makeArea(areaName, data) {
  return {
    data,
    async get(keys) { return clone(pick(data, keys)); },
    async set(patch) {
      const changes = {};
      for (const [key, value] of Object.entries(patch)) {
        if (JSON.stringify(data[key]) === JSON.stringify(value)) continue;
        changes[key] = { oldValue: clone(data[key]), newValue: clone(value) };
        data[key] = clone(value);
      }
      if (Object.keys(changes).length) notify(changes, areaName);
    },
    async remove(keys) {
      const keysArr = Array.isArray(keys) ? keys : [keys];
      const changes = {};
      for (const key of keysArr) {
        if (!(key in data)) continue;
        changes[key] = { oldValue: clone(data[key]), newValue: undefined };
        delete data[key];
      }
      if (Object.keys(changes).length) notify(changes, areaName);
    }
  };
}

const syncArea = makeArea('sync', {});
const localArea = makeArea('local', {});
const granted = new Set(['https://api.groq.com/*']);
const sentToTabs = [];
const createdTabs = [];
const menus = [];
const badges = [];
const openedOptions = [];
const commandListeners = [];
const installedListeners = [];
const messageListeners = [];
const menuClickListeners = [];

function patternOf(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return '';
  }
}

function fakeResponse(status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    async text() { return text; }
  };
}

const fetchCalls = [];
let responder = async () => fakeResponse(200, {});
globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  fetchCalls.push({ url: target, init });
  const pattern = patternOf(target);
  if (!granted.has(pattern)) {
    // What Chrome/Firefox do when a host permission is missing.
    throw new TypeError('Failed to fetch');
  }
  return responder(target, init);
};

const apiMock = {
  storage: {
    sync: syncArea,
    local: localArea,
    onChanged: { addListener: (fn) => storageListeners.push(fn) }
  },
  runtime: {
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    onInstalled: { addListener: (fn) => installedListeners.push(fn) },
    onStartup: { addListener: () => {} },
    getURL: (p) => `chrome-extension://test/${p}`,
    getManifest: () => manifest,
    openOptionsPage: async () => { openedOptions.push(true); },
    lastError: undefined
  },
  tabs: {
    async query() { return [{ id: 1, url: 'https://example.com/' }]; },
    async create(props) { createdTabs.push(props); return { id: 2 }; },
    async sendMessage(tabId, msg, options) {
      sentToTabs.push({ tabId, msg, options });
      return { ok: true };
    }
  },
  permissions: {
    async contains({ origins }) { return origins.every((o) => granted.has(o)); },
    async request({ origins }) {
      for (const o of origins) granted.add(o);
      return true;
    }
  },
  contextMenus: {
    create(props) { menus.push(props); return menus.length; },
    removeAll(cb) {
      menus.length = 0;
      if (namespace === 'chrome') {
        // Chrome before 123 only supports the callback form.
        setTimeout(() => cb && cb(), 0);
        return undefined;
      }
      return Promise.resolve();
    },
    onClicked: { addListener: (fn) => menuClickListeners.push(fn) }
  },
  commands: {
    onCommand: { addListener: (fn) => commandListeners.push(fn) },
    async getAll() {
      return Object.keys(manifest.commands).map((name, i) => ({ name, shortcut: `Alt+Shift+${'RFGK'[i]}` }));
    }
  },
  action: {
    async setBadgeBackgroundColor(v) { badges.push(v); },
    async setBadgeText(v) { badges.push(v); }
  }
};

if (namespace === 'browser') globalThis.browser = apiMock;
else globalThis.chrome = apiMock;

let seq = 0;
function send(message) {
  return new Promise((resolve, reject) => {
    const listener = messageListeners[0];
    if (!listener) return reject(new Error('background did not register onMessage'));
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) reject(new Error('no response for ' + message.type));
    }, 5000);
    listener(message, { id: 'test' }, (response) => {
      settled = true;
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function chatReply(content, status = 200) {
  return fakeResponse(status, {
    choices: [{ message: { role: 'assistant', content } }]
  });
}

async function main() {
  await import('../chrome/background.js');
  await new Promise((r) => setTimeout(r, 20));
  assert(messageListeners.length === 1, `[${namespace}] background registers a message listener`);

  // ---------------------------------------------------------------- defaults
  let r = await send({ type: 'getSettings' });
  assert(r && r.ok && r.settings.provider === 'groq', `[${namespace}] defaults to the Groq provider`);
  assert(r.settings.checkModel === 'openai/gpt-oss-20b', `[${namespace}] default check model`);
  assert(r.hasKey === false, `[${namespace}] reports no connection before setup`);
  assert(Array.isArray(r.modes) && r.modes.length === 8, `[${namespace}] returns rewrite modes`);

  r = await send({ type: 'check', text: 'I saw teh cat.' });
  assert(r && r.ok === false && r.error === 'no_key', `[${namespace}] check without a key is rejected`);

  // ---------------------------------------------------------------- Groq direct
  await localArea.set({ apiKey: 'gsk_test' });
  responder = async (url) => {
    if (url === GROQ_CHAT) {
      return chatReply(JSON.stringify({
        issues: [
          { original: 'teh', replacement: 'the', category: 'spelling', explanation: 'Typo', context: 'I saw ' },
          { original: 'cat', replacement: 'dog', category: 'unknown_category', explanation: 'bad category', context: '' },
          { original: 'not in the text', replacement: 'x', category: 'grammar', explanation: 'not present', context: '' }
        ]
      }));
    }
    return fakeResponse(404, { error: 'unexpected URL' });
  };

  r = await send({ type: 'check', text: 'I saw teh cat.' });
  assert(r && r.ok && r.issues.length === 1, `[${namespace}] check returns only valid suggestions`);
  assert(r.issues[0].replacement === 'the', `[${namespace}] suggestion content is preserved`);
  const checkCall = fetchCalls.find((c) => c.url === GROQ_CHAT);
  const checkBody = JSON.parse(checkCall.init.body);
  assert(checkBody.model === 'openai/gpt-oss-20b', `[${namespace}] check uses the saved check model`);
  assert(checkCall.init.headers.Authorization === 'Bearer gsk_test', `[${namespace}] Groq uses a Bearer key`);
  assert(checkBody.reasoning_effort === 'low', `[${namespace}] Groq gpt-oss requests stay cheap`);

  responder = async () => chatReply('  This is better.  ');
  r = await send({ type: 'rewrite', text: 'this is bad', mode: 'improve' });
  assert(r && r.ok && r.text === 'This is better.', `[${namespace}] rewrite trims the result`);

  responder = async () => chatReply(JSON.stringify({ source_language: 'German', translation: 'Hallo Welt' }));
  r = await send({ type: 'translate', text: 'Hallo Welt', language: 'English' });
  assert(r && r.ok && r.text === 'Hallo Welt' && r.sourceLanguage === 'German', `[${namespace}] translate parses JSON`);

  responder = async () => chatReply('```json\n{"language":"German"}\n```');
  r = await send({ type: 'detect', text: 'Guten Tag' });
  assert(r && r.ok && r.language === 'German', `[${namespace}] detect parses fenced JSON`);

  responder = async (url) => {
    if (url === GROQ_MODELS) {
      return fakeResponse(200, {
        data: [
          { id: 'openai/gpt-oss-20b' },
          { id: 'whisper-large-v3' },
          { id: 'text-embedding-3-small' }
        ]
      });
    }
    return fakeResponse(404, {});
  };
  r = await send({ type: 'test' });
  assert(r && r.ok && r.models.length === 1 && r.models[0] === 'openai/gpt-oss-20b',
    `[${namespace}] Groq test lists chat models only`);

  // ---------------------------------------------------------------- custom provider
  granted.add('https://api.example.com/*');
  let customCalls = 0;
  responder = async (url) => {
    if (url === 'https://api.example.com/v1/models') return fakeResponse(404, { error: 'no model list' });
    customCalls++;
    return chatReply(JSON.stringify({ issues: [] }));
  };
  r = await send({
    type: 'test',
    provider: 'custom',
    baseUrl: 'https://api.example.com/v1',
    auth: 'x-api-key',
    apiKey: 'custom-secret',
    model: 'my-model'
  });
  assert(r && r.ok && r.via === 'chat' && customCalls === 1,
    `[${namespace}] custom test falls back to a tiny chat request`);
  const customTestCall = fetchCalls.filter((c) => c.url === 'https://api.example.com/v1/chat/completions').at(-1);
  assert(customTestCall.init.headers['x-api-key'] === 'custom-secret' &&
    !customTestCall.init.headers.Authorization,
  `[${namespace}] x-api-key authentication header is used`);

  // Missing host permission is reported as such, not as a generic network error.
  responder = async () => { throw new TypeError('Failed to fetch'); };
  r = await send({
    type: 'test',
    provider: 'custom',
    baseUrl: 'https://not-granted.example/v1',
    auth: 'none',
    apiKey: '',
    model: 'm'
  });
  assert(r && r.ok === false && r.error === 'permission', `[${namespace}] missing host access is reported`);

  // Switch the saved connection to the custom endpoint.
  await syncArea.set({
    settings: {
      enabled: true,
      provider: 'custom',
      customBaseUrl: 'https://api.example.com/v1',
      customAuth: 'bearer',
      checkModel: 'custom-small',
      rewriteModel: 'custom-large',
      targetLanguages: ['English', 'German'],
      categories: { spelling: true, grammar: true, punctuation: true, clarity: true, style: false },
      language: 'en-US',
      debounceMs: 900,
      showBadge: true,
      translateTone: 'formal',
      quickTone: 'formal',
      quickLanguage: 'German'
    }
  });
  await localArea.set({ customApiKey: 'custom-bearer' });
  responder = async (url, init) => {
    if (url === 'https://api.example.com/v1/chat/completions') {
      const body = JSON.parse(init.body);
      if (body.response_format && !responder.fixed) {
        return fakeResponse(400, { error: { message: "Unsupported parameter: 'response_format'" } });
      }
      return chatReply(JSON.stringify({
        issues: [{ original: 'teh', replacement: 'the', category: 'spelling', explanation: 'Typo', context: '' }]
      }));
    }
    return fakeResponse(404, {});
  };

  r = await send({ type: 'check', text: 'teh cat' });
  assert(r && r.ok && r.issues.length === 1, `[${namespace}] custom provider check succeeds after a parameter fallback`);
  const customChatCalls = fetchCalls.filter((c) => c.url === 'https://api.example.com/v1/chat/completions');
  assert(customChatCalls.length >= 2, `[${namespace}] parameter fallback retried`);
  const lastCustom = customChatCalls.at(-1);
  assert(!JSON.parse(lastCustom.init.body).response_format, `[${namespace}] unsupported response_format was dropped`);
  assert(lastCustom.init.headers.Authorization === 'Bearer custom-bearer', `[${namespace}] custom Bearer key is used`);
  assert(JSON.parse(lastCustom.init.body).model === 'custom-small', `[${namespace}] custom check model is used`);

  // ---------------------------------------------------------------- shortcuts and support
  await syncArea.set({ settings: { ...clone((await syncArea.get('settings')).settings), quickTone: 'friendly', quickLanguage: 'Spanish' } });
  await new Promise((r) => setTimeout(r, 10));
  sentToTabs.length = 0;
  commandListeners[0]('tone-shortcut', { id: 1 });
  await new Promise((r) => setTimeout(r, 30));
  assert(sentToTabs.at(-1)?.msg.type === 'quickRewrite' && sentToTabs.at(-1)?.msg.mode === 'friendly',
    `[${namespace}] tone shortcut uses the configured mode`);
  commandListeners[0]('translate-shortcut', { id: 1 });
  await new Promise((r) => setTimeout(r, 30));
  assert(sentToTabs.at(-1)?.msg.type === 'quickTranslate' && sentToTabs.at(-1)?.msg.language === 'Spanish',
    `[${namespace}] translate shortcut uses the configured language`);

  commandListeners[0]('toggle-enabled', { id: 1 });
  await new Promise((r) => setTimeout(r, 30));
  r = await send({ type: 'getSettings' });
  assert(r.settings.enabled === false, `[${namespace}] toggle shortcut changes the enabled setting`);

  r = await send({ type: 'openSupport' });
  assert(r && r.ok && createdTabs.at(-1)?.url.endsWith('options.html#support'),
    `[${namespace}] support message opens the support dialog page`);

  // ---------------------------------------------------------------- proxy provider
  granted.add('https://worker.example/*');
  await localArea.set({ proxyUrl: 'https://worker.example/hook', proxyToken: 'proxy-secret' });
  await localArea.remove(['apiKey', 'customApiKey']);
  let proxyCalls = [];
  responder = async (url, init) => {
    proxyCalls.push({ url: String(url), init });
    return chatReply(JSON.stringify({ issues: [] }));
  };

  r = await send({
    type: 'test',
    provider: 'proxy',
    baseUrl: 'https://worker.example/hook',
    apiKey: 'proxy-secret',
    model: 'openai/gpt-oss-20b'
  });
  assert(r && r.ok && r.via === 'chat' && r.models.length === 0,
    `[${namespace}] proxy test uses a chat request and lists no models`);
  assert(proxyCalls.length === 1 && proxyCalls[0].url === 'https://worker.example/hook',
    `[${namespace}] proxy URL is used exactly as entered`);
  assert(proxyCalls[0].init.method === 'POST', `[${namespace}] proxy test sends POST`);
  assert(proxyCalls[0].init.headers.Authorization === 'Bearer proxy-secret',
    `[${namespace}] proxy token is sent as Bearer`);
  assert(!fetchCalls.some((c) => c.url.endsWith('/hook/models')),
    `[${namespace}] proxy test never asks for a model list`);

  await syncArea.set({
    settings: {
      ...clone((await syncArea.get('settings')).settings),
      provider: 'proxy',
      checkModel: 'openai/gpt-oss-20b',
      rewriteModel: 'openai/gpt-oss-120b'
    }
  });
  proxyCalls = [];
  responder = async (url, init) => {
    proxyCalls.push({ url: String(url), init });
    return chatReply(JSON.stringify({
      issues: [{ original: 'teh', replacement: 'the', category: 'spelling', explanation: 'Typo', context: '' }]
    }));
  };

  r = await send({ type: 'check', text: 'teh cat' });
  assert(r && r.ok && r.issues.length === 1, `[${namespace}] saved proxy works without any API key`);
  assert(proxyCalls[0].init.headers.Authorization === 'Bearer proxy-secret',
    `[${namespace}] saved proxy sends its stored token`);
  assert(!('reasoning_effort' in JSON.parse(proxyCalls[0].init.body)) &&
    !('include_reasoning' in JSON.parse(proxyCalls[0].init.body)),
  `[${namespace}] Groq-only fields are not sent through a proxy`);

  await localArea.set({ proxyToken: '' });
  proxyCalls = [];
  r = await send({ type: 'check', text: 'teh cat' });
  assert(r && r.ok, `[${namespace}] proxy without a token still works`);
  assert(proxyCalls[0].init.headers.Authorization === undefined,
    `[${namespace}] proxy without a token sends no auth header`);

  // ---------------------------------------------------------------- local lists
  r = await send({ type: 'addWord', word: 'GroqWriter' });
  r = await send({ type: 'setSiteDisabled', host: 'example.com', disabled: true });
  const syncNow = (await syncArea.get('settings')).settings;
  assert(localArea.data.dictionary.includes('GroqWriter'), `[${namespace}] dictionary is written to local storage`);
  assert(localArea.data.disabledSites.includes('example.com'), `[${namespace}] disabled sites are written to local storage`);
  assert(!('dictionary' in syncNow) && !('disabledSites' in syncNow), `[${namespace}] lists stay out of sync storage`);

  // ---------------------------------------------------------------- legacy proxy migration
  await localArea.set({ proxyUrl: 'https://legacy-worker.example/' });
  await localArea.remove(['apiKey', 'customApiKey', 'proxyToken']);
  await syncArea.set({
    settings: {
      enabled: true,
      targetLanguages: ['English', 'German'],
      categories: { spelling: true, grammar: true, punctuation: true, clarity: true, style: false },
      language: 'en-US',
      debounceMs: 900,
      showBadge: true,
      translateTone: 'formal',
      quickTone: 'formal',
      quickLanguage: 'German'
    }
  });
  installedListeners[0]({ reason: 'update' });
  await new Promise((r) => setTimeout(r, 50));
  r = await send({ type: 'getSettings' });
  assert(r.settings.provider === 'proxy',
    `[${namespace}] legacy proxy URL regains its own provider`);
  assert(localArea.data.proxyUrl === 'https://legacy-worker.example/',
    `[${namespace}] legacy proxy URL is kept, not discarded`);
  assert(r.hasKey === true, `[${namespace}] migrated proxy counts as configured`);

  // ---------------------------------------------------------------- menus
  assert(menus.some((m) => m.id === 'gw-root'), `[${namespace}] context menu root is created`);
  assert(menus.some((m) => m.id === 'gw-settings') && menus.some((m) => m.id === 'gw-support'),
    `[${namespace}] context menu includes settings and support`);

  console.log(`\n${namespace}: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
