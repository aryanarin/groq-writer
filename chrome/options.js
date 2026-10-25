// SPDX-License-Identifier: GPL-3.0-or-later
import {
  api, DEFAULTS, CATEGORY_IDS, CATEGORY_INFO, LANGUAGES, REWRITE_MODES, COMMON_LANGUAGES,
  PROVIDER_PRESETS, AUTH_HEADERS, UPI_ID, bugReportMailto,
  getSettings, saveSettings, getApiKey, setApiKey, getCustomApiKey, setCustomApiKey,
  getProxyUrl, setProxyUrl, getProxyToken, setProxyToken,
  isValidEndpointUrl, originPatternFor, endpointHost
} from './shared.js';

const $ = (id) => document.getElementById(id);

const ERRORS = {
  no_key: 'Add an API key or Worker URL first.',
  invalid_key: 'The endpoint rejected the key or proxy token (401 or 403).',
  permission: 'The browser has not granted access to this endpoint.',
  network: 'Could not reach the endpoint. Check the URL and your connection.',
  timeout: 'The request timed out.',
  rate_limited: 'Rate limited. Try again in a moment.',
  server: 'The provider returned a server error. Try again later.',
  bad_request: 'The provider rejected the request. Check the endpoint URL and model names.',
  no_model: 'Enter a model name below first.'
};

const state = {
  settings: null,
  formType: 'groq',
  keys: { groq: '', custom: '' },
  proxyUrl: '',
  proxyToken: '',
  dirty: false
};

// Same rule the background applies before putting a language name in a prompt.
const LANGUAGE_NAME = /^[\p{L}\p{M}][\p{L}\p{M} \-'().,/]{1,39}$/u;

let toastTimer = null;
function toast() {
  const t = $('saved');
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1200);
}

function setStatus(id, text, kind) {
  const el = $(id);
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

const lines = (text) =>
  [...new Set(text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];

function normalizeSite(s) {
  return s.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/:?#].*$/, '');
}

async function sendBg(msg) {
  try {
    return await api.runtime.sendMessage(msg);
  } catch {
    return { ok: false, error: 'network' };
  }
}

function presetById(id) {
  return PROVIDER_PRESETS.find((p) => p.id === id) || PROVIDER_PRESETS[0];
}

function sameEndpoint(a, b) {
  const clean = (v) => String(v || '').trim().replace(/\/+$/, '').toLowerCase();
  return clean(a) !== '' && clean(a) === clean(b);
}

function providerIdFor(settings) {
  if (settings.provider === 'groq') return 'groq';
  if (settings.provider === 'proxy') return 'proxy';
  const match = PROVIDER_PRESETS.find((p) =>
    p.id !== 'groq' && p.id !== 'proxy' && p.id !== 'custom' && p.baseUrl &&
    sameEndpoint(p.baseUrl, settings.customBaseUrl) && p.auth === settings.customAuth);
  return match ? match.id : 'custom';
}

function readForm() {
  const selected = $('provider').value;
  const type = selected === 'groq' ? 'groq' : selected === 'proxy' ? 'proxy' : 'custom';
  const proxyToken = $('proxyToken').value.trim();
  return {
    selected,
    type,
    preset: presetById(selected),
    baseUrl: type === 'groq'
      ? ''
      : type === 'proxy' ? $('proxyUrl').value.trim() : $('customBaseUrl').value.trim(),
    auth: type === 'groq'
      ? 'bearer'
      : type === 'proxy' ? (proxyToken ? 'bearer' : 'none') : $('customAuth').value,
    key: type === 'proxy' ? proxyToken : $('apiKey').value.trim(),
    checkModel: $('checkModel').value.trim(),
    rewriteModel: $('rewriteModel').value.trim()
  };
}

// ---------------------------------------------------------------- connection form

function setKeyHint(form) {
  const hint = $('keyHint');
  hint.replaceChildren();
  const add = (text) => hint.append(text);
  const addLink = (href, label) => {
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = label;
    hint.append(a);
  };

  if (form.type === 'groq') {
    add('Create a key at ');
    addLink('https://console.groq.com/keys', 'console.groq.com/keys');
    add('. Stored only in this browser and sent only to api.groq.com.');
    return;
  }
  if (form.type === 'proxy') {
    add('No API key is needed here: your Worker holds it. Add a proxy token above only if your Worker checks one.');
    return;
  }
  if (form.auth === 'none') {
    add('This endpoint needs no key. Nothing is attached to requests.');
    return;
  }
  const label = AUTH_HEADERS.find(([id]) => id === form.auth)[1];
  add(`Sent as ${label.replace('<key>', 'your key')}. Stored only in this browser.`);
  if (form.preset.keyUrl) {
    add(' Create one at ');
    addLink(form.preset.keyUrl, endpointHost(form.preset.keyUrl) || form.preset.keyUrl);
    add('.');
  }
}

function syncAuthUi() {
  const form = readForm();
  $('proxyFields').hidden = form.type !== 'proxy';
  $('keyField').hidden = form.type === 'proxy' ||
    (form.type === 'custom' && form.auth === 'none');
  $('apiKeyLabel').textContent = form.type === 'groq' ? 'Groq API key' : 'API key';
  $('apiKey').placeholder = form.type === 'groq' ? 'gsk_...' : (form.auth === 'none' ? '' : 'Your provider key');
  setKeyHint(form);
  $('providerHint').textContent = {
    groq: 'Requests go to api.groq.com. A free Groq account includes a generous rate limit.',
    openai: 'Requests go to api.openai.com. Model names are read from your account, so load them below.',
    openrouter: 'Requests go to openrouter.ai, which routes to many model providers.',
    mistral: 'Requests go to api.mistral.ai.',
    ollama: 'Start Ollama on this computer and pull a model first, for example: ollama pull llama3.2. No key is needed.',
    proxy: 'Send requests through a Cloudflare Worker or another proxy you run. The real API key stays in the proxy, so no key is stored in this browser.',
    custom: 'Any OpenAI-compatible endpoint, including a local model server. The browser will ask for access to its host.'
  }[form.selected] || '';
}

function switchKeyType(next) {
  if (state.formType === next) return;
  state.keys[state.formType] = $('apiKey').value.trim();
  state.formType = next;
  $('apiKey').value = state.keys[next];
}

function markDirty() {
  state.dirty = true;
}

function applyConfirmation(id, settings) {
  const preset = presetById(id);
  $('provider').value = id;
  state.formType = settings.provider === 'groq' ? 'groq' : 'custom';
  $('customFields').hidden = id === 'groq' || id === 'proxy';
  $('proxyFields').hidden = id !== 'proxy';
  $('customBaseUrl').value = settings.customBaseUrl;
  $('customAuth').value = settings.customAuth;
  $('proxyUrl').value = state.proxyUrl;
  $('proxyToken').value = state.proxyToken;
  $('apiKey').value = state.keys[state.formType];
  if (preset.checkModel) {
    // Only prefill names when the saved endpoint has none of its own.
    if (!$('checkModel').value.trim()) $('checkModel').value = preset.checkModel;
    if (!$('rewriteModel').value.trim()) $('rewriteModel').value = preset.rewriteModel;
  }
  syncAuthUi();
  updatePermissionUi();
}

function onProviderChange() {
  const id = $('provider').value;
  const preset = presetById(id);
  const type = id === 'groq' ? 'groq' : id === 'proxy' ? 'proxy' : 'custom';
  if (type !== 'proxy') switchKeyType(type);
  $('customFields').hidden = type !== 'custom';
  $('proxyFields').hidden = type !== 'proxy';

  if (id !== 'groq') {
    if (type === 'custom' && preset.baseUrl) $('customBaseUrl').value = preset.baseUrl;
    if (type === 'custom') $('customAuth').value = preset.auth;
    if (preset.checkModel) {
      $('checkModel').value = preset.checkModel;
      $('rewriteModel').value = preset.rewriteModel;
    }
  }

  markDirty();
  syncAuthUi();
  updatePermissionUi();
  setStatus('connStatus',
    type === 'proxy' ? 'Enter your Worker URL, then test or save.'
      : type === 'groq' ? '' : 'Review the endpoint, then test or save.', '');
}

function validateConnection(form) {
  if (form.type === 'proxy') {
    if (!form.baseUrl) {
      setStatus('connStatus', 'Enter the Worker URL.', 'bad');
      $('proxyUrl').focus();
      return false;
    }
    if (!isValidEndpointUrl(form.baseUrl)) {
      setStatus('connStatus', 'Enter a full http:// or https:// Worker URL without a username or password.', 'bad');
      $('proxyUrl').focus();
      return false;
    }
    if (!form.checkModel) {
      setStatus('connStatus', 'Enter a model name first; a Worker has no model list to choose from.', 'bad');
      $('checkModel').focus();
      return false;
    }
    return true;
  }

  if (form.type === 'custom') {
    if (!form.baseUrl) {
      setStatus('connStatus', 'Enter the endpoint URL.', 'bad');
      $('customBaseUrl').focus();
      return false;
    }
    if (!isValidEndpointUrl(form.baseUrl)) {
      setStatus('connStatus', 'Enter a full http:// or https:// endpoint URL without a username or password.', 'bad');
      $('customBaseUrl').focus();
      return false;
    }
  }
  if (form.type === 'custom' && form.auth === 'none') {
    // No key required.
  } else if (!form.key) {
    setStatus('connStatus', form.type === 'groq' ? 'Enter your Groq API key.' : 'Enter an API key, or switch the authentication header to "No authentication".', 'bad');
    $('apiKey').focus();
    return false;
  }
  return true;
}

async function requestEndpointAccess(baseUrl) {
  const pattern = originPatternFor(baseUrl);
  if (!pattern) return false;
  try {
    return await api.permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
}

async function updatePermissionUi() {
  const form = readForm();
  const button = $('grantAccess');
  const needsHost = form.type === 'custom' || form.type === 'proxy';
  if (!needsHost || !isValidEndpointUrl(form.baseUrl)) {
    button.hidden = true;
    return;
  }
  const pattern = originPatternFor(form.baseUrl);
  let granted = false;
  try {
    granted = await api.permissions.contains({ origins: [pattern] });
  } catch { /* treat as missing */ }
  button.hidden = !!granted;
}

async function saveConnection() {
  const form = readForm();
  if (!validateConnection(form)) return;

  let access = true;
  if (form.type === 'custom' || form.type === 'proxy') {
    access = await requestEndpointAccess(form.baseUrl);
  }

  const next = await saveSettings({
    provider: form.type,
    customBaseUrl: form.type === 'custom' ? form.baseUrl : state.settings.customBaseUrl,
    customAuth: form.type === 'custom' ? form.auth : state.settings.customAuth,
    checkModel: form.checkModel || (form.type === 'groq' || form.type === 'proxy' ? DEFAULTS.checkModel : ''),
    rewriteModel: form.rewriteModel || (form.type === 'groq' || form.type === 'proxy' ? DEFAULTS.rewriteModel : '')
  });
  if (form.type === 'groq') await setApiKey(form.key);
  else if (form.type === 'custom') await setCustomApiKey(form.key);
  else {
    await setProxyUrl(form.baseUrl);
    await setProxyToken(form.key);
    state.proxyUrl = form.baseUrl;
    state.proxyToken = form.key;
  }

  if (form.type !== 'proxy') state.keys[form.type] = form.key;
  state.settings = next;
  state.dirty = false;
  $('checkModel').value = next.checkModel;
  $('rewriteModel').value = next.rewriteModel;
  setStatus(
    'connStatus',
    access
      ? 'Connection saved.'
      : `Connection saved, but access to ${endpointHost(form.baseUrl)} was not granted. Click Allow access, or test again.`,
    access ? 'ok' : 'bad'
  );
  await updatePermissionUi();
  toast();
}

async function testConnection() {
  const form = readForm();
  if (!validateConnection(form)) return;

  if (form.type === 'custom' || form.type === 'proxy') {
    const access = await requestEndpointAccess(form.baseUrl);
    if (!access) {
      setStatus('connStatus', `Access to ${endpointHost(form.baseUrl) || 'this endpoint'} was not granted. Allow it to test the connection.`, 'bad');
      await updatePermissionUi();
      return;
    }
    await updatePermissionUi();
  }

  setStatus('connStatus', 'Testing...', '');
  const r = await sendBg({
    type: 'test',
    provider: form.type,
    baseUrl: form.baseUrl,
    auth: form.auth,
    apiKey: form.key,
    model: form.checkModel
  });

  if (r && r.ok) {
    fillModels(r.models || []);
    const n = (r.models || []).length;
    const summary = form.type === 'proxy'
      ? 'Connected. The Worker answered a short test request.'
      : n
        ? `Connected. ${n} model${n === 1 ? '' : 's'} available.`
        : 'Connected. This server does not list models, so type a model name below.';
    setStatus('connStatus', state.dirty ? `${summary} Save the connection to use it.` : summary, 'ok');
  } else {
    setStatus('connStatus', ERRORS[r && r.error] || (r && r.message) || 'Test failed.', 'bad');
    if (r && r.error === 'permission') await updatePermissionUi();
  }
}

// ---------------------------------------------------------------- models

function fillModels(ids) {
  const list = $('modelList');
  list.replaceChildren();
  for (const id of ids) {
    const o = document.createElement('option');
    o.value = id;
    list.append(o);
  }
}

function currentPreset() {
  return presetById($('provider').value);
}

async function loadModels() {
  const form = readForm();
  if (form.type === 'proxy') {
    setStatus('modelStatus', 'A Worker answers chat requests only, so there is no model list to load. Type the model names your Worker targets; the defaults are Groq\u2019s.', '');
    return;
  }
  if (!validateConnection(form)) return;

  if (form.type === 'custom') {
    const access = await requestEndpointAccess(form.baseUrl);
    if (!access) {
      setStatus('modelStatus', `Access to ${endpointHost(form.baseUrl) || 'the endpoint'} was not granted.`, 'bad');
      return;
    }
  }

  setStatus('modelStatus', 'Loading...', '');
  const r = await sendBg({
    type: 'test',
    provider: form.type,
    baseUrl: form.baseUrl,
    auth: form.auth,
    apiKey: form.key,
    model: form.checkModel
  });
  if (r && r.ok) {
    fillModels(r.models || []);
    const n = (r.models || []).length;
    setStatus('modelStatus', n
      ? `${n} model${n === 1 ? '' : 's'} loaded. Click a model box to pick one.`
      : 'Connected, but this server does not publish a model list. Type the model name from its documentation.', 'ok');
  } else {
    setStatus('modelStatus', ERRORS[r && r.error] || (r && r.message) || 'Could not load models.', 'bad');
  }
}

async function resetModels() {
  const preset = currentPreset();
  const check = preset.checkModel;
  const rewrite = preset.rewriteModel;
  if (!check && !rewrite) {
    setStatus('modelStatus', 'A custom endpoint has no default models. Type the names your provider documents.', '');
    return;
  }
  $('checkModel').value = check;
  $('rewriteModel').value = rewrite;
  const next = await saveSettings({ checkModel: check, rewriteModel: rewrite });
  state.settings = next;
  setStatus('modelStatus', 'Provider defaults restored.', 'ok');
  toast();
}

// ---------------------------------------------------------------- shortcuts

function shortcutPageUrl() {
  return /Firefox\//.test(navigator.userAgent) ? 'about:addons' : 'chrome://extensions/shortcuts';
}

function keyNodes(shortcut) {
  if (!shortcut) return [document.createTextNode('Not set')];
  const parts = shortcut.split('+').map((p) => p.trim()).filter(Boolean);
  const nodes = [];
  parts.forEach((part, i) => {
    if (i) nodes.push(document.createTextNode(' + '));
    const kbd = document.createElement('kbd');
    kbd.textContent = part;
    nodes.push(kbd);
  });
  return nodes;
}

async function renderShortcuts() {
  const box = $('shortcutList');
  let commands = [];
  try {
    commands = await api.commands.getAll();
  } catch { /* leave empty */ }
  const byName = new Map((commands || []).map((c) => [c.name, c]));
  const s = state.settings;
  const tone = (REWRITE_MODES.find((m) => m.id === s.quickTone) || REWRITE_MODES[0]).label;
  const rows = [
    ['tone-shortcut', `Quick rewrite: ${tone}`],
    ['translate-shortcut', `Translate to ${s.quickLanguage}`],
    ['rewrite-selection', 'Open the rewrite menu'],
    ['toggle-enabled', 'Turn Groq Writer on or off']
  ];

  box.replaceChildren();
  for (const [name, label] of rows) {
    const cmd = byName.get(name);
    if (!cmd) continue;
    const row = document.createElement('div');
    row.className = 'shortcut-row';
    const text = document.createElement('span');
    text.textContent = label;
    const keys = document.createElement('span');
    keys.className = 'shortcut-keys';
    keys.append(...keyNodes(cmd.shortcut));
    row.append(text, keys);
    box.append(row);
  }
  if (!box.children.length) {
    box.textContent = 'No keyboard commands are available in this browser.';
  }
}

async function openShortcutSettings() {
  if (typeof api.commands.openShortcutSettings === 'function') {
    try {
      await api.commands.openShortcutSettings();
      setStatus('shortcutStatus', 'Opened the browser\'s shortcut settings.', 'ok');
      return;
    } catch { /* fall through to a normal tab */ }
  }
  const url = shortcutPageUrl();
  try {
    await api.tabs.create({ url });
    setStatus('shortcutStatus', 'Opened the shortcut page in a new tab. Click the pencil icon to change a key.', 'ok');
  } catch {
    await copyShortcutUrl();
  }
}

async function copyShortcutUrl() {
  const url = shortcutPageUrl();
  try {
    await navigator.clipboard.writeText(url);
    setStatus('shortcutStatus', `Copied ${url}. Paste it into a new tab.`, 'ok');
    return;
  } catch { /* try the old path */ }
  try {
    const range = document.createRange();
    range.selectNodeContents($('shortcutUrl'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const ok = document.execCommand('copy');
    setStatus('shortcutStatus', ok ? 'Address copied. Paste it into a new tab.' : 'Copy failed. Select the address and copy it.', ok ? 'ok' : 'bad');
  } catch {
    setStatus('shortcutStatus', 'Copy failed. Select the address and copy it.', 'bad');
  }
}

// ---------------------------------------------------------------- init

async function init() {
  const [s, groqKey, customKey, proxyUrl, proxyToken] = await Promise.all([
    getSettings(), getApiKey(), getCustomApiKey(), getProxyUrl(), getProxyToken()
  ]);
  state.settings = s;
  state.keys = { groq: groqKey, custom: customKey };
  state.proxyUrl = proxyUrl;
  state.proxyToken = proxyToken;
  $('proxyUrl').value = proxyUrl;
  $('proxyToken').value = proxyToken;

  // Bug report and support
  $('reportBug').href = bugReportMailto(api.runtime.getManifest().version, navigator.userAgent);
  const dialog = $('supportDialog');
  $('upiId').textContent = UPI_ID;
  $('openSupport').addEventListener('click', () => dialog.showModal());
  $('closeSupport').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  $('copyUpi').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(UPI_ID);
      $('copyUpi').textContent = 'Copied';
    } catch {
      $('copyUpi').textContent = 'Copy failed';
    }
    setTimeout(() => { $('copyUpi').textContent = 'Copy'; }, 1500);
  });
  if (location.hash === '#support') dialog.showModal();

  // Connection
  for (const preset of PROVIDER_PRESETS) {
    const o = document.createElement('option');
    o.value = preset.id;
    o.textContent = preset.label;
    $('provider').append(o);
  }
  for (const [value, label] of AUTH_HEADERS) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    $('customAuth').append(o);
  }
  $('checkModel').value = s.checkModel;
  $('rewriteModel').value = s.rewriteModel;
  applyConfirmation(providerIdFor(s), s);

  $('provider').addEventListener('change', onProviderChange);
  $('customAuth').addEventListener('change', () => {
    markDirty();
    syncAuthUi();
  });
  $('customBaseUrl').addEventListener('input', () => {
    markDirty();
    updatePermissionUi();
    setKeyHint(readForm());
  });
  $('proxyUrl').addEventListener('input', () => {
    markDirty();
    updatePermissionUi();
  });
  for (const id of ['apiKey', 'customBaseUrl', 'customAuth', 'proxyUrl', 'proxyToken', 'checkModel', 'rewriteModel']) {
    $(id).addEventListener('input', markDirty);
    $(id).addEventListener('change', markDirty);
  }
  $('showKey').addEventListener('click', () => {
    const show = $('apiKey').type === 'password';
    $('apiKey').type = show ? 'text' : 'password';
    $('showKey').textContent = show ? 'Hide' : 'Show';
    $('showKey').setAttribute('aria-pressed', String(show));
  });
  $('showProxyToken').addEventListener('click', () => {
    const show = $('proxyToken').type === 'password';
    $('proxyToken').type = show ? 'text' : 'password';
    $('showProxyToken').textContent = show ? 'Hide' : 'Show';
    $('showProxyToken').setAttribute('aria-pressed', String(show));
  });
  $('saveConnection').addEventListener('click', saveConnection);
  $('testConnection').addEventListener('click', testConnection);
  $('grantAccess').addEventListener('click', async () => {
    const form = readForm();
    if ((form.type !== 'custom' && form.type !== 'proxy') || !isValidEndpointUrl(form.baseUrl)) {
      setStatus('connStatus', 'Enter a valid endpoint URL first.', 'bad');
      return;
    }
    const granted = await requestEndpointAccess(form.baseUrl);
    setStatus('connStatus', granted
      ? `Access to ${endpointHost(form.baseUrl)} granted.`
      : 'Access was not granted. Your browser may block this permission.', granted ? 'ok' : 'bad');
    await updatePermissionUi();
  });

  // Model field changes save immediately, like the other settings.
  for (const id of ['checkModel', 'rewriteModel']) {
    $(id).addEventListener('change', async () => {
      const v = $(id).value.trim();
      if (!v) {
        const preset = presetById($('provider').value);
        const fallback = id === 'checkModel' ? preset.checkModel : preset.rewriteModel;
        if (fallback) {
          const next = await saveSettings({ [id]: fallback });
          state.settings = next;
          $(id).value = fallback;
          setStatus('modelStatus', 'A model name cannot be empty; the provider default was restored.', '');
          toast();
          return;
        }
        $(id).value = '';
        setStatus('modelStatus', 'Enter a model name for your endpoint.', 'bad');
        return;
      }
      const next = await saveSettings({ [id]: v });
      state.settings = next;
      $(id).value = next[id];
      toast();
    });
  }
  $('loadModels').addEventListener('click', loadModels);
  $('resetModels').addEventListener('click', resetModels);

  // Language
  for (const [value, label] of LANGUAGES) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    $('language').append(o);
  }
  $('language').value = s.language;
  $('language').addEventListener('change', async () => {
    await saveSettings({ language: $('language').value });
    toast();
  });

  // Categories
  for (const id of CATEGORY_IDS) {
    const row = document.createElement('label');
    row.className = 'cat';

    const sw = document.createElement('span');
    sw.className = 'switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!s.categories[id];
    const track = document.createElement('span');
    track.className = 'track';
    sw.append(input, track);

    const text = document.createElement('span');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = id[0].toUpperCase() + id.slice(1);
    const desc = document.createElement('div');
    desc.className = 'desc';
    desc.textContent = CATEGORY_INFO[id];
    text.append(name, desc);

    row.append(sw, text);
    $('categories').append(row);

    input.addEventListener('change', async () => {
      await saveSettings({ categories: { [id]: input.checked } });
      toast();
    });
  }

  // Translation
  $('targetLanguages').value = s.targetLanguages.join('\n');
  $('targetLanguages').addEventListener('change', async () => {
    const langs = lines($('targetLanguages').value).map((l) => l.slice(0, 40)).slice(0, 12);
    await saveSettings({ targetLanguages: langs });
    $('targetLanguages').value = langs.join('\n');
    toast();
  });
  $('translateTone').value = s.translateTone;
  $('translateTone').addEventListener('change', async () => {
    await saveSettings({ translateTone: $('translateTone').value });
    toast();
  });
  $('bubbleEverywhere').checked = s.bubbleEverywhere;
  $('bubbleEverywhere').addEventListener('change', async () => {
    await saveSettings({ bubbleEverywhere: $('bubbleEverywhere').checked });
    toast();
  });

  // Quick actions
  for (const mode of REWRITE_MODES) {
    const o = document.createElement('option');
    o.value = mode.id;
    o.textContent = mode.label;
    $('quickTone').append(o);
  }
  for (const lang of COMMON_LANGUAGES) {
    const o = document.createElement('option');
    o.value = lang;
    $('languageList').append(o);
  }
  $('quickTone').value = s.quickTone;
  $('quickLanguage').value = s.quickLanguage;
  $('quickTone').addEventListener('change', async () => {
    state.settings = await saveSettings({ quickTone: $('quickTone').value });
    toast();
    renderShortcuts();
  });
  $('quickLanguage').addEventListener('change', async () => {
    const value = $('quickLanguage').value.trim();
    if (!LANGUAGE_NAME.test(value)) {
      $('quickLanguage').value = state.settings.quickLanguage;
      setStatus('shortcutStatus', 'Use a language name, for example German or Spanish.', 'bad');
      return;
    }
    state.settings = await saveSettings({ quickLanguage: value });
    $('quickLanguage').value = state.settings.quickLanguage;
    setStatus('shortcutStatus', '', '');
    toast();
    renderShortcuts();
  });

  $('shortcutUrl').textContent = shortcutPageUrl();
  $('openShortcuts').addEventListener('click', openShortcutSettings);
  $('copyShortcuts').addEventListener('click', copyShortcutUrl);
  window.addEventListener('focus', renderShortcuts);

  // Behavior
  $('showBadge').checked = s.showBadge;
  $('showBadge').addEventListener('change', async () => {
    await saveSettings({ showBadge: $('showBadge').checked });
    toast();
  });

  const showDebounce = () => {
    $('debounceValue').textContent = (Number($('debounce').value) / 1000).toFixed(1) + 's';
  };
  $('debounce').value = s.debounceMs;
  showDebounce();
  $('debounce').addEventListener('input', showDebounce);
  $('debounce').addEventListener('change', async () => {
    await saveSettings({ debounceMs: Number($('debounce').value) });
    toast();
  });

  // Lists
  $('dictionary').value = s.dictionary.join('\n');
  $('dictionary').addEventListener('change', async () => {
    await saveSettings({ dictionary: lines($('dictionary').value).slice(0, 400) });
    toast();
  });

  $('disabledSites').value = s.disabledSites.join('\n');
  $('disabledSites').addEventListener('change', async () => {
    const sites = lines($('disabledSites').value).map(normalizeSite).filter(Boolean);
    await saveSettings({ disabledSites: [...new Set(sites)] });
    $('disabledSites').value = sites.join('\n');
    toast();
  });

  renderShortcuts();
}

// Keep the lists in sync if the popup or a context action changes them.
api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.dictionary && document.activeElement !== $('dictionary')) {
    $('dictionary').value = (changes.dictionary.newValue || []).join('\n');
  }
  if (changes.disabledSites && document.activeElement !== $('disabledSites')) {
    $('disabledSites').value = (changes.disabledSites.newValue || []).join('\n');
  }
});

init();
